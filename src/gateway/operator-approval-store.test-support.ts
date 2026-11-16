import { afterAll, beforeEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { insertOperatorApproval, getOperatorApprovalDetailed } from "./operator-approval-store.js";
type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

/** Each file owns a separate temporary database; workers are reused only within that file. */
export function createOperatorApprovalStoreFixture() {
  async function getOperatorApproval(params: Parameters<typeof getOperatorApprovalDetailed>[0]) {
    const result = await getOperatorApprovalDetailed(params);
    return result.outcome === "found" ? result.record : null;
  }

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let suiteDatabaseOptions: OpenClawStateDatabaseOptions | undefined;

  function createDatabaseOptions(): OpenClawStateDatabaseOptions {
    const stateDir = tempDirs.make("openclaw-operator-approval-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  }

  function getSuiteDatabaseOptions(): OpenClawStateDatabaseOptions {
    return (suiteDatabaseOptions ??= createDatabaseOptions());
  }

  function approval(id: string, overrides: Partial<NewOperatorApproval> = {}): NewOperatorApproval {
    const kind = overrides.kind ?? overrides.presentation?.kind ?? "exec";
    const presentation: NewOperatorApproval["presentation"] =
      overrides.presentation ??
      (kind === "exec"
        ? {
            kind: "exec" as const,
            commandText: `echo ${id}`,
            commandPreview: `echo ${id}`,
            warningText: null,
            host: "gateway",
            nodeId: null,
            agentId: "main",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          }
        : {
            kind: "plugin" as const,
            title: "Approve plugin action",
            description: `Allow the plugin action for ${id}.`,
            severity: "warning" as const,
            pluginId: "test-plugin",
            toolName: "test-tool",
            agentId: "main",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          });
    return {
      id,
      kind,
      presentation,
      requester: {
        deviceId: "request-device",
        clientId: "request-client",
        deviceTokenAuth: true,
      },
      reviewerDeviceIds: ["reviewer-b", "reviewer-a", "reviewer-b"],
      source: {
        agentId: "main",
        sessionKey: "agent:main:child",
        sessionId: "session-1",
        runId: "run-1",
        toolCallId: "tool-call-1",
        toolName: "exec",
      },
      audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
      runtimeEpoch: "runtime-a",
      createdAtMs: 1_000,
      expiresAtMs: 10_000,
      ...overrides,
    };
  }

  function rawApprovalRow(options: OpenClawStateDatabaseOptions, id: string) {
    const database = openOpenClawStateDatabase(options);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    return executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
    );
  }

  beforeEach(() => {
    if (!suiteDatabaseOptions) {
      return;
    }
    // Completed cases leave workers reusable; only their approval rows are isolated.
    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
      executeSqliteQuerySync(database.db, stateDb.deleteFrom("operator_approvals"));
    }, suiteDatabaseOptions);
  });

  return {
    approval,
    getOperatorApproval,
    getSuiteDatabaseOptions,
    createDatabaseOptions,
    rawApprovalRow,
  };
}
