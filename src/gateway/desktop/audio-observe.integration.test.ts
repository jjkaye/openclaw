import { once } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import { handleDesktopAudioUpgrade } from "./audio-bridge.js";
import { closeServer, createSocketServer, listenLoopback } from "./desktop.test-support.js";
import { createHostDesktopService } from "./host-source.js";
import {
  handleDesktopObserveUpgrade,
  mintDesktopObserverToken,
  releaseDesktopObserverToken,
} from "./observe-bridge.js";
import { connectRfbObserver, RFB_VERSION as VERSION } from "./observe.test-support.js";
import { createDesktopSessionRegistry } from "./session-registry.js";
import { SocketReader } from "./socket-reader.test-support.js";

const FRAMEBUFFER_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
const httpServer = http.createServer();
let origin = "";
let registry: ReturnType<typeof createDesktopSessionRegistry>;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  httpServer.on("upgrade", (req, socket, head) => {
    if (!handleDesktopAudioUpgrade(req, socket, head)) {
      handleDesktopObserveUpgrade(req, socket, head, { registry });
    }
  });
  origin = "ws://127.0.0.1:" + (await listenLoopback(httpServer));
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.useRealTimers();
});
afterAll(() => closeServer(httpServer));
async function attach(path: string) {
  const socket = new WebSocket(origin + path);
  cleanups.push(async () => socket.terminate());
  await once(socket, "open");
  return socket;
}

it.each([
  "success",
  "rejected",
  "released",
  "expired",
  "stale-owner",
  "ard-success",
  "ard-rejected",
  "invalid security",
] as const)("gates audio and view-only display on screen authentication: %s", async (outcome) => {
  if (outcome === "expired") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  }
  const ard = outcome.startsWith("ard-") || outcome === "invalid security";
  const rejected = outcome.endsWith("rejected");
  const authenticated = createDeferred();
  const browserReady = createDeferred();
  const finishAuth = createDeferred();
  const script = createDeferred();
  let connections = 0;
  const { server } = createSocketServer(cleanups, (socket) => {
    const probe = ard && ++connections === 1;
    const reader = new SocketReader(socket);
    void (async () => {
      socket.write(ard ? Buffer.from("RFB 003.889\n") : VERSION);
      expect(await reader.readExactly(12)).toEqual(VERSION);
      socket.write(Buffer.from(ard ? [4, 30, 33, 36, 35] : [1, 2]));
      if (probe) {
        return;
      }
      expect(await reader.readExactly(1)).toEqual(Buffer.from([ard ? 30 : 2]));
      await browserReady.promise;
      if (ard) {
        // ARD: generator 5, 16-byte modulus 7919 and server public key 6817.
        const parameters = Buffer.from(
          "0005001000000000000000000000000000001eef00000000000000000000000000001aa1",
          "hex",
        );
        if (outcome === "invalid security") {
          parameters.writeUInt16BE(0, 2);
        }
        socket.write(parameters);
        if (outcome === "invalid security") {
          script.resolve();
          return;
        }
      } else {
        socket.write(Buffer.alloc(16, 1));
      }
      await reader.readExactly(ard ? 144 : 16);
      authenticated.resolve();
      await finishAuth.promise;
      const reason = Buffer.from("access denied for operator using account-password");
      const failure = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, reason.length]), reason]);
      socket.write(rejected ? failure : Buffer.alloc(4));
      if (!rejected) {
        expect(await reader.readExactly(1)).toEqual(Buffer.from([1]));
        socket.write(Buffer.from("server-init"));
        expect(await reader.readExactly(FRAMEBUFFER_REQUEST.length)).toEqual(FRAMEBUFFER_REQUEST);
      }
      script.resolve();
    })().catch(script.reject);
  });
  const port = await listenLoopback(server);
  const stopped = createDeferred();
  const pcm = new PassThrough();
  const stop = vi.fn(async () => {
    pcm.destroy();
    stopped.resolve();
  });
  const start = vi.fn(async (_signal: AbortSignal) => ({ stream: pcm, stop }));
  registry = createDesktopSessionRegistry();
  cleanups.push(() => registry.stopAll());
  if (!ard && outcome !== "stale-owner") {
    await registry.activate({ sourceKey: "host", ownerEpoch: 1 });
  }
  const requester = { connId: "audio-authorization-test", isCurrent: () => true };
  const credentials = { username: "operator", password: "account-password" };
  const observation = ard
    ? await createHostDesktopService({
        registry,
        getConfig: () => ({ enabled: true, port }),
      }).observe({ control: false, credentials })
    : mintDesktopObserverToken({
        sourceKey: "host",
        ownerEpoch: 1,
        control: false,
        attachment: { kind: "tcp", host: "127.0.0.1", port },
        preauth: { auth: "vnc-password", credentials },
        audio: { start },
        requester,
      });
  const screenPath =
    "token" in observation ? "/desktop/observe?token=" + observation.token : observation.wsPath;
  const audio = observation.audio ? await attach(observation.audio.wsPath) : undefined;
  const audioClosed = audio ? once(audio, "close") : undefined;
  const expectAudioDenied = async () => {
    await audioClosed;
    expect(start).not.toHaveBeenCalled();
  };
  audio?.send(JSON.stringify({ action: "start" }));
  if (outcome === "released") {
    expect(await releaseDesktopObserverToken(screenPath, requester)).toBe(true);
    return expectAudioDenied();
  }
  if (outcome === "expired") {
    vi.advanceTimersByTime(60_001);
    return expectAudioDenied();
  }
  if (outcome === "stale-owner") {
    await attach(screenPath);
    return expectAudioDenied();
  }
  const { ws, nextFrame, closed } = await connectRfbObserver(cleanups, origin + screenPath);
  const audioStarted = outcome === "success" && audio ? once(audio, "message") : undefined;
  browserReady.resolve();
  if (outcome !== "invalid security") {
    await authenticated.promise;
    expect(start).not.toHaveBeenCalled();
    finishAuth.resolve();
  }
  if (rejected || outcome === "invalid security") {
    const result = await closed;
    expect(result.code).toBe(outcome === "invalid security" ? 1011 : 1008);
    expect(result.reason).toMatch(
      outcome === "invalid security"
        ? /security negotiation failed; check .+ reconnect/u
        : ard
          ? /macOS denied desktop access; check .+ Observe\/Control permissions/u
          : /desktop VNC authentication rejected/u,
    );
    expect(Buffer.byteLength(result.reason)).toBeLessThanOrEqual(123);
    expect(result.reason).not.toContain(credentials.password);
    await script.promise;
    return expectAudioDenied();
  }
  expect(await nextFrame()).toEqual(Buffer.alloc(4));
  expect(await nextFrame()).toEqual(Buffer.from("server-init"));
  ws.send(Buffer.concat([Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), FRAMEBUFFER_REQUEST]));
  await script.promise;
  if (!audio) {
    return;
  }
  expect((await audioStarted)![0].toString()).toBe('{"state":"started"}');
  const received = once(audio, "message");
  const samples = Buffer.from([0, 1, 0, 2]);
  pcm.write(samples);
  expect(await received).toEqual([samples, true]);
  ws.close();
  await Promise.all([audioClosed, stopped.promise]);
  expect(pcm.destroyed).toBe(true);
  expect(start.mock.calls[0]?.[0].aborted).toBe(true);
});
