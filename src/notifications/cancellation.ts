import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";

/** Core-authored source veto, never a provider assertion about an attempted send. */
export class NotificationCanceledError extends PlatformMessageNotDispatchedError {
  constructor(readonly excludedTopicKeys: readonly string[]) {
    super("Notification subject changed or is no longer eligible", {
      cause: undefined,
      retryable: false,
    });
    this.name = "NotificationCanceledError";
  }
}

export function findNotificationCancellation(
  error: unknown,
): NotificationCanceledError | undefined {
  return collectNestedErrorCandidates(error).find(
    (candidate): candidate is NotificationCanceledError =>
      candidate instanceof NotificationCanceledError,
  );
}

export function isNotificationCanceledError(error: unknown): boolean {
  return findNotificationCancellation(error) !== undefined;
}
