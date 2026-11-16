import { isPluginApprovalScope } from "../gateway/operator-approval-plugin-binding.js";
import type { PluginApprovalBinding } from "../gateway/operator-approval-store.types.js";
import type { PluginHookBeforeToolCallResult } from "./hook-before-tool-call-result.js";
import { cloneHookIsolationValue } from "./hook-isolation.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";

/** Snapshot only validated scalars before the registered instance adopts the private binding. */
function retainHookApprovalBinding(
  receipt: Pick<PluginApprovalBinding, "scope" | "intent">,
  handler: object,
): Pick<PluginApprovalBinding, "scope" | "intent"> | undefined {
  const sourceScope = receipt.scope;
  const scope = {
    generation: sourceScope?.generation,
    digest: sourceScope?.digest,
    validFromMs: sourceScope?.validFromMs,
    validUntilMs: sourceScope?.validUntilMs,
  };
  const intent = receipt.intent;
  // Canonical insertion owns retention; reject malformed snapshots without throwing through a fail-open hook merge.
  if (!isPluginApprovalScope(scope, Infinity) || (intent !== "approve" && intent !== "revoke")) {
    return undefined;
  }
  const binding = Object.freeze({ scope: Object.freeze(scope), intent });
  return getPluginValueInstance(handler)?.adopt(binding) ?? binding;
}

/** Preserve sticky blocking and the first detached approval snapshot across hook handlers. */
export function mergeBeforeToolCallApproval(
  acc: PluginHookBeforeToolCallResult | undefined,
  next: PluginHookBeforeToolCallResult,
  reg: { pluginId: string; handler: object },
): PluginHookBeforeToolCallResult {
  if (acc?.block === true) {
    return acc;
  }
  const approvalAlreadyRequested = acc?.requireApproval !== undefined;
  let params = next.params ?? acc?.params;
  if (approvalAlreadyRequested) {
    params = acc?.params;
  } else if (next.requireApproval && params !== undefined) {
    // Later hooks may block, but cannot change what the operator reviewed.
    params = cloneHookIsolationValue("before_tool_call", params);
  }
  let approval = acc?.requireApproval;
  if (!approval && next.requireApproval) {
    approval = { ...next.requireApproval, pluginId: reg.pluginId };
    if (approval.receiptBinding) {
      const binding = retainHookApprovalBinding(approval.receiptBinding, reg.handler);
      if (!binding) {
        return { params, block: true, blockReason: "Invalid private plugin approval binding" };
      }
      approval.receiptBinding = binding;
    }
  }
  return {
    params,
    block: next.block === true ? true : undefined,
    blockReason: next.blockReason ?? acc?.blockReason,
    requireApproval: approval,
  };
}
