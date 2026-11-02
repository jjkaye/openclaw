import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../auto-reply/reply-payload.js";
import { listNotificationDeliveryReceipts } from "../infra/delivery-queue-sqlite.js";
import {
  parseDeliveryQueueNotificationReceipts,
  type DeliveryQueueNotificationReceipt,
} from "../infra/delivery-queue-sqlite.types.js";
import { stripTargetProviderPrefix } from "../infra/outbound/channel-target-prefix.js";
import type { InternalDeliverOutboundPayloadsParams } from "../infra/outbound/deliver-contracts.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "../infra/outbound/deliver-types.js";
import { claimNotificationPreparation } from "../infra/outbound/delivery-queue-preparation.js";
import {
  getPluginExecutionFrame,
  InvocationFrame,
  runWithPluginExecutionFrame,
} from "../plugins/plugin-instance-invocation.js";
import {
  createNotificationCandidate,
  notificationStateEligible,
  notificationTopicKey,
} from "./admission.js";
import { findNotificationCancellation, NotificationCanceledError } from "./cancellation.js";
import {
  NOTIFICATION_BATCH_CHANNEL_DATA_KEY,
  NOTIFICATION_CHANNEL_DATA_KEY,
  notificationKey,
  notificationOwnerKey,
  parseNotificationProposal,
  type NotificationBlock,
} from "./proposal.js";
import { captureNotificationSource } from "./source-registry.js";
import type { NotificationResolveContext } from "./source-types.js";

type IndexedBlock = { index: number; block: NotificationBlock; payload?: ReplyPayload };
type SourceHandle = ReturnType<typeof captureNotificationSource>;
type GuardEntry = IndexedBlock & {
  source: SourceHandle;
  receipt: DeliveryQueueNotificationReceipt;
};
type Delivery = (
  params: InternalDeliverOutboundPayloadsParams,
) => Promise<OutboundDeliveryResult[]>;
const MAX_RECOMPOSITIONS = 3;

export function hasNotificationProposal(payload: ReplyPayload): boolean {
  return Boolean(
    payload.channelData &&
    (NOTIFICATION_CHANNEL_DATA_KEY in payload.channelData ||
      NOTIFICATION_BATCH_CHANNEL_DATA_KEY in payload.channelData),
  );
}

function resolveContext(params: InternalDeliverOutboundPayloadsParams): NotificationResolveContext {
  const agentId = params.session?.agentId;
  if (!agentId) {
    throw new Error("Notification delivery requires an admitted agent");
  }
  return {
    agentId,
    recipient: {
      channel: params.channel,
      // Transport decoration must not split the source grant or retained topic custody.
      to: stripTargetProviderPrefix(params.to, params.channel),
      accountId: params.accountId,
      threadId: params.threadId,
    },
    signal: params.abortSignal,
  };
}

function parseBlock(value: unknown): NotificationBlock {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["notification", "text", "spokenText"].includes(key)) ||
    typeof value.text !== "string" ||
    (value.spokenText !== undefined && typeof value.spokenText !== "string")
  ) {
    throw new Error("Invalid notification block");
  }
  const notification = parseNotificationProposal(value.notification);
  if (!notification) {
    throw new Error("Invalid notification proposal");
  }
  return {
    notification,
    text: value.text,
    ...(typeof value.spokenText === "string" ? { spokenText: value.spokenText } : {}),
  };
}

function readBlocks(params: InternalDeliverOutboundPayloadsParams): IndexedBlock[] {
  const explicit = params.notificationBlocks;
  let blocks: Array<{ block: NotificationBlock; payload?: ReplyPayload }>;
  if (explicit !== undefined) {
    if (!Array.isArray(explicit)) {
      throw new Error("Invalid notification blocks");
    }
    blocks = explicit.map((value) => ({ block: parseBlock(value) }));
    // Recovery carries logical references alongside the exact post-policy
    // physical batch, which can contain no accepted payloads at all.
    if (!params.deliveryQueueId && blocks.length === params.payloads.length) {
      for (const [index, entry] of blocks.entries()) {
        entry.payload = params.payloads[index];
      }
    } else if (!params.deliveryQueueId && params.payloads.length !== 1) {
      throw new Error("Notification blocks require one carrier or one payload per block");
    }
  } else {
    blocks = params.payloads.flatMap<{ block: NotificationBlock; payload?: ReplyPayload }>(
      (payload) => {
        const batch = payload.channelData?.[NOTIFICATION_BATCH_CHANNEL_DATA_KEY];
        if (batch !== undefined) {
          if (!Array.isArray(batch) || params.payloads.length !== 1) {
            throw new Error("Invalid notification batch carrier");
          }
          return batch.map((value) => {
            const block = parseBlock(value);
            return batch.length === 1 ? { block, payload } : { block };
          });
        }
        const notification = parseNotificationProposal(
          payload.channelData?.[NOTIFICATION_CHANNEL_DATA_KEY],
        );
        if (!notification) {
          throw new Error("Proactive notification requires a current source reference");
        }
        return [
          {
            block: { notification, text: payload.text ?? "", spokenText: payload.spokenText },
            payload,
          },
        ];
      },
    );
  }
  if (blocks.length === 0 || blocks.length > 16) {
    throw new Error("Notification delivery requires between one and sixteen blocks");
  }
  return blocks.map((entry, index) => Object.assign({}, entry, { index }));
}

