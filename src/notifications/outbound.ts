import type { ReplyPayload } from "../auto-reply/types.js";
import { listNotificationDeliveryReceipts } from "../infra/delivery-queue-sqlite.js";
import { parseDeliveryQueueNotificationReceipt } from "../infra/delivery-queue-sqlite.types.js";
import type { InternalDeliverOutboundPayloadsParams } from "../infra/outbound/deliver-contracts.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { admitNotification, notificationStateEligible, notificationTopicKey } from "./admission.js";
import {
  NOTIFICATION_CHANNEL_DATA_KEY,
  notificationKey,
  notificationOwnerKey,
  parseNotificationProposal,
  type NotificationProposal,
} from "./proposal.js";
import { captureNotificationSource } from "./source-registry.js";
import type { NotificationResolveContext } from "./source-types.js";

export function hasNotificationProposal(payload: ReplyPayload): boolean {
  return payload.channelData !== undefined && NOTIFICATION_CHANNEL_DATA_KEY in payload.channelData;
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
      to: params.to,
      accountId: params.accountId,
      threadId: params.threadId,
    },
    signal: params.abortSignal,
  };
}

/** Rebuilt from queued data on recovery; callbacks themselves never enter storage. */
export async function guardNotificationDelivery(
  params: InternalDeliverOutboundPayloadsParams,
  proposal: NotificationProposal,
) {
  const source = captureNotificationSource(proposal.sourceId);
  const context = resolveContext(params);
  const resolveCurrent = async () => {
    try {
      return await source.resolve(proposal, context);
    } catch (cause) {
      throw new PlatformMessageNotDispatchedError(
        "Notification source could not be checked before dispatch",
        { cause },
      );
    }
  };
  const assertSourceCurrent = () => {
    try {
      source.assertCurrent();
    } catch (cause) {
      throw new PlatformMessageNotDispatchedError(
        "Notification source authority changed before dispatch",
        { cause },
      );
    }
  };
  const initial = await resolveCurrent();
  const rejection = () =>
    new PlatformMessageNotDispatchedError("Notification subject changed or is no longer eligible", {
      cause: undefined,
      retryable: false,
    });
  if (!notificationStateEligible(proposal, initial)) {
    throw rejection();
  }
  const revisionKey = notificationKey(initial.revision, initial.consequenceKey ?? "");
  const receipt = parseDeliveryQueueNotificationReceipt(params.notificationReceipt);
  if (
    !receipt ||
    receipt.ownerKey !== notificationOwnerKey(proposal.sourceId, proposal.ownerId) ||
    receipt.topicKey !== notificationTopicKey(proposal, context) ||
    receipt.revisionKey !== revisionKey ||
    (params.deliveryQueueId &&
      params.deliveryQueueId !==
        `notification-${notificationKey(receipt.topicKey, revisionKey, String(receipt.slot))}`)
  ) {
    throw rejection();
  }
  return {
    onPlatformSendDispatch: async () => {
      await params.onPlatformSendDispatch?.();
      const current = await resolveCurrent();
      if (
        !notificationStateEligible(proposal, current) ||
        notificationKey(current.revision, current.consequenceKey ?? "") !== revisionKey
      ) {
        throw rejection();
      }
      assertSourceCurrent();
    },
    assertDirectAdapterHandoff: () => {
      params.assertDirectAdapterHandoff?.();
      assertSourceCurrent();
    },
  };
}

export async function prepareNotificationDelivery(
  params: InternalDeliverOutboundPayloadsParams,
): Promise<InternalDeliverOutboundPayloadsParams | undefined> {
  const raw =
    params.notification ?? params.payloads[0]?.channelData?.[NOTIFICATION_CHANNEL_DATA_KEY];
  const proposal = parseNotificationProposal(raw);
  if (!proposal) {
    throw new Error("Invalid notification proposal");
  }
  // Recovery retains exact custody and reacquires current source authority. It
  // must never elect a new reminder slot for a queued occurrence.
  if (params.deliveryQueueId) {
    return {
      ...params,
      notification: proposal,
      ...(await guardNotificationDelivery(params, proposal)),
    };
  }
  const context = resolveContext(params);
  const source = captureNotificationSource(proposal.sourceId);
  const state = await source.resolve(proposal, context);
  if (!notificationStateEligible(proposal, state)) {
    return undefined;
  }
  const deliveries = await listNotificationDeliveryReceipts(
    {
      topicKey: notificationTopicKey(proposal, context),
      includePending: true,
    },
    params.deliveryQueueStateDir,
    params.deliveryQueueStateContext,
  );
  source.assertCurrent();
  const admitted = admitNotification({ proposal, context, state, deliveries, now: Date.now() });
  if (!admitted) {
    return undefined;
  }
  const admittedParams: InternalDeliverOutboundPayloadsParams = {
    ...params,
    notification: proposal,
    notificationReceipt: admitted.receipt,
    deliveryIntentId: admitted.id,
    reusePendingDeliveryIntent: true,
    completionRetention: "permanent",
    queuePolicy: "required",
    skipQueue: false,
  };
  return { ...admittedParams, ...(await guardNotificationDelivery(admittedParams, proposal)) };
}
