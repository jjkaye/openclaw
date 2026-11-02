import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationCandidate } from "../../notifications/admission.js";
import type { NotificationProposal } from "../../notifications/proposal.js";
import { electNotificationReceipt } from "../../notifications/receipt-policy.js";
import type { NotificationSourceState } from "../../notifications/source-types.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { listNotificationDeliveryReceipts } from "../delivery-queue-sqlite.js";
import { drainPendingDeliveriesCore, recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
} from "./delivery-queue.test-helpers.js";
import type { PreparedOutboundBatch } from "./prepared-batch.js";

let deliver: typeof import("./deliver.js").deliverOutboundPayloads;
const proposal: NotificationProposal = {
  sourceId: "fixture-tasks",
  ownerId: "task-1",
  topicId: "next-action",
  purpose: "decision",
  expectedRevision: "v1",
};
const originalState: NotificationSourceState = {
  topicId: "next-action",
  revision: "v1",
  status: "open",
  timeZone: "America/New_York",
};

describe("notification authority after durable recovery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const send = vi.fn(async () => ({ messageId: "fixture-message" }));
  let oldResolve: ReturnType<typeof vi.fn>;

  const installSource = (state: NotificationSourceState | Error) => {
    const resolve = vi.fn(async () => {
      if (state instanceof Error) {
        throw state;
      }
      return state;
    });
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
      resolve,
    });
    registry.registry.channels.push({
      pluginId: "matrix",
      source: "test",
      plugin: createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          sendText: async ({ onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
            await onPlatformSendDispatch?.();
            assertDirectAdapterHandoff?.();
            return { channel: "matrix", ...(await send()) };
          },
        },
      }),
    });
    setActivePluginRegistry(registry.registry);
    return resolve;
  };

  const seedPending = async (preparedBatch?: PreparedOutboundBatch) => {
    const candidate = createNotificationCandidate(
      proposal,
      {
        agentId: "fixture-agent",
        recipient: { channel: "matrix", to: "!owner:fixture" },
      },
      originalState,
      0,
    );
    const receipt = electNotificationReceipt(candidate, [], Date.now());
    if (!receipt) {
      throw new Error("Expected initial notification admission");
    }
    const admission = { id: "notification-recovery-fixture", receipt };
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!owner:fixture",
        session: { agentId: "fixture-agent" },
        payloads: [{ text: "private queued decision" }],
        ...(preparedBatch ? { preparedBatch } : {}),
        notificationBlocks: [{ notification: proposal, text: "private queued decision" }],
        notificationReceipts: [admission.receipt],
        completionRetention: "permanent",
        queuePolicy: "required",
      },
      admission.id,
      fixtures.tmpDir(),
    );
    expect(readQueuedEntry(fixtures.tmpDir(), admission.id)).toMatchObject({
      notificationBlocks: [{ notification: proposal, text: "private queued decision" }],
      notificationReceipts: [admission.receipt],
    });
    await closeStateDatabaseForTest();
    return admission.id;
  };

  beforeAll(async () => {
    ({ deliverOutboundPayloads: deliver } = await import("./deliver.js"));
  });
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    send.mockClear();
    oldResolve = installSource(originalState);
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it.each([{ status: "answered" as const }, { status: "paused" as const }, { revision: "v2" }])(
    "cancels a serialized ask after current source changes to %j",
    async (change) => {
      const id = await seedPending();
      const currentResolve = installSource({ ...originalState, ...change });
      const result = await recoverPendingDeliveries({
        cfg: {},
        stateDir: fixtures.tmpDir(),
        log: createRecoveryLog(),
        deliver,
      });
      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      expect(currentResolve).toHaveBeenCalled();
      expect(oldResolve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      const [receipt] = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
      expect(receipt).toMatchObject({ id, status: "failed" });
      expect(JSON.stringify(readQueuedEntry(fixtures.tmpDir(), id))).not.toContain(
        "private queued decision",
      );
    },
  );

  it("delivers an unchanged recovered ask using the replacement source registry", async () => {
    const id = await seedPending();
    const currentResolve = installSource(originalState);
    const result = await recoverPendingDeliveries({
      cfg: {},
      stateDir: fixtures.tmpDir(),
      log: createRecoveryLog(),
      deliver,
    });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(currentResolve).toHaveBeenCalled();
    expect(oldResolve).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toMatchObject([
      { id, status: "completed" },
    ]);
  });

  it("settles a recovered group with no accepted prepared payloads without reconstructing its copy", async () => {
    const preparedBatch: PreparedOutboundBatch = {
      schemaVersion: 1,
      sourcePayloadCount: 1,
      entries: [
        { sourceIndex: 0, status: "suppressed", reason: "cancelled_by_message_sending_hook" },
      ],
    };
    const id = await seedPending(preparedBatch);
    const currentResolve = installSource(originalState);
    const prepareNotificationPayload = vi.fn(async () => ({ text: "must not rebuild old copy" }));
    const result = await recoverPendingDeliveries({
      cfg: {},
      stateDir: fixtures.tmpDir(),
      log: createRecoveryLog(),
      deliver: async (params) => {
        expect(params.payloads).toEqual([]);
        expect(params.preparedBatch).toEqual(preparedBatch);
        return deliver({ ...params, prepareNotificationPayload });
      },
    });
    expect(result).toMatchObject({ recovered: 1, failed: 0 });
    expect(currentResolve).toHaveBeenCalled();
    expect(oldResolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(prepareNotificationPayload).not.toHaveBeenCalled();
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toMatchObject([
      { id, status: "completed", recoveryState: "completed_notification_suppressed" },
    ]);
    expect(JSON.stringify(readQueuedEntry(fixtures.tmpDir(), id))).not.toContain(
      "private queued decision",
    );
  });

  it("retains the same occurrence during a source outage and resumes through native recovery", async () => {
    const id = await seedPending();
    installSource(new Error("synthetic private source outage"));
    await recoverPendingDeliveries({
      cfg: {},
      stateDir: fixtures.tmpDir(),
      log: createRecoveryLog(),
      deliver,
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      await listNotificationDeliveryReceipts({ includePending: true }, fixtures.tmpDir()),
    ).toMatchObject([{ id, status: "pending" }]);
    expect(JSON.stringify(readQueuedEntry(fixtures.tmpDir(), id))).not.toContain(
      "synthetic private source outage",
    );

    installSource(originalState);
    await drainPendingDeliveriesCore({
      cfg: {},
      stateDir: fixtures.tmpDir(),
      log: createRecoveryLog(),
      deliver,
      drainKey: fixtures.tmpDir(),
      logLabel: "fixture reconnect",
      selectEntry: () => ({ match: true, bypassBackoff: true }),
    });
    expect(send).toHaveBeenCalledOnce();
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toMatchObject([
      { id, status: "completed" },
    ]);
  });
});
