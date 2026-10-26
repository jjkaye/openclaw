import type { ReadinessChecker } from "./server/readiness.js";

type GatewayReadinessLog = {
  log: { info: (message: string) => void };
  getReadiness: ReadinessChecker;
};

export function logGatewayReady(params: GatewayReadinessLog, message = "gateway ready"): void {
  if (params.getReadiness().ready) {
    params.log.info(message);
  }
}
