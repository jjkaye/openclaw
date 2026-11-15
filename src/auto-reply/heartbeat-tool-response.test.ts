import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createHeartbeatToolResponsePayload,
  normalizeHeartbeatToolResponse,
  selectHeartbeatToolResponse,
} from "./heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "./reply-payload.js";

const notification = {
  sourceId: "fixture-tasks",
  ownerId: "task-1",
  topicId: "next-action",
  purpose: "decision" as const,
  expectedRevision: "material-1",
};

describe("heartbeat notification reference", () => {
  it("preserves the same source proposal in the selected response and outbound payload", () => {
    const payload = createHeartbeatToolResponsePayload({
      outcome: "needs_attention",
      notify: true,
      summary: "A decision is ready.",
      notification,
    });
    expect(selectHeartbeatToolResponse(payload)?.response.notification).toEqual(notification);
    expect(payload.channelData?.openclawNotification).toEqual(notification);
  });

  it.each([
    null,
    {},
    { ...notification, expectedRevision: "" },
    { ...notification, invented: true },
  ])("rejects malformed supplied notification metadata rather than dropping it", (invalid) => {
    expect(
      normalizeHeartbeatToolResponse({
        outcome: "needs_attention",
        notify: true,
        summary: "A decision is ready.",
        notification: invalid,
      }),
    ).toBeUndefined();
  });
});

describe("heartbeat scratch proposal resolution", () => {
  it("lets a later heartbeat response clear an earlier scratch proposal", () => {
    const first = createHeartbeatToolResponsePayload({
      outcome: "progress",
      notify: false,
      summary: "first",
      scratch: "stale scratch",
    });
    const corrected = createHeartbeatToolResponsePayload({
      outcome: "no_change",
      notify: false,
      summary: "corrected",
    });

    const selected = expectDefined(
      selectHeartbeatToolResponse([first, corrected]),
      "expected the corrected heartbeat response",
    );
    expect(selected.response.summary).toBe("corrected");
    expect(getReplyPayloadMetadata(selected.payload)?.heartbeatScratchProposal).toBeUndefined();
  });
});
