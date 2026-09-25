import { createHash } from "node:crypto";

import { z } from "zod";
import { Lexer, type Token } from "marked";

const NonEmptyIdSchema = z.string().trim().min(1);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: NonEmptyIdSchema }),
  z.object({
    kind: z.literal("agent"),
    id: NonEmptyIdSchema,
    runId: NonEmptyIdSchema,
  }),
  z.object({ kind: z.literal("runtime"), id: NonEmptyIdSchema }),
  z.object({ kind: z.literal("legacy_import"), id: NonEmptyIdSchema }),
]);

export const ProjectModeSchema = z.enum(["quick", "deep"]);
export const WritingGenreSchema = z.enum([
  "argument_commentary",
  "explanatory_analysis",
  "narrative_observation",
  "practical_experience",
]);
export const InteractionModeSchema = z.enum(["autonomous", "co_creation"]);
export const MaterialSourceKindSchema = z.enum([
  "pasted_text",
  "utf8_file",
  "web_snapshot",
  "legacy_import",
]);
export const MaterialRoleSchema = z.enum([
  "user_firsthand",
  "source_verified",
  "illustrative",
]);
export const MaterialTrustLabelSchema = z.enum([
  "user_provided_untrusted",
  "external_untrusted",
  "legacy_unknown",
]);
export const MaterialPermissionScopeSchema = z.literal("project_only");
export const AuthorizationDecisionSchema = z.enum([
  "user_confirmed",
  "user_delegated",
  "unspecified",
]);
export const DirectionDecisionSchema = z.enum([
  "user_confirmed",
  "user_delegated",
  "tentative",
]);
export const DecisionTypeSchema = z.enum([
  "brief",
  "direction",
  "style",
  "author_voice",
  "interaction",
  "budget",
  "title",
]);

const UniqueIdsSchema = z
  .array(NonEmptyIdSchema)
  .refine((values) => new Set(values).size === values.length, {
    message: "IDs must be unique",
  });

export const WritingBriefSchema = z
  .object({
    schemaVersion: z.literal(1),
    topic: z.string().trim().min(1),
    genre: WritingGenreSchema,
    audience: z.string().trim().min(1),
    lengthTarget: z
      .object({
        targetCharacters: z.number().int().positive().max(1_000_000),
      })
      .strict(),
    materialIds: UniqueIdsSchema,
    constraints: z.array(z.string().trim().min(1)),
    interactionMode: InteractionModeSchema,
    authorAuthorization: z
      .object({
        voice: z.string().trim().min(1).nullable(),
        styleReference: z.string().trim().min(1).nullable(),
        styleDecision: AuthorizationDecisionSchema,
        directionDecision: DirectionDecisionSchema,
        firsthandMaterialIds: UniqueIdsSchema,
      })
      .strict(),
    platform: z.string().trim().min(1).nullable(),
    publicationGoal: z.enum(["primary", "secondary", "not_applicable"]),
    confirmationStatus: z.enum(["tentative", "confirmed"]),
  })
  .strict()
  .superRefine((brief, context) => {
    const materialIds = new Set(brief.materialIds);
    for (const materialId of brief.authorAuthorization.firsthandMaterialIds) {
      if (!materialIds.has(materialId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["authorAuthorization", "firsthandMaterialIds"],
          message: "First-hand material must also be listed in materialIds",
        });
      }
    }
  });
export const ArtifactKindSchema = z.enum([
  "body",
  "outline",
  "title",
  "evidence",
  "review",
  "report",
]);
export const ProvenanceRelationSchema = z.enum([
  "DERIVED_FROM",
  "USES_MATERIAL",
  "CHANGED_BY_DECISION",
  "REVIEWED_IN",
  "CHECKED_IN",
  "EXPORTED_AS",
]);
export const FactGateStatusSchema = z.enum([
  "not_checked",
  "checking",
  "passed",
  "blocked",
  "error",
  "stale",
]);

export const FactClaimTypeSchema = z.enum([
  "number",
  "date",
  "person",
  "company",
  "policy",
  "report",
  "event",
  "link",
  "strong_assertion",
  "other",
]);
export const FactClaimStatusSchema = z.enum([
  "SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
  "BROKEN_LINK",
  "NEEDS_USER_SOURCE",
]);
export const FactRiskSchema = z.enum(["red", "yellow", "green"]);
export const FactSupportScopeSchema = z.enum(["full", "partial", "none"]);
export const FactClaimSchema = z.object({
  claimId: z.string().regex(/^C\d{3,}$/u),
  claimText: z.string().trim().min(1),
  claimType: FactClaimTypeSchema,
  location: z.string().trim().min(1),
  status: FactClaimStatusSchema,
  risk: FactRiskSchema,
  supportScope: FactSupportScopeSchema,
  matchedEvidenceId: z.string().trim().min(1).nullable().default(null),
  sourceReference: z.string().trim().min(1).nullable().default(null),
  evidenceSummary: z.string().trim().min(1),
  recommendedAction: z.string().trim().min(1),
});
export const FactCheckCoverageSchema = z.object({
  body: z.literal(true),
  title: z.literal(true),
  distributionCopy: z.literal(true),
});
export const FactCheckClaimsPayloadSchema = z.object({
  schemaVersion: z.literal("fact-check-v2"),
  snapshotId: NonEmptyIdSchema,
  bodyVersionId: NonEmptyIdSchema,
  titleVersionId: NonEmptyIdSchema,
  coverage: FactCheckCoverageSchema,
  claims: z.array(FactClaimSchema),
  noFactualClaimsReason: z.string(),
});

export const BODY_BLOCK_PARSER_VERSION = "markdown-blocks-v1" as const;
export const BodyBlockKindSchema = z.enum([
  "heading",
  "paragraph",
  "list",
  "blockquote",
  "code",
  "thematic_break",
]);

const ContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const RevisionEditSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace"),
    targetBlockId: NonEmptyIdSchema,
    baseBlockHash: ContentHashSchema,
    content: z.string().refine((value) => value.trim().length > 0, {
      message: "Replacement block must not be empty",
    }),
  }),
  z.object({
    type: z.literal("delete"),
    targetBlockId: NonEmptyIdSchema,
    baseBlockHash: ContentHashSchema,
  }),
  z.object({
    type: z.enum(["insert_before", "insert_after"]),
    targetBlockId: NonEmptyIdSchema,
    baseBlockHash: ContentHashSchema,
    content: z.string().refine((value) => value.trim().length > 0, {
      message: "Inserted block must not be empty",
    }),
  }),
]);

const RevisionEditsSchema = z
  .array(RevisionEditSchema)
  .min(1)
  .max(100)
  .superRefine((edits, context) => {
    const destructiveTargets = new Set<string>();
    for (const [index, edit] of edits.entries()) {
      if (edit.type === "insert_before" || edit.type === "insert_after") continue;
      if (destructiveTargets.has(edit.targetBlockId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "targetBlockId"],
          message: "A block can only be replaced or deleted once per proposal",
        });
      }
      destructiveTargets.add(edit.targetBlockId);
    }
  });

export const CreateProjectCommandSchema = z.object({
  operationId: NonEmptyIdSchema,
  projectId: NonEmptyIdSchema,
  name: z.string().trim().min(1),
  mode: ProjectModeSchema,
  actor: ActorSchema,
});

const MutationEnvelopeSchema = z.object({
  operationId: NonEmptyIdSchema,
  projectId: NonEmptyIdSchema,
  expectedProjectRevision: z.number().int().nonnegative(),
  actor: ActorSchema,
});

