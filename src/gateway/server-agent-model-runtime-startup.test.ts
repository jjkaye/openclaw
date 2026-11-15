// Preserve the real model-runtime harness setup before its consumers.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { listConfiguredOwnerInputs } from "../agents/prepared-model-runtime.configured.js";
import { PreparedModelRuntimePublicationSupersededError } from "../agents/prepared-model-runtime.errors.js";
import * as runtime from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { publishDeferredAgentModelRuntime } from "./server-agent-model-runtime-startup.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness();

function pendingAgents() {
  fixture.mocks.configuredAgentIds = ["default", "uninspected"];
  const cfg: OpenClawConfig = {
    agents: { entries: { default: {}, uninspected: {} } },
  };
  const refusals = fixture.mocks.configuredAgentIds.map((agentId) =>
    createAgentDatabaseInspectionRefusal({
      agentId,
      paths: [fixture.state.agentDir(agentId)],
      reason: "synthetic pending inspection",
      pending: true,
    }),
  );
  recordAgentDatabaseAdmissions(refusals, { source: "startup" });
  return { cfg, refusal: refusals[0]! };
}

function observeGlobalPublication() {
  const entered = createDeferredCore();
  const secondEntered = createDeferredCore();
  let globals = 0;
  const original = runtime.refreshPreparedModelRuntimeSnapshots;
  const spy = vi.spyOn(runtime, "refreshPreparedModelRuntimeSnapshots");
  spy.mockImplementation((cfg, options) => {
    const result = original(cfg, options);
    if (options?.gatewayLifecycle) {
      if (++globals === 1) {
        entered.resolve();
      } else {
        secondEntered.resolve();
      }
    }
    return result;
  });
  return {
    entered: entered.promise,
    secondEntered: secondEntered.promise,
    restore: () => spy.mockRestore(),
  };
}

it(
  "reproduces global startup superseding a privately prepared pending agent",
  { timeout: 5_000 },
  async ({ signal }) => {
    const { cfg, refusal } = pendingAgents();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    fixture.mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { entries: [] };
    });
    const global = observeGlobalPublication();
    const scoped = preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
      runtime.refreshPreparedModelRuntimeSnapshots(cfg, {
        agentIds: new Set(["default"]),
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
      }),
    );
    const rejected = expect(scoped).rejects.toBeInstanceOf(
      PreparedModelRuntimePublicationSupersededError,
    );
    let publication: Promise<void> | undefined;
    try {
      await withinTest(entered.promise, signal);
      expect(listConfiguredOwnerInputs(cfg)).toEqual([]);
      publication = publishConfiguredModelRuntimeSnapshots({ cfg });
      await withinTest(global.entered, signal);
      release.resolve();
      await Promise.all([rejected, publication]);
      expect(readAgentDatabaseAdmissionRefusal("default")?.code).toBe(
        "agent-database-inspection-pending",
      );
    } finally {
      release.resolve();
      await Promise.allSettled([scoped, publication]);
      global.restore();
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  },
);

it(
  "republishes the pending agent after joining an excluding global replacement",
  { timeout: 5_000 },
  async ({ signal }) => {
    const { cfg, refusal } = pendingAgents();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const retryEntered = createDeferredCore();
    const releaseRetry = createDeferredCore();
    let builds = 0;
    fixture.mocks.prepareStaticCatalog.mockImplementation(async () => {
      if (++builds === 1) {
        entered.resolve();
        await release.promise;
      } else {
        retryEntered.resolve();
        await releaseRetry.promise;
      }
      return { entries: [] };
    });
    const global = observeGlobalPublication();
    const scoped = preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
      publishDeferredAgentModelRuntime({
        cfg,
        agentId: "default",
        pluginRegistry: createEmptyPluginRegistry(),
        assertCurrent() {},
      }),
    );
    let publication: Promise<void> | undefined;
    try {
      await withinTest(entered.promise, signal);
      expect(listConfiguredOwnerInputs(cfg)).toEqual([]);
      publication = publishConfiguredModelRuntimeSnapshots({ cfg });
      await withinTest(global.entered, signal);
      release.resolve();
      await withinTest(retryEntered.promise, signal);
      await publication;
      expect(readAgentDatabaseAdmissionRefusal("default")?.code).toBe(
        "agent-database-inspection-pending",
      );
      releaseRetry.resolve();
      await scoped;
      expect(builds).toBe(2);
      expect(readAgentDatabaseAdmissionRefusal("default")).toBeUndefined();
      const input = listConfiguredOwnerInputs(cfg, undefined, true).find(
        (candidate) => candidate.agentId === "default",
      );
      expect(input).toBeDefined();
      expect(runtime.getPreparedModelRuntimeSnapshot(input!)).toBeDefined();
      expect(readAgentDatabaseAdmissionRefusal("uninspected")?.code).toBe(
        "agent-database-inspection-pending",
      );
    } finally {
      release.resolve();
      releaseRetry.resolve();
      await Promise.allSettled([scoped, publication]);
      global.restore();
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  },
);

