import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createHeartbeatToolResponsePayload } from "../../auto-reply/heartbeat-tool-response.js";
import { sendDurableMessageBatchCore } from "../../channels/message/send.js";
import { normalizeDirectCronDeliveryPayloads } from "../../cron/isolated-agent/delivery-payload-normalization.js";
import {
  NOTIFICATION_CHANNEL_DATA_KEY,
  type NotificationProposal,
} from "../../notifications/proposal.js";
import type { NotificationSourceState } from "../../notifications/source-types.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { listNotificationDeliveryReceipts } from "../delivery-queue-sqlite.js";
import type { OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

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
  let beforeDispatch: (() => Promise<void>) | undefined;
  const send = vi.fn(async (_text: string): Promise<{ messageId?: string }> => ({
    messageId: "fixture-message",
  }));
  const payload = (text: string, notification = proposal) => ({
    text,
    channelData: { [NOTIFICATION_CHANNEL_DATA_KEY]: notification },
  });
  const request = (
    payloads: ReturnType<typeof payload>[],
    onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void,
  ) => ({
    cfg: {},
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
      resolve: async (reference) => ({ ...state, topicId: reference.topicId }),
    });
    registry.registry.channels.push({
      pluginId: "matrix",
      source: "test",
      plugin: createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          sendText: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
            await beforeDispatch?.();
            await onPlatformSendDispatch?.();
            assertDirectAdapterHandoff?.();
            return { channel: "matrix", ...(await send(text)) };
          },
        },
      }),
    });
    setActivePluginRegistry(registry.registry);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetPluginRuntimeStateForTest();
  });

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
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
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
    await expect(deliver(request([payload("Stale decision")]))).rejects.toThrow();
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
});
