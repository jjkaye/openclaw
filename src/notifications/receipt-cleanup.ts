import {
  listNotificationDeliveryReceipts,
  updateNotificationDeliveryReceiptResolution,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-sqlite.js";
import { resolveNotificationReceipt } from "./source-registry.js";

/** Uses the existing queue-maintenance cycle; no independent source poller. */
export async function reconcileNotificationReceiptResolution(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  const receipts = await listNotificationDeliveryReceipts({}, stateDir, context);
  const owners = new Set(receipts.map((receipt) => receipt.notificationReceipt.ownerKey));
  for (const ownerKey of owners) {
    // Missing sources and outages retain custody. Let the next normal
    // maintenance cycle retry without blocking independent queue cleanup.
    try {
      const state = await resolveNotificationReceipt(ownerKey);
      if (!state) {
        continue;
      }
      if (state.status === "resolved" || state.status === "superseded") {
        await updateNotificationDeliveryReceiptResolution(
          { ownerKey, resolvedAt: state.resolvedAt ?? Date.now() },
          stateDir,
          context,
        );
      } else if (
        state.status === "open" ||
        state.status === "paused" ||
        state.status === "answered"
      ) {
        await updateNotificationDeliveryReceiptResolution(
          { ownerKey, resolvedAt: null },
          stateDir,
          context,
        );
      }
    } catch {
      /* Unknown resolution never permits expiry. */
    }
  }
}
