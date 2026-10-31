import { describe, expect, it } from "vitest";
import {
  selectHeartbeatToolResponse,
  type HeartbeatToolResponse,
} from "../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { createApplyPatchTool } from "./apply-patch.js";
import { createMemoryPatchSandbox } from "./apply-patch.test-support.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { markToolExecutionNotStarted } from "./tool-effect-receipt.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

async function captureFailure(tool: ReturnType<typeof createApplyPatchTool>, input: string) {
  try {
    await tool.execute("patch", { input }, undefined);
  } catch (error) {
    return error;
  }
  throw new Error("Expected patch failure");
}

function observeHeartbeat(error: unknown, response?: HeartbeatToolResponse) {
  const observe = createToolTerminalObserver("patch-heartbeat");
  observe({ toolName: "apply_patch", outcome: "failure", result: error });
  const terminal = observe({ toolName: "read", outcome: "success", result: {} });
  const payloads = buildEmbeddedRunPayloads({
    sessionKey: "agent:fixture-agent:main:heartbeat",
    assistantTexts: [],
    lastAssistant: undefined,
    isHeartbeatTrigger: true,
    lastToolError: terminal.lastToolError,
    heartbeatToolResponse: response ?? {
      outcome: "no_change",
      notify: false,
      summary: "Independent review finished.",
    },
  });
  return { terminal, payloads };
}

describe("apply_patch effect boundary consumed by heartbeat", () => {
  it.each(["outside root", "unmatched hunk"])(
    "keeps %s refusal from becoming an uncertain mutation",
    async (kind) => {
      const sandbox = createMemoryPatchSandbox({ "note.md": "before\n" });
      if (kind === "outside root") {
        sandbox.bridge.resolvePath = ({ filePath }) => ({
          relativePath: filePath,
          containerPath: `/sandbox/${filePath}`,
          hostPath: "/etc/outside.md",
        });
      }
      const input =
        kind === "outside root"
          ? "*** Begin Patch\n*** Add File: /outside/note.md\n+new\n*** End Patch"
          : "*** Begin Patch\n*** Update File: note.md\n@@\n-missing\n+after\n*** End Patch";
      const error = await captureFailure(createApplyPatchTool(sandbox.options), input);
      const { terminal, payloads } = observeHeartbeat(error);
      expect(terminal.lastToolError).toMatchObject({
        toolName: "apply_patch",
        executionStarted: false,
        mutatingAction: false,
      });
      expect(sandbox.writeFile).not.toHaveBeenCalled();
      expect(sandbox.createFileExclusive).not.toHaveBeenCalled();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.text).toBe("HEARTBEAT_OK");
      expect(getReplyPayloadMetadata(payloads[0]!)?.heartbeatTerminalToolFailure).toBeUndefined();
    },
  );

  it("preserves a source-backed notification after a no-effect patch refusal", async () => {
    const sandbox = createMemoryPatchSandbox({ "note.md": "before\n" });
    const error = await captureFailure(
      createApplyPatchTool(sandbox.options),
      "*** Begin Patch\n*** Update File: note.md\n@@\n-missing\n+after\n*** End Patch",
    );
    const response: HeartbeatToolResponse = {
      outcome: "progress",
      notify: true,
      summary: "Independent work prepared.",
      notificationText: "Your draft is ready.",
      notification: {
        sourceId: "native-tasks",
        ownerId: "task-1",
        topicId: "result",
        purpose: "result",
        expectedRevision: "revision-1",
      },
    };
    const { payloads } = observeHeartbeat(error, response);
    expect(selectHeartbeatToolResponse(payloads)?.response).toEqual(response);
    expect(payloads[0]?.text).toBe(response.notificationText);
    expect(getReplyPayloadMetadata(payloads[0]!)?.heartbeatTerminalToolFailure).toBeUndefined();
  });

  it("retains a partial mutation even when a later file operation reports no start", async () => {
    const sandbox = createMemoryPatchSandbox();
    sandbox.createFileExclusive
      .mockImplementationOnce(async ({ filePath, data }) => {
        sandbox.files.set(filePath, data);
        return "created";
      })
      .mockRejectedValueOnce(markToolExecutionNotStarted(new Error("second file refused")));
    const input =
      "*** Begin Patch\n*** Add File: first.md\n+saved\n*** Add File: second.md\n+unsaved\n*** End Patch";
    const error = await captureFailure(createApplyPatchTool(sandbox.options), input);
    const { terminal, payloads } = observeHeartbeat(error);
    expect([...sandbox.files.values()].some((value) => String(value) === "saved\n")).toBe(true);
    expect(terminal.lastToolError).toMatchObject({
      toolName: "apply_patch",
      executionStarted: true,
      mutatingAction: true,
    });
    expect(
      payloads.some(
        (payload) =>
          getReplyPayloadMetadata(payload)?.heartbeatTerminalToolFailure?.toolName ===
          "apply_patch",
      ),
    ).toBe(true);
  });
});
