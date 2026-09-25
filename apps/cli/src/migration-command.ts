import { readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  applyLegacyMigration,
  LegacyMigrationError,
  parseLegacyMigrationPlan,
  planLegacyMigration,
  rollbackLegacyMigration,
  type LegacySourceSpec,
} from "../../../packages/legacy-migration/src/index.js";
import type { CliIo } from "./index.js";

class MigrationCommandInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MigrationCommandInputError";
  }
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new MigrationCommandInputError("CLI_OPTION_REQUIRED", `${name} is required`);
  }
  return value;
}

function strictJson(path: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new MigrationCommandInputError(
      "INPUT_UTF8_INVALID",
      `Migration plan must be readable UTF-8: ${basename(path)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new MigrationCommandInputError(
      "INPUT_JSON_INVALID",
      `Migration plan is not valid JSON: ${basename(path)}`,
    );
  }
}

function sourceSpec(args: readonly string[]): LegacySourceSpec {
  const kind = requiredOption(args, "--kind");
  const sourcePath = requiredOption(args, "--source");
  if (kind === "manifest") return { kind, projectPath: sourcePath };
  if (kind === "desktop_v0_1") {
    return {
      kind,
      databasePath: sourcePath,
      artifactsRoot: requiredOption(args, "--artifacts-root"),
    };
  }
  throw new MigrationCommandInputError(
    "CLI_MIGRATION_KIND_INVALID",
    "--kind must be manifest or desktop_v0_1",
  );
}

export async function runMigrationCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const action = args[1];
  if (action === "scan") {
    const plan = planLegacyMigration({
      source: sourceSpec(args),
      targetWorkspacePath: requiredOption(args, "--workspace"),
    });
    io.stdout(JSON.stringify(plan, null, 2));
    if (!plan.spaceCheck.ok) {
      io.stderr("Migration dry-run blocked: TARGET_SPACE_INSUFFICIENT");
      return 1;
    }
    return 0;
  }
  if (action === "apply") {
    const plan = parseLegacyMigrationPlan(strictJson(requiredOption(args, "--plan")));
    const report = await applyLegacyMigration({ plan });
    io.stdout(JSON.stringify(report, null, 2));
    return 0;
  }
  if (action === "rollback") {
    const report = rollbackLegacyMigration({
      workspacePath: requiredOption(args, "--workspace"),
      reportPath: requiredOption(args, "--report"),
      confirmedProjectId: requiredOption(args, "--confirm-project"),
    });
    io.stdout(JSON.stringify(report, null, 2));
    return 0;
  }
  throw new LegacyMigrationError(
    "CLI_MIGRATION_ACTION_INVALID",
    "migrate action must be scan, apply or rollback",
  );
}
