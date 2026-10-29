import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCanceledError } from "../../notifications/cancellation.js";
import type { NotificationPreparationCandidate } from "../../notifications/receipt-policy.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  captureDeliveryQueueStateContext,
  listNotificationDeliveryReceipts,
  pruneExpiredDeliveryQueueTombstones,
  updateNotificationDeliveryReceiptResolution,
} from "../delivery-queue-sqlite.js";
import { inspectDeliveryQueueReceiptInDatabase } from "../delivery-queue-sqlite.kernel.js";
import { seedDeliveryQueueEntry } from "../delivery-queue-sqlite.test-support.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import {
  claimNotificationPreparation,
  withStableDeliveryPreparation,
} from "./delivery-queue-preparation.js";
import { enqueuePreparedDeliveryOnce } from "./delivery-queue-storage.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

describe("atomic notification preparation custody", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const candidate = (topic: string, index = 0): NotificationPreparationCandidate => ({
    index,
    purpose: "decision",
    timeZone: "America/New_York",
    receiptBase: {
      ownerKey: "a".repeat(64),
      topicKey: topic.repeat(64),
      revisionKey: "f".repeat(64),
    },
  });
  const claim = (candidates: NotificationPreparationCandidate[]) =>
    claimNotificationPreparation({ candidates, stateDir: fixtures.tmpDir() });
  const requireClaim = async (candidates: NotificationPreparationCandidate[]) => {
    const result = await claim(candidates);
    if (result.status !== "claimed") {
      throw new Error("Expected notification preparation");
    }
    return result;
  };
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("distinguishes acknowledged notification custody from suppressed, canceled, or malformed receipts", () => {
    const stateDir = fixtures.tmpDir();
    const QUEUE = "notification-receipt-inspection";
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const receipt = {
      ownerKey: "a".repeat(64),
      topicKey: "b".repeat(64),
      revisionKey: "c".repeat(64),
      slot: 0,
      localDate: "2026-10-29",
    };
    for (const [index, state, valid, ack, expected] of [
      [0, "completed_notification", true, true, true],
      [1, "completed_notification_suppressed", true, true, false],
      [2, "completed_notification_canceled", true, true, false],
      [3, "completed_notification", false, true, false],
      [4, "completed_notification", true, false, false],
    ] as const) {
      const id = `notification-${index}`;
      seedDeliveryQueueEntry({
        queueName: QUEUE,
        entry: { id, enqueuedAt: Date.now(), retryCount: 0 },
        stateDir,
      });
      database.db
        .prepare(
          "UPDATE delivery_queue_entries SET status = 'completed', recovery_state = ?, entry_json = ? WHERE queue_name = ? AND id = ?",
        )
        .run(
          state,
          JSON.stringify({
            id,
            notificationReceipts: valid ? [receipt] : "invalid",
            ...(ack ? { acknowledgedAt: Date.now() } : {}),
          }),
          QUEUE,
          id,
        );
      expect(
        inspectDeliveryQueueReceiptInDatabase(database, {
          queueName: QUEUE,
          id,
          includePending: true,
        }),
      ).toMatchObject({ status: "completed", notificationAcknowledged: expected });
    }
  });

  it("atomically reserves overlapping groups once and retains independent subjects", async () => {
    const results = await Promise.all([
      claim([candidate("a"), candidate("b", 1)]),
      claim([candidate("b"), candidate("c", 1)]),
    ]);
    const selected = results.flatMap((result) =>
      result.status === "claimed" ? result.selected : [],
    );
    expect(selected.map(({ receipt }) => receipt.topicKey).toSorted()).toEqual(
      ["a", "b", "c"].map((value) => value.repeat(64)),
    );
    const rows = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(({ id }) => id)).size).toBe(2);
    expect(rows.every(({ status }) => status === "pending")).toBe(true);
  });

  it("deduplicates a repeated input subject before composing the physical group", async () => {
    const result = await requireClaim([candidate("a"), candidate("a", 1)]);
    expect(result.selected.map(({ index }) => index)).toEqual([0]);
    expect(result.entry.notificationReceipts).toHaveLength(1);
    expect(await claim([candidate("a")])).toEqual({ status: "suppressed" });
  });

  it("retains canceled physical history while reusing its wholly unsent logical occurrence", async () => {
    const first = await requireClaim([candidate("a")]);
    await expect(
      withStableDeliveryPreparation({
        id: first.entry.id,
        stateDir: fixtures.tmpDir(),
        preclaimed: first.entry,
        run: async () => {
          throw new NotificationCanceledError([candidate("a").receiptBase.topicKey]);
        },
      }),
    ).rejects.toBeInstanceOf(NotificationCanceledError);
    const second = await requireClaim([candidate("a")]);
    expect(second.entry.id).not.toBe(first.entry.id);
    expect(second.selected[0].receipt).toMatchObject({ ...candidate("a").receiptBase, slot: 0 });
    const rows = await listNotificationDeliveryReceipts(
      { includePending: true },
      fixtures.tmpDir(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find(({ id }) => id === first.entry.id)).toMatchObject({
      status: "failed",
      recoveryState: "completed_notification_canceled",
    });
    expect(rows.find(({ id }) => id === first.entry.id)?.acknowledgedAt).toBeUndefined();
  });

  it("reclaims only expired untouched preparation while preserving modifier uncertainty", async () => {
    const context = captureDeliveryQueueStateContext(fixtures.tmpDir());
    const first = await requireClaim([candidate("a")]);
    await executeDeliveryQueueOperation(context, undefined, {
      type: "deliveryQueue.replacePreparation",
      input: {
        expectedEntry: first.entry,
        replacementEntry: { ...first.entry, preparationLeaseExpiresAt: 0 },
      },
    });
    const reclaimed = await requireClaim([candidate("a")]);
    expect(reclaimed.entry.id).not.toBe(first.entry.id);
    await expect(
      withStableDeliveryPreparation({
        id: first.entry.id,
        stateDir: fixtures.tmpDir(),
        preclaimed: first.entry,
        run: async (owner) => {
          await owner.beforeFirstModifier();
        },
      }),
    ).rejects.toThrow("ownership was lost");
    const changed = {
      ...reclaimed.entry,
      preparationState: "modifiers_started" as const,
      preparationLeaseExpiresAt: 0,
    };
    await executeDeliveryQueueOperation(context, undefined, {
      type: "deliveryQueue.replacePreparation",
      input: { expectedEntry: reclaimed.entry, replacementEntry: changed },
    });
    expect(
      await claim([
        {
          ...candidate("a"),
          receiptBase: { ...candidate("a").receiptBase, revisionKey: "d".repeat(64) },
        },
      ]),
    ).toEqual({ status: "suppressed" });
  });

  it("records an unpublished prepared omission without claiming a provider acknowledgement", async () => {
    const first = await requireClaim([candidate("a")]);
    await withStableDeliveryPreparation({
      id: first.entry.id,
      stateDir: fixtures.tmpDir(),
      preclaimed: first.entry,
      run: async (owner) => {
        await owner.beforeFirstModifier();
        await owner.markPrepared();
      },
    });
    const [stored] = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(stored).toMatchObject({
      status: "completed",
      recoveryState: "completed_notification_suppressed",
    });
    expect(stored.acknowledgedAt).toBeUndefined();
    expect(await claim([candidate("a")])).toEqual({ status: "suppressed" });
    expect(
      (
        await claim([
          {
            ...candidate("a"),
            receiptBase: { ...candidate("a").receiptBase, revisionKey: "d".repeat(64) },
          },
        ])
      ).status,
    ).toBe("claimed");
  });

  it("updates only the resolved owner members of one physical receipt", async () => {
    const other = {
      ...candidate("b", 1),
      receiptBase: { ...candidate("b", 1).receiptBase, ownerKey: "d".repeat(64) },
    };
    const group = await requireClaim([candidate("a"), other]);
    await withStableDeliveryPreparation({
      id: group.entry.id,
      stateDir: fixtures.tmpDir(),
      preclaimed: group.entry,
      run: async (owner) => {
        await owner.beforeFirstModifier();
        await owner.markPrepared();
      },
    });
    const resolution = { ownerKey: candidate("a").receiptBase.ownerKey, resolvedAt: Date.now() };
    expect(await updateNotificationDeliveryReceiptResolution(resolution, fixtures.tmpDir())).toBe(
      1,
    );
    expect(
      await updateNotificationDeliveryReceiptResolution(
        { ...resolution, resolvedAt: resolution.resolvedAt + 1 },
        fixtures.tmpDir(),
      ),
    ).toBe(0);
    const members = await listNotificationDeliveryReceipts({}, fixtures.tmpDir());
    expect(
      members.find(
        ({ notificationReceipt }) => notificationReceipt.ownerKey === resolution.ownerKey,
      )?.notificationReceipt.resolvedAt,
    ).toBe(resolution.resolvedAt);
    expect(
      members.find(
        ({ notificationReceipt }) => notificationReceipt.ownerKey === other.receiptBase.ownerKey,
      )?.notificationReceipt.resolvedAt,
    ).toBeUndefined();
  });

  it("retires expired untouched preparation through existing maintenance without another proposal", async () => {
    const first = await requireClaim([candidate("a")]);
    await executeDeliveryQueueOperation(
      captureDeliveryQueueStateContext(fixtures.tmpDir()),
      undefined,
      {
        type: "deliveryQueue.replacePreparation",
        input: {
          expectedEntry: first.entry,
          replacementEntry: { ...first.entry, preparationLeaseExpiresAt: 0 },
        },
      },
    );
    await pruneExpiredDeliveryQueueTombstones(fixtures.tmpDir());
    expect(await listNotificationDeliveryReceipts({}, fixtures.tmpDir())).toMatchObject([
      { id: first.entry.id, recoveryState: "completed_notification_canceled" },
    ]);
  });

  it("rejects publication that changes or drops atomically reserved receipt membership", async () => {
    const first = await requireClaim([candidate("a")]);
    const params = {
      channel: "matrix",
      to: "!owner:fixture",
      payloads: [{ text: "briefing" }],
      completionRetention: "permanent" as const,
      notificationReceipts: first.entry.notificationReceipts,
    };
    await expect(
      enqueuePreparedDeliveryOnce(
        {
          ...params,
          notificationReceipts: [{ ...first.selected[0].receipt, topicKey: "b".repeat(64) }],
        },
        first.entry.id,
        first.entry,
        fixtures.tmpDir(),
      ),
    ).rejects.toMatchObject({
      message: "Delivery queue admission rejected before publication",
      queueCustody: "released",
      cause: { cause: { message: "Notification preparation receipts changed before publication" } },
    });
    await expect(
      enqueuePreparedDeliveryOnce(
        {
          ...params,
          notificationReceipts: undefined,
        },
        first.entry.id,
        first.entry,
        fixtures.tmpDir(),
      ),
    ).rejects.toMatchObject({
      message: "Delivery queue admission rejected before publication",
      queueCustody: "released",
      cause: { cause: { message: "Notification preparation receipts changed before publication" } },
    });
    expect(await claim([candidate("a")])).toEqual({ status: "suppressed" });
    expect(
      await enqueuePreparedDeliveryOnce(params, first.entry.id, first.entry, fixtures.tmpDir()),
    ).toMatchObject({ created: true });
  });
});
