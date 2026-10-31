// Normalizes direct cron payloads before TTS, custody, transport, or mirroring.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { NormalizeReplyOutcome } from "../../auto-reply/reply/normalize-reply.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import {
  NOTIFICATION_CHANNEL_DATA_KEY,
  unwrapNotificationEnvelopes,
} from "../../notifications/proposal.js";
import { normalizeSilentReplyText } from "./delivery-dispatch-policy.js";

type CronChannelTransform = {
  apply: (payload: ReplyPayload) => ReplyPayload | null;
};

function shouldAttachDirectCronFallbackText(payload: ReplyPayload): boolean {
  return (
    Boolean(payload.channelData) &&
    !hasReplyPayloadContent(payload, { trimText: true, hasChannelData: false })
  );
}

function normalizeDirectPayload(payload: ReplyPayload): ReplyPayload[] {
  const normalized = payload.text ? normalizeSilentReplyText(payload.text) : undefined;
  const candidate = normalized
    ? copyReplyPayloadMetadata(payload, {
        ...payload,
        text: normalized.strippedTrailingSilentToken ? undefined : normalized.text,
      })
    : payload;
  const envelopes = candidate.text ? unwrapNotificationEnvelopes(candidate.text) : undefined;
  if (!envelopes) {
    return [candidate];
  }
  if (
    envelopes.length > 1 &&
    hasReplyPayloadContent({ ...candidate, text: undefined }, { trimText: true })
  ) {
    throw new Error("Multiple notification topics require text-only payloads");
  }
  return envelopes.map(({ text, notification }) =>
    copyReplyPayloadMetadata(candidate, {
      ...candidate,
      text,
      channelData: { ...candidate.channelData, [NOTIFICATION_CHANNEL_DATA_KEY]: notification },
    }),
  );
}

export function normalizeDirectCronDeliveryPayloads(params: {
  deliveryPayloads: ReplyPayload[];
  outputText?: string;
  summary?: string;
  synthesizedText?: string;
  channelTransform?: CronChannelTransform;
}): NormalizeReplyOutcome<ReplyPayload[]> {
  const fallback = normalizeSilentReplyText(
    normalizeOptionalString(params.outputText) ??
      normalizeOptionalString(params.summary) ??
      normalizeOptionalString(params.synthesizedText),
  );
  const fallbackRawText = fallback.strippedTrailingSilentToken ? undefined : fallback.text;
  const fallbackEnvelopes = fallbackRawText
    ? unwrapNotificationEnvelopes(fallbackRawText)
    : undefined;
  const fallbackText = fallbackEnvelopes ? undefined : fallbackRawText;
  const candidates = params.deliveryPayloads
    .flatMap(normalizeDirectPayload)
    .filter((payload) => hasReplyPayloadContent(payload, { trimText: true }));
  if (candidates.length === 0 && fallbackEnvelopes) {
    candidates.push(
      ...fallbackEnvelopes.map(({ text, notification }) => ({
        text,
        channelData: { [NOTIFICATION_CHANNEL_DATA_KEY]: notification },
      })),
    );
  } else if (candidates.length === 0 && fallbackText) {
    candidates.push({ text: fallbackText });
  }
  const fallbackIndex = fallbackText
    ? candidates.findLastIndex((payload) => normalizeOptionalString(payload.text) === fallbackText)
    : -1;
  let fallbackSourceIndex = fallbackIndex >= 0 ? fallbackIndex : undefined;
  if (
    fallbackText &&
    fallbackSourceIndex === undefined &&
    candidates.some(shouldAttachDirectCronFallbackText)
  ) {
    candidates.unshift({ text: fallbackText });
    fallbackSourceIndex = 0;
  }
  const prepared = candidates.map((payload) =>
    shouldAttachDirectCronFallbackText(payload) && fallbackText && fallbackSourceIndex !== undefined
      ? copyReplyPayloadMetadata(
          payload,
          Object.assign({}, payload, {
            fallbackText: { text: fallbackText, replacesPayloadIndex: fallbackSourceIndex },
          }),
        )
      : payload,
  );
  const accepted: Array<{ payload: ReplyPayload; sourceIndex: number }> = [];
  let channelSuppressed = false;
  for (const [index, candidate] of prepared.entries()) {
    const transformed = params.channelTransform
      ? params.channelTransform.apply(candidate)
      : candidate;
    if (transformed === null) {
      channelSuppressed = true;
    } else {
      accepted.push({ payload: transformed, sourceIndex: index });
    }
  }
  if (accepted.length === 0) {
    return { kind: "suppress", reason: channelSuppressed ? "channel_transform" : "empty" };
  }

  const acceptedFallbackIndex = accepted.findIndex(
    ({ sourceIndex }) => sourceIndex === fallbackSourceIndex,
  );
  const payloads = accepted.map(({ payload }) => {
    const fallbackMeta = payload.fallbackText;
    if (!fallbackMeta || fallbackMeta.replacesPayloadIndex !== fallbackSourceIndex) {
      return payload;
    }
    return copyReplyPayloadMetadata(
      payload,
      Object.assign({}, payload, {
        fallbackText:
          acceptedFallbackIndex < 0
            ? undefined
            : { ...fallbackMeta, replacesPayloadIndex: acceptedFallbackIndex },
      }),
    );
  });

  return { kind: "deliver", payload: payloads };
}

/**
 * Appends the Control UI run-inspection link to the last visible payload.
 * Callers invoke this only after silent-reply suppression so a link cannot turn
 * a silent or empty run into a visible announcement; the payload is replaced
 * rather than mutated because payload objects can be aliased by the caller.
 */
export function appendCronRunInspectionLink(
  payloads: ReplyPayload[],
  inspectionUrl: string | undefined,
): ReplyPayload[] {
  // Source-backed proactive copy stays conversational. The run's native
  // inspection record remains available without appending bookkeeping to it.
  if (
    payloads.some(
      (payload) => payload.channelData && NOTIFICATION_CHANNEL_DATA_KEY in payload.channelData,
    )
  ) {
    return payloads;
  }
  const index = payloads.findLastIndex((payload) => payload.text?.trim());
  if (!inspectionUrl || index < 0) {
    return payloads;
  }
  const payload = payloads[index]!;
  const linked = copyReplyPayloadMetadata(payload, {
    ...payload,
    text: `${payload.text}\nInspect: ${inspectionUrl}`,
  });
  return payloads.map((entry, at) => (at === index ? linked : entry));
}
