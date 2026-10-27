import {
  NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS,
  type DeliveryQueueNotificationReceipt,
} from "../infra/delivery-queue-sqlite.types.js";
import { notificationKey, notificationOwnerKey, type NotificationProposal } from "./proposal.js";
import type { NotificationResolveContext, NotificationSourceState } from "./source-types.js";

export type NotificationTopicDelivery = {
  id: string;
  status: "pending" | "completed" | "failed";
  notificationReceipt?: DeliveryQueueNotificationReceipt;
  acknowledgedAt?: number;
  recoveryState?: string;
};

export function notificationLocalDate(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function notificationTopicKey(
  proposal: NotificationProposal,
  context: NotificationResolveContext,
): string {
  return notificationKey(
    notificationOwnerKey(proposal.sourceId, proposal.ownerId),
    proposal.topicId,
    proposal.purpose,
    context.agentId,
    context.recipient.channel,
    context.recipient.to,
    context.recipient.accountId ?? "",
    String(context.recipient.threadId ?? ""),
  );
}

export function notificationStateEligible(
  proposal: NotificationProposal,
  state: NotificationSourceState | null,
  now = Date.now(),
): state is NotificationSourceState {
  if (
    !(
      state &&
      state.topicId === proposal.topicId &&
      state.revision === proposal.expectedRevision &&
      (state.status === "open" || (proposal.purpose === "result" && state.status === "resolved"))
    )
  ) {
    return false;
  }
  if (state.status !== "resolved") {
    return true;
  }
  // Expired terminal receipts must never make an old completed result look new.
  // Date-only sources retain their actual precision rather than inventing a time.
  if (state.resolvedAt !== undefined) {
    return (
      Number.isSafeInteger(state.resolvedAt) &&
      state.resolvedAt <= now &&
      now < state.resolvedAt + NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS
    );
  }
  if (!state.resolvedOn || !/^\d{4}-\d{2}-\d{2}$/.test(state.resolvedOn)) {
    return false;
  }
  const closed = new Date(`${state.resolvedOn}T00:00:00.000Z`);
  if (
    !Number.isFinite(closed.getTime()) ||
    closed.toISOString().slice(0, 10) !== state.resolvedOn
  ) {
    return false;
  }
  const today = notificationLocalDate(now, state.timeZone);
  const expiresOn = new Date(closed.getTime() + NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS)
    .toISOString()
    .slice(0, 10);
  return state.resolvedOn <= today && today < expiresOn;
}

export function admitNotification(params: {
  proposal: NotificationProposal;
  context: NotificationResolveContext;
  state: NotificationSourceState;
  deliveries: readonly NotificationTopicDelivery[];
  now: number;
}): { id: string; receipt: DeliveryQueueNotificationReceipt } | undefined {
  const { proposal, context, state, deliveries, now } = params;
  if (!notificationStateEligible(proposal, state, now)) {
    return undefined;
  }
  // Earlier revisions may have reached the provider. A new source revision is
  // not permission to bypass unresolved transport custody for this subject.
  if (
    deliveries.some(
      (delivery) =>
        delivery.status === "pending" ||
        (delivery.status === "failed" && delivery.recoveryState !== "completed_notification"),
    )
  ) {
    return undefined;
  }
  const topicKey = notificationTopicKey(proposal, context);
  const revisionKey = notificationKey(state.revision, state.consequenceKey ?? "");
  const current = deliveries.filter(
    (delivery) => delivery.notificationReceipt?.revisionKey === revisionKey,
  );
  const localDate = notificationLocalDate(now, state.timeZone);
  if (
    current.some(
      (delivery) =>
        delivery.notificationReceipt!.localDate >= localDate ||
        (delivery.acknowledgedAt !== undefined &&
          notificationLocalDate(delivery.acknowledgedAt, state.timeZone) >= localDate),
    )
  ) {
    return undefined;
  }
  // A terminal rejection belongs to the same occurrence until a meaningful
  // source change; native pending recovery owns bounded pre-dispatch retry.
  if (current.some((delivery) => delivery.status === "failed")) {
    return undefined;
  }
  const used = new Set(current.map((delivery) => delivery.notificationReceipt!.slot));
  const slot = ([0, 1, 2] as const).find((candidate) => !used.has(candidate));
  if (slot === undefined || (proposal.purpose === "result" && slot !== 0)) {
    return undefined;
  }
  return {
    id: `notification-${notificationKey(topicKey, revisionKey, String(slot))}`,
    receipt: {
      ownerKey: notificationOwnerKey(proposal.sourceId, proposal.ownerId),
      topicKey,
      revisionKey,
      slot,
      localDate,
      ...(state.status === "resolved" ? { resolvedAt: state.resolvedAt ?? now } : {}),
    },
  };
}
