import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { strToU8, zipSync, type Zippable } from "fflate";

export type DiagnosticSection =
  | "application"
  | "provider"
  | "runtime"
  | "security";

export type DiagnosticBundleErrorCode =
  | "DIAGNOSTIC_CONFIRMATION_MISMATCH"
  | "DIAGNOSTIC_FILE_NAME_INVALID"
  | "DIAGNOSTIC_PREPARATION_INVALID"
  | "DIAGNOSTIC_SECTION_UNAVAILABLE"
  | "DIAGNOSTIC_SELECTION_INVALID"
  | "DIAGNOSTIC_SELECTION_REQUIRED"
  | "DIAGNOSTIC_TARGET_EXISTS"
  | "DIAGNOSTIC_WRITE_FAILED";

export class DiagnosticBundleError extends Error {
  constructor(
    public readonly code: DiagnosticBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DiagnosticBundleError";
  }
}

export interface DiagnosticApplicationInput {
  readonly version: unknown;
  readonly build: unknown;
  readonly platform: unknown;
  readonly arch: unknown;
}

export interface DiagnosticProviderInput {
  readonly id: unknown;
  readonly protocol: unknown;
  readonly model: unknown;
  readonly capabilities?: {
    readonly streaming?: unknown;
    readonly tools?: unknown;
    readonly usage?: unknown;
  };
  readonly connection?: {
    readonly status?: unknown;
    readonly errorCode?: unknown;
  };
}

export interface DiagnosticRuntimeInput {
  readonly status?: unknown;
  readonly stopReason?: unknown;
  readonly counts?: {
    readonly modelCalls?: unknown;
    readonly retries?: unknown;
    readonly toolCalls?: unknown;
    readonly majorRevisions?: unknown;
  };
  readonly budget?: {
    readonly maxModelSteps?: unknown;
    readonly maxRetries?: unknown;
    readonly maxToolCalls?: unknown;
    readonly maxMajorRevisions?: unknown;
  };
  readonly usage?: {
    readonly inputTokens?: unknown;
    readonly outputTokens?: unknown;
    readonly cost?: {
      readonly status?: unknown;
      readonly amount?: unknown;
      readonly currency?: unknown;
      readonly priceVersion?: unknown;
      readonly verifiedAt?: unknown;
    };
  };
}

export interface DiagnosticSecurityInput {
  readonly credentialPersistence?: unknown;
  readonly systemCredentialStoreAvailable?: unknown;
  readonly networkPolicy?: unknown;
  readonly externalContentTrust?: unknown;
  readonly htmlActiveContent?: unknown;
  readonly rendererDirectProviderAccess?: unknown;
  readonly upstreamTelemetryEnabled?: unknown;
}

export interface DiagnosticSnapshotInput {
  readonly application?: DiagnosticApplicationInput;
  readonly provider?: DiagnosticProviderInput;
  readonly runtime?: DiagnosticRuntimeInput;
  readonly security?: DiagnosticSecurityInput;
}

export interface DiagnosticPreviewManifest {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly includedFiles: readonly string[];
  readonly excludedDataClasses: readonly string[];
  readonly fileHashes: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly confirmationHash: string;
}

export interface PreparedDiagnosticBundle {
  readonly manifest: DiagnosticPreviewManifest;
}

export interface PrepareDiagnosticBundleOptions {
  readonly sections: readonly DiagnosticSection[];
  readonly createdAt?: string;
}

export interface WriteDiagnosticBundleOptions {
  readonly outputDirectory: string;
  readonly confirmationHash: string;
  readonly fileName?: string;
}

