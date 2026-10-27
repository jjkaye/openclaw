import { NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS } from "../infra/delivery-queue-sqlite.types.js";
import { notificationKey, notificationOwnerKey, type NotificationProposal } from "./proposal.js";
import { notificationLocalDate, type NotificationPreparationCandidate } from "./receipt-policy.js";
import type { NotificationResolveContext, NotificationSourceState } from "./source-types.js";

export { notificationLocalDate } from "./receipt-policy.js";

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

/** Source eligibility is separate from the worker's atomic receipt election. */
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
  // Expiring transport history cannot make a source's old completed result new.
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

export function createNotificationCandidate(
  proposal: NotificationProposal,
  context: NotificationResolveContext,
  state: NotificationSourceState,
  index: number,
): NotificationPreparationCandidate {
  return {
    index,
    purpose: proposal.purpose,
    timeZone: state.timeZone,
    receiptBase: {
      ownerKey: notificationOwnerKey(proposal.sourceId, proposal.ownerId),
      topicKey: notificationTopicKey(proposal, context),
      revisionKey: notificationKey(state.revision, state.consequenceKey ?? ""),
      ...(state.status === "resolved" ? { resolvedAt: state.resolvedAt ?? Date.now() } : {}),
    },
  };
}
