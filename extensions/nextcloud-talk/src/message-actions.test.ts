import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const { sendReactionNextcloudTalk, listNextcloudTalkAccountIds, resolveNextcloudTalkAccount } =
  vi.hoisted(() => ({
    sendReactionNextcloudTalk: vi.fn(),
    listNextcloudTalkAccountIds: vi.fn(),
    resolveNextcloudTalkAccount: vi.fn(),
  }));

vi.mock("./send.js", () => ({
  sendReactionNextcloudTalk,
}));

vi.mock("./accounts.js", () => ({
  listNextcloudTalkAccountIds,
  resolveNextcloudTalkAccount,
}));

const { nextcloudTalkMessageActions } = await import("./message-actions.js");

const configuredAccount = {
  accountId: "default",
  enabled: true,
  baseUrl: "https://nc.example.com",
  secret: "bot-secret",
} as const;

const unconfiguredAccount = { ...configuredAccount, baseUrl: "", secret: null };
const disabledAccount = { ...configuredAccount, enabled: false };
const reaction = { to: "room:abc123", messageId: "1", emoji: "👍" };
const cfg: CoreConfig = {};
type ActionContext = Parameters<NonNullable<typeof nextcloudTalkMessageActions.handleAction>>[0];
const act = (params: ActionContext["params"], context: Partial<ActionContext> = {}) =>
  nextcloudTalkMessageActions.handleAction!({
    channel: "nextcloud-talk",
    action: "react",
    params,
    cfg,
    ...context,
  });

describe("nextcloudTalkMessageActions", () => {
  beforeEach(() => {
    sendReactionNextcloudTalk.mockReset().mockResolvedValue(undefined);
    listNextcloudTalkAccountIds.mockReset();
    resolveNextcloudTalkAccount.mockReset().mockReturnValue(configuredAccount);
  });

  describe("describeMessageTool", () => {
    it("returns null when configured account has no secret/baseUrl", () => {
      listNextcloudTalkAccountIds.mockReturnValue([unconfiguredAccount.accountId]);
      resolveNextcloudTalkAccount.mockReturnValue(unconfiguredAccount);

      expect(nextcloudTalkMessageActions.describeMessageTool?.({ cfg: {} })).toBeNull();
    });

    it("scopes discovery to a specific accountId when provided", () => {
      const result = nextcloudTalkMessageActions.describeMessageTool?.({
        cfg: {},
        accountId: "work",
      });

      expect(resolveNextcloudTalkAccount).toHaveBeenCalledWith({
        cfg: {},
        accountId: "work",
      });
      expect(listNextcloudTalkAccountIds).not.toHaveBeenCalled();
      expect(result?.actions).toEqual(["send", "react"]);
    });
  });

  it("handles react locally", () => {
    expect(nextcloudTalkMessageActions.supportsAction?.({ action: "react" })).toBe(true);
  });

  describe("handleAction", () => {
    it.each([
      ["disabled account", disabledAccount, reaction, /is disabled or not configured/],
      ["unconfigured account", unconfiguredAccount, reaction, /is disabled or not configured/],
      [
        "missing id",
        configuredAccount,
        { to: reaction.to, emoji: reaction.emoji },
        /messageId required/,
      ],
      ["removal", configuredAccount, { ...reaction, remove: true }, /removal is not supported/],
    ] as const)("rejects %s before reaching the sender", async (_name, account, params, error) => {
      resolveNextcloudTalkAccount.mockReturnValue(account);
      await expect(act(params, { accountId: "work" })).rejects.toThrow(error);
      expect(sendReactionNextcloudTalk).not.toHaveBeenCalled();
    });

    it("uses toolContext.currentMessageId when params.messageId is missing", async () => {
      await act(
        { to: "room:abc123", emoji: "✅", remove: false },
        { accountId: null, toolContext: { currentMessageId: 99 } },
      );

      expect(sendReactionNextcloudTalk).toHaveBeenCalledWith("room:abc123", "99", "✅", {
        accountId: undefined,
        cfg,
      });
    });

    it.each([
      ["send", /handled by outbound/],
      ["delete", /Action delete not supported for nextcloud-talk/],
    ] as const)("rejects %s through the action handler", async (action, error) => {
      await expect(act({ to: "room:abc123", text: "hi" }, { action })).rejects.toThrow(error);
    });
  });
});
