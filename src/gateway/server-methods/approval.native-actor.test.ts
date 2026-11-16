import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayNativeApprovalRuntime } from "../../infra/approval-gateway-runtime.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createRuntimeChannel } from "../../plugins/runtime/runtime-channel.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { APPROVALS_SCOPE } from "../method-scopes.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import {
  createTestChannelManager,
  createTestChannelRegistry,
  createTestPlugin,
  waitForAbort,
} from "../server-channels.test-support.js";
import { createGatewayInstanceRuntime } from "../server-instance-runtime.js";
import {
  cleanupApprovalHandlerFixtures,
  createDatabaseOptions,
  createManagers,
  getOperatorApproval,
} from "./approval.handlers.test-support.js";
import { createApprovalHandlers } from "./approval.js";
import { createApprovalInvocation, createClient, createContext } from "./approval.test-support.js";

// mock-isolation: Isolate notification bootstrap I/O while retaining real account, Gateway, canonical handler and database owners.
vi.mock("../../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: vi.fn(async () => async () => {}),
}));
const previousRegistry = getActivePluginRegistry();
afterEach(async () => {
  await cleanupApprovalHandlerFixtures();
  setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  resetGatewayWorkAdmission();
});
const senderId = "+15555550101";
const conversationId = "chat_id:42";
const reviewer = { channel: "imessage", accountId: DEFAULT_ACCOUNT_ID, senderId };

async function fixture(rewrite?: (body: Record<string, unknown>) => Record<string, unknown>) {
  resetGatewayWorkAdmission();
  const databaseOptions = createDatabaseOptions();
  const managers = createManagers(databaseOptions);
  const record = managers.plugin.create(
    {
      title: "Approve household plan",
      description: "Synthetic immutable plan",
      severity: "warning",
      pluginId: "household",
      toolName: "capture_plan",
      agentId: "main",
      sessionKey: "agent:main:imessage:group:42",
      turnSourceChannel: "imessage",
      turnSourceAccountId: DEFAULT_ACCOUNT_ID,
    },
    60_000,
    "plugin:household-plan-1",
  );
  record.pluginBinding = {
    version: 1,
    pluginId: "household",
    intent: "approve",
    actor: null,
    scope: {
      generation: "week-1",
      digest: "d".repeat(64),
      validFromMs: Date.now() - 1_000,
      validUntilMs: Date.now() + 30_000,
    },
  };
  record.approvalReviewerDeviceIds = ["operator"];
  await managers.plugin.register(record, 60_000);
  const handlers = createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    databaseOptions,
  });
  const context = createContext();
  const cfg = { channels: { imessage: { allowFrom: [senderId, "+15555550102"] } } };
  context.getRuntimeConfig = () => cfg;
  context.trackExecution = trackAsyncWork;
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: APPROVALS_SCOPE,
    })),
  );
  const gateway = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => true,
  });
  const started = createDeferred<void>();
  let current: Pick<GatewayNativeApprovalRuntime, "request"> | undefined;
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
  plugin.approvalCapability = {
    authorizeActorAction: ({ cfg: currentCfg, senderId: actor }) => ({
      authorized:
        typeof actor === "string" &&
        currentCfg.channels?.imessage?.allowFrom?.includes(actor) === true,
    }),
  };
  setActivePluginRegistry(createTestChannelRegistry(plugin));
  const channel = createTestChannelManager({
    channelIds: ["imessage"],
    channelRuntime: createRuntimeChannel(),
    getRuntimeConfig: () => cfg,
    getNativeApprovalRuntime: () => ({
      ...gateway.nativeApprovals,
      request: (method, body, options) =>
        gateway.nativeApprovals.request(method, rewrite ? rewrite(body) : body, options),
    }),
  });
  await channel.startChannels();
  await started.promise;
  if (!current) {
    throw new Error("Missing native account approval capability");
  }
  return {
    current,
    record,
    handlers,
    context,
    databaseOptions,
    revokeApprovers: () => {
      cfg.channels.imessage.allowFrom = [];
    },
    close: async () => {
      await channel.stopChannel("imessage", DEFAULT_ACCOUNT_ID);
      gateway.close();
    },
    body: { id: record.id, kind: "plugin" as const, decision: "allow-once" as const, reviewer },
  };
}

