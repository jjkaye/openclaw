import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { projectOperatorApprovalSnapshot } from "./operator-approval-snapshot.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
  pruneTerminalOperatorApprovals,
  readPluginApprovalReceipts,
} from "./operator-approval-store.js";
import { createOperatorApprovalStoreFixture } from "./operator-approval-store.test-support.js";
type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
const { approval, getOperatorApproval, getSuiteDatabaseOptions } =
  createOperatorApprovalStoreFixture();

describe("canonical plugin approval receipts", () => {
  it("retains the originating plugin and immutable assent scope across storage", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    const pluginBinding = {
      version: 1,
      pluginId: "test-plugin",
      scope: {
        generation: "week-preview-1",
        digest: "a".repeat(64),
        validFromMs: 900,
        validUntilMs: 9_000,
      },
      intent: "approve",
      actor: null,
    } as const;
    const input = { ...approval("plugin:bound-scope", { kind: "plugin" }), pluginBinding };
    await insertOperatorApproval({ approval: input, databaseOptions });
    await expect(
      getOperatorApproval({ id: input.id, nowMs: 2_000, databaseOptions }),
    ).resolves.toMatchObject({ status: "pending", pluginBinding });
  });

  it("rejects changed bindings under one request id and keeps private assent out of public snapshots", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    const pluginBinding = {
      version: 1 as const,
      pluginId: "test-plugin",
      scope: {
        generation: "week-1",
        digest: "a".repeat(64),
        validFromMs: 900,
        validUntilMs: 9_000,
      },
      intent: "approve" as const,
      actor: null,
    };
    const input = approval("plugin:immutable", { kind: "plugin", pluginBinding });
    await insertOperatorApproval({ approval: input, databaseOptions });
    await expect(
      insertOperatorApproval({ approval: input, databaseOptions }),
    ).resolves.toMatchObject({ outcome: "existing" });
    await expect(
      insertOperatorApproval({
        approval: { ...input, pluginBinding: { ...pluginBinding, intent: "revoke" } },
        databaseOptions,
      }),
    ).resolves.toEqual({ outcome: "conflict" });
    const record = await getOperatorApproval({ id: input.id, nowMs: 2_000, databaseOptions });
    expect(record).not.toBeNull();
    const snapshot = projectOperatorApprovalSnapshot(record!, "");
    expect(snapshot).not.toHaveProperty("pluginBinding");
    expect(JSON.stringify(snapshot)).not.toContain(pluginBinding.scope.digest);
    for (const invalid of [
      { ...pluginBinding, version: 2 },
      { ...pluginBinding, pluginId: "other-plugin" },
      { ...pluginBinding, scope: { ...pluginBinding.scope, validFromMs: 1_001 } },
      {
        ...pluginBinding,
        scope: { ...pluginBinding.scope, validUntilMs: Number.MAX_SAFE_INTEGER + 1 },
      },
    ]) {
      await expect(
        insertOperatorApproval({
          approval: {
            ...input,
            id: "plugin:invalid",
            pluginBinding: invalid as typeof pluginBinding,
          },
          databaseOptions,
        }),
      ).rejects.toThrow(/binding/u);
    }
  });

  it("reads distinct canonical actors after reopen using the protected original source scope", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    const scope = {
      generation: "week-1",
      digest: "a".repeat(64),
      validFromMs: 900,
      validUntilMs: 9_000,
    };
    for (const [index, senderId] of ["+15550000001", "+15550000002"].entries()) {
      const input = approval(`plugin:owner-${index}`, {
        kind: "plugin",
        pluginBinding: {
          version: 1,
          pluginId: "test-plugin",
          scope,
          intent: "approve",
          actor: null,
        },
      });
      await insertOperatorApproval({ approval: input, databaseOptions });
      await resolveOperatorApproval({
        id: input.id,
        decision: "allow-once",
        resolver: { kind: "channel", id: "imessage:household" },
        verifiedPluginActor: {
          channel: "imessage",
          accountId: "household",
          senderId,
          conversationId: "chat_id:42",
        },
        nowMs: 2_000 + index,
        databaseOptions,
      });
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const query = {
      agentId: "main",
      sessionKey: "agent:main:child",
      pluginId: "test-plugin",
      scope,
      nowMs: 3_000,
      databaseOptions,
    };
    const receipts = await readPluginApprovalReceipts(query);
    expect(receipts.outcome).toBe("complete");
    if (receipts.outcome !== "complete") {
      throw new Error("expected complete canonical receipt read");
    }
    expect(receipts.receipts.map((receipt) => receipt.actor?.senderId)).toEqual([
      "+15550000001",
      "+15550000002",
    ]);
    for (const override of [
      { sessionKey: "agent:main:other" },
      { agentId: "other" },
      { pluginId: "other-plugin" },
    ]) {
      await expect(readPluginApprovalReceipts({ ...query, ...override })).resolves.toEqual({
        outcome: "complete",
        receipts: [],
      });
    }
  });

  it("keeps the first native actor with the terminal verdict, including conflicting retries", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    const input = approval("plugin:native-actor", {
      kind: "plugin",
      pluginBinding: {
        version: 1,
        pluginId: "test-plugin",
        scope: {
          generation: "week-preview-1",
          digest: "a".repeat(64),
          validFromMs: 900,
          validUntilMs: 9_000,
        },
        intent: "approve",
        actor: null,
      },
    });
    await insertOperatorApproval({ approval: input, databaseOptions });
    const actor = {
      channel: "imessage",
      accountId: "household",
      senderId: "+15550000001",
      conversationId: "chat_id:42",
    };
    const resolution = {
      id: input.id,
      decision: "allow-once" as const,
      resolver: { kind: "channel" as const, id: "imessage:household" },
      verifiedPluginActor: actor,
      nowMs: 2_000,
      databaseOptions,
    };
    await expect(resolveOperatorApproval(resolution)).resolves.toMatchObject({
      outcome: "resolved",
      record: { pluginBinding: { actor } },
    });
    await expect(
      resolveOperatorApproval({
        ...resolution,
        verifiedPluginActor: { ...actor, senderId: "+15550000002" },
        decision: "deny",
        nowMs: 2_001,
      }),
    ).resolves.toMatchObject({
      outcome: "already-resolved",
      retry: "conflict",
      record: { decision: "allow-once", pluginBinding: { actor } },
    });
    await expect(
      getOperatorApproval({ id: input.id, nowMs: 2_002, databaseOptions }),
    ).resolves.toMatchObject({ status: "allowed", pluginBinding: { actor } });
  });

  it("reads pending scope facts and holds when unrelated interval rows exceed the receipt bound", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    const scope = {
      generation: "week-preview-1",
      digest: "a".repeat(64),
      validFromMs: 900,
      validUntilMs: 9_000,
    };
    await insertOperatorApproval({
      approval: approval("plugin:pending-assent", {
        kind: "plugin",
        pluginBinding: {
          version: 1,
          pluginId: "test-plugin",
          scope,
          intent: "approve",
          actor: null,
        },
      }),
      databaseOptions,
    });
    const query = {
      agentId: "main",
      sessionKey: "agent:main:child",
      pluginId: "test-plugin",
      scope,
      nowMs: 2_000,
      databaseOptions,
    };
    await expect(readPluginApprovalReceipts(query)).resolves.toEqual({
      outcome: "complete",
      receipts: [
        {
          id: "plugin:pending-assent",
          status: "pending",
          decision: null,
          terminalReason: null,
          createdAtMs: 1_000,
          resolvedAtMs: null,
          intent: "approve",
          actor: null,
        },
      ],
    });
    for (let index = 0; index < 128; index++) {
      await insertOperatorApproval({
        approval: approval(`unrelated-exec-${index}`),
        databaseOptions,
      });
    }
    await expect(readPluginApprovalReceipts(query)).resolves.toEqual({
      outcome: "held",
      reason: "overflow",
    });
  });

  it("refuses shortened retention that could erase still-valid plugin assent", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    const input = approval("plugin:retained-assent", {
      kind: "plugin",
      pluginBinding: {
        version: 1,
        pluginId: "test-plugin",
        scope: {
          generation: "week-1",
          digest: "a".repeat(64),
          validFromMs: 900,
          validUntilMs: 9_000,
        },
        intent: "approve",
        actor: null,
      },
    });
    await insertOperatorApproval({ approval: input, databaseOptions });
    await resolveOperatorApproval({
      id: input.id,
      decision: "allow-once",
      resolver: { kind: "channel", id: "imessage:household" },
      verifiedPluginActor: {
        channel: "imessage",
        accountId: "household",
        senderId: "+15550000001",
        conversationId: "chat_id:42",
      },
      nowMs: 2_000,
      databaseOptions,
    });
    expect(() =>
      pruneTerminalOperatorApprovals({
        nowMs: 5_000,
        retentionMs: 1_000,
        databaseOptions,
      }),
    ).toThrow(/retention/u);
    await expect(
      getOperatorApproval({ id: input.id, nowMs: 5_000, databaseOptions }),
    ).resolves.toMatchObject({ status: "allowed" });
  });

  it("holds on unknown interval provenance and expiry while legacy rows confer no assent", async () => {
    const databaseOptions = getSuiteDatabaseOptions();
    await insertOperatorApproval({ approval: approval("legacy-exec"), databaseOptions });
    const query = {
      agentId: "main",
      sessionKey: "agent:main:child",
      pluginId: "test-plugin",
      scope: {
        generation: "week-1",
        digest: "a".repeat(64),
        validFromMs: 900,
        validUntilMs: 9_000,
      },
      nowMs: 2_000,
      databaseOptions,
    };
    await expect(readPluginApprovalReceipts(query)).resolves.toEqual({
      outcome: "complete",
      receipts: [],
    });
    runOpenClawStateWriteTransaction((database) => {
      const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("operator_approvals")
          .set({ plugin_binding_json: '{"version":2}' })
          .where("approval_id", "=", "legacy-exec"),
      );
    }, databaseOptions);
    await expect(readPluginApprovalReceipts(query)).resolves.toEqual({
      outcome: "held",
      reason: "corrupt",
    });
    await expect(readPluginApprovalReceipts({ ...query, nowMs: 9_000 })).resolves.toEqual({
      outcome: "held",
      reason: "expired",
    });
    await expect(
      readPluginApprovalReceipts({
        ...query,
        scope: { ...query.scope, validUntilMs: 900 + 30 * 24 * 60 * 60_000 },
      }),
    ).resolves.toEqual({ outcome: "held", reason: "invalid-scope" });
  });
});
