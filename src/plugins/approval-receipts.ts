import type {
  PluginApprovalBinding,
  ReadPluginApprovalReceiptsResult,
} from "../gateway/operator-approval-store.types.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

/** Plugin-private facts, never an execution grant or a model-facing history tool. */
export type PluginApprovalReceipts = {
  read: (
    scope: PluginApprovalBinding["scope"],
  ) => Promise<ReadPluginApprovalReceiptsResult | { outcome: "held"; reason: "unavailable" }>;
};

/** Registration and current invocation supply identity; callers supply only the exact plan scope. */
export function createPluginApprovalReceipts(owner: {
  pluginId: string;
  agentId?: string;
  sessionKey?: string;
  assertCurrent: () => void;
}): PluginApprovalReceipts {
  const { pluginId, agentId, sessionKey, assertCurrent: assertOwnerCurrent } = owner;
  return {
    async read(scope) {
      assertOwnerCurrent();
      if (
        !agentId ||
        !sessionKey ||
        isCronSessionKey(sessionKey) ||
        isSubagentSessionKey(sessionKey)
      ) {
        return { outcome: "held", reason: "unavailable" };
      }
      const { getGatewayToolCallerIdentity, captureGatewayToolCallerAssertion } =
        await import("../agents/tools/gateway-caller-context.js");
      assertOwnerCurrent();
      const caller = getGatewayToolCallerIdentity();
      if (caller?.agentId !== agentId || caller.sessionKey !== sessionKey) {
        return { outcome: "held", reason: "unavailable" };
      }
      const resolveGatewayContext = caller.gatewayContextResolver;
      const gatewayContext = resolveGatewayContext?.();
      const assertCallerCurrent = captureGatewayToolCallerAssertion();
      if (!assertCallerCurrent || !gatewayContext || gatewayContext.localEmbedded === true) {
        return { outcome: "held", reason: "unavailable" };
      }
      const assertCurrent = () => {
        assertOwnerCurrent();
        assertCallerCurrent();
        if (resolveGatewayContext?.() !== gatewayContext) {
          throw new Error("plugin approval receipt Gateway authority is no longer active");
        }
      };
      assertCurrent();
      const { readPluginApprovalReceipts } = await import("../gateway/operator-approval-store.js");
      assertCurrent();
      const result = await readPluginApprovalReceipts({
        pluginId,
        agentId,
        sessionKey,
        scope,
        assertCurrent,
      });
      assertCurrent();
      return result;
    },
  };
}
