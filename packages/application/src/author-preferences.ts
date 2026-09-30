import type {
  ArtifactVersion,
  MutationResult,
  ProjectInspection,
  StoragePort,
} from "../../writing-core/src/index.js";

const LOGICAL_KEY = "author-approved-preferences";
const REMEMBER_PREFIX = "记住我的写作偏好：";
const CLEAR_TEXT = "忘记我的写作偏好";
const MAX_RULES = 20;
const MAX_TOTAL_CHARS = 20_000;

interface CrossProjectPreferenceStorage extends StoragePort {
  /** Project metadata only; preference reads never inspect project bodies or materials. */
  listProjects(): readonly ProjectInspection[];
}

interface StoredPreferencePayload {
  readonly schemaVersion: 1;
  readonly status: "approved" | "cleared";
  readonly sourceProjectId: string;
  readonly sourceUserText: string;
  readonly authorizationArtifactId?: string;
  readonly rules: readonly string[];
  readonly ruleSources: readonly {
    readonly text: string;
    readonly sourceUserText: string;
    readonly authorizationArtifactId?: string;
  }[];
  readonly scope: "writing_preference_only";
  readonly instructionAuthority: "none";
  readonly mayAffectMaterialTrust: false;
  readonly mayExpandPermissions: false;
}

export interface ApprovedAuthorPreferenceRule {
  readonly text: string;
  readonly sourceProjectId: string;
  readonly sourceUserText: string;
  readonly artifactVersionId: string;
}

export interface ApprovedAuthorPreferences {
  readonly rules: readonly ApprovedAuthorPreferenceRule[];
  readonly totalChars: number;
  readonly scope: "writing_preference_only";
  readonly instructionAuthority: "none";
  readonly mayAffectMaterialTrust: false;
  readonly mayExpandPermissions: false;
}

export interface SetAuthorPreferenceResult {
  readonly status: "approved" | "cleared";
  readonly artifactVersionId: string;
  readonly rules: readonly string[];
  readonly sourceProjectId: string;
  readonly sourceUserText: string;
  readonly instructionAuthority: "none";
}

export class AuthorPreferenceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AuthorPreferenceError";
  }
}

function value<T>(result: MutationResult<T>): T {
  if (result.ok) return result.result;
  throw new AuthorPreferenceError(result.code, result.message);
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorPreferenceError("AUTHOR_PREFERENCE_INPUT_INVALID", `${field} must not be empty`);
  }
  return value;
}

function parseUserOperation(userText: string):
  | { readonly status: "approved"; readonly rule: string }
  | { readonly status: "cleared" } {
  if (typeof userText !== "string") {
    throw new AuthorPreferenceError(
      "AUTHOR_PREFERENCE_USER_TEXT_REQUIRED",
      "Only the user's exact text can approve a reusable writing preference",
    );
  }
  if (userText === CLEAR_TEXT) return { status: "cleared" };
  if (!userText.startsWith(REMEMBER_PREFIX)) {
    throw new AuthorPreferenceError(
      "AUTHOR_PREFERENCE_EXPLICIT_APPROVAL_REQUIRED",
      `Use the exact form “${REMEMBER_PREFIX}<完整偏好>” or “${CLEAR_TEXT}”`,
    );
  }
  const rule = userText.slice(REMEMBER_PREFIX.length);
  if (rule.trim().length === 0) {
    throw new AuthorPreferenceError(
      "AUTHOR_PREFERENCE_EMPTY",
      "The approved writing preference must not be empty",
    );
  }
  if (rule.length > MAX_TOTAL_CHARS) {
    throw new AuthorPreferenceError(
      "AUTHOR_PREFERENCE_TOO_LONG",
      "The approved writing preference exceeds the 20000 character limit",
    );
  }
  return { status: "approved", rule };
}

