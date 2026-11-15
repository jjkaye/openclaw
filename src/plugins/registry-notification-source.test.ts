import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureNotificationSource,
  NotificationSourceUnavailableError,
  resolveNotificationReceipt,
  resolveNotificationSource,
} from "../notifications/source-registry.js";
import type {
  NotificationResolveContext,
  NotificationSourceReference,
  NotificationSourceV1,
} from "../notifications/source-types.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

const reference: NotificationSourceReference = {
  sourceId: "fixture-tasks",
  ownerId: "task-1",
  topicId: "next-action",
  purpose: "decision",
};
const context: NotificationResolveContext = {
  agentId: "fixture-agent",
  recipient: { channel: "fixture", to: "fixture-owner" },
};
const current = {
  topicId: "next-action",
  revision: "material-1",
  status: "open" as const,
  timeZone: "America/New_York",
};

function harness() {
  const plugins = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const add = (id: string, source: NotificationSourceV1) => {
    const record = createPluginRecord({ id });
    plugins.registry.plugins.push(record);
    const api = plugins.createApi(record, { config: {} });
    api.registerNotificationSource(source);
    return { api, record };
  };
  const run = <T>(body: () => T) => withPluginRuntimeRegistryScope(plugins.registry, body);
  return { plugins, add, run };
}

afterEach(() => vi.useRealTimers());

