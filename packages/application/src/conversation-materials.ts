import { createHash } from "node:crypto";

import type {
  MaterialRole,
  MutationResult,
  StoragePort,
} from "../../writing-core/src/index.js";
import { isExplicitFirsthandUserStatement } from "./conversation-intake.js";

export type ConversationMaterialRole = Extract<MaterialRole, "illustrative" | "user_firsthand">;

export interface AddConversationMaterialInput {
  readonly storage: StoragePort;
  readonly projectId: string;
  /** Exact user-authored operation text. It is stored unchanged as the material content. */
  readonly userOperationText: string;
  readonly materialName: string;
  readonly role: ConversationMaterialRole;
  readonly operationId: string;
  readonly expectedProjectRevision: number;
}

export interface ConversationMaterialAttachment {
  readonly materialId: string;
  readonly contentVersionId: string;
  readonly briefVersionId: string;
  readonly projectRevision: number;
  readonly role: ConversationMaterialRole;
  readonly trustLabel: "user_provided_untrusted";
}

export class ConversationMaterialError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ConversationMaterialError";
  }
}

function value<T>(result: MutationResult<T>): T {
  if (result.ok) return result.result;
  throw new ConversationMaterialError(result.code, result.message);
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ConversationMaterialError("CONVERSATION_MATERIAL_INVALID", `${field} must not be empty`);
  }
  return normalized;
}

function materialIdentity(projectId: string, operationId: string): {
  readonly materialId: string;
  readonly sourceReference: string;
} {
  const digest = createHash("sha256")
    .update(`${projectId}\0${operationId}`)
    .digest("hex");
  return {
    materialId: `conversation-material-${digest.slice(0, 24)}`,
    sourceReference: `conversation-user-operation:${digest}`,
  };
}

/**
 * Adds an exact post-writing user message as project material and binds it to
 * the current confirmed brief. The two storage mutations use stable operation
 * IDs, while an already-bound exact material is returned as an idempotent replay.
 * Trust remains user_provided_untrusted for every role.
 */
