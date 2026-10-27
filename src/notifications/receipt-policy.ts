import {
  parseDeliveryQueueNotificationReceipt,
  type DeliveryQueueNotificationReceipt,
  type DeliveryQueueNotificationReceiptSnapshot,
} from "../infra/delivery-queue-sqlite.types.js";

export type NotificationPreparationCandidate = Readonly<{
  index: number;
  receiptBase: Omit<DeliveryQueueNotificationReceipt, "slot" | "localDate">;
  purpose: "decision" | "result";
  timeZone: string;
}>;

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

/** SQLite's reservation owner calls this policy against its current write snapshot. */
export function electNotificationReceipt(
  candidate: NotificationPreparationCandidate,
  deliveries: readonly DeliveryQueueNotificationReceiptSnapshot[],
  now: number,
): DeliveryQueueNotificationReceipt | undefined {
  if (
    !candidate.receiptBase ||
    typeof candidate.receiptBase !== "object" ||
    Array.isArray(candidate.receiptBase) ||
    Object.keys(candidate.receiptBase).some(
      (key) => !["ownerKey", "topicKey", "revisionKey", "resolvedAt"].includes(key),
    )
  ) {
    throw new Error("Invalid notification preparation candidate");
  }
  const localDate = notificationLocalDate(now, candidate.timeZone);
  const receipt = parseDeliveryQueueNotificationReceipt({
    ...candidate.receiptBase,
    slot: 0,
    localDate,
  });
  if (!receipt || (candidate.purpose !== "decision" && candidate.purpose !== "result")) {
    throw new Error("Invalid notification preparation candidate");
  }
  const topic = deliveries.filter(
    (delivery) =>
      delivery.notificationReceipt.topicKey === receipt.topicKey &&
      delivery.recoveryState !== "completed_notification_canceled",
  );
  if (
    topic.some(
      (delivery) =>
        delivery.status === "pending" ||
        (delivery.status === "failed" &&
          delivery.recoveryState !== "completed_notification" &&
          delivery.recoveryState !== "completed_notification_suppressed"),
    )
  ) {
    return undefined;
  }
  const current = topic.filter(
    (delivery) => delivery.notificationReceipt.revisionKey === receipt.revisionKey,
  );
  if (
    current.some(
      (delivery) =>
        delivery.status === "failed" ||
        delivery.recoveryState === "completed_notification_suppressed" ||
        delivery.notificationReceipt.localDate >= localDate ||
        (delivery.acknowledgedAt !== undefined &&
          notificationLocalDate(delivery.acknowledgedAt, candidate.timeZone) >= localDate),
    )
  ) {
    return undefined;
  }
  const used = new Set(current.map((delivery) => delivery.notificationReceipt.slot));
  const slot = ([0, 1, 2] as const).find((value) => !used.has(value));
  if (slot === undefined || (candidate.purpose === "result" && slot !== 0)) {
    return undefined;
  }
  return { ...receipt, slot };
}