export const ImportMaterialCommandSchema = MutationEnvelopeSchema.extend({
  materialId: NonEmptyIdSchema,
  displayName: z.string().trim().min(1),
  sourceKind: MaterialSourceKindSchema,
  sourceReference: z.string().trim().min(1).nullable(),
  role: MaterialRoleSchema,
  trustLabel: MaterialTrustLabelSchema,
  permissionScope: MaterialPermissionScopeSchema,
  content: z.string().refine((value) => value.trim().length > 0, {
    message: "Material content must not be empty",
  }),
});

export const SaveWritingBriefCommandSchema = MutationEnvelopeSchema.extend({
  baseVersionId: NonEmptyIdSchema.nullable(),
  brief: WritingBriefSchema,
});

export const RecordDecisionCommandSchema = MutationEnvelopeSchema.extend({
  decisionId: NonEmptyIdSchema,
  type: DecisionTypeSchema,
  value: JsonValueSchema,
  scope: z.string().trim().min(1),
  sourceEventId: NonEmptyIdSchema.nullable(),
});

export const CommitArtifactVersionCommandSchema = MutationEnvelopeSchema.extend({
  kind: ArtifactKindSchema,
  logicalKey: NonEmptyIdSchema,
  baseVersionId: NonEmptyIdSchema.nullable(),
  content: z.string(),
  reason: z.string().trim().min(1),
  requestSnapshotId: NonEmptyIdSchema.nullable().optional().default(null),
});

export const CreateFactCheckSnapshotCommandSchema = MutationEnvelopeSchema.extend({
  bodyVersionId: NonEmptyIdSchema,
  titleVersionId: NonEmptyIdSchema,
  evidenceVersionId: NonEmptyIdSchema,
});

export const EvaluateFactCheckSnapshotCommandSchema = MutationEnvelopeSchema.extend({
  snapshotId: NonEmptyIdSchema,
  payload: FactCheckClaimsPayloadSchema,
});

export const RollbackArtifactVersionCommandSchema = MutationEnvelopeSchema.extend({
  kind: ArtifactKindSchema,
  logicalKey: NonEmptyIdSchema,
  baseVersionId: NonEmptyIdSchema,
  targetVersionId: NonEmptyIdSchema,
  reason: z.string().trim().min(1),
  requestSnapshotId: NonEmptyIdSchema.nullable().optional().default(null),
});

export const DeleteProjectCommandSchema = MutationEnvelopeSchema.extend({
  confirmedProjectId: NonEmptyIdSchema,
});

export const ProposeRevisionCommandSchema = MutationEnvelopeSchema.extend({
  proposalId: NonEmptyIdSchema,
  baseBodyVersionId: NonEmptyIdSchema,
  instruction: z.string().trim().min(1).max(20_000),
  constraints: z.array(z.string().trim().min(1).max(2_000)).max(100),
  edits: RevisionEditsSchema,
});

export const AcceptRevisionProposalCommandSchema = MutationEnvelopeSchema.extend({
  proposalId: NonEmptyIdSchema,
});

export const RejectRevisionProposalCommandSchema = MutationEnvelopeSchema.extend({
  proposalId: NonEmptyIdSchema,
  reason: z.string().trim().min(1).max(2_000),
});

export const SaveBodyCommandSchema = MutationEnvelopeSchema.extend({
  baseBodyVersionId: NonEmptyIdSchema,
  content: z.string(),
  reason: z.string().trim().min(1).max(2_000),
});

export const SetBodyBlockLockCommandSchema = MutationEnvelopeSchema.extend({
  baseBodyVersionId: NonEmptyIdSchema,
  blockId: NonEmptyIdSchema,
  blockHash: ContentHashSchema,
  action: z.enum(["lock", "unlock"]),
});

export const SaveWorkingCopyCommandSchema = MutationEnvelopeSchema.extend({
  bodyVersionId: NonEmptyIdSchema,
});

export const PublicationLayoutPresetSchema = z.enum([
  "clean",
  "editorial",
  "compact",
]);

export const ExportPublicationCommandSchema = MutationEnvelopeSchema.extend({
  bodyVersionId: NonEmptyIdSchema,
  factSnapshotId: NonEmptyIdSchema,
  format: z.enum(["txt", "html"]),
  layoutPreset: PublicationLayoutPresetSchema.optional(),
});

export type Actor = z.infer<typeof ActorSchema>;
export type ProjectMode = z.infer<typeof ProjectModeSchema>;
export type WritingGenre = z.infer<typeof WritingGenreSchema>;
export type WritingBrief = z.infer<typeof WritingBriefSchema>;
export type MaterialSourceKind = z.infer<typeof MaterialSourceKindSchema>;
export type MaterialRole = z.infer<typeof MaterialRoleSchema>;
export type MaterialTrustLabel = z.infer<typeof MaterialTrustLabelSchema>;
export type MaterialPermissionScope = z.infer<
  typeof MaterialPermissionScopeSchema
>;
export type DecisionType = z.infer<typeof DecisionTypeSchema>;
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type FactGateStatus = z.infer<typeof FactGateStatusSchema>;
export type ProvenanceRelation = z.infer<typeof ProvenanceRelationSchema>;
export type CreateProjectCommand = z.infer<typeof CreateProjectCommandSchema>;
export type CommitArtifactVersionCommand = z.input<
  typeof CommitArtifactVersionCommandSchema
>;
export type CreateFactCheckSnapshotCommand = z.infer<
  typeof CreateFactCheckSnapshotCommandSchema
>;
export type EvaluateFactCheckSnapshotCommand = z.infer<
  typeof EvaluateFactCheckSnapshotCommandSchema
>;
export type RollbackArtifactVersionCommand = z.input<
  typeof RollbackArtifactVersionCommandSchema
>;
export type DeleteProjectCommand = z.infer<typeof DeleteProjectCommandSchema>;
export type ImportMaterialCommand = z.infer<typeof ImportMaterialCommandSchema>;
export type SaveWritingBriefCommand = z.infer<
  typeof SaveWritingBriefCommandSchema
>;
export type RecordDecisionCommand = z.infer<typeof RecordDecisionCommandSchema>;
export type BodyBlockKind = z.infer<typeof BodyBlockKindSchema>;
export type RevisionEdit = z.infer<typeof RevisionEditSchema>;
export type ProposeRevisionCommand = z.infer<
  typeof ProposeRevisionCommandSchema
>;
export type AcceptRevisionProposalCommand = z.infer<
  typeof AcceptRevisionProposalCommandSchema
>;
export type RejectRevisionProposalCommand = z.infer<
  typeof RejectRevisionProposalCommandSchema
>;
export type SaveBodyCommand = z.infer<typeof SaveBodyCommandSchema>;
export type SetBodyBlockLockCommand = z.infer<
  typeof SetBodyBlockLockCommandSchema
>;
export type SaveWorkingCopyCommand = z.infer<
  typeof SaveWorkingCopyCommandSchema
>;
export type ExportPublicationCommand = z.infer<
  typeof ExportPublicationCommandSchema
>;
export type PublicationLayoutPreset = z.infer<
  typeof PublicationLayoutPresetSchema
>;

export interface ProjectInspection {
  id: string;
  name: string;
  mode: ProjectMode;
  schemaVersion: number;
  revision: number;
  latestBodyVersionId: string | null;
  currentTitleVersionId: string | null;
  currentEvidenceVersionId: string | null;
  currentBriefVersionId: string | null;
  factGateStatus: FactGateStatus;
  currentFactSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialRecord {
  readonly id: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly sourceKind: MaterialSourceKind;
  readonly sourceReference: string | null;
  readonly role: MaterialRole;
  readonly trustLabel: MaterialTrustLabel;
  readonly permissionScope: MaterialPermissionScope;
  readonly importedAt: string;
  readonly contentVersionId: string;
  readonly hash: string;
  readonly content: string;
}

export interface WritingBriefVersion {
  readonly id: string;
  readonly projectId: string;
  readonly brief: WritingBrief;
  readonly contentHash: string;
  readonly parentVersionId: string | null;
  readonly actor: Actor;
  readonly operationId: string;
  readonly createdEventSeq: number;
  readonly createdAt: string;
}

export interface DecisionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly type: DecisionType;
  readonly value: JsonValue;
  readonly scope: string;
  readonly actor: Actor;
  readonly sourceEventId: string | null;
  readonly createdAt: string;
}

