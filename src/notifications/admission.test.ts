import { describe, expect, it } from "vitest";
import {
  admitNotification,
  notificationLocalDate,
  notificationTopicKey,
  type NotificationTopicDelivery,
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
function admit(
  now: number,
  deliveries: NotificationTopicDelivery[] = [],
  overrides: Partial<NotificationSourceState> = {},
) {
  return admitNotification({
    proposal,
    context,
    state: { ...state, ...overrides },
    deliveries,
    now,
  });
}

describe("shared notification admission", () => {
  it("allows an initial ask and exactly two later local dates, not repeated wakes", () => {
    const deliveries: NotificationTopicDelivery[] = [];
    for (const [day, slot] of [
      [0, 0],
      [1, 1],
      [2, 2],
    ] as const) {
      const admitted = admit(start + day * 86_400_000, deliveries)!;
      expect(admitted.receipt.slot).toBe(slot);
      expect(admitted.id).toMatch(/^notification-[a-f0-9]{64}$/);
      deliveries.push({
        id: admitted.id,
        status: "completed",
        notificationReceipt: admitted.receipt,
      });
      expect(admit(start + day * 86_400_000 + 3_600_000, deliveries)).toBeUndefined();
    }
    expect(admit(start + 10 * 86_400_000, deliveries)).toBeUndefined();
  });

  it("uses actual acknowledgement date across midnight and the25hour DST day", () => {
    expect(notificationLocalDate(Date.parse("2026-11-01T05:30:00Z"), state.timeZone)).toBe(
      "2026-11-01",
    );
    expect(notificationLocalDate(Date.parse("2026-11-01T06:30:00Z"), state.timeZone)).toBe(
      "2026-11-01",
    );
    const first = admit(start)!;
    const deliveries: NotificationTopicDelivery[] = [
      {
        id: first.id,
        status: "completed",
        notificationReceipt: first.receipt,
        acknowledgedAt: Date.parse("2026-11-01T04:10:00Z"),
      },
    ];
    expect(admit(Date.parse("2026-11-01T23:00:00Z"), deliveries)).toBeUndefined();
    expect(admit(Date.parse("2026-11-02T05:01:00Z"), deliveries)?.receipt.slot).toBe(1);
  });

  it("keeps unknown older revisions in custody and rejects unsupported model revisions", () => {
    const first = admit(start)!;
    expect(
      admit(start, [
        {
          id: first.id,
          status: "pending",
          notificationReceipt: { ...first.receipt, revisionKey: "b".repeat(64) },
        },
      ]),
    ).toBeUndefined();
    expect(
      admit(start, [
        {
          id: first.id,
          status: "failed",
          recoveryState: "settlement_pending",
          notificationReceipt: { ...first.receipt, revisionKey: "b".repeat(64) },
        },
      ]),
    ).toBeUndefined();
    expect(admit(start, [], { revision: "v2" })).toBeUndefined();
    for (const status of ["answered", "paused", "resolved", "superseded"] as const) {
      expect(admit(start, [], { status })).toBeUndefined();
    }
  });

  it("separates same-task decisions and recipients; source consequence can reopen attention", () => {
    expect(notificationTopicKey(proposal, context)).not.toBe(
      notificationTopicKey({ ...proposal, topicId: "decision-b" }, context),
    );
    expect(notificationTopicKey(proposal, context)).not.toBe(
      notificationTopicKey(proposal, {
        ...context,
        recipient: { ...context.recipient, to: "another-owner" },
      }),
    );
    const first = admit(start)!;
    const deliveries: NotificationTopicDelivery[] = [
      { id: first.id, status: "completed", notificationReceipt: first.receipt },
    ];
    const changed = admit(start + 1_000, deliveries, { consequenceKey: "source-deadline-today" });
    expect(changed?.receipt.slot).toBe(0);
    expect(changed?.id).not.toBe(first.id);
  });

  it("reports a new completed result once while keeping resolved decisions quiet", () => {
    const resultProposal = { ...proposal, purpose: "result" as const };
    const completed = { ...state, status: "resolved" as const, resolvedAt: start };
    const first = admitNotification({
      proposal: resultProposal,
      context,
      state: completed,
      deliveries: [],
      now: start,
    })!;
    expect(first.receipt.resolvedAt).toBe(start);
    expect(
      admitNotification({
        proposal: resultProposal,
        context,
        state: completed,
        deliveries: [{ id: first.id, status: "completed", notificationReceipt: first.receipt }],
        now: start + 86_400_000,
      }),
    ).toBeUndefined();
  });

  it("never resurrects an expired resolved result after its receipt is pruned", () => {
    const resultProposal = { ...proposal, purpose: "result" as const };
    for (const closure of [{ resolvedAt: start }, { resolvedOn: "2026-10-30" }]) {
      const completed = { ...state, status: "resolved" as const, ...closure };
      const initial = admitNotification({
        proposal: resultProposal,
        context,
        state: completed,
        deliveries: [],
        now: start,
      });
      expect(initial).toBeDefined();
      expect(
        admitNotification({
          proposal: resultProposal,
          context,
          state: completed,
          deliveries: [],
          now: start + 31 * 86_400_000,
        }),
      ).toBeUndefined();
    }
    expect(
      admitNotification({
        proposal: resultProposal,
        context,
        state: { ...state, status: "resolved" },
        deliveries: [],
        now: start,
      }),
    ).toBeUndefined();
    expect(
      admitNotification({
        proposal: resultProposal,
        context,
        state: { ...state, revision: "v2", status: "open" },
        deliveries: [],
        now: start + 31 * 86_400_000,
      }),
    ).toBeUndefined();
    expect(
      admitNotification({
        proposal: { ...resultProposal, expectedRevision: "v2" },
        context,
        state: { ...state, revision: "v2", status: "open" },
        deliveries: [],
        now: start + 31 * 86_400_000,
      }),
    ).toBeDefined();
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