export interface DiagnosticBundleWriteResult {
  readonly outputPath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

const SECTION_ORDER: readonly DiagnosticSection[] = [
  "application",
  "provider",
  "runtime",
  "security",
];
const EXCLUDED_DATA_CLASSES = Object.freeze([
  "api_keys_and_credential_values",
  "article_and_material_content",
  "full_prompts_and_tool_results",
  "personal_paths",
  "raw_logs_and_exception_messages",
]);
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SECRET_OR_PATH =
  /(?:api[_-]?key|authorization|bearer\s|sk-[A-Za-z0-9]|[A-Za-z]:\\|\\\\|\/(?:Users|home|etc|private|tmp|var)\/|[?&](?:key|token|secret)=)/iu;
const preparedFiles = new WeakMap<object, Readonly<Record<string, Uint8Array>>>();

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function safeLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  if (
    !SAFE_LABEL.test(normalized) ||
    SECRET_OR_PATH.test(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return "redacted";
  }
  return normalized;
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_CODE.test(value)
    ? value
    : "UNKNOWN";
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

function nullableCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function requiredCount(value: unknown): number {
  return nullableCount(value) ?? 0;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value
    ? null
    : value;
}

function applicationSection(input: DiagnosticApplicationInput): unknown {
  return {
    version: safeLabel(input.version),
    build: safeLabel(input.build),
    platform: safeLabel(input.platform),
    arch: safeLabel(input.arch),
  };
}

function providerSection(input: DiagnosticProviderInput): unknown {
  const capabilities = input.capabilities ?? {};
  const connection = input.connection ?? {};
  return {
    id: safeLabel(input.id),
    protocol: safeLabel(input.protocol),
    model: safeLabel(input.model),
    capabilities: {
      streaming: capabilities.streaming === true,
      tools: enumValue(
        capabilities.tools,
        ["supported", "unsupported", "unknown"] as const,
        "unknown",
      ),
      usage: enumValue(
        capabilities.usage,
        ["reported", "not_reported", "unknown"] as const,
        "unknown",
      ),
    },
    connection: {
      status: enumValue(
        connection.status,
        ["ok", "failed", "not_tested"] as const,
        "not_tested",
      ),
      errorCode: safeErrorCode(connection.errorCode),
    },
  };
}

function runtimeSection(input: DiagnosticRuntimeInput): unknown {
  const counts = input.counts ?? {};
  const budget = input.budget ?? {};
  const usage = input.usage ?? {};
  const cost = usage.cost ?? {};
  const knownCost =
    cost.status === "known" &&
    typeof cost.amount === "number" &&
    Number.isFinite(cost.amount) &&
    cost.amount >= 0;
  return {
    status: safeLabel(input.status),
    stopReason:
      input.stopReason === null || input.stopReason === undefined
        ? null
        : safeLabel(input.stopReason),
    counts: {
      modelCalls: requiredCount(counts.modelCalls),
      retries: requiredCount(counts.retries),
      toolCalls: requiredCount(counts.toolCalls),
      majorRevisions: requiredCount(counts.majorRevisions),
    },
    budget: {
      maxModelSteps: requiredCount(budget.maxModelSteps),
      maxRetries: requiredCount(budget.maxRetries),
      maxToolCalls: requiredCount(budget.maxToolCalls),
      maxMajorRevisions: requiredCount(budget.maxMajorRevisions),
    },
    usage: {
      inputTokens: nullableCount(usage.inputTokens),
      outputTokens: nullableCount(usage.outputTokens),
      cost: knownCost
        ? {
            status: "known",
            amount: cost.amount as number,
            currency: safeLabel(cost.currency),
            priceVersion:
              cost.priceVersion === null ? null : safeLabel(cost.priceVersion),
            verifiedAt: isoDate(cost.verifiedAt),
          }
        : {
            status: "unknown",
            amount: null,
            currency: null,
            priceVersion: null,
            verifiedAt: null,
          },
    },
  };
}

function securitySection(input: DiagnosticSecurityInput): unknown {
  return {
    credentialPersistence: enumValue(
      input.credentialPersistence,
      ["system", "session", "environment", "missing"] as const,
      "missing",
    ),
    systemCredentialStoreAvailable:
      input.systemCredentialStoreAvailable === true,
    networkPolicy: enumValue(
      input.networkPolicy,
      ["enforced", "disabled"] as const,
      "disabled",
    ),
    externalContentTrust: enumValue(
      input.externalContentTrust,
      ["external_untrusted", "unclassified"] as const,
      "unclassified",
    ),
    htmlActiveContent: enumValue(
      input.htmlActiveContent,
      ["removed", "not_processed"] as const,
      "not_processed",
    ),
    rendererDirectProviderAccess:
      input.rendererDirectProviderAccess === true,
    upstreamTelemetryEnabled: input.upstreamTelemetryEnabled === true,
  };
}

function sectionBytes(
  section: DiagnosticSection,
  snapshot: DiagnosticSnapshotInput,
): Uint8Array {
  switch (section) {
    case "application":
      if (snapshot.application === undefined) break;
      return jsonBytes(applicationSection(snapshot.application));
    case "provider":
      if (snapshot.provider === undefined) break;
      return jsonBytes(providerSection(snapshot.provider));
    case "runtime":
      if (snapshot.runtime === undefined) break;
      return jsonBytes(runtimeSection(snapshot.runtime));
    case "security":
      if (snapshot.security === undefined) break;
      return jsonBytes(securitySection(snapshot.security));
  }
  throw new DiagnosticBundleError(
    "DIAGNOSTIC_SECTION_UNAVAILABLE",
    "A selected diagnostic section is unavailable",
  );
}

function normalizedCreatedAt(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (isoDate(value) === null) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_PREPARATION_INVALID",
      "Diagnostic creation time is invalid",
    );
  }
  return value;
}