export function addConversationMaterialToBrief(
  input: AddConversationMaterialInput,
): ConversationMaterialAttachment {
  const operationId = required(input.operationId, "operationId");
  const projectId = required(input.projectId, "projectId");
  const content = input.userOperationText.trim();
  const displayName = required(input.materialName, "materialName");
  if (content.length === 0) {
    throw new ConversationMaterialError(
      "CONVERSATION_MATERIAL_INVALID",
      "userOperationText must not be empty",
    );
  }
  if (input.role !== "illustrative" && input.role !== "user_firsthand") {
    throw new ConversationMaterialError(
      "CONVERSATION_MATERIAL_ROLE_INVALID",
      "Conversation material role must be illustrative or user_firsthand",
    );
  }
  if (input.role === "user_firsthand" && !isExplicitFirsthandUserStatement(content)) {
    throw new ConversationMaterialError(
      "FIRSTHAND_AUTHORIZATION_REQUIRED",
      "The user's exact operation text must explicitly identify the material as their firsthand experience",
    );
  }

  const identity = materialIdentity(projectId, operationId);
  let project = input.storage.inspectProject(projectId);
  if (project === null) {
    throw new ConversationMaterialError("PROJECT_NOT_FOUND", "Project does not exist");
  }
  let briefVersion = project.currentBriefVersionId === null
    ? null
    : input.storage.getWritingBriefVersion(project.currentBriefVersionId);
  if (briefVersion === null || briefVersion.brief.confirmationStatus !== "confirmed") {
    throw new ConversationMaterialError(
      "WRITING_BRIEF_NOT_CONFIRMED",
      "Post-writing material can only be attached to a confirmed brief",
    );
  }

  const existing = input.storage.getMaterial(projectId, identity.materialId);
  if (existing === null) {
    // A retry gets a new tool operation ID, not a new author statement. Reuse
    // only an exact, already-authorized conversation material in this brief.
    const duplicate = input.storage.listMaterials(projectId).find(material =>
      material.sourceReference?.startsWith('conversation-user-operation:') &&
      material.displayName === displayName && material.role === input.role &&
      material.trustLabel === 'user_provided_untrusted' && material.permissionScope === 'project_only' &&
      material.content === content && briefVersion!.brief.materialIds.includes(material.id) &&
      (input.role !== 'user_firsthand' || briefVersion!.brief.authorAuthorization.firsthandMaterialIds.includes(material.id)));
    if (duplicate) return { materialId: duplicate.id, contentVersionId: duplicate.contentVersionId,
      briefVersionId: briefVersion.id, projectRevision: project.revision, role: input.role, trustLabel: 'user_provided_untrusted' };
  }
  if (existing !== null) {
    if (
      existing.displayName !== displayName ||
      existing.content !== content ||
      existing.sourceReference !== identity.sourceReference ||
      existing.role !== input.role ||
      existing.trustLabel !== "user_provided_untrusted" ||
      existing.permissionScope !== "project_only"
    ) {
      throw new ConversationMaterialError(
        "IDEMPOTENCY_KEY_REUSED",
        "operationId was already used for different conversation material input",
      );
    }
    const alreadyBound = briefVersion.brief.materialIds.includes(existing.id) &&
      (input.role !== "user_firsthand" ||
        briefVersion.brief.authorAuthorization.firsthandMaterialIds.includes(existing.id));
    if (alreadyBound) {
      return {
        materialId: existing.id,
        contentVersionId: existing.contentVersionId,
        briefVersionId: briefVersion.id,
        projectRevision: project.revision,
        role: input.role,
        trustLabel: "user_provided_untrusted",
      };
    }
    if (project.revision !== input.expectedProjectRevision + 1) {
      throw new ConversationMaterialError(
        "PROJECT_REVISION_CONFLICT",
        "Project changed after the conversation material was imported",
      );
    }
  } else {
    if (project.revision !== input.expectedProjectRevision) {
      throw new ConversationMaterialError(
        "PROJECT_REVISION_CONFLICT",
        "Project changed after the conversation material operation was prepared",
      );
    }
    value(input.storage.importMaterial({
      operationId: `${operationId}:import`,
      projectId,
      expectedProjectRevision: input.expectedProjectRevision,
      materialId: identity.materialId,
      displayName,
      sourceKind: "pasted_text",
      sourceReference: identity.sourceReference,
      role: input.role,
      trustLabel: "user_provided_untrusted",
      permissionScope: "project_only",
      content,
      actor: { kind: "user", id: "conversation-user" },
    }));
    project = input.storage.inspectProject(projectId);
    if (project === null) {
      throw new ConversationMaterialError("PROJECT_NOT_FOUND", "Project does not exist");
    }
    briefVersion = project.currentBriefVersionId === null
      ? null
      : input.storage.getWritingBriefVersion(project.currentBriefVersionId);
    if (briefVersion === null || briefVersion.brief.confirmationStatus !== "confirmed") {
      throw new ConversationMaterialError(
        "WRITING_BRIEF_NOT_CONFIRMED",
        "Confirmed brief changed while conversation material was imported",
      );
    }
  }

  const material = input.storage.getMaterial(projectId, identity.materialId);
  if (material === null) {
    throw new ConversationMaterialError(
      "CONVERSATION_MATERIAL_MISSING",
      "Imported conversation material could not be read back",
    );
  }
  const updatedBrief = {
    ...briefVersion.brief,
    materialIds: [...new Set([...briefVersion.brief.materialIds, material.id])],
    authorAuthorization: {
      ...briefVersion.brief.authorAuthorization,
      firsthandMaterialIds: input.role === "user_firsthand"
        ? [...new Set([...briefVersion.brief.authorAuthorization.firsthandMaterialIds, material.id])]
        : briefVersion.brief.authorAuthorization.firsthandMaterialIds,
    },
  };
  const saved = value(input.storage.saveWritingBrief({
    operationId: `${operationId}:brief`,
    projectId,
    expectedProjectRevision: project.revision,
    baseVersionId: briefVersion.id,
    brief: updatedBrief,
    actor: { kind: "user", id: "conversation-user" },
  }));
  const after = input.storage.inspectProject(projectId);
  if (after === null || after.currentBriefVersionId !== saved.versionId) {
    throw new ConversationMaterialError(
      "CONVERSATION_MATERIAL_BIND_FAILED",
      "Updated writing brief could not be read back",
    );
  }
  return {
    materialId: material.id,
    contentVersionId: material.contentVersionId,
    briefVersionId: saved.versionId,
    projectRevision: after.revision,
    role: input.role,
    trustLabel: "user_provided_untrusted",
  };
}