export interface WritingBriefCommitResult {
  readonly status: "created" | "no_change";
  readonly versionId: string;
  readonly contentHash: string;
}

export interface DomainEvent {
  id: string;
  projectId: string;
  projectSeq: number;
  runId?: string;
  type: string;
  actor: Actor;
  operationId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface MutationError {
  code: string;
  message: string;
  retryable: boolean;
  operationId: string;
  details: Record<string, unknown>;
}

export type MutationResult<T> =
  | {
      ok: true;
      projectRevision: number;
      operationId: string;
      result: T;
    }
  | ({ ok: false } & MutationError);

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  projectId: string;
  kind: ArtifactKind;
  logicalKey: string;
  content: string;
  contentHash: string;
  actor: Actor;
  parentVersionIds: string[];
  reason: string;
  requestSnapshotId: string | null;
  createdEventSeq: number;
  operationId: string;
  createdAt: string;
}

export interface ProvenanceEdge {
  id: string;
  projectId: string;
  fromId: string;
  relation: ProvenanceRelation;
  toId: string;
  actor: Actor;
  eventSeq: number;
  evidenceRef: string | null;
  createdAt: string;
}

export interface PersistedFactCheckSnapshot extends FactCheckInputSnapshot {
  readonly projectId: string;
  readonly createdEventSeq: number;
  readonly createdAt: string;
}

export interface PersistedFactAssessment extends FactCheckEvaluation {
  readonly id: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly payload: FactCheckClaimsPayload;
  readonly actor: Actor;
  readonly operationId: string;
  readonly createdEventSeq: number;
  readonly createdAt: string;
}

export interface FactCheckInvalidation {
  readonly id: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly reason:
    | "body_version_changed"
    | "title_version_changed"
    | "evidence_version_changed";
  readonly changedVersionId: string;
  readonly actor: Actor;
  readonly operationId: string;
  readonly createdEventSeq: number;
  readonly createdAt: string;
}

export interface FactCheckStatusView {
  readonly status: FactGateStatus;
  readonly currentSnapshotId: string | null;
  readonly snapshot: PersistedFactCheckSnapshot | null;
  readonly assessment: PersistedFactAssessment | null;
  readonly invalidations: readonly FactCheckInvalidation[];
}

export interface ArtifactVersionCommitResult {
  status: "created" | "no_change" | "rolled_back";
  artifactId: string;
  versionId: string;
  contentHash: string;
}

export interface BodyBlock {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: BodyBlockKind;
  readonly content: string;
  readonly contentHash: string;
}

export interface BodyDocument {
  readonly versionId: string;
  readonly parserVersion: typeof BODY_BLOCK_PARSER_VERSION;
  readonly content: string;
  readonly contentHash: string;
  readonly blocks: readonly BodyBlock[];
}

