import { describe, expect, it } from "vitest";
import type { DeliveryQueueNotificationReceiptSnapshot } from "../infra/delivery-queue-sqlite.types.js";
import {
  electNotificationReceipt,
  type NotificationPreparationCandidate,
} from "./receipt-policy.js";

describe("notification receipt election", () => {
  const candidate: NotificationPreparationCandidate = {
    index: 0,
    purpose: "decision",
    timeZone: "America/New_York",
    receiptBase: {
      ownerKey: "a".repeat(64),
      topicKey: "b".repeat(64),
      revisionKey: "c".repeat(64),
    },
  };
  const now = Date.parse("2026-11-01T17:00:00Z");
  const delivered = (
    overrides: Partial<DeliveryQueueNotificationReceiptSnapshot> = {},
  ): DeliveryQueueNotificationReceiptSnapshot => ({
    queueName: "outbound",
    id: "physical",
    status: "completed",
    recoveryState: "completed_notification",
    notificationReceipt: { ...candidate.receiptBase, slot: 0, localDate: "2026-10-31" },
    ...overrides,
  });

  it("elects three distinct later-local-date slots and counts actual acknowledgement date", () => {
    const first = electNotificationReceipt(candidate, [], now)!;
    expect(first).toMatchObject({ slot: 0, localDate: "2026-11-01" });
    expect(
      electNotificationReceipt(candidate, [delivered({ notificationReceipt: first })], now),
    ).toBeUndefined();
    const day2 = now + 24 * 60 * 60_000;
    const second = electNotificationReceipt(
      candidate,
      [delivered({ notificationReceipt: first })],
      day2,
    )!;
    expect(second.slot).toBe(1);
    const history = [first, second].map((notificationReceipt) =>
      delivered({ notificationReceipt }),
    );
    const third = electNotificationReceipt(candidate, history, day2 + 24 * 60 * 60_000)!;
    expect(third.slot).toBe(2);
    expect(
      electNotificationReceipt(
        candidate,
        [...history, delivered({ notificationReceipt: third })],
        day2 + 48 * 60 * 60_000,
      ),
    ).toBeUndefined();
    expect(
      electNotificationReceipt(candidate, [delivered({ acknowledgedAt: now })], now),
    ).toBeUndefined();
  });

  it("holds unknown and partial older revisions while excluding wholly canceled occurrences", () => {
    const older = delivered({
      status: "pending",
      recoveryState: "unknown_after_send",
      notificationReceipt: {
        ...candidate.receiptBase,
        revisionKey: "d".repeat(64),
        slot: 0,
        localDate: "2026-10-31",
      },
    });
    expect(electNotificationReceipt(candidate, [older], now)).toBeUndefined();
    expect(
      electNotificationReceipt(
        candidate,
        [{ ...older, status: "failed", recoveryState: "settlement_pending" }],
        now,
      ),
    ).toBeUndefined();
    expect(
      electNotificationReceipt(
        candidate,
        [delivered({ status: "failed", recoveryState: "completed_notification_canceled" })],
        now,
      )?.slot,
    ).toBe(0);
  });

  it("keeps suppressed or rejected current revisions quiet and permits meaningful new revisions", () => {
    const suppressed = delivered({ recoveryState: "completed_notification_suppressed" });
    expect(electNotificationReceipt(candidate, [suppressed], now)).toBeUndefined();
    expect(
      electNotificationReceipt(candidate, [delivered({ status: "failed" })], now),
    ).toBeUndefined();
    expect(
      electNotificationReceipt(
        { ...candidate, receiptBase: { ...candidate.receiptBase, revisionKey: "d".repeat(64) } },
        [suppressed],
        now,
      )?.slot,
    ).toBe(0);
    expect(
      electNotificationReceipt({ ...candidate, purpose: "result" }, [delivered()], now),
    ).toBeUndefined();
  });
});
