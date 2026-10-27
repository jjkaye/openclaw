import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notificationOwnerKey } from "../../notifications/proposal.js";
import { reconcileNotificationReceiptResolution } from "../../notifications/receipt-cleanup.js";
import type { NotificationReceiptState } from "../../notifications/source-types.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { listNotificationDeliveryReceipts } from "../delivery-queue-sqlite.js";
import { ackDelivery, enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks, readQueuedEntry } from "./delivery-queue.test-helpers.js";

describe("source-owned notification receipt cleanup", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const ownerKey = notificationOwnerKey("fixture-tasks", "task-1");
  const id = "notification-cleanup";
  let sourceState: NotificationReceiptState | null;
  let sourceError: boolean;

  const installSource = (includeSource = true) => {
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
    if (includeSource) {
      const record = createPluginRecord({ id: "fixture-source" });
      registry.registry.plugins.push(record);
      registry.createApi(record, { config: {} }).registerNotificationSource({
        contractVersion: 1,
        id: "fixture-tasks",
        resolve: () => null,
        resolveReceipt: (key) => {
          if (sourceError) {
            throw new Error("synthetic source outage");
          }
          return key === ownerKey ? sourceState : null;
        },
      });
    }
    setActivePluginRegistry(registry.registry);
  };

  const readReceipt = async () => {
    const [stored] = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(stored?.id).toBe(id);
    if (!stored) {
      throw new Error("Expected retained notification receipt");
    }
    return stored.notificationReceipt;
  };

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    sourceState = { status: "open" };
    sourceError = false;
    installSource();
    await enqueueDeliveryOnce(
      {
        channel: "matrix",
        to: "!owner:fixture",
        payloads: [{ text: "private completed notification" }],
        completionRetention: "permanent",
        notificationReceipt: {
          ownerKey,
          topicKey: "a".repeat(64),
          revisionKey: "b".repeat(64),
          slot: 0,
          localDate: "2026-10-27",
        },
      },
      id,
      fixtures.tmpDir(),
    );
    await ackDelivery(id, fixtures.tmpDir());
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("authors closure once from the current source and clears it on verified reopen", async () => {
    sourceState = { status: "resolved" };
    const before = Date.now();
    await reconcileNotificationReceiptResolution(fixtures.tmpDir());
    const first = (await readReceipt()).resolvedAt;
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(Date.now());
    sourceState = { status: "resolved", resolvedAt: first! + 60_000 };
    await reconcileNotificationReceiptResolution(fixtures.tmpDir());
    expect((await readReceipt()).resolvedAt).toBe(first);

    sourceState = { status: "open" };
    await reconcileNotificationReceiptResolution(fixtures.tmpDir());
    expect((await readReceipt()).resolvedAt).toBeUndefined();
    expect(JSON.stringify(readQueuedEntry(fixtures.tmpDir(), id))).not.toContain(
      "private completed notification",
    );
  });

  it("retains unresolved custody through missing owners, source outages and registry absence", async () => {
    sourceState = null;
    await reconcileNotificationReceiptResolution(fixtures.tmpDir());
    expect((await readReceipt()).resolvedAt).toBeUndefined();
    sourceError = true;
    await reconcileNotificationReceiptResolution(fixtures.tmpDir());
    expect((await readReceipt()).resolvedAt).toBeUndefined();
    installSource(false);
    await reconcileNotificationReceiptResolution(fixtures.tmpDir());
    expect((await readReceipt()).resolvedAt).toBeUndefined();
    expect(JSON.stringify(readQueuedEntry(fixtures.tmpDir(), id))).not.toContain("payloads");
  });
});
