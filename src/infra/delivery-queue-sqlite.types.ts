import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";

export type DeliveryQueueCompletionRetention =
  | "permanent"
  | Readonly<{ idPrefix: string; maxAgeMs: number; maxEntries: number }>;

export const NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Opaque admission identity only; completed receipts never retain notification copy. */
export type DeliveryQueueNotificationReceipt = Readonly<{
  ownerKey: string;
  topicKey: string;
  revisionKey: string;
  slot: 0 | 1 | 2;
  localDate: string;
  resolvedAt?: number;
}>;

export type DeliveryQueueNotificationReceiptSnapshot = Readonly<{
  queueName: string;
  id: string;
  status: "pending" | "completed" | "failed";
  notificationReceipt: DeliveryQueueNotificationReceipt;
  acknowledgedAt?: number;
  recoveryState?: string;
}>;

export type DeliveryQueueNotificationReceiptQuery = Readonly<{
  topicKey?: string;
  includePending?: boolean;
}>;

/** A current source may close receipt custody or explicitly reopen its owner. */
export type DeliveryQueueNotificationResolution = Readonly<{
  ownerKey: string;
  resolvedAt: number | null;
}>;

/** Reject malformed or content-bearing metadata before it becomes durable custody. */
export function parseDeliveryQueueNotificationReceipt(
  value: unknown,
): DeliveryQueueNotificationReceipt | undefined {
  const receipt = asNullableRecord(value);
  if (
    !receipt ||
    Object.keys(receipt).some(
      (key) =>
        !["ownerKey", "topicKey", "revisionKey", "slot", "localDate", "resolvedAt"].includes(key),
    ) ||
    typeof receipt.ownerKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.ownerKey) ||
    typeof receipt.topicKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.topicKey) ||
    typeof receipt.revisionKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt.revisionKey) ||
    (receipt.slot !== 0 && receipt.slot !== 1 && receipt.slot !== 2) ||
    typeof receipt.localDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(receipt.localDate)
  ) {
    return undefined;
  }
  const date = new Date(`${receipt.localDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== receipt.localDate) {
    return undefined;
  }
  const resolvedAt = receipt.resolvedAt;
  if (
    resolvedAt !== undefined &&
    (typeof resolvedAt !== "number" || !Number.isSafeInteger(resolvedAt) || resolvedAt < 0)
  ) {
    return undefined;
  }
  return {
    ownerKey: receipt.ownerKey,
    topicKey: receipt.topicKey,
    revisionKey: receipt.revisionKey,
    slot: receipt.slot,
    localDate: receipt.localDate,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  };
}

/** Parse only the shipped completion-retention shape for one exact producer ID. */
export function parseDeliveryQueueCompletionRetention(
  value: unknown,
  id: string,
): DeliveryQueueCompletionRetention | undefined {
  if (value === "permanent") {
    return value;
  }
  const retention = asNullableRecord(value);
  if (!retention) {
    return undefined;
  }
  const idPrefix = typeof retention.idPrefix === "string" ? retention.idPrefix : "";
  const maxAgeMs = asPositiveSafeInteger(retention.maxAgeMs);
  const maxEntries = asPositiveSafeInteger(retention.maxEntries);
  if (!idPrefix || !id.startsWith(idPrefix) || maxAgeMs === undefined || maxEntries === undefined) {
    return undefined;
  }
  return { idPrefix, maxAgeMs, maxEntries };
}

type DeliveryQueueFailureFacts = Partial<
  Record<
    | keyof DeliveryQueueEntryState
    | "deliveryCompletion"
    | "deliveryStartedAt"
    | "failureRetention"
    | "settlementOutcome"
    | "terminalPolicy",
    unknown
  >
>;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Recover only authored or shipped producer ownership from a failed entry. */
export function inferDeliveryQueueFailureRetention(
  entry: DeliveryQueueFailureFacts,
  id: string,
  queueName?: string,
  legacyAmbiguousSendEvidence = false,
): DeliveryQueueCompletionRetention | undefined {
  if (parseDeliveryQueueNotificationReceipt(entry.notificationReceipt)) {
    return "permanent";
  }
  const explicit =
    parseDeliveryQueueCompletionRetention(entry.completionRetention, id) ??
    parseDeliveryQueueCompletionRetention(entry.failureRetention, id);
  if (explicit) {
    return explicit;
  }
  const fence = asNullableRecord(asNullableRecord(entry.terminalPolicy)?.fence);
  if (fence?.kind === "none") {
    return undefined;
  }
  const fenced =
    fence?.kind === "permanent" ? "permanent" : parseDeliveryQueueCompletionRetention(fence, id);
  if (fenced) {
    return fenced;
  }
  const durable =
    queueName === "outbound-preparing-v1" ||
    queueName === "outbound-legacy-preparing-v1" ||
    queueName === "outbound-prepared-migration-v1" ||
    entry.retainOnFailure === true ||
    asNullableRecord(entry.deliveryCompletion) !== null ||
    (queueName === "session" && finite(entry.availableAt));
  const ambiguous =
    legacyAmbiguousSendEvidence &&
    ((typeof entry.platformSendAttemptId === "string" && entry.platformSendAttemptId.length > 0) ||
      finite(entry.platformSendStartedAt) ||
      entry.recoveryState === "send_attempt_started" ||
      entry.recoveryState === "unknown_after_send" ||
      (queueName === "session" &&
        (finite(entry.deliveryStartedAt) ||
          (typeof entry.settlementOutcome === "string" && entry.settlementOutcome.length > 0) ||
          finite(entry.acknowledgedAt))));
  return durable || ambiguous ? "permanent" : undefined;
}

/** Persisted queue entry fields common to all delivery queue payloads. */
export type DeliveryQueueEntryState = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  availableAt?: number;
  /** Only explicit reusable producers retain a platform-send ownership lease. */
  requiresProducerClaim?: boolean;
  producerClaimId?: string;
  /** Durable delivery-call count reserved before invoking the provider path. */
  attemptCount?: number;
  completionRetention?: DeliveryQueueCompletionRetention;
  notificationReceipt?: DeliveryQueueNotificationReceipt;
  /** Failure-only ownership fence; successful acknowledgement ignores this field. */
  retainOnFailure?: true;
  acknowledgedAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  /** UUID fencing one platform attempt even when clock timestamps collide. */
  platformSendAttemptId?: string;
  platformSendStartedAt?: number;
  recoveryState?: string;
};

export function resolveDeliveryQueueAttemptCount(
  entry: Pick<DeliveryQueueEntryState, "attemptCount" | "retryCount">,
): number {
  const count = entry.attemptCount;
  const persisted = typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 0;
  return Math.max(persisted, entry.retryCount);
}

/** Additional work needs a live claim; settling an observed outcome only needs exact ownership. */
export function hasLiveDeliveryQueueClaim(
  entry: DeliveryQueueEntryState,
  claimId: string,
  now: number,
): boolean {
  const unexpired = typeof entry.availableAt === "number" && entry.availableAt > now;
  return entry.recoveryState === "producer_claimed"
    ? entry.producerClaimId === claimId && unexpired
    : (entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send") &&
        entry.platformSendAttemptId === claimId &&
        (entry.requiresProducerClaim !== true || unexpired);
}

/** Strip a terminal queue row to the producer policy needed for admission. */
export function projectDeliveryQueueTerminalEntry(
  entry: Pick<DeliveryQueueEntryState, "id" | "retryCount" | "notificationReceipt">,
  terminalAt: number,
  terminal: "completed" | "failed",
  completionRetention?: DeliveryQueueCompletionRetention,
): DeliveryQueueEntryState {
  const notificationReceipt = parseDeliveryQueueNotificationReceipt(entry.notificationReceipt);
  if (entry.notificationReceipt !== undefined && !notificationReceipt) {
    throw new Error("Invalid notification delivery receipt");
  }
  const retainedPolicy = notificationReceipt ? "permanent" : completionRetention;
  const retryCount =
    Number.isSafeInteger(entry.retryCount) && entry.retryCount >= 0 ? entry.retryCount : 0;
  const recoveryState = notificationReceipt
    ? "completed_notification"
    : retainedPolicy === "permanent"
      ? "completed_permanent"
      : retainedPolicy
        ? "completed_bounded"
        : undefined;
  return {
    id: entry.id,
    enqueuedAt: terminalAt,
    retryCount,
    ...(terminal === "completed" ? { acknowledgedAt: terminalAt } : { failedAt: terminalAt }),
    ...(retainedPolicy ? { completionRetention: retainedPolicy } : {}),
    ...(notificationReceipt ? { notificationReceipt } : {}),
    ...(recoveryState ? { recoveryState } : {}),
  };
}
