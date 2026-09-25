import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";

import { canonicalJson } from "../../writing-core/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";

export type LegacySourceSpec =
  | { readonly kind: "manifest"; readonly projectPath: string }
  | {
      readonly kind: "desktop_v0_1";
      readonly databasePath: string;
      readonly artifactsRoot: string;
    };

export interface LegacyMigrationProjectPlan {
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly name: string;
  readonly mode: "quick" | "deep";
  readonly artifactCount: number;
  readonly legacyFactStatus: string;
  readonly migratedFactStatus: "not_checked";
  readonly authorAttribution: "unknown/legacy_import";
  readonly styleStatus: "not_present" | "legacy_unknown";
}

export interface LegacyMigrationPlan {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly planHash: string;
  readonly createdAt: string;
  readonly source: LegacySourceSpec;
  readonly sourceLocatorHash: string;
  readonly sourceContentHash: string;
  readonly targetWorkspacePath: string;
  readonly projects: readonly LegacyMigrationProjectPlan[];
  readonly credentialDisposition: "excluded_requires_explicit_consent";
  readonly warnings: readonly string[];
  readonly spaceCheck: {
    readonly requiredBytes: number;
    readonly availableBytes: number;
    readonly ok: boolean;
  };
}

export interface PlanLegacyMigrationInput {
  readonly source: LegacySourceSpec;
  readonly targetWorkspacePath: string;
  readonly clock?: () => string;
  readonly spaceProbe?: (targetWorkspacePath: string) => number;
}

export interface ApplyLegacyMigrationInput {
  readonly plan: LegacyMigrationPlan;
  readonly clock?: () => string;
  readonly spaceProbe?: (targetWorkspacePath: string) => number;
  readonly checkpoint?: (name: string) => void | Promise<void>;
}

export interface LegacyMigrationProjectReport {
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly finalProjectRevision: number;
  readonly artifactVersionCount: number;
  readonly legacyFactStatus: string;
  readonly factGateStatus: "not_checked";
  readonly styleStatus: "not_present" | "legacy_unknown";
}

export interface LegacyMigrationReport {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly planHash: string;
  readonly status: "completed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceKind: LegacySourceSpec["kind"];
  readonly sourceContentHash: string;
  readonly sourceUnchanged: true;
  readonly sourceBackupPath: string;
  readonly reportPath: string;
  readonly targetPreImportBackupPath: string | null;
  readonly credentialDisposition: "excluded_requires_explicit_consent";
  readonly projects: readonly LegacyMigrationProjectReport[];
}

export interface RollbackLegacyMigrationInput {
  readonly workspacePath: string;
  readonly reportPath: string;
  readonly confirmedProjectId: string;
}

export interface LegacyMigrationRollbackReport {
  readonly importId: string;
  readonly deletedProjectId: string;
  readonly status: "deleted";
  readonly receiptPath: string;
}

interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly content: string;
}

interface ScannedArtifact {
  readonly sourceId: string;
  readonly kind: "body" | "title" | "evidence" | "review" | "report" | "outline";
  readonly logicalKey: string;
  readonly content: string;
  readonly contentHash: string;
}

interface ScannedProject {
  readonly sourceProjectId: string;
  readonly targetProjectId: string;
  readonly name: string;
  readonly mode: "quick" | "deep";
  readonly topic: string;
  readonly audience: string;
  readonly targetCharacters: number;
  readonly legacyFactStatus: string;
  readonly styleReference: string | null;
  readonly artifacts: readonly ScannedArtifact[];
}

interface ScannedSource {
  readonly source: LegacySourceSpec;
  readonly sourceRoot: string;
  readonly additionalSourceRoots: readonly string[];
  readonly desktopDatabasePath: string | null;
  readonly desktopLogicalDatabaseHash: string | null;
  readonly sourceLocatorHash: string;
  readonly sourceContentHash: string;
  readonly files: readonly ScannedFile[];
  readonly projects: readonly ScannedProject[];
  readonly warnings: readonly string[];
  readonly totalBytes: number;
}

export class LegacyMigrationError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyMigrationError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function strictUtf8(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new LegacyMigrationError(
      "LEGACY_TEXT_INVALID",
      `Legacy text file is not readable UTF-8: ${basename(path)}`,
      { cause: error },
    );
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot.length === 0 ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function requireSourceDirectory(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new LegacyMigrationError("LEGACY_SOURCE_NOT_FOUND", "Legacy source does not exist");
  }
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_INVALID",
      "Legacy manifest source must be a real directory",
    );
  }
  return realpathSync(resolved);
}

function requireContainedFile(root: string, reference: string): string {
  const normalized = reference.trim();
  if (normalized.length === 0 || isAbsolute(normalized)) {
    throw new LegacyMigrationError(
      "LEGACY_PATH_INVALID",
      "Legacy manifest references an invalid path",
    );
  }
  const candidate = resolve(root, normalized);
  if (!pathIsInside(root, candidate)) {
    throw new LegacyMigrationError(
      "LEGACY_PATH_OUTSIDE_SOURCE",
      "Legacy manifest path escapes the selected source directory",
    );
  }
  let current = root;
  for (const segment of relative(root, candidate).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    if (!existsSync(current)) {
      throw new LegacyMigrationError(
        "LEGACY_FILE_NOT_FOUND",
        `Legacy manifest file is missing: ${normalized}`,
      );
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new LegacyMigrationError(
        "LEGACY_SYMLINK_REJECTED",
        "Legacy import does not follow symbolic links",
      );
    }
  }
  if (!lstatSync(candidate).isFile()) {
    throw new LegacyMigrationError(
      "LEGACY_FILE_INVALID",
      `Legacy manifest reference is not a file: ${normalized}`,
    );
  }
  return candidate;
}

