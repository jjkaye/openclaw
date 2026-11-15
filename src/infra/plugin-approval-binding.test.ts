import { afterEach, describe, expect, it } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import {
  claimAgentRunDelegatedAuthority,
  claimAgentRunApprovalAuthority,
  validateAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "./agent-run-registry.js";
import {
  registerPluginApprovalBinding,
  takePluginApprovalBinding,
} from "./plugin-approval-binding.js";

afterEach(resetAgentRunRegistryForTest);

function binding() {
  const authority = claimAgentRunDelegatedAuthority(createOperationalRunInstanceRef("assent-run"));
  return {
    authority,
    agentId: "nora",
    sessionKey: "agent:nora:imessage:group:42",
    toolCallId: "capture-1",
    pluginId: "household",
    scope: { generation: "week-1", digest: "a".repeat(64), validFromMs: 900, validUntilMs: 9_000 },
    intent: "approve" as const,
    assertCurrent: () => {},
  };
}

describe("native originating plugin approval handoff", () => {
  it("matches the native live source and consumes the handoff only once", () => {
    const original = binding();
    const retained = registerPluginApprovalBinding(original);
    expect(() => retained.assertConsumed()).toThrow(/handoff/u);
    for (const change of [
      { pluginId: "forged" },
      { agentId: "other" },
      { sessionKey: "other" },
      { toolCallId: "other" },
    ]) {
      expect(takePluginApprovalBinding({ ...original, ...change })).toBeUndefined();
    }
    const received = takePluginApprovalBinding(original);
    expect(received?.binding).toEqual({
      version: 1,
      pluginId: "household",
      scope: original.scope,
      intent: "approve",
      actor: null,
    });
    retained.assertConsumed();
    expect(takePluginApprovalBinding(original)).toBeUndefined();
    releaseAgentRunDelegatedAuthority(original.authority);
    expect(() => received?.assertCurrent()).toThrow(/authority/u);
    retained.release();
  });
  it("retains a consuming lease cancellation without revoking the live source run", () => {
    const original = binding();
    const abort = new AbortController();
    const consumer = claimAgentRunApprovalAuthority(original.authority, [abort.signal]);
    const retained = registerPluginApprovalBinding(original);
    const received = takePluginApprovalBinding({ ...original, authority: consumer });
    expect(received).toBeDefined();
    received!.assertCurrent();
    abort.abort();
    expect(validateAgentRunDelegatedAuthority(original.authority)).toBe(true);
    expect(() => received!.assertCurrent()).toThrow(/authority/u);
    retained.release();
  });

  it("supports a native source lease and refuses a broader consumer", () => {
    const original = binding();
    const abort = new AbortController();
    const source = claimAgentRunApprovalAuthority(original.authority, [abort.signal]);
    const retained = registerPluginApprovalBinding({ ...original, authority: source });
    expect(takePluginApprovalBinding(original)).toBeUndefined();
    const consumer = claimAgentRunApprovalAuthority(source, []);
    const received = takePluginApprovalBinding({ ...original, authority: consumer });
    expect(received).toBeDefined();
    abort.abort();
    expect(validateAgentRunDelegatedAuthority(original.authority)).toBe(true);
    expect(() => received!.assertCurrent()).toThrow(/authority/u);
    retained.release();
  });

  it("refuses ambiguous, cancelled and replacement-owner handoffs", () => {
    const original = binding();
    const first = registerPluginApprovalBinding(original);
    const second = registerPluginApprovalBinding(original);
    expect(takePluginApprovalBinding(original)).toBeUndefined();
    second.release();
    first.release();
    expect(takePluginApprovalBinding(original)).toBeUndefined();
    const pending = registerPluginApprovalBinding(original);
    const replacement = claimAgentRunDelegatedAuthority(
      createOperationalRunInstanceRef("assent-run"),
    );
    expect(takePluginApprovalBinding({ ...original, authority: replacement })).toBeUndefined();
    expect(() => pending.assertConsumed()).toThrow(/authority|handoff/u);
    pending.release();
  });
});