export interface RevisionDiffEntry {
  readonly type: RevisionEdit["type"];
  readonly targetBlockId: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface RevisionProposal {
  readonly id: string;
  readonly projectId: string;
  readonly baseBodyVersionId: string;
  readonly baseProjectRevision: number;
  readonly instruction: string;
  readonly constraints: readonly string[];
  readonly edits: readonly RevisionEdit[];
  readonly diff: readonly RevisionDiffEntry[];
  readonly requestedBy: Actor;
  readonly status: "proposed" | "accepted" | "rejected" | "conflicted" | "withdrawn";
  readonly acceptedVersionId: string | null;
  readonly conflictCode: "REVISION_CONFLICT" | "LOCK_CONFLICT" | null;
  readonly createdEventSeq: number;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface BodyBlockLock {
  readonly decisionId: string;
  readonly projectId: string;
  readonly bodyVersionId: string;
  readonly blockId: string;
  readonly blockHash: string;
  readonly actor: Actor;
  readonly createdEventSeq: number;
  readonly createdAt: string;
}

export interface RevisionProposalResult {
  readonly proposalId: string;
  readonly status: "proposed";
  readonly diff: readonly RevisionDiffEntry[];
}

export interface ExportRecord {
  readonly id: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly expectedProjectRevision: number;
  readonly mode: ExportMode;
  readonly format: ExportFormat;
  readonly state: "prepared" | "completed";
  readonly bodyVersionId: string;
  readonly bodyHash: string;
  readonly titleVersionId: string | null;
  readonly titleHash: string | null;
  readonly distributionCopyHash: string | null;
  readonly evidenceVersionId: string | null;
  readonly evidenceHash: string | null;
  readonly factSnapshotId: string | null;
  readonly assessmentId: string | null;
  readonly policyVersion: string | null;
  readonly gateStatus: FactGateStatus;
  readonly relativePath: string;
  readonly manifestRelativePath: string | null;
  readonly contentHash: string;
  readonly manifestHash: string | null;
  readonly byteLength: number;
  readonly manifestByteLength: number | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface StoragePort {
  close(): void;
  createProject(
    command: CreateProjectCommand,
  ): MutationResult<{ projectId: string; revision: number }>;
  importMaterial(
    command: ImportMaterialCommand,
  ): MutationResult<{
    materialId: string;
    contentVersionId: string;
    hash: string;
  }>;
  saveWritingBrief(
    command: SaveWritingBriefCommand,
  ): MutationResult<WritingBriefCommitResult>;
  recordDecision(
    command: RecordDecisionCommand,
  ): MutationResult<{ decisionId: string }>;
  proposeRevision(
    command: ProposeRevisionCommand,
  ): MutationResult<RevisionProposalResult>;
  acceptRevisionProposal(
    command: AcceptRevisionProposalCommand,
  ): MutationResult<ArtifactVersionCommitResult & { proposalId: string }>;
  rejectRevisionProposal(
    command: RejectRevisionProposalCommand,
  ): MutationResult<{ proposalId: string; status: "rejected" }>;
  saveBody(
    command: SaveBodyCommand,
  ): MutationResult<ArtifactVersionCommitResult>;
  setBodyBlockLock(
    command: SetBodyBlockLockCommand,
  ): MutationResult<{ blockId: string; locked: boolean }>;
  commitArtifactVersion(
    command: CommitArtifactVersionCommand,
  ): MutationResult<ArtifactVersionCommitResult>;
  rollbackArtifactVersion(
    command: RollbackArtifactVersionCommand,
  ): MutationResult<ArtifactVersionCommitResult>;
  createFactCheckSnapshot(
    command: CreateFactCheckSnapshotCommand,
  ): MutationResult<{
    snapshotId: string;
    status: "checking";
  }>;
  evaluateFactCheckSnapshot(
    command: EvaluateFactCheckSnapshotCommand,
  ): MutationResult<{
    snapshotId: string;
    assessmentId: string;
    status: "passed" | "blocked";
    blockers: readonly string[];
  }>;
  saveWorkingCopy(
    command: SaveWorkingCopyCommand,
  ): MutationResult<ExportRecord>;
  exportPublication(
    command: ExportPublicationCommand,
  ): MutationResult<ExportRecord>;
  deleteProject(
    command: DeleteProjectCommand,
  ): MutationResult<{ projectId: string; deleted: true }>;
  inspectProject(projectId: string): ProjectInspection | null;
  getMaterial(projectId: string, materialId: string): MaterialRecord | null;
  listMaterials(projectId: string): MaterialRecord[];
  getWritingBriefVersion(versionId: string): WritingBriefVersion | null;
  listActiveDecisions(projectId: string): DecisionRecord[];
  getArtifactVersion(versionId: string): ArtifactVersion | null;
  getBodyDocument(versionId: string): BodyDocument | null;
  getRevisionProposal(proposalId: string): RevisionProposal | null;
  listRevisionProposals(projectId: string): RevisionProposal[];
  listBodyBlockLocks(projectId: string): BodyBlockLock[];
  listArtifactVersions(
    projectId: string,
    kind: ArtifactKind,
    logicalKey: string,
  ): ArtifactVersion[];
  getFactCheckSnapshot(snapshotId: string): PersistedFactCheckSnapshot | null;
  getFactCheckAssessment(snapshotId: string): PersistedFactAssessment | null;
  getFactCheckStatus(projectId: string): FactCheckStatusView;
  listExports(projectId: string): ExportRecord[];
  listProvenanceEdges(projectId: string): ProvenanceEdge[];
  listEvents(projectId: string, afterProjectSeq?: number): DomainEvent[];
}

function normalizeJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Only finite numbers can be canonicalized");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) {
        throw new TypeError("Undefined values cannot be canonicalized");
      }
      result[key] = normalizeJson(entry);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export const FACT_CHECK_SCHEMA_VERSION = "fact-check-v2" as const;
export const FACT_CHECK_POLICY_VERSION = "fact-check-v2-ts-v1" as const;

export interface FactCheckInputSnapshot {
  readonly schemaVersion: typeof FACT_CHECK_SCHEMA_VERSION;
  readonly policyVersion: typeof FACT_CHECK_POLICY_VERSION;
  readonly snapshotId: string;
  readonly bodyVersionId: string;
  readonly bodyHash: string;
  readonly titleVersionId: string;
  readonly titleHash: string;
  readonly distributionCopyHash: string | null;
  readonly evidenceVersionId: string;
  readonly evidenceHash: string;
}

export interface FactCheckInputContents {
  readonly bodyContent: string;
  readonly titleContent: string;
  readonly evidenceContent: string;
}

export interface CreateFactCheckInputSnapshotInput extends FactCheckInputContents {
  readonly snapshotId: string;
  readonly bodyVersionId: string;
  readonly titleVersionId: string;
  readonly evidenceVersionId: string;
}

export type FactClaim = z.infer<typeof FactClaimSchema>;
export type FactCheckCoverage = z.infer<typeof FactCheckCoverageSchema>;
export type FactCheckClaimsPayload = z.infer<
  typeof FactCheckClaimsPayloadSchema
>;

export interface FactCheckEvaluation {
  readonly status: "passed" | "blocked";
  readonly blockers: readonly string[];
  readonly claimsHash: string;
  readonly reportContent: string;
  readonly reportHash: string;
}

export type ExportMode = "working_copy" | "publication";
export type ExportFormat = "markdown" | "txt" | "html";

export interface PublicationGateInput {
  readonly project: ProjectInspection;
  readonly body: ArtifactVersion;
  readonly title: ArtifactVersion;
  readonly evidence: ArtifactVersion;
  readonly factCheck: FactCheckStatusView;
  readonly factSnapshotId: string;
}

export interface PublicationBinding {
  readonly title: string;
  readonly bodyVersionId: string;
  readonly bodyHash: string;
  readonly titleVersionId: string;
  readonly titleHash: string;
  readonly distributionCopyHash: string | null;
  readonly evidenceVersionId: string;
  readonly evidenceHash: string;
  readonly factSnapshotId: string;
  readonly assessmentId: string;
  readonly policyVersion: string;
}

export interface PreparedExportContent {
  readonly mode: ExportMode;
  readonly format: ExportFormat;
  readonly title: string;
  readonly bodyVersionId: string;
  readonly bodyHash: string;
  readonly titleVersionId: string | null;
  readonly titleHash: string | null;
  readonly distributionCopyHash: string | null;
  readonly evidenceVersionId: string | null;
  readonly evidenceHash: string | null;
  readonly factSnapshotId: string | null;
  readonly assessmentId: string | null;
  readonly policyVersion: string | null;
  readonly relativePath: string;
  readonly content: string;
  readonly contentHash: string;
  readonly manifestRelativePath: string | null;
  readonly manifestContent: string | null;
  readonly manifestHash: string | null;
  readonly gateStatus: FactGateStatus;
}

function lockedTitle(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  let selectionLocked = false;
  let finalTitleFound = false;
  for (const rawLine of lines) {
    const normalized = rawLine.trim().replaceAll("**", "");
    if (normalized.includes("选择状态")) {
      const parts = normalized.split(/[:：]/u, 2);
      selectionLocked = parts.length === 2 && parts[1]?.trim() === "已锁定";
    }
    if (normalized.includes("最终标题") && /[:：]/u.test(normalized)) {
      const value = normalized.slice(normalized.search(/[:：]/u) + 1).trim().replace(/^\*+|\*+$/gu, "").trim();
      finalTitleFound = value.length > 0 && !value.includes("待定") && !value.includes("[");
    }
  }
  return selectionLocked && finalTitleFound;
}

function stripWrappingTitleQuotes(value: string): string {
  let result = value.trim().replace(/^\*+|\*+$/gu, "").trim();
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ['"', '"'],
    ["'", "'"],
  ];
  for (const [open, close] of pairs) {
    if (result.startsWith(open) && result.endsWith(close)) {
      result = result.slice(open.length, -close.length).trim();
      break;
    }
  }
  return result;
}

export function finalLockedTitle(content: string): string | null {
  if (!lockedTitle(content)) return null;
  for (const rawLine of content.split(/\r?\n/u)) {
    const normalized = rawLine.trim().replaceAll("**", "");
    if (normalized.includes("最终标题") && /[:：]/u.test(normalized)) {
      const title = stripWrappingTitleQuotes(
        normalized.slice(normalized.search(/[:：]/u) + 1),
      );
      if (title.length > 0 && !title.includes("待定") && !title.includes("[")) {
        return title;
      }
    }
  }
  return null;
}

function lockedDistributionCopy(content: string): string | null {
  if (
    !["平台分发文案", "分发文案选择", "最终分发文案"].some((label) =>
      content.includes(label),
    )
  ) {
    return null;
  }
  let selectionValue = "";
  let finalValue = "";
  for (const rawLine of content.split(/\r?\n/u)) {
    const normalized = rawLine.trim().replaceAll("**", "");
    if (normalized.includes("分发文案选择") && /[:：]/u.test(normalized)) {
      selectionValue = normalized.slice(normalized.search(/[:：]/u) + 1).trim();
    }
    if (normalized.includes("最终分发文案") && /[:：]/u.test(normalized)) {
      finalValue = normalized.slice(normalized.search(/[:：]/u) + 1).trim();
    }
  }
  const pendingMarkers = ["待定", "暂定", "[", "]"];
  if (
    selectionValue.length === 0 ||
    finalValue.length === 0 ||
    pendingMarkers.some(
      (marker) => selectionValue.includes(marker) || finalValue.includes(marker),
    ) ||
    finalValue === "已确认" ||
    finalValue === "已锁定"
  ) {
    throw new Error("FACT_DISTRIBUTION_NOT_LOCKED");
  }
  return finalValue;
}

const EVIDENCE_REQUIRED_FIELDS = [
  "evidence_id",
  "claim_type",
  "claim_text",
  "source_title",
  "source_publisher",
  "source_quote",
  "accessed_at",
  "reliability",
  "use_boundary",
  "verification_status",
] as const;

function parseEvidenceLedger(content: string): { evidenceIds: ReadonlySet<string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("FACT_EVIDENCE_INVALID");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { claims?: unknown }).claims)
  ) {
    throw new Error("FACT_EVIDENCE_INVALID");
  }
  const ledger = parsed as Record<string, unknown> & { claims: readonly unknown[] };
  const claims = ledger.claims;
  const notes = ledger.notes;
  const researchRequirement = ledger.research_requirement;
  const researchAttempts = ledger.research_attempts;
  if (researchRequirement !== undefined) {
    if (
      (researchRequirement !== "required" && researchRequirement !== "not_required") ||
      !Array.isArray(researchAttempts) ||
      (researchRequirement === "required" && researchAttempts.length === 0)
    ) {
      throw new Error("FACT_EVIDENCE_INVALID");
    }
    for (const attempt of researchAttempts) {
      if (attempt === null || typeof attempt !== "object") {
        throw new Error("FACT_EVIDENCE_INVALID");
      }
      const record = attempt as Record<string, unknown>;
      for (const field of ["target_claim", "query", "outcome", "notes"] as const) {
        if (typeof record[field] !== "string" || record[field].trim().length === 0) {
          throw new Error("FACT_EVIDENCE_INVALID");
        }
      }
      const outcome = record.outcome;
      if (
        typeof outcome !== "string" ||
        !new Set(["found", "not_found", "blocked"]).has(outcome.trim().toLowerCase())
      ) {
        throw new Error("FACT_EVIDENCE_INVALID");
      }
    }
  } else if (researchAttempts !== undefined) {
    throw new Error("FACT_EVIDENCE_INVALID");
  }
  if (claims.length === 0 && (typeof notes !== "string" || notes.trim().length === 0)) {
    throw new Error("FACT_EVIDENCE_INVALID");
  }
  const evidenceIds = new Set<string>();
  for (const item of claims) {
    if (item === null || typeof item !== "object") {
      throw new Error("FACT_EVIDENCE_INVALID");
    }
    const record = item as Record<string, unknown>;
    for (const field of EVIDENCE_REQUIRED_FIELDS) {
      if (typeof record[field] !== "string" || record[field].trim().length === 0) {
        throw new Error("FACT_EVIDENCE_INVALID");
      }
    }
    const evidenceId = record.evidence_id as string;
    if (!/^E\d{3,}$/u.test(evidenceId) || evidenceIds.has(evidenceId)) {
      throw new Error("FACT_EVIDENCE_INVALID");
    }
    evidenceIds.add(evidenceId);
    if (!new Set(["high", "medium", "low"]).has((record.reliability as string).toLowerCase())) {
      throw new Error("FACT_EVIDENCE_INVALID");
    }
    const sourceUrl = record.source_url;
    if (sourceUrl !== undefined && sourceUrl !== null) {
      if (typeof sourceUrl !== "string") throw new Error("FACT_EVIDENCE_INVALID");
      try {
        const parsedUrl = new URL(sourceUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          throw new Error("FACT_EVIDENCE_INVALID");
        }
      } catch {
        throw new Error("FACT_EVIDENCE_INVALID");
      }
    }
  }
  return { evidenceIds };
}

