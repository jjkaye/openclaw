import { describe, expect, it } from "vitest";
import {
  inferDeliveryQueueFailureRetention,
  parseDeliveryQueueNotificationReceipt,
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
      notificationReceipt: receipt,
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
      notificationReceipt: receipt,
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
        { id: "notification", retryCount: 0, notificationReceipt: contentBearingReceipt },
        1_000,
        "completed",
      ),
    ).toThrow("Invalid notification delivery receipt");
  });
});
