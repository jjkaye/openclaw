import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCanceledError } from "../../notifications/cancellation.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createOutboundTestPlugin } from "../../test-utils/channel-plugins.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  countFailedDeliveryQueueEntries,
  listNotificationDeliveryReceipts,
} from "../delivery-queue-sqlite.js";
import { createQueuedDeliveryOwner, rejectQueuedDelivery } from "./deliver-queue-state.js";
import { claimNotificationPreparation } from "./delivery-queue-preparation.js";
import { recoverPendingDeliveries } from "./delivery-queue-recovery.js";
import * as storage from "./delivery-queue-storage.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  readQueuedEntry,
} from "./delivery-queue.test-helpers.js";

describe("durable wholly-unsent notification cancellation", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const candidate = {
    index: 0,
    purpose: "decision" as const,
    timeZone: "America/New_York",
    receiptBase: {
      ownerKey: "a".repeat(64),
      topicKey: "b".repeat(64),
      revisionKey: "c".repeat(64),
    },
  };
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    // Queue settlement owns this proof; do not initialize a bundled transport
    // merely to resolve recovery's channel admission metadata.
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    registry.registry.channels.push({
      pluginId: "matrix",
      source: "test",
      plugin: createOutboundTestPlugin({
        id: "matrix",
        outbound: {
          deliveryMode: "direct",
          sendText: async () => {
            throw new Error("Unexpected provider effect in queue settlement proof");
          },
        },
      }),
    });
    setActivePluginRegistry(registry.registry);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  const enqueue = async (requiresProducerClaim = false) => {
    const claim = await claimNotificationPreparation({
      candidates: [candidate],
      stateDir: fixtures.tmpDir(),
    });
    if (claim.status !== "claimed") {
      throw new Error("Expected preparation claim");
    }
    await storage.enqueuePreparedDeliveryOnce(
      {
        channel: "matrix",
        to: "!owner:fixture",
        payloads: [{ text: "private stale briefing" }],
        completionRetention: "permanent",
        notificationReceipts: claim.entry.notificationReceipts,
        requiresProducerClaim,
      },
      claim.entry.id,
      claim.entry,
      fixtures.tmpDir(),
    );
    return claim;
  };

  it("preserves cancellation through failed settlement restart without invoking delivery", async () => {
    const first = await enqueue();
    const entry = await storage.loadPendingDelivery(first.entry.id, fixtures.tmpDir());
    if (!entry) {
      throw new Error("Expected published notification group");
    }
    expect(
      await storage.stageDeliveryFailureSettlement(
        entry,
        {
          outcome: "failed",
          error: "source changed",
          rejectionError: "source changed",
          notificationCanceled: true,
        },
        fixtures.tmpDir(),
      ),
    ).toBeDefined();
    await closeStateDatabaseForTest();
    const deliver = vi.fn();
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: fixtures.tmpDir(),
      deliver,
    });
    expect(deliver).not.toHaveBeenCalled();
    const [stored] = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(stored).toMatchObject({
      id: first.entry.id,
      status: "failed",
      recoveryState: "completed_notification_canceled",
    });
    expect(stored.acknowledgedAt).toBeUndefined();
    expect(await countFailedDeliveryQueueEntries(fixtures.tmpDir())).toEqual([]);
    expect(JSON.stringify(readQueuedEntry(fixtures.tmpDir(), first.entry.id))).not.toContain(
      "private stale briefing",
    );
    const next = await claimNotificationPreparation({
      candidates: [candidate],
      stateDir: fixtures.tmpDir(),
    });
    expect(next.status).toBe("claimed");
    if (next.status === "claimed") {
      expect(next.entry.id).not.toBe(first.entry.id);
      expect(next.selected[0].receipt).toMatchObject({ ...candidate.receiptBase, slot: 0 });
    }
  });

  it("retains the cancellation disposition when failure staging falls back to retiring the unsent claim", async () => {
    const first = await enqueue(true);
    const claimId = await storage.claimDeliveryPlatformSendAttempt(
      first.entry.id,
      fixtures.tmpDir(),
    );
    if (!claimId) {
      throw new Error("Expected live producer claim");
    }
    vi.spyOn(storage, "stageDeliveryFailureSettlement").mockRejectedValueOnce(
      new Error("synthetic staging failure"),
    );
    const owner = createQueuedDeliveryOwner({
      queueId: first.entry.id,
      stateDir: fixtures.tmpDir(),
      expectedPlatformSendAttemptId: claimId,
    });
    expect(
      await rejectQueuedDelivery(
        owner,
        new NotificationCanceledError([candidate.receiptBase.topicKey]),
        {},
        [],
      ),
    ).toBe(true);
    expect(owner.custody).toBe("released");
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toMatchObject([
      { id: first.entry.id, recoveryState: "completed_notification_canceled" },
    ]);
  });

  it("never turns uncertain or partial custody into a wholly-unsent cancellation", async () => {
    const first = await enqueue();
    await storage.markDeliveryPlatformOutcomeUnknown(first.entry.id, fixtures.tmpDir());
    const unknown = await storage.loadPendingDelivery(first.entry.id, fixtures.tmpDir());
    if (!unknown) {
      throw new Error("Expected unknown notification custody");
    }
    expect(
      await storage.stageDeliveryFailureSettlement(
        unknown,
        {
          outcome: "failed",
          error: "source changed",
          notificationCanceled: true,
        },
        fixtures.tmpDir(),
      ),
    ).toBeUndefined();
    const changed = {
      ...candidate,
      receiptBase: { ...candidate.receiptBase, revisionKey: "d".repeat(64) },
    };
    expect(
      await claimNotificationPreparation({ candidates: [changed], stateDir: fixtures.tmpDir() }),
    ).toEqual({ status: "suppressed" });
    expect(
      await storage.stageDeliveryFailureSettlement(
        unknown,
        {
          outcome: "unknown",
          error: "partial send awaiting reconciliation",
        },
        fixtures.tmpDir(),
      ),
    ).toBeDefined();
    expect(
      await claimNotificationPreparation({ candidates: [changed], stateDir: fixtures.tmpDir() }),
    ).toEqual({ status: "suppressed" });
    expect(
      await claimNotificationPreparation({
        candidates: [
          { ...candidate, receiptBase: { ...candidate.receiptBase, topicKey: "e".repeat(64) } },
        ],
        stateDir: fixtures.tmpDir(),
      }),
    ).toMatchObject({ status: "claimed" });
    expect(
      (await listNotificationDeliveryReceipts({ includePending: true }, fixtures.tmpDir())).find(
        ({ id }) => id === first.entry.id,
      ),
    ).toMatchObject({ status: "failed", recoveryState: "settlement_pending" });
    expect(
      (await countFailedDeliveryQueueEntries(fixtures.tmpDir())).map(({ count }) => count),
    ).toEqual([1]);
  });

  it("records an intentionally omitted recovered payload without counting it as a sent reminder", async () => {
    const first = await enqueue();
    await recoverPendingDeliveries({
      cfg: {},
      log: createRecoveryLog(),
      stateDir: fixtures.tmpDir(),
      deliver: async (params) => {
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "adapter_returned_no_send",
        });
        return [];
      },
    });
    const [stored] = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(stored).toMatchObject({
      id: first.entry.id,
      status: "completed",
      recoveryState: "completed_notification_suppressed",
    });
    expect(stored.acknowledgedAt).toBeUndefined();
    expect(
      await claimNotificationPreparation({ candidates: [candidate], stateDir: fixtures.tmpDir() }),
    ).toEqual({ status: "suppressed" });
  });
});
