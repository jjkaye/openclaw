import fs from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { expect, it, type TestContext } from "vitest";
import { createDeferred, withTestTimeout } from "./promise.js";
import { runQaGatewayTestFixture } from "./qa-gateway-test-lifetime.js";

const record = (events: string[], event: string) => () => events.push(event);

function testOwner(signal: AbortSignal, events: string[] = []) {
  let cleanup!: Parameters<TestContext["onTestFinished"]>[0];
  return {
    context: {
      signal,
      onTestFinished: (hook: typeof cleanup) => {
        events.push("registered");
        cleanup = hook;
      },
    },
    finish: async (context: TestContext) => cleanup(context),
  };
}

it("joins the actual cancelled body and ordered cleanup before finishing the test", async (context) => {
  const controller = new AbortController();
  const reason = new Error("test cancelled");
  const events: string[] = [];
  const owner = testOwner(controller.signal, events);
  const bodyEntered = createDeferred();
  const gatewayCleanup = createDeferred();
  const releaseCleanup = createDeferred();
  let scratch: string | undefined;
  const run = runQaGatewayTestFixture(
    owner.context,
    async ({ signal, createTempDir }) => {
      scratch = createTempDir("qa-gateway-test-work-");
      events.push("body");
      bodyEntered.resolve();
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(reason), { once: true });
        });
      } finally {
        events.push("body-settled");
      }
    },
    record(events, "client"),
    async () => {
      events.push("gateway-start");
      gatewayCleanup.resolve();
      await releaseCleanup.promise;
      events.push("gateway-end");
    },
    record(events, "provider"),
  );
  const outcome = run.catch((error: unknown) => error);
  let finishing: Promise<void> | undefined;
  let finished = false;
  try {
    await withTestTimeout(bodyEntered.promise, 1_000, "fixture body did not start");
    expect(events).toEqual(["registered", "body"]);
    controller.abort(reason);
    await withTestTimeout(gatewayCleanup.promise, 1_000, "fixture did not enter cleanup");
    finishing = owner.finish(context).then(() => {
      finished = true;
    });
    await setImmediate();
    expect(finished).toBe(false);
    await expect(fs.stat(scratch!)).resolves.toBeDefined();
    const beforeRelease = ["registered", "body", "body-settled", "client", "gateway-start"];
    expect(events).toEqual(beforeRelease);
    releaseCleanup.resolve();
    expect(await outcome).toBe(reason);
    await finishing;
    await expect(fs.stat(scratch!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events).toEqual([...beforeRelease, "gateway-end", "provider"]);
  } finally {
    controller.abort(reason);
    releaseCleanup.resolve();
    await outcome;
    await finishing;
    await owner.finish(context);
  }
});

it("refuses an already-cancelled body", async (context) => {
  const reason = new Error("cancelled before body admission");
  let entered = false;
  const cancelledOwner = testOwner(AbortSignal.abort(reason));
  await expect(
    runQaGatewayTestFixture(cancelledOwner.context, async () => {
      entered = true;
    }),
  ).rejects.toBe(reason);
  expect(entered).toBe(false);
  await cancelledOwner.finish(context);
});
