import { beforeAll, beforeEach, expect, it } from "vitest";
import { hoisted } from "./sessions-spawn-tool.mocks.test-support.js";

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
beforeAll(async () => {
  ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
});
beforeEach(() => {
  hoisted.spawnSubagentDirectMock.mockReset();
  hoisted.spawnAcpDirectMock.mockReset();
  hoisted.registerSubagentRunMock.mockReset();
  hoisted.inProcessCreationMock.mockReset();
});

it.each(["subagent", "acp"])(
  "refuses heartbeat %s delegation before creating a child",
  async (runtime) => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      trigger: "heartbeat",
      config: {},
    });
    const result = await tool.execute("heartbeat-spawn", {
      task: "Check synthetic fixture",
      runtime,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("heartbeat"),
    });
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.inProcessCreationMock).not.toHaveBeenCalled();
  },
);
