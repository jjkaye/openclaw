import type { DatabaseSync } from "node:sqlite";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import { createAgentDatabaseDeletionClassifier } from "../state/agent-deletion-discovery.js";
import { readRetainedAgentDeletionsFromDatabase } from "../state/agent-deletion-journal.read.js";
import { readRegisteredAgentDatabaseRows } from "../state/openclaw-agent-db-registry.read.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";

/** Released updaters compare exact response paths, so every raw alias is published. */
export function publishStateDatabaseVersions(
  files: Map<string, StateDatabaseDiscovery>,
  inspected: Map<string, Omit<UpdateStateSchemaVersion, "path">>,
): UpdateStateSchemaVersion[] {
  const versions: UpdateStateSchemaVersion[] = [];
  for (const [identity, discovery] of files) {
    const result = inspected.get(identity);
    if (!result) {
      continue;
    }
    for (const spelling of discovery.spellings) {
      versions.push({ path: spelling, ...result });
    }
  }
  return versions;
}

/** Candidate-only classification from the exact private shared-state generation. */
export function readRetainedUpdateAgentPaths(params: {
  db: DatabaseSync;
  sharedPath: string;
  paths: readonly string[];
  stateDir: string;
  config: OpenClawConfigWithLegacyRoster;
  env?: NodeJS.ProcessEnv;
}): string[] | undefined {
  const retainedDeletions = readRetainedAgentDeletionsFromDatabase(params.db, params.sharedPath);
  // Unknown history and older workers grant no migration exemption.
  if (retainedDeletions.status !== "present") {
    return undefined;
  }
  const env = { ...params.env, OPENCLAW_STATE_DIR: params.stateDir };
  const registeredAgentDatabases = readRegisteredAgentDatabaseRows(
    params.db,
    params.sharedPath,
    false,
  );
  const classifyDeletion = createAgentDatabaseDeletionClassifier({
    env,
    retainedDeletions,
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(params.config, {
      env,
      registeredDatabases: registeredAgentDatabases,
    }),
    registeredAgentDatabases,
  });
  return params.paths.filter(
    (pathname) => pathname !== params.sharedPath && Boolean(classifyDeletion(pathname)),
  );
}
