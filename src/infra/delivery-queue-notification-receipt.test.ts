import { describe, expect, it } from "vitest";
import {
  inferDeliveryQueueFailureRetention,
  parseDeliveryQueueNotificationReceipt,
  parseDeliveryQueueNotificationReceipts,
  projectDeliveryQueueTerminalEntry,
} from "./delivery-queue-sqlite.types.js";

describe("notification receipt metadata", () => {
  const receipt = {
    ownerKey: "a".repeat(64),
    topicKey: "b".repeat(64),
    revisionKey: "c".repeat(64),
    slot: 1,
    localDate: "2028-02-29",
  } as const;

  it("accepts a real calendar date and safe resolution timestamp", () => {
    expect(parseDeliveryQueueNotificationReceipt({ ...receipt, resolvedAt: 0 })).toEqual({
      ...receipt,
      resolvedAt: 0,
    });
  });

  it("preserves notification failure custody without retaining a raw message body", () => {
    const entry = {
      id: "notification",
      retryCount: 1,
      notificationReceipts: [receipt],
      payloads: [{ text: "private notification copy" }],
    };
    const retention = inferDeliveryQueueFailureRetention(entry, entry.id);
    expect(retention).toBe("permanent");
    expect(projectDeliveryQueueTerminalEntry(entry, 1_000, "failed", retention)).toEqual({
      id: "notification",
      enqueuedAt: 1_000,
      retryCount: 1,
      failedAt: 1_000,
      completionRetention: "permanent",
      notificationReceipts: [receipt],
      recoveryState: "completed_notification",
    });
  });

  it.each([
    { ownerKey: "task name" },
    { topicKey: "A".repeat(64) },
    { revisionKey: "short" },
    { slot: "1" },
    { slot: 3 },
    { localDate: "2026-02-29" },
    { localDate: "2028-02-30" },
    { localDate: "2028-2-29" },
    { resolvedAt: -1 },
    { resolvedAt: 0.5 },
    { resolvedAt: Number.NaN },
    { resolvedAt: Number.POSITIVE_INFINITY },
    { resolvedAt: Number.MAX_SAFE_INTEGER + 1 },
    { text: "private notification copy" },
  ])("rejects malformed or content-bearing metadata %j", (invalid) => {
    expect(parseDeliveryQueueNotificationReceipt({ ...receipt, ...invalid })).toBeUndefined();
  });

  it("refuses content-bearing terminal projection rather than retaining extra fields", () => {
    const contentBearingReceipt = { ...receipt, text: "private notification copy" };
    expect(() =>
      projectDeliveryQueueTerminalEntry(
        { id: "notification", retryCount: 0, notificationReceipts: [contentBearingReceipt] },
        1_000,
        "completed",
      ),
    ).toThrow("Invalid notification delivery receipts");
  });

  it("requires one to sixteen unique opaque topics per physical delivery", () => {
    expect(parseDeliveryQueueNotificationReceipts([receipt])).toEqual([receipt]);
    expect(parseDeliveryQueueNotificationReceipts([])).toBeUndefined();
    expect(parseDeliveryQueueNotificationReceipts([receipt, receipt])).toBeUndefined();
    expect(
      parseDeliveryQueueNotificationReceipts(Array.from({ length: 17 }, () => receipt)),
    ).toBeUndefined();
    expect(
      parseDeliveryQueueNotificationReceipts([{ ...receipt, text: "private" }]),
    ).toBeUndefined();
  });

  it("retains typed cancellation and policy suppression without a provider acknowledgement", () => {
    const entry = { id: "physical", retryCount: 0, notificationReceipts: [receipt] };
    const canceled = projectDeliveryQueueTerminalEntry(
      { ...entry, settlement: { notificationCanceled: true } },
      1_000,
      "failed",
    );
    expect(canceled.recoveryState).toBe("completed_notification_canceled");
    expect(canceled.acknowledgedAt).toBeUndefined();
    const suppressed = projectDeliveryQueueTerminalEntry(
      { ...entry, notificationSuppressed: true },
      1_000,
      "completed",
    );
    expect(suppressed.recoveryState).toBe("completed_notification_suppressed");
    expect(suppressed.acknowledgedAt).toBeUndefined();
  });
});