describe("notification source ownership", () => {
  it("rejects competing ownership and resolves the original trusted route context", async () => {
    const { plugins, add, run } = harness();
    const first = vi.fn(async () => current);
    const second = vi.fn(async () => ({ ...current, revision: "untrusted" }));
    add("source-owner", { contractVersion: 1, id: reference.sourceId, resolve: first });
    add("other-plugin", { contractVersion: 1, id: reference.sourceId, resolve: second });
    await run(async () => {
      await expect(resolveNotificationSource(reference, context)).resolves.toEqual(current);
    });
    expect(first).toHaveBeenCalledWith(reference, context);
    expect(second).not.toHaveBeenCalled();
    expect(plugins.registry.notificationSources).toHaveLength(1);
    expect(plugins.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("already registered"),
      }),
    );
  });

  it("distinguishes a missing source from a source-confirmed missing task", async () => {
    const { add, run } = harness();
    await run(async () => {
      await expect(resolveNotificationSource(reference, context)).rejects.toMatchObject({
        reason: "missing",
      });
    });
    add("source-owner", { contractVersion: 1, id: reference.sourceId, resolve: () => null });
    await run(async () => {
      await expect(resolveNotificationSource(reference, context)).resolves.toBeNull();
    });
  });

  it("rejects a captured handle after its owning plugin replaces the source", async () => {
    const { add, run } = harness();
    const { api } = add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => current,
    });
    await run(async () => {
      const captured = captureNotificationSource(reference.sourceId);
      api.registerNotificationSource({
        contractVersion: 1,
        id: reference.sourceId,
        resolve: () => ({ ...current, status: "paused" }),
      });
      expect(() => captured.assertCurrent()).toThrow(NotificationSourceUnavailableError);
      await expect(captured.resolve(reference, context)).rejects.toMatchObject({
        reason: "retired",
      });
      await expect(resolveNotificationSource(reference, context)).resolves.toMatchObject({
        status: "paused",
      });
    });
  });

  it("rejects awaited results when source authority is revoked while resolving", async () => {
    const { plugins, add, run } = harness();
    let finish!: (value: typeof current) => void;
    const pending = new Promise<typeof current>((resolve) => {
      finish = resolve;
    });
    const { record } = add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => pending,
    });
    await run(async () => {
      const result = resolveNotificationSource(reference, context);
      revokePluginRecord(plugins.registry, record);
      finish(current);
      await expect(result).rejects.toMatchObject({ reason: "retired" });
    });
  });

  it("rejects registration through a retained API after its owner is revoked", () => {
    const { plugins, add } = harness();
    const { api, record } = add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => current,
    });
    revokePluginRecord(plugins.registry, record);
    expect(() =>
      api.registerNotificationSource({
        contractVersion: 1,
        id: "replacement",
        resolve: () => current,
      }),
    ).toThrow();
    expect(plugins.registry.notificationSources).toHaveLength(1);
  });

  it("does not let a captured source escape its admitted registry scope", async () => {
    const { add, run } = harness();
    add("source-owner", { contractVersion: 1, id: reference.sourceId, resolve: () => current });
    const captured = await run(async () => captureNotificationSource(reference.sourceId));
    expect(() => captured.assertCurrent()).toThrow(NotificationSourceUnavailableError);
    await expect(captured.resolve(reference, context)).rejects.toMatchObject({ reason: "retired" });
  });

  it("fails closed on provider failure without exposing private source text", async () => {
    const { add, run } = harness();
    add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => {
        throw new Error("private task text");
      },
    });
    await run(async () => {
      await expect(resolveNotificationSource(reference, context)).rejects.toMatchObject({
        message: "Notification source unavailable: resolve-failed",
      });
    });
  });

  it("bounds a stalled source and preserves cancellation before calling it", async () => {
    vi.useFakeTimers();
    const { add, run } = harness();
    const resolve = vi.fn(() => new Promise<null>(() => {}));
    add("source-owner", { contractVersion: 1, id: reference.sourceId, resolve });
    await run(async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        resolveNotificationSource(reference, { ...context, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(resolve).not.toHaveBeenCalled();
      const timed = resolveNotificationSource(reference, context);
      const rejected = expect(timed).rejects.toMatchObject({ reason: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    });
  });
});

describe("opaque notification receipt lookup", () => {
  it("retains absence as unknown and returns only a current source-confirmed lifecycle", async () => {
    const { add, run } = harness();
    await run(async () => expect(await resolveNotificationReceipt("a".repeat(64))).toBeNull());
    add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => current,
      resolveReceipt: (key) =>
        key === "a".repeat(64) ? { status: "resolved", resolvedAt: 1234 } : null,
    });
    await run(async () => {
      await expect(resolveNotificationReceipt("a".repeat(64))).resolves.toEqual({
        status: "resolved",
        resolvedAt: 1234,
      });
      await expect(resolveNotificationReceipt("b".repeat(64))).resolves.toBeNull();
    });
  });

  it("rejects ambiguous or failed lifecycle evidence rather than choosing a source", async () => {
    const { add, run } = harness();
    for (const id of ["one", "two"]) {
      add(id, {
        contractVersion: 1,
        id,
        resolve: () => current,
        resolveReceipt: () => ({ status: "resolved", resolvedAt: 1234 }),
      });
    }
    await run(async () => {
      await expect(resolveNotificationReceipt("a".repeat(64))).rejects.toMatchObject({
        reason: "ambiguous",
      });
    });
  });

  it("rejects earlier evidence retired during a later source lookup", async () => {
    const { plugins, add, run } = harness();
    const { record } = add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => current,
      resolveReceipt: () => ({ status: "resolved", resolvedAt: 1234 }),
    });
    add("other-owner", {
      contractVersion: 1,
      id: "other-tasks",
      resolve: () => current,
      resolveReceipt: async () => {
        revokePluginRecord(plugins.registry, record);
        return null;
      },
    });
    await run(async () => {
      await expect(resolveNotificationReceipt("a".repeat(64))).rejects.toMatchObject({
        reason: "retired",
      });
    });
  });

  it("uses one finite registration snapshot rather than admitting sources added during lookup", async () => {
    const { add, run } = harness();
    const added = vi.fn(() => null);
    add("source-owner", {
      contractVersion: 1,
      id: reference.sourceId,
      resolve: () => current,
      resolveReceipt: async () => {
        add("new-owner", {
          contractVersion: 1,
          id: "new-tasks",
          resolve: () => current,
          resolveReceipt: added,
        });
        return { status: "resolved", resolvedAt: 1234 };
      },
    });
    await run(async () => {
      await expect(resolveNotificationReceipt("a".repeat(64))).rejects.toMatchObject({
        reason: "retired",
      });
    });
    expect(added).not.toHaveBeenCalled();
  });
});
