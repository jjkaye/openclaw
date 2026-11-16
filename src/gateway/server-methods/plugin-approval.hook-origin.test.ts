import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveBeforeToolCallApprovalOutcome } from "../../agents/agent-tools.before-tool-call.approval.js";
import { runBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../../agents/tools/gateway.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { getPluginValueInstance } from "../../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import { createPluginApprovalHandlers } from "./plugin-approval.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

// Only transport is replaced: requests still run the native handler and canonical store.
// mock-isolation: Replace only network transport; each request still enters the native handler and canonical store.
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
const transport = vi.mocked(callGatewayTool);
afterEach(() => transport.mockReset());
const sessionKey = "agent:main:imessage:group:42";

function managedHook(modifyScope?: (scope: Record<string, unknown>) => void) {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "household" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const scope = {
    generation: "week-1",
    digest: "b".repeat(64),
    validFromMs: Date.now() - 1_000,
    validUntilMs: Date.now() + 60_000,
  };
  modifyScope?.(scope);
  const onResolution = vi.fn();
  addTestHook({
    registry,
    pluginId: record.id,
    hookName: "before_tool_call",
    handler: instance.wrap(() => ({
      requireApproval: {
        pluginId: "claimed-other-owner",
        title: "Approve this plan",
        description: "Synthetic plan",
        receiptBinding: { scope, intent: "approve" as const },
        onResolution,
      },
    })),
  });
  return { instance, registry, scope, onResolution, runner: createHookRunner(registry) };
}

for (const retire of [false, true]) {
  it(`persists the managed hook binding and fences retirement=${retire}`, async (test) => {
    const fixture = await createPreparedTestApprovalManager<PluginApprovalRequestPayload>(test, {
      approvalKind: "plugin",
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: `hook-binding-${retire}`,
      runId: `hook-binding-${retire}`,
    });
    const hook = managedHook();
    const context = {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({ agents: { entries: { main: {} } } }),
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: () => validateAgentRunDelegatedAuthority(authority),
    } as unknown as GatewayRequestContext;
    const handler = createPluginApprovalHandlers(fixture.manager)["plugin.approval.request"]!;
    transport.mockImplementation(async (method, _options, params) => {
      const request = params as Record<string, unknown>;
      if (method === "plugin.approval.waitDecision") {
        return {
          id: request.id,
          decision: await fixture.manager.awaitDecision(String(request.id)),
        };
      }
      if (method !== "plugin.approval.request") {
        throw new Error("Unexpected transport method");
      }
      const accepted = createDeferred<Record<string, unknown>>();
      const caller = getGatewayToolCallerIdentity()!;
      const options = {
        req: { method, params, id: "native-hook-request" },
        params,
        context,
        client: {
          connId: "native-hook",
          connect: { client: { id: "native-hook" } },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: caller.agentId,
              sessionKey: caller.sessionKey,
              operationalRunInstance: authority.operationalRunInstance,
              delegatedAuthority: { ...authority, kind: "local" },
              approvalOwnerPluginId: caller.approvalOwnerPluginId,
            },
          },
        },
        isWebchatConnect: () => false,
        respond: (ok: boolean, result: Record<string, unknown>, error: unknown) =>
          ok ? accepted.resolve(result) : accepted.reject(error),
      } as unknown as GatewayRequestHandlerOptions;
      fixture.track(Promise.resolve(handler(options))).catch(accepted.reject);
      return accepted.promise;
    });
    try {
      await fixture.run(async () => {
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: authority.operationalRunInstance,
            approvalAuthority: authority,
            receiptAuthority: () => true,
            gatewayContextResolver: () => context,
          },
          async () => {
            const ctx = { agentId: "main", sessionKey };
            const result = await hook.runner.runBeforeToolCall(
              { toolName: "approve_plan", params: {} },
              ctx,
            );
            expect(result?.requireApproval?.pluginId).toBe("household");
            const receiptBinding = result?.requireApproval?.receiptBinding;
            if (!receiptBinding) {
              throw new Error("Expected private binding snapshot");
            }
            expect(getPluginValueInstance(receiptBinding)).toBe(hook.instance);
            const { pending, payload } = await waitForApprovalRequested(
              context,
              "plugin.approval.requested",
              () =>
                fixture.track(
                  resolveBeforeToolCallApprovalOutcome({
                    result,
                    toolName: "approve_plan",
                    toolCallId: "plan-call",
                    ctx,
                    baseParams: {},
                  }),
                ),
            );
            const [record] = await fixture.manager.listPendingRecords();
            const stored = await getOperatorApprovalDetailed({
              id: record!.id,
              databaseOptions: fixture.databaseOptions,
            });
            expect(stored.outcome).toBe("found");
            if (stored.outcome !== "found") {
              throw new Error("Expected canonical record");
            }
            expect(stored.record.pluginBinding).toEqual({
              version: 1,
              pluginId: "household",
              scope: hook.scope,
              intent: "approve",
              actor: null,
            });
            expect(JSON.stringify(payload)).not.toContain(hook.scope.digest);
            if (retire) {
              await hook.instance.dispose();
            }
            await fixture.manager.resolve(record!.id, "allow-once");
            if (retire) {
              await expect(pending).resolves.toMatchObject({ blocked: true });
              expect(hook.onResolution.mock.calls).toEqual([["cancelled"]]);
              const closed = await getOperatorApprovalDetailed({
                id: record!.id,
                databaseOptions: fixture.databaseOptions,
              });
              expect(closed).toMatchObject({ outcome: "found", record: { status: "cancelled" } });
            } else {
              await expect(pending).resolves.toMatchObject({
                blocked: false,
                approvalResolution: "allow-once",
              });
              expect(hook.onResolution.mock.calls).toEqual([["allow-once"]]);
            }
          },
        );
      });
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
      await hook.instance.dispose();
    }
  });
}

