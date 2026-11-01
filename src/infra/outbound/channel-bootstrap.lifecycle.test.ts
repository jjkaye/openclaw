import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { NOTIFICATION_CHANNEL_DATA_KEY } from "../../notifications/proposal.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "../../plugins/loader.test-fixtures.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { finalizePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  capturePluginLifecycleAuthority,
  revokePluginRecord,
} from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { listNotificationDeliveryReceipts } from "../delivery-queue-sqlite.js";
import {
  bootstrapOutboundChannelPlugin,
  bootstrapOutboundChannelPluginAsync,
  resetOutboundChannelBootstrapStateForTests,
} from "./channel-bootstrap.runtime.js";
import { deliverOutboundPayloads } from "./deliver.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";

afterEach(() => {
  resetOutboundChannelBootstrapStateForTests();
  resetPluginLoaderTestStateForTest();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function createFixture({
  global = false,
  deferInstall = false,
  stateDir: selectedStateDir = "",
} = {}) {
  useNoBundledPlugins();
  const root = makePluginLoaderTempDir();
  const stateDir = selectedStateDir || path.join(root, "state");
  vi.stubEnv("OPENCLAW_HOME", path.join(root, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const id = "bootstrap-lifecycle";
  const events = path.join(root, "events.txt");
  const write = (dir: string, label: string) => {
    const plugin = writePlugin({
      id,
      dir,
      filename: "index.cjs",
      registration: `
        const fs = require("node:fs");
        const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + "\\n");
        record("registered:${label}");
        api.lifecycle.onDispose(() => record("disposed:${label}"));
        api.registerChannel({ plugin: {
          id: "${id}",
          meta: { id: "${id}", label: "Fixture", selectionLabel: "Fixture", docsPath: "/fixture", blurb: "Fixture" },
          capabilities: { chatTypes: ["direct"] },
          config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
          outbound: {
            deliveryMode: "direct",
            async sendText({ onPlatformSendDispatch, assertDirectAdapterHandoff }) {
              await onPlatformSendDispatch?.();
              assertDirectAdapterHandoff?.();
              record("sent:${label}");
              return { channel: "${id}", messageId: "${label}" };
            },
          },
        } });`,
    });
    writePluginMetadata({
      dir,
      id,
      channels: [id],
      packageJson: { name: id, openclaw: { extensions: ["./index.cjs"] } },
    });
    return plugin;
  };
  const pluginDir = global ? path.join(stateDir, "extensions", id) : path.join(root, "plugin");
  const plugin = { id, dir: pluginDir, file: path.join(pluginDir, "index.cjs") };
  if (!deferInstall) {
    write(pluginDir, "first");
  }
  const config: OpenClawConfig = {
    plugins: {
      allow: [id],
      ...(global ? {} : { load: { paths: [plugin.file] } }),
      entries: { [id]: { enabled: true } },
      slots: { memory: "none" },
    },
    channels: { [id]: { enabled: true } },
  };
  return {
    plugin,
    config,
    params: { channel: id, cfg: config },
    events: () => fs.readFileSync(events, "utf8").trim().split("\n"),
    write,
    root,
  };
}

function sender(registry: PluginRegistry | undefined) {
  return expectDefined(registry?.channels[0]?.plugin.outbound?.sendText, "bootstrapped sender");
}

describe("outbound bootstrap lifetime", () => {
  it.each([
    { retirement: "registry", bootstrap: bootstrapOutboundChannelPlugin },
    { retirement: "cache", bootstrap: bootstrapOutboundChannelPluginAsync },
  ])(
    "sends through a fresh instance after $retirement retirement",
    async ({ retirement, bootstrap }) => {
      const fixture = createFixture();
      const request = { cfg: fixture.config, to: "recipient", text: "hello" };
      await using firstCache = createPluginCache();
      await using nextCache = createPluginCache();
      const first = await withPluginCache(firstCache, () => bootstrap(fixture.params));
      const firstSend = sender(first);
      await expect(firstSend(request)).resolves.toMatchObject({ messageId: "first" });
      if (retirement === "cache") {
        await retirePluginCache(firstCache);
      } else {
        await disposePluginRegistryInstances(expectDefined(first, "first registry"));
      }
      expect(() => firstSend(request)).toThrow(/reloaded|disabled|retir/);

      const cache = retirement === "cache" ? nextCache : firstCache;
      const next = await withPluginCache(cache, () => bootstrap(fixture.params));
      await expect(sender(next)(request)).resolves.toMatchObject({ messageId: "first" });
      expect(fixture.events()).toEqual([
        "registered:first",
        "sent:first",
        "disposed:first",
        "registered:first",
        "sent:first",
      ]);
    },
  );

  it("discovers a newly installed sender after metadata invalidation clears an unavailable outcome", async () => {
    const bootstrap = bootstrapOutboundChannelPluginAsync;
    const fixture = createFixture({ global: true, deferInstall: true });
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      expect(await bootstrap(fixture.params)).toBeUndefined();
      fixture.write(fixture.plugin.dir, "first");
      expect(await bootstrap(fixture.params)).toBeUndefined();

      clearPluginMetadataLifecycleCaches();

      const registry = await bootstrap(fixture.params);
      const request = { cfg: fixture.config, to: "recipient", text: "hello" };
      await expect(sender(registry)(request)).resolves.toMatchObject({ messageId: "first" });
    });
    expect(fixture.events()).toEqual(["registered:first", "sent:first"]);
  });

  it("keeps available and empty metadata outcomes separate within one cache", async () => {
    const bootstrap = bootstrapOutboundChannelPluginAsync;
    const fixture = createFixture();
    await using cache = createPluginCache();
    const { available, empty } = withPluginCache(cache, () => ({
      available: finalizePluginMetadataSnapshot(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: fixture.plugin.id,
              rootDir: fixture.plugin.dir,
              source: fixture.plugin.file,
              origin: "config",
              channels: [fixture.plugin.id],
              configSchema: EMPTY_PLUGIN_SCHEMA,
            },
          ],
        }),
      ),
      empty: finalizePluginMetadataSnapshot(createPluginMetadataSnapshotFixture()),
    }));
    const options = { config: fixture.config, trustConfigIdentity: true };
    await withPluginMetadataSnapshotScope(
      available,
      async () => {
        const first = await bootstrap(fixture.params);
        const request = { cfg: fixture.config, to: "recipient", text: "hello" };
        await expect(sender(first)(request)).resolves.toMatchObject({ messageId: "first" });
        await withPluginMetadataSnapshotScope(
          empty,
          async () => {
            expect(await bootstrap(fixture.params)).toBeUndefined();
            expect(await bootstrap(fixture.params)).toBeUndefined();
          },
          options,
        );
        const restored = await bootstrap(fixture.params);
        expect(restored).toBe(first);
        await expect(sender(restored)(request)).resolves.toMatchObject({ messageId: "first" });
      },
      options,
    );
    expect(fixture.events()).toEqual(["registered:first", "sent:first", "sent:first"]);
  });
});

