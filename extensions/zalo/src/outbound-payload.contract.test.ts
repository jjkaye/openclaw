import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
  type OutboundPayloadHarnessParams,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  createMessageReceiptFromOutboundResults,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";

const sendZaloTextMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel.runtime.js")>()),
  sendMessageZalo: sendZaloTextMock,
}));

const required = <T>(value: T | undefined) => expectDefined(value, "Zalo outbound capability");

const zaloMessageAdapter = required(zaloPlugin.message);
const target = () => ({ cfg: {}, to: "123456789" });

function createZaloHarness(params: OutboundPayloadHarnessParams) {
  const sendZalo = vi.fn();
  primeChannelOutboundSendMock(sendZalo, { messageId: "zl-1" }, params.sendResults);
  sendZaloTextMock
    .mockReset()
    .mockImplementation(
      async (to: string, text: string, nextCtx: { mediaUrl?: string }) =>
        await sendZalo(to, text, { mediaUrl: nextCtx.mediaUrl }),
    );
  const sendPayload = required(zaloPlugin.outbound?.sendPayload);
  return {
    run: () => sendPayload({ ...target(), text: "", payload: params.payload }),
    sendMock: sendZalo,
    to: target().to,
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Zalo outbound payload contract", () => {
  installChannelOutboundPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createZaloHarness,
  });

  it.each([
    { kind: "text", payload: { text: "hello" } },
    { kind: "media", payload: { text: "image", mediaUrl: "https://example.com/image.png" } },
  ] as const)(
    "reports $kind message-adapter failures to durable delivery",
    async ({ kind, payload }) => {
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

  it.each(["text", "media"] as const)("delivers declared durable %s receipts", async (kind) => {
    expect(zaloMessageAdapter.durableFinal?.capabilities).toEqual({
      text: true,
      media: true,
      messageSendingHooks: true,
    });
    sendZaloTextMock
      .mockReset()
      .mockImplementation(async (_to: string, _text: string, ctx: { mediaUrl?: string }) => {
        const deliveredKind = ctx.mediaUrl ? "media" : "text";
        const messageId = `zl-${deliveredKind}-1`;
        return {
          messageId,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "zalo", messageId }],
            kind: deliveredKind,
          }),
        };
      });
    const result = await required(zaloMessageAdapter.send?.[kind])({
      ...target(),
      text: "hello",
      ...(kind === "media" ? { mediaUrl: "https://example.com/image.png" } : {}),
    });
    expect(result.receipt.platformMessageIds).toEqual([`zl-${kind}-1`]);
  });
});
