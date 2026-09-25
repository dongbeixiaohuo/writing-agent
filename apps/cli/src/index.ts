import { randomUUID } from "node:crypto";

import {
  ApplicationServiceError,
  WritingApplicationService,
} from "../../../packages/application/src/index.js";
import type { CredentialBroker } from "../../../packages/runtime/credentials/src/index.js";
import { createDefaultCredentialBroker } from "../../../packages/runtime/provider-config/src/index.js";
import { RuntimeRecovery } from "../../../packages/runtime/recovery/src/index.js";
import { SessionStoreError } from "../../../packages/runtime/session/src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import { runCredentialCommand } from "./credential-command.js";
import { runMigrationCommand } from "./migration-command.js";
import { runProviderDoctor } from "./provider-command.js";
import { runWritingCommand } from "./run-command.js";

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CliDependencies {
  readonly credentials?: CredentialBroker;
}

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = [
  "Usage:",
  "  writing-agent run --workspace <path> --project <id> --name <name> --mode <quick|deep> --brief <json> --material <utf8-file> --material-id <id> --material-role <user_firsthand|source_verified|illustrative> --provider-config <json>",
  "  writing-agent doctor --provider-config <json>",
  "  writing-agent credential set --id <id> --from-env <NAME>",
  "  writing-agent credential inspect --id <id>",
  "  writing-agent credential delete --id <id>",
  "  writing-agent migrate scan --kind <manifest|desktop_v0_1> --source <path> --workspace <path> [--artifacts-root <path>]",
  "  writing-agent migrate apply --plan <json>",
  "  writing-agent migrate rollback --workspace <path> --report <json> --confirm-project <id>",
  "  writing-agent export working-copy --workspace <path> --project <id> [--operation <id>]",
  "  writing-agent export publication --workspace <path> --project <id> --format <txt|html> [--operation <id>]",
  "  writing-agent request rebuild --workspace <path> --snapshot <id>",
  "  writing-agent inspect --workspace <path> --run <id>",
  "  writing-agent replay --workspace <path> --run <id>",
  "  writing-agent resume --workspace <path> --run <id> --decision <resume|retry-unknown>",
].join("\n");

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requiredOption(
  args: readonly string[],
  name: string,
): string | undefined {
  const value = option(args, name);
  return value === undefined || value.length === 0 ? undefined : value;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof SessionStoreError
    ? error.code
    : error instanceof Error
      ? error.name
      : "UNKNOWN_ERROR";
}

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const command = args[0];
  const isRequestRebuild = command === "request" && args[1] === "rebuild";
  const isRecoveryRead = command === "inspect" || command === "replay";
  const isResume = command === "resume";
  const isRun = command === "run";
  const isDoctor = command === "doctor";
  const isCredential = command === "credential";
  const isMigrate = command === "migrate";
  const exportKind = command === "export" ? args[1] : undefined;
  const isExport = exportKind === "working-copy" || exportKind === "publication";
  if (
    !isRequestRebuild &&
    !isRecoveryRead &&
    !isResume &&
    !isRun &&
    !isDoctor &&
    !isCredential &&
    !isMigrate &&
    !isExport
  ) {
    io.stderr(USAGE);
    return 2;
  }

  const workspacePath = requiredOption(args, "--workspace");
  if (!isDoctor && !isCredential && !isMigrate && workspacePath === undefined) {
    io.stderr("--workspace is required");
    return 2;
  }

  let storage: ReturnType<typeof openWorkspaceStorage> | undefined;
  try {
    const credentials =
      dependencies.credentials ?? createDefaultCredentialBroker();
    if (isCredential) {
      return await runCredentialCommand(args, io, credentials);
    }
    if (isDoctor) return await runProviderDoctor(args, io, credentials);
    if (isMigrate) return await runMigrationCommand(args, io);
    if (workspacePath === undefined) {
      io.stderr("--workspace is required");
      return 2;
    }
    if (isRun) {
      return await runWritingCommand(args, workspacePath, io, credentials);
    }
    if (isExport) {
      const projectId = requiredOption(args, "--project");
      if (projectId === undefined) {
        io.stderr("--project is required");
        return 2;
      }
      const operationId = requiredOption(args, "--operation") ?? randomUUID();
      storage = openWorkspaceStorage({ workspacePath });
      const service = new WritingApplicationService({ storage });
      const projection = service.getProjectProjection(projectId);
      const prior = projection.exports.find(
        (record) => record.operationId === operationId,
      );
      const bodyVersionId = prior?.bodyVersionId ?? projection.currentBody?.id;
      if (bodyVersionId === undefined) {
        throw new ApplicationServiceError(
          "BODY_VERSION_NOT_FOUND",
          "The project has no current body to export",
        );
      }
      const expectedProjectRevision =
        prior?.expectedProjectRevision ?? projection.project.revision;
      const actor = { kind: "user", id: "cli-user" } as const;
      const result =
        exportKind === "working-copy"
          ? service.saveWorkingCopy({
              operationId,
              projectId,
              expectedProjectRevision,
              bodyVersionId,
              actor,
            })
          : (() => {
              const format = requiredOption(args, "--format");
              if (format !== "txt" && format !== "html") {
                throw new ApplicationServiceError(
                  "CLI_FORMAT_INVALID",
                  "--format must be txt or html",
                );
              }
              const factSnapshotId =
                prior?.factSnapshotId ?? projection.factCheck.currentSnapshotId;
              if (factSnapshotId === null) {
                throw new ApplicationServiceError(
                  "FACT_GATE_NOT_PASSED",
                  "Formal export requires the current fact gate to pass",
                );
              }
              return service.exportPublication({
                operationId,
                projectId,
                expectedProjectRevision,
                bodyVersionId,
                factSnapshotId,
                format,
                actor,
              });
            })();
      if (!result.ok) {
        throw new ApplicationServiceError(result.code, result.message);
      }
      io.stdout(JSON.stringify(result.result, null, 2));
      return 0;
    }
    if (isRequestRebuild) {
      const snapshotId = requiredOption(args, "--snapshot");
      if (snapshotId === undefined) {
        io.stderr("--snapshot is required");
        return 2;
      }
      storage = openWorkspaceStorage({ workspacePath, readOnly: true });
      io.stdout(JSON.stringify(storage.rebuildModelRequest(snapshotId), null, 2));
      return 0;
    }

    const runId = requiredOption(args, "--run");
    if (runId === undefined) {
      io.stderr("--run is required");
      return 2;
    }
    if (isRecoveryRead) {
      storage = openWorkspaceStorage({ workspacePath, readOnly: true });
      const recovery = new RuntimeRecovery(storage);
      const result =
        command === "inspect"
          ? recovery.inspectRun(runId)
          : recovery.replayRun(runId);
      io.stdout(JSON.stringify(result, null, 2));
      return 0;
    }

    const decisionValue = requiredOption(args, "--decision");
    if (decisionValue !== "resume" && decisionValue !== "retry-unknown") {
      io.stderr("--decision must be resume or retry-unknown");
      return 2;
    }
    storage = openWorkspaceStorage({ workspacePath });
    const recovery = new RuntimeRecovery(storage);
    const before = storage.getRun(runId);
    if (before === null) {
      throw new SessionStoreError("RUN_NOT_FOUND", "Run does not exist");
    }
    if (before.status === "running") {
      recovery.recoverProject(before.projectId);
    }
    const result = recovery.resumeRun(runId, {
      action:
        decisionValue === "retry-unknown" ? "retry_unknown" : "resume",
    });
    if (!result.resumed) {
      io.stderr(`Resume blocked: ${result.reason}`);
      return 1;
    }
    io.stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    let label = "Runtime command";
    if (isRun) label = "Writing run";
    else if (isDoctor) label = "Provider doctor";
    else if (isCredential) label = "Credential command";
    else if (isMigrate) label = "Migration";
    else if (isExport) label = "Export";
    else if (isRequestRebuild) label = "Request rebuild";
    io.stderr(`${label} failed: ${errorCode(error)}`);
    return 1;
  } finally {
    storage?.close();
  }
}
