// Private canonical receipt query. Only the shared-state read worker calls this kernel.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isPluginApprovalScope } from "./operator-approval-plugin-binding.js";
import {
  OPERATOR_APPROVAL_TERMINAL_RETENTION_MS,
  OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS,
  isValidTimestamp,
  decodeOperatorApprovalRow,
} from "./operator-approval-store.rows.js";
import type {
  OperatorApprovalDatabase,
  PluginApprovalReceipt,
  ReadPluginApprovalReceiptsInput,
  ReadPluginApprovalReceiptsResult,
} from "./operator-approval-store.types.js";

/** Count and decode the complete raw interval before selecting this plugin's facts. */
export function readPluginApprovalReceiptsInDatabase(
  input: ReadPluginApprovalReceiptsInput,
  db: DatabaseSync,
): ReadPluginApprovalReceiptsResult {
  const nowMs = input.nowMs ?? Date.now();
  if (
    ![input.agentId, input.sessionKey, input.pluginId].every(
      (value) => typeof value === "string" && value.length > 0 && value.trim() === value,
    ) ||
    !isPluginApprovalScope(input.scope, OPERATOR_APPROVAL_TERMINAL_RETENTION_MS) ||
    !isValidTimestamp(nowMs) ||
    nowMs < input.scope.validFromMs
  ) {
    return { outcome: "held", reason: "invalid-scope" };
  }
  if (nowMs >= input.scope.validUntilMs) {
    return { outcome: "held", reason: "expired" };
  }
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
  const rows = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("operator_approvals")
      .selectAll()
      .where("source_agent_id", "=", input.agentId)
      .where("source_session_key", "=", input.sessionKey)
      .where("created_at_ms", ">=", input.scope.validFromMs)
      .where("created_at_ms", "<=", input.scope.validUntilMs)
      .orderBy("created_at_ms", "asc")
      .orderBy("approval_id", "asc")
      .limit(OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS + 1),
  ).rows;
  if (rows.length > OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS) {
    return { outcome: "held", reason: "overflow" };
  }
  const decoded = rows.map(decodeOperatorApprovalRow);
  const receipts: PluginApprovalReceipt[] = [];
  for (const record of decoded) {
    if (!record) {
      return { outcome: "held", reason: "corrupt" };
    }
    const binding = record.pluginBinding;
    if (
      !binding ||
      binding.pluginId !== input.pluginId ||
      binding.scope.generation !== input.scope.generation ||
      binding.scope.digest !== input.scope.digest ||
      binding.scope.validFromMs !== input.scope.validFromMs ||
      binding.scope.validUntilMs !== input.scope.validUntilMs
    ) {
      continue;
    }
    receipts.push({
      id: record.id,
      status: record.status,
      decision: record.decision,
      terminalReason: record.terminalReason,
      createdAtMs: record.createdAtMs,
      resolvedAtMs: record.resolvedAtMs,
      intent: binding.intent,
      actor: binding.actor,
    });
  }
  return (input.nowMs ?? Date.now()) >= input.scope.validUntilMs
    ? { outcome: "held", reason: "expired" }
    : { outcome: "complete", receipts };
}
