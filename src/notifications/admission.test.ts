import { describe, expect, it } from "vitest";
import {
  createNotificationCandidate,
  notificationStateEligible,
  notificationTopicKey,
} from "./admission.js";
import {
  parseNotificationProposal,
  unwrapNotificationEnvelopes,
  type NotificationProposal,
} from "./proposal.js";
import type { NotificationResolveContext, NotificationSourceState } from "./source-types.js";

const proposal: NotificationProposal = {
  sourceId: "tasks",
  ownerId: "task-1",
  topicId: "decision-a",
  purpose: "decision",
  expectedRevision: "v1",
};
const context: NotificationResolveContext = {
  agentId: "assistant",
  recipient: { channel: "matrix", to: "owner" },
};
const state: NotificationSourceState = {
  topicId: "decision-a",
  revision: "v1",
  status: "open",
  timeZone: "America/New_York",
};
const start = Date.parse("2026-10-30T15:00:00Z");

describe("notification source eligibility", () => {
  it("rejects unsupported revisions, topics and stale decision states", () => {
    expect(notificationStateEligible(proposal, state, start)).toBe(true);
    expect(notificationStateEligible(proposal, null, start)).toBe(false);
    expect(notificationStateEligible(proposal, { ...state, revision: "v2" }, start)).toBe(false);
    expect(notificationStateEligible(proposal, { ...state, topicId: "decision-b" }, start)).toBe(
      false,
    );
    for (const status of ["paused", "answered", "resolved", "superseded"] as const) {
      expect(notificationStateEligible(proposal, { ...state, status }, start)).toBe(false);
    }
  });
  it("does not resurrect expired completed results when transport history is absent", () => {
    const result = { ...proposal, purpose: "result" as const };
    for (const anchor of [{ resolvedAt: start }, { resolvedOn: "2026-10-30" }]) {
      const completed = { ...state, status: "resolved" as const, ...anchor };
      expect(notificationStateEligible(result, completed, start)).toBe(true);
      expect(notificationStateEligible(result, completed, start + 31 * 86400000)).toBe(false);
    }
    expect(notificationStateEligible(result, { ...state, status: "resolved" }, start)).toBe(false);
    expect(
      notificationStateEligible(
        result,
        { ...state, status: "resolved", resolvedOn: "2026-02-30" },
        start,
      ),
    ).toBe(false);
    expect(
      notificationStateEligible(
        result,
        { ...state, status: "resolved", resolvedAt: start + 1 },
        start,
      ),
    ).toBe(false);
  });
  it("distinguishes source-owned subjects and routes while retaining opaque candidate identity", () => {
    expect(notificationTopicKey(proposal, context)).not.toBe(
      notificationTopicKey({ ...proposal, topicId: "decision-b" }, context),
    );
    expect(notificationTopicKey(proposal, context)).not.toBe(
      notificationTopicKey(proposal, {
        ...context,
        recipient: { ...context.recipient, to: "another-owner" },
      }),
    );
    const first = createNotificationCandidate(proposal, context, state, 0);
    const changed = createNotificationCandidate(
      proposal,
      context,
      { ...state, consequenceKey: "deadline-today" },
      0,
    );
    expect(first.receiptBase.ownerKey).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.receiptBase.revisionKey).not.toBe(first.receiptBase.revisionKey);
    expect(JSON.stringify(first.receiptBase)).not.toContain("task-1");
  });
});

describe("notification producer contract", () => {
  it("unwraps only explicitly tagged strict envelopes and supports distinct briefing items", () => {
    expect(unwrapNotificationEnvelopes("ordinary reply")).toBeUndefined();
    expect(unwrapNotificationEnvelopes('{"text":"ordinary JSON"}')).toBeUndefined();
    const item = { text: "Please decide", notification: proposal };
    expect(
      unwrapNotificationEnvelopes(JSON.stringify({ $schema: "openclaw.notification.v1", ...item })),
    ).toEqual([item]);
    expect(
      unwrapNotificationEnvelopes(
        JSON.stringify({ $schema: "openclaw.notification.v1", notifications: [item, item] }),
      ),
    ).toHaveLength(2);
    expect(() =>
      unwrapNotificationEnvelopes(
        JSON.stringify({
          $schema: "openclaw.notification.v1",
          notifications: [{ text: "unguarded" }],
        }),
      ),
    ).toThrow("Invalid notification envelope");
    expect(parseNotificationProposal({ ...proposal, urgency: "invented" })).toBeUndefined();
  });
});
