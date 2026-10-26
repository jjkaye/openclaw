import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import { zaloWebhookRuntime } from "./monitor.webhook.js";
import { ZaloWebhookPayloadError } from "./webhook-spool.js";

const {
  clearZaloWebhookSecurityStateForTest,
  handleZaloWebhookRequest,
  registerZaloWebhookTarget,
} = zaloWebhookRuntime;
const unregister: Array<() => void> = [];
function register(
  acceptWebhook: (rawEvent: string) => Promise<void> = async () => {},
  config: OpenClawConfig = {},
) {
  unregister.push(
    registerZaloWebhookTarget({
      account: {
        accountId: "default",
        enabled: true,
        token: "tok",
        tokenSource: "config",
        config: {},
      },
      config,
      runtime: {} as ZaloRuntimeEnv,
      secret: "secret",
      path: "/hook",
      acceptWebhook,
    }),
  );
}
type Post = (body?: string, headers?: Record<string, string>, suffix?: string) => Promise<Response>;
const secretHeader = "x-bot-api-secret-token";
function withWebhook(run: (post: Post) => Promise<void>) {
  return withServer(
    async (req, res) => {
      if (!(await handleZaloWebhookRequest(req, res))) {
        res.statusCode = 404;
        res.end("not found");
      }
    },
    (baseUrl) =>
      run((body = "{}", headers = {}, suffix = "") =>
        fetch(`${baseUrl}/hook${suffix}`, {
          method: "POST",
          headers: {
            [secretHeader]: "secret",
            "content-type": "application/json",
            ...headers,
          },
          body,
        }),
      ),
  );
}
async function reachesRateLimit(
  request: (index: number) => Promise<Response>,
  attempts: number,
  unauthorized = false,
) {
  for (let i = 0; i < attempts; i += 1) {
    const response = await request(i);
    if (unauthorized) {
      expect([401, 429]).toContain(response.status);
    }
    if (response.status === 429) {
      return true;
    }
  }
  return false;
}
describe("Zalo webhook HTTP boundary", () => {
  afterEach(() => {
    for (const stop of unregister.splice(0)) {
      stop();
    }
    clearZaloWebhookSecurityStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  it.each([
    ["invalid admission payload", "null", {}, 400],
    ["non-JSON content type", "{}", { "content-type": "text/plain" }, 415],
    [
      "invalid secret before content type",
      "not-json",
      { [secretHeader]: "invalid-token", "content-type": "text/plain" },
      401,
    ],
  ] as const)("rejects %s", async (_name, body, headers, status) => {
    register(async () => {
      throw new ZaloWebhookPayloadError("invalid payload");
    });
    await withWebhook(async (post) => {
      const response = await post(body, headers);
      expect(response.status).toBe(status);
      if (status === 400) {
        expect(await response.text()).toBe("Bad Request");
      }
    });
  });
  it("rejects ambiguous targets without admitting either", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    register(first);
    register(second);
    await withWebhook(async (post) => {
      expect((await post()).status).toBe(401);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();
    });
  });
  it.each([false, true])("acks only durable admission (failed=%s)", async (failed) => {
    const admission = Promise.withResolvers<void>();
    const accept = vi.fn(async () => {
      await admission.promise;
    });
    const body = '{ "event_name": "message.text.received", "extra": true }';
    register(accept);
    try {
      await withWebhook(async (post) => {
        let settled = false;
        const pending = post(body).then((response) => {
          settled = true;
          return response;
        });
        await vi.waitFor(() => expect(accept).toHaveBeenCalledExactlyOnceWith(body));
        expect(settled).toBe(false);
        if (failed) {
          admission.reject(new Error("sqlite unavailable"));
        } else {
          admission.resolve();
        }
        const response = await pending;
        expect([response.status, response.headers.get("x-openclaw-delivery-accepted")]).toEqual(
          failed ? [500, null] : [200, "durable"],
        );
      });
    } finally {
      admission.resolve();
    }
  });
  it.each([true, false])("rate limits query churn (unauthorized=%s)", async (unauthorized) => {
    register();
    await withWebhook(async (post) => {
      expect(
        await reachesRateLimit(
          (i) =>
            post(
              "{}",
              { [secretHeader]: unauthorized ? "invalid-token" : "secret" },
              `?nonce=${i}`,
            ),
          unauthorized ? 200 : 130,
          unauthorized,
        ),
      ).toBe(true);
    });
  });
  it("isolates authenticated traffic from floods by trusted forwarded client IP", async () => {
    register(undefined, { gateway: { trustedProxies: ["127.0.0.1"] } });
    await withWebhook(async (post) => {
      await reachesRateLimit(
        (i) =>
          post(
            "{}",
            {
              [secretHeader]: "invalid-token",
              "x-forwarded-for": "203.0.113.10",
            },
            `?nonce=${i}`,
          ),
        130,
      );
      const response = await post("{}", { "x-forwarded-for": "198.51.100.20" });
      expect(response.status).toBe(200);
    });
  });
});