function assertComposable(
  params: InternalDeliverOutboundPayloadsParams,
  blocks: IndexedBlock[],
): void {
  if (blocks.length === 1) {
    return;
  }
  if (params.preparedBatch || blocks.some(({ block }) => !block.text.trim())) {
    throw new Error("Notification groups require unprepared text-only blocks");
  }
  for (const payload of params.payloads) {
    if (
      payload.mediaUrl ||
      payload.mediaUrls?.length ||
      payload.attachments?.length ||
      payload.presentation ||
      payload.interactive ||
      payload.location ||
      payload.ttsSupplement ||
      payload.fallbackText ||
      payload.btw ||
      payload.delivery ||
      payload.replyToId ||
      payload.replyToTag ||
      payload.replyToCurrent ||
      Object.keys(payload.channelData ?? {}).some(
        (key) =>
          key !== NOTIFICATION_CHANNEL_DATA_KEY && key !== NOTIFICATION_BATCH_CHANNEL_DATA_KEY,
      )
    ) {
      throw new Error("Notification groups cannot compose existing media or structured payloads");
    }
  }
}

function composePayload(selected: readonly IndexedBlock[], originalCount: number): ReplyPayload {
  const first = selected[0];
  if (!first) {
    throw new Error("Notification preparation selected no blocks");
  }
  if (originalCount === 1 && first.payload) {
    return copyReplyPayloadMetadata(first.payload, {
      ...first.payload,
      ...(first.block.text || first.payload.text !== undefined ? { text: first.block.text } : {}),
      ...(first.block.spokenText !== undefined ? { spokenText: first.block.spokenText } : {}),
    });
  }
  const payload: ReplyPayload = { text: selected.map(({ block }) => block.text).join("\n\n") };
  const speech = selected.map(({ block, payload: source }) => {
    const metadata = source ? getReplyPayloadMetadata(source) : undefined;
    return {
      text: block.spokenText ?? metadata?.tts?.text ?? source?.spokenText ?? block.text,
      explicit: block.spokenText !== undefined || metadata?.tts !== undefined,
      ttsExplicit: metadata?.ttsExplicit,
      directives: metadata?.tts?.directives ?? [],
    };
  });
  if (speech.some((entry) => entry.explicit)) {
    const spokenText = speech.map((entry) => entry.text).join("\n\n");
    payload.spokenText = spokenText;
    const directives = speech.flatMap((entry) => entry.directives);
    setReplyPayloadMetadata(payload, {
      tts: { tagged: true, text: spokenText, ...(directives.length ? { directives } : {}) },
      ...(speech.some((entry) => entry.ttsExplicit) ? { ttsExplicit: true } : {}),
    });
  }
  return payload;
}

function sourceUnavailable(cause: unknown): PlatformMessageNotDispatchedError {
  return new PlatformMessageNotDispatchedError(
    "Notification source could not be checked before dispatch",
    { cause },
  );
}

/** Captured callbacks are process-local; recovery reacquires every provider. */
function sourceGuards(
  params: InternalDeliverOutboundPayloadsParams,
  entries: readonly GuardEntry[],
  context: NotificationResolveContext,
) {
  // Channel dispatch enters its own registry scope. Source checks retain the
  // admission frame, including an unscoped global owner that can be replaced.
  const sourceFrame = getPluginExecutionFrame() ?? new InvocationFrame({});
  const assertCurrent = () =>
    runWithPluginExecutionFrame(sourceFrame, () => {
      try {
        params.abortSignal?.throwIfAborted();
        for (const entry of entries) {
          entry.source.assertCurrent();
        }
      } catch (cause) {
        params.abortSignal?.throwIfAborted();
        throw sourceUnavailable(cause);
      }
    });
  const validate = () =>
    runWithPluginExecutionFrame(sourceFrame, async () => {
      const states = await Promise.allSettled(
        entries.map((entry) => entry.source.resolve(entry.block.notification, context)),
      );
      // A previously successful provider may retire while another provider awaits.
      assertCurrent();
      const unavailable = states.find((state) => state.status === "rejected");
      if (unavailable?.status === "rejected") {
        throw sourceUnavailable(unavailable.reason);
      }
      const excluded: string[] = [];
      for (const [index, entry] of entries.entries()) {
        const result = states[index];
        if (!result || result.status !== "fulfilled") {
          throw sourceUnavailable(undefined);
        }
        const proposal = entry.block.notification;
        if (
          !notificationStateEligible(proposal, result.value) ||
          notificationKey(result.value.revision, result.value.consequenceKey ?? "") !==
            entry.receipt.revisionKey
        ) {
          excluded.push(entry.receipt.topicKey);
        }
      }
      if (excluded.length) {
        throw new NotificationCanceledError(excluded);
      }
      assertCurrent();
    });
  return {
    validateNotificationPreparation: async () => {
      await params.validateNotificationPreparation?.();
      await validate();
    },
    onPlatformSendDispatch: async () => {
      await params.onPlatformSendDispatch?.();
      await validate();
    },
    assertDirectAdapterHandoff: () => {
      params.assertDirectAdapterHandoff?.();
      assertCurrent();
    },
    validate,
  };
}

