import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

const sendZaloTextMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel.runtime.js")>()),
  sendMessageZalo: sendZaloTextMock,
}));

const required = <T>(value: T | undefined) => expectDefined(value, "Zalo outbound capability");

const target = () => ({ cfg: {}, to: "123456789" });

beforeEach(resetGlobalHookRunner);
afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Zalo outbound payload contract", () => {
  it("splits Zalo payload text at 2000 characters", async () => {
    sendZaloTextMock.mockReset().mockResolvedValue({ messageId: "chunk" });
    const result = await required(zaloPlugin.outbound?.sendPayload)({
      ...target(),
      text: "",
      payload: { text: "a".repeat(3000) },
    });
    expect(sendZaloTextMock.mock.calls.map(([, text]) => text)).toEqual([
      "a".repeat(2000),
      "a".repeat(1000),
    ]);
    expect(result).toMatchObject({ channel: "zalo", messageId: "chunk" });
  });

  it.each([
    { kind: "text", payload: { text: "hello" } },
    { kind: "media", payload: { text: "image", mediaUrl: "https://example.com/image.png" } },
  ] as const)(
    "reports $kind message-adapter failures to durable delivery",
    async ({ kind, payload }) => {
      expect(required(zaloPlugin.message).durableFinal?.capabilities).toEqual({
        text: true,
        media: true,
        messageSendingHooks: true,
      });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "zalo", source: "test", plugin: zaloPlugin }]),
      );
      sendZaloTextMock.mockReset().mockRejectedValue(new Error(`Zalo rejected the ${kind}`));

      const result = await sendDurableMessageBatch({
        ...target(),
        channel: "zalo",
        payloads: [payload],
        skipQueue: true,
      });

      expect(result).toMatchObject({
        status: "failed",
        error: { message: `Zalo rejected the ${kind}` },
      });
    },
  );
});
