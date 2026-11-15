import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { readPluginApprovalReceipts } from "../gateway/operator-approval-store.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createPluginApprovalReceipts } from "./approval-receipts.js";

// mock-isolation: Private capability lifetime and scope checks are isolated from storage, which has separate real worker/database tests.
vi.mock("../gateway/operator-approval-store.js", () => ({ readPluginApprovalReceipts: vi.fn() }));
const read = vi.mocked(readPluginApprovalReceipts);
const sessionKey = "agent:nora:imessage:group:42";
const scope = {
  generation: "week-1",
  digest: "a".repeat(64),
  validFromMs: 900,
  validUntilMs: 9_000,
};
function capability(assertCurrent = () => {}) {
  return createPluginApprovalReceipts({
    pluginId: "household",
    agentId: "nora",
    sessionKey,
    assertCurrent,
  });
}
const gatewayContext = { localEmbedded: false } as GatewayRequestContext;
function caller(runId: string, overrides = {}) {
  return {
    agentId: "nora",
    sessionKey,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    receiptAuthority: () => true,
    gatewayContextResolver: () => gatewayContext,
    ...overrides,
  };
}

describe("private plugin approval receipt capability", () => {
  beforeEach(() => {
    read.mockReset();
    read.mockResolvedValue({ outcome: "complete", receipts: [] });
  });
  it("binds source and plugin through fresh admitted turns without exposing selectors", async () => {
    for (const runId of ["original-turn", "fresh-after-restart"]) {
      await withGatewayToolCallerIdentity(caller(runId), async () => {
        await expect(capability().read(scope)).resolves.toEqual({
          outcome: "complete",
          receipts: [],
        });
      });
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[0]).toEqual({
      pluginId: "household",
      agentId: "nora",
      sessionKey,
      scope,
      assertCurrent: expect.any(Function),
    });
    expect(read.mock.calls[0]?.[0]).not.toHaveProperty("nowMs");
  });
  it("refuses absent, mismatched, cron and delegated callers without touching storage", async () => {
    await expect(capability().read(scope)).resolves.toEqual({
      outcome: "held",
      reason: "unavailable",
    });
    for (const override of [
      { gatewayContextResolver: undefined },
      { gatewayContextResolver: () => undefined },
      { gatewayContextResolver: () => ({ localEmbedded: true }) },
      { agentId: "other" },
      { sessionKey: "agent:nora:other" },
      { sessionKey: "agent:nora:cron:job:run:1" },
      { sessionKey: "agent:nora:subagent:child" },
    ]) {
      await withGatewayToolCallerIdentity(caller("wrong-source", override), async () => {
        await expect(capability().read(scope)).resolves.toEqual({
          outcome: "held",
          reason: "unavailable",
        });
      });
    }
    for (const source of ["agent:nora:cron:job:run:1", "agent:nora:subagent:child"]) {
      await withGatewayToolCallerIdentity(caller("delegated", { sessionKey: source }), async () => {
        const bound = createPluginApprovalReceipts({
          pluginId: "household",
          agentId: "nora",
          sessionKey: source,
          assertCurrent: () => {},
        });
        await expect(bound.read(scope)).resolves.toEqual({
          outcome: "held",
          reason: "unavailable",
        });
      });
    }
    await withGatewayToolCallerIdentity(
      caller("no-receipt-owner", { receiptAuthority: undefined }),
      async () => {
        await expect(capability().read(scope)).rejects.toThrow(/authority/u);
      },
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses a replaced or retired Gateway after awaited storage", async () => {
    for (const replacement of [undefined, { localEmbedded: false } as GatewayRequestContext]) {
      let current: GatewayRequestContext | undefined = gatewayContext;
      const pending = createDeferred<Awaited<ReturnType<typeof readPluginApprovalReceipts>>>();
      const started = createDeferred<void>();
      read.mockImplementationOnce(async () => {
        started.resolve();
        return await pending.promise;
      });
      await withGatewayToolCallerIdentity(
        caller("gateway-retirement", { gatewayContextResolver: () => current }),
        async () => {
          const result = capability().read(scope);
          await started.promise;
          current = replacement;
          pending.resolve({ outcome: "complete", receipts: [] });
          await expect(result).rejects.toThrow(/Gateway authority/u);
        },
      );
    }
  });
  it("checks captured owner and run cancellation before read and after awaited storage", async () => {
    const signal = new AbortController();
    const pending = createDeferred<Awaited<ReturnType<typeof readPluginApprovalReceipts>>>();
    const started = createDeferred<void>();
    read.mockImplementationOnce(async () => {
      started.resolve();
      return await pending.promise;
    });
    await withGatewayToolCallerIdentity(
      caller("closing", { approvalSignals: [signal.signal] }),
      async () => {
        const result = capability().read(scope);
        await started.promise;
        signal.abort();
        pending.resolve({ outcome: "complete", receipts: [] });
        await expect(result).rejects.toThrow(/authority/u);
      },
    );
    await withGatewayToolCallerIdentity(caller("retired-plugin"), async () => {
      await expect(
        capability(() => {
          throw new Error("plugin retired");
        }).read(scope),
      ).rejects.toThrow("plugin retired");
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