export function prepareDiagnosticBundle(
  snapshot: DiagnosticSnapshotInput,
  options: PrepareDiagnosticBundleOptions,
): PreparedDiagnosticBundle {
  if (options.sections.length === 0) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_SELECTION_REQUIRED",
      "Select at least one diagnostic section",
    );
  }
  if (
    options.sections.some((section) => !SECTION_ORDER.includes(section)) ||
    new Set(options.sections).size !== options.sections.length
  ) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_SELECTION_INVALID",
      "Diagnostic section selection is invalid",
    );
  }
  const selected = SECTION_ORDER.filter((section) =>
    options.sections.includes(section),
  );
  const files: Record<string, Uint8Array> = {};
  for (const section of selected) {
    files[`${section}.json`] = sectionBytes(section, snapshot);
  }
  const includedFiles = Object.freeze(Object.keys(files));
  const fileHashes = Object.freeze(
    includedFiles.map((path) =>
      Object.freeze({ path, sha256: sha256(files[path]!) }),
    ),
  );
  const createdAt = normalizedCreatedAt(options.createdAt);
  const preview = {
    schemaVersion: 1 as const,
    createdAt,
    includedFiles,
    excludedDataClasses: EXCLUDED_DATA_CLASSES,
    fileHashes,
  };
  const manifest: DiagnosticPreviewManifest = Object.freeze({
    ...preview,
    confirmationHash: sha256(JSON.stringify(preview)),
  });
  const prepared = Object.freeze({ manifest });
  preparedFiles.set(prepared, Object.freeze({ ...files }));
  return prepared;
}

function defaultFileName(manifest: DiagnosticPreviewManifest): string {
  const timestamp = manifest.createdAt.replace(/[-:.]/gu, "").replace("Z", "Z");
  return `writing-agent-diagnostics-${timestamp}-${manifest.confirmationHash.slice(0, 8)}.zip`;
}

function validateFileName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.zip$/u.test(value)) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_FILE_NAME_INVALID",
      "Diagnostic archive file name is invalid",
    );
  }
  return value;
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

export function writeDiagnosticBundle(
  prepared: PreparedDiagnosticBundle,
  options: WriteDiagnosticBundleOptions,
): DiagnosticBundleWriteResult {
  const files = preparedFiles.get(prepared);
  if (files === undefined) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_PREPARATION_INVALID",
      "Diagnostic preview was not produced by this runtime",
    );
  }
  if (options.confirmationHash !== prepared.manifest.confirmationHash) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_CONFIRMATION_MISMATCH",
      "Diagnostic preview confirmation no longer matches",
    );
  }
  const fileName = validateFileName(
    options.fileName ?? defaultFileName(prepared.manifest),
  );
  const outputPath = join(options.outputDirectory, fileName);
  if (existsSync(outputPath)) {
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_TARGET_EXISTS",
      "Diagnostic archive target already exists",
    );
  }

  const archiveEntries: Zippable = {
    ...files,
    "manifest.json": jsonBytes(prepared.manifest),
  };
  const archive = zipSync(archiveEntries, { level: 6 });
  const temporaryPath = join(
    options.outputDirectory,
    `.writing-agent-diagnostics-${process.pid}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, archive);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, outputPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (isFileExistsError(error)) {
      throw new DiagnosticBundleError(
        "DIAGNOSTIC_TARGET_EXISTS",
        "Diagnostic archive target already exists",
      );
    }
    throw new DiagnosticBundleError(
      "DIAGNOSTIC_WRITE_FAILED",
      "Diagnostic archive could not be written",
    );
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return Object.freeze({
    outputPath,
    byteLength: archive.byteLength,
    sha256: sha256(archive),
  });
}
