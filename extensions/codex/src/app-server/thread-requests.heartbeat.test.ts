import { expect, it } from "vitest";
import type { CodexDynamicToolSpec } from "./protocol.js";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";

it.each([false, true])(
  "keeps heartbeat monitoring inline with sessions_send available=%s",
  (hasSessionsSend) => {
    const params = Object.assign(createAttemptParams({ provider: "openai" }), {
      trigger: "heartbeat" as const,
    });
    const dynamicTools: CodexDynamicToolSpec[] = hasSessionsSend
      ? [
          {
            type: "function",
            name: "sessions_send",
            description: "Send to an existing session",
            inputSchema: { type: "object" },
          },
        ]
      : [];
    const options = { appServer: createAppServerOptions(), dynamicTools };
    const requests = [
      buildThreadStartParams(params, { ...options, cwd: "/workspace" }),
      buildThreadResumeParams(params, { ...options, threadId: "existing-thread" }),
    ];
    for (const request of requests) {
      expect(request.config).toMatchObject({
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      });
      expect(request.developerInstructions).not.toContain("`spawn_agent`");
      if (hasSessionsSend) {
        expect(request.developerInstructions).toContain(
          "Do not spawn agents, yield, wait for background completion, or transfer this heartbeat's outcome to another run.",
        );
        expect(request.developerInstructions).toContain(
          "When the caller has already authorized and verified an existing ordinary execution owner",
        );
        expect(request.developerInstructions).toContain("timeoutSeconds: 0");
        expect(request.developerInstructions).toContain(
          "record acceptance without claiming start or completion",
        );
        expect(request.developerInstructions).toContain("finish with `heartbeat_respond`");
        expect(request.developerInstructions).toContain(
          "Verify returned work in a later ordinary result turn or the next authorized wake.",
        );
        expect(request.developerInstructions).toContain(
          "Tool availability alone grants no authority.",
        );
      } else {
        expect(request.developerInstructions).toContain(
          "Finish this heartbeat check inline and record its outcome in this turn.",
        );
        expect(request.developerInstructions).not.toContain("timeoutSeconds: 0");
        expect(request.developerInstructions).not.toContain("record acceptance");
      }
    }
  },
);

it("disables native heartbeat delegation for only the heartbeat turn", () => {
  for (const trigger of ["heartbeat", "user"] as const) {
    const params = Object.assign(createAttemptParams({ provider: "openai" }), { trigger });
    const request = buildThreadStartParams(params, {
      appServer: createAppServerOptions(),
      cwd: "/workspace",
      dynamicTools: [],
    });
    if (trigger === "heartbeat") {
      expect(request.config).toMatchObject({
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      });
      expect(
        buildThreadResumeParams(params, {
          appServer: createAppServerOptions(),
          threadId: "existing-thread",
        }).config,
      ).toMatchObject({
        "agents.enabled": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
      });
      expect(buildDeveloperInstructions(params)).not.toContain("`spawn_agent`");
    } else {
      expect(request.config).not.toHaveProperty("features.multi_agent", false);
      expect(buildDeveloperInstructions(params)).toContain("`spawn_agent`");
    }
  }
});
