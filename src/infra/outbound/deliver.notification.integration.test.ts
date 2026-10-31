import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createHeartbeatToolResponsePayload } from "../../auto-reply/heartbeat-tool-response.js";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeDirectCronDeliveryPayloads } from "../../cron/isolated-agent/delivery-payload-normalization.js";
import {
  NOTIFICATION_CHANNEL_DATA_KEY,
  type NotificationProposal,
} from "../../notifications/proposal.js";
import type { NotificationSourceState } from "../../notifications/source-types.js";
import { revokePluginRecord } from "../../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { listNotificationDeliveryReceipts } from "../delivery-queue-sqlite.js";
import type { OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

let bootstrappedRegistry: ReturnType<typeof createPluginRegistry>["registry"] | undefined;
vi.mock("./channel-bootstrap.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-bootstrap.runtime.js")>()),
  bootstrapOutboundChannelPluginAsync: async () => bootstrappedRegistry,
}));

let deliver: typeof import("./deliver.js").deliverOutboundPayloads;
const proposal: NotificationProposal = {
  sourceId: "fixture-tasks",
  ownerId: "task-1",
  topicId: "next-action",
  purpose: "decision",
  expectedRevision: "v1",
};

describe("notification policy through the native durable delivery owner", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let state: NotificationSourceState;
  let sourceRegistry: ReturnType<typeof createPluginRegistry>["registry"];
  const sourceScopes: unknown[] = [];
  let beforeDispatch: (() => Promise<void>) | undefined;
  let topicOverrides: Map<string, Partial<NotificationSourceState>>;
  let chunkLimit: number;
  const send = vi.fn(async (_text: string): Promise<{ messageId?: string }> => ({
    messageId: "fixture-message",
  }));
  const payload = (text: string, notification = proposal) => ({
    text,
    channelData: { [NOTIFICATION_CHANNEL_DATA_KEY]: notification },
  });
  const request = (
    payloads: ReplyPayload[],
    onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void,
  ) => ({
    cfg: { channels: { matrix: { textChunkLimit: chunkLimit || 4000 } } } as OpenClawConfig,
    channel: "matrix",
    to: "!owner:fixture",
    session: { agentId: "fixture-agent" },
    payloads,
    onPayloadDeliveryOutcome,
  });
  beforeAll(async () => {
    ({ deliverOutboundPayloads: deliver } = await import("./deliver.js"));
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    state = {
      topicId: "next-action",
      revision: "v1",
      status: "open",
      timeZone: "America/New_York",
    };
    beforeDispatch = undefined;
    bootstrappedRegistry = undefined;
    sourceScopes.length = 0;
    topicOverrides = new Map();
    chunkLimit = 0;
    send.mockReset().mockImplementation(async () => ({ messageId: "fixture-message" }));
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({ id: "fixture-source" });
    registry.registry.plugins.push(record);
    registry.createApi(record, { config: {} }).registerNotificationSource({
      contractVersion: 1,
      id: proposal.sourceId,
      resolve: async (reference, context) => {
        sourceScopes.push(
          getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry(),
        );
        return context.agentId === "fixture-agent" &&
          context.recipient.channel === "matrix" &&
          context.recipient.to === "!owner:fixture" &&
          context.recipient.accountId === undefined &&
          context.recipient.threadId == null &&
          ["next-action", "another-decision", "third-decision"].includes(reference.topicId)
          ? { ...state, ...topicOverrides.get(reference.topicId), topicId: reference.topicId }
          : null;
      },
    });
    registry.registry.channels.push({
      pluginId: "matrix",
      source: "test",
      plugin: createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          chunkerMode: "text",
          chunker: (text, limit) =>
            text.length > limit ? [text.slice(0, limit), text.slice(limit)] : [text],
          get textChunkLimit() {
            return chunkLimit || 4000;
          },
          sendText: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
            await beforeDispatch?.();
            await onPlatformSendDispatch?.();
            assertDirectAdapterHandoff?.();
            return { channel: "matrix", ...(await send(text)) };
          },
        },
      }),
    });
    sourceRegistry = registry.registry;
    setActivePluginRegistry(registry.registry);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
  });

  for (const scoped of [false, true]) {
    it(`keeps source validation with its admitted owner across channel bootstrap (scoped=${scoped})`, async () => {
      const channelRegistry = {
        ...sourceRegistry,
        notificationSources: [],
        channels: [...sourceRegistry.channels],
      };
      sourceRegistry.channels = sourceRegistry.channels.map((entry) => ({
        ...entry,
        plugin: { ...entry.plugin, outbound: undefined },
      }));
      bootstrappedRegistry = channelRegistry;
      send.mockImplementation(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(channelRegistry);
        return { messageId: "scoped-channel-message" };
      });
      const run = () => deliver(request([payload("Scoped source result")]));
      await (scoped ? withPluginRuntimeRegistryScope(sourceRegistry, run) : run());
      expect(send).toHaveBeenCalledTimes(1);
      expect(sourceScopes.every((registry) => registry === sourceRegistry)).toBe(true);
      const receipts = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.acknowledgedAt).toBeDefined();
    });
  }

  for (const change of [
    "revocation",
    "provider replacement",
    "global replacement",
    "correction",
  ] as const) {
    it(`preserves ${change} fencing across a distinct channel registry`, async () => {
      const channelRegistry = {
        ...sourceRegistry,
        notificationSources: [],
        channels: [...sourceRegistry.channels],
      };
      sourceRegistry.channels = sourceRegistry.channels.map((entry) => ({
        ...entry,
        plugin: { ...entry.plugin, outbound: undefined },
      }));
      bootstrappedRegistry = channelRegistry;
      beforeDispatch = async () => {
        if (change === "revocation") {
          const record = sourceRegistry.plugins.find((entry) => entry.id === "fixture-source");
          if (!record) {
            throw new Error("Missing fixture source owner");
          }
          revokePluginRecord(sourceRegistry, record);
        }
        if (change === "provider replacement") {
          const entry = sourceRegistry.notificationSources[0];
          if (!entry) {
            throw new Error("Missing fixture source registration");
          }
          sourceRegistry.notificationSources[0] = { ...entry };
        }
        if (change === "global replacement") {
          setActivePluginRegistry({ ...sourceRegistry });
        }
        if (change === "correction") {
          state = { ...state, status: "answered" };
        }
      };
      const result = deliver(request([payload("Must remain unsent")]));
      if (change === "correction") {
        await expect(result).resolves.toEqual([]);
      } else {
        await expect(result).rejects.toThrow();
      }
      expect(send).not.toHaveBeenCalled();
      const receipts = await listNotificationDeliveryReceipts(
        { includePending: true },
        fixtures.tmpDir(),
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.acknowledgedAt).toBeUndefined();
    });
  }

  it("shares topic custody between heartbeat and cron despite changed wording", async () => {
    const heartbeat = createHeartbeatToolResponsePayload({
      outcome: "needs_attention",
      notify: true,
      summary: "decision",
      notificationText: "First ask",
      notification: proposal,
    });
    await deliver({ ...request([]), payloads: [heartbeat] });
    const cron = normalizeDirectCronDeliveryPayloads({
      deliveryPayloads: [
        {
          text: JSON.stringify({
            $schema: "openclaw.notification.v1",
            notification: proposal,
            text: "Reworded briefing ask",
          }),
        },
      ],
    });
    expect(cron.kind).toBe("deliver");
    if (cron.kind !== "deliver") {
      throw new Error("Expected tagged cron payload");
    }
    const outcomes: OutboundPayloadDeliveryOutcome[] = [];
    await deliver({ ...request([], (outcome) => outcomes.push(outcome)), payloads: cron.payload });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("First ask");
    expect(outcomes).toEqual([{ index: 0, status: "suppressed", reason: "notification_policy" }]);
    const receipts = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(receipts).toHaveLength(1);
    expect(receipts[0].notificationReceipt.slot).toBe(0);
    expect(JSON.stringify(receipts)).not.toContain("First ask");
  });

  it.each([
    ["!owner:fixture", "matrix:!owner:fixture"],
    ["matrix:!owner:fixture", "!owner:fixture"],
  ])("shares retained topic custody from %s to %s", async (first, second) => {
    await deliver({ ...request([payload("Initial decision")]), to: first });
    expect(send).toHaveBeenCalledTimes(1);
    const before = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    const outcomes: OutboundPayloadDeliveryOutcome[] = [];
    await deliver({
      ...request([payload("Reworded decision")], (outcome) => outcomes.push(outcome)),
      to: second,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([{ index: 0, status: "suppressed", reason: "notification_policy" }]);
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toEqual(before);
  });

  it.each([
    { to: "other:!owner:fixture" },
    { to: "matrix:!other:fixture" },
    { to: "matrix:!owner:fixture:topic:7" },
    { to: "matrix:!owner:fixture", accountId: "other" },
    { to: "matrix:!owner:fixture", threadId: "7" },
    { to: "matrix:!owner:fixture", session: { agentId: "other" } },
  ])("does not widen a source grant for %j", async (route) => {
    const outcomes: OutboundPayloadDeliveryOutcome[] = [];
    await deliver({
      ...request([payload("Foreign decision")], (outcome) => outcomes.push(outcome)),
      ...route,
    });
    expect(send).not.toHaveBeenCalled();
    expect(outcomes).toEqual([{ index: 0, status: "suppressed", reason: "notification_policy" }]);
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toEqual([]);
  });

  it("retains bare pending custody when a prefixed wake arrives", async () => {
    send.mockResolvedValueOnce({});
    await deliver(request([payload("Uncertain decision")]));
    const before = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("pending");
    await deliver({ ...request([payload("Repeated decision")]), to: "matrix:!owner:fixture" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await listNotificationDeliveryReceipts({ includePending: true }, fixtures.tmpDir()),
    ).toEqual(before);
  });

  it("requires configured producer references even when model output is plain text", async () => {
    await expect(
      deliver({
        ...request([payload("Untagged ask")]),
        payloads: [{ text: "Untagged ask" }],
        requireNotificationReference: true,
      }),
    ).rejects.toThrow("requires a current source reference");
    expect(send).not.toHaveBeenCalled();
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toEqual([]);
  });

  it("holds concurrent wakes to one platform effect", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    beforeDispatch = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = deliver(request([payload("Initial ask")]));
    await entered.promise;
    const second = sendDurableMessageBatchCore({
      ...request([payload("Concurrent rewording")]),
      durability: "required",
    });
    await expect(second).resolves.toMatchObject({
      status: "suppressed",
      reason: "notification_policy",
    });
    release.resolve();
    await first;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancels a correction at final platform handoff and preserves a non-send receipt", async () => {
    beforeDispatch = async () => {
      state = { ...state, status: "answered" };
    };
    const outcome = await sendDurableMessageBatchCore({
      ...request([payload("Stale decision")]),
      durability: "required",
    });
    expect(outcome).toMatchObject({ status: "suppressed", reason: "notification_policy" });
    expect(send).not.toHaveBeenCalled();
    const receipts = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe("failed");
  });

  it("retains an unknown prior revision while continuing an unrelated topic", async () => {
    send.mockResolvedValueOnce({});
    await deliver(request([payload("Uncertain send")]));
    state = { ...state, revision: "v2" };
    const changed = { ...proposal, expectedRevision: "v2" };
    await deliver(
      request([
        payload("Same subject changed", changed),
        payload("Independent decision", { ...changed, topicId: "another-decision" }),
      ]),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("Independent decision");
    const receipts = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(receipts.some((receipt) => receipt.status === "pending")).toBe(true);
    expect(receipts.some((receipt) => receipt.status === "completed")).toBe(true);
  });
  it("composes two admitted subjects into one coherent send and one queue identity", async () => {
    await deliver(
      request([
        payload("First decision"),
        payload("Second decision", { ...proposal, topicId: "another-decision" }),
      ]),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("First decision\n\nSecond decision");
    const receipts = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map((receipt) => receipt.id)).size).toBe(1);
  });

  it("deduplicates repeated subject blocks in the same briefing", async () => {
    await deliver(request([payload("First decision"), payload("Reworded duplicate")]));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("First decision");
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toHaveLength(1);
  });

  it("drops an answered subject before speech preparation and never leaks its spoken copy", async () => {
    topicOverrides.set("another-decision", { status: "answered" });
    const selected = { ...payload("Selected decision"), spokenText: "Selected spoken decision" };
    const excluded = {
      ...payload("Old answered decision", { ...proposal, topicId: "another-decision" }),
      spokenText: "Stale spoken decision",
    };
    const transform = vi.fn(async (current: ReplyPayload) => current);
    await deliver({ ...request([selected, excluded]), prepareNotificationPayload: transform });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(transform.mock.calls[0][0].text).toBe("Selected decision");
    expect(transform.mock.calls[0][0].spokenText).toBe("Selected spoken decision");
    expect(JSON.stringify(transform.mock.calls)).not.toContain("Stale spoken decision");
    expect(send).toHaveBeenCalledWith("Selected decision");
  });

  it("composes selected speech instead of retaining only the first private TTS fragment", async () => {
    const first = { ...payload("First decision"), spokenText: "Speak first" };
    const second = {
      ...payload("Second decision", { ...proposal, topicId: "another-decision" }),
      spokenText: "Speak second",
    };
    setReplyPayloadMetadata(first, { tts: { tagged: true, text: "Speak first" } });
    setReplyPayloadMetadata(second, { tts: { tagged: true, text: "Speak second" } });
    const transform = vi.fn(async (current: ReplyPayload) => current);
    await deliver({ ...request([first, second]), prepareNotificationPayload: transform });
    expect(transform).toHaveBeenCalledTimes(1);
    const combined = transform.mock.calls[0][0];
    expect(combined.text).toBe("First decision\n\nSecond decision");
    expect(combined.spokenText).toBe("Speak first\n\nSpeak second");
    expect(getReplyPayloadMetadata(combined)?.tts?.text).toBe("Speak first\n\nSpeak second");
  });

  it("recomposes surviving subjects after a confirmed wholly-unsent handoff cancellation", async () => {
    beforeDispatch = async () => {
      topicOverrides.set("another-decision", { status: "answered" });
      beforeDispatch = undefined;
      bootstrappedRegistry = undefined;
      sourceScopes.length = 0;
    };
    const result = await sendDurableMessageBatchCore({
      ...request([
        payload("Still useful decision"),
        payload("Now stale decision", { ...proposal, topicId: "another-decision" }),
      ]),
      durability: "required",
    });
    expect(result.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Still useful decision");
    const receipts = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(
      receipts.filter((receipt) => receipt.recoveryState === "completed_notification_canceled"),
    ).toHaveLength(2);
    expect(receipts.filter((receipt) => receipt.status === "completed")).toHaveLength(1);
  });

  it("holds every member after a correction following the first required platform part", async () => {
    chunkLimit = 8;
    send.mockImplementationOnce(async () => {
      topicOverrides.set("another-decision", { status: "answered" });
      return { messageId: "first-part" };
    });
    await expect(
      deliver(
        request([
          payload("First decision spans more than one part"),
          payload("Second decision", { ...proposal, topicId: "another-decision" }),
        ]),
      ),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    const pending = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(pending).toHaveLength(2);
    expect(pending.every((receipt) => receipt.status === "pending")).toBe(true);
    expect(
      pending.every((receipt) => receipt.recoveryState !== "completed_notification_canceled"),
    ).toBe(true);
    await deliver(request([payload("New", { ...proposal, topicId: "third-decision" })]));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("New");
  });

  it("retains policy suppression without fabricating a provider acknowledgement", async () => {
    const result = await sendDurableMessageBatchCore({
      ...request([payload("Policy omitted decision")]),
      durability: "required",
      prepareNotificationPayload: async () => ({ text: "" }),
    });
    expect(result.status).toBe("suppressed");
    expect(send).not.toHaveBeenCalled();
    const receipts = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(receipts).toHaveLength(1);
    expect(receipts[0].recoveryState).toBe("completed_notification_suppressed");
    expect(receipts[0].acknowledgedAt).toBeUndefined();
  });
});