export function createFactCheckInputSnapshot(
  input: CreateFactCheckInputSnapshotInput,
): FactCheckInputSnapshot {
  if (!lockedTitle(input.titleContent)) throw new Error("FACT_TITLE_NOT_LOCKED");
  parseEvidenceLedger(input.evidenceContent);
  const distributionCopy = lockedDistributionCopy(input.titleContent);
  return {
    schemaVersion: FACT_CHECK_SCHEMA_VERSION,
    policyVersion: FACT_CHECK_POLICY_VERSION,
    snapshotId: input.snapshotId,
    bodyVersionId: input.bodyVersionId,
    bodyHash: contentHash(input.bodyContent),
    titleVersionId: input.titleVersionId,
    titleHash: contentHash(input.titleContent),
    distributionCopyHash:
      distributionCopy === null ? null : contentHash(distributionCopy),
    evidenceVersionId: input.evidenceVersionId,
    evidenceHash: contentHash(input.evidenceContent),
  };
}

export function parseLegacyFactCheckClaimsPayload(
  input: string,
): FactCheckClaimsPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw new Error("FACT_CHECK_CLAIMS_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("FACT_CHECK_CLAIMS_INVALID");
  }
  const source = parsed as Record<string, unknown>;
  const coverage = source.coverage;
  if (coverage === null || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw new Error("FACT_CHECK_CLAIMS_INVALID");
  }
  if (!Array.isArray(source.claims)) throw new Error("FACT_CHECK_CLAIMS_INVALID");
  const claims = source.claims.map((claim): FactClaim => {
    if (claim === null || typeof claim !== "object" || Array.isArray(claim)) {
      throw new Error("FACT_CHECK_CLAIMS_INVALID");
    }
    const record = claim as Record<string, unknown>;
    return {
      claimId: record.claim_id as string,
      claimText: record.claim_text as string,
      claimType: record.claim_type as FactClaim["claimType"],
      location: record.location as string,
      status: record.status as FactClaim["status"],
      risk: record.risk as FactClaim["risk"],
      supportScope: record.support_scope as FactClaim["supportScope"],
      matchedEvidenceId: (record.matched_evidence_id ?? null) as string | null,
      sourceReference: (record.source_reference ?? null) as string | null,
      evidenceSummary: record.evidence_summary as string,
      recommendedAction: record.recommended_action as string,
    };
  });
  const coverageRecord = coverage as Record<string, unknown>;
  return FactCheckClaimsPayloadSchema.parse({
    schemaVersion: source.schema_version as typeof FACT_CHECK_SCHEMA_VERSION,
    snapshotId: source.snapshot_id as string,
    bodyVersionId: source.body_file as string,
    titleVersionId: source.title_file as string,
    coverage: {
      body: coverageRecord.body as boolean,
      title: coverageRecord.title as boolean,
      distributionCopy: coverageRecord.distribution_copy as boolean,
    },
    claims,
    noFactualClaimsReason: source.no_factual_claims_reason as string,
  });
}

