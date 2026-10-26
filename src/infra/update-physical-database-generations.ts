import { readBackupEngineImage } from "./database-engine/physical-store.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { readUpdateDatabaseGenerationPair } from "./update-database-generations.js";

export async function readUpdatePhysicalDatabaseGenerations(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
) {
  return (await readUpdatePhysicalDatabaseGenerationPair(paths, pluginOwners)).committed;
}

export async function readUpdatePhysicalDatabaseGenerationPair(
  paths: readonly string[],
  pluginOwners?: DatabasePortPluginOwners,
) {
  const postgres: string[] = [];
  // Classify the captured image without reacquiring the live source family.
  const result = readUpdateDatabaseGenerationPair(paths, (imagePath, sourcePath) => {
    if (readBackupEngineImage(imagePath, sourcePath).engine === "postgres") {
      postgres.push(sourcePath);
    }
  });
  if (postgres.length) {
    const { fingerprintPostgresBackup } = await import("../snapshot/database-backup.js");
    const { createConfigIO } = await import("../config/io.js");
    const { config } = await createConfigIO({
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    for (const pathname of postgres) {
      result.committed[pathname] = result.physical[pathname] = await fingerprintPostgresBackup(
        pathname,
        config,
        pluginOwners,
      );
    }
  }
  return result;
}

/** Only the recorded 9.33-line parent sends an unmarked restore inspection. */
export async function isLegacyUpdateGenerationRequest(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { findActiveUpdateRun } = await import("./update-run-reader.js");
  const { readUpdateRunDriver, sameUpdateRunDriver } = await import("./update-run-driver.js");
  const run = findActiveUpdateRun({ env });
  if (run?.status !== "running" || !["2026.9.33", "2026.9.34"].includes(run.before.version ?? "")) {
    return false;
  }
  const parent = readUpdateRunDriver(process.ppid);
  return (
    parent !== undefined &&
    [run.origin.driver, ...(run.origin.previousDrivers ?? [])].some(
      (driver) => driver && sameUpdateRunDriver(driver, parent),
    )
  );
}
