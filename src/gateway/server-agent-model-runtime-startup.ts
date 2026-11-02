import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";

/** Publish the inspected agent inside its existing private admission scope. */
export async function publishDeferredAgentModelRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  pluginRegistry: PluginRegistry;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  assertCurrent: () => void;
}): Promise<void> {
  const [{ refreshPreparedModelRuntimeSnapshots, getPreparedModelRuntimeSnapshot }, configured] =
    await Promise.all([
      import("../agents/prepared-model-runtime.js"),
      import("../agents/prepared-model-runtime.configured.js"),
    ]);
  for (let attempt = 0; attempt < 2; attempt++) {
    params.assertCurrent();
    await withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
      refreshPreparedModelRuntimeSnapshots(params.cfg, {
        agentIds: new Set([params.agentId]),
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        joinSupersedingPublication: true,
        ...(params.pluginMetadataSnapshot
          ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
          : {}),
        isPublicationCurrent: () => {
          try {
            params.assertCurrent();
            return true;
          } catch {
            return false;
          }
        },
      }),
    );
    params.assertCurrent();
    const input = configured
      .listConfiguredOwnerInputs(params.cfg, undefined, true)
      .find((candidate) => candidate.agentId === params.agentId);
    if (!input) {
      throw new Error(`Agent ${params.agentId} model preparation is no longer configured`);
    }
    if (getPreparedModelRuntimeSnapshot(input)) {
      return;
    }
    // Global startup cannot borrow this pending admission. Its replacement can
    // omit our owner; republish once after joining it, under the same guards.
  }
  throw new Error(`Agent ${params.agentId} model preparation has not published`);
}