export function evaluateFactCheck(
  snapshot: FactCheckInputSnapshot,
  contents: FactCheckInputContents,
  payload: FactCheckClaimsPayload,
): FactCheckEvaluation {
  if (
    contentHash(contents.bodyContent) !== snapshot.bodyHash ||
    contentHash(contents.titleContent) !== snapshot.titleHash ||
    contentHash(contents.evidenceContent) !== snapshot.evidenceHash
  ) {
    throw new Error("FACT_CHECK_STALE");
  }
  const distributionCopy = lockedDistributionCopy(contents.titleContent);
  if (
    (distributionCopy === null ? null : contentHash(distributionCopy)) !==
    snapshot.distributionCopyHash
  ) {
    throw new Error("FACT_CHECK_STALE");
  }
  if (
    payload.schemaVersion !== FACT_CHECK_SCHEMA_VERSION ||
    payload.snapshotId !== snapshot.snapshotId ||
    payload.bodyVersionId !== snapshot.bodyVersionId ||
    payload.titleVersionId !== snapshot.titleVersionId
  ) {
    throw new Error("FACT_CHECK_BINDING_INVALID");
  }
  if (
    payload.coverage.body !== true ||
    payload.coverage.title !== true ||
    payload.coverage.distributionCopy !== true
  ) {
    throw new Error("FACT_CHECK_COVERAGE_INCOMPLETE");
  }
  const parsedClaims = z.array(FactClaimSchema).safeParse(payload.claims);
  if (!parsedClaims.success) throw new Error("FACT_CHECK_CLAIMS_INVALID");
  const claimIds = new Set<string>();
  for (const claim of parsedClaims.data) {
    if (claimIds.has(claim.claimId)) throw new Error("FACT_CHECK_CLAIMS_INVALID");
    claimIds.add(claim.claimId);
  }
  if (
    parsedClaims.data.length === 0 &&
    (typeof payload.noFactualClaimsReason !== "string" ||
      payload.noFactualClaimsReason.trim().length === 0)
  ) {
    throw new Error("FACT_CHECK_EMPTY_REASON_REQUIRED");
  }
  const evidenceLedger = parseEvidenceLedger(contents.evidenceContent);
  for (const claim of parsedClaims.data) {
    if (
      claim.matchedEvidenceId !== null &&
      !evidenceLedger.evidenceIds.has(claim.matchedEvidenceId)
    ) {
      throw new Error("FACT_CHECK_EVIDENCE_REFERENCE_INVALID");
    }
    if (
      claim.status === "SUPPORTED" &&
      claim.matchedEvidenceId === null &&
      claim.sourceReference === null
    ) {
      throw new Error("FACT_CHECK_SOURCE_REQUIRED");
    }
  }
  const blockers = parsedClaims.data
    .filter(
      (claim) =>
        claim.status !== "SUPPORTED" ||
        claim.risk === "red" ||
        claim.supportScope !== "full",
    )
    .map((claim) => claim.claimId);
  const status = blockers.length === 0 ? "passed" : "blocked";
  const claimsHash = contentHash(canonicalJson(payload));
  const reportLines = [
    "# 事实核查报告",
    "",
    `- 核查状态：${status}`,
    `- 正文版本：${snapshot.bodyVersionId}`,
    `- 标题版本：${snapshot.titleVersionId}`,
    `- 输入快照：${snapshot.snapshotId}`,
    `- 阻断问题：${blockers.length}`,
    "",
    "结论由运行时根据事实清单计算；无法验证的事实不得放行。",
    "",
  ];
  for (const claim of parsedClaims.data) {
    reportLines.push(
      `## ${claim.claimId} · ${claim.status} · ${claim.supportScope}`,
      `- 原文：${claim.claimText}`,
      `- 位置：${claim.location}`,
      `- 依据：${claim.evidenceSummary}`,
      `- 建议：${claim.recommendedAction}`,
      "",
    );
  }
  const reportContent = reportLines.join("\n");
  return {
    status,
    blockers,
    claimsHash,
    reportContent,
    reportHash: contentHash(reportContent),
  };
}

const WINDOWS_RESERVED_FILE_STEMS = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu;