it(
  "does not publish or admit an uninspected agent outside its private scope",
  { timeout: 5_000 },
  async () => {
    const { cfg } = pendingAgents();
    try {
      await expect(
        publishDeferredAgentModelRuntime({
          cfg,
          agentId: "default",
          pluginRegistry: createEmptyPluginRegistry(),
          assertCurrent() {},
        }),
      ).rejects.toThrow("no longer configured");
      expect(fixture.mocks.prepareStaticCatalog).not.toHaveBeenCalled();
      expect(readAgentDatabaseAdmissionRefusal("default")?.code).toBe(
        "agent-database-inspection-pending",
      );
    } finally {
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  },
);

it(
  "propagates an unrelated model preparation failure without retry or admission",
  { timeout: 5_000 },
  async () => {
    const { cfg, refusal } = pendingAgents();
    fixture.mocks.prepareStaticCatalog.mockRejectedValue(new Error("synthetic catalog refused"));
    try {
      await expect(
        preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
          publishDeferredAgentModelRuntime({
            cfg,
            agentId: "default",
            pluginRegistry: createEmptyPluginRegistry(),
            assertCurrent() {},
          }),
        ),
      ).rejects.toThrow("synthetic catalog refused");
      expect(fixture.mocks.prepareStaticCatalog).toHaveBeenCalledTimes(1);
      expect(readAgentDatabaseAdmissionRefusal("default")).toBeDefined();
    } finally {
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  },
);

it.for(["configuration", "secrets", "cancellation"])(
  "does not retry or admit after the captured %s guard changes",
  { timeout: 5_000 },
  async (boundary, { signal }) => {
    const { cfg, refusal } = pendingAgents();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let currentConfig = cfg;
    let secretsRevision = 1;
    const cancellation = new AbortController();
    const assertCurrent = () => {
      cancellation.signal.throwIfAborted();
      if (currentConfig !== cfg || secretsRevision !== 1) {
        throw new Error(`synthetic ${boundary} changed`);
      }
    };
    fixture.mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { entries: [] };
    });
    const scoped = preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
      publishDeferredAgentModelRuntime({
        cfg,
        agentId: "default",
        pluginRegistry: createEmptyPluginRegistry(),
        assertCurrent,
      }),
    );
    const rejected = expect(scoped).rejects.toThrow();
    try {
      await withinTest(entered.promise, signal);
      if (boundary === "configuration") {
        currentConfig = structuredClone(cfg);
      } else if (boundary === "secrets") {
        secretsRevision++;
      } else {
        cancellation.abort(new Error("synthetic cancellation"));
      }
      release.resolve();
      await rejected;
      expect(fixture.mocks.prepareStaticCatalog).toHaveBeenCalledTimes(1);
      expect(readAgentDatabaseAdmissionRefusal("default")).toBeDefined();
    } finally {
      release.resolve();
      await Promise.allSettled([scoped]);
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  },
);

it(
  "fails closed when a second replacement still excludes the pending snapshot",
  { timeout: 5_000 },
  async ({ signal }) => {
    const { cfg, refusal } = pendingAgents();
    const entered = [createDeferredCore(), createDeferredCore()];
    const release = [createDeferredCore(), createDeferredCore()];
    let builds = 0;
    fixture.mocks.prepareStaticCatalog.mockImplementation(async () => {
      const index = builds++;
      entered[index]!.resolve();
      await release[index]!.promise;
      return { entries: [] };
    });
    const global = observeGlobalPublication();
    const scoped = preparePendingAgentDatabase(refusal, { assertCurrent() {} }, () =>
      publishDeferredAgentModelRuntime({
        cfg,
        agentId: "default",
        pluginRegistry: createEmptyPluginRegistry(),
        assertCurrent() {},
      }),
    );
    const rejected = expect(scoped).rejects.toThrow("model preparation has not published");
    const publications: Promise<void>[] = [];
    try {
      await withinTest(entered[0]!.promise, signal);
      publications.push(publishConfiguredModelRuntimeSnapshots({ cfg }));
      await withinTest(global.entered, signal);
      release[0]!.resolve();
      await withinTest(entered[1]!.promise, signal);
      // The global caller is outside the pending agent's private preparation borrow.
      publications.push(publishConfiguredModelRuntimeSnapshots({ cfg }));
      await withinTest(global.secondEntered, signal);
      release[1]!.resolve();
      await Promise.all([rejected, ...publications]);
      expect(builds).toBe(2);
      expect(readAgentDatabaseAdmissionRefusal("default")).toBeDefined();
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled([scoped, ...publications]);
      global.restore();
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  },
);