function readScannedFile(root: string, reference: string): ScannedFile {
  const absolutePath = requireContainedFile(root, reference);
  const bytes = readFileSync(absolutePath);
  const content = strictUtf8(absolutePath);
  return {
    absolutePath,
    relativePath: relative(root, absolutePath).split(sep).join("/"),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    content,
  };
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function headingFromMarkdown(content: string): string | null {
  const heading = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/u.test(line));
  return heading?.replace(/^#{1,6}\s+/u, "").trim() ?? null;
}

function artifact(
  sourceId: string,
  kind: ScannedArtifact["kind"],
  logicalKey: string,
  content: string,
): ScannedArtifact {
  return { sourceId, kind, logicalKey, content, contentHash: sha256(content) };
}

function scanManifestSource(source: Extract<LegacySourceSpec, { kind: "manifest" }>): ScannedSource {
  const sourceRoot = requireSourceDirectory(source.projectPath);
  const manifestFile = readScannedFile(sourceRoot, "run_manifest.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestFile.content) as unknown;
  } catch (error) {
    throw new LegacyMigrationError(
      "LEGACY_MANIFEST_INVALID",
      "Legacy run_manifest.json is not valid JSON",
      { cause: error },
    );
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new LegacyMigrationError(
      "LEGACY_MANIFEST_INVALID",
      "Legacy run_manifest.json must contain an object",
    );
  }
  const manifest = decoded as Record<string, unknown>;
  const bodyReference = stringField(manifest, "latest_body_file");
  if (bodyReference === null) {
    throw new LegacyMigrationError(
      "LEGACY_BODY_POINTER_MISSING",
      "Legacy manifest does not identify the latest body file",
    );
  }

  const files = new Map<string, ScannedFile>();
  files.set(manifestFile.relativePath, manifestFile);
  const bodyFile = readScannedFile(sourceRoot, bodyReference);
  files.set(bodyFile.relativePath, bodyFile);

  const artifacts: ScannedArtifact[] = [
    artifact(bodyFile.relativePath, "body", "main", bodyFile.content),
  ];
  const optionalFiles: Array<{
    key: string;
    fallback: string;
    kind: ScannedArtifact["kind"];
    logicalKey: string;
  }> = [
    { key: "title_file", fallback: "04_title.md", kind: "title", logicalKey: "main" },
    {
      key: "evidence_ledger_file",
      fallback: "02_evidence_ledger.json",
      kind: "evidence",
      logicalKey: "ledger",
    },
    { key: "latest_notes_file", fallback: "", kind: "review", logicalKey: "legacy-notes" },
  ];
  for (const item of optionalFiles) {
    const explicit = stringField(manifest, item.key);
    const reference = explicit ?? (item.fallback.length > 0 && existsSync(resolve(sourceRoot, item.fallback))
      ? item.fallback
      : null);
    if (reference === null) continue;
    const file = readScannedFile(sourceRoot, reference);
    files.set(file.relativePath, file);
    artifacts.push(artifact(file.relativePath, item.kind, item.logicalKey, file.content));
  }
  const cleanReference = stringField(manifest, "clean_source_file");
  if (cleanReference !== null) {
    const cleanFile = readScannedFile(sourceRoot, cleanReference);
    files.set(cleanFile.relativePath, cleanFile);
  }

  const fileInventory = [...files.values()]
    .map((file) => ({ path: file.relativePath, sha256: file.sha256, byteLength: file.byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const sourceContentHash = sha256(canonicalJson(fileInventory));
  const sourceLocatorHash = sha256(`manifest:${sourceRoot}`);
  const sourceProjectId = stringField(manifest, "project_id") ?? basename(sourceRoot);
  const targetProjectId = `legacy-${sha256(
    canonicalJson({ sourceLocatorHash, sourceProjectId, sourceContentHash }),
  ).slice(0, 32)}`;
  const name =
    stringField(manifest, "project_name") ??
    headingFromMarkdown(bodyFile.content) ??
    sourceProjectId;
  const mode = manifest.mode === "quick" ? "quick" : "deep";
  const styleReference = stringField(manifest, "style_profile_id");

  return {
    source: { kind: "manifest", projectPath: sourceRoot },
    sourceRoot,
    additionalSourceRoots: [],
    desktopDatabasePath: null,
    desktopLogicalDatabaseHash: null,
    sourceLocatorHash,
    sourceContentHash,
    files: [...files.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    projects: [
      {
        sourceProjectId,
        targetProjectId,
        name,
        mode,
        topic: stringField(manifest, "topic") ?? name,
        audience: stringField(manifest, "audience") ?? "unknown/legacy_import",
        targetCharacters: Math.max(1, bodyFile.content.length),
        legacyFactStatus: stringField(manifest, "fact_check_status") ?? "unknown",
        styleReference,
        artifacts,
      },
    ],
    warnings: [
      "Legacy event history is not reconstructed.",
      "Legacy fact-check state is imported as not_checked and requires a new check.",
    ],
    totalBytes: [...files.values()].reduce((total, file) => total + file.byteLength, 0),
  };
}

interface DesktopProjectRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly mode: string;
  readonly topic: string;
  readonly audience: string;
  readonly word_target: number | null;
  readonly style_profile_id: string | null;
  readonly model_profile_id: string;
  readonly current_stage: string;
  readonly status: string;
  readonly is_archived: number;
  readonly archived_at: string | null;
  readonly workspace_path: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface DesktopOutputRow {
  readonly id: string;
  readonly project_id: string;
  readonly stage_key: string;
  readonly version: number;
  readonly markdown: string;
  readonly artifact_path: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function requireRegularFile(path: string, code: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new LegacyMigrationError(code, "Legacy source file does not exist");
  }
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new LegacyMigrationError(code, "Legacy source must be a real file");
  }
  return realpathSync(resolved);
}

function sqliteNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== "number") {
    throw new LegacyMigrationError(
      "LEGACY_DATABASE_INVALID",
      `Legacy database PRAGMA ${pragma} did not return a number`,
    );
  }
  return value;
}

const DESKTOP_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  writing_projects: [
    "id",
    "slug",
    "title",
    "mode",
    "topic",
    "audience",
    "word_target",
    "style_profile_id",
    "model_profile_id",
    "current_stage",
    "status",
    "is_archived",
    "archived_at",
    "workspace_path",
    "created_at",
    "updated_at",
  ],
  stage_outputs: [
    "id",
    "project_id",
    "stage_key",
    "version",
    "markdown",
    "artifact_path",
    "created_at",
    "updated_at",
  ],
  model_profiles: ["id", "provider_label", "protocol", "base_url", "model"],
  exports: ["id", "project_id", "format", "file_path", "created_at"],
  app_settings: ["key", "value", "updated_at"],
};

function verifyDesktopSchema(database: DatabaseSync): void {
  const userVersion = sqliteNumber(database, "user_version");
  if (userVersion !== 0) {
    throw new LegacyMigrationError(
      "LEGACY_SCHEMA_UNSUPPORTED",
      `Legacy desktop schema version ${userVersion} is not supported`,
    );
  }
  for (const [table, required] of Object.entries(DESKTOP_REQUIRED_COLUMNS)) {
    const tableExists = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table);
    if (tableExists === undefined) {
      throw new LegacyMigrationError(
        "LEGACY_SCHEMA_INVALID",
        `Legacy desktop table is missing: ${table}`,
      );
    }
    const columns = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const column of required) {
      if (!columns.has(column)) {
        throw new LegacyMigrationError(
          "LEGACY_SCHEMA_INVALID",
          `Legacy desktop column is missing: ${table}.${column}`,
        );
      }
    }
  }
}

