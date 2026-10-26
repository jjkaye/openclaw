import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { loadModelProvidersData } from "./load.ts";

const emptyAuth = { ts: 1, providers: [] };
const model = { id: "configured", name: "Configured", provider: "test-provider" };
const configured = { models: [model] };
function harness(
  catalog: (params?: unknown) => unknown = () => configured,
  auth: () => unknown = () => emptyAuth,
  raw = false,
) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "models.authStatus") {
      return auth();
    }
    if (method === "models.list") {
      return catalog(params);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = raw
    ? ({ request } as unknown as GatewayBrowserClient)
    : createTestGatewayClient(request);
  return {
    load: (refresh = false, signal?: AbortSignal) =>
      loadModelProvidersData(client, { agentId: "main", refresh, signal }),
  };
}

it.each(["auth failure", "page retirement"])(
  "settles %s before acquiring models",
  async (ending) => {
    const auth = createDeferred();
    const events: string[] = [];
    const catalog = vi.fn(() => {
      events.push("catalog");
      return configured;
    });
    const h = harness(catalog, async () => {
      try {
        await auth.promise;
      } finally {
        events.push("auth");
      }
      return emptyAuth;
    });
    const controller = new AbortController();
    const loading = h.load(true, controller.signal);
    if (ending === "page retirement") {
      controller.abort();
      auth.resolve();
    } else {
      auth.reject(new Error("Authentication status unavailable"));
    }
    const result = await loading;
    if (ending === "page retirement") {
      expect(catalog).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({
        catalogError: null,
        error: "Authentication status unavailable",
      });
      expect(events).toEqual(["auth", "catalog"]);
    }
  },
);

it.each([false, true])(
  "retains providers and redacts catalog failures (refresh=%s)",
  async (refresh) => {
    const h = harness(
      (params) => {
        if (!refresh || (params as { refresh?: boolean } | undefined)?.refresh) {
          throw new Error("catalog unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
        }
        return configured;
      },
      () => ({
        ...emptyAuth,
        providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
        ...(refresh ? { providerCapabilities: [] } : {}),
      }),
      true,
    );
    if (refresh) {
      await h.load();
    }
    const result = await h.load(refresh);
    expect(result).toMatchObject({
      catalogError: "catalog unavailable: OPENAI_API_KEY=sk-123...cdef",
      error: null,
    });
    expect(result.authStatus?.providers).toHaveLength(1);
  },
);

it("surfaces unavailable auth preparation", async () => {
  const unavailable = { code: "PREPARED_MODEL_AUTH_UNAVAILABLE", message: "Unavailable." };
  const h = harness(undefined, () => ({ ...emptyAuth, unavailable }));
  expect(await h.load()).toMatchObject({ error: unavailable.message, authStatus: { unavailable } });
});

it("retries a missing auth-status response", async () => {
  let malformed = true;
  const h = harness(
    () => ({ models: [] }),
    () => (malformed ? undefined : { ts: 2, providers: [] }),
    true,
  );
  const result = await h.load();
  expect(result.authStatus).toEqual({ ts: 0, providers: [] });
  expect(result).toMatchObject({
    catalogError: null,
    error: null,
  });
  malformed = false;
  expect((await h.load()).authStatus).toEqual({ ts: 2, providers: [] });
});
