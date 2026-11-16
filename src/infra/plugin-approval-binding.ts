import type { PluginApprovalBinding } from "../gateway/operator-approval-store.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

type PluginApprovalSource = {
  authority: AgentRunDelegatedAuthority;
  agentId: string;
  sessionKey: string;
  pluginId: string;
  toolCallId: string;
};
type PluginApprovalHandoff = PluginApprovalSource & {
  binding: Omit<PluginApprovalBinding, "actor"> & { actor: null };
  assertCurrent: () => void;
  consumed: boolean;
};

// Native host admission supplies both leases. The opaque run-owner map is
// process-local; public request fields never register an originating binding.
const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginApprovalBindings"),
  () => new WeakMap<AgentRunDelegatedAuthority, Set<PluginApprovalHandoff>>(),
);

export function registerPluginApprovalBinding(
  input: PluginApprovalSource & {
    scope: PluginApprovalBinding["scope"];
    intent: PluginApprovalBinding["intent"];
    assertCurrent: () => void;
  },
): { release: () => void; assertConsumed: () => void } {
  const sourceAuthority = input.authority;
  const owner = getActiveAgentRunDelegatedAuthority(sourceAuthority.operationalRunInstance);
  if (!owner || !validateAgentRunDelegatedAuthority(sourceAuthority)) {
    throw new Error("plugin approval handoff requires live native source authority");
  }
  const assertSourceCurrent = input.assertCurrent;
  const assertCurrent = () => {
    if (!validateAgentRunDelegatedAuthority(sourceAuthority)) {
      throw new Error("plugin approval handoff authority is no longer active");
    }
    assertSourceCurrent();
    if (!validateAgentRunDelegatedAuthority(sourceAuthority)) {
      throw new Error("plugin approval handoff authority is no longer active");
    }
  };
  assertCurrent();
  const entry: PluginApprovalHandoff = {
    authority: sourceAuthority,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    pluginId: input.pluginId,
    toolCallId: input.toolCallId,
    binding: Object.freeze({
      version: 1,
      pluginId: input.pluginId,
      scope: Object.freeze({ ...input.scope }),
      intent: input.intent,
      actor: null,
    }),
    assertCurrent,
    consumed: false,
  };
  const entries = bindings.get(owner) ?? new Set<PluginApprovalHandoff>();
  entries.add(entry);
  bindings.set(owner, entries);
  return {
    release: () => {
      entries.delete(entry);
    },
    assertConsumed: () => {
      assertCurrent();
      if (!entry.consumed) {
        throw new Error("plugin approval handoff was not accepted by the native owner");
      }
    },
  };
}

export function takePluginApprovalBinding(
  source: PluginApprovalSource,
): Pick<PluginApprovalHandoff, "binding" | "assertCurrent"> | undefined {
  if (!validateAgentRunDelegatedAuthority(source.authority)) {
    return undefined;
  }
  const owner = getActiveAgentRunDelegatedAuthority(source.authority.operationalRunInstance);
  const entries = owner && bindings.get(owner);
  const matches = [...(entries ?? [])].filter(
    (entry) =>
      entry.agentId === source.agentId &&
      entry.sessionKey === source.sessionKey &&
      entry.pluginId === source.pluginId &&
      entry.toolCallId === source.toolCallId,
  );
  if (matches.length !== 1) {
    return undefined;
  }
  const entry = matches[0]!;
  const consumerAuthority = source.authority;
  if (!validateAgentRunDelegatedAuthority(consumerAuthority, entry.authority)) {
    return undefined;
  }
  const assertCurrent = () => {
    entry.assertCurrent();
    if (!validateAgentRunDelegatedAuthority(consumerAuthority, entry.authority)) {
      throw new Error("plugin approval consuming authority is no longer active");
    }
    entry.assertCurrent();
    if (!validateAgentRunDelegatedAuthority(consumerAuthority, entry.authority)) {
      throw new Error("plugin approval consuming authority is no longer active");
    }
  };
  assertCurrent();
  entries!.delete(entry);
  entry.consumed = true;
  return { binding: entry.binding, assertCurrent };
}
