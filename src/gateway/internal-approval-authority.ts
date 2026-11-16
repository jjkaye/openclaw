import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApprovalResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { isWellFormedApprovalId } from "../../packages/gateway-protocol/src/schema/approvals.js";
import type { PluginApprovalActor } from "./operator-approval-store.types.js";

type NativeChannelDecision = {
  id: string;
  kind: "plugin";
  decision: ApprovalResolveParams["decision"];
  actor: PluginApprovalActor;
};
const internalApprovalGuards = new WeakMap<() => void, NativeChannelDecision | undefined>();

/** First-party producers retain their live owner; opaque SDK callbacks are never promoted. */
export function retainInternalApprovalCommitGuard<T extends () => void>(
  guard: T,
  sourceGuard?: () => void,
): T {
  if (sourceGuard && !internalApprovalGuards.has(sourceGuard)) {
    throw new Error("native approval source guard is not host-owned");
  }
  internalApprovalGuards.set(guard, internalApprovalGuards.get(sourceGuard ?? guard));
  return guard;
}

export function isInternalApprovalCommitGuard(guard: (() => void) | undefined): boolean {
  return guard !== undefined && internalApprovalGuards.has(guard);
}

function identity(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

/** Called only by the admitted account task after a native control matched its prompt. */
export function retainNativeChannelApprovalDecision(params: {
  guard: () => void;
  channel: string;
  accountId: string;
  request: Record<string, unknown>;
  conversationId?: string;
}): () => void {
  if (!isInternalApprovalCommitGuard(params.guard))
    throw new Error("native account guard required");
  params.guard();
  if (params.request.kind !== "plugin" || params.conversationId === undefined) return params.guard;
  const { id, decision, reviewer } = params.request;
  if (
    typeof id !== "string" ||
    !isWellFormedApprovalId(id) ||
    (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") ||
    !isRecord(reviewer) ||
    reviewer.channel !== params.channel ||
    reviewer.accountId !== params.accountId ||
    !identity(params.channel) ||
    !identity(params.accountId) ||
    !identity(reviewer.senderId) ||
    !identity(params.conversationId)
  )
    throw new Error("native approval decision does not match its account");
  const sourceGuard = params.guard;
  const guard = () => sourceGuard();
  const actor = Object.freeze({
    channel: params.channel,
    accountId: params.accountId,
    senderId: reviewer.senderId,
    conversationId: params.conversationId,
  });
  internalApprovalGuards.set(guard, Object.freeze({ id, kind: "plugin", decision, actor }));
  return guard;
}

/** Canonical ID and verdict must still match at the terminal CAS, including transport aliases. */
export function readNativeChannelApprovalActor(
  guard: (() => void) | undefined,
  request: {
    id: string;
    kind: string;
    decision: string | null;
    reviewer?: ApprovalResolveParams["reviewer"];
  },
): PluginApprovalActor | undefined {
  const decision = guard && internalApprovalGuards.get(guard);
  if (!decision) return undefined;
  guard();
  if (
    decision.id !== request.id ||
    decision.kind !== request.kind ||
    decision.decision !== request.decision ||
    decision.actor.channel !== request.reviewer?.channel ||
    decision.actor.accountId !== request.reviewer?.accountId ||
    decision.actor.senderId !== request.reviewer?.senderId
  ) {
    throw new Error("native approval actor does not match the canonical decision");
  }
  return decision.actor;
}