function mapOutcome(
  outcome: OutboundPayloadDeliveryOutcome,
  index: number,
): OutboundPayloadDeliveryOutcome {
  return { ...outcome, index };
}

function possibleSend(
  error: unknown,
  outcomes: readonly OutboundPayloadDeliveryOutcome[],
): boolean {
  return (
    collectNestedErrorCandidates(error).some(
      (candidate) => candidate instanceof OutboundDeliveryError && candidate.sentBeforeError,
    ) ||
    outcomes.some(
      (outcome) =>
        outcome.status === "sent" ||
        (outcome.status === "failed" && outcome.sentBeforeError) ||
        (outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity"),
    )
  );
}

async function cancellationSettled(
  params: InternalDeliverOutboundPayloadsParams,
  id: string,
): Promise<boolean> {
  const rows = (
    await listNotificationDeliveryReceipts(
      { includePending: true },
      params.deliveryQueueStateDir,
      params.deliveryQueueStateContext,
    )
  ).filter((row) => row.id === id);
  return (
    rows.length > 0 &&
    rows.every(
      (row) => row.status !== "pending" && row.recoveryState === "completed_notification_canceled",
    )
  );
}

/** One physical message carries the worker-selected, independently owned topics. */
export async function runNotificationDelivery(
  params: InternalDeliverOutboundPayloadsParams,
  run: Delivery,
): Promise<OutboundDeliveryResult[]> {
  const blocks = readBlocks(params);
  const context = resolveContext(params);
  if (params.deliveryQueueId) {
    const receipts = parseDeliveryQueueNotificationReceipts(params.notificationReceipts);
    if (!receipts || receipts.length !== blocks.length) {
      throw new Error("Invalid queued notification group");
    }
    const entries = blocks.map((entry, index): GuardEntry => {
      const receipt = receipts[index];
      const proposal = entry.block.notification;
      if (
        !receipt ||
        receipt.ownerKey !== notificationOwnerKey(proposal.sourceId, proposal.ownerId) ||
        receipt.topicKey !== notificationTopicKey(proposal, context)
      ) {
        throw new Error("Queued notification authority does not match its receipt");
      }
      try {
        return { ...entry, receipt, source: captureNotificationSource(proposal.sourceId) };
      } catch (cause) {
        throw sourceUnavailable(cause);
      }
    });
    const { validate, ...guards } = sourceGuards(params, entries, context);
    await validate();
    return run({
      ...params,
      notificationBlocks: blocks.map(({ block }) => block),
      notificationReceipts: receipts,
      ...guards,
    });
  }

  assertComposable(params, blocks);
  const outcomes = new Map<number, OutboundPayloadDeliveryOutcome>();
  const failures = new Map<number, unknown>();
  let remaining = blocks;
  const suppress = (index: number) =>
    outcomes.set(index, { index, status: "suppressed", reason: "notification_policy" });
  const fail = (index: number, error: unknown) => {
    failures.set(index, error);
    outcomes.set(index, { index, status: "failed", error, sentBeforeError: false, stage: "queue" });
  };
  const finish = (results: OutboundDeliveryResult[], error?: unknown): OutboundDeliveryResult[] => {
    for (const block of blocks) {
      const outcome = outcomes.get(block.index);
      if (outcome) {
        params.onPayloadDeliveryOutcome?.(outcome);
      }
    }
    if (error !== undefined || failures.size > 0) {
      const mapped = new OutboundDeliveryError(
        "One or more notification subjects could not be delivered",
        {
          cause: error ?? new AggregateError([...failures.values()]),
          results,
          payloadOutcomes: [...outcomes.values()].toSorted(
            (left, right) => left.index - right.index,
          ),
          stage: error instanceof OutboundDeliveryError ? error.stage : "queue",
        },
      );
      if (error instanceof OutboundDeliveryError) {
        mapped.queueCustody = error.queueCustody;
      }
      throw mapped;
    }
    return results;
  };

  for (let recompositions = 0; ; recompositions++) {
    const candidates = [];
    const resolved = new Map<number, IndexedBlock & { source: SourceHandle }>();
    const seen = new Set<string>();
    for (const entry of remaining) {
      const proposal = entry.block.notification;
      try {
        params.abortSignal?.throwIfAborted();
        const source = captureNotificationSource(proposal.sourceId);
        const state = await source.resolve(proposal, context);
        source.assertCurrent();
        if (!notificationStateEligible(proposal, state)) {
          suppress(entry.index);
          continue;
        }
        const candidate = createNotificationCandidate(proposal, context, state, entry.index);
        if (seen.has(candidate.receiptBase.topicKey)) {
          suppress(entry.index);
          continue;
        }
        seen.add(candidate.receiptBase.topicKey);
        candidates.push(candidate);
        resolved.set(entry.index, { ...entry, source });
      } catch (cause) {
        params.abortSignal?.throwIfAborted();
        fail(entry.index, sourceUnavailable(cause));
      }
    }
    if (candidates.length === 0) {
      return finish([]);
    }
    const claim = await claimNotificationPreparation(
      { candidates, stateDir: params.deliveryQueueStateDir },
      params.deliveryQueueStateContext,
    );
    if (claim.status === "suppressed") {
      for (const index of resolved.keys()) {
        suppress(index);
      }
      return finish([]);
    }
    const entries: GuardEntry[] = claim.selected.map(({ index, receipt }) => ({
      ...resolved.get(index)!,
      receipt,
    }));
    const selected = new Set(entries.map(({ index }) => index));
    for (const index of resolved.keys()) {
      if (!selected.has(index)) {
        suppress(index);
      }
    }
    // There is no asynchronous gap between the worker claim and its native
    // preparation owner. Fresh-source checks run inside that owner's cleanup.
    const payload = composePayload(entries, blocks.length);
    const { validate: _validate, ...guards } = sourceGuards(params, entries, context);
    const physicalOutcomes: OutboundPayloadDeliveryOutcome[] = [];
    const admitted: InternalDeliverOutboundPayloadsParams = {
      ...params,
      payloads: [payload],
      notificationBlocks: entries.map(({ block }) => block),
      notificationReceipts: entries.map(({ receipt }) => receipt),
      notificationPreparation: claim.entry,
      deliveryIntentId: claim.entry.id,
      reusePendingDeliveryIntent: true,
      completionRetention: "permanent",
      queuePolicy: "required",
      skipQueue: false,
      ...guards,
      onPayloadDeliveryOutcome: (outcome) => physicalOutcomes.push(outcome),
    };
    let results: OutboundDeliveryResult[];
    let failure: { error: unknown } | undefined;
    try {
      results = await run(admitted);
    } catch (error) {
      failure = { error };
      results = error instanceof OutboundDeliveryError ? error.results : [];
    }
    if (!failure) {
      const outcome =
        physicalOutcomes.at(-1) ??
        (results.length
          ? { index: 0, status: "sent" as const, results }
          : { index: 0, status: "suppressed" as const, reason: "no_visible_payload" as const });
      for (const entry of entries) {
        outcomes.set(entry.index, mapOutcome(outcome, entry.index));
      }
      return finish(results);
    }
    const error = failure.error;
    const cancellation = findNotificationCancellation(error);
    let canceledDurably = false;
    if (cancellation && !possibleSend(error, physicalOutcomes)) {
      try {
        canceledDurably = await cancellationSettled(params, claim.entry.id);
      } catch {
        /* Unconfirmed custody cannot authorize a fresh preparation. */
      }
    }
    if (cancellation && canceledDurably) {
      const excluded = new Set(cancellation.excludedTopicKeys);
      const canceled = entries.filter(({ receipt }) => excluded.has(receipt.topicKey));
      const keep = entries.filter(({ receipt }) => !excluded.has(receipt.topicKey));
      if (canceled.length > 0) {
        for (const entry of canceled) {
          suppress(entry.index);
        }
        if (keep.length === 0) {
          return finish([]);
        }
        if (recompositions < MAX_RECOMPOSITIONS) {
          remaining = keep;
          continue;
        }
      }
    }
    const physical = physicalOutcomes.at(-1) ?? {
      index: 0,
      status: "failed" as const,
      error,
      sentBeforeError: possibleSend(error, physicalOutcomes),
      stage: error instanceof OutboundDeliveryError ? error.stage : ("queue" as const),
      ...(results.length ? { results } : {}),
    };
    for (const entry of entries) {
      if (outcomes.get(entry.index)?.status !== "suppressed") {
        outcomes.set(entry.index, mapOutcome(physical, entry.index));
      }
    }
    return finish(results, error);
  }
}
