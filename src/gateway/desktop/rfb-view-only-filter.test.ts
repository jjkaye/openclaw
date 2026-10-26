import { expect, it } from "vitest";
import { createRfbClientMessageFilter } from "./rfb-view-only-filter.js";

const VERSION = Buffer.from("RFB 003.008\n", "ascii");
const FRAMEBUFFER_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
const hex = (bytes: string) => Buffer.from(bytes, "hex");

function enterMessagePhase() {
  const filter = createRfbClientMessageFilter();
  const handshake = Buffer.concat([VERSION, Buffer.from([1, 1])]);
  expect(filter.filter(handshake)).toEqual({ forward: handshake });
  return filter;
}

it("forwards a complete VncAuth handshake byte-identically", () => {
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
  const handshake = Buffer.concat([VERSION, Buffer.of(2), auth, Buffer.of(1)]);
  expect(createRfbClientMessageFilter().filter(handshake)).toEqual({ forward: handshake });
});

it("filters fragmented input and preserves display/flow control", () => {
  const filter = enterMessagePhase();
  // Independent protocol fixtures: forwarding is expected only for display/flow control.
  const messages = [
    [hex("0401000000000041"), false], // KeyEvent
    [Buffer.alloc(20), true], // SetPixelFormat
    [hex("0501000a0014"), false], // PointerEvent
    [hex("0580000a001401"), false], // Extended PointerEvent
    [Buffer.concat([hex("02000018"), Buffer.alloc(96)]), true], // SetEncodings
    [hex("0600000000000003616263"), false], // ClientCutText
    [Buffer.concat([Buffer.of(251), Buffer.alloc(23)]), false], // SetDesktopSize
    [Buffer.concat([Buffer.of(255), Buffer.alloc(11)]), false], // QEMU key
    [FRAMEBUFFER_REQUEST, true],
    [hex("f8000000000000000100"), true], // ClientFence
    [hex("06000000fffffff80000000000000000"), false], // Extended clipboard
    [hex("96010000000000400040"), true], // EnableContinuousUpdates after skipped clipboard
  ] as const;
  const captured = Buffer.concat(messages.map(([bytes]) => bytes));
  const forwarded = Array.from(captured, (byte) => {
    const result = filter.filter(Buffer.of(byte));
    if ("error" in result) {
      throw new Error(result.error);
    }
    return result.forward;
  });
  expect(Buffer.concat(forwarded)).toEqual(
    Buffer.concat(messages.filter(([, forward]) => forward).map(([bytes]) => bytes)),
  );
});

it.each([
  [false, Buffer.concat([VERSION, Buffer.of(30)]), "unsupported RFB security type 30"],
  [true, Buffer.of(254), "unsupported RFB client message type 254"],
  [true, hex("0600000000010000"), "RFB client message exceeds the 64 KiB buffer limit"],
] as const)("fails closed (message phase: %s): %s -> %s", (messagePhase, frame, error) => {
  const filter = messagePhase ? enterMessagePhase() : createRfbClientMessageFilter();
  expect(filter.filter(frame)).toEqual({ error });
});