export function safeExportStem(input: string): string {
  let value = input
    .normalize("NFC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/_+/gu, "_")
    .trim()
    .replace(/^[._ ]+|[._ ]+$/gu, "")
    .slice(0, 80)
    .replace(/[. ]+$/gu, "");
  if (value.length === 0) value = "untitled";
  if (WINDOWS_RESERVED_FILE_STEMS.test(value)) value = `_${value}`;
  return value;
}

function requireArtifactIntegrity(
  artifact: ArtifactVersion,
  projectId: string,
  kind: "body" | "title" | "evidence",
): void {
  if (artifact.projectId !== projectId || artifact.kind !== kind) {
    throw new Error("EXPORT_ARTIFACT_SCOPE_INVALID");
  }
  if (contentHash(artifact.content) !== artifact.contentHash) {
    throw new Error("EXPORT_ARTIFACT_HASH_MISMATCH");
  }
}

export function validatePublicationGate(
  input: PublicationGateInput,
): PublicationBinding {
  const { project, body, title, evidence, factCheck, factSnapshotId } = input;
  requireArtifactIntegrity(body, project.id, "body");
  requireArtifactIntegrity(title, project.id, "title");
  requireArtifactIntegrity(evidence, project.id, "evidence");
  if (factCheck.status !== "passed" || project.factGateStatus !== "passed") {
    throw new Error("FACT_GATE_NOT_PASSED");
  }
  if (
    factCheck.currentSnapshotId !== factSnapshotId ||
    project.currentFactSnapshotId !== factSnapshotId
  ) {
    throw new Error("FACT_SNAPSHOT_NOT_CURRENT");
  }
  const snapshot = factCheck.snapshot;
  const assessment = factCheck.assessment;
  if (
    snapshot === null ||
    assessment === null ||
    snapshot.snapshotId !== factSnapshotId ||
    assessment.snapshotId !== factSnapshotId ||
    snapshot.projectId !== project.id ||
    assessment.projectId !== project.id ||
    factCheck.invalidations.length > 0
  ) {
    throw new Error("FACT_SNAPSHOT_NOT_CURRENT");
  }
  if (
    snapshot.policyVersion !== FACT_CHECK_POLICY_VERSION ||
    snapshot.schemaVersion !== FACT_CHECK_SCHEMA_VERSION
  ) {
    throw new Error("FACT_POLICY_MISMATCH");
  }
  if (
    project.latestBodyVersionId !== body.id ||
    project.currentTitleVersionId !== title.id ||
    project.currentEvidenceVersionId !== evidence.id ||
    snapshot.bodyVersionId !== body.id ||
    snapshot.titleVersionId !== title.id ||
    snapshot.evidenceVersionId !== evidence.id
  ) {
    throw new Error("FACT_INPUT_VERSION_MISMATCH");
  }
  const distributionCopy = lockedDistributionCopy(title.content);
  if (
    snapshot.bodyHash !== body.contentHash ||
    snapshot.titleHash !== title.contentHash ||
    snapshot.evidenceHash !== evidence.contentHash ||
    snapshot.distributionCopyHash !==
      (distributionCopy === null ? null : contentHash(distributionCopy))
  ) {
    throw new Error("FACT_INPUT_HASH_MISMATCH");
  }
  if (
    assessment.status !== "passed" ||
    assessment.blockers.length > 0 ||
    assessment.payload.snapshotId !== factSnapshotId ||
    assessment.payload.bodyVersionId !== body.id ||
    assessment.payload.titleVersionId !== title.id
  ) {
    throw new Error("FACT_ASSESSMENT_NOT_PASSED");
  }
  if (contentHash(canonicalJson(assessment.payload)) !== assessment.claimsHash) {
    throw new Error("FACT_CLAIMS_HASH_MISMATCH");
  }
  if (contentHash(assessment.reportContent) !== assessment.reportHash) {
    throw new Error("FACT_REPORT_HASH_MISMATCH");
  }
  const selectedTitle = finalLockedTitle(title.content);
  if (selectedTitle === null) throw new Error("FACT_TITLE_NOT_LOCKED");
  return {
    title: selectedTitle,
    bodyVersionId: body.id,
    bodyHash: body.contentHash,
    titleVersionId: title.id,
    titleHash: title.contentHash,
    distributionCopyHash: snapshot.distributionCopyHash,
    evidenceVersionId: evidence.id,
    evidenceHash: evidence.contentHash,
    factSnapshotId,
    assessmentId: assessment.id,
    policyVersion: snapshot.policyVersion,
  };
}

export function withoutFirstMarkdownHeading(content: string): string {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (
    firstContentIndex >= 0 &&
    /^#{1,6}\s+\S/u.test(lines[firstContentIndex]?.trimStart() ?? "")
  ) {
    lines.splice(firstContentIndex, 1);
  }
  return lines.join("\n").trim();
}

function markdownToPlainText(content: string): string {
  const lines = withoutFirstMarkdownHeading(content).split("\n");
  let insideFence = false;
  const output: string[] = [];
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    let value = line;
    if (!insideFence) {
      value = value
        .replace(/^\s*#{1,6}\s+/u, "")
        .replace(/^\s*>\s?/u, "")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replace(/[*_~`]/gu, "");
    }
    output.push(value.trimEnd());
  }
  return output.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("=", "&#61;");
}

function renderSafeInline(content: string): string {
  // Only emit these fixed formatting tags. Raw HTML, URLs and image attributes
  // never become active content in a publication file.
  const render = (tokens: readonly Token[]): string => tokens.map(token => {
    if (token.type === 'strong' || token.type === 'em' || token.type === 'del') {
      return `<${token.type}>${render(token.tokens ?? [])}</${token.type}>`;
    }
    if (token.type === 'codespan') return `<code>${escapeHtmlText(token.text)}</code>`;
    if (token.type === 'br') return '<br>';
    if (token.type === 'link') return render(token.tokens ?? []);
    return escapeHtmlText('text' in token ? String(token.text) : token.raw);
  }).join('');
  return render(Lexer.lexInline(content));
}

function renderSafeBodyHtml(bodyContent: string): string {
  const source = withoutFirstMarkdownHeading(bodyContent);
  if (source.length === 0) return "";
  return parseBodyDocument("publication-render", source).blocks
    .map((block) => {
      const escapedLines = block.content.split("\n").map(renderSafeInline);
      if (block.kind === "heading") {
        const match = /^(#{1,6})\s+(.*)$/u.exec(block.content.trimStart());
        const level = match?.[1]?.length ?? 2;
        return `<h${level}>${renderSafeInline(match?.[2] ?? block.content)}</h${level}>`;
      }
      if (block.kind === "list") {
        const items = block.content
          .split("\n")
          .map((line) => line.replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, ""))
          .map((line) => `<li>${renderSafeInline(line)}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      if (block.kind === "blockquote") {
        return `<blockquote>${block.content
          .split("\n")
          .map((line) => renderSafeInline(line.replace(/^\s*>\s?/u, "")))
          .join("<br>")}</blockquote>`;
      }
      if (block.kind === "code") {
        const code = block.content
          .split("\n")
          .filter((line, index, all) =>
            !((index === 0 || index === all.length - 1) && /^\s*(?:```|~~~)/u.test(line)),
          )
          .join("\n");
        return `<pre><code>${escapeHtmlText(code)}</code></pre>`;
      }
      if (block.kind === "thematic_break") return "<hr>";
      return `<p>${escapedLines.join("<br>")}</p>`;
    })
    .join("\n");
}

function renderPublicationText(title: string, bodyContent: string): string {
  const body = markdownToPlainText(bodyContent);
  return `${title}${body.length === 0 ? "" : `\n\n${body}`}\n`;
}

const PUBLICATION_LAYOUT_STYLES: Readonly<Record<PublicationLayoutPreset, string>> = {
  clean:
    'body{margin:0;background:#fff;color:#202124;font:16px/1.75 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}article{max-width:760px;margin:0 auto;padding:48px 24px 80px}h1{font-size:2rem;line-height:1.3}h2,h3,h4,h5,h6{margin-top:2em;line-height:1.4}p,blockquote,pre,ul{margin:1em 0}blockquote{border-left:3px solid #bbb;padding-left:1em;color:#555}pre{overflow:auto;background:#f6f7f8;padding:1em;border-radius:8px;white-space:pre-wrap}hr{border:0;border-top:1px solid #ddd;margin:2em 0}',
  editorial:
    'body{margin:0;background:#f4f0e8;color:#29251f;font:18px/1.9 Georgia,"Noto Serif SC","Songti SC",serif}article{max-width:720px;margin:0 auto;padding:72px 36px 96px;background:#fffdf8;box-shadow:0 0 0 1px rgba(75,61,42,.08)}h1{margin:0 0 1.5em;font-size:2.45rem;line-height:1.25;letter-spacing:.02em}h2,h3,h4,h5,h6{margin-top:2.2em;line-height:1.45;color:#5b3c24}p,blockquote,pre,ul{margin:1.2em 0}blockquote{margin-inline:0;border-left:4px solid #a56c38;padding:.25em 0 .25em 1.2em;color:#6c5a49}pre{overflow:auto;background:#f3eee4;padding:1.1em;border-radius:4px;white-space:pre-wrap}hr{width:72px;border:0;border-top:2px solid #b7946f;margin:2.6em auto}',
  compact:
    'body{margin:0;background:#fff;color:#1f2937;font:15px/1.62 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}article{max-width:880px;margin:0 auto;padding:32px 28px 56px}h1{margin:.2em 0 1em;font-size:1.75rem;line-height:1.25}h2,h3,h4,h5,h6{margin:1.45em 0 .55em;line-height:1.35}p,blockquote,pre,ul{margin:.7em 0}blockquote{border-left:3px solid #64748b;padding:.1em 0 .1em .9em;color:#475569}pre{overflow:auto;background:#f1f5f9;padding:.8em;border-radius:6px;white-space:pre-wrap}hr{border:0;border-top:1px solid #cbd5e1;margin:1.5em 0}',
};

function renderPublicationHtml(
  title: string,
  bodyContent: string,
  layoutPreset: PublicationLayoutPreset,
): string {
  const safeTitle = escapeHtmlText(title);
  const body = renderSafeBodyHtml(bodyContent);
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    `<style>${PUBLICATION_LAYOUT_STYLES[layoutPreset]}</style>`,
    "</head>",
    "<body>",
    "<article>",
    `<h1>${safeTitle}</h1>`,
    body,
    "</article>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export function prepareWorkingCopyContent(input: {
  readonly project: ProjectInspection;
  readonly body: ArtifactVersion;
  readonly factCheck: FactCheckStatusView;
  readonly operationId: string;
  readonly createdAt: string;
}): PreparedExportContent {
  requireArtifactIntegrity(input.body, input.project.id, "body");
  if (input.project.latestBodyVersionId !== input.body.id) {
    throw new Error("EXPORT_BODY_NOT_CURRENT");
  }
  const projectSegment = safeExportStem(input.project.id);
  const fileStem = safeExportStem(input.project.name);
  const operationSuffix = contentHash(input.operationId).slice(0, 10);
  const relativePath = `exports/${projectSegment}/working/${fileStem}-working-${input.body.contentHash.slice(0, 12)}-${operationSuffix}.md`;
  const manifestRelativePath = `${relativePath}.status.json`;
  const manifestContent = canonicalJson({
    bodyHash: input.body.contentHash,
    bodyVersionId: input.body.id,
    createdAt: input.createdAt,
    factSnapshotId: input.factCheck.snapshot?.snapshotId ?? null,
    mode: "working_copy",
    operationId: input.operationId,
    projectId: input.project.id,
    publicationStatus: input.factCheck.status,
    schemaVersion: "working-copy-v1",
    warning: "WORKING_COPY_NOT_PUBLICATION",
  });
  return {
    mode: "working_copy",
    format: "markdown",
    relativePath,
    content: input.body.content,
    contentHash: input.body.contentHash,
    manifestRelativePath,
    manifestContent,
    manifestHash: contentHash(manifestContent),
    gateStatus: input.factCheck.status,
    title: input.project.name,
    bodyVersionId: input.body.id,
    bodyHash: input.body.contentHash,
    titleVersionId: null,
    titleHash: null,
    distributionCopyHash: null,
    evidenceVersionId: null,
    evidenceHash: null,
    factSnapshotId: input.factCheck.snapshot?.snapshotId ?? null,
    assessmentId: input.factCheck.assessment?.id ?? null,
    policyVersion: input.factCheck.snapshot?.policyVersion ?? null,
  };
}

export function preparePublicationContent(
  input: PublicationGateInput & {
    readonly format: "txt" | "html";
    readonly layoutPreset?: PublicationLayoutPreset;
  },
): PreparedExportContent {
  const binding = validatePublicationGate(input);
  const layoutPreset = input.layoutPreset ?? "clean";
  const content =
    input.format === "txt"
      ? renderPublicationText(binding.title, input.body.content)
      : renderPublicationHtml(binding.title, input.body.content, layoutPreset);
  const layoutSuffix = input.format === "html" && layoutPreset !== "clean"
    ? `-${layoutPreset}`
    : "";
  const relativePath = `exports/${safeExportStem(input.project.id)}/publication/${safeExportStem(binding.title)}-${binding.bodyHash.slice(0, 12)}${layoutSuffix}.${input.format}`;
  return {
    ...binding,
    mode: "publication",
    format: input.format,
    relativePath,
    content,
    contentHash: contentHash(content),
    manifestRelativePath: null,
    manifestContent: null,
    manifestHash: null,
    gateStatus: "passed",
  };
}

function blockKind(content: string): BodyBlockKind {
  const firstLine = content.split("\n", 1)[0]?.trimStart() ?? "";
  if (/^#{1,6}\s+\S/u.test(firstLine)) return "heading";
  if (/^(?:[-+*]|\d+[.)])\s+\S/u.test(firstLine)) return "list";
  if (/^>\s?/u.test(firstLine)) return "blockquote";
  if (/^(?:```|~~~)/u.test(firstLine)) return "code";
  if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(firstLine.replace(/\s+/gu, ""))) {
    return "thematic_break";
  }
  return "paragraph";
}

function markdownBlockContents(content: string): string[] {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: "```" | "~~~" | null = null;

  const flush = (): void => {
    while (current.at(-1)?.trim().length === 0) current.pop();
    while (current[0]?.trim().length === 0) current.shift();
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (fence !== null) {
      current.push(line);
      if (trimmed.startsWith(fence)) {
        fence = null;
        flush();
      }
      continue;
    }
    const fenceMatch = /^(?<fence>```|~~~)/u.exec(trimmed);
    if (fenceMatch?.groups?.fence === "```" || fenceMatch?.groups?.fence === "~~~") {
      flush();
      fence = fenceMatch.groups.fence;
      current.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const kind = blockKind(line);
    const currentKind = current.length === 0 ? null : blockKind(current[0] ?? "");
    const standalone = kind === "heading" || kind === "thematic_break";
    const startsStructured = kind === "list" || kind === "blockquote";
    if (
      current.length > 0 &&
      (standalone ||
        (startsStructured && currentKind !== kind) ||
        (currentKind === "heading" || currentKind === "thematic_break"))
    ) {
      flush();
    }
    current.push(line);
    if (standalone) flush();
  }
  flush();
  return blocks;
}

function bodyBlockId(
  versionId: string,
  ordinal: number,
  kind: BodyBlockKind,
  content: string,
): string {
  return `blk_${contentHash(`${versionId}\n${ordinal}\n${kind}\n${content}`).slice(0, 24)}`;
}

function parseBlock(versionId: string, ordinal: number, content: string): BodyBlock {
  const kind = blockKind(content);
  return {
    id: bodyBlockId(versionId, ordinal, kind, content),
    ordinal,
    kind,
    content,
    contentHash: contentHash(content),
  };
}

export function parseBodyDocument(versionId: string, content: string): BodyDocument {
  const blocks = markdownBlockContents(content).map((block, ordinal) =>
    parseBlock(versionId, ordinal, block),
  );
  return {
    versionId,
    parserVersion: BODY_BLOCK_PARSER_VERSION,
    content,
    contentHash: contentHash(content),
    blocks,
  };
}

export function reconcileBodyDocument(
  versionId: string,
  content: string,
  previous: BodyDocument | null,
): BodyDocument {
  const parsed = parseBodyDocument(versionId, content);
  if (previous === null || previous.blocks.length === 0) return parsed;
  const previousByKey = new Map<string, BodyBlock[]>();
  const nextCounts = new Map<string, number>();
  const keyFor = (block: Pick<BodyBlock, "kind" | "contentHash" | "content">): string =>
    canonicalJson([block.kind, block.contentHash, block.content]);
  for (const block of previous.blocks) {
    const key = keyFor(block);
    previousByKey.set(key, [...(previousByKey.get(key) ?? []), block]);
  }
  for (const block of parsed.blocks) {
    const key = keyFor(block);
    nextCounts.set(key, (nextCounts.get(key) ?? 0) + 1);
  }
  const blocks = parsed.blocks.map((block, ordinal): BodyBlock => {
    const key = keyFor(block);
    const candidates = previousByKey.get(key) ?? [];
    const prior = candidates.length === 1 && nextCounts.get(key) === 1
      ? candidates[0]
      : undefined;
    return { ...block, id: prior?.id ?? block.id, ordinal };
  });
  return { ...parsed, blocks };
}

function singleRevisionBlock(
  versionId: string,
  content: string,
  field: string,
): BodyBlock {
  const parsed = parseBodyDocument(versionId, content);
  if (parsed.blocks.length !== 1) {
    throw new Error(`${field}_MUST_BE_ONE_BLOCK`);
  }
  const block = parsed.blocks[0];
  if (block === undefined) throw new Error(`${field}_MUST_BE_ONE_BLOCK`);
  return block;
}

export function revisionDiff(
  base: BodyDocument,
  edits: readonly RevisionEdit[],
): RevisionDiffEntry[] {
  const byId = new Map(base.blocks.map((block) => [block.id, block]));
  return edits.map((edit) => {
    const target = byId.get(edit.targetBlockId);
    if (target === undefined) throw new Error("BLOCK_NOT_FOUND");
    if (target.contentHash !== edit.baseBlockHash) {
      throw new Error("BLOCK_HASH_CONFLICT");
    }
    return {
      type: edit.type,
      targetBlockId: edit.targetBlockId,
      before:
        edit.type === "insert_before" || edit.type === "insert_after"
          ? null
          : target.content,
      after: edit.type === "delete" ? null : edit.content,
    };
  });
}

export function applyRevisionEdits(
  versionId: string,
  base: BodyDocument,
  editsInput: readonly RevisionEdit[],
  proposalSeed: string,
): BodyDocument {
  const edits = RevisionEditsSchema.parse(editsInput);
  revisionDiff(base, edits);
  const blocks = base.blocks.map((block) => ({ ...block }));
  for (const [editIndex, edit] of edits.entries()) {
    const targetIndex = blocks.findIndex((block) => block.id === edit.targetBlockId);
    if (targetIndex < 0) throw new Error("BLOCK_NOT_FOUND");
    const target = blocks[targetIndex];
    if (target === undefined || target.contentHash !== edit.baseBlockHash) {
      throw new Error("BLOCK_HASH_CONFLICT");
    }
    if (edit.type === "delete") {
      blocks.splice(targetIndex, 1);
      continue;
    }
    const parsed = singleRevisionBlock(
      `${proposalSeed}:${editIndex}`,
      edit.content,
      edit.type === "replace" ? "REPLACEMENT" : "INSERTION",
    );
    const nextBlock: BodyBlock = {
      ...parsed,
      id:
        edit.type === "replace"
          ? target.id
          : bodyBlockId(
              `${proposalSeed}:${editIndex}`,
              editIndex,
              parsed.kind,
              parsed.content,
            ),
    };
    if (edit.type === "replace") {
      blocks.splice(targetIndex, 1, nextBlock);
    } else {
      blocks.splice(edit.type === "insert_before" ? targetIndex : targetIndex + 1, 0, nextBlock);
    }
  }
  const normalizedBlocks = blocks.map((block, ordinal) => ({ ...block, ordinal }));
  const content = normalizedBlocks.map((block) => block.content).join("\n\n");
  return {
    versionId,
    parserVersion: BODY_BLOCK_PARSER_VERSION,
    content,
    contentHash: contentHash(content),
    blocks: normalizedBlocks,
  };
}