function desktopArtifactTarget(stageKey: string): {
  kind: ScannedArtifact["kind"];
  logicalKey: string;
} {
  switch (stageKey) {
    case "research":
      return { kind: "evidence", logicalKey: "legacy-research" };
    case "outline":
      return { kind: "outline", logicalKey: "main" };
    case "titles":
      return { kind: "title", logicalKey: "main" };
    case "draft":
    case "humanize":
      return { kind: "body", logicalKey: "main" };
    case "review":
      return { kind: "review", logicalKey: "main" };
    case "theme":
    case "position":
      return { kind: "report", logicalKey: `legacy-stage-${stageKey}` };
    default:
      return {
        kind: "report",
        logicalKey: `legacy-stage-${stageKey.replace(/[^a-z0-9_-]/giu, "-") || "unknown"}`,
      };
  }
}

function parseDesktopProjectManifest(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(strictUtf8(path)) as unknown;
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      "LEGACY_PROJECT_MANIFEST_INVALID",
      "Legacy desktop project.json is invalid",
      { cause: error },
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyMigrationError(
      "LEGACY_PROJECT_MANIFEST_INVALID",
      "Legacy desktop project.json must contain an object",
    );
  }
  return value as Record<string, unknown>;
}

function desktopProjectDirectory(
  artifactsRoot: string,
  project: DesktopProjectRow,
): { path: string; manifest: Record<string, unknown>; file: ScannedFile } {
  const workspaceBase = basename(project.workspace_path.replace(/[\\/]+$/u, ""));
  const candidates = [artifactsRoot, join(artifactsRoot, project.slug)];
  if (workspaceBase.length > 0) candidates.push(join(artifactsRoot, workspaceBase));
  candidates.push(join(artifactsRoot, project.id));

  for (const candidate of [...new Set(candidates.map((value) => resolve(value)))]) {
    if (!pathIsInside(artifactsRoot, candidate) || !existsSync(candidate)) continue;
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
    const manifestPath = join(candidate, "project.json");
    if (!existsSync(manifestPath)) continue;
    const file = readScannedFile(artifactsRoot, relative(artifactsRoot, manifestPath));
    const manifest = parseDesktopProjectManifest(manifestPath);
    if (manifest.id !== project.id) continue;
    if (
      manifest.slug !== project.slug ||
      manifest.title !== project.title ||
      manifest.mode !== project.mode
    ) {
      throw new LegacyMigrationError(
        "LEGACY_PROJECT_CONFLICT",
        `Legacy project.json does not match database project ${project.id}`,
      );
    }
    return { path: candidate, manifest, file };
  }
  throw new LegacyMigrationError(
    "LEGACY_PROJECT_MANIFEST_NOT_FOUND",
    `No matching project.json was found for legacy project ${project.id}`,
  );
}