it("keeps an async bootstrap outcome in its captured state namespace", async () => {
  const fixture = createFixture({ global: true });
  const nextState = path.join(fixture.root, "other-state");
  fixture.write(path.join(nextState, "extensions", fixture.plugin.id), "second");
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const pending = bootstrapOutboundChannelPluginAsync(fixture.params);
    vi.stubEnv("OPENCLAW_STATE_DIR", nextState);
    const request = { cfg: fixture.config, to: "recipient", text: "hello" };
    await expect(sender(await pending)(request)).resolves.toMatchObject({ messageId: "first" });
    const next = await bootstrapOutboundChannelPluginAsync(fixture.params);
    await expect(sender(next)(request)).resolves.toMatchObject({ messageId: "second" });
  });
});

describe("native notification admission across real cold channel loading", () => {
  const queues = installDeliveryQueueTmpDirHooks();

  it.each([
    { scoped: false, change: "none" },
    { scoped: true, change: "none" },
    { scoped: true, change: "revocation" },
    { scoped: true, change: "replacement" },
  ])("preserves source fences (scoped=$scoped, change=$change)", async ({ scoped, change }) => {
    const fixture = createFixture({ stateDir: queues.tmpDir() });
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const owner = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: {} as PluginRuntime,
        activateGlobalSideEffects: false,
      });
      const registry = owner.registry;
      const record = createPluginRecord({ id: "notification-owner" });
      registry.plugins.push(record);
      const sourceId = "cold-loader-tasks";
      const observations: { sameRegistry: boolean; authorityValid: boolean; sameEntry: boolean }[] =
        [];
      let changed = false;
      owner.createApi(record, { config: {} }).registerNotificationSource({
        contractVersion: 1,
        id: sourceId,
        resolve: async () => {
          observations.push({
            sameRegistry:
              (getPluginRuntimeGatewayRequestScope()?.pluginRegistry ??
                getActivePluginRegistry()) === registry,
            authorityValid: authority(),
            sameEntry: registry.notificationSources[0] === entry,
          });
          // The real loader's registration is the barrier; admission happened before it.
          if (
            !changed &&
            change !== "none" &&
            fs.existsSync(path.join(fixture.root, "events.txt"))
          ) {
            changed = true;
            if (change === "revocation") {
              revokePluginRecord(registry, record);
            } else {
              registry.notificationSources[0] = { ...entry };
            }
          }
          return {
            topicId: "next-action",
            revision: "v1",
            status: "open",
            timeZone: "America/New_York",
          };
        },
      });
      const entry = expectDefined(registry.notificationSources[0], "notification source");
      const authority = expectDefined(
        capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true }),
        "source authority",
      );
      setActivePluginRegistry(registry);
      expect(registry.channels).toEqual([]);
      expect(fs.existsSync(path.join(fixture.root, "events.txt"))).toBe(false);
      const run = (text: string) =>
        deliverOutboundPayloads({
          cfg: fixture.config,
          channel: fixture.plugin.id,
          to: "fixture-recipient",
          session: { agentId: "fixture-agent" },
          payloads: [
            {
              text,
              channelData: {
                [NOTIFICATION_CHANNEL_DATA_KEY]: {
                  sourceId,
                  ownerId: "task-1",
                  topicId: "next-action",
                  purpose: "decision",
                  expectedRevision: "v1",
                },
              },
            },
          ],
        });
      const attempt = () =>
        scoped
          ? withPluginRuntimeRegistryScope(registry, () => run("One useful decision"))
          : run("One useful decision");
      if (change === "none") {
        await attempt();
        const loaded = await bootstrapOutboundChannelPluginAsync({
          ...fixture.params,
          agentId: "fixture-agent",
        });
        expect(loaded).toBeDefined();
        expect(loaded).not.toBe(registry);
        expect(loaded?.notificationSources).toEqual([]);
        expect(fixture.events()).toEqual(["registered:first", "sent:first"]);
        await (scoped
          ? withPluginRuntimeRegistryScope(registry, () => run("Same decision, different wording"))
          : run("Same decision, different wording"));
        expect(fixture.events()).toEqual(["registered:first", "sent:first"]);
      } else {
        let cause: unknown = await attempt().then(
          () => undefined,
          (error: unknown) => error,
        );
        while (cause instanceof Error && cause.cause) {
          cause = cause.cause;
        }
        expect(cause).toMatchObject({
          name: "NotificationSourceUnavailableError",
          reason: "retired",
        });
        expect(changed).toBe(true);
        expect(fixture.events()).toEqual(["registered:first"]);
      }
      expect(observations.length).toBeGreaterThan(0);
      expect(
        observations.every(
          (observation) =>
            observation.sameRegistry && observation.authorityValid && observation.sameEntry,
        ),
      ).toBe(true);
      const receipts = await listNotificationDeliveryReceipts(
        { includePending: true },
        queues.tmpDir(),
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.acknowledgedAt !== undefined).toBe(change === "none");
    });
  });
});
