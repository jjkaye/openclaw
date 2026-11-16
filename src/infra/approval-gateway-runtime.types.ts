import type { GatewayNativeApprovalMethod } from "./approval-gateway-runtime-methods.js";
import type { ApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import type { ApprovalRequest, ApprovalResolved, ChannelApprovalKind } from "./approval-types.js";

export type GatewayApprovalRequest = ApprovalRequest;
export type GatewayApprovalResolved = ApprovalResolved;

export type GatewayNativeApprovalRequestOptions = {
  clientDisplayName?: string;
  /** Provider conversation from a matched native control; never a public RPC claim. */
  conversationId?: string;
  /** Native account lifetime; the host accepts only its opaque internal guard. */
  commitGuard?: () => void;
  signal?: AbortSignal;
};

export type GatewayApprovalEventSubscriber = {
  eventKinds: ReadonlySet<ChannelApprovalKind>;
  shouldHandle: (request: GatewayApprovalRequest) => boolean;
  onRequested: (request: GatewayApprovalRequest) => void;
  onResolved: (resolved: GatewayApprovalResolved) => void;
};

/** Gateway-owned authority and event transport for channel-native approval runtimes. */
export type GatewayNativeApprovalRuntime = {
  request: <T = unknown>(
    method: GatewayNativeApprovalMethod,
    params: Record<string, unknown>,
    options?: GatewayNativeApprovalRequestOptions,
  ) => Promise<T>;
  requestRoute: <T = unknown>(method: "send", params: Record<string, unknown>) => Promise<T>;
  routeCoordinator: ApprovalNativeRouteCoordinator;
  subscribe: (subscriber: GatewayApprovalEventSubscriber) => () => void;
};
