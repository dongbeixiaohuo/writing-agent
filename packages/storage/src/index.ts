import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";

import {
  AcceptRevisionProposalCommandSchema,
  ActorSchema,
  applyRevisionEdits,
  BODY_BLOCK_PARSER_VERSION,
  canonicalJson,
  CommitArtifactVersionCommandSchema,
  contentHash,
  createFactCheckInputSnapshot,
  CreateFactCheckSnapshotCommandSchema,
  CreateProjectCommandSchema,
  RenameProjectCommandSchema,
  DeleteProjectCommandSchema,
  evaluateFactCheck,
  EvaluateFactCheckSnapshotCommandSchema,
  ExportPublicationCommandSchema,
  FactCheckClaimsPayloadSchema,
  ImportMaterialCommandSchema,
  parseBodyDocument,
  ProposeRevisionCommandSchema,
  RecordDecisionCommandSchema,
  reconcileBodyDocument,
  RejectRevisionProposalCommandSchema,
  revisionDiff,
  RollbackArtifactVersionCommandSchema,
  SaveBodyCommandSchema,
  SaveWorkingCopyCommandSchema,
  SaveWritingBriefCommandSchema,
  SetBodyBlockLockCommandSchema,
  WritingBriefSchema,
  type AcceptRevisionProposalCommand,
  type Actor,
  type ArtifactKind,
  type ArtifactVersion,
  type ArtifactVersionCommitResult,
  type BodyBlock,
  type BodyBlockLock,
  type BodyDocument,
  type CommitArtifactVersionCommand,
  type CreateFactCheckSnapshotCommand,
  type CreateProjectCommand,
  type RenameProjectCommand,
  type DeleteProjectCommand,
  type DecisionRecord,
  type DomainEvent,
  type EvaluateFactCheckSnapshotCommand,
  type ExportPublicationCommand,
  type ExportRecord,
  type FactCheckInvalidation,
  type FactCheckStatusView,
  type PersistedFactAssessment,
  type PersistedFactCheckSnapshot,
  type PublicationLayoutPreset,
  type PreparedExportContent,
  type ImportMaterialCommand,
  type MaterialRecord,
  type MutationResult,
  type ProvenanceEdge,
  type ProvenanceRelation,
  type ProjectInspection,
  type ProposeRevisionCommand,
  type RecordDecisionCommand,
  type RejectRevisionProposalCommand,
  type RevisionDiffEntry,
  type RevisionEdit,
  type RevisionProposal,
  type RevisionProposalResult,
  type RollbackArtifactVersionCommand,
  type SaveBodyCommand,
  type SaveWorkingCopyCommand,
  type SaveWritingBriefCommand,
  type SetBodyBlockLockCommand,
  type StoragePort,
  type WritingBriefCommitResult,
  type WritingBriefVersion,
  preparePublicationContent,
  prepareWorkingCopyContent,
} from "../../writing-core/src/index.js";
import {
  DEFAULT_RUN_BUDGET,
  loopBudgetUsage,
  EMPTY_RUN_USAGE,
  SessionStoreError,
  type CancelRunInput,
  type CreateSessionInput,
  type DispatchRuntimeOperationInput,
  type DispatchRuntimeOperationResult,
  type FinishRunInput,
  type PauseRunInput,
  type PrepareRuntimeOperationInput,
  type RecordRunEventInput,
  type RecoveredRun,
  type ReserveMajorRevisionInput,
  type ReserveMajorRevisionResult,
  type RequestContentReference,
  type RequestSnapshotRecord,
  type ResumeRunInput,
  type RunRecord,
  type RunUsage,
  type RuntimeEvent,
  type RuntimeOperationRecord,
  type SaveRequestSnapshotInput,
  type SessionRecord,
  type SessionStore,
  type SettleRuntimeOperationInput,
  type StartRunInput,
} from "../../runtime/session/src/index.js";
import type { ModelRequest } from "../../runtime/llm/src/index.js";
import {
  APPLICATION_ID,
  createSchema,
  CURRENT_SCHEMA_VERSION,
  migrateSchema,
} from "./schema.js";

export type CommitFaultPoint =
  | "after_artifact_version_insert"
  | "after_project_pointer_update"
  | "after_runtime_operation_dispatch"
  | "after_export_temp_write"
  | "after_export_file_replace"
  | "before_transaction_commit";

export interface OpenWorkspaceStorageOptions {
  workspacePath: string;
  clock?: () => string;
  idFactory?: () => string;
  faultInjector?: (point: CommitFaultPoint) => void;
  readOnly?: boolean;
}

export interface BackupManifest {
  path: string;
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  createdAt: string;
}

export type WorkspaceDatabaseInspection =
  | {
      ok: true;
      databasePath: string;
      applicationId: number;
      schemaVersion: number;
      supported: boolean;
      integrity: "ok";
      projectCount: number;
    }
  | {
      ok: false;
      databasePath: string;
      code: string;
      message: string;
    };

export interface RestoreWorkspaceBackupOptions {
  backupPath: string;
  targetWorkspacePath: string;
}

export interface MigrateWorkspaceStorageOptions {
  workspacePath: string;
  backupPath?: string;
  clock?: () => string;
}

export interface SchemaMigrationResult {
  fromVersion: number;
  toVersion: number;
  backup: BackupManifest;
}

interface ProjectRow {
  id: string;
  name: string;
  name_source: "placeholder" | "agent" | "manual" | "legacy";
  mode: "quick" | "deep";
  schema_version: number;
  revision: number;
  latest_body_version_id: string | null;
  current_title_version_id: string | null;
  current_evidence_version_id: string | null;
  current_brief_version_id: string | null;
  fact_gate_status: "not_checked" | "passed" | "blocked" | "error" | "stale";
  current_fact_snapshot_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MaterialRow {
  id: string;
  project_id: string;
  display_name: string;
  source_kind: MaterialRecord["sourceKind"];
  source_reference: string | null;
  role: MaterialRecord["role"];
  trust_label: MaterialRecord["trustLabel"];
  permission_scope: MaterialRecord["permissionScope"];
  content_version_id: string;
  content: string;
  content_hash: string;
  imported_at: string;
}

interface WritingBriefVersionRow {
  id: string;
  project_id: string;
  brief_json: string;
  content_hash: string;
  parent_version_id: string | null;
  actor_json: string;
  operation_id: string;
  created_event_seq: number;
  created_at: string;
}

interface DecisionRow {
  id: string;
  project_id: string;
  type: DecisionRecord["type"];
  value_json: string;
  scope: string;
  actor_json: string;
  source_event_id: string | null;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  latest_version_id: string | null;
}

interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  project_id: string;
  kind: ArtifactKind;
  logical_key: string;
  content: string;
  content_hash: string;
  actor_json: string;
  parent_version_ids_json: string;
  reason: string;
  request_snapshot_id: string | null;
  created_event_seq: number;
  operation_id: string;
  created_at: string;
}

interface BodyDocumentRow {
  artifact_version_id: string;
  project_id: string;
  parser_version: string;
  content_hash: string;
  document_json: string;
  created_at: string;
}

interface RevisionProposalRow {
  id: string;
  project_id: string;
  base_body_version_id: string;
  base_project_revision: number;
  instruction: string;
  constraints_json: string;
  edits_json: string;
  diff_json: string;
  requested_by_json: string;
  status: RevisionProposal["status"];
  accepted_version_id: string | null;
  conflict_code: RevisionProposal["conflictCode"];
  created_event_seq: number;
  created_at: string;
  resolved_at: string | null;
}

interface BlockLockDecisionRow {
  id: string;
  project_id: string;
  body_version_id: string;
  block_id: string;
  block_hash: string;
  action: "lock" | "unlock";
  actor_json: string;
  operation_id: string;
  created_event_seq: number;
  created_at: string;
}

interface FactInputSnapshotRow {
  id: string;
  project_id: string;
  schema_version: "fact-check-v2";
  policy_version: PersistedFactCheckSnapshot["policyVersion"];
  body_version_id: string;
  body_hash: string;
  title_version_id: string;
  title_hash: string;
  distribution_copy_hash: string | null;
  evidence_version_id: string;
  evidence_hash: string;
  created_event_seq: number;
  created_at: string;
}

interface FactAssessmentRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  status: PersistedFactAssessment["status"];
  payload_json: string;
  claims_hash: string;
  blockers_json: string;
  report_content: string;
  report_hash: string;
  actor_json: string;
  operation_id: string;
  created_event_seq: number;
  created_at: string;
}

interface FactInvalidationRow {
  id: string;
  project_id: string;
  snapshot_id: string;
  reason: FactCheckInvalidation["reason"];
  changed_version_id: string;
  actor_json: string;
  operation_id: string;
  created_event_seq: number;
  created_at: string;
}

interface ExportRow {
  id: string;
  operation_id: string;
  input_hash: string;
  expected_project_revision: number;
  project_id: string;
  mode: ExportRecord["mode"];
  format: ExportRecord["format"];
  state: ExportRecord["state"];
  body_version_id: string;
  body_hash: string;
  title_version_id: string | null;
  title_hash: string | null;
  distribution_copy_hash: string | null;
  evidence_version_id: string | null;
  evidence_hash: string | null;
  fact_snapshot_id: string | null;
  assessment_id: string | null;
  policy_version: string | null;
  gate_status: ExportRecord["gateStatus"];
  relative_path: string;
  manifest_relative_path: string | null;
  content_text: string;
  manifest_content: string | null;
  content_hash: string;
  manifest_hash: string | null;
  byte_length: number;
  manifest_byte_length: number | null;
  actor_json: string;
  created_at: string;
  completed_event_seq: number | null;
  completed_at: string | null;
}

interface ProvenanceEdgeRow {
  id: string;
  project_id: string;
  from_id: string;
  relation: ProvenanceRelation;
  to_id: string;
  actor_json: string;
  event_seq: number;
  evidence_ref: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  project_id: string;
  project_seq: number;
  run_id: string | null;
  type: string;
  actor_json: string;
  operation_id: string;
  payload_json: string;
  occurred_at: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  purpose: string;
  created_at: string;
}

interface RunRow {
  id: string;
  session_id: string;
  project_id: string;
  status: RunRecord["status"];
  plan_version: string;
  budget_json: string;
  usage_json: string;
  last_committed_event_seq: number;
  stop_reason: string | null;
  created_at: string;
  started_at: string;
  completed_at: string | null;
}

interface RequestSnapshotRow {
  id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  request_id: string;
  provider: string;
  model: string;
  adapter_version: string;
  serialization_version: string;
  assembly_version: string;
  request_json: string;
  normalized_payload_json: string;
  tool_schemas_json: string;
  content_references_json: string;
  payload_hash: string;
  request_hash: string;
  schema_hash: string;
  redactions_json: string;
  unreconstructable_fields_json: string;
  created_at: string;
}

interface RuntimeOperationRow {
  operation_id: string;
  project_id: string;
  run_id: string;
  kind: RuntimeOperationRecord["kind"];
  effect: RuntimeOperationRecord["effect"];
  input_hash: string;
  state: RuntimeOperationRecord["state"];
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
}

interface OperationRow {
  command_type?: string;
  input_hash: string;
  state: string;
  result_json: string | null;
}

interface MutationActionSuccess<T> {
  ok: true;
  projectRevision: number;
  result: T;
}

type MutationAction<T> =
  | MutationActionSuccess<T>
  | {
      ok: false;
      code: string;
      message: string;
      retryable: boolean;
      details: Record<string, unknown>;
      commit?: boolean;
    };

interface VersionCommitInput {
  operationId: string;
  projectId: string;
  expectedProjectRevision: number;
  actor: Actor;
  kind: ArtifactKind;
  logicalKey: string;
  baseVersionId: string | null;
  content: string;
  reason: string;
  requestSnapshotId: string | null;
  eventType: "artifact.version_committed" | "artifact.rolled_back";
  parentVersionIds: string[];
  allowSameContent: boolean;
  bodyBlocks?: readonly BodyBlock[];
}

export class StorageOpenError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageOpenError";
  }
}

function failure(
  operationId: string,
  code: string,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
): MutationResult<never> {
  return { ok: false, operationId, code, message, retryable, details };
}

function actionFailure(
  code: string,
  message: string,
  retryable = false,
  details: Record<string, unknown> = {},
  commit = false,
): MutationAction<never> {
  return {
    ok: false,
    code,
    message,
    retryable,
    details,
    ...(commit ? { commit: true } : {}),
  };
}

function workspaceDatabasePath(workspacePath: string): string {
  return join(workspacePath, ".writing-agent", "workspace.sqlite3");
}

function classifyDatabaseError(error: unknown): StorageOpenError {
  const sqliteCode =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (
    sqliteCode === "ERR_SQLITE_CORRUPT" ||
    sqliteCode === "ERR_SQLITE_NOTADB" ||
    message.includes("database disk image is malformed") ||
    message.includes("file is not a database")
  ) {
    return new StorageOpenError(
      "DATABASE_CORRUPT",
      "Workspace database is corrupt or is not a SQLite database",
      { cause: error },
    );
  }
  return new StorageOpenError(
    "DATABASE_UNAVAILABLE",
    "Unable to open the workspace database",
    { cause: error },
  );
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

class ExportFileError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ExportFileError";
  }
}

function exportTargetPath(databasePath: string, relativePath: string): string {
  const workspacePath = dirname(dirname(resolve(databasePath)));
  const exportRoot = resolve(workspacePath, "exports");
  const target = resolve(workspacePath, ...relativePath.split("/"));
  const fromExportRoot = relative(exportRoot, target);
  if (
    fromExportRoot.length === 0 ||
    fromExportRoot === ".." ||
    fromExportRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromExportRoot)
  ) {
    throw new ExportFileError(
      "EXPORT_PATH_INVALID",
      "Export target must stay inside the workspace exports directory",
    );
  }
  return target;
}

function publicationLayoutPresetFromPath(
  relativePath: string,
): PublicationLayoutPreset {
  if (relativePath.endsWith("-editorial.html")) return "editorial";
  if (relativePath.endsWith("-compact.html")) return "compact";
  return "clean";
}

function sqlitePragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as
    | Record<string, unknown>
    | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "number") {
    throw new StorageOpenError(
      "DATABASE_INVALID",
      `SQLite PRAGMA ${pragma} did not return a number`,
    );
  }
  return value;
}

function verifyDatabase(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA quick_check").get() as
    | Record<string, unknown>
    | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (value !== "ok") {
    throw new StorageOpenError(
      "DATABASE_CORRUPT",
      `SQLite quick_check failed: ${String(value)}`,
    );
  }
}

function configureConnection(database: DatabaseSync, readOnly: boolean): void {
  database.enableLoadExtension(false);
  database.enableDefensive(true);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    PRAGMA trusted_schema = OFF;
  `);
  if (readOnly) {
    database.exec("PRAGMA query_only = ON");
  }
  const expectedPragmas: Array<[string, number]> = [
    ["foreign_keys", 1],
    ["busy_timeout", 5000],
    ["synchronous", 2],
    ["trusted_schema", 0],
  ];
  for (const [pragma, expected] of expectedPragmas) {
    const actual = sqlitePragmaNumber(database, pragma);
    if (actual !== expected) {
      throw new StorageOpenError(
        "DATABASE_CONFIGURATION_FAILED",
        `SQLite PRAGMA ${pragma} expected ${expected} but read back ${actual}`,
      );
    }
  }
}

function verifyWalMode(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA journal_mode").get() as
    | Record<string, unknown>
    | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (value !== "wal") {
    throw new StorageOpenError(
      "DATABASE_CONFIGURATION_FAILED",
      `SQLite journal_mode expected wal but read back ${String(value)}`,
    );
  }
}

function initializeDatabase(
  database: DatabaseSync,
  isNewDatabase: boolean,
  now: string,
  readOnly: boolean,
): void {
  try {
    configureConnection(database, readOnly);
    verifyDatabase(database);

    const schemaVersion = sqlitePragmaNumber(database, "user_version");
    const applicationId = sqlitePragmaNumber(database, "application_id");

    if (isNewDatabase) {
      database.exec("BEGIN IMMEDIATE");
      try {
        createSchema(database, now);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      database.exec("PRAGMA journal_mode = WAL");
      verifyWalMode(database);
      return;
    }

    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new StorageOpenError(
        "SCHEMA_UNSUPPORTED",
        `Workspace schema ${schemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (applicationId !== APPLICATION_ID || schemaVersion === 0) {
      throw new StorageOpenError(
        "UNRECOGNIZED_DATABASE",
        "Workspace database is not a recognized Writing Agent database",
      );
    }
    if (schemaVersion < CURRENT_SCHEMA_VERSION) {
      throw new StorageOpenError(
        "SCHEMA_MIGRATION_REQUIRED",
        `Workspace schema ${schemaVersion} requires a migration`,
      );
    }
    if (!readOnly) database.exec("PRAGMA journal_mode = WAL");
    verifyWalMode(database);
  } catch (error) {
    if (error instanceof StorageOpenError) throw error;
    throw classifyDatabaseError(error);
  }
}

