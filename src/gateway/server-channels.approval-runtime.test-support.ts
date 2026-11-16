import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  createTestPlugin,
  waitForAbort,
  flushMicrotasks,
  type createTestChannelManager,
  type createTestChannelRegistry,
  type TestAccount,
} from "./server-channels.test-support.js";
const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";
type ApprovalGatewayRequestRuntime = Pick<GatewayNativeApprovalRuntime, "request">;

/** Register against the existing lifecycle suite's managed cleanup and registry fixture. */
export function registerChannelApprovalRuntimeTests({
  createManager,
  installTestRegistry,
  firstStartAccountContext,
}: {
  createManager: typeof createTestChannelManager;
  installTestRegistry: typeof createTestChannelRegistry;
  firstStartAccountContext: (
    startAccount: ReturnType<typeof vi.fn>,
  ) => ChannelGatewayContext<TestAccount>;
}) {
  it("injects a narrow Gateway approval resolver into the channel task runtime", async () => {
    const request = vi.fn(async () => ({ applied: true, approval: {} }));
    const { promise: accountStartReady, resolve: releaseAccountStart } = createDeferred();
    const nativeApprovalRuntime = {
      current: undefined as GatewayNativeApprovalRuntime | undefined,
    };
    let observerCount: number | undefined;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      observerCount = getEventListeners(ctx.abortSignal, "abort").length;
      const stopped = waitForAbort(ctx.abortSignal);
      const approvalRuntime =
        ctx.channelRuntime?.runtimeContexts.get<ApprovalGatewayRequestRuntime>({
          channelId: "discord",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
        });
      await approvalRuntime?.request(
        "approval.resolve",
        { id: "approval-1", kind: "exec", decision: "deny" },
        { clientDisplayName: "Discord approval" },
      );
      await expect(approvalRuntime?.request("config.get" as never, {})).rejects.toThrow(
        "channel approval runtime cannot dispatch config.get",
      );
      await stopped;
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({
      channelRuntime: createRuntimeChannel(),
      deferStartupAccountStartsUntil: accountStartReady,
      getNativeApprovalRuntime: () => nativeApprovalRuntime.current,
    });

    await manager.startChannels();
    expect(startAccount).not.toHaveBeenCalled();
    nativeApprovalRuntime.current = { request } as unknown as GatewayNativeApprovalRuntime;
    releaseAccountStart();
    await flushMicrotasks();

    // Scheduler retirement and approval disposal remain; the deferred-start waiter is gone.
    expect(observerCount).toBe(2);
    expect(request).toHaveBeenCalledWith(
      "approval.resolve",
      { id: "approval-1", kind: "exec", decision: "deny" },
      {
        clientDisplayName: "Discord approval",
        commitGuard: expect.any(Function),
        signal: firstStartAccountContext(startAccount).abortSignal,
      },
    );
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(
      getEventListeners(firstStartAccountContext(startAccount).abortSignal, "abort"),
    ).toHaveLength(0);
  });
}
