import type {
  ArtifactVersion,
  JsonValue,
  MaterialRecord,
  MaterialTrustLabel,
} from "../../../writing-core/src/index.js";
import {
  ToolExecutionFault,
  type ToolDefinition,
} from "./types.js";

export type { MaterialRecord, MaterialTrustLabel };

export interface MaterialReadPort {
  listMaterials(
    projectId: string,
  ): readonly MaterialRecord[] | Promise<readonly MaterialRecord[]>;
  getMaterial(
    projectId: string,
    materialId: string,
  ): MaterialRecord | null | Promise<MaterialRecord | null>;
}

export interface ArtifactVersionReadPort {
  getArtifactVersion(
    versionId: string,
  ): ArtifactVersion | null | Promise<ArtifactVersion | null>;
}

export interface BuiltinReadToolDependencies {
  readonly materials: MaterialReadPort;
  readonly versions: ArtifactVersionReadPort;
}

interface ReadMaterialArgs {
  readonly materialId: string;
  readonly contentVersionId: string;
  readonly offset: number;
  readonly maxChars: number;
}

interface ReadArtifactVersionArgs {
  readonly versionId: string;
}

function materialNotFound(): ToolExecutionFault {
  return new ToolExecutionFault(
    "MATERIAL_NOT_FOUND",
    "The requested material is not available in this project",
  );
}

async function requireMaterial(
  port: MaterialReadPort,
  projectId: string,
  materialId: string,
): Promise<MaterialRecord> {
  const material = await port.getMaterial(projectId, materialId);
  if (material === null || material.projectId !== projectId) {
    throw materialNotFound();
  }
  return material;
}

async function requireMaterialVersion(
  port: MaterialReadPort,
  projectId: string,
  materialId: string,
  contentVersionId: string,
): Promise<MaterialRecord> {
  const material = await requireMaterial(port, projectId, materialId);
  if (material.contentVersionId !== contentVersionId) {
    throw new ToolExecutionFault(
      "MATERIAL_VERSION_CONFLICT",
      "The material content version changed before it could be read",
    );
  }
  return material;
}

async function requireVersion(
  port: ArtifactVersionReadPort,
  projectId: string,
  versionId: string,
): Promise<ArtifactVersion> {
  const version = await port.getArtifactVersion(versionId);
  if (version === null || version.projectId !== projectId) {
    throw new ToolExecutionFault(
      "ARTIFACT_VERSION_NOT_FOUND",
      "The requested artifact version is not available in this project",
    );
  }
  return version;
}

export function createBuiltinReadTools(
  dependencies: BuiltinReadToolDependencies,
): readonly ToolDefinition<never, JsonValue>[] {
  const listProjectMaterials: ToolDefinition<
    Record<string, never>,
    JsonValue
  > = {
    name: "list_project_materials",
    version: "1.0.0",
    description: "List metadata for materials authorized in the active project",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    effect: "read_only",
    permissions: ["material:list"],
    async execute(_args, context) {
      const records = await dependencies.materials.listMaterials(context.projectId);
      return {
        materials: records
          .filter((record) => record.projectId === context.projectId)
          .map((record) => ({
            id: record.id,
            displayName: record.displayName,
            sourceKind: record.sourceKind,
            role: record.role,
            permissionScope: record.permissionScope,
            importedAt: record.importedAt,
            contentVersionId: record.contentVersionId,
            hash: record.hash,
            trustLabel: record.trustLabel,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
    },
  };

  const readMaterial: ToolDefinition<ReadMaterialArgs, JsonValue> = {
    name: "read_material",
    version: "1.0.0",
    description: "Read a bounded slice of one material authorized in the active project",
    inputSchema: {
      type: "object",
      properties: {
        materialId: { type: "string", minLength: 1 },
        contentVersionId: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        maxChars: { type: "integer", minimum: 1, maximum: 20_000 },
      },
      required: ["materialId", "contentVersionId", "offset", "maxChars"],
      additionalProperties: false,
    },
    effect: "read_only",
    permissions: ["material:read"],
    async validateTarget(args, context) {
      await requireMaterialVersion(
        dependencies.materials,
        context.projectId,
        args.materialId,
        args.contentVersionId,
      );
    },
    async execute(args, context) {
      const material = await requireMaterialVersion(
        dependencies.materials,
        context.projectId,
        args.materialId,
        args.contentVersionId,
      );
      const characters = Array.from(material.content);
      const content = characters.slice(args.offset, args.offset + args.maxChars).join("");
      const nextOffset = Math.min(args.offset + Array.from(content).length, characters.length);
      return {
        materialId: material.id,
        contentVersionId: material.contentVersionId,
        content,
        offset: args.offset,
        nextOffset,
        totalChars: characters.length,
        truncated: nextOffset < characters.length,
        trustLabel: material.trustLabel,
        instructionAuthority: "none",
      };
    },
  };

  const readArtifactVersion: ToolDefinition<ReadArtifactVersionArgs, JsonValue> = {
    name: "read_artifact_version",
    version: "1.0.0",
    description: "Read one immutable artifact version from the active project",
    inputSchema: {
      type: "object",
      properties: {
        versionId: { type: "string", minLength: 1 },
      },
      required: ["versionId"],
      additionalProperties: false,
    },
    effect: "read_only",
    permissions: ["artifact:read"],
    async validateTarget(args, context) {
      await requireVersion(dependencies.versions, context.projectId, args.versionId);
    },
    async execute(args, context) {
      const version = await requireVersion(
        dependencies.versions,
        context.projectId,
        args.versionId,
      );
      return {
        versionId: version.id,
        artifactId: version.artifactId,
        kind: version.kind,
        logicalKey: version.logicalKey,
        content: version.content,
        contentHash: version.contentHash,
        parentVersionIds: version.parentVersionIds,
        requestSnapshotId: version.requestSnapshotId,
        createdEventSeq: version.createdEventSeq,
        createdAt: version.createdAt,
      };
    },
  };

  return [
    listProjectMaterials,
    readMaterial,
    readArtifactVersion,
  ] as unknown as readonly ToolDefinition<never, JsonValue>[];
}
