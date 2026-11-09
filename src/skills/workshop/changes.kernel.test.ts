import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { listWorkshopChangesInDatabase, recordWorkshopChangeInDatabase } from "./changes.kernel.js";

it("preserves older changes beyond 500 while keeping history queries bounded", () => {
  const db = new DatabaseSync(":memory:");
  const database: OpenClawStateDatabase = {
    db,
    path: ":memory:",
    get walMaintenance() {
      throw new Error("This in-memory kernel test must not request WAL maintenance.");
    },
  };
  try {
    for (let index = 0; index < 501; index += 1) {
      recordWorkshopChangeInDatabase(database, {
        id: `change-${index}`,
        agentId: "main",
        skillName: "deploy",
        action: "patch",
        actor: "user",
        summary: `Change ${index}`,
        runId: index === 0 ? "oldest-run" : "later-run",
        createdAtMs: index,
      });
    }
    expect(listWorkshopChangesInDatabase(db, { agentId: "main", limit: 501 })).toHaveLength(501);
    expect(
      listWorkshopChangesInDatabase(db, { agentId: "main", limit: 2 }).map((row) => row.id),
    ).toEqual(["change-500", "change-499"]);
    expect(
      listWorkshopChangesInDatabase(db, { agentId: "main", limit: 1, runId: "oldest-run" }),
    ).toMatchObject([{ id: "change-0", summary: "Change 0" }]);
    expect(
      listWorkshopChangesInDatabase(db, { agentId: "main", limit: 2, beforeMs: 2 }).map((row) => row.id),
    ).toEqual(["change-1", "change-0"]);
    expect(listWorkshopChangesInDatabase(db, { agentId: "other", limit: 1 })).toEqual([]);
  } finally {
    db.close();
  }
});
