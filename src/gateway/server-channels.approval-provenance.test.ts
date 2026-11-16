import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { isInternalApprovalCommitGuard } from "./internal-approval-authority.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  waitForAbort,
} from "./server-channels.test-support.js";

// mock-isolation: Bootstrap I/O is outside account-capability custody; exercise the real channel lifecycle without live notification handlers.
vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: vi.fn(async () => async () => {}),
}));
const previousRegistry = getActivePluginRegistry();
afterEach(() => {
  setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  resetGatewayWorkAdmission();
});
const requestParams = {
  id: "plugin:plan-1",
  kind: "plugin",
  decision: "allow-once",
  reviewer: { channel: "imessage", accountId: DEFAULT_ACCOUNT_ID, senderId: "+15555550101" },
};
const requestOptions = {
  clientDisplayName: "Synthetic household approval",
  conversationId: "chat_id:42",
};

async function fixture() {
  resetGatewayWorkAdmission();
  let started = createDeferred<void>();
  let current: Pick<GatewayNativeApprovalRuntime, "request"> | undefined;
  const request = vi.fn(
    async (
      _method: string,
      _params: Record<string, unknown>,
      _options?: { clientDisplayName?: string; commitGuard?: () => void; signal?: AbortSignal },
    ) => ({ applied: true, approval: {} }),
  );
  const plugin = createTestPlugin({
    id: "imessage",
    startAccount: async (ctx) => {
      current = ctx.channelRuntime?.runtimeContexts.get<
        Pick<GatewayNativeApprovalRuntime, "request">
      >({ channelId: "imessage", accountId: DEFAULT_ACCOUNT_ID, capability: "approval.gateway" });
      started.resolve();
      await waitForAbort(ctx.abortSignal);
    },
  });
  setActivePluginRegistry(createTestChannelRegistry(plugin));
  const manager = createTestChannelManager({
    channelIds: ["imessage"],
    channelRuntime: createRuntimeChannel(),
    getNativeApprovalRuntime: () => ({ request }) as unknown as GatewayNativeApprovalRuntime,
  });
  await manager.startChannels();
  await started.promise;
  if (!current) {
    throw new Error("Expected native account approval capability");
  }
  return {
    current,
    request,
    manager,
    restart: async () => {
      started = createDeferred<void>();
      await manager.startChannel("imessage", DEFAULT_ACCOUNT_ID);
      await started.promise;
      return current!;
    },
  };
}

it("binds native approval dispatch to the account's private current commit guard", async () => {
  const f = await fixture();
  try {
    await f.current.request("approval.resolve", requestParams, requestOptions);
    const options = f.request.mock.calls[0]?.[2];
    expect(isInternalApprovalCommitGuard(options?.commitGuard)).toBe(true);
    expect(options?.signal?.aborted).toBe(false);
    expect(() => options?.commitGuard?.()).not.toThrow();
    await f.manager.stopChannel("imessage", DEFAULT_ACCOUNT_ID);
    expect(options?.signal?.aborted).toBe(true);
    expect(() => options?.commitGuard?.()).toThrow();
  } finally {
    await f.manager.stopChannel("imessage", DEFAULT_ACCOUNT_ID);
  }
});

it("never revives a retained approval capability after account stop and re-enable", async () => {
  const f = await fixture();
  try {
    await f.current.request("approval.resolve", requestParams, requestOptions);
    await f.manager.stopChannel("imessage", DEFAULT_ACCOUNT_ID);
    await expect(
      f.current.request("approval.resolve", requestParams, requestOptions),
    ).rejects.toThrow();
    const originalGuard = f.request.mock.calls[0]?.[2]?.commitGuard;
    const replacement = await f.restart();
    expect(originalGuard).toBeTypeOf("function");
    expect(() => originalGuard?.()).toThrow();
    await expect(
      f.current.request("approval.resolve", requestParams, requestOptions),
    ).rejects.toThrow();
    await replacement.request("approval.resolve", requestParams, requestOptions);
    expect(f.request).toHaveBeenCalledTimes(2);
  } finally {
    await f.manager.stopChannel("imessage", DEFAULT_ACCOUNT_ID);
  }
});