function authorizedOperation(storage: StoragePort, projectId: string, userText: string, receiptId?: string): ReturnType<typeof parseUserOperation> {
  if (!receiptId) return parseUserOperation(userText); // Compatibility for explicit typed legacy commands.
  const receipt = storage.getArtifactVersion(receiptId);
  const data = receipt && JSON.parse(receipt.content);
  if (!receipt || receipt.projectId !== projectId || receipt.reason !== 'contextual-author-intent' ||
    data.userMessage !== userText || data.sourceQuote.trim() !== userText.trim() ||
    !['remember_preference', 'forget_preferences'].includes(data.intent)) {
    throw new AuthorPreferenceError('AUTHOR_PREFERENCE_EXPLICIT_APPROVAL_REQUIRED', 'A current, source-bound preference decision is required');
  }
  if (data.intent === 'forget_preferences') return { status: 'cleared' };
  // Store the author's own wording, not a rule invented by a model. It remains reference data only.
  required(userText, 'userText');
  if (userText.length > MAX_TOTAL_CHARS) throw new AuthorPreferenceError('AUTHOR_PREFERENCE_TOO_LONG', 'Preference exceeds limit');
  return { status: 'approved', rule: userText };
}

function parseStored(storage: StoragePort, version: ArtifactVersion): StoredPreferencePayload | null {
  if (version.kind !== "report" || version.logicalKey !== LOGICAL_KEY) return null;
  if (version.actor.kind !== "user") return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(version.content);
  } catch {
    return null;
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const payload = candidate as Partial<StoredPreferencePayload>;
  if (
    payload.schemaVersion !== 1 ||
    (payload.status !== "approved" && payload.status !== "cleared") ||
    payload.sourceProjectId !== version.projectId ||
    typeof payload.sourceUserText !== "string" ||
    !Array.isArray(payload.rules) ||
    !Array.isArray(payload.ruleSources) ||
    payload.rules.some((rule) => typeof rule !== "string" || rule.trim().length === 0) ||
    payload.ruleSources.some((source) => {
      if (source === null || typeof source !== "object" || Array.isArray(source)) return true;
      const entry = source as { readonly text?: unknown; readonly sourceUserText?: unknown; readonly authorizationArtifactId?: string };
      if (typeof entry.text !== "string" || typeof entry.sourceUserText !== "string") return true;
      try {
        const parsed = authorizedOperation(storage, version.projectId, entry.sourceUserText, entry.authorizationArtifactId);
        return parsed.status !== "approved" || parsed.rule !== entry.text;
      } catch {
        return true;
      }
    }) ||
    payload.ruleSources.length !== payload.rules.length ||
    payload.ruleSources.some((source, index) => source.text !== payload.rules?.[index]) ||
    payload.rules.length > MAX_RULES ||
    payload.rules.reduce((sum, rule) => sum + rule.length, 0) > MAX_TOTAL_CHARS ||
    payload.scope !== "writing_preference_only" ||
    payload.instructionAuthority !== "none" ||
    payload.mayAffectMaterialTrust !== false ||
    payload.mayExpandPermissions !== false
  ) return null;
  const operation = (() => {
    try {
      return authorizedOperation(storage, version.projectId, payload.sourceUserText, payload.authorizationArtifactId);
    } catch {
      return null;
    }
  })();
  if (operation === null || operation.status !== payload.status) return null;
  if (
    payload.status === "cleared" &&
    (payload.rules.length !== 0 || payload.ruleSources.length !== 0)
  ) return null;
  if (
    payload.status === "approved" &&
    (operation.status !== "approved" || !payload.rules.includes(operation.rule))
  ) return null;
  return payload as StoredPreferencePayload;
}

function resultFrom(version: ArtifactVersion, payload: StoredPreferencePayload): SetAuthorPreferenceResult {
  return {
    status: payload.status,
    artifactVersionId: version.id,
    rules: [...payload.rules],
    sourceProjectId: payload.sourceProjectId,
    sourceUserText: payload.sourceUserText,
    instructionAuthority: "none",
  };
}

