import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { expect, it, vi } from "vitest";
import { buildHttpError, matrixEventToRaw, parseMxc } from "./event-helpers.js";

const content = { body: "original", msgtype: "m.text" };
function messageEvent(
  overrides: ConstructorParameters<typeof MatrixEvent>[0] = {},
  wire?: Record<string, unknown>,
) {
  const event = new MatrixEvent({ type: "m.room.message", content: { ...content }, ...overrides });
  if (wire) {
    event.makeEncrypted("m.room.encrypted", wire, "curve-key", "ed-key");
  }
  return event;
}

it("rejects non-mxc URIs", () => {
  expect(parseMxc("not-mxc")).toBeNull();
});

it("keeps truncated HTTP error bodies UTF-16 safe", () => {
  const parsedPrefix = `{"detail":"${"a".repeat(488)}`;
  const invalidPrefix = `not-json ${"b".repeat(490)}`;

  expect(buildHttpError(500, `${parsedPrefix}😀"}`).message).toBe(parsedPrefix);
  expect(buildHttpError(502, `${invalidPrefix}🎉tail`).message).toBe(invalidPrefix);
});

it("preserves reply-only wire relations for encrypted events with clear content", () => {
  const reply = { "m.in_reply_to": { event_id: "$parent" } };
  const event = messageEvent({}, { "m.relates_to": reply });

  const raw = matrixEventToRaw(event);
  expect(raw.content).toEqual({ ...content, "m.relates_to": reply });
  expect(raw).not.toHaveProperty("decryptionFailure");
});

it("preserves packed wire state keys when clear state is unavailable", () => {
  const event = messageEvent({ type: "m.room.member", state_key: "@alice:example.org" }, {});
  vi.spyOn(event, "getStateKey").mockReturnValue(undefined);

  expect(matrixEventToRaw(event).state_key).toBe("m.room.member:@alice:example.org");
});

it("can serialize original content for inbound trigger filtering", () => {
  const event = messageEvent();
  const edit = { body: "edited", msgtype: "m.text" };
  event.makeReplaced(messageEvent({ content: { "m.new_content": edit } }));
  expect(matrixEventToRaw(event, { contentMode: "original" }).content).toEqual(content);
});
