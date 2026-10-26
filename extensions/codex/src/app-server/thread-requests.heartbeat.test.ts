import { expect, it } from "vitest";
import {
  createThreadRequestAppServerOptions as createAppServerOptions,
  createThreadRequestAttemptParams as createAttemptParams,
} from "./thread-lifecycle.test-fixtures.js";
import { buildDeveloperInstructions } from "./thread-prompt.js";
import { buildThreadResumeParams, buildThreadStartParams } from "./thread-requests.js";

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
