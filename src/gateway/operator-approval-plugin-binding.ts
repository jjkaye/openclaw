import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PluginApprovalActor,
  PluginApprovalBinding,
} from "./operator-approval-store.types.js";

function boundedIdentity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

function decodeActor(value: unknown): PluginApprovalActor | null {
  return isRecord(value) &&
    boundedIdentity(value.channel) &&
    boundedIdentity(value.accountId) &&
    boundedIdentity(value.senderId) &&
    boundedIdentity(value.conversationId)
    ? {
        channel: value.channel,
        accountId: value.accountId,
        senderId: value.senderId,
        conversationId: value.conversationId,
      }
    : null;
}

export function isPluginApprovalScope(
  scope: unknown,
  retentionMs: number,
): scope is PluginApprovalBinding["scope"] {
  return (
    isRecord(scope) &&
    boundedIdentity(scope.generation) &&
    typeof scope.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(scope.digest) &&
    typeof scope.validFromMs === "number" &&
    typeof scope.validUntilMs === "number" &&
    Number.isSafeInteger(scope.validFromMs) &&
    Number.isSafeInteger(scope.validUntilMs) &&
    scope.validFromMs >= 0 &&
    scope.validUntilMs >= scope.validFromMs &&
    scope.validUntilMs - scope.validFromMs < retentionMs
  );
}

/** Decode persisted provenance independently of public presentation fields. */
export function decodePluginApprovalBinding(
  raw: string,
  retentionMs: number,
): PluginApprovalBinding | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !boundedIdentity(value.pluginId) ||
      (value.intent !== "approve" && value.intent !== "revoke") ||
      (value.actor !== null && !decodeActor(value.actor)) ||
      !isPluginApprovalScope(value.scope, retentionMs)
    ) {
      return null;
    }
    const scope = value.scope;
    return {
      version: 1,
      pluginId: value.pluginId,
      scope: {
        generation: scope.generation,
        digest: scope.digest,
        validFromMs: scope.validFromMs,
        validUntilMs: scope.validUntilMs,
      },
      intent: value.intent,
      actor: value.actor === null ? null : decodeActor(value.actor),
    };
  } catch {
    return null;
  }
}
