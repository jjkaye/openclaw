import { randomUUID } from "node:crypto";
import {
  electNotificationReceipt,
  type NotificationPreparationCandidate,
} from "../../notifications/receipt-policy.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { pruneNotificationDeliveryReceipts } from "../delivery-queue-sqlite-bound.js";
import {
  listNotificationDeliveryReceiptsInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import {
  parseDeliveryQueueNotificationReceipts,
  type DeliveryQueueNotificationReceipt,
} from "../delivery-queue-sqlite.types.js";
import { OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";

export type NotificationPreparationClaim =
  | { status: "suppressed" }
  | {
      status: "claimed";
      entry: StableDeliveryPreparation;
      selected: Array<{ index: number; receipt: DeliveryQueueNotificationReceipt }>;
    };

/** Existing maintenance may release expired custody only before any modifier ran. */
export function retireExpiredNotificationPreparationsInDatabase(
  database: OpenClawStateDatabase,
  now = Date.now(),
): void {
  const queueName = OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME;
  for (const stored of loadDeliveryQueueEntriesInDatabase(database, queueName)) {
    if (stored.notificationReceipts === undefined) {
      continue;
    }
    if (!parseDeliveryQueueNotificationReceipts(stored.notificationReceipts)) {
      continue;
    }
    // SAFETY: This namespace is authored exclusively by the preparation owner.
    const preparation = stored as StableDeliveryPreparation;
    if (
      preparation.preparationState === "claimed" &&
      typeof preparation.preparationLeaseExpiresAt === "number" &&
      preparation.preparationLeaseExpiresAt <= now
    ) {
      terminalizePendingDeliveryQueueEntryInDatabase(
        database,
        prepareDeliveryQueueTerminalEntry({
          queueName,
          id: preparation.id,
          entry: preparation,
          notificationCanceled: true,
        }),
      );
    }
  }
}

/** The worker's write transaction reserves stable topics before allocating a physical ID. */
export function claimNotificationPreparationInDatabase(
  database: OpenClawStateDatabase,
  input: { candidates: readonly NotificationPreparationCandidate[] },
): NotificationPreparationClaim {
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length === 0 ||
    input.candidates.length > 16
  ) {
    throw new Error("Invalid notification preparation candidates");
  }
  const now = Date.now();
  const queueName = OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME;
  for (const candidate of input.candidates) {
    if (
      !Number.isSafeInteger(candidate.index) ||
      candidate.index < 0 ||
      candidate.index > 15 ||
      typeof candidate.timeZone !== "string" ||
      candidate.timeZone.length > 128 ||
      Object.keys(candidate).some(
        (key) => !["index", "receiptBase", "purpose", "timeZone"].includes(key),
      )
    ) {
      throw new Error("Invalid notification preparation candidate");
    }
    electNotificationReceipt(candidate, [], now);
  }
  retireExpiredNotificationPreparationsInDatabase(database, now);
  pruneNotificationDeliveryReceipts(database.db, now);
  const deliveries = listNotificationDeliveryReceiptsInDatabase(database, { includePending: true });
  const topics = new Set<string>();
  const indexes = new Set<number>();
  const selected: Array<{ index: number; receipt: DeliveryQueueNotificationReceipt }> = [];
  for (const candidate of input.candidates) {
    if (topics.has(candidate.receiptBase.topicKey)) {
      continue;
    }
    topics.add(candidate.receiptBase.topicKey);
    if (indexes.has(candidate.index)) {
      throw new Error("Ambiguous notification block index");
    }
    indexes.add(candidate.index);
    const receipt = electNotificationReceipt(candidate, deliveries, now);
    if (receipt) {
      selected.push({ index: candidate.index, receipt });
    }
  }
  if (!selected.length) {
    return { status: "suppressed" };
  }
  const entry: StableDeliveryPreparation = {
    id: `notification-${randomUUID()}`,
    enqueuedAt: now,
    retryCount: 0,
    attemptCount: 0,
    retainOnFailure: true,
    completionRetention: "permanent",
    notificationReceipts: selected.map(({ receipt }) => receipt),
    preparationState: "claimed",
    preparationOwnerId: randomUUID(),
    preparationLeaseExpiresAt: now + 5 * 60_000,
  };
  if (!upsertDeliveryQueueEntryInDatabase({ queueName, entry, insertOnly: true }, database)) {
    throw new Error("Notification preparation identity collision");
  }
  return { status: "claimed", entry, selected };
}
