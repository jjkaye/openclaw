import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { NotificationSourceReference } from "./source-types.js";

export type NotificationProposal = NotificationSourceReference & { expectedRevision: string };
export type NotificationBlock = {
  notification: NotificationProposal;
  text: string;
  spokenText?: string;
};
export const NOTIFICATION_BATCH_CHANNEL_DATA_KEY = "openclawNotificationBatch";
export const NOTIFICATION_CHANNEL_DATA_KEY = "openclawNotification";
export const NOTIFICATION_ENVELOPE_SCHEMA = "openclaw.notification.v1";

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim()
  );
}

export function parseNotificationProposal(value: unknown): NotificationProposal | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["sourceId", "ownerId", "topicId", "purpose", "expectedRevision"].includes(key),
    ) ||
    !identifier(value.sourceId) ||
    !identifier(value.ownerId) ||
    !identifier(value.topicId) ||
    !identifier(value.expectedRevision) ||
    (value.purpose !== "decision" && value.purpose !== "result")
  ) {
    return undefined;
  }
  return {
    sourceId: value.sourceId,
    ownerId: value.ownerId,
    topicId: value.topicId,
    purpose: value.purpose,
    expectedRevision: value.expectedRevision,
  };
}

/** Length-framed values prevent delimiter ambiguity; keys never contain task text. */
export function notificationKey(...values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function notificationOwnerKey(sourceId: string, ownerId: string): string {
  return notificationKey(sourceId, ownerId);
}

/** Only explicitly tagged cron output is interpreted as a notification envelope. */
export function unwrapNotificationEnvelope(
  text: string,
): { text: string; notification: NotificationProposal } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.$schema !== NOTIFICATION_ENVELOPE_SCHEMA) {
    return undefined;
  }
  const notification = parseNotificationProposal(value.notification);
  if (
    !notification ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    Object.keys(value).some((key) => !["$schema", "notification", "text"].includes(key))
  ) {
    throw new Error("Invalid notification envelope");
  }
  return { text: value.text.trim(), notification };
}

/** A briefing may contain independently admitted subjects, in their display order. */
export function unwrapNotificationEnvelopes(
  text: string,
): Array<{ text: string; notification: NotificationProposal }> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.$schema !== NOTIFICATION_ENVELOPE_SCHEMA) {
    return undefined;
  }
  if (!("notifications" in value)) {
    const single = unwrapNotificationEnvelope(text);
    return single ? [single] : undefined;
  }
  if (
    Object.keys(value).some((key) => !["$schema", "notifications"].includes(key)) ||
    !Array.isArray(value.notifications) ||
    value.notifications.length === 0 ||
    value.notifications.length > 16
  ) {
    throw new Error("Invalid notification envelope");
  }
  return value.notifications.map((item: unknown) => {
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => !["notification", "text"].includes(key))
    ) {
      throw new Error("Invalid notification envelope");
    }
    const parsed = unwrapNotificationEnvelope(
      JSON.stringify({ ...item, $schema: NOTIFICATION_ENVELOPE_SCHEMA }),
    );
    if (!parsed) {
      throw new Error("Invalid notification envelope");
    }
    return parsed;
  });
}