function backfillBodyDocuments(database: DatabaseSync, now: string): void {
  const rows = database
    .prepare(
      `SELECT version.id, version.project_id, version.content
         FROM artifact_versions AS version
         LEFT JOIN body_documents AS document
           ON document.artifact_version_id = version.id
        WHERE version.kind = 'body'
          AND document.artifact_version_id IS NULL
        ORDER BY version.rowid ASC`,
    )
    .all() as unknown as Array<{
    id: string;
    project_id: string;
    content: string;
  }>;
  const insert = database.prepare(
    `INSERT INTO body_documents(
       artifact_version_id, project_id, parser_version, content_hash,
       document_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const document = parseBodyDocument(row.id, row.content);
    insert.run(
      row.id,
      row.project_id,
      document.parserVersion,
      document.contentHash,
      canonicalJson(document),
      now,
    );
  }
}

function projectFromRow(row: ProjectRow): ProjectInspection {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    schemaVersion: row.schema_version,
    revision: row.revision,
    latestBodyVersionId: row.latest_body_version_id,
    currentTitleVersionId: row.current_title_version_id,
    currentEvidenceVersionId: row.current_evidence_version_id,
    currentBriefVersionId: row.current_brief_version_id,
    factGateStatus: row.fact_gate_status,
    currentFactSnapshotId: row.current_fact_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function materialFromRow(row: MaterialRow): MaterialRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    displayName: row.display_name,
    sourceKind: row.source_kind,
    sourceReference: row.source_reference,
    role: row.role,
    trustLabel: row.trust_label,
    permissionScope: row.permission_scope,
    importedAt: row.imported_at,
    contentVersionId: row.content_version_id,
    hash: row.content_hash,
    content: row.content,
  };
}

function writingBriefVersionFromRow(
  row: WritingBriefVersionRow,
): WritingBriefVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    brief: WritingBriefSchema.parse(JSON.parse(row.brief_json)),
    contentHash: row.content_hash,
    parentVersionId: row.parent_version_id,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    operationId: row.operation_id,
    createdEventSeq: row.created_event_seq,
    createdAt: row.created_at,
  };
}

function decisionFromRow(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    value: JSON.parse(row.value_json) as DecisionRecord["value"],
    scope: row.scope,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    sourceEventId: row.source_event_id,
    createdAt: row.created_at,
  };
}

function artifactVersionFromRow(row: ArtifactVersionRow): ArtifactVersion {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    projectId: row.project_id,
    kind: row.kind,
    logicalKey: row.logical_key,
    content: row.content,
    contentHash: row.content_hash,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    parentVersionIds: JSON.parse(row.parent_version_ids_json) as string[],
    reason: row.reason,
    requestSnapshotId: row.request_snapshot_id,
    createdEventSeq: row.created_event_seq,
    operationId: row.operation_id,
    createdAt: row.created_at,
  };
}

function bodyDocumentFromRow(row: BodyDocumentRow): BodyDocument {
  const parsed = JSON.parse(row.document_json) as BodyDocument;
  if (
    parsed.versionId !== row.artifact_version_id ||
    parsed.parserVersion !== BODY_BLOCK_PARSER_VERSION ||
    parsed.contentHash !== row.content_hash
  ) {
    throw new StorageOpenError(
      "BODY_DOCUMENT_INVALID",
      "Stored body document metadata does not match its version",
    );
  }
  return parsed;
}

function revisionProposalFromRow(row: RevisionProposalRow): RevisionProposal {
  return {
    id: row.id,
    projectId: row.project_id,
    baseBodyVersionId: row.base_body_version_id,
    baseProjectRevision: row.base_project_revision,
    instruction: row.instruction,
    constraints: JSON.parse(row.constraints_json) as string[],
    edits: JSON.parse(row.edits_json) as RevisionEdit[],
    diff: JSON.parse(row.diff_json) as RevisionDiffEntry[],
    requestedBy: ActorSchema.parse(JSON.parse(row.requested_by_json)),
    status: row.status,
    acceptedVersionId: row.accepted_version_id,
    conflictCode: row.conflict_code,
    createdEventSeq: row.created_event_seq,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function bodyBlockLockFromRow(row: BlockLockDecisionRow): BodyBlockLock {
  return {
    decisionId: row.id,
    projectId: row.project_id,
    bodyVersionId: row.body_version_id,
    blockId: row.block_id,
    blockHash: row.block_hash,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    createdEventSeq: row.created_event_seq,
    createdAt: row.created_at,
  };
}

function provenanceEdgeFromRow(row: ProvenanceEdgeRow): ProvenanceEdge {
  return {
    id: row.id,
    projectId: row.project_id,
    fromId: row.from_id,
    relation: row.relation,
    toId: row.to_id,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    eventSeq: row.event_seq,
    evidenceRef: row.evidence_ref,
    createdAt: row.created_at,
  };
}

function factInputSnapshotFromRow(
  row: FactInputSnapshotRow,
): PersistedFactCheckSnapshot {
  return {
    schemaVersion: row.schema_version,
    policyVersion: row.policy_version,
    snapshotId: row.id,
    projectId: row.project_id,
    bodyVersionId: row.body_version_id,
    bodyHash: row.body_hash,
    titleVersionId: row.title_version_id,
    titleHash: row.title_hash,
    distributionCopyHash: row.distribution_copy_hash,
    evidenceVersionId: row.evidence_version_id,
    evidenceHash: row.evidence_hash,
    createdEventSeq: row.created_event_seq,
    createdAt: row.created_at,
  };
}

function factAssessmentFromRow(row: FactAssessmentRow): PersistedFactAssessment {
  return {
    id: row.id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    status: row.status,
    payload: FactCheckClaimsPayloadSchema.parse(JSON.parse(row.payload_json)),
    claimsHash: row.claims_hash,
    blockers: JSON.parse(row.blockers_json) as string[],
    reportContent: row.report_content,
    reportHash: row.report_hash,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    operationId: row.operation_id,
    createdEventSeq: row.created_event_seq,
    createdAt: row.created_at,
  };
}

function factInvalidationFromRow(row: FactInvalidationRow): FactCheckInvalidation {
  return {
    id: row.id,
    projectId: row.project_id,
    snapshotId: row.snapshot_id,
    reason: row.reason,
    changedVersionId: row.changed_version_id,
    actor: ActorSchema.parse(JSON.parse(row.actor_json)),
    operationId: row.operation_id,
    createdEventSeq: row.created_event_seq,
    createdAt: row.created_at,
  };
}

function exportRecordFromRow(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    projectId: row.project_id,
    expectedProjectRevision: row.expected_project_revision,
    mode: row.mode,
    format: row.format,
    state: row.state,
    bodyVersionId: row.body_version_id,
    bodyHash: row.body_hash,
    titleVersionId: row.title_version_id,
    titleHash: row.title_hash,
    distributionCopyHash: row.distribution_copy_hash,
    evidenceVersionId: row.evidence_version_id,
    evidenceHash: row.evidence_hash,
    factSnapshotId: row.fact_snapshot_id,
    assessmentId: row.assessment_id,
    policyVersion: row.policy_version,
    gateStatus: row.gate_status,
    relativePath: row.relative_path,
    manifestRelativePath: row.manifest_relative_path,
    contentHash: row.content_hash,
    manifestHash: row.manifest_hash,
    byteLength: row.byte_length,
    manifestByteLength: row.manifest_byte_length,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function requireRuntimeId(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SessionStoreError("RUNTIME_INPUT_INVALID", `${field} must not be empty`);
  }
  return normalized;
}

function requireCounter(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionStoreError(
      "RUNTIME_INPUT_INVALID",
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function normalizedRunBudget(input: StartRunInput["budget"]): RunRecord["budget"] {
  const budget = input ?? DEFAULT_RUN_BUDGET;
  return {
    maxModelRequests: requireCounter(
      budget.maxModelRequests,
      "budget.maxModelRequests",
    ),
    maxToolCalls: requireCounter(budget.maxToolCalls, "budget.maxToolCalls"),
    maxRetriesPerRequest: requireCounter(
      budget.maxRetriesPerRequest,
      "budget.maxRetriesPerRequest",
    ),
    maxMajorRevisions: requireCounter(
      budget.maxMajorRevisions,
      "budget.maxMajorRevisions",
    ),
  };
}

function normalizedRunUsage(input: StartRunInput["usage"]): RunUsage {
  const usage = input ?? EMPTY_RUN_USAGE;
  return {
    modelRequests: requireCounter(usage.modelRequests, "usage.modelRequests"),
    toolCalls: requireCounter(usage.toolCalls, "usage.toolCalls"),
    retries: requireCounter(usage.retries, "usage.retries"),
    majorRevisions: requireCounter(
      usage.majorRevisions,
      "usage.majorRevisions",
    ),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    reasoningTokens: usage.reasoningTokens,
    cost: usage.cost,
    costKnown: usage.costKnown,
    usageReports: requireCounter(usage.usageReports, "usage.usageReports"),
    missingUsageReports: requireCounter(
      usage.missingUsageReports,
      "usage.missingUsageReports",
    ),
  };
}

function addKnownTokenCount(
  prior: number | null,
  next: number | null,
): number | null {
  return prior === null || next === null ? null : prior + next;
}

function usageAfterModelAttempt(
  usage: RunUsage,
  tokenUsage: SettleRuntimeOperationInput["tokenUsage"],
): RunUsage {
  if (tokenUsage === null || tokenUsage === undefined) {
    return {
      ...usage,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      cost: null,
      costKnown: false,
      missingUsageReports: usage.missingUsageReports + 1,
    };
  }
  let cost: RunUsage["cost"] = null;
  let costKnown = usage.costKnown && tokenUsage.cost !== null;
  if (costKnown && tokenUsage.cost !== null) {
    const settledAttempts = usage.usageReports + usage.missingUsageReports;
    if (settledAttempts === 0) {
      cost = tokenUsage.cost;
    } else if (
      usage.cost !== null &&
      usage.cost.currency === tokenUsage.cost.currency &&
      usage.cost.pricingVersion === tokenUsage.cost.pricingVersion
    ) {
      cost = {
        amount: usage.cost.amount + tokenUsage.cost.amount,
        currency: usage.cost.currency,
        pricingVersion: usage.cost.pricingVersion,
        verifiedAt:
          usage.cost.verifiedAt > tokenUsage.cost.verifiedAt
            ? usage.cost.verifiedAt
            : tokenUsage.cost.verifiedAt,
      };
    } else {
      costKnown = false;
    }
  }
  return {
    ...usage,
    inputTokens: addKnownTokenCount(usage.inputTokens, tokenUsage.inputTokens),
    outputTokens: addKnownTokenCount(usage.outputTokens, tokenUsage.outputTokens),
    totalTokens: addKnownTokenCount(usage.totalTokens, tokenUsage.totalTokens),
    cacheReadTokens: addKnownTokenCount(
      usage.cacheReadTokens,
      tokenUsage.cacheReadTokens,
    ),
    reasoningTokens: addKnownTokenCount(
      usage.reasoningTokens,
      tokenUsage.reasoningTokens,
    ),
    cost,
    costKnown,
    usageReports: usage.usageReports + 1,
  };
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    purpose: row.purpose,
    createdAt: row.created_at,
  };
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    status: row.status,
    planVersion: row.plan_version,
    budget: JSON.parse(row.budget_json) as RunRecord["budget"],
    usage: JSON.parse(row.usage_json) as RunRecord["usage"],
    lastCommittedEventSeq: row.last_committed_event_seq,
    stopReason: row.stop_reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function runtimeOperationFromRow(
  row: RuntimeOperationRow,
): RuntimeOperationRecord {
  return {
    operationId: row.operation_id,
    projectId: row.project_id,
    runId: row.run_id,
    kind: row.kind,
    effect: row.effect,
    inputHash: row.input_hash,
    state: row.state,
    result:
      row.result_json === null
        ? null
        : (JSON.parse(row.result_json) as RuntimeOperationRecord["result"]),
    error:
      row.error_json === null
        ? null
        : (JSON.parse(row.error_json) as RuntimeOperationRecord["error"]),
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
  };
}

function persistedModelRequest(request: ModelRequest): ModelRequest {
  const serializable = {
    requestId: request.requestId,
    model: request.model,
    messages: request.messages,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    parameters: request.parameters,
  };
  return JSON.parse(canonicalJson(serializable)) as ModelRequest;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new SessionStoreError(
      "REQUEST_SNAPSHOT_INTEGRITY_FAILED",
      `Persisted ${field} is invalid`,
    );
  }
  return value;
}

function requestSnapshotFromRow(row: RequestSnapshotRow): RequestSnapshotRecord {
  let request: ModelRequest;
  let normalizedPayload: RequestSnapshotRecord["normalizedPayload"];
  let toolSchemas: RequestSnapshotRecord["toolSchemas"];
  let contentReferences: RequestContentReference[];
  let redactions: string[];
  let unreconstructableFields: string[];
  try {
    request = JSON.parse(row.request_json) as ModelRequest;
    normalizedPayload = JSON.parse(
      row.normalized_payload_json,
    ) as RequestSnapshotRecord["normalizedPayload"];
    toolSchemas = JSON.parse(
      row.tool_schemas_json,
    ) as RequestSnapshotRecord["toolSchemas"];
    contentReferences = JSON.parse(
      row.content_references_json,
    ) as RequestContentReference[];
    redactions = stringArray(JSON.parse(row.redactions_json), "redactions");
    unreconstructableFields = stringArray(
      JSON.parse(row.unreconstructable_fields_json),
      "unreconstructable fields",
    );
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    throw new SessionStoreError(
      "REQUEST_SNAPSHOT_INTEGRITY_FAILED",
      "Persisted request snapshot JSON is invalid",
      { cause: error },
    );
  }

  const requestHash = contentHash(canonicalJson(request));
  const payloadHash = contentHash(canonicalJson(normalizedPayload));
  const schemaHash = contentHash(canonicalJson(toolSchemas));
  if (
    requestHash !== row.request_hash ||
    payloadHash !== row.payload_hash ||
    schemaHash !== row.schema_hash ||
    request.requestId !== row.request_id ||
    request.model !== row.model
  ) {
    throw new SessionStoreError(
      "REQUEST_SNAPSHOT_INTEGRITY_FAILED",
      "Persisted request snapshot hashes or identity fields do not match",
    );
  }
  if (!Array.isArray(contentReferences)) {
    throw new SessionStoreError(
      "REQUEST_SNAPSHOT_INTEGRITY_FAILED",
      "Persisted content references are invalid",
    );
  }
  for (const reference of contentReferences) {
    const message = request.messages[reference.messageIndex];
    if (
      reference.kind === "tool_result" &&
      (message?.role !== "tool" ||
        message.toolCallId !== reference.id ||
        contentHash(message.content) !== reference.contentHash)
    ) {
      throw new SessionStoreError(
        "REQUEST_SNAPSHOT_INTEGRITY_FAILED",
        "Persisted tool-result content reference cannot be resolved",
      );
    }
  }

  return {
    snapshotId: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    requestId: row.request_id,
    provider: row.provider,
    model: row.model,
    adapterVersion: row.adapter_version,
    serializationVersion: row.serialization_version,
    assemblyVersion: row.assembly_version,
    request,
    normalizedPayload,
    toolSchemas,
    contentReferences,
    payloadHash: row.payload_hash,
    requestHash: row.request_hash,
    schemaHash: row.schema_hash,
    redactions,
    unreconstructableFields,
    createdAt: row.created_at,
  };
}

export class WorkspaceStorage implements StoragePort, SessionStore {
  constructor(
    private readonly database: DatabaseSync,
    public readonly databasePath: string,
    private readonly clock: () => string,
    private readonly idFactory: () => string,
    private readonly faultInjector?: (point: CommitFaultPoint) => void,
    private readonly readOnly = false,
  ) {}

  close(): void {
    this.database.close();
  }

  private rollbackQuietly(): void {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // A failed COMMIT may already have ended the transaction.
    }
  }

  private runtimeWrite<T>(action: (now: string) => T): T {
    if (this.readOnly) {
      throw new SessionStoreError(
        "STORAGE_READ_ONLY",
        "Workspace storage was opened in read-only mode",
      );
    }
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const result = action(this.clock());
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.rollbackQuietly();
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError(
        "SESSION_STORE_WRITE_FAILED",
        "Runtime session state could not be committed",
        { cause: error },
      );
    }
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const sessionId = requireRuntimeId(input.sessionId, "sessionId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const purpose = requireRuntimeId(input.purpose, "purpose");
    return this.runtimeWrite((now) => {
      if (this.getProjectRow(projectId) === undefined) {
        throw new SessionStoreError("PROJECT_NOT_FOUND", "Project does not exist");
      }
      if (this.getSession(sessionId) !== null) {
        throw new SessionStoreError(
          "SESSION_ALREADY_EXISTS",
          "Session ID already exists",
        );
      }
      this.database
        .prepare(
          `INSERT INTO sessions(id, project_id, purpose, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sessionId, projectId, purpose, now);
      return { id: sessionId, projectId, purpose, createdAt: now };
    });
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? null : sessionFromRow(row);
  }

  startRun(input: StartRunInput): RunRecord {
    const runId = requireRuntimeId(input.runId, "runId");
    const sessionId = requireRuntimeId(input.sessionId, "sessionId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const planVersion = requireRuntimeId(input.planVersion, "planVersion");
    const operationId =
      input.operationId === undefined
        ? `run:${runId}:start`
        : requireRuntimeId(input.operationId, "operationId");
    const budget = normalizedRunBudget(input.budget);
    const usage = normalizedRunUsage(input.usage);
    const requiredArtifactVersionIds = [...new Set(
      (input.requiredArtifactVersionIds ?? []).map((versionId) =>
        requireRuntimeId(versionId, "requiredArtifactVersionId"),
      ),
    )];
    const budgetJson = canonicalJson(budget);
    const usageJson = canonicalJson(usage);
    return this.runtimeWrite((now) => {
      const session = this.getSession(sessionId);
      if (session === null || session.projectId !== projectId) {
        throw new SessionStoreError(
          "SESSION_SCOPE_INVALID",
          "Session does not belong to the requested project",
        );
      }
      if (this.getRun(runId) !== null) {
        throw new SessionStoreError("RUN_ALREADY_EXISTS", "Run ID already exists");
      }
      const projectSeq = this.nextProjectSeq(projectId);
      this.database
        .prepare(
          `INSERT INTO runs(
             id, session_id, project_id, status, plan_version,
             budget_json, usage_json, last_committed_event_seq,
             created_at, started_at
           ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          sessionId,
          projectId,
          planVersion,
          budgetJson,
          usageJson,
          projectSeq,
          now,
          now,
        );
      this.insertEvent(
        projectId,
        projectSeq,
        "run.started",
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        {
          runId,
          sessionId,
          planVersion,
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          ...(input.expectedBodyVersionId === undefined ? {} : { expectedBodyVersionId: input.expectedBodyVersionId }),
          ...(input.displayInstruction === undefined
            ? {}
            : { displayInstruction: input.displayInstruction }),
          ...(requiredArtifactVersionIds.length === 0
            ? {}
            : { requiredArtifactVersionIds }),
        },
        now,
        runId,
      );
      return {
        id: runId,
        sessionId,
        projectId,
        status: "running",
        planVersion,
        budget,
        usage,
        lastCommittedEventSeq: projectSeq,
        stopReason: null,
        createdAt: now,
        startedAt: now,
        completedAt: null,
      };
    });
  }

  getRun(runId: string): RunRecord | null {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    return row === undefined ? null : runFromRow(row);
  }

  saveRequestSnapshot(input: SaveRequestSnapshotInput): RequestSnapshotRecord {
    const snapshotId = requireRuntimeId(input.snapshotId, "snapshotId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const sessionId = requireRuntimeId(input.sessionId, "sessionId");
    const runId = requireRuntimeId(input.runId, "runId");
    requireRuntimeId(input.request.requestId, "requestId");
    requireRuntimeId(input.request.model, "model");
    requireRuntimeId(input.provider.id, "provider.id");
    requireRuntimeId(input.provider.adapterVersion, "provider.adapterVersion");
    requireRuntimeId(
      input.provider.serializationVersion,
      "provider.serializationVersion",
    );
    requireRuntimeId(input.assemblyVersion, "assemblyVersion");

    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (
        run === null ||
        run.projectId !== projectId ||
        run.sessionId !== sessionId ||
        run.status !== "running"
      ) {
        throw new SessionStoreError(
          "RUN_SCOPE_INVALID",
          "Request snapshot run is missing, terminal, or outside session scope",
        );
      }
      const existing = this.database
        .prepare("SELECT id FROM request_snapshots WHERE id = ?")
        .get(snapshotId);
      if (existing !== undefined) {
        throw new SessionStoreError(
          "REQUEST_SNAPSHOT_ALREADY_EXISTS",
          "Request snapshots are immutable and this ID already exists",
        );
      }

      let request: ModelRequest;
      let requestJson: string;
      let normalizedPayloadJson: string;
      let toolSchemasJson: string;
      let contentReferencesJson: string;
      let redactionsJson: string;
      let unreconstructableFieldsJson: string;
      try {
        request = persistedModelRequest(input.request);
        requestJson = canonicalJson(request);
        normalizedPayloadJson = canonicalJson(input.provider.normalizedPayload);
        toolSchemasJson = canonicalJson(input.toolSchemas);
        contentReferencesJson = canonicalJson(input.contentReferences);
        redactionsJson = canonicalJson(input.provider.redactions);
        unreconstructableFieldsJson = canonicalJson(
          input.provider.unreconstructableFields,
        );
      } catch (error) {
        throw new SessionStoreError(
          "REQUEST_SNAPSHOT_INVALID",
          "Request snapshot contains non-JSON data",
          { cause: error },
        );
      }
      const payloadHash = contentHash(normalizedPayloadJson);
      const requestHash = contentHash(requestJson);
      const schemaHash = contentHash(toolSchemasJson);
      const row: RequestSnapshotRow = {
        id: snapshotId,
        project_id: projectId,
        session_id: sessionId,
        run_id: runId,
        request_id: request.requestId,
        provider: input.provider.id,
        model: request.model,
        adapter_version: input.provider.adapterVersion,
        serialization_version: input.provider.serializationVersion,
        assembly_version: input.assemblyVersion,
        request_json: requestJson,
        normalized_payload_json: normalizedPayloadJson,
        tool_schemas_json: toolSchemasJson,
        content_references_json: contentReferencesJson,
        payload_hash: payloadHash,
        request_hash: requestHash,
        schema_hash: schemaHash,
        redactions_json: redactionsJson,
        unreconstructable_fields_json: unreconstructableFieldsJson,
        created_at: now,
      };
      const snapshot = requestSnapshotFromRow(row);
      this.database
        .prepare(
          `INSERT INTO request_snapshots(
             id, project_id, session_id, run_id, request_id, provider, model,
             adapter_version, serialization_version, assembly_version,
             request_json, normalized_payload_json, tool_schemas_json,
             content_references_json, payload_hash, request_hash, schema_hash,
             redactions_json, unreconstructable_fields_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.project_id,
          row.session_id,
          row.run_id,
          row.request_id,
          row.provider,
          row.model,
          row.adapter_version,
          row.serialization_version,
          row.assembly_version,
          row.request_json,
          row.normalized_payload_json,
          row.tool_schemas_json,
          row.content_references_json,
          row.payload_hash,
          row.request_hash,
          row.schema_hash,
          row.redactions_json,
          row.unreconstructable_fields_json,
          row.created_at,
        );
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        "request.prepared",
        { kind: "agent", id: "agent-runtime", runId },
        `request:${request.requestId}:prepare`,
        {
          runId,
          sessionId,
          snapshotId,
          requestId: request.requestId,
          provider: input.provider.id,
          model: request.model,
          payloadHash,
          requestHash,
          schemaHash,
        },
        now,
        runId,
      );
      return snapshot;
    });
  }

  getRequestSnapshot(snapshotId: string): RequestSnapshotRecord | null {
    const row = this.database
      .prepare("SELECT * FROM request_snapshots WHERE id = ?")
      .get(snapshotId) as RequestSnapshotRow | undefined;
    return row === undefined ? null : requestSnapshotFromRow(row);
  }

  listRequestSnapshots(runId: string): RequestSnapshotRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM request_snapshots
          WHERE run_id = ? ORDER BY rowid ASC`,
      )
      .all(runId) as unknown as RequestSnapshotRow[];
    return rows.map(requestSnapshotFromRow);
  }

  rebuildModelRequest(snapshotId: string): ModelRequest {
    const snapshot = this.getRequestSnapshot(snapshotId);
    if (snapshot === null) {
      throw new SessionStoreError(
        "REQUEST_SNAPSHOT_NOT_FOUND",
        "Request snapshot does not exist",
      );
    }
    return structuredClone(snapshot.request);
  }

  recordRunEvent(input: RecordRunEventInput): RuntimeEvent {
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const operationId = requireRuntimeId(input.operationId, "operationId");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId || run.status !== "running") {
        throw new SessionStoreError(
          "RUN_NOT_ACTIVE",
          "Run event cannot be appended to a missing or terminal run",
        );
      }
      const projectSeq = this.nextProjectSeq(projectId);
      const payload = { ...input.payload, runId };
      const eventId = this.insertEvent(
        projectId,
        projectSeq,
        input.type,
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        payload,
        now,
        runId,
      );
      return {
        id: eventId,
        projectId,
        projectSeq,
        runId,
        type: input.type,
        operationId,
        payload,
        occurredAt: now,
      };
    });
  }

  prepareRuntimeOperation(
    input: PrepareRuntimeOperationInput,
  ): RuntimeOperationRecord {
    const operationId = requireRuntimeId(input.operationId, "operationId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const inputHash = contentHash(canonicalJson(input.input));
    return this.runtimeWrite((now) => {
      const prior = this.database
        .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
        .get(operationId) as RuntimeOperationRow | undefined;
      if (prior !== undefined) {
        if (
          prior.input_hash !== inputHash ||
          prior.project_id !== projectId ||
          prior.run_id !== runId ||
          prior.kind !== input.kind ||
          prior.effect !== input.effect
        ) {
          throw new SessionStoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Runtime operation ID was already used with different input",
          );
        }
        return runtimeOperationFromRow(prior);
      }
      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId || run.status !== "running") {
        throw new SessionStoreError(
          "RUN_NOT_ACTIVE",
          "Runtime operation requires an active run",
        );
      }
      this.database
        .prepare(
          `INSERT INTO runtime_operations(
             operation_id, project_id, run_id, kind, effect, input_hash,
             state, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)`,
        )
        .run(
          operationId,
          projectId,
          runId,
          input.kind,
          input.effect,
          inputHash,
          now,
        );
      return runtimeOperationFromRow(
        this.database
          .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
          .get(operationId) as unknown as RuntimeOperationRow,
      );
    });
  }

  dispatchRuntimeOperation(
    input: DispatchRuntimeOperationInput,
  ): DispatchRuntimeOperationResult {
    const operationId = requireRuntimeId(input.operationId, "operationId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId || run.status !== "running") {
        throw new SessionStoreError(
          "RUN_NOT_ACTIVE",
          "Runtime operation dispatch requires an active run",
        );
      }
      const operationRow = this.database
        .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
        .get(operationId) as RuntimeOperationRow | undefined;
      if (
        operationRow === undefined ||
        operationRow.project_id !== projectId ||
        operationRow.run_id !== runId
      ) {
        throw new SessionStoreError(
          "RUNTIME_OPERATION_NOT_FOUND",
          "Prepared runtime operation does not exist in this run",
        );
      }
      if (
        operationRow.state !== "prepared" &&
        !(
          operationRow.state === "interrupted" &&
          operationRow.effect !== "external_side_effect"
        )
      ) {
        throw new SessionStoreError(
          "RUNTIME_OPERATION_NOT_DISPATCHABLE",
          "Runtime operation is not safe to dispatch",
        );
      }
      if (
        (operationRow.kind === "model_request" &&
          input.eventType !== "request.dispatch_attempted") ||
        (operationRow.kind === "tool_call" && input.eventType !== "tool.requested")
      ) {
        throw new SessionStoreError(
          "RUNTIME_EVENT_INVALID",
          "Dispatch event does not match runtime operation kind",
        );
      }

      const budgetUse = {
        modelRequests: requireCounter(
          input.budgetUse.modelRequests ?? 0,
          "budgetUse.modelRequests",
        ),
        toolCalls: requireCounter(
          input.budgetUse.toolCalls ?? 0,
          "budgetUse.toolCalls",
        ),
        retries: requireCounter(
          input.budgetUse.retries ?? 0,
          "budgetUse.retries",
        ),
        majorRevisions: requireCounter(
          input.budgetUse.majorRevisions ?? 0,
          "budgetUse.majorRevisions",
        ),
      };
      const retryAttempt = requireCounter(
        input.retryAttempt ?? 0,
        "retryAttempt",
      );
      if (
        (budgetUse.retries === 0 && retryAttempt !== 0) ||
        (budgetUse.retries > 0 && retryAttempt === 0)
      ) {
        throw new SessionStoreError(
          "RUNTIME_INPUT_INVALID",
          "retryAttempt must identify a retry budget use",
        );
      }
      const nextUsage: RunUsage = {
        ...run.usage,
        modelRequests: run.usage.modelRequests + budgetUse.modelRequests,
        toolCalls: run.usage.toolCalls + budgetUse.toolCalls,
        retries: run.usage.retries + budgetUse.retries,
        majorRevisions:
          run.usage.majorRevisions + budgetUse.majorRevisions,
      };
      const loopUsage = loopBudgetUsage(run, this.listRunEvents(runId));
      const exceeded =
        loopUsage.modelRequests + budgetUse.modelRequests > run.budget.maxModelRequests ||
        loopUsage.toolCalls + budgetUse.toolCalls > run.budget.maxToolCalls ||
        retryAttempt > run.budget.maxRetriesPerRequest ||
        loopUsage.majorRevisions + budgetUse.majorRevisions > run.budget.maxMajorRevisions;
      if (exceeded) {
        this.database
          .prepare(
            `UPDATE runtime_operations
                SET state = 'cancelled', completed_at = ?
              WHERE operation_id = ?`,
          )
          .run(now, operationId);
        this.database
          .prepare(
            `UPDATE runs
                SET status = 'budget_exhausted', stop_reason = 'BUDGET_EXHAUSTED',
                    completed_at = ?
              WHERE id = ?`,
          )
          .run(now, runId);
        const projectSeq = this.nextProjectSeq(projectId);
        this.insertEvent(
          projectId,
          projectSeq,
          "run.budget_exhausted",
          { kind: "agent", id: "agent-runtime", runId },
          operationId,
          { runId, attempted: budgetUse, budget: run.budget, usage: run.usage, loopUsage },
          now,
          runId,
        );
        return {
          dispatched: false,
          reason: "BUDGET_EXHAUSTED",
          operation: runtimeOperationFromRow(
            this.database
              .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
              .get(operationId) as unknown as RuntimeOperationRow,
          ),
          run: this.getRun(runId)!,
        };
      }

      this.database
        .prepare("UPDATE runs SET usage_json = ? WHERE id = ?")
        .run(canonicalJson(nextUsage), runId);
      this.database
        .prepare(
          `UPDATE runtime_operations
              SET state = 'dispatched', dispatched_at = ?, completed_at = NULL
            WHERE operation_id = ?`,
        )
        .run(now, operationId);
      this.faultInjector?.("after_runtime_operation_dispatch");
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        input.eventType,
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        { ...input.eventPayload, runId },
        now,
        runId,
      );
      return {
        dispatched: true,
        operation: runtimeOperationFromRow(
          this.database
            .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
            .get(operationId) as unknown as RuntimeOperationRow,
        ),
        run: this.getRun(runId)!,
      };
    });
  }

  settleRuntimeOperation(
    input: SettleRuntimeOperationInput,
  ): RuntimeOperationRecord {
    const operationId = requireRuntimeId(input.operationId, "operationId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      const operationRow = this.database
        .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
        .get(operationId) as RuntimeOperationRow | undefined;
      if (
        run === null ||
        run.projectId !== projectId ||
        operationRow === undefined ||
        operationRow.project_id !== projectId ||
        operationRow.run_id !== runId
      ) {
        throw new SessionStoreError(
          "RUNTIME_OPERATION_NOT_FOUND",
          "Runtime operation does not exist in this run",
        );
      }
      if (run.status === "cancelled") {
        if (operationRow.state === "dispatched") {
          this.database
            .prepare(
              `UPDATE runtime_operations
                  SET state = 'cancelled', completed_at = ?
                WHERE operation_id = ?`,
            )
            .run(now, operationId);
        }
        return runtimeOperationFromRow(
          this.database
            .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
            .get(operationId) as unknown as RuntimeOperationRow,
        );
      }
      if (run.status !== "running" || operationRow.state !== "dispatched") {
        if (operationRow.state === input.state) {
          return runtimeOperationFromRow(operationRow);
        }
        throw new SessionStoreError(
          "RUNTIME_OPERATION_NOT_SETTLEABLE",
          "Runtime operation is not awaiting a result",
        );
      }

      const resultJson =
        input.result === undefined ? null : canonicalJson(input.result);
      const errorJson =
        input.error === undefined ? null : canonicalJson(input.error);
      this.database
        .prepare(
          `UPDATE runtime_operations
              SET state = ?, result_json = ?, error_json = ?, completed_at = ?
            WHERE operation_id = ?`,
        )
        .run(input.state, resultJson, errorJson, now, operationId);

      if (operationRow.kind === "model_request") {
        const nextUsage = usageAfterModelAttempt(run.usage, input.tokenUsage);
        this.database
          .prepare("UPDATE runs SET usage_json = ? WHERE id = ?")
          .run(canonicalJson(nextUsage), runId);
      }
      if (input.state === "unknown_outcome") {
        this.database
          .prepare(
            `UPDATE runs
                SET status = 'waiting_user',
                    stop_reason = 'UNKNOWN_EXTERNAL_OUTCOME'
              WHERE id = ?`,
          )
          .run(runId);
      }
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        input.eventType,
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        { ...input.eventPayload, runId },
        now,
        runId,
      );
      return runtimeOperationFromRow(
        this.database
          .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
          .get(operationId) as unknown as RuntimeOperationRow,
      );
    });
  }

  listRuntimeOperations(runId: string): RuntimeOperationRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM runtime_operations WHERE run_id = ? ORDER BY rowid ASC",
      )
      .all(runId) as unknown as RuntimeOperationRow[];
    return rows.map(runtimeOperationFromRow);
  }

  recoverProjectRuns(projectIdInput: string): RecoveredRun[] {
    const projectId = requireRuntimeId(projectIdInput, "projectId");
    return this.runtimeWrite((now) => {
      const rows = this.database
        .prepare(
          "SELECT * FROM runs WHERE project_id = ? AND status = 'running' ORDER BY rowid ASC",
        )
        .all(projectId) as unknown as RunRow[];
      const recovered: RecoveredRun[] = [];
      for (const row of rows) {
        const runId = row.id;
        this.database
          .prepare(
            `UPDATE runs
                SET status = 'interrupted', stop_reason = 'PROCESS_INTERRUPTED'
              WHERE id = ?`,
          )
          .run(runId);
        let projectSeq = this.nextProjectSeq(projectId);
        this.insertEvent(
          projectId,
          projectSeq,
          "run.interrupted",
          { kind: "agent", id: "runtime-recovery", runId },
          `run:${runId}:recover`,
          { runId, reason: "PROCESS_INTERRUPTED" },
          now,
          runId,
        );

        const dispatched = this.database
          .prepare(
            "SELECT * FROM runtime_operations WHERE run_id = ? AND state = 'dispatched' ORDER BY rowid ASC",
          )
          .all(runId) as unknown as RuntimeOperationRow[];
        const unknownOperationIds: string[] = [];
        for (const operation of dispatched) {
          if (operation.effect !== "external_side_effect") {
            this.database
              .prepare(
                "UPDATE runtime_operations SET state = 'interrupted' WHERE operation_id = ?",
              )
              .run(operation.operation_id);
            continue;
          }
          unknownOperationIds.push(operation.operation_id);
          this.database
            .prepare(
              `UPDATE runtime_operations
                  SET state = 'unknown_outcome', completed_at = ?
                WHERE operation_id = ?`,
            )
            .run(now, operation.operation_id);
          projectSeq = this.nextProjectSeq(projectId);
          const eventType =
            operation.kind === "tool_call"
              ? "tool.outcome_unknown"
              : "request.outcome_unknown";
          this.insertEvent(
            projectId,
            projectSeq,
            eventType,
            { kind: "agent", id: "runtime-recovery", runId },
            operation.operation_id,
            { runId, operationId: operation.operation_id },
            now,
            runId,
          );
        }
        const status =
          unknownOperationIds.length === 0 ? "interrupted" : "waiting_user";
        if (status === "waiting_user") {
          this.database
            .prepare(
              `UPDATE runs
                  SET status = 'waiting_user',
                      stop_reason = 'UNKNOWN_EXTERNAL_OUTCOME'
                WHERE id = ?`,
            )
            .run(runId);
        }
        recovered.push({ runId, status, unknownOperationIds });
      }
      return recovered;
    });
  }

  pauseRun(input: PauseRunInput): RunRecord {
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const operationId = requireRuntimeId(input.operationId, "operationId");
    const reason = requireRuntimeId(input.reason, "reason");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId || run.status !== "running") {
        throw new SessionStoreError(
          "RUN_NOT_ACTIVE",
          "Only an active run can wait for user confirmation",
        );
      }
      this.database
        .prepare(
          `UPDATE runs
              SET status = 'waiting_user', stop_reason = ?, completed_at = NULL
            WHERE id = ?`,
        )
        .run(reason, runId);
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        "run.waiting_user",
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        { ...input.payload, runId, stopReason: reason },
        now,
        runId,
      );
      return {
        ...run,
        status: "waiting_user",
        lastCommittedEventSeq: projectSeq,
        stopReason: reason,
        completedAt: null,
      };
    });
  }

  resumeRun(input: ResumeRunInput): RunRecord {
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const operationId = requireRuntimeId(input.operationId, "operationId");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (
        run === null ||
        run.projectId !== projectId ||
        (run.status !== "interrupted" && run.status !== "waiting_user" && !(run.status === "budget_exhausted" && input.refreshLoopAllowance === true))
      ) {
        throw new SessionStoreError(
          "RUN_NOT_RESUMABLE",
          "Run is not in a resumable recovery state",
        );
      }
      const unknownCount = Number(
        (
          this.database
            .prepare(
              `SELECT COUNT(*) AS count FROM runtime_operations
                WHERE run_id = ? AND state = 'unknown_outcome'`,
            )
            .get(runId) as { count: number }
        ).count,
      );
      if (unknownCount > 0 && input.decision !== "retry_unknown") {
        throw new SessionStoreError(
          "UNKNOWN_EXTERNAL_OUTCOME",
          "Unknown external outcomes require an explicit retry decision",
        );
      }
      if (unknownCount > 0 && input.decision === "retry_unknown") {
        this.database
          .prepare(
            `UPDATE runtime_operations
                SET state = 'abandoned'
              WHERE run_id = ? AND state = 'unknown_outcome'`,
          )
          .run(runId);
      }
      this.database
        .prepare(
          `UPDATE runs
              SET status = 'running', stop_reason = NULL, completed_at = NULL
            WHERE id = ?`,
        )
        .run(runId);
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        "run.resumed",
        { kind: "agent", id: "runtime-recovery", runId },
        operationId,
        {
          runId,
          decision: input.decision,
          ...(input.checkpointDecision ? { checkpointDecision: input.checkpointDecision } : {}),
          ...(input.factSearchDecision ? { factSearchDecision: input.factSearchDecision } : {}),
          ...(input.refreshLoopAllowance ? { loopAllowanceBaseline: { modelRequests: run.usage.modelRequests, toolCalls: run.usage.toolCalls, majorRevisions: run.usage.majorRevisions } } : {}),
          ...(input.preservePendingAssignment ? { preservePendingAssignment: true } : {}),
          unknownOperationCount: unknownCount,
          ...(input.displayInstruction === undefined
            ? {}
            : { displayInstruction: input.displayInstruction }),
        },
        now,
        runId,
      );
      return this.getRun(runId)!;
    });
  }

  cancelRun(input: CancelRunInput): RunRecord {
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const operationId = requireRuntimeId(input.operationId, "operationId");
    const reason = requireRuntimeId(input.reason, "reason");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId) {
        throw new SessionStoreError("RUN_NOT_FOUND", "Run does not exist");
      }
      if (run.status === "cancelled") return run;
      if (
        run.status === "completed" ||
        run.status === "failed"
      ) {
        throw new SessionStoreError(
          "RUN_NOT_CANCELLABLE",
          "Terminal run cannot be cancelled",
        );
      }
      this.database
        .prepare(
          `UPDATE runs
              SET status = 'cancelled', stop_reason = ?, completed_at = ?
            WHERE id = ?`,
        )
        .run(reason, now, runId);
      this.database
        .prepare(
          `UPDATE runtime_operations
              SET state = 'cancelled', completed_at = ?
            WHERE run_id = ?
              AND state IN ('prepared', 'dispatched', 'interrupted')`,
        )
        .run(now, runId);
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        "run.cancelled",
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        { runId, stopReason: reason },
        now,
        runId,
      );
      return this.getRun(runId)!;
    });
  }

  reserveMajorRevision(
    input: ReserveMajorRevisionInput,
  ): ReserveMajorRevisionResult {
    const operationId = requireRuntimeId(input.operationId, "operationId");
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const reason = requireRuntimeId(input.reason, "reason");
    const inputHash = contentHash(
      canonicalJson({ projectId, runId, reason, kind: "major_revision" }),
    );
    return this.runtimeWrite((now) => {
      const prior = this.database
        .prepare("SELECT * FROM runtime_operations WHERE operation_id = ?")
        .get(operationId) as unknown as RuntimeOperationRow | undefined;
      if (prior !== undefined) {
        if (
          prior.input_hash !== inputHash ||
          prior.project_id !== projectId ||
          prior.run_id !== runId ||
          prior.kind !== "major_revision"
        ) {
          throw new SessionStoreError(
            "IDEMPOTENCY_KEY_REUSED",
            "Runtime operation ID was already used with different input",
          );
        }
        if (prior.result_json === null) {
          throw new SessionStoreError(
            "RUNTIME_OPERATION_INCOMPLETE",
            "Major revision reservation has no committed result",
          );
        }
        return JSON.parse(prior.result_json) as ReserveMajorRevisionResult;
      }

      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId || run.status !== "running") {
        throw new SessionStoreError(
          "RUN_NOT_ACTIVE",
          "Major revision budget requires an active run",
        );
      }
      const nextCount = run.usage.majorRevisions + 1;
      if (loopBudgetUsage(run, this.listRunEvents(runId)).majorRevisions + 1 > run.budget.maxMajorRevisions) {
        const result: ReserveMajorRevisionResult = {
          reserved: false,
          operationId,
          reason: "BUDGET_EXHAUSTED",
          majorRevisions: run.usage.majorRevisions,
        };
        this.database
          .prepare(
            `INSERT INTO runtime_operations(
               operation_id, project_id, run_id, kind, effect, input_hash,
               state, result_json, error_json, created_at, completed_at
             ) VALUES (?, ?, ?, 'major_revision', 'local_idempotent', ?,
                       'cancelled', ?, ?, ?, ?)`,
          )
          .run(
            operationId,
            projectId,
            runId,
            inputHash,
            canonicalJson(result),
            canonicalJson({ code: "BUDGET_EXHAUSTED" }),
            now,
            now,
          );
        this.database
          .prepare(
            `UPDATE runs
                SET status = 'budget_exhausted', stop_reason = 'BUDGET_EXHAUSTED',
                    completed_at = ?
              WHERE id = ?`,
          )
          .run(now, runId);
        const projectSeq = this.nextProjectSeq(projectId);
        this.insertEvent(
          projectId,
          projectSeq,
          "run.budget_exhausted",
          { kind: "agent", id: "agent-runtime", runId },
          operationId,
          { runId, attempted: { majorRevisions: 1 }, budget: run.budget },
          now,
          runId,
        );
        return result;
      }

      const result: ReserveMajorRevisionResult = {
        reserved: true,
        operationId,
        majorRevisions: nextCount,
      };
      const nextUsage: RunUsage = {
        ...run.usage,
        majorRevisions: nextCount,
      };
      this.database
        .prepare("UPDATE runs SET usage_json = ? WHERE id = ?")
        .run(canonicalJson(nextUsage), runId);
      this.database
        .prepare(
          `INSERT INTO runtime_operations(
             operation_id, project_id, run_id, kind, effect, input_hash,
             state, result_json, created_at, dispatched_at, completed_at
           ) VALUES (?, ?, ?, 'major_revision', 'local_idempotent', ?,
                     'completed', ?, ?, ?, ?)`,
        )
        .run(
          operationId,
          projectId,
          runId,
          inputHash,
          canonicalJson(result),
          now,
          now,
          now,
        );
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        "budget.major_revision_reserved",
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        { runId, reason, majorRevisions: nextCount },
        now,
        runId,
      );
      return result;
    });
  }

  finishRun(input: FinishRunInput): RunRecord {
    const projectId = requireRuntimeId(input.projectId, "projectId");
    const runId = requireRuntimeId(input.runId, "runId");
    const operationId = requireRuntimeId(input.operationId, "operationId");
    return this.runtimeWrite((now) => {
      const run = this.getRun(runId);
      if (run === null || run.projectId !== projectId || run.status !== "running") {
        throw new SessionStoreError(
          "RUN_NOT_ACTIVE",
          "Only an active run can enter a terminal state",
        );
      }
      this.database
        .prepare(
          `UPDATE runs
              SET status = ?, stop_reason = ?, completed_at = ?
            WHERE id = ?`,
        )
        .run(input.status, input.stopReason, now, runId);
      const eventType = `run.${input.status}`;
      const projectSeq = this.nextProjectSeq(projectId);
      this.insertEvent(
        projectId,
        projectSeq,
        eventType,
        { kind: "agent", id: "agent-runtime", runId },
        operationId,
        { ...input.payload, runId, stopReason: input.stopReason },
        now,
        runId,
      );
      return {
        ...run,
        status: input.status,
        lastCommittedEventSeq: projectSeq,
        stopReason: input.stopReason,
        completedAt: now,
      };
    });
  }

  listRunEvents(runId: string): RuntimeEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY project_seq ASC")
      .all(runId) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectSeq: row.project_seq,
      runId,
      type: row.type,
      operationId: row.operation_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    }));
  }

  private runMutation<T>(
    operationId: string,
    projectId: string,
    commandType: string,
    command: unknown,
    action: (now: string) => MutationAction<T>,
  ): MutationResult<T> {
    if (this.readOnly) {
      return failure(
        operationId,
        "STORAGE_READ_ONLY",
        "Workspace storage was opened in read-only mode",
      );
    }
    const inputHash = contentHash(canonicalJson(command));
    const now = this.clock();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const prior = this.database
        .prepare(
          `SELECT input_hash, state, result_json
             FROM operations WHERE operation_id = ?`,
        )
        .get(operationId) as OperationRow | undefined;
      if (prior !== undefined) {
        this.database.exec("ROLLBACK");
        if (prior.input_hash !== inputHash) {
          return failure(
            operationId,
            "IDEMPOTENCY_KEY_REUSED",
            "Operation ID was already used with different input",
          );
        }
        if (prior.state === "completed" && prior.result_json !== null) {
          return JSON.parse(prior.result_json) as MutationResult<T>;
        }
        return failure(
          operationId,
          "OPERATION_INCOMPLETE",
          "A prior attempt with this operation ID did not complete",
          true,
        );
      }

      this.database
        .prepare(
          `INSERT INTO operations(
             operation_id, project_id, command_type, input_hash, state, created_at
           ) VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(operationId, projectId, commandType, inputHash, now);

      const outcome = action(now);
      if (!outcome.ok) {
        const response = failure(
          operationId,
          outcome.code,
          outcome.message,
          outcome.retryable,
          outcome.details,
        );
        if (outcome.commit === true) {
          this.database
            .prepare(
              `UPDATE operations
                  SET state = 'completed', result_json = ?, completed_at = ?
                WHERE operation_id = ?`,
            )
            .run(canonicalJson(response), now, operationId);
          this.faultInjector?.("before_transaction_commit");
          this.database.exec("COMMIT");
          return response;
        }
        this.database.exec("ROLLBACK");
        return response;
      }

      const response: MutationResult<T> = {
        ok: true,
        projectRevision: outcome.projectRevision,
        operationId,
        result: outcome.result,
      };
      this.database
        .prepare(
          `UPDATE operations
              SET state = 'completed', result_json = ?, completed_at = ?
            WHERE operation_id = ?`,
        )
        .run(canonicalJson(response), now, operationId);
      this.faultInjector?.("before_transaction_commit");
      this.database.exec("COMMIT");
      return response;
    } catch (error) {
      this.rollbackQuietly();
      return failure(
        operationId,
        "STORAGE_WRITE_FAILED",
        "The workspace change could not be committed",
        true,
        {
          causeCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "UNKNOWN",
        },
      );
    }
  }

  createProject(
    commandInput: CreateProjectCommand,
  ): MutationResult<{ projectId: string; revision: number }> {
    const parsed = CreateProjectCommandSchema.safeParse(commandInput);
    const operationId = commandInput.operationId;
    if (!parsed.success) {
      return failure(
        operationId,
        "INVALID_COMMAND",
        "Create project command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "create_project",
      command,
      (now) => {
        const existing = this.database
          .prepare("SELECT id FROM projects WHERE id = ?")
          .get(command.projectId);
        if (existing !== undefined) {
          return actionFailure(
            "PROJECT_ALREADY_EXISTS",
            "A project with this ID already exists",
          );
        }
        this.database
          .prepare(
            `INSERT INTO projects(
               id, name, name_source, mode, schema_version, revision, fact_gate_status,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 0, 'not_checked', ?, ?)`,
          )
          .run(
            command.projectId,
            command.name,
            command.nameSource,
            command.mode,
            CURRENT_SCHEMA_VERSION,
            now,
            now,
          );
        this.insertEvent(
          command.projectId,
          1,
          "project.created",
          command.actor,
          command.operationId,
          { name: command.name, mode: command.mode },
          now,
        );
        return {
          ok: true,
          projectRevision: 0,
          result: { projectId: command.projectId, revision: 0 },
        };
      },
    );
  }

  renameProject(
    commandInput: RenameProjectCommand,
  ): MutationResult<{
    projectId: string;
    name: string;
    applied: boolean;
  }> {
    const parsed = RenameProjectCommandSchema.safeParse(commandInput);
    const operationId = commandInput.operationId;
    if (!parsed.success) {
      return failure(
        operationId,
        "INVALID_COMMAND",
        "Rename project command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation<{
      projectId: string;
      name: string;
      applied: boolean;
    }>(
      command.operationId,
      command.projectId,
      "rename_project",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (command.source === "agent" && project.name_source !== "placeholder") {
          return {
            ok: true,
            projectRevision: project.revision,
            result: {
              projectId: project.id,
              name: project.name,
              applied: false,
            },
          };
        }
        const nextNameSource = command.source;
        if (project.name === command.name && project.name_source === nextNameSource) {
          return {
            ok: true,
            projectRevision: project.revision,
            result: {
              projectId: project.id,
              name: project.name,
              applied: false,
            },
          };
        }
        const nextRevision = project.revision + 1;
        this.database.prepare(
          `UPDATE projects
              SET name = ?, name_source = ?, revision = ?, updated_at = ?
            WHERE id = ?`,
        ).run(command.name, nextNameSource, nextRevision, now, command.projectId);
        this.insertEvent(
          command.projectId,
          this.nextProjectSeq(command.projectId),
          "project.renamed",
          command.actor,
          command.operationId,
          {
            previousName: project.name,
            name: command.name,
            source: nextNameSource,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: nextRevision,
          result: {
            projectId: command.projectId,
            name: command.name,
            applied: true,
          },
        };
      },
    );
  }

  importMaterial(
    commandInput: ImportMaterialCommand,
  ): MutationResult<{
    materialId: string;
    contentVersionId: string;
    hash: string;
  }> {
    const parsed = ImportMaterialCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Import material command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "import_material",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "PROJECT_REVISION_CONFLICT",
            "Project changed after the material import was prepared",
            true,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        if (
          this.database.prepare("SELECT id FROM materials WHERE id = ?").get(
            command.materialId,
          ) !== undefined
        ) {
          return actionFailure(
            "MATERIAL_ALREADY_EXISTS",
            "A material with this ID already exists",
          );
        }

        const materialHash = contentHash(command.content);
        const contentVersionId = this.idFactory();
        const projectSeq = this.nextProjectSeq(command.projectId);
        this.database
          .prepare(
            `INSERT INTO materials(
               id, project_id, display_name, source_kind, source_reference,
               role, trust_label, permission_scope, content_version_id,
               content, content_hash, imported_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            command.materialId,
            command.projectId,
            command.displayName,
            command.sourceKind,
            command.sourceReference,
            command.role,
            command.trustLabel,
            command.permissionScope,
            contentVersionId,
            command.content,
            materialHash,
            now,
          );
        const update = this.database
          .prepare(
            `UPDATE projects
                SET revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(now, command.projectId, command.expectedProjectRevision);
        if (Number(update.changes) !== 1) {
          throw new Error("Project revision changed during material import");
        }
        this.insertEvent(
          command.projectId,
          projectSeq,
          "material.imported",
          command.actor,
          command.operationId,
          {
            materialId: command.materialId,
            contentVersionId,
            hash: materialHash,
            sourceKind: command.sourceKind,
            role: command.role,
            permissionScope: command.permissionScope,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: {
            materialId: command.materialId,
            contentVersionId,
            hash: materialHash,
          },
        };
      },
    );
  }

  saveWritingBrief(
    commandInput: SaveWritingBriefCommand,
  ): MutationResult<WritingBriefCommitResult> {
    const parsed = SaveWritingBriefCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Save writing brief command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation<WritingBriefCommitResult>(
      command.operationId,
      command.projectId,
      "save_writing_brief",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "PROJECT_REVISION_CONFLICT",
            "Project changed after the writing brief was prepared",
            true,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        if (project.current_brief_version_id !== command.baseVersionId) {
          return actionFailure(
            "BASE_VERSION_CONFLICT",
            "Writing brief changed after the command was prepared",
            true,
            {
              expected: command.baseVersionId,
              actual: project.current_brief_version_id,
            },
          );
        }

        const materials = new Map(
          command.brief.materialIds.map((materialId) => [
            materialId,
            this.getMaterial(command.projectId, materialId),
          ]),
        );
        if ([...materials.values()].some((material) => material === null)) {
          return actionFailure(
            "MATERIAL_SCOPE_INVALID",
            "Writing brief references material outside this project",
          );
        }
        for (const materialId of command.brief.authorAuthorization
          .firsthandMaterialIds) {
          if (materials.get(materialId)?.role !== "user_firsthand") {
            return actionFailure(
              "AUTHOR_MATERIAL_AUTHORIZATION_INVALID",
              "Only explicitly first-hand material can authorize author experience",
            );
          }
        }

        const briefJson = canonicalJson(command.brief);
        const briefHash = contentHash(briefJson);
        if (command.baseVersionId !== null) {
          const current = this.database
            .prepare(
              `SELECT content_hash, brief_json
                 FROM writing_brief_versions WHERE id = ? AND project_id = ?`,
            )
            .get(command.baseVersionId, command.projectId) as
            | { content_hash: string; brief_json: string }
            | undefined;
          if (
            current !== undefined &&
            current.content_hash === briefHash &&
            current.brief_json === briefJson
          ) {
            return {
              ok: true,
              projectRevision: project.revision,
              result: {
                status: "no_change",
                versionId: command.baseVersionId,
                contentHash: briefHash,
              },
            };
          }
        }

        const projectSeq = this.nextProjectSeq(command.projectId);
        const versionId = this.idFactory();
        this.database
          .prepare(
            `INSERT INTO writing_brief_versions(
               id, project_id, brief_json, content_hash, parent_version_id,
               actor_json, operation_id, created_event_seq, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            versionId,
            command.projectId,
            briefJson,
            briefHash,
            command.baseVersionId,
            canonicalJson(command.actor),
            command.operationId,
            projectSeq,
            now,
          );
        const update = this.database
          .prepare(
            `UPDATE projects
                SET current_brief_version_id = ?, revision = revision + 1,
                    updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(
            versionId,
            now,
            command.projectId,
            command.expectedProjectRevision,
          );
        if (Number(update.changes) !== 1) {
          throw new Error("Project revision changed during writing brief save");
        }
        this.insertEvent(
          command.projectId,
          projectSeq,
          command.brief.confirmationStatus === "confirmed"
            ? "brief.confirmed"
            : "brief.saved",
          command.actor,
          command.operationId,
          {
            versionId,
            contentHash: briefHash,
            confirmationStatus: command.brief.confirmationStatus,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: { status: "created", versionId, contentHash: briefHash },
        };
      },
    );
  }

  recordDecision(
    commandInput: RecordDecisionCommand,
  ): MutationResult<{ decisionId: string }> {
    const parsed = RecordDecisionCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Record decision command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "record_decision",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "PROJECT_REVISION_CONFLICT",
            "Project changed after the decision was prepared",
            true,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        if (
          this.database.prepare("SELECT id FROM decisions WHERE id = ?").get(
            command.decisionId,
          ) !== undefined
        ) {
          return actionFailure(
            "DECISION_ALREADY_EXISTS",
            "A decision with this ID already exists",
          );
        }

        const projectSeq = this.nextProjectSeq(command.projectId);
        this.database
          .prepare(
            `INSERT INTO decisions(
               id, project_id, type, value_json, scope, actor_json,
               source_event_id, active, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .run(
            command.decisionId,
            command.projectId,
            command.type,
            canonicalJson(command.value),
            command.scope,
            canonicalJson(command.actor),
            command.sourceEventId,
            now,
          );
        const update = this.database
          .prepare(
            `UPDATE projects
                SET revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(now, command.projectId, command.expectedProjectRevision);
        if (Number(update.changes) !== 1) {
          throw new Error("Project revision changed during decision recording");
        }
        this.insertEvent(
          command.projectId,
          projectSeq,
          "decision.recorded",
          command.actor,
          command.operationId,
          {
            decisionId: command.decisionId,
            type: command.type,
            scope: command.scope,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: { decisionId: command.decisionId },
        };
      },
    );
  }

  commitArtifactVersion(
    commandInput: CommitArtifactVersionCommand,
  ): MutationResult<ArtifactVersionCommitResult> {
    const parsed = CommitArtifactVersionCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Commit artifact version command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "commit_artifact_version",
      command,
      (now) =>
        this.commitVersionInTransaction(
          {
            ...command,
            eventType: "artifact.version_committed",
            parentVersionIds:
              command.baseVersionId === null ? [] : [command.baseVersionId],
            allowSameContent: false,
          },
          now,
        ),
    );
  }

  rollbackArtifactVersion(
    commandInput: RollbackArtifactVersionCommand,
  ): MutationResult<ArtifactVersionCommitResult> {
    const parsed = RollbackArtifactVersionCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Rollback artifact version command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "rollback_artifact_version",
      command,
      (now) => {
        if (command.targetVersionId === command.baseVersionId) {
          return actionFailure(
            "INVALID_ROLLBACK_TARGET",
            "Rollback target is already the current version",
          );
        }
        const target = this.database
          .prepare(
            `SELECT * FROM artifact_versions
              WHERE id = ? AND project_id = ? AND kind = ? AND logical_key = ?`,
          )
          .get(
            command.targetVersionId,
            command.projectId,
            command.kind,
            command.logicalKey,
          ) as ArtifactVersionRow | undefined;
        if (target === undefined) {
          return actionFailure(
            "ROLLBACK_TARGET_NOT_FOUND",
            "Rollback target does not belong to this artifact",
          );
        }
        return this.commitVersionInTransaction(
          {
            ...command,
            content: target.content,
            eventType: "artifact.rolled_back",
            parentVersionIds: [command.baseVersionId, command.targetVersionId],
            allowSameContent: true,
          },
          now,
        );
      },
    );
  }

  saveBody(
    commandInput: SaveBodyCommand,
  ): MutationResult<ArtifactVersionCommitResult> {
    const parsed = SaveBodyCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Save body command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "body.save",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (
          project.revision !== command.expectedProjectRevision ||
          project.latest_body_version_id !== command.baseBodyVersionId
        ) {
          return actionFailure(
            "REVISION_CONFLICT",
            "Body changed after the manual edit was prepared",
            false,
            {
              expectedProjectRevision: command.expectedProjectRevision,
              actualProjectRevision: project.revision,
              expectedBodyVersionId: command.baseBodyVersionId,
              actualBodyVersionId: project.latest_body_version_id,
            },
          );
        }
        return this.commitVersionInTransaction(
          {
            operationId: command.operationId,
            projectId: command.projectId,
            expectedProjectRevision: command.expectedProjectRevision,
            actor: command.actor,
            kind: "body",
            logicalKey: "main",
            baseVersionId: command.baseBodyVersionId,
            content: command.content,
            reason: command.reason,
            requestSnapshotId: null,
            eventType: "artifact.version_committed",
            parentVersionIds: [command.baseBodyVersionId],
            allowSameContent: false,
          },
          now,
        );
      },
    );
  }

  proposeRevision(
    commandInput: ProposeRevisionCommand,
  ): MutationResult<RevisionProposalResult> {
    const parsed = ProposeRevisionCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Revision proposal command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "revision.propose",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (
          project.revision !== command.expectedProjectRevision ||
          project.latest_body_version_id !== command.baseBodyVersionId
        ) {
          return actionFailure(
            "REVISION_CONFLICT",
            "Body changed after the revision request was prepared",
            false,
            {
              expectedProjectRevision: command.expectedProjectRevision,
              actualProjectRevision: project.revision,
              expectedBodyVersionId: command.baseBodyVersionId,
              actualBodyVersionId: project.latest_body_version_id,
            },
          );
        }
        if (
          this.database.prepare("SELECT id FROM revision_proposals WHERE id = ?").get(
            command.proposalId,
          ) !== undefined
        ) {
          return actionFailure(
            "PROPOSAL_ID_EXISTS",
            "A revision proposal with this ID already exists",
          );
        }
        const base = this.getBodyDocument(command.baseBodyVersionId);
        if (base === null) {
          return actionFailure(
            "BODY_DOCUMENT_MISSING",
            "Base body block metadata is unavailable",
          );
        }
        let diff: RevisionDiffEntry[];
        try {
          diff = revisionDiff(base, command.edits);
          applyRevisionEdits(
            `proposal:${command.proposalId}`,
            base,
            command.edits,
            command.proposalId,
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : "REVISION_INVALID";
          return actionFailure(
            code === "BLOCK_HASH_CONFLICT" || code === "BLOCK_NOT_FOUND"
              ? "REVISION_CONFLICT"
              : "REVISION_INVALID",
            "Revision edits do not match the base body blocks",
          );
        }
        const lockedIds = new Set(
          this.activeBlockLockRows(command.projectId).map((row) => row.block_id),
        );
        const lockedEdit = command.edits.find(
          (edit) =>
            edit.type !== "insert_before" &&
            edit.type !== "insert_after" &&
            lockedIds.has(edit.targetBlockId),
        );
        if (lockedEdit !== undefined) {
          return actionFailure(
            "LOCK_CONFLICT",
            "Revision proposal modifies a locked block",
            false,
            { blockId: lockedEdit.targetBlockId },
          );
        }

        const projectSeq = this.nextProjectSeq(command.projectId);
        this.database
          .prepare(
            `INSERT INTO revision_proposals(
               id, project_id, base_body_version_id, base_project_revision,
               instruction, constraints_json, edits_json, diff_json,
               requested_by_json, status, created_event_seq, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
          )
          .run(
            command.proposalId,
            command.projectId,
            command.baseBodyVersionId,
            command.expectedProjectRevision,
            command.instruction,
            canonicalJson(command.constraints),
            canonicalJson(command.edits),
            canonicalJson(diff),
            canonicalJson(command.actor),
            projectSeq,
            now,
          );
        const updated = this.database
          .prepare(
            `UPDATE projects
                SET revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(now, command.projectId, command.expectedProjectRevision);
        if (Number(updated.changes) !== 1) {
          throw new Error("Project revision changed during proposal creation");
        }
        this.insertEvent(
          command.projectId,
          projectSeq,
          "revision.proposed",
          command.actor,
          command.operationId,
          {
            proposalId: command.proposalId,
            baseBodyVersionId: command.baseBodyVersionId,
            targetBlockIds: command.edits.map((edit) => edit.targetBlockId),
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: {
            proposalId: command.proposalId,
            status: "proposed",
            diff,
          },
        };
      },
    );
  }

  acceptRevisionProposal(
    commandInput: AcceptRevisionProposalCommand,
  ): MutationResult<ArtifactVersionCommitResult & { proposalId: string }> {
    const parsed = AcceptRevisionProposalCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Accept revision proposal command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "revision.accept",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "REVISION_CONFLICT",
            "Project changed after proposal acceptance was prepared",
            false,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        const proposalRow = this.database
          .prepare("SELECT * FROM revision_proposals WHERE id = ? AND project_id = ?")
          .get(command.proposalId, command.projectId) as
          | RevisionProposalRow
          | undefined;
        if (proposalRow === undefined) {
          return actionFailure("PROPOSAL_NOT_FOUND", "Revision proposal does not exist");
        }
        if (proposalRow.status !== "proposed") {
          return actionFailure(
            "PROPOSAL_NOT_PENDING",
            "Revision proposal is no longer pending",
            false,
            { status: proposalRow.status },
          );
        }
        if (project.latest_body_version_id !== proposalRow.base_body_version_id) {
          this.markProposalConflicted(
            proposalRow,
            "REVISION_CONFLICT",
            command.actor,
            command.operationId,
            now,
          );
          return actionFailure(
            "REVISION_CONFLICT",
            "Revision proposal is based on an outdated body version",
            false,
            {
              expected: proposalRow.base_body_version_id,
              actual: project.latest_body_version_id,
            },
            true,
          );
        }
        const base = this.getBodyDocument(proposalRow.base_body_version_id);
        if (base === null) {
          return actionFailure(
            "BODY_DOCUMENT_MISSING",
            "Base body block metadata is unavailable",
          );
        }
        const edits = JSON.parse(proposalRow.edits_json) as RevisionEdit[];
        let proposed: BodyDocument;
        try {
          proposed = applyRevisionEdits(
            `proposal:${proposalRow.id}`,
            base,
            edits,
            proposalRow.id,
          );
        } catch {
          this.markProposalConflicted(
            proposalRow,
            "REVISION_CONFLICT",
            command.actor,
            command.operationId,
            now,
          );
          return actionFailure(
            "REVISION_CONFLICT",
            "Revision proposal no longer matches its base blocks",
            false,
            {},
            true,
          );
        }
        const committed = this.commitVersionInTransaction(
          {
            operationId: command.operationId,
            projectId: command.projectId,
            expectedProjectRevision: command.expectedProjectRevision,
            actor: command.actor,
            kind: "body",
            logicalKey: "main",
            baseVersionId: proposalRow.base_body_version_id,
            content: proposed.content,
            reason: `accepted revision proposal: ${proposalRow.instruction}`,
            requestSnapshotId: null,
            eventType: "artifact.version_committed",
            parentVersionIds: [proposalRow.base_body_version_id],
            allowSameContent: false,
            bodyBlocks: proposed.blocks,
          },
          now,
        );
        if (!committed.ok) {
          if (committed.code === "LOCK_CONFLICT") {
            this.markProposalConflicted(
              proposalRow,
              "LOCK_CONFLICT",
              command.actor,
              command.operationId,
              now,
            );
            return actionFailure(
              "LOCK_CONFLICT",
              committed.message,
              false,
              committed.details,
              true,
            );
          }
          return committed;
        }
        let projectRevision = committed.projectRevision;
        if (committed.result.status === "no_change") {
          const updated = this.database
            .prepare(
              `UPDATE projects
                  SET revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
            )
            .run(now, command.projectId, command.expectedProjectRevision);
          if (Number(updated.changes) !== 1) {
            throw new Error("Project revision changed during no-op proposal acceptance");
          }
          projectRevision += 1;
        }
        this.database
          .prepare(
            `UPDATE revision_proposals
                SET status = 'accepted', accepted_version_id = ?, resolved_at = ?
              WHERE id = ? AND status = 'proposed'`,
          )
          .run(committed.result.versionId, now, proposalRow.id);
        this.insertEvent(
          command.projectId,
          this.nextProjectSeq(command.projectId),
          "revision.accepted",
          command.actor,
          command.operationId,
          {
            proposalId: proposalRow.id,
            baseBodyVersionId: proposalRow.base_body_version_id,
            versionId: committed.result.versionId,
            status: committed.result.status,
          },
          now,
        );
        return {
          ok: true,
          projectRevision,
          result: { ...committed.result, proposalId: proposalRow.id },
        };
      },
    );
  }

  rejectRevisionProposal(
    commandInput: RejectRevisionProposalCommand,
  ): MutationResult<{ proposalId: string; status: "rejected" }> {
    const parsed = RejectRevisionProposalCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Reject revision proposal command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "revision.reject",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "REVISION_CONFLICT",
            "Project changed after proposal rejection was prepared",
          );
        }
        const updatedProposal = this.database
          .prepare(
            `UPDATE revision_proposals
                SET status = 'rejected', resolved_at = ?
              WHERE id = ? AND project_id = ? AND status = 'proposed'`,
          )
          .run(now, command.proposalId, command.projectId);
        if (Number(updatedProposal.changes) !== 1) {
          return actionFailure(
            "PROPOSAL_NOT_PENDING",
            "Revision proposal is missing or no longer pending",
          );
        }
        const updatedProject = this.database
          .prepare(
            `UPDATE projects
                SET revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(now, command.projectId, command.expectedProjectRevision);
        if (Number(updatedProject.changes) !== 1) {
          throw new Error("Project revision changed during proposal rejection");
        }
        this.insertEvent(
          command.projectId,
          this.nextProjectSeq(command.projectId),
          "revision.rejected",
          command.actor,
          command.operationId,
          { proposalId: command.proposalId, reason: command.reason },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: { proposalId: command.proposalId, status: "rejected" },
        };
      },
    );
  }

  setBodyBlockLock(
    commandInput: SetBodyBlockLockCommand,
  ): MutationResult<{ blockId: string; locked: boolean }> {
    const parsed = SetBodyBlockLockCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Block lock command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      `body.block_${command.action === "lock" ? "lock" : "unlock"}`,
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (
          project.revision !== command.expectedProjectRevision ||
          project.latest_body_version_id !== command.baseBodyVersionId
        ) {
          return actionFailure(
            "REVISION_CONFLICT",
            "Body changed after the lock decision was prepared",
          );
        }
        const document = this.getBodyDocument(command.baseBodyVersionId);
        const block = document?.blocks.find(
          (candidate) => candidate.id === command.blockId,
        );
        if (block === undefined || block.contentHash !== command.blockHash) {
          return actionFailure(
            "REVISION_CONFLICT",
            "Block no longer matches the lock decision",
          );
        }
        const active = this.activeBlockLockRows(command.projectId).find(
          (row) => row.block_id === command.blockId,
        );
        if (command.action === "lock" && active !== undefined) {
          return {
            ok: true,
            projectRevision: project.revision,
            result: { blockId: command.blockId, locked: true },
          };
        }
        if (command.action === "unlock" && active === undefined) {
          return actionFailure(
            "LOCK_NOT_FOUND",
            "Block is not currently locked",
          );
        }
        const projectSeq = this.nextProjectSeq(command.projectId);
        const decisionId = this.idFactory();
        this.database
          .prepare(
            `INSERT INTO block_lock_decisions(
               id, project_id, body_version_id, block_id, block_hash, action,
               actor_json, operation_id, created_event_seq, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            decisionId,
            command.projectId,
            command.baseBodyVersionId,
            command.blockId,
            command.blockHash,
            command.action,
            canonicalJson(command.actor),
            command.operationId,
            projectSeq,
            now,
          );
        const updated = this.database
          .prepare(
            `UPDATE projects
                SET revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(now, command.projectId, command.expectedProjectRevision);
        if (Number(updated.changes) !== 1) {
          throw new Error("Project revision changed during block lock decision");
        }
        this.insertEvent(
          command.projectId,
          projectSeq,
          command.action === "lock" ? "body.block_locked" : "body.block_unlocked",
          command.actor,
          command.operationId,
          {
            decisionId,
            bodyVersionId: command.baseBodyVersionId,
            blockId: command.blockId,
            blockHash: command.blockHash,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: { blockId: command.blockId, locked: command.action === "lock" },
        };
      },
    );
  }

  private commitVersionInTransaction(
    input: VersionCommitInput,
    now: string,
  ): MutationAction<ArtifactVersionCommitResult> {
    const project = this.getProjectRow(input.projectId);
    if (project === undefined) {
      return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
    }
    if (project.revision !== input.expectedProjectRevision) {
      return actionFailure(
        "PROJECT_REVISION_CONFLICT",
        "Project changed after the command was prepared",
        true,
        { expected: input.expectedProjectRevision, actual: project.revision },
      );
    }

    let artifact = this.database
      .prepare(
        `SELECT id, latest_version_id FROM artifacts
          WHERE project_id = ? AND kind = ? AND logical_key = ?`,
      )
      .get(input.projectId, input.kind, input.logicalKey) as
      | ArtifactRow
      | undefined;
    const currentVersionId = artifact?.latest_version_id ?? null;
    if (currentVersionId !== input.baseVersionId) {
      return actionFailure(
        "BASE_VERSION_CONFLICT",
        "Artifact changed after the command was prepared",
        true,
        { expected: input.baseVersionId, actual: currentVersionId },
      );
    }

    const nextContentHash = contentHash(input.content);
    if (!input.allowSameContent && currentVersionId !== null) {
      const current = this.database
        .prepare("SELECT content, content_hash FROM artifact_versions WHERE id = ?")
        .get(currentVersionId) as
        | { content: string; content_hash: string }
        | undefined;
      if (
        current !== undefined &&
        current.content_hash === nextContentHash &&
        current.content === input.content
      ) {
        if (artifact === undefined) {
          throw new Error("Artifact pointer is inconsistent");
        }
        return {
          ok: true,
          projectRevision: project.revision,
          result: {
            status: "no_change",
            artifactId: artifact.id,
            versionId: currentVersionId,
            contentHash: nextContentHash,
          },
        };
      }
    }

    if (artifact === undefined) {
      const artifactId = this.idFactory();
      this.database
        .prepare(
          `INSERT INTO artifacts(
             id, project_id, kind, logical_key, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(artifactId, input.projectId, input.kind, input.logicalKey, now);
      artifact = { id: artifactId, latest_version_id: null };
    }

    const projectSeq = this.nextProjectSeq(input.projectId);
    const versionId = this.idFactory();
    let bodyDocument: BodyDocument | null = null;
    if (input.kind === "body") {
      const previous =
        currentVersionId === null ? null : this.getBodyDocument(currentVersionId);
      if (currentVersionId !== null && previous === null) {
        return actionFailure(
          "BODY_DOCUMENT_MISSING",
          "Current body block metadata is unavailable",
        );
      }
      if (input.bodyBlocks === undefined) {
        bodyDocument = reconcileBodyDocument(versionId, input.content, previous);
      } else {
        const blocks = input.bodyBlocks.map((block, ordinal) => ({
          ...block,
          ordinal,
        }));
        const rendered = blocks.map((block) => block.content).join("\n\n");
        if (rendered !== input.content) {
          return actionFailure(
            "REVISION_DOCUMENT_INVALID",
            "Revision block content does not match the proposed body",
          );
        }
        bodyDocument = {
          versionId,
          parserVersion: BODY_BLOCK_PARSER_VERSION,
          content: input.content,
          contentHash: nextContentHash,
          blocks,
        };
      }
      for (const lock of this.activeBlockLockRows(input.projectId)) {
        const nextBlock = bodyDocument.blocks.find(
          (block) => block.id === lock.block_id,
        );
        if (
          nextBlock === undefined ||
          nextBlock.contentHash !== lock.block_hash
        ) {
          return actionFailure(
            "LOCK_CONFLICT",
            "Body change would modify or remove a locked block",
            false,
            { blockId: lock.block_id },
          );
        }
      }
    }
    this.database
      .prepare(
        `INSERT INTO artifact_versions(
           id, artifact_id, project_id, kind, logical_key, content, content_hash,
           actor_json, parent_version_ids_json, reason, request_snapshot_id,
           created_event_seq, operation_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        artifact.id,
        input.projectId,
        input.kind,
        input.logicalKey,
        input.content,
        nextContentHash,
        canonicalJson(input.actor),
        canonicalJson(input.parentVersionIds),
        input.reason,
        input.requestSnapshotId,
        projectSeq,
        input.operationId,
        now,
      );
    if (bodyDocument !== null) {
      this.database
        .prepare(
          `INSERT INTO body_documents(
             artifact_version_id, project_id, parser_version, content_hash,
             document_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          versionId,
          input.projectId,
          bodyDocument.parserVersion,
          bodyDocument.contentHash,
          canonicalJson(bodyDocument),
          now,
        );
    }
    for (const parentVersionId of input.parentVersionIds) {
      this.insertProvenanceEdge(
        input.projectId,
        versionId,
        "DERIVED_FROM",
        parentVersionId,
        input.actor,
        projectSeq,
        null,
        now,
      );
    }
    this.faultInjector?.("after_artifact_version_insert");

    this.database
      .prepare("UPDATE artifacts SET latest_version_id = ? WHERE id = ?")
      .run(versionId, artifact.id);

    const pointerColumn: string | null =
      input.kind === "body"
        ? "latest_body_version_id"
        : input.kind === "title"
          ? "current_title_version_id"
          : input.kind === "evidence"
            ? "current_evidence_version_id"
            : null;
    const factInputChanged = pointerColumn !== null;
    const factStatusBeforeChange = this.getFactCheckStatus(input.projectId).status;
    const nextGateStatus = factInputChanged
      ? project.current_fact_snapshot_id === null &&
        project.fact_gate_status === "not_checked"
        ? "not_checked"
        : "stale"
      : project.fact_gate_status;
    const update =
      pointerColumn === null
        ? this.database
            .prepare(
              `UPDATE projects
                  SET revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
            )
            .run(now, input.projectId, input.expectedProjectRevision)
        : this.database
            .prepare(
              `UPDATE projects
                  SET ${pointerColumn} = ?, fact_gate_status = ?,
                      revision = revision + 1, updated_at = ?
                WHERE id = ? AND revision = ?`,
            )
            .run(
              versionId,
              nextGateStatus,
              now,
              input.projectId,
              input.expectedProjectRevision,
            );
    if (Number(update.changes) !== 1) {
      throw new Error("Project revision changed during commit");
    }
    this.faultInjector?.("after_project_pointer_update");

    this.insertEvent(
      input.projectId,
      projectSeq,
      input.eventType,
      input.actor,
      input.operationId,
      {
        artifactId: artifact.id,
        kind: input.kind,
        logicalKey: input.logicalKey,
        versionId,
        contentHash: nextContentHash,
        parentVersionIds: input.parentVersionIds,
        reason: input.reason,
      },
      now,
    );
    if (factInputChanged) {
      const reason =
        input.kind === "body"
          ? "body_version_changed"
          : input.kind === "title"
            ? "title_version_changed"
            : "evidence_version_changed";
      const invalidated = this.invalidateFactCheckSnapshots(
        input.projectId,
        input.kind as "body" | "title" | "evidence",
        reason,
        versionId,
        input.actor,
        input.operationId,
        now,
      );
      if (
        invalidated === 0 &&
        project.current_fact_snapshot_id !== null &&
        factStatusBeforeChange !== "stale"
      ) {
        const invalidatedEventSeq = this.nextProjectSeq(input.projectId);
        this.insertEvent(
          input.projectId,
          invalidatedEventSeq,
          "fact.invalidated",
          input.actor,
          input.operationId,
          {
            snapshotId: project.current_fact_snapshot_id,
            previousStatus: factStatusBeforeChange,
            reason,
            changedVersionId: versionId,
            legacySnapshot: true,
          },
          now,
        );
      }
    }

    return {
      ok: true,
      projectRevision: project.revision + 1,
      result: {
        status:
          input.eventType === "artifact.rolled_back" ? "rolled_back" : "created",
        artifactId: artifact.id,
        versionId,
        contentHash: nextContentHash,
      },
    };
  }

  createFactCheckSnapshot(
    commandInput: CreateFactCheckSnapshotCommand,
  ): MutationResult<{ snapshotId: string; status: "checking" }> {
    const parsed = CreateFactCheckSnapshotCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Create fact-check snapshot command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "create_fact_check_snapshot",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "PROJECT_REVISION_CONFLICT",
            "Project changed before fact-check inputs were frozen",
            true,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        if (
          project.latest_body_version_id !== command.bodyVersionId ||
          project.current_title_version_id !== command.titleVersionId ||
          project.current_evidence_version_id !== command.evidenceVersionId
        ) {
          return actionFailure(
            "FACT_INPUTS_STALE",
            "Fact-check inputs are not the current project versions",
            true,
            {
              current: {
                bodyVersionId: project.latest_body_version_id,
                titleVersionId: project.current_title_version_id,
                evidenceVersionId: project.current_evidence_version_id,
              },
            },
          );
        }
        const body = this.getArtifactVersion(command.bodyVersionId);
        const title = this.getArtifactVersion(command.titleVersionId);
        const evidence = this.getArtifactVersion(command.evidenceVersionId);
        if (
          body?.projectId !== command.projectId ||
          body.kind !== "body" ||
          title?.projectId !== command.projectId ||
          title.kind !== "title" ||
          evidence?.projectId !== command.projectId ||
          evidence.kind !== "evidence"
        ) {
          return actionFailure(
            "FACT_INPUTS_INVALID",
            "Fact-check input versions are missing or have the wrong artifact kind",
          );
        }

        const snapshotId = this.idFactory();
        let snapshot;
        try {
          snapshot = createFactCheckInputSnapshot({
            snapshotId,
            bodyVersionId: body.id,
            bodyContent: body.content,
            titleVersionId: title.id,
            titleContent: title.content,
            evidenceVersionId: evidence.id,
            evidenceContent: evidence.content,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : "FACT_INPUTS_INVALID";
          if (code.startsWith("FACT_")) {
            return actionFailure(code, "Fact-check inputs do not satisfy the gate contract");
          }
          throw error;
        }
        const eventSeq = this.nextProjectSeq(command.projectId);
        this.database
          .prepare(
            `INSERT INTO fact_input_snapshots(
               id, project_id, schema_version, policy_version,
               body_version_id, body_hash, title_version_id, title_hash,
               distribution_copy_hash, evidence_version_id, evidence_hash,
               created_event_seq, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            snapshot.snapshotId,
            command.projectId,
            snapshot.schemaVersion,
            snapshot.policyVersion,
            snapshot.bodyVersionId,
            snapshot.bodyHash,
            snapshot.titleVersionId,
            snapshot.titleHash,
            snapshot.distributionCopyHash,
            snapshot.evidenceVersionId,
            snapshot.evidenceHash,
            eventSeq,
            now,
          );
        const update = this.database
          .prepare(
            `UPDATE projects
                SET current_fact_snapshot_id = ?, revision = revision + 1,
                    updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(
            snapshotId,
            now,
            command.projectId,
            command.expectedProjectRevision,
          );
        if (Number(update.changes) !== 1) {
          throw new Error("Project revision changed during fact-check snapshot creation");
        }
        this.insertEvent(
          command.projectId,
          eventSeq,
          "fact.snapshot_created",
          command.actor,
          command.operationId,
          {
            snapshotId,
            bodyVersionId: snapshot.bodyVersionId,
            bodyHash: snapshot.bodyHash,
            titleVersionId: snapshot.titleVersionId,
            titleHash: snapshot.titleHash,
            distributionCopyHash: snapshot.distributionCopyHash,
            evidenceVersionId: snapshot.evidenceVersionId,
            evidenceHash: snapshot.evidenceHash,
            policyVersion: snapshot.policyVersion,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: { snapshotId, status: "checking" },
        };
      },
    );
  }

  evaluateFactCheckSnapshot(
    commandInput: EvaluateFactCheckSnapshotCommand,
  ): MutationResult<{
    snapshotId: string;
    assessmentId: string;
    status: "passed" | "blocked";
    blockers: readonly string[];
  }> {
    const parsed = EvaluateFactCheckSnapshotCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Evaluate fact-check snapshot command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "evaluate_fact_check_snapshot",
      command,
      (now) => {
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "PROJECT_REVISION_CONFLICT",
            "Project changed after fact-check evaluation was prepared",
            true,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        const snapshot = this.getFactCheckSnapshot(command.snapshotId);
        if (snapshot === null || snapshot.projectId !== command.projectId) {
          return actionFailure("FACT_SNAPSHOT_NOT_FOUND", "Fact-check snapshot does not exist");
        }
        if (project.current_fact_snapshot_id !== command.snapshotId) {
          return actionFailure(
            "FACT_CHECK_STALE",
            "Fact-check snapshot is no longer the current project snapshot",
            true,
          );
        }
        if (this.getFactCheckAssessment(command.snapshotId) !== null) {
          return actionFailure(
            "FACT_ASSESSMENT_EXISTS",
            "Fact-check snapshot already has an immutable assessment",
          );
        }
        const invalidation = this.database
          .prepare("SELECT id FROM fact_invalidations WHERE snapshot_id = ? LIMIT 1")
          .get(command.snapshotId);
        if (
          invalidation !== undefined ||
          project.latest_body_version_id !== snapshot.bodyVersionId ||
          project.current_title_version_id !== snapshot.titleVersionId ||
          project.current_evidence_version_id !== snapshot.evidenceVersionId
        ) {
          return actionFailure(
            "FACT_CHECK_STALE",
            "Fact-check inputs changed after the snapshot was frozen",
            true,
          );
        }
        const body = this.getArtifactVersion(snapshot.bodyVersionId);
        const title = this.getArtifactVersion(snapshot.titleVersionId);
        const evidence = this.getArtifactVersion(snapshot.evidenceVersionId);
        if (body === null || title === null || evidence === null) {
          return actionFailure(
            "FACT_INPUTS_INVALID",
            "Fact-check input contents are unavailable",
          );
        }
        let evaluation;
        try {
          evaluation = evaluateFactCheck(
            snapshot,
            {
              bodyContent: body.content,
              titleContent: title.content,
              evidenceContent: evidence.content,
            },
            command.payload,
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : "FACT_CHECK_FAILED";
          if (code.startsWith("FACT_")) {
            return actionFailure(code, "Fact-check evaluation failed closed");
          }
          throw error;
        }

        const eventSeq = this.nextProjectSeq(command.projectId);
        const assessmentId = this.idFactory();
        this.database
          .prepare(
            `INSERT INTO fact_assessments(
               id, project_id, snapshot_id, status, payload_json, claims_hash,
               blockers_json, report_content, report_hash, actor_json,
               operation_id, created_event_seq, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            assessmentId,
            command.projectId,
            command.snapshotId,
            evaluation.status,
            canonicalJson(command.payload),
            evaluation.claimsHash,
            canonicalJson(evaluation.blockers),
            evaluation.reportContent,
            evaluation.reportHash,
            canonicalJson(command.actor),
            command.operationId,
            eventSeq,
            now,
          );
        for (const versionId of [
          snapshot.bodyVersionId,
          snapshot.titleVersionId,
          snapshot.evidenceVersionId,
        ]) {
          this.insertProvenanceEdge(
            command.projectId,
            snapshot.snapshotId,
            "CHECKED_IN",
            versionId,
            command.actor,
            eventSeq,
            assessmentId,
            now,
          );
        }
        const update = this.database
          .prepare(
            `UPDATE projects
                SET current_fact_snapshot_id = ?, fact_gate_status = ?,
                    revision = revision + 1, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(
            snapshot.snapshotId,
            evaluation.status,
            now,
            command.projectId,
            command.expectedProjectRevision,
          );
        if (Number(update.changes) !== 1) {
          throw new Error("Project revision changed during fact-check evaluation");
        }
        this.insertEvent(
          command.projectId,
          eventSeq,
          "fact.assessment_recorded",
          command.actor,
          command.operationId,
          {
            snapshotId: snapshot.snapshotId,
            assessmentId,
            status: evaluation.status,
            blockers: evaluation.blockers,
            claimsHash: evaluation.claimsHash,
            reportHash: evaluation.reportHash,
          },
          now,
        );
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: {
            snapshotId: snapshot.snapshotId,
            assessmentId,
            status: evaluation.status,
            blockers: evaluation.blockers,
          },
        };
      },
    );
  }

  saveWorkingCopy(
    commandInput: SaveWorkingCopyCommand,
  ): MutationResult<ExportRecord> {
    const parsed = SaveWorkingCopyCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Save working copy command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.executeExport(
      command,
      "export_working_copy",
      (project, body, now) =>
        prepareWorkingCopyContent({
          project,
          body,
          factCheck: this.getFactCheckStatus(command.projectId),
          operationId: command.operationId,
          createdAt: now,
        }),
    );
  }

  exportPublication(
    commandInput: ExportPublicationCommand,
  ): MutationResult<ExportRecord> {
    const parsed = ExportPublicationCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Export publication command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.executeExport(
      command,
      "export_publication",
      (project, body) => {
        const factCheck = this.getFactCheckStatus(command.projectId);
        if (factCheck.status !== "passed") throw new Error("FACT_GATE_NOT_PASSED");
        if (
          project.currentTitleVersionId === null ||
          project.currentEvidenceVersionId === null
        ) {
          throw new Error("FACT_INPUTS_INVALID");
        }
        const title = this.getArtifactVersion(project.currentTitleVersionId);
        const evidence = this.getArtifactVersion(project.currentEvidenceVersionId);
        if (title === null || evidence === null) throw new Error("FACT_INPUTS_INVALID");
        return preparePublicationContent({
          project,
          body,
          title,
          evidence,
          factCheck,
          factSnapshotId: command.factSnapshotId,
          format: command.format,
          layoutPreset: command.layoutPreset ?? "clean",
        });
      },
    );
  }

  listExports(projectId: string): ExportRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM exports
          WHERE project_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(projectId) as unknown as ExportRow[];
    return rows.map(exportRecordFromRow);
  }

  private executeExport(
    command: SaveWorkingCopyCommand | ExportPublicationCommand,
    commandType: "export_working_copy" | "export_publication",
    prepare: (
      project: ProjectInspection,
      body: ArtifactVersion,
      now: string,
    ) => PreparedExportContent,
  ): MutationResult<ExportRecord> {
    if (this.readOnly) {
      return failure(
        command.operationId,
        "STORAGE_READ_ONLY",
        "Workspace storage was opened in read-only mode",
      );
    }
    const inputHash = contentHash(canonicalJson(command));
    const existingOperation = this.database
      .prepare("SELECT * FROM operations WHERE operation_id = ?")
      .get(command.operationId) as OperationRow | undefined;
    const existingExport = this.getExportRowByOperation(command.operationId);
    if (existingOperation !== undefined || existingExport !== undefined) {
      if (
        existingOperation?.input_hash !== inputHash ||
        existingOperation.command_type !== commandType ||
        existingExport?.input_hash !== inputHash
      ) {
        return failure(
          command.operationId,
          "IDEMPOTENCY_KEY_REUSED",
          "Operation ID was already used with different input",
        );
      }
      if (existingExport === undefined) {
        return failure(
          command.operationId,
          "OPERATION_INCOMPLETE",
          "Export operation state is incomplete",
          true,
        );
      }
      return this.completePreparedExport(existingExport);
    }

    const now = this.clock();
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const projectRow = this.getProjectRow(command.projectId);
      if (projectRow === undefined) {
        this.database.exec("ROLLBACK");
        return failure(command.operationId, "PROJECT_NOT_FOUND", "Project does not exist");
      }
      if (projectRow.revision !== command.expectedProjectRevision) {
        this.database.exec("ROLLBACK");
        return failure(
          command.operationId,
          "PROJECT_REVISION_CONFLICT",
          "Project changed after export was prepared",
          true,
          { expected: command.expectedProjectRevision, actual: projectRow.revision },
        );
      }
      if (projectRow.latest_body_version_id !== command.bodyVersionId) {
        this.database.exec("ROLLBACK");
        return failure(
          command.operationId,
          "EXPORT_BODY_NOT_CURRENT",
          "Export body is not the current project body",
          true,
        );
      }
      const body = this.getArtifactVersion(command.bodyVersionId);
      if (body === null) {
        this.database.exec("ROLLBACK");
        return failure(
          command.operationId,
          "BODY_VERSION_NOT_FOUND",
          "Export body version does not exist",
        );
      }
      let prepared: PreparedExportContent;
      try {
        prepared = prepare(projectFromRow(projectRow), body, now);
      } catch (error) {
        this.database.exec("ROLLBACK");
        const code = error instanceof Error ? error.message : "EXPORT_PREPARATION_FAILED";
        return failure(
          command.operationId,
          code.startsWith("FACT_") || code.startsWith("EXPORT_")
            ? code
            : "EXPORT_PREPARATION_FAILED",
          "Export inputs did not satisfy the delivery contract",
        );
      }
      const exportId = this.idFactory();
      this.database
        .prepare(
          `INSERT INTO operations(
             operation_id, project_id, command_type, input_hash, state, created_at
           ) VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(command.operationId, command.projectId, commandType, inputHash, now);
      this.database
        .prepare(
          `INSERT INTO exports(
             id, operation_id, input_hash, expected_project_revision,
             project_id, mode, format, state, body_version_id, body_hash,
             title_version_id, title_hash, distribution_copy_hash,
             evidence_version_id, evidence_hash, fact_snapshot_id,
             assessment_id, policy_version, gate_status, relative_path,
             manifest_relative_path, content_text, manifest_content,
             content_hash, manifest_hash, byte_length, manifest_byte_length,
             actor_json, created_at
           ) VALUES (
             ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          exportId,
          command.operationId,
          inputHash,
          command.expectedProjectRevision,
          command.projectId,
          prepared.mode,
          prepared.format,
          prepared.bodyVersionId,
          prepared.bodyHash,
          prepared.titleVersionId,
          prepared.titleHash,
          prepared.distributionCopyHash,
          prepared.evidenceVersionId,
          prepared.evidenceHash,
          prepared.factSnapshotId,
          prepared.assessmentId,
          prepared.policyVersion,
          prepared.gateStatus,
          prepared.relativePath,
          prepared.manifestRelativePath,
          prepared.content,
          prepared.manifestContent,
          prepared.contentHash,
          prepared.manifestHash,
          Buffer.byteLength(prepared.content, "utf8"),
          prepared.manifestContent === null
            ? null
            : Buffer.byteLength(prepared.manifestContent, "utf8"),
          canonicalJson(command.actor),
          now,
        );
      this.database.exec("COMMIT");
      const row = this.getExportRowByOperation(command.operationId);
      if (row === undefined) throw new Error("Prepared export record was not persisted");
      return this.completePreparedExport(row);
    } catch (error) {
      this.rollbackQuietly();
      return failure(
        command.operationId,
        "STORAGE_WRITE_FAILED",
        "Export preparation could not be committed",
        true,
        {
          causeCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "UNKNOWN",
        },
      );
    }
  }

  private completePreparedExport(rowInput: ExportRow): MutationResult<ExportRecord> {
    const completedResponse = (): MutationResult<ExportRecord> | null => {
      const operation = this.database
        .prepare("SELECT result_json FROM operations WHERE operation_id = ?")
        .get(rowInput.operation_id) as { result_json: string | null } | undefined;
      if (
        rowInput.state !== "completed" ||
        operation === undefined ||
        operation.result_json === null
      ) {
        return null;
      }
      try {
        this.verifyExportFiles(rowInput, "EXPORT_FILE_MISMATCH");
      } catch (error) {
        const code = error instanceof ExportFileError ? error.code : "EXPORT_FILE_MISMATCH";
        return failure(
          rowInput.operation_id,
          code,
          "Completed export file no longer matches its database hash",
        );
      }
      return JSON.parse(operation.result_json) as MutationResult<ExportRecord>;
    };
    const prior = completedResponse();
    if (prior !== null) return prior;

    let filesAlreadyComplete = false;
    try {
      filesAlreadyComplete = this.verifyExportFiles(
        rowInput,
        "EXPORT_TARGET_CONFLICT",
        true,
      );
    } catch (error) {
      const code = error instanceof ExportFileError ? error.code : "EXPORT_TARGET_CONFLICT";
      return failure(
        rowInput.operation_id,
        code,
        "Export target already contains different content",
      );
    }

    try {
      this.database.exec("BEGIN IMMEDIATE");
      const row = this.getExportRowByOperation(rowInput.operation_id);
      if (row === undefined) throw new Error("Prepared export record disappeared");
      if (row.state === "completed") {
        this.database.exec("ROLLBACK");
        return this.completePreparedExport(row);
      }
      const projectRow = this.getProjectRow(row.project_id);
      if (projectRow === undefined) {
        this.database.exec("ROLLBACK");
        return failure(row.operation_id, "PROJECT_NOT_FOUND", "Project does not exist");
      }

      if (!filesAlreadyComplete && row.mode === "publication") {
        const factCheck = this.getFactCheckStatus(row.project_id);
        if (factCheck.status !== "passed") {
          this.database.exec("ROLLBACK");
          return failure(
            row.operation_id,
            "FACT_GATE_NOT_PASSED",
            "Publication gate is no longer passed",
          );
        }
        const body = this.getArtifactVersion(row.body_version_id);
        const title =
          row.title_version_id === null
            ? null
            : this.getArtifactVersion(row.title_version_id);
        const evidence =
          row.evidence_version_id === null
            ? null
            : this.getArtifactVersion(row.evidence_version_id);
        if (
          body === null ||
          title === null ||
          evidence === null ||
          row.fact_snapshot_id === null
        ) {
          this.database.exec("ROLLBACK");
          return failure(
            row.operation_id,
            "FACT_INPUTS_INVALID",
            "Publication inputs are unavailable",
          );
        }
        let current: PreparedExportContent;
        try {
          current = preparePublicationContent({
            project: projectFromRow(projectRow),
            body,
            title,
            evidence,
            factCheck,
            factSnapshotId: row.fact_snapshot_id,
            format: row.format as "txt" | "html",
            layoutPreset: publicationLayoutPresetFromPath(row.relative_path),
          });
        } catch (error) {
          this.database.exec("ROLLBACK");
          const code = error instanceof Error ? error.message : "FACT_GATE_NOT_PASSED";
          return failure(
            row.operation_id,
            code.startsWith("FACT_") ? code : "FACT_GATE_NOT_PASSED",
            "Publication gate revalidation failed",
          );
        }
        if (
          current.relativePath !== row.relative_path ||
          current.contentHash !== row.content_hash ||
          current.content !== row.content_text ||
          current.assessmentId !== row.assessment_id
        ) {
          this.database.exec("ROLLBACK");
          return failure(
            row.operation_id,
            "EXPORT_PREPARED_CONTENT_MISMATCH",
            "Prepared publication no longer matches the current gate",
          );
        }
      }

      if (!filesAlreadyComplete) {
        this.writeExpectedExportFile(
          exportTargetPath(this.databasePath, row.relative_path),
          row.content_text,
          row.content_hash,
        );
        if (
          row.manifest_relative_path !== null &&
          row.manifest_content !== null &&
          row.manifest_hash !== null
        ) {
          this.writeExpectedExportFile(
            exportTargetPath(this.databasePath, row.manifest_relative_path),
            row.manifest_content,
            row.manifest_hash,
          );
        }
      }

      const now = this.clock();
      const eventSeq = this.nextProjectSeq(row.project_id);
      this.database
        .prepare(
          `UPDATE exports
              SET state = 'completed', completed_event_seq = ?, completed_at = ?
            WHERE id = ? AND state = 'prepared'`,
        )
        .run(eventSeq, now, row.id);
      const projectUpdate = this.database
        .prepare(
          `UPDATE projects
              SET revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`,
        )
        .run(now, row.project_id, projectRow.revision);
      if (Number(projectUpdate.changes) !== 1) {
        throw new Error("Project changed while completing export");
      }
      const actor = ActorSchema.parse(JSON.parse(row.actor_json));
      this.insertEvent(
        row.project_id,
        eventSeq,
        "export.completed",
        actor,
        row.operation_id,
        {
          exportId: row.id,
          mode: row.mode,
          format: row.format,
          bodyVersionId: row.body_version_id,
          factSnapshotId: row.fact_snapshot_id,
          relativePath: row.relative_path,
          contentHash: row.content_hash,
        },
        now,
      );
      this.insertProvenanceEdge(
        row.project_id,
        row.body_version_id,
        "EXPORTED_AS",
        row.id,
        actor,
        eventSeq,
        row.assessment_id,
        now,
      );
      const completedRow: ExportRow = {
        ...row,
        state: "completed",
        completed_event_seq: eventSeq,
        completed_at: now,
      };
      const response: MutationResult<ExportRecord> = {
        ok: true,
        projectRevision: projectRow.revision + 1,
        operationId: row.operation_id,
        result: exportRecordFromRow(completedRow),
      };
      this.database
        .prepare(
          `UPDATE operations
              SET state = 'completed', result_json = ?, completed_at = ?
            WHERE operation_id = ?`,
        )
        .run(canonicalJson(response), now, row.operation_id);
      this.faultInjector?.("before_transaction_commit");
      this.database.exec("COMMIT");
      return response;
    } catch (error) {
      this.rollbackQuietly();
      const code =
        error instanceof ExportFileError
          ? error.code
          : "EXPORT_WRITE_FAILED";
      return failure(
        rowInput.operation_id,
        code,
        "Export file could not be atomically written and reconciled",
        true,
        {
          causeCode:
            typeof error === "object" && error !== null && "code" in error
              ? String((error as { code?: unknown }).code)
              : "UNKNOWN",
        },
      );
    }
  }

  private getExportRowByOperation(operationId: string): ExportRow | undefined {
    return this.database
      .prepare("SELECT * FROM exports WHERE operation_id = ?")
      .get(operationId) as ExportRow | undefined;
  }

  private verifyExportFiles(
    row: ExportRow,
    mismatchCode: "EXPORT_TARGET_CONFLICT" | "EXPORT_FILE_MISMATCH",
    allowMissing = false,
  ): boolean {
    const targets: Array<[string, string]> = [
      [row.relative_path, row.content_hash],
    ];
    if (row.manifest_relative_path !== null && row.manifest_hash !== null) {
      targets.push([row.manifest_relative_path, row.manifest_hash]);
    }
    let allPresent = true;
    for (const [relativePath, expectedHash] of targets) {
      const target = exportTargetPath(this.databasePath, relativePath);
      if (!existsSync(target)) {
        allPresent = false;
        if (!allowMissing) {
          throw new ExportFileError(mismatchCode, "Expected export file is missing");
        }
        continue;
      }
      if (fileSha256(target) !== expectedHash) {
        throw new ExportFileError(mismatchCode, "Export file hash does not match");
      }
    }
    return allPresent;
  }

  private writeExpectedExportFile(
    target: string,
    content: string,
    expectedHash: string,
  ): void {
    if (existsSync(target)) {
      if (fileSha256(target) !== expectedHash) {
        throw new ExportFileError(
          "EXPORT_TARGET_CONFLICT",
          "Export target already contains different content",
        );
      }
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      const descriptor = openSync(temporary, "r+");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      if (fileSha256(temporary) !== expectedHash) {
        throw new ExportFileError(
          "EXPORT_FILE_HASH_MISMATCH",
          "Temporary export file failed hash verification",
        );
      }
      this.faultInjector?.("after_export_temp_write");
      if (existsSync(target)) {
        if (fileSha256(target) !== expectedHash) {
          throw new ExportFileError(
            "EXPORT_TARGET_CONFLICT",
            "Export target changed before atomic replace",
          );
        }
        return;
      }
      renameSync(temporary, target);
      this.faultInjector?.("after_export_file_replace");
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  deleteProject(
    commandInput: DeleteProjectCommand,
  ): MutationResult<{ projectId: string; deleted: true }> {
    const parsed = DeleteProjectCommandSchema.safeParse(commandInput);
    if (!parsed.success) {
      return failure(
        commandInput.operationId,
        "INVALID_COMMAND",
        "Delete project command is invalid",
        false,
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    return this.runMutation(
      command.operationId,
      command.projectId,
      "delete_project",
      command,
      () => {
        if (command.confirmedProjectId !== command.projectId) {
          return actionFailure(
            "PROJECT_CONFIRMATION_MISMATCH",
            "Confirmed project ID does not match the deletion target",
          );
        }
        const project = this.getProjectRow(command.projectId);
        if (project === undefined) {
          return actionFailure("PROJECT_NOT_FOUND", "Project does not exist");
        }
        if (project.revision !== command.expectedProjectRevision) {
          return actionFailure(
            "PROJECT_REVISION_CONFLICT",
            "Project changed after deletion was prepared",
            true,
            { expected: command.expectedProjectRevision, actual: project.revision },
          );
        }
        this.database
          .prepare(
            "DELETE FROM operations WHERE project_id = ? AND operation_id <> ?",
          )
          .run(command.projectId, command.operationId);
        const deleted = this.database
          .prepare("DELETE FROM projects WHERE id = ? AND revision = ?")
          .run(command.projectId, command.expectedProjectRevision);
        if (Number(deleted.changes) !== 1) {
          throw new Error("Project changed during deletion");
        }
        return {
          ok: true,
          projectRevision: project.revision + 1,
          result: { projectId: command.projectId, deleted: true as const },
        };
      },
    );
  }

  async createBackup(destinationPath: string): Promise<BackupManifest> {
    const source = resolve(this.databasePath);
    const destination = resolve(destinationPath);
    if (source === destination) {
      throw new StorageOpenError(
        "BACKUP_TARGET_IS_LIVE_DATABASE",
        "Backup destination cannot be the live workspace database",
      );
    }
    if (existsSync(destination)) {
      throw new StorageOpenError(
        "BACKUP_DESTINATION_EXISTS",
        "Backup destination already exists",
      );
    }

    mkdirSync(dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.tmp-${randomUUID()}`;
    try {
      await backupDatabase(this.database, temporaryPath);
      const inspection = inspectDatabaseFile(temporaryPath);
      if (!inspection.ok || !inspection.supported) {
        throw new StorageOpenError(
          "BACKUP_VERIFICATION_FAILED",
          "Created backup did not pass schema and integrity verification",
        );
      }
      if (existsSync(destination)) {
        throw new StorageOpenError(
          "BACKUP_DESTINATION_EXISTS",
          "Backup destination was created while the backup was running",
        );
      }
      renameSync(temporaryPath, destination);
      return {
        path: destination,
        sizeBytes: statSync(destination).size,
        sha256: fileSha256(destination),
        schemaVersion: inspection.schemaVersion,
        createdAt: this.clock(),
      };
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    }
  }

  inspectProject(projectId: string): ProjectInspection | null {
    const row = this.getProjectRow(projectId);
    return row === undefined ? null : projectFromRow(row);
  }

  listProjects(): ProjectInspection[] {
    const rows = this.database
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC, id ASC")
      .all() as unknown as ProjectRow[];
    return rows.map(projectFromRow);
  }

  listSessions(projectId: string): SessionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM sessions
          WHERE project_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId) as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  listRuns(projectId: string, sessionId?: string): RunRecord[] {
    const rows = (sessionId === undefined
      ? this.database
          .prepare(
            `SELECT * FROM runs
              WHERE project_id = ?
              ORDER BY created_at ASC, id ASC`,
          )
          .all(projectId)
      : this.database
          .prepare(
            `SELECT * FROM runs
              WHERE project_id = ? AND session_id = ?
              ORDER BY created_at ASC, id ASC`,
          )
          .all(projectId, sessionId)) as unknown as RunRow[];
    return rows.map(runFromRow);
  }

  getMaterial(projectId: string, materialId: string): MaterialRecord | null {
    const row = this.database
      .prepare("SELECT * FROM materials WHERE project_id = ? AND id = ?")
      .get(projectId, materialId) as MaterialRow | undefined;
    return row === undefined ? null : materialFromRow(row);
  }

  listMaterials(projectId: string): MaterialRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM materials
          WHERE project_id = ?
          ORDER BY rowid ASC`,
      )
      .all(projectId) as unknown as MaterialRow[];
    return rows.map(materialFromRow);
  }

  getWritingBriefVersion(versionId: string): WritingBriefVersion | null {
    const row = this.database
      .prepare("SELECT * FROM writing_brief_versions WHERE id = ?")
      .get(versionId) as WritingBriefVersionRow | undefined;
    return row === undefined ? null : writingBriefVersionFromRow(row);
  }

  listActiveDecisions(projectId: string): DecisionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, project_id, type, value_json, scope, actor_json,
                source_event_id, created_at
           FROM decisions
          WHERE project_id = ? AND active = 1
          ORDER BY rowid ASC`,
      )
      .all(projectId) as unknown as DecisionRow[];
    return rows.map(decisionFromRow);
  }

  getArtifactVersion(versionId: string): ArtifactVersion | null {
    const row = this.database
      .prepare("SELECT * FROM artifact_versions WHERE id = ?")
      .get(versionId) as ArtifactVersionRow | undefined;
    return row === undefined ? null : artifactVersionFromRow(row);
  }

  getBodyDocument(versionId: string): BodyDocument | null {
    const row = this.database
      .prepare("SELECT * FROM body_documents WHERE artifact_version_id = ?")
      .get(versionId) as BodyDocumentRow | undefined;
    return row === undefined ? null : bodyDocumentFromRow(row);
  }

  getRevisionProposal(proposalId: string): RevisionProposal | null {
    const row = this.database
      .prepare("SELECT * FROM revision_proposals WHERE id = ?")
      .get(proposalId) as RevisionProposalRow | undefined;
    return row === undefined ? null : revisionProposalFromRow(row);
  }

  listRevisionProposals(projectId: string): RevisionProposal[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM revision_proposals
          WHERE project_id = ?
          ORDER BY created_event_seq ASC, id ASC`,
      )
      .all(projectId) as unknown as RevisionProposalRow[];
    return rows.map(revisionProposalFromRow);
  }

  listBodyBlockLocks(projectId: string): BodyBlockLock[] {
    return this.activeBlockLockRows(projectId).map(bodyBlockLockFromRow);
  }

  listArtifactVersions(
    projectId: string,
    kind: ArtifactKind,
    logicalKey: string,
  ): ArtifactVersion[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM artifact_versions
          WHERE project_id = ? AND kind = ? AND logical_key = ?
          ORDER BY rowid ASC`,
      )
      .all(projectId, kind, logicalKey) as unknown as ArtifactVersionRow[];
    return rows.map(artifactVersionFromRow);
  }

  getFactCheckSnapshot(snapshotId: string): PersistedFactCheckSnapshot | null {
    const row = this.database
      .prepare("SELECT * FROM fact_input_snapshots WHERE id = ?")
      .get(snapshotId) as FactInputSnapshotRow | undefined;
    return row === undefined ? null : factInputSnapshotFromRow(row);
  }

  getFactCheckAssessment(snapshotId: string): PersistedFactAssessment | null {
    const row = this.database
      .prepare("SELECT * FROM fact_assessments WHERE snapshot_id = ?")
      .get(snapshotId) as FactAssessmentRow | undefined;
    return row === undefined ? null : factAssessmentFromRow(row);
  }

  getFactCheckStatus(projectId: string): FactCheckStatusView {
    const project = this.getProjectRow(projectId);
    if (project === undefined) {
      return {
        status: "not_checked",
        currentSnapshotId: null,
        snapshot: null,
        assessment: null,
        invalidations: [],
      };
    }
    const snapshot =
      project.current_fact_snapshot_id === null
        ? null
        : this.getFactCheckSnapshot(project.current_fact_snapshot_id);
    const assessment =
      snapshot === null ? null : this.getFactCheckAssessment(snapshot.snapshotId);
    const invalidationRows =
      snapshot === null
        ? []
        : (this.database
            .prepare(
              `SELECT * FROM fact_invalidations
                WHERE snapshot_id = ?
                ORDER BY created_event_seq ASC, id ASC`,
            )
            .all(snapshot.snapshotId) as unknown as FactInvalidationRow[]);
    const invalidations = invalidationRows.map(factInvalidationFromRow);
    const status =
      project.current_fact_snapshot_id !== null && snapshot === null
        ? "stale"
        : snapshot === null
        ? project.fact_gate_status
        : invalidations.length > 0
          ? "stale"
          : assessment === null
            ? "checking"
            : assessment.status;
    return {
      status,
      currentSnapshotId: project.current_fact_snapshot_id,
      snapshot,
      assessment,
      invalidations,
    };
  }

  listProvenanceEdges(projectId: string): ProvenanceEdge[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM provenance_edges
          WHERE project_id = ?
          ORDER BY rowid ASC`,
      )
      .all(projectId) as unknown as ProvenanceEdgeRow[];
    return rows.map(provenanceEdgeFromRow);
  }

  listEvents(projectId: string, afterProjectSeq = 0): DomainEvent[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM events
          WHERE project_id = ? AND project_seq > ?
          ORDER BY project_seq ASC`,
      )
      .all(projectId, afterProjectSeq) as unknown as EventRow[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectSeq: row.project_seq,
      ...(row.run_id === null ? {} : { runId: row.run_id }),
      type: row.type,
      actor: ActorSchema.parse(JSON.parse(row.actor_json)),
      operationId: row.operation_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    }));
  }

  private getProjectRow(projectId: string): ProjectRow | undefined {
    return this.database
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
  }

  private activeBlockLockRows(projectId: string): BlockLockDecisionRow[] {
    return this.database
      .prepare(
        `SELECT decision.*
           FROM block_lock_decisions AS decision
          WHERE decision.project_id = ?
            AND decision.action = 'lock'
            AND NOT EXISTS (
              SELECT 1
                FROM block_lock_decisions AS newer
               WHERE newer.project_id = decision.project_id
                 AND newer.block_id = decision.block_id
                 AND newer.created_event_seq > decision.created_event_seq
            )
          ORDER BY decision.created_event_seq ASC, decision.id ASC`,
      )
      .all(projectId) as unknown as BlockLockDecisionRow[];
  }

  private markProposalConflicted(
    proposal: RevisionProposalRow,
    code: "REVISION_CONFLICT" | "LOCK_CONFLICT",
    actor: Actor,
    operationId: string,
    now: string,
  ): void {
    const updated = this.database
      .prepare(
        `UPDATE revision_proposals
            SET status = 'conflicted', conflict_code = ?, resolved_at = ?
          WHERE id = ? AND status = 'proposed'`,
      )
      .run(code, now, proposal.id);
    if (Number(updated.changes) !== 1) {
      throw new Error("Revision proposal changed while recording conflict");
    }
    this.insertEvent(
      proposal.project_id,
      this.nextProjectSeq(proposal.project_id),
      "revision.conflicted",
      actor,
      operationId,
      {
        proposalId: proposal.id,
        baseBodyVersionId: proposal.base_body_version_id,
        conflictCode: code,
      },
      now,
    );
  }

  private invalidateFactCheckSnapshots(
    projectId: string,
    kind: "body" | "title" | "evidence",
    reason: FactCheckInvalidation["reason"],
    changedVersionId: string,
    actor: Actor,
    operationId: string,
    now: string,
  ): number {
    const versionColumn =
      kind === "body"
        ? "body_version_id"
        : kind === "title"
          ? "title_version_id"
          : "evidence_version_id";
    const rows = this.database
      .prepare(
        `SELECT snapshot.id
           FROM fact_input_snapshots AS snapshot
          WHERE snapshot.project_id = ?
            AND snapshot.${versionColumn} <> ?
            AND NOT EXISTS (
              SELECT 1
                FROM fact_invalidations AS invalidation
               WHERE invalidation.snapshot_id = snapshot.id
                 AND invalidation.reason = ?
                 AND invalidation.changed_version_id = ?
            )
          ORDER BY snapshot.created_event_seq ASC, snapshot.id ASC`,
      )
      .all(projectId, changedVersionId, reason, changedVersionId) as unknown as Array<{
      id: string;
    }>;
    for (const row of rows) {
      const eventSeq = this.nextProjectSeq(projectId);
      const invalidationId = this.idFactory();
      this.database
        .prepare(
          `INSERT INTO fact_invalidations(
             id, project_id, snapshot_id, reason, changed_version_id,
             actor_json, operation_id, created_event_seq, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invalidationId,
          projectId,
          row.id,
          reason,
          changedVersionId,
          canonicalJson(actor),
          operationId,
          eventSeq,
          now,
        );
      this.insertEvent(
        projectId,
        eventSeq,
        "fact.invalidated",
        actor,
        operationId,
        {
          invalidationId,
          snapshotId: row.id,
          reason,
          changedVersionId,
        },
        now,
      );
    }
    return rows.length;
  }

  private nextProjectSeq(projectId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(project_seq), 0) + 1 AS next_seq FROM events WHERE project_id = ?",
      )
      .get(projectId) as { next_seq: number };
    return row.next_seq;
  }

  private insertProvenanceEdge(
    projectId: string,
    fromId: string,
    relation: ProvenanceRelation,
    toId: string,
    actor: Actor,
    eventSeq: number,
    evidenceRef: string | null,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO provenance_edges(
           id, project_id, from_id, relation, to_id, actor_json,
           event_seq, evidence_ref, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.idFactory(),
        projectId,
        fromId,
        relation,
        toId,
        canonicalJson(actor),
        eventSeq,
        evidenceRef,
        createdAt,
      );
  }

  private insertEvent(
    projectId: string,
    projectSeq: number,
    type: string,
    actor: Actor,
    operationId: string,
    payload: Record<string, unknown>,
    occurredAt: string,
    runId: string | null = null,
  ): string {
    const eventId = this.idFactory();
    this.database
      .prepare(
        `INSERT INTO events(
           id, project_id, project_seq, run_id, type, actor_json, operation_id,
           payload_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        projectId,
        projectSeq,
        runId,
        type,
        canonicalJson(actor),
        operationId,
        canonicalJson(payload),
        occurredAt,
      );
    if (runId !== null) {
      this.database
        .prepare(
          `UPDATE runs
              SET last_committed_event_seq = ?
            WHERE id = ?`,
        )
        .run(projectSeq, runId);
    }
    return eventId;
  }
}

export function openWorkspaceStorage(
  options: OpenWorkspaceStorageOptions,
): WorkspaceStorage {
  const databasePath = workspaceDatabasePath(options.workspacePath);
  const readOnly = options.readOnly ?? false;
  const databaseExisted = existsSync(databasePath);
  if (readOnly && !databaseExisted) {
    throw new StorageOpenError(
      "DATABASE_NOT_FOUND",
      "Workspace database does not exist",
    );
  }
  if (databaseExisted && statSync(databasePath).size === 0) {
    throw new StorageOpenError(
      "DATABASE_CORRUPT",
      "Existing workspace database is empty and will not be reinitialized",
    );
  }
  if (!readOnly) mkdirSync(dirname(databasePath), { recursive: true });
  const isNewDatabase = !databaseExisted;
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly, timeout: 5000 });
  } catch (error) {
    throw classifyDatabaseError(error);
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? randomUUID;
  try {
    initializeDatabase(database, isNewDatabase, clock(), readOnly);
    return new WorkspaceStorage(
      database,
      databasePath,
      clock,
      idFactory,
      options.faultInjector,
      readOnly,
    );
  } catch (error) {
    database.close();
    throw error;
  }
}

function inspectDatabaseFile(databasePath: string): WorkspaceDatabaseInspection {
  const resolvedPath = resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    return {
      ok: false,
      databasePath: resolvedPath,
      code: "DATABASE_NOT_FOUND",
      message: "Workspace database does not exist",
    };
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(resolvedPath, { readOnly: true, timeout: 5000 });
    configureConnection(database, true);
    verifyDatabase(database);
    const applicationId = sqlitePragmaNumber(database, "application_id");
    const schemaVersion = sqlitePragmaNumber(database, "user_version");
    if (applicationId !== APPLICATION_ID || schemaVersion === 0) {
      return {
        ok: false,
        databasePath: resolvedPath,
        code: "UNRECOGNIZED_DATABASE",
        message: "Database is not a recognized Writing Agent workspace",
      };
    }
    const table = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'",
      )
      .get();
    const projectCount =
      table === undefined
        ? 0
        : Number(
            (
              database.prepare("SELECT COUNT(*) AS count FROM projects").get() as {
                count: number;
              }
            ).count,
          );
    return {
      ok: true,
      databasePath: resolvedPath,
      applicationId,
      schemaVersion,
      supported: schemaVersion === CURRENT_SCHEMA_VERSION,
      integrity: "ok",
      projectCount,
    };
  } catch (error) {
    const classified =
      error instanceof StorageOpenError ? error : classifyDatabaseError(error);
    return {
      ok: false,
      databasePath: resolvedPath,
      code: classified.code,
      message: classified.message,
    };
  } finally {
    database?.close();
  }
}

export function inspectWorkspaceDatabase(
  workspacePath: string,
): WorkspaceDatabaseInspection {
  return inspectDatabaseFile(workspaceDatabasePath(workspacePath));
}

export function inspectWorkspaceBackupFile(
  backupPath: string,
): WorkspaceDatabaseInspection {
  return inspectDatabaseFile(backupPath);
}

export async function migrateWorkspaceStorage(
  options: MigrateWorkspaceStorageOptions,
): Promise<SchemaMigrationResult> {
  const databasePath = resolve(workspaceDatabasePath(options.workspacePath));
  if (!existsSync(databasePath)) {
    throw new StorageOpenError(
      "DATABASE_NOT_FOUND",
      "Workspace database does not exist",
    );
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const now = clock();
  const defaultBackupName = `schema-migration-to-v${CURRENT_SCHEMA_VERSION}-${now.replace(/[:.]/g, "-")}-${randomUUID()}.sqlite3`;
  const backupPath = resolve(
    options.backupPath ??
      join(dirname(databasePath), "backups", defaultBackupName),
  );
  if (backupPath === databasePath) {
    throw new StorageOpenError(
      "BACKUP_TARGET_IS_LIVE_DATABASE",
      "Migration backup cannot overwrite the live workspace database",
    );
  }
  if (existsSync(backupPath)) {
    throw new StorageOpenError(
      "BACKUP_DESTINATION_EXISTS",
      "Migration backup destination already exists",
    );
  }

  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  const temporaryPath = `${backupPath}.tmp-${randomUUID()}`;
  try {
    configureConnection(database, false);
    verifyDatabase(database);
    const applicationId = sqlitePragmaNumber(database, "application_id");
    const fromVersion = sqlitePragmaNumber(database, "user_version");
    if (applicationId !== APPLICATION_ID || fromVersion === 0) {
      throw new StorageOpenError(
        "UNRECOGNIZED_DATABASE",
        "Workspace database is not a recognized Writing Agent database",
      );
    }
    if (fromVersion === CURRENT_SCHEMA_VERSION) {
      throw new StorageOpenError(
        "SCHEMA_ALREADY_CURRENT",
        "Workspace database is already at the current schema version",
      );
    }
    if (fromVersion > CURRENT_SCHEMA_VERSION) {
      throw new StorageOpenError(
        "SCHEMA_UNSUPPORTED",
        `Workspace schema ${fromVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (
      fromVersion !== 1 &&
      fromVersion !== 2 &&
      fromVersion !== 3 &&
      fromVersion !== 4 &&
      fromVersion !== 5 &&
      fromVersion !== 6 &&
      fromVersion !== 7
    ) {
      throw new StorageOpenError(
        "SCHEMA_MIGRATION_UNSUPPORTED",
        `No ordered migration is available from schema ${fromVersion}`,
      );
    }

    mkdirSync(dirname(backupPath), { recursive: true });
    await backupDatabase(database, temporaryPath);
    const backupInspection = inspectDatabaseFile(temporaryPath);
    if (
      !backupInspection.ok ||
      backupInspection.applicationId !== APPLICATION_ID ||
      backupInspection.schemaVersion !== fromVersion ||
      backupInspection.integrity !== "ok"
    ) {
      throw new StorageOpenError(
        "BACKUP_VERIFICATION_FAILED",
        "Migration backup did not pass identity, schema and integrity verification",
      );
    }
    if (existsSync(backupPath)) {
      throw new StorageOpenError(
        "BACKUP_DESTINATION_EXISTS",
        "Migration backup destination was created while backup was running",
      );
    }
    renameSync(temporaryPath, backupPath);
    const backup: BackupManifest = {
      path: backupPath,
      sizeBytes: statSync(backupPath).size,
      sha256: fileSha256(backupPath),
      schemaVersion: fromVersion,
      createdAt: now,
    };

    database.exec("BEGIN IMMEDIATE");
    try {
      migrateSchema(database, fromVersion, now);
      backfillBodyDocuments(database, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new StorageOpenError(
        "SCHEMA_MIGRATION_FAILED",
        "Workspace schema migration failed; the verified backup was preserved",
        { cause: error },
      );
    }
    verifyDatabase(database);
    if (sqlitePragmaNumber(database, "user_version") !== CURRENT_SCHEMA_VERSION) {
      throw new StorageOpenError(
        "SCHEMA_MIGRATION_FAILED",
        "Workspace schema version did not advance after migration",
      );
    }
    return {
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      backup,
    };
  } finally {
    database.close();
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export async function restoreWorkspaceBackup(
  options: RestoreWorkspaceBackupOptions,
): Promise<BackupManifest> {
  const backupPath = resolve(options.backupPath);
  const targetPath = resolve(workspaceDatabasePath(options.targetWorkspacePath));
  if (backupPath === targetPath) {
    throw new StorageOpenError(
      "RESTORE_SOURCE_IS_TARGET",
      "Restore source and target must be different files",
    );
  }
  if (existsSync(targetPath)) {
    throw new StorageOpenError(
      "RESTORE_TARGET_EXISTS",
      "Restore target already contains a workspace database",
    );
  }
  const sourceInspection = inspectDatabaseFile(backupPath);
  if (!sourceInspection.ok) {
    throw new StorageOpenError(sourceInspection.code, sourceInspection.message);
  }
  if (!sourceInspection.supported) {
    throw new StorageOpenError(
      "SCHEMA_UNSUPPORTED",
      `Backup schema ${sourceInspection.schemaVersion} is not supported`,
    );
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  const source = new DatabaseSync(backupPath, { readOnly: true, timeout: 5000 });
  try {
    await backupDatabase(source, temporaryPath);
  } finally {
    source.close();
  }
  try {
    const restoredInspection = inspectDatabaseFile(temporaryPath);
    if (!restoredInspection.ok || !restoredInspection.supported) {
      throw new StorageOpenError(
        "RESTORE_VERIFICATION_FAILED",
        "Restored database did not pass schema and integrity verification",
      );
    }
    if (existsSync(targetPath)) {
      throw new StorageOpenError(
        "RESTORE_TARGET_EXISTS",
        "Restore target was created while restore was running",
      );
    }
    renameSync(temporaryPath, targetPath);
    return {
      path: targetPath,
      sizeBytes: statSync(targetPath).size,
      sha256: fileSha256(targetPath),
      schemaVersion: restoredInspection.schemaVersion,
      createdAt: new Date().toISOString(),
    };
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}
