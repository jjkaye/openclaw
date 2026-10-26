import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  replayLifecycleWebhook,
  withStoppedMonitor,
} from "./test-support/lifecycle-test-support.js";
import {
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

type Reply = PluginRuntime["channel"]["reply"];
type Session = PluginRuntime["channel"]["session"];

describe("Zalo reply-once lifecycle", () => {
  const textUpdate = createTextUpdate({
    messageId: "zalo-replay",
    userId: "user-1",
    userName: "User One",
    chatId: "dm-chat-1",
    text: "check https://example.com",
  });
  const recordSession = vi.fn<Session["recordInboundSession"]>(async () => {});
  const dispatchReply = vi.fn();

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-reply-once-lifecycle");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      reply: {
        finalizeInboundContext: (ctx) => ctx,
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReply as unknown as Reply["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordInboundSession: recordSession,
      },
    });
  });

  afterAll(resetLifecycleTestState);

  function startMonitor() {
    const setup = createLifecycleMonitorSetup({
      accountId: "acct-zalo-lifecycle",
      dmPolicy: "open",
    });
    return startWebhookLifecycleMonitor({
      ...setup,
      cacheKey: "zalo-reply-once-lifecycle",
      config: {
        ...setup.config,
        session: { dmScope: "per-channel-peer" as const },
      },
    });
  }

  it.each([
    ["message.text.received", false],
    ["message.unsupported.received", false],
    ["message.text.received", true],
  ] as const)(
    "replies once to %s across replay (post-send failure=%s)",
    async (eventName, failed) => {
      dispatchReply.mockImplementation(async ({ dispatcherOptions, replyOptions }) => {
        expect(replyOptions.turnAdoptionLifecycle).toBeDefined();
        await replyOptions.turnAdoptionLifecycle?.onAdopted();
        await dispatcherOptions.deliver({ text: "zalo reply once" });
        if (failed && dispatchReply.mock.calls.length === 1) {
          throw new Error("post-send failure");
        }
      });

      await withStoppedMonitor(await startMonitor(), async (monitor) => {
        await replayLifecycleWebhook(monitor, { ...textUpdate, event_name: eventName }, failed);

        expect(dispatchReply).toHaveBeenCalledTimes(1);
        expect(dispatchReply.mock.calls[0]?.[0].ctx.BodyForAgent).toBe("check https://example.com");
        expect(recordSession).toHaveBeenCalledTimes(1);
        expect(recordSession.mock.calls[0]?.[0]).toMatchObject({
          sessionKey: "agent:main:zalo:direct:dm-chat-1",
          ctx: {
            MessageSid: "zalo-replay",
            AccountId: "acct-zalo-lifecycle",
            SessionKey: "agent:main:zalo:direct:dm-chat-1",
            From: "zalo:user-1",
            To: "zalo:dm-chat-1",
          },
        });
        expect(sendMessageMock).toHaveBeenCalledExactlyOnceWith(
          "zalo-token",
          expect.objectContaining({ chat_id: "dm-chat-1", text: "zalo reply once" }),
          undefined,
        );
        if (failed) {
          expect(monitor.runtime.error).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([undefined, " \t "])(
    "logs unsupported events with no usable text (%j) without sending a reply",
    async (text) => {
      await withStoppedMonitor(await startMonitor(), async (monitor) => {
        await replayLifecycleWebhook(
          monitor,
          {
            ...textUpdate,
            event_name: "message.unsupported.received",
            message: { ...textUpdate.message, text },
          },
          true,
        );

        expect(monitor.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("Zalo unsupported message has no recoverable text"),
        );
        expect(dispatchReply).not.toHaveBeenCalled();
        expect(recordSession).not.toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
      });
    },
  );
});
