import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type {
  GatewayNativeApprovalRuntime,
  GatewayNativeApprovalRequestOptions,
} from "../infra/approval-gateway-runtime.types.js";
import {
  retainInternalApprovalCommitGuard,
  retainNativeChannelApprovalDecision,
} from "./internal-approval-authority.js";

/** Account-owned approval capability; callers retain the original task and lease assertion. */
export function createChannelApprovalRuntime(params: {
  runtime: Pick<GatewayNativeApprovalRuntime, "request">;
  channelId: string;
  accountId: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Pick<GatewayNativeApprovalRuntime, "request"> {
  const { runtime, channelId, accountId, signal, assertCurrent } = params;
  const assertApprovalCurrent = retainInternalApprovalCommitGuard(assertCurrent);
  return {
    request: async <T>(
      method: GatewayNativeApprovalMethod,
      requestParams: Record<string, unknown>,
      requestOptions?: GatewayNativeApprovalRequestOptions,
    ): Promise<T> => {
      if (method !== "approval.resolve") {
        throw new Error(`channel approval runtime cannot dispatch ${method}`);
      }
      assertApprovalCurrent();
      const commitGuard = retainNativeChannelApprovalDecision({
        guard: assertApprovalCurrent,
        channel: channelId,
        accountId,
        request: requestParams,
        conversationId: requestOptions?.conversationId,
      });
      const result = await runtime.request<T>("approval.resolve", requestParams, {
        clientDisplayName: requestOptions?.clientDisplayName,
        commitGuard,
        signal,
      });
      assertApprovalCurrent();
      return result;
    },
  };
}