it("persists the verified native account actor through canonical approval resolution", async () => {
  const f = await fixture();
  try {
    const response = await f.current.request("approval.resolve", f.body, {
      clientDisplayName: "Synthetic native response",
      conversationId,
    });
    expect(response).toMatchObject({ applied: true });
    expect(JSON.stringify(response)).not.toContain("pluginBinding");
    expect(JSON.stringify(response)).not.toContain("conversationId");
    const stored = await getOperatorApproval({
      id: f.record.id,
      databaseOptions: f.databaseOptions,
    });
    expect(stored?.pluginBinding?.actor).toEqual({ ...reviewer, conversationId });
  } finally {
    await f.close();
  }
});

it("does not turn an operator RPC's matching reviewer strings into a native actor", async () => {
  const f = await fixture();
  try {
    const response = await createApprovalInvocation({
      handlers: f.handlers,
      method: "approval.resolve",
      body: f.body,
      context: f.context,
      client: createClient({ deviceId: "operator" }),
    }).invoke();
    expect(response.ok).toBe(true);
    expect(response.result).toMatchObject({ applied: true });
    const stored = await getOperatorApproval({
      id: f.record.id,
      databaseOptions: f.databaseOptions,
    });
    expect(stored?.pluginBinding?.actor).toBeNull();
  } finally {
    await f.close();
  }
});

for (const field of ["canonical-id", "decision", "sender"] as const) {
  it(`refuses a native actor whose ${field} does not match the canonical request`, async () => {
    const f = await fixture((body) =>
      field === "canonical-id"
        ? body
        : field === "decision"
          ? { ...body, decision: "deny" }
          : { ...body, reviewer: { ...reviewer, senderId: "+15555550102" } },
    );
    try {
      const before = await getOperatorApproval({
        id: f.record.id,
        databaseOptions: f.databaseOptions,
      });
      const transportRef = before!.resolutionRef;
      await expect(
        f.current.request(
          "approval.resolve",
          field === "canonical-id" ? { ...f.body, id: transportRef } : f.body,
          { conversationId },
        ),
      ).rejects.toThrow();
      const after = await getOperatorApproval({
        id: f.record.id,
        databaseOptions: f.databaseOptions,
      });
      expect(after?.status).toBe("pending");
      expect(after?.pluginBinding?.actor).toBeNull();
    } finally {
      await f.close();
    }
  });
}

it("rechecks current approver policy before persisting native actor assent", async () => {
  let revoke = () => {};
  const f = await fixture((body) => {
    revoke();
    return body;
  });
  revoke = f.revokeApprovers;
  try {
    await expect(
      f.current.request("approval.resolve", f.body, { conversationId }),
    ).rejects.toThrow();
    const stored = await getOperatorApproval({
      id: f.record.id,
      databaseOptions: f.databaseOptions,
    });
    expect(stored?.status).toBe("pending");
    expect(stored?.pluginBinding?.actor).toBeNull();
  } finally {
    await f.close();
  }
});

it("preserves the first native actor when another owner races and retries", async () => {
  const f = await fixture();
  try {
    const second = { ...f.body, reviewer: { ...reviewer, senderId: "+15555550102" } };
    const results = await Promise.allSettled([
      f.current.request("approval.resolve", f.body, { conversationId }),
      f.current.request("approval.resolve", second, { conversationId }),
    ]);
    expect(
      results.some(
        (result) =>
          result.status === "fulfilled" && (result.value as { applied?: boolean }).applied,
      ),
    ).toBe(true);
    const first = await getOperatorApproval({
      id: f.record.id,
      databaseOptions: f.databaseOptions,
    });
    expect(first?.status).toBe("allowed");
    expect([senderId, "+15555550102"]).toContain(first?.pluginBinding?.actor?.senderId);
    await f.current.request("approval.resolve", second, { conversationId }).catch(() => undefined);
    const retried = await getOperatorApproval({
      id: f.record.id,
      databaseOptions: f.databaseOptions,
    });
    expect(retried?.pluginBinding?.actor).toEqual(first?.pluginBinding?.actor);
  } finally {
    await f.close();
  }
});

it("does not create native actor proof without a matched conversation", async () => {
  const f = await fixture();
  try {
    await f.current.request("approval.resolve", f.body);
    const stored = await getOperatorApproval({
      id: f.record.id,
      databaseOptions: f.databaseOptions,
    });
    expect(stored?.status).toBe("allowed");
    expect(stored?.pluginBinding?.actor).toBeNull();
  } finally {
    await f.close();
  }
});