function scanDesktopSource(
  source: Extract<LegacySourceSpec, { kind: "desktop_v0_1" }>,
): ScannedSource {
  const databasePath = requireRegularFile(source.databasePath, "LEGACY_DATABASE_NOT_FOUND");
  const artifactsRoot = requireSourceDirectory(source.artifactsRoot);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
    database.enableLoadExtension(false);
    database.enableDefensive(true);
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;");
    const check = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (check === undefined || Object.values(check)[0] !== "ok") {
      throw new LegacyMigrationError(
        "LEGACY_DATABASE_CORRUPT",
        "Legacy desktop database failed SQLite quick_check",
      );
    }
    verifyDesktopSchema(database);

    const projectRows = database
      .prepare(
        `SELECT id, slug, title, mode, topic, audience, word_target,
                style_profile_id, model_profile_id, current_stage, status,
                is_archived, archived_at, workspace_path, created_at, updated_at
           FROM writing_projects
          ORDER BY created_at ASC, id ASC`,
      )
      .all() as unknown as DesktopProjectRow[];
    if (projectRows.length === 0) {
      throw new LegacyMigrationError(
        "LEGACY_PROJECTS_EMPTY",
        "Legacy desktop database contains no writing projects",
      );
    }
    const outputRows = database
      .prepare(
        `SELECT id, project_id, stage_key, version, markdown, artifact_path,
                created_at, updated_at
           FROM stage_outputs
          ORDER BY created_at ASC, version ASC, id ASC`,
      )
      .all() as unknown as DesktopOutputRow[];
    const files = new Map<string, ScannedFile>();
    const warnings = [
      "Legacy event history is not reconstructed.",
      "Legacy fact-check state is imported as not_checked and requires a new check.",
      "Legacy model credentials are excluded and require separate explicit consent.",
    ];
    const sourceLocatorHash = sha256(`desktop:${databasePath}:${artifactsRoot}`);
    const projectInputs: Array<{
      row: DesktopProjectRow;
      outputs: DesktopOutputRow[];
      artifacts: ScannedArtifact[];
      contentHash: string;
    }> = [];

    for (const row of projectRows) {
      if (row.mode !== "quick" && row.mode !== "deep") {
        throw new LegacyMigrationError(
          "LEGACY_PROJECT_INVALID",
          `Legacy project ${row.id} has an unsupported mode`,
        );
      }
      const located = desktopProjectDirectory(artifactsRoot, row);
      files.set(located.file.relativePath, located.file);
      const projectOutputs = outputRows.filter((output) => output.project_id === row.id);
      const artifacts: ScannedArtifact[] = [];
      for (const output of projectOutputs) {
        if (
          typeof output.markdown !== "string" ||
          typeof output.stage_key !== "string" ||
          !Number.isInteger(output.version) ||
          output.version < 1
        ) {
          throw new LegacyMigrationError(
            "LEGACY_OUTPUT_INVALID",
            `Legacy stage output ${output.id} is invalid`,
          );
        }
        const externalName = basename(output.artifact_path.replaceAll("\\", "/"));
        const externalPath = join(located.path, externalName);
        if (externalName.length > 0 && existsSync(externalPath)) {
          const file = readScannedFile(artifactsRoot, relative(artifactsRoot, externalPath));
          if (file.content !== output.markdown) {
            throw new LegacyMigrationError(
              "LEGACY_ARTIFACT_MISMATCH",
              `Legacy artifact does not match SQLite content: ${externalName}`,
            );
          }
          files.set(file.relativePath, file);
        } else {
          warnings.push(`Artifact file missing; SQLite copy will be used: ${row.id}/${externalName}`);
        }
        const target = desktopArtifactTarget(output.stage_key);
        artifacts.push(
          artifact(
            `desktop:${output.stage_key}:v${output.version}:${output.id}`,
            target.kind,
            target.logicalKey,
            output.markdown,
          ),
        );
      }
      const contentHash = sha256(
        canonicalJson({
          project: row,
          manifest: located.manifest,
          outputs: projectOutputs,
          fileHashes: [...files.values()]
            .filter((file) => pathIsInside(located.path, file.absolutePath))
            .map((file) => ({ path: file.relativePath, sha256: file.sha256 }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        }),
      );
      projectInputs.push({ row, outputs: projectOutputs, artifacts, contentHash });
    }

    const logicalDatabaseHash = sha256(
      canonicalJson({ projects: projectRows, outputs: outputRows }),
    );
    const fileInventory = [...files.values()]
      .map((file) => ({ path: file.relativePath, sha256: file.sha256, byteLength: file.byteLength }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const sourceContentHash = sha256(
      canonicalJson({ logicalDatabaseHash, files: fileInventory }),
    );
    return {
      source: { kind: "desktop_v0_1", databasePath, artifactsRoot },
      sourceRoot: dirname(databasePath),
      additionalSourceRoots: [artifactsRoot],
      desktopDatabasePath: databasePath,
      desktopLogicalDatabaseHash: logicalDatabaseHash,
      sourceLocatorHash,
      sourceContentHash,
      files: [...files.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      projects: projectInputs.map(({ row, artifacts, contentHash }) => ({
        sourceProjectId: row.id,
        targetProjectId: `legacy-${sha256(
          canonicalJson({ sourceLocatorHash, sourceProjectId: row.id, contentHash }),
        ).slice(0, 32)}`,
        name: row.title,
        mode: row.mode as "quick" | "deep",
        topic: row.topic,
        audience: row.audience,
        targetCharacters:
          typeof row.word_target === "number" && row.word_target > 0
            ? row.word_target
            : Math.max(1, artifacts.findLast((item) => item.kind === "body")?.content.length ?? 1),
        legacyFactStatus: "not_available",
        styleReference: row.style_profile_id,
        artifacts,
      })),
      warnings: [...new Set(warnings)],
      totalBytes:
        statSync(databasePath).size +
        [...files.values()].reduce((total, file) => total + file.byteLength, 0),
    };
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      "LEGACY_DATABASE_CORRUPT",
      "Legacy desktop database could not be read safely",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}

function nearestExistingPath(path: string): string {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function assertMigrationTargetWritable(path: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new LegacyMigrationError(
        "TARGET_NOT_WRITABLE",
        "Migration target must be a writable real directory",
      );
    }
  }
  try {
    accessSync(nearestExistingPath(target), fsConstants.W_OK);
  } catch (error) {
    throw new LegacyMigrationError(
      "TARGET_NOT_WRITABLE",
      "Migration target or its nearest existing parent is not writable",
      { cause: error },
    );
  }
}

function availableBytes(path: string): number {
  const stats = statfsSync(nearestExistingPath(path));
  const value = BigInt(stats.bavail) * BigInt(stats.bsize);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

function planHashInput(plan: Omit<LegacyMigrationPlan, "planHash" | "createdAt" | "spaceCheck">): string {
  return canonicalJson(plan);
}

export function planLegacyMigration(input: PlanLegacyMigrationInput): LegacyMigrationPlan {
  const scanned =
    input.source.kind === "manifest"
      ? scanManifestSource(input.source)
      : scanDesktopSource(input.source);
  const targetWorkspacePath = resolve(input.targetWorkspacePath);
  if (
    [scanned.sourceRoot, ...scanned.additionalSourceRoots].some((root) =>
      pathIsInside(root, targetWorkspacePath),
    )
  ) {
    throw new LegacyMigrationError(
      "TARGET_INSIDE_SOURCE",
      "Migration target must be outside the read-only legacy source",
    );
  }
  const requiredBytes = Math.max(1_048_576, scanned.totalBytes * 3 + 1_048_576);
  const freeBytes = input.spaceProbe?.(targetWorkspacePath) ?? availableBytes(targetWorkspacePath);
  const importId = `import-${sha256(
    canonicalJson({
      sourceLocatorHash: scanned.sourceLocatorHash,
      sourceContentHash: scanned.sourceContentHash,
      targetWorkspacePath,
    }),
  ).slice(0, 32)}`;
  const withoutHash: Omit<LegacyMigrationPlan, "planHash" | "createdAt" | "spaceCheck"> = {
    schemaVersion: 1,
    importId,
    source: scanned.source,
    sourceLocatorHash: scanned.sourceLocatorHash,
    sourceContentHash: scanned.sourceContentHash,
    targetWorkspacePath,
    projects: scanned.projects.map((project) => ({
      sourceProjectId: project.sourceProjectId,
      targetProjectId: project.targetProjectId,
      name: project.name,
      mode: project.mode,
      artifactCount: project.artifacts.length,
      legacyFactStatus: project.legacyFactStatus,
      migratedFactStatus: "not_checked",
      authorAttribution: "unknown/legacy_import",
      styleStatus: project.styleReference === null ? "not_present" : "legacy_unknown",
    })),
    credentialDisposition: "excluded_requires_explicit_consent",
    warnings: scanned.warnings,
  };
  return {
    ...withoutHash,
    planHash: sha256(planHashInput(withoutHash)),
    createdAt: input.clock?.() ?? new Date().toISOString(),
    spaceCheck: {
      requiredBytes,
      availableBytes: freeBytes,
      ok: freeBytes >= requiredBytes,
    },
  };
}

export function parseLegacyMigrationPlan(value: unknown): LegacyMigrationPlan {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyMigrationError(
      "MIGRATION_PLAN_INVALID",
      "Migration plan must contain an object",
    );
  }
  const plan = value as Partial<LegacyMigrationPlan>;
  const source = plan.source as Partial<LegacySourceSpec> | undefined;
  const sourceValid =
    source?.kind === "manifest"
      ? typeof (source as { projectPath?: unknown }).projectPath === "string"
      : source?.kind === "desktop_v0_1" &&
        typeof (source as { databasePath?: unknown }).databasePath === "string" &&
        typeof (source as { artifactsRoot?: unknown }).artifactsRoot === "string";
  if (
    plan.schemaVersion !== 1 ||
    typeof plan.importId !== "string" ||
    typeof plan.planHash !== "string" ||
    typeof plan.createdAt !== "string" ||
    !sourceValid ||
    typeof plan.sourceLocatorHash !== "string" ||
    typeof plan.sourceContentHash !== "string" ||
    typeof plan.targetWorkspacePath !== "string" ||
    !Array.isArray(plan.projects) ||
    plan.credentialDisposition !== "excluded_requires_explicit_consent" ||
    !Array.isArray(plan.warnings) ||
    plan.spaceCheck === undefined ||
    typeof plan.spaceCheck.requiredBytes !== "number" ||
    typeof plan.spaceCheck.availableBytes !== "number" ||
    typeof plan.spaceCheck.ok !== "boolean"
  ) {
    throw new LegacyMigrationError(
      "MIGRATION_PLAN_INVALID",
      "Migration plan is incomplete or unsupported",
    );
  }
  for (const project of plan.projects) {
    if (
      project === null ||
      typeof project !== "object" ||
      typeof project.sourceProjectId !== "string" ||
      typeof project.targetProjectId !== "string" ||
      typeof project.name !== "string" ||
      (project.mode !== "quick" && project.mode !== "deep") ||
      !Number.isInteger(project.artifactCount) ||
      typeof project.legacyFactStatus !== "string" ||
      project.migratedFactStatus !== "not_checked" ||
      project.authorAttribution !== "unknown/legacy_import" ||
      (project.styleStatus !== "not_present" && project.styleStatus !== "legacy_unknown")
    ) {
      throw new LegacyMigrationError(
        "MIGRATION_PLAN_INVALID",
        "Migration plan contains an invalid project entry",
      );
    }
  }
  return plan as LegacyMigrationPlan;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const descriptor = openSync(temporary, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (existsSync(path)) {
      throw new LegacyMigrationError(
        "MIGRATION_STATE_CONFLICT",
        "Migration state destination already exists",
      );
    }
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

async function renameDirectoryWithTransientRetry(source: string, target: string): Promise<void> {
  const delays = [0, 25, 75, 150] as const;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    try {
      renameSync(source, target);
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
      const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!retryable || attempt === delays.length - 1) throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delays[attempt + 1]));
    }
  }
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(strictUtf8(path)) as unknown;
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    throw new LegacyMigrationError(
      "MIGRATION_STATE_INVALID",
      "Migration state JSON is invalid",
      { cause: error },
    );
  }
}

interface SourceBackupManifest {
  readonly schemaVersion: 1;
  readonly planHash: string;
  readonly sourceContentHash: string;
  readonly files: readonly { path: string; sha256: string; byteLength: number }[];
  desktopDatabase:
    | { path: "writing-agent.db"; sha256: string; logicalContentHash: string }
    | null;
}

interface MigrationState {
  readonly schemaVersion: 1;
  readonly planHash: string;
  readonly sourceContentHash: string;
  readonly targetDatabaseExistedBefore: boolean;
  readonly targetBackupRelativePath: string | null;
  readonly targetBackupSha256: string | null;
}

function logicalDesktopDatabaseHash(database: DatabaseSync): string {
  verifyDesktopSchema(database);
  const projects = database
    .prepare(
      `SELECT id, slug, title, mode, topic, audience, word_target,
              style_profile_id, model_profile_id, current_stage, status,
              is_archived, archived_at, workspace_path, created_at, updated_at
         FROM writing_projects
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as unknown as DesktopProjectRow[];
  const outputs = database
    .prepare(
      `SELECT id, project_id, stage_key, version, markdown, artifact_path,
              created_at, updated_at
         FROM stage_outputs
        ORDER BY created_at ASC, version ASC, id ASC`,
    )
    .all() as unknown as DesktopOutputRow[];
  return sha256(canonicalJson({ projects, outputs }));
}

function backupFile(backupPath: string, reference: string): string {
  if (!existsSync(backupPath) || lstatSync(backupPath).isSymbolicLink()) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_INCOMPLETE",
      "Existing source backup is missing or unsafe",
    );
  }
  try {
    return requireContainedFile(backupPath, reference);
  } catch (error) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_INCOMPLETE",
      "Existing source backup is incomplete or unsafe",
      { cause: error },
    );
  }
}

function verifySourceBackup(
  scanned: ScannedSource,
  plan: LegacyMigrationPlan,
  backupPath: string,
): void {
  const manifestPath = backupFile(backupPath, "backup-manifest.json");
  const existing = parseJsonFile(manifestPath) as Partial<SourceBackupManifest>;
  if (
    existing.schemaVersion !== 1 ||
    existing.planHash !== plan.planHash ||
    existing.sourceContentHash !== scanned.sourceContentHash ||
    !Array.isArray(existing.files)
  ) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_CONFLICT",
      "Existing source backup does not match this migration plan",
    );
  }
  if (existing.files.length !== scanned.files.length) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_INCOMPLETE",
      "Existing source backup file inventory is incomplete",
    );
  }
  for (const sourceFile of scanned.files) {
    const recorded = existing.files.find(
      (candidate) =>
        candidate.path === sourceFile.relativePath &&
        candidate.sha256 === sourceFile.sha256 &&
        candidate.byteLength === sourceFile.byteLength,
    );
    if (recorded === undefined) {
      throw new LegacyMigrationError(
        "SOURCE_BACKUP_CONFLICT",
        "Existing source backup file inventory does not match the source scan",
      );
    }
    const copiedPath = backupFile(
      backupPath,
      `files/${sourceFile.relativePath}`,
    );
    if (sha256(readFileSync(copiedPath)) !== sourceFile.sha256) {
      throw new LegacyMigrationError(
        "SOURCE_BACKUP_HASH_MISMATCH",
        `Source backup hash mismatch: ${sourceFile.relativePath}`,
      );
    }
  }

  if (scanned.desktopDatabasePath === null) {
    if (existing.desktopDatabase !== null) {
      throw new LegacyMigrationError(
        "SOURCE_BACKUP_CONFLICT",
        "Manifest source backup unexpectedly contains a desktop database record",
      );
    }
    return;
  }
  if (
    existing.desktopDatabase === null ||
    existing.desktopDatabase === undefined ||
    existing.desktopDatabase.path !== "writing-agent.db" ||
    typeof existing.desktopDatabase.sha256 !== "string" ||
    typeof existing.desktopDatabase.logicalContentHash !== "string"
  ) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_INCOMPLETE",
      "Desktop source backup is missing its database record",
    );
  }
  const databasePath = backupFile(backupPath, "writing-agent.db");
  if (sha256(readFileSync(databasePath)) !== existing.desktopDatabase.sha256) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_DATABASE_MISMATCH",
      "Legacy desktop database backup bytes have changed",
    );
  }
  let database: DatabaseSync | undefined;
  let logicalContentHash: string;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
    database.enableLoadExtension(false);
    database.enableDefensive(true);
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const check = database.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    if (check === undefined || Object.values(check)[0] !== "ok") {
      throw new Error("quick_check failed");
    }
    logicalContentHash = logicalDesktopDatabaseHash(database);
  } catch (error) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_DATABASE_INVALID",
      "Legacy desktop database backup is not readable and valid",
      { cause: error },
    );
  } finally {
    database?.close();
  }
  if (
    logicalContentHash !== scanned.desktopLogicalDatabaseHash ||
    logicalContentHash !== existing.desktopDatabase.logicalContentHash
  ) {
    throw new LegacyMigrationError(
      "SOURCE_BACKUP_DATABASE_MISMATCH",
      "Legacy desktop database backup does not match the scanned source",
    );
  }
}

async function prepareSourceBackup(
  scanned: ScannedSource,
  plan: LegacyMigrationPlan,
  backupPath: string,
): Promise<void> {
  const manifestPath = join(backupPath, "backup-manifest.json");
  if (existsSync(backupPath)) {
    verifySourceBackup(scanned, plan, backupPath);
    return;
  }

  const temporary = `${backupPath}.tmp-${randomUUID()}`;
  try {
    for (const file of scanned.files) {
      const destination = join(temporary, "files", ...file.relativePath.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file.absolutePath, destination);
      if (sha256(readFileSync(destination)) !== file.sha256) {
        throw new LegacyMigrationError(
          "SOURCE_BACKUP_HASH_MISMATCH",
          `Source backup hash mismatch: ${file.relativePath}`,
        );
      }
    }
    const backupManifest: SourceBackupManifest = {
      schemaVersion: 1,
      planHash: plan.planHash,
      sourceContentHash: scanned.sourceContentHash,
      files: scanned.files.map((file) => ({
        path: file.relativePath,
        sha256: file.sha256,
        byteLength: file.byteLength,
      })),
      desktopDatabase: null,
    };
    if (scanned.desktopDatabasePath !== null) {
      const destination = join(temporary, "writing-agent.db");
      mkdirSync(dirname(destination), { recursive: true });
      const source = new DatabaseSync(scanned.desktopDatabasePath, {
        readOnly: true,
        timeout: 5000,
      });
      try {
        await backupDatabase(source, destination);
      } finally {
        source.close();
      }
      const backup = new DatabaseSync(destination, { readOnly: true, timeout: 5000 });
      let logicalContentHash: string;
      try {
        backup.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
        const check = backup.prepare("PRAGMA quick_check").get() as
          | Record<string, unknown>
          | undefined;
        if (check === undefined || Object.values(check)[0] !== "ok") {
          throw new LegacyMigrationError(
            "SOURCE_BACKUP_DATABASE_INVALID",
            "Legacy desktop database backup failed SQLite quick_check",
          );
        }
        logicalContentHash = logicalDesktopDatabaseHash(backup);
      } finally {
        backup.close();
      }
      if (logicalContentHash !== scanned.desktopLogicalDatabaseHash) {
        throw new LegacyMigrationError(
          "SOURCE_BACKUP_DATABASE_MISMATCH",
          "Legacy desktop database backup does not match the scanned source",
        );
      }
      backupManifest.desktopDatabase = {
        path: "writing-agent.db",
        sha256: sha256(readFileSync(destination)),
        logicalContentHash,
      };
    }
    atomicJson(join(temporary, "backup-manifest.json"), backupManifest);
    mkdirSync(dirname(backupPath), { recursive: true });
    if (existsSync(backupPath)) {
      throw new LegacyMigrationError(
        "SOURCE_BACKUP_CONFLICT",
        "Source backup destination was created concurrently",
      );
    }
    await renameDirectoryWithTransientRetry(temporary, backupPath);
    verifySourceBackup(scanned, plan, backupPath);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

async function prepareMigrationState(
  plan: LegacyMigrationPlan,
  migrationRoot: string,
): Promise<MigrationState> {
  const statePath = join(migrationRoot, "state.json");
  if (existsSync(statePath)) {
    const existing = parseJsonFile(statePath) as Partial<MigrationState>;
    if (
      existing.schemaVersion !== 1 ||
      existing.planHash !== plan.planHash ||
      existing.sourceContentHash !== plan.sourceContentHash ||
      typeof existing.targetDatabaseExistedBefore !== "boolean" ||
      !(
        typeof existing.targetBackupRelativePath === "string" ||
        existing.targetBackupRelativePath === null
      ) ||
      !(
        typeof existing.targetBackupSha256 === "string" ||
        existing.targetBackupSha256 === null
      )
    ) {
      throw new LegacyMigrationError(
        "MIGRATION_STATE_CONFLICT",
        "Existing migration state does not match the selected plan",
      );
    }
    if (existing.targetBackupRelativePath !== null) {
      const backupPath = resolve(
        plan.targetWorkspacePath,
        ...existing.targetBackupRelativePath.split("/"),
      );
      if (
        !pathIsInside(plan.targetWorkspacePath, backupPath) ||
        !existsSync(backupPath) ||
        sha256(readFileSync(backupPath)) !== existing.targetBackupSha256
      ) {
        throw new LegacyMigrationError(
          "TARGET_BACKUP_INVALID",
          "Pre-import target backup is missing or has changed",
        );
      }
    }
    return existing as MigrationState;
  }

  const databasePath = join(
    plan.targetWorkspacePath,
    ".writing-agent",
    "workspace.sqlite3",
  );
  const targetDatabaseExistedBefore = existsSync(databasePath);
  let targetBackupRelativePath: string | null = null;
  let targetBackupSha256: string | null = null;
  if (targetDatabaseExistedBefore) {
    const backupPath = join(migrationRoot, "target-before.sqlite3");
    if (!existsSync(backupPath)) {
      const storage = openWorkspaceStorage({ workspacePath: plan.targetWorkspacePath });
      try {
        const backup = await storage.createBackup(backupPath);
        targetBackupSha256 = backup.sha256;
      } finally {
        storage.close();
      }
    } else {
      targetBackupSha256 = sha256(readFileSync(backupPath));
    }
    targetBackupRelativePath = relative(plan.targetWorkspacePath, backupPath)
      .split(sep)
      .join("/");
  }
  const state: MigrationState = {
    schemaVersion: 1,
    planHash: plan.planHash,
    sourceContentHash: plan.sourceContentHash,
    targetDatabaseExistedBefore,
    targetBackupRelativePath,
    targetBackupSha256,
  };
  atomicJson(statePath, state);
  return state;
}

function requireMutation<T>(
  result:
    | { readonly ok: true; readonly projectRevision: number; readonly result: T }
    | { readonly ok: false; readonly code: string; readonly message: string },
): { readonly projectRevision: number; readonly result: T } {
  if (!result.ok) {
    throw new LegacyMigrationError(result.code, result.message);
  }
  return result;
}

function persistedReport(
  report: LegacyMigrationReport,
  targetWorkspacePath: string,
): Omit<LegacyMigrationReport, "sourceBackupPath" | "reportPath" | "targetPreImportBackupPath"> & {
  readonly sourceBackupRelativePath: string;
  readonly targetPreImportBackupRelativePath: string | null;
} {
  return {
    schemaVersion: report.schemaVersion,
    importId: report.importId,
    planHash: report.planHash,
    status: report.status,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    sourceKind: report.sourceKind,
    sourceContentHash: report.sourceContentHash,
    sourceUnchanged: report.sourceUnchanged,
    sourceBackupRelativePath: relative(targetWorkspacePath, report.sourceBackupPath)
      .split(sep)
      .join("/"),
    targetPreImportBackupRelativePath:
      report.targetPreImportBackupPath === null
        ? null
        : relative(targetWorkspacePath, report.targetPreImportBackupPath)
            .split(sep)
            .join("/"),
    credentialDisposition: report.credentialDisposition,
    projects: report.projects,
  };
}

export async function applyLegacyMigration(
  input: ApplyLegacyMigrationInput,
): Promise<LegacyMigrationReport> {
  const plan = input.plan;
  if (plan.schemaVersion !== 1) {
    throw new LegacyMigrationError(
      "MIGRATION_PLAN_UNSUPPORTED",
      "Migration plan schema is not supported",
    );
  }
  const refreshed = planLegacyMigration({
    source: plan.source,
    targetWorkspacePath: plan.targetWorkspacePath,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.spaceProbe === undefined ? {} : { spaceProbe: input.spaceProbe }),
  });
  if (refreshed.planHash !== plan.planHash) {
    throw new LegacyMigrationError(
      "MIGRATION_PLAN_STALE",
      "Legacy source or migration target changed after the dry-run",
    );
  }
  if (!refreshed.spaceCheck.ok) {
    throw new LegacyMigrationError(
      "TARGET_SPACE_INSUFFICIENT",
      "Migration target does not have enough available space",
    );
  }
  assertMigrationTargetWritable(plan.targetWorkspacePath);
  const scanned =
    plan.source.kind === "manifest"
      ? scanManifestSource(plan.source)
      : scanDesktopSource(plan.source);
  const startedAt = input.clock?.() ?? new Date().toISOString();
  const migrationRoot = join(
    plan.targetWorkspacePath,
    ".writing-agent",
    "legacy-imports",
    plan.importId,
  );
  const sourceBackupPath = join(migrationRoot, "source-backup");
  const reportPath = join(migrationRoot, "report.json");
  if (existsSync(reportPath)) {
    verifySourceBackup(scanned, plan, sourceBackupPath);
    return hydratePersistedMigrationReport(
      reportPath,
      plan.targetWorkspacePath,
      plan,
    );
  }
  await prepareSourceBackup(scanned, plan, sourceBackupPath);
  await input.checkpoint?.("source-backup.completed");
  const migrationState = await prepareMigrationState(plan, migrationRoot);
  await input.checkpoint?.("target-backup.completed");

  const storage = openWorkspaceStorage({ workspacePath: plan.targetWorkspacePath });
  const projectReports: LegacyMigrationProjectReport[] = [];
  try {
    for (const project of scanned.projects) {
      const actor = { kind: "legacy_import", id: plan.importId } as const;
      let revision = requireMutation(
        storage.createProject({
          operationId: `${plan.importId}:${project.targetProjectId}:create`,
          projectId: project.targetProjectId,
          name: project.name,
          mode: project.mode,
          actor,
        }),
      ).projectRevision;
      await input.checkpoint?.(`project:${project.targetProjectId}:created`);

      revision = requireMutation(
        storage.saveWritingBrief({
          operationId: `${plan.importId}:${project.targetProjectId}:brief`,
          projectId: project.targetProjectId,
          expectedProjectRevision: revision,
          baseVersionId: null,
          brief: {
            schemaVersion: 1,
            topic: project.topic,
            genre: "explanatory_analysis",
            audience: project.audience,
            lengthTarget: { targetCharacters: project.targetCharacters },
            materialIds: [],
            constraints: [],
            interactionMode: "autonomous",
            authorAuthorization: {
              voice: null,
              styleReference: project.styleReference,
              styleDecision: "unspecified",
              directionDecision: "tentative",
              firsthandMaterialIds: [],
            },
            platform: null,
            publicationGoal: "not_applicable",
            confirmationStatus: "tentative",
          },
          actor,
        }),
      ).projectRevision;

      if (project.styleReference !== null) {
        revision = requireMutation(
          storage.recordDecision({
            operationId: `${plan.importId}:${project.targetProjectId}:style`,
            projectId: project.targetProjectId,
            expectedProjectRevision: revision,
            decisionId: `${project.targetProjectId}:legacy-style`,
            type: "style",
            value: {
              legacyReference: project.styleReference,
              validationStatus: "legacy_unknown",
              requiresUserConfirmation: true,
            },
            scope: "legacy_import_reference",
            sourceEventId: null,
            actor,
          }),
        ).projectRevision;
      }

      const latestByArtifact = new Map<string, string>();
      let artifactVersionCount = 0;
      for (const [index, sourceArtifact] of project.artifacts.entries()) {
        const artifactKey = `${sourceArtifact.kind}:${sourceArtifact.logicalKey}`;
        const committed = requireMutation(
          storage.commitArtifactVersion({
            operationId: `${plan.importId}:${project.targetProjectId}:artifact:${index}:${sourceArtifact.contentHash}`,
            projectId: project.targetProjectId,
            expectedProjectRevision: revision,
            kind: sourceArtifact.kind,
            logicalKey: sourceArtifact.logicalKey,
            baseVersionId: latestByArtifact.get(artifactKey) ?? null,
            content: sourceArtifact.content,
            reason: `Read-only legacy import: ${sourceArtifact.sourceId}`,
            requestSnapshotId: null,
            actor,
          }),
        );
        revision = committed.projectRevision;
        if ("versionId" in (committed.result as object)) {
          const versionId = (committed.result as { versionId: string }).versionId;
          latestByArtifact.set(artifactKey, versionId);
        }
        artifactVersionCount += 1;
        await input.checkpoint?.(
          `project:${project.targetProjectId}:artifact:${index + 1}`,
        );
      }
      projectReports.push({
        sourceProjectId: project.sourceProjectId,
        targetProjectId: project.targetProjectId,
        finalProjectRevision: revision,
        artifactVersionCount,
        legacyFactStatus: project.legacyFactStatus,
        factGateStatus: "not_checked",
        styleStatus: project.styleReference === null ? "not_present" : "legacy_unknown",
      });
      await input.checkpoint?.(`project:${project.targetProjectId}:completed`);
    }
  } finally {
    storage.close();
  }

  const after =
    plan.source.kind === "manifest"
      ? scanManifestSource(plan.source)
      : scanDesktopSource(plan.source);
  if (after.sourceContentHash !== plan.sourceContentHash) {
    throw new LegacyMigrationError(
      "LEGACY_SOURCE_CHANGED_DURING_IMPORT",
      "Legacy source changed while it was being imported",
    );
  }
  const completedAt = input.clock?.() ?? new Date().toISOString();
  const report: LegacyMigrationReport = {
    schemaVersion: 1,
    importId: plan.importId,
    planHash: plan.planHash,
    status: "completed",
    startedAt,
    completedAt,
    sourceKind: plan.source.kind,
    sourceContentHash: plan.sourceContentHash,
    sourceUnchanged: true,
    sourceBackupPath,
    reportPath,
    targetPreImportBackupPath:
      migrationState.targetBackupRelativePath === null
        ? null
        : resolve(
            plan.targetWorkspacePath,
            ...migrationState.targetBackupRelativePath.split("/"),
          ),
    credentialDisposition: "excluded_requires_explicit_consent",
    projects: projectReports,
  };
  if (!existsSync(reportPath)) {
    atomicJson(reportPath, persistedReport(report, plan.targetWorkspacePath));
  }
  await input.checkpoint?.("report.completed");
  return report;
}

interface PersistedMigrationReport {
  readonly schemaVersion: 1;
  readonly importId: string;
  readonly planHash: string;
  readonly status: "completed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly sourceKind: LegacySourceSpec["kind"];
  readonly sourceContentHash: string;
  readonly sourceUnchanged: true;
  readonly sourceBackupRelativePath: string;
  readonly targetPreImportBackupRelativePath: string | null;
  readonly credentialDisposition: "excluded_requires_explicit_consent";
  readonly projects: readonly LegacyMigrationProjectReport[];
}

function parsePersistedMigrationReport(path: string): PersistedMigrationReport {
  const value = parseJsonFile(path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LegacyMigrationError(
      "MIGRATION_REPORT_INVALID",
      "Migration report must contain an object",
    );
  }
  const report = value as Partial<PersistedMigrationReport>;
  if (
    report.schemaVersion !== 1 ||
    report.status !== "completed" ||
    typeof report.importId !== "string" ||
    report.importId.length === 0 ||
    typeof report.planHash !== "string" ||
    typeof report.startedAt !== "string" ||
    typeof report.completedAt !== "string" ||
    (report.sourceKind !== "manifest" && report.sourceKind !== "desktop_v0_1") ||
    typeof report.sourceContentHash !== "string" ||
    report.sourceUnchanged !== true ||
    typeof report.sourceBackupRelativePath !== "string" ||
    !(
      typeof report.targetPreImportBackupRelativePath === "string" ||
      report.targetPreImportBackupRelativePath === null
    ) ||
    report.credentialDisposition !== "excluded_requires_explicit_consent" ||
    !Array.isArray(report.projects)
  ) {
    throw new LegacyMigrationError(
      "MIGRATION_REPORT_INVALID",
      "Migration report is incomplete or unsupported",
    );
  }
  for (const project of report.projects) {
    if (
      project === null ||
      typeof project !== "object" ||
      typeof project.targetProjectId !== "string" ||
      !Number.isInteger(project.finalProjectRevision)
    ) {
      throw new LegacyMigrationError(
        "MIGRATION_REPORT_INVALID",
        "Migration report contains an invalid project entry",
      );
    }
  }
  return report as PersistedMigrationReport;
}

function hydratePersistedMigrationReport(
  reportPath: string,
  targetWorkspacePath: string,
  plan: LegacyMigrationPlan,
): LegacyMigrationReport {
  const persisted = parsePersistedMigrationReport(reportPath);
  if (
    persisted.importId !== plan.importId ||
    persisted.planHash !== plan.planHash ||
    persisted.sourceKind !== plan.source.kind ||
    persisted.sourceContentHash !== plan.sourceContentHash
  ) {
    throw new LegacyMigrationError(
      "MIGRATION_REPORT_CONFLICT",
      "Existing completion report does not match this migration plan",
    );
  }
  const sourceBackupPath = resolve(
    targetWorkspacePath,
    ...persisted.sourceBackupRelativePath.split("/"),
  );
  const targetPreImportBackupPath =
    persisted.targetPreImportBackupRelativePath === null
      ? null
      : resolve(
          targetWorkspacePath,
          ...persisted.targetPreImportBackupRelativePath.split("/"),
        );
  if (
    !pathIsInside(targetWorkspacePath, sourceBackupPath) ||
    !existsSync(sourceBackupPath) ||
    (targetPreImportBackupPath !== null &&
      (!pathIsInside(targetWorkspacePath, targetPreImportBackupPath) ||
        !existsSync(targetPreImportBackupPath)))
  ) {
    throw new LegacyMigrationError(
      "MIGRATION_BACKUP_MISSING",
      "Completed migration report references a missing backup",
    );
  }
  return {
    schemaVersion: 1,
    importId: persisted.importId,
    planHash: persisted.planHash,
    status: "completed",
    startedAt: persisted.startedAt,
    completedAt: persisted.completedAt,
    sourceKind: persisted.sourceKind,
    sourceContentHash: persisted.sourceContentHash,
    sourceUnchanged: true,
    sourceBackupPath,
    reportPath: resolve(reportPath),
    targetPreImportBackupPath,
    credentialDisposition: "excluded_requires_explicit_consent",
    projects: persisted.projects,
  };
}

export function rollbackLegacyMigration(
  input: RollbackLegacyMigrationInput,
): LegacyMigrationRollbackReport {
  const workspacePath = resolve(input.workspacePath);
  const reportPath = resolve(input.reportPath);
  const allowedRoot = resolve(
    workspacePath,
    ".writing-agent",
    "legacy-imports",
  );
  if (!pathIsInside(allowedRoot, reportPath) || basename(reportPath) !== "report.json") {
    throw new LegacyMigrationError(
      "MIGRATION_REPORT_OUTSIDE_WORKSPACE",
      "Rollback report must be a migration report from this workspace",
    );
  }
  const reportFile = requireRegularFile(reportPath, "MIGRATION_REPORT_NOT_FOUND");
  if (!pathIsInside(allowedRoot, reportFile)) {
    throw new LegacyMigrationError(
      "MIGRATION_REPORT_OUTSIDE_WORKSPACE",
      "Rollback report resolves outside this workspace",
    );
  }
  const report = parsePersistedMigrationReport(reportFile);
  const project = report.projects.find(
    (candidate) => candidate.targetProjectId === input.confirmedProjectId,
  );
  if (project === undefined) {
    throw new LegacyMigrationError(
      "ROLLBACK_CONFIRMATION_MISMATCH",
      "Confirmed project ID is not an imported project in this report",
    );
  }
  const receiptPath = join(
    dirname(reportFile),
    `rollback-${sha256(project.targetProjectId).slice(0, 16)}.json`,
  );
  if (existsSync(receiptPath)) {
    const existing = parseJsonFile(receiptPath) as Partial<LegacyMigrationRollbackReport>;
    if (
      existing.importId === report.importId &&
      existing.deletedProjectId === project.targetProjectId &&
      existing.status === "deleted"
    ) {
      return {
        importId: report.importId,
        deletedProjectId: project.targetProjectId,
        status: "deleted",
        receiptPath,
      };
    }
    throw new LegacyMigrationError(
      "ROLLBACK_RECEIPT_CONFLICT",
      "Existing rollback receipt does not match this project",
    );
  }

  const storage = openWorkspaceStorage({ workspacePath });
  try {
    requireMutation(
      storage.deleteProject({
        operationId: `rollback:${report.importId}:${project.targetProjectId}`,
        projectId: project.targetProjectId,
        expectedProjectRevision: project.finalProjectRevision,
        confirmedProjectId: input.confirmedProjectId,
        actor: { kind: "user", id: "legacy-migration-rollback" },
      }),
    );
  } finally {
    storage.close();
  }
  const receipt: LegacyMigrationRollbackReport = {
    importId: report.importId,
    deletedProjectId: project.targetProjectId,
    status: "deleted",
    receiptPath,
  };
  atomicJson(receiptPath, {
    schemaVersion: 1,
    importId: receipt.importId,
    deletedProjectId: receipt.deletedProjectId,
    status: receipt.status,
  });
  return receipt;
}
