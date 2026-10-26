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
import { createDesktopSessionRegistry, type DesktopSessionRegistry } from "./session-registry.js";
import { SocketReader } from "./socket-reader.test-support.js";

const FRAMEBUFFER_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
const httpServer = http.createServer();
let origin = "";
let registry: Pick<DesktopSessionRegistry, "attachObserver" | "claimStream">;
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
        const header = Buffer.from([0, 5, 0, outcome === "invalid security" ? 0 : 16]);
        const modulus = Buffer.alloc(16);
        modulus.writeUInt16BE(7919, 14);
        const serverPublic = Buffer.alloc(16);
        serverPublic.writeUInt16BE(6817, 14);
        socket.write(Buffer.concat([header, modulus, serverPublic]));
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
      const rejected = outcome.endsWith("rejected");
      const reason = Buffer.from("access denied for operator using account-password");
      const result = Buffer.alloc(rejected ? 8 : 4);
      if (rejected) {
        result.writeUInt32BE(1, 0);
        result.writeUInt32BE(reason.length, 4);
      }
      socket.write(rejected ? Buffer.concat([result, reason]) : result);
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
  const sessions = createDesktopSessionRegistry();
  cleanups.push(() => sessions.stopAll());
  registry = ard
    ? sessions
    : {
        claimStream: () => undefined,
        attachObserver: () => (outcome === "stale-owner" ? undefined : { release() {} }),
      };
  const requester = { connId: "audio-authorization-test", isCurrent: () => true };
  const credentials = { username: "operator", password: "account-password" };
  const host = ard
    ? await createHostDesktopService({
        registry: sessions,
        getConfig: () => ({ enabled: true, port }),
      }).observe({ control: false, credentials })
    : undefined;
  if (host) {
    expect(host.auth).toBe("ard-account");
    expect(host.vncPassword).toBeUndefined();
  }
  const grant = host
    ? undefined
    : mintDesktopObserverToken({
        sourceKey: "host",
        ownerEpoch: 1,
        control: false,
        attachment: { kind: "tcp", host: "127.0.0.1", port },
        preauth: { auth: "vnc-password", credentials },
        audio: { start },
        requester,
      });
  const audio = grant ? await attach(grant.audio!.wsPath) : undefined;
  const audioClosed = audio ? once(audio, "close") : undefined;
  const expectAudioDenied = async () => {
    await audioClosed;
    expect(start).not.toHaveBeenCalled();
  };
  audio?.send(JSON.stringify({ action: "start" }));
  if (outcome === "released") {
    expect(
      await releaseDesktopObserverToken("/desktop/observe?token=" + grant!.token, requester),
    ).toBe(true);
    return expectAudioDenied();
  }
  if (outcome === "expired") {
    vi.advanceTimersByTime(60_001);
    return expectAudioDenied();
  }
  const screenPath = host?.wsPath ?? "/desktop/observe?token=" + grant!.token;
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
  if (outcome.endsWith("rejected") || outcome === "invalid security") {
    const result = await closed;
    expect(result).toEqual({
      code: outcome === "invalid security" ? 1011 : 1008,
      reason:
        outcome === "invalid security"
          ? "desktop security negotiation failed; check the desktop service and reconnect"
          : ard
            ? "macOS denied desktop access; check credentials and Screen Sharing or Remote Management Observe/Control permissions"
            : "desktop VNC authentication rejected",
    });
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
    expect(connections).toBe(2);
    return;
  }
  expect((await audioStarted)![0].toString()).toBe('{"state":"started"}');
  expect(start).toHaveBeenCalledOnce();
  const received = once(audio, "message");
  const samples = Buffer.from([0, 1, 0, 2]);
  pcm.write(samples);
  expect(await received).toEqual([samples, true]);
  ws.close();
  await audioClosed;
  await stopped.promise;
  expect(pcm.destroyed).toBe(true);
  expect(stop).toHaveBeenCalledOnce();
  expect(start.mock.calls[0]?.[0].aborted).toBe(true);
});
