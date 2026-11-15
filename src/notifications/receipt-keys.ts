import { createHash } from "node:crypto";

/** Length-framed values prevent delimiter ambiguity; keys never contain task text. */
export function notificationKey(...values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function notificationOwnerKey(sourceId: string, ownerId: string): string {
  return notificationKey(sourceId, ownerId);
}