export function getApprovedAuthorPreferences(
  storage: CrossProjectPreferenceStorage,
): ApprovedAuthorPreferences {
  const rules: ApprovedAuthorPreferenceRule[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const project of storage.listProjects()) {
    const latest = storage.listArtifactVersions(project.id, "report", LOGICAL_KEY).at(-1);
    if (latest === undefined) continue;
    const payload = parseStored(storage, latest);
    if (payload === null || payload.status === "cleared") continue;
    for (let index = payload.ruleSources.length - 1; index >= 0; index -= 1) {
      const source = payload.ruleSources[index];
      if (source === undefined || seen.has(source.text)) continue;
      const text = source.text;
      if (rules.length >= MAX_RULES || totalChars + text.length > MAX_TOTAL_CHARS) continue;
      seen.add(text);
      totalChars += text.length;
      rules.push({
        text,
        sourceProjectId: payload.sourceProjectId,
        sourceUserText: source.sourceUserText,
        artifactVersionId: latest.id,
      });
    }
  }
  return {
    rules,
    totalChars,
    scope: "writing_preference_only",
    instructionAuthority: "none",
    mayAffectMaterialTrust: false,
    mayExpandPermissions: false,
  };
}

export function setAuthorPreferenceFromUserText(
  storage: StoragePort,
  projectId: string,
  operationId: string,
  userText: string,
  authorizationArtifactId?: string,
): SetAuthorPreferenceResult {
  required(projectId, "projectId");
  required(operationId, "operationId");
  const operation = authorizedOperation(storage, projectId, userText, authorizationArtifactId);
  const project = storage.inspectProject(projectId);
  if (project === null) {
    throw new AuthorPreferenceError("PROJECT_NOT_FOUND", "Project does not exist");
  }
  const history = storage.listArtifactVersions(projectId, "report", LOGICAL_KEY);
  const replay = history.find((version) => version.operationId === operationId);
  if (replay !== undefined) {
    const payload = parseStored(storage, replay);
    if (payload === null || payload.sourceUserText !== userText) {
      throw new AuthorPreferenceError(
        "IDEMPOTENCY_KEY_REUSED",
        "operationId was already used for different preference input",
      );
    }
    return resultFrom(replay, payload);
  }

  const latest = history.at(-1);
  const latestPayload = latest === undefined ? null : parseStored(storage, latest);
  let rules: readonly string[] = [];
  let ruleSources: StoredPreferencePayload["ruleSources"] = [];
  if (operation.status === "approved") {
    const existing = latestPayload?.status === "approved" ? latestPayload.rules : [];
    rules = [...new Set([...existing, operation.rule])];
    const existingSources = latestPayload?.status === "approved" ? latestPayload.ruleSources : [];
    ruleSources = rules.map((rule) =>
      existingSources.find((source) => source.text === rule) ?? {
        text: rule,
        sourceUserText: userText,
        ...(authorizationArtifactId ? { authorizationArtifactId } : {}),
      },
    );
    const totalChars = rules.reduce((sum, rule) => sum + rule.length, 0);
    if (rules.length > MAX_RULES || totalChars > MAX_TOTAL_CHARS) {
      throw new AuthorPreferenceError(
        "AUTHOR_PREFERENCE_LIMIT_EXCEEDED",
        "Approved preferences are limited to 20 rules and 20000 total characters per project",
      );
    }
  }
  const payload: StoredPreferencePayload = {
    schemaVersion: 1,
    status: operation.status,
    sourceProjectId: projectId,
    sourceUserText: userText,
    ...(authorizationArtifactId ? { authorizationArtifactId } : {}),
    rules,
    ruleSources,
    scope: "writing_preference_only",
    instructionAuthority: "none",
    mayAffectMaterialTrust: false,
    mayExpandPermissions: false,
  };
  const committed = value(storage.commitArtifactVersion({
    operationId,
    projectId,
    expectedProjectRevision: project.revision,
    kind: "report",
    logicalKey: LOGICAL_KEY,
    baseVersionId: latest?.id ?? null,
    content: JSON.stringify(payload),
    reason: operation.status === "approved"
      ? "User explicitly approved reusable writing preferences"
      : "User explicitly soft-cleared reusable writing preferences",
    actor: { kind: "user", id: "author-preference-user" },
  }));
  const version = storage.getArtifactVersion(committed.versionId);
  if (version === null) {
    throw new AuthorPreferenceError(
      "AUTHOR_PREFERENCE_READBACK_FAILED",
      "The preference record could not be read back",
    );
  }
  return resultFrom(version, payload);
}