it("holds a bound request without current native caller authority before transport", async () => {
  const hook = managedHook();
  transport.mockResolvedValue({ id: "must-not-request", decision: "allow-once" });
  try {
    const ctx = { agentId: "main", sessionKey };
    const result = await hook.runner.runBeforeToolCall(
      { toolName: "approve_plan", params: {} },
      ctx,
    );
    await expect(
      resolveBeforeToolCallApprovalOutcome({
        result,
        toolName: "approve_plan",
        toolCallId: "unadmitted-call",
        ctx,
        baseParams: {},
      }),
    ).resolves.toMatchObject({ blocked: true });
    expect(transport).not.toHaveBeenCalled();
    expect(hook.onResolution.mock.calls).toEqual([["cancelled"]]);
  } finally {
    await hook.instance.dispose();
  }
});

for (const mode of [
  "copied",
  "retired",
  "embedded",
  "remote",
  "wrong-session",
  "cron",
  "subagent",
]) {
  it(`holds ${mode} bound approval before transport`, async () => {
    const authority = claimAgentRunDelegatedAuthority({
      instanceId: `unavailable-${mode}`,
      runId: `unavailable-${mode}`,
    });
    const hook = managedHook();
    const sourceSession =
      mode === "cron"
        ? "agent:main:cron:job:run:1"
        : mode === "subagent"
          ? "agent:main:subagent:child"
          : sessionKey;
    const ctx = { agentId: "main", sessionKey: sourceSession };
    const context = { localEmbedded: mode === "embedded" } as GatewayRequestContext;
    transport.mockResolvedValue({ id: "must-not-request", decision: "allow-once" });
    try {
      const result = await hook.runner.runBeforeToolCall(
        { toolName: "approve_plan", params: {} },
        ctx,
      );
      if (!result?.requireApproval?.receiptBinding) {
        throw new Error("Expected opt-in binding");
      }
      if (mode === "copied") {
        result.requireApproval.receiptBinding = {
          ...result.requireApproval.receiptBinding,
          scope: { ...result.requireApproval.receiptBinding.scope },
        };
      }
      if (mode === "retired") {
        await hook.instance.dispose();
      }
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: mode === "wrong-session" ? "agent:main:other" : sourceSession,
          operationalRunInstance: authority.operationalRunInstance,
          approvalAuthority: authority,
          receiptAuthority: () => true,
          gatewayContextResolver: () => (mode === "remote" ? undefined : context),
        },
        async () => {
          await expect(
            resolveBeforeToolCallApprovalOutcome({
              result,
              toolName: "approve_plan",
              toolCallId: "unavailable-call",
              ctx,
              baseParams: {},
            }),
          ).resolves.toMatchObject({ blocked: true });
        },
      );
      expect(transport).not.toHaveBeenCalled();
      expect(hook.onResolution.mock.calls).toEqual([["cancelled"]]);
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
      await hook.instance.dispose();
    }
  });
}

for (const malformed of [false, true]) {
  it(`keeps foreign scope values unowned while rejecting malformed=${malformed}`, async () => {
    const foreign = new PluginInstance("foreign");
    const value = foreign.adopt({ retained: "foreign resource" });
    const hook = managedHook((scope) =>
      Object.assign(scope, malformed ? { generation: value } : { extra: value }),
    );
    try {
      const ctx = { agentId: "main", sessionKey };
      const result = await hook.runner.runBeforeToolCall(
        { toolName: "approve_plan", params: {} },
        ctx,
      );
      expect(getPluginValueInstance(value)).toBe(foreign);
      if (malformed) {
        expect(result).toMatchObject({ block: true });
        setActivePluginRegistry(hook.registry);
        initializeGlobalHookRunner(hook.registry);
        await expect(
          runBeforeToolCallHook({
            toolName: "approve_plan",
            toolCallId: "invalid-scope",
            params: {},
            ctx,
          }),
        ).resolves.toMatchObject({ blocked: true });
        expect(transport).not.toHaveBeenCalled();
      } else {
        expect(result?.requireApproval?.receiptBinding?.scope).not.toHaveProperty("extra");
      }
    } finally {
      resetGlobalHookRunner();
      setActivePluginRegistry(createEmptyPluginRegistry());
      await hook.instance.dispose();
      await foreign.dispose();
    }
  });
}
