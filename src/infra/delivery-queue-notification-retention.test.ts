import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneDeliveryQueueTombstones,
  pruneNotificationDeliveryReceipts,
} from "./delivery-queue-sqlite-bound.js";
import {
  NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS,
  projectDeliveryQueueTerminalEntry,
  type DeliveryQueueNotificationReceipt,
} from "./delivery-queue-sqlite.types.js";

describe("notification receipt database retention", () => {
  let db: DatabaseSync;
  const now = Date.UTC(2026, 9, 27, 12);
  const receipt = {
    ownerKey: "a".repeat(64),
    topicKey: "b".repeat(64),
    revisionKey: "c".repeat(64),
    slot: 0,
    localDate: "2026-10-27",
  } as const;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE delivery_queue_entries (
      queue_name TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL,
      recovery_state TEXT, entry_json TEXT NOT NULL, enqueued_at INTEGER NOT NULL,
      PRIMARY KEY (queue_name, id))`);
  });

  afterEach(() => db.close());

  const seed = (id: string, notificationReceipt: DeliveryQueueNotificationReceipt) => {
    const entry = projectDeliveryQueueTerminalEntry(
      { id, retryCount: 0, notificationReceipt },
      1,
      "completed",
    );
    db.prepare("INSERT INTO delivery_queue_entries VALUES (?, ?, ?, ?, ?, ?)").run(
      "notification-test",
      id,
      "completed",
      entry.recoveryState ?? null,
      JSON.stringify(entry),
      entry.enqueuedAt,
    );
  };

  const ids = () =>
    db
      .prepare("SELECT id FROM delivery_queue_entries ORDER BY id")
      .all()
      .map((row) => row.id);

  it("keeps open notification receipts while pruning only sufficiently old resolutions", () => {
    seed("open", receipt);
    seed("recent-resolution", { ...receipt, resolvedAt: now - 1 });
    seed("future-resolution", { ...receipt, resolvedAt: now + 1 });
    seed("expired-resolution", {
      ...receipt,
      resolvedAt: now - NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS,
    });
    expect(pruneDeliveryQueueTombstones(db, now)).toBe(true);
    expect(ids()).toEqual(["future-resolution", "open", "recent-resolution"]);
    expect(pruneDeliveryQueueTombstones(db, now)).toBe(false);
  });

  it("scopes exact replay cleanup to its receipt and preserves malformed custody", () => {
    const resolvedAt = now - NOTIFICATION_RECEIPT_RESOLVED_RETENTION_MS;
    seed("exact", { ...receipt, resolvedAt });
    seed("sibling", { ...receipt, resolvedAt });
    db.prepare("INSERT INTO delivery_queue_entries VALUES (?, ?, ?, ?, ?, ?)").run(
      "notification-test",
      "malformed",
      "completed",
      "completed_notification",
      JSON.stringify({ notificationReceipt: { ...receipt, localDate: "2026-02-30", resolvedAt } }),
      1,
    );
    expect(
      pruneNotificationDeliveryReceipts(db, now, { queueName: "notification-test", id: "exact" }),
    ).toBe(true);
    expect(ids()).toEqual(["malformed", "sibling"]);
    expect(pruneNotificationDeliveryReceipts(db, now)).toBe(true);
    expect(ids()).toEqual(["malformed"]);
  });
});
