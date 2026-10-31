import { raceWithTimeout } from "@openclaw/retry";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  NotificationReceiptResolveContext,
  NotificationReceiptState,
  NotificationResolveContext,
  NotificationSourceReference,
  NotificationSourceState,
} from "./source-types.js";

const SOURCE_RESOLVE_TIMEOUT_MS = 10_000;

export class NotificationSourceUnavailableError extends Error {
  constructor(readonly reason: "missing" | "retired" | "timeout" | "resolve-failed" | "ambiguous") {
    super(`Notification source unavailable: ${reason}`);
    this.name = "NotificationSourceUnavailableError";
  }
}

function currentRegistry() {
  return getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? getActivePluginRegistry();
}

/** Reacquired on recovery; a persisted reference never retains a plugin callback. */
export function captureNotificationSource(sourceId: string) {
  const registry = currentRegistry();
  const entry = registry?.notificationSources.find(({ provider }) => provider.id === sourceId);
  const record = registry?.plugins.find((plugin) => plugin.id === entry?.pluginId);
  const authority =
    registry && record
      ? capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true })
      : undefined;
  if (!registry || !entry || !authority) {
    throw new NotificationSourceUnavailableError("missing");
  }
  const assertCurrent = () => {
    if (
      currentRegistry() !== registry ||
      !authority() ||
      registry.notificationSources.find(({ provider }) => provider.id === sourceId) !== entry
    ) {
      throw new NotificationSourceUnavailableError("retired");
    }
  };
  const run = async <T>(resolve: () => T | Promise<T>, signal?: AbortSignal): Promise<T> => {
    assertCurrent();
    signal?.throwIfAborted();
    let value: T;
    try {
      value = await raceWithTimeout(
        () => Promise.resolve(resolve()),
        SOURCE_RESOLVE_TIMEOUT_MS,
        () => {
          throw new NotificationSourceUnavailableError("timeout");
        },
        { signal, ref: false },
      );
    } catch (error) {
      assertCurrent();
      signal?.throwIfAborted();
      if (error instanceof NotificationSourceUnavailableError) {
        throw error;
      }
      // A source can contain private records; do not surface provider-controlled error text.
      throw new NotificationSourceUnavailableError("resolve-failed");
    }
    assertCurrent();
    signal?.throwIfAborted();
    return value;
  };
  return {
    assertCurrent,
    resolve: async (
      reference: NotificationSourceReference,
      context: NotificationResolveContext,
    ): Promise<NotificationSourceState | null> => {
      if (reference.sourceId !== sourceId) {
        throw new NotificationSourceUnavailableError("missing");
      }
      return run(() => entry.provider.resolve(reference, context), context.signal);
    },
    resolveReceipt: async (
      ownerKey: string,
      context: NotificationReceiptResolveContext,
    ): Promise<NotificationReceiptState | null> =>
      run(() => entry.provider.resolveReceipt?.(ownerKey, context) ?? null, context.signal),
  };
}

export async function resolveNotificationSource(
  reference: NotificationSourceReference,
  context: NotificationResolveContext,
): Promise<NotificationSourceState | null> {
  return captureNotificationSource(reference.sourceId).resolve(reference, context);
}

/** Absence and source outages never imply resolution of a retained receipt. */
export async function resolveNotificationReceipt(
  ownerKey: string,
  context: NotificationReceiptResolveContext = {},
): Promise<NotificationReceiptState | null> {
  const registry = currentRegistry();
  // Capture a finite set before awaiting providers. Registration replacement or
  // retirement during another provider's lookup invalidates the whole result.
  const entries = [...(registry?.notificationSources ?? [])];
  const sources = entries
    .filter(({ provider }) => provider.resolveReceipt)
    .map(({ provider }) => captureNotificationSource(provider.id));
  let matched: NotificationReceiptState | null = null;
  for (const source of sources) {
    const result = await source.resolveReceipt(ownerKey, context);
    if (result) {
      if (matched) {
        throw new NotificationSourceUnavailableError("ambiguous");
      }
      matched = result;
    }
  }
  if (
    currentRegistry() !== registry ||
    entries.length !== (registry?.notificationSources.length ?? 0) ||
    entries.some((entry, index) => entry !== registry?.notificationSources[index])
  ) {
    throw new NotificationSourceUnavailableError("retired");
  }
  for (const source of sources) {
    source.assertCurrent();
  }
  return matched;
}
