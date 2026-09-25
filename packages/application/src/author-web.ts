import { createHash } from "node:crypto";

import {
  NetworkAccessPolicy,
  SecureWebFetcher,
  ToolExecutionFault,
  type SecureWebFetchResult,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../../runtime/tools/src/index.js";
import type { JsonValue, MutationResult, StoragePort } from "../../writing-core/src/index.js";

export interface AuthorWebFetcher {
  fetchText(url: string): Promise<SecureWebFetchResult>;
}

export interface CreateAuthorWebToolOptions {
  readonly storage: StoragePort;
  readonly projectId: string;
  /** Exact URLs explicitly supplied by the current user at the application boundary. */
  readonly authorizedUrls: readonly string[];
  /** Test seam only. Authorization and network policy checks still run before this dependency. */
  readonly fetcher?: AuthorWebFetcher;
}

interface ReadAuthorWebArgs {
  readonly url: string;
}

const permissions = [
  "network:https:read",
  "material:import",
  "brief:write",
] as const;

function value<T>(result: MutationResult<T>): T {
  if (result.ok) return result.result;
  throw new ToolExecutionFault(result.code, result.message, result.retryable);
}

function identity(projectId: string, operationId: string, requestedUrl: string): string {
  const digest = createHash("sha256")
    .update(`${projectId}\0${operationId}\0${requestedUrl}`)
    .digest("hex");
  return `author-web-${digest.slice(0, 24)}`;
}

function assertProject(options: CreateAuthorWebToolOptions, context: ToolExecutionContext): void {
  if (context.projectId !== options.projectId) {
    throw new ToolExecutionFault(
      "TOOL_TARGET_INVALID",
      "The webpage authorization belongs to a different project",
    );
  }
}

function confirmedBrief(storage: StoragePort, projectId: string) {
  const project = storage.inspectProject(projectId);
  if (project === null) {
    throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Project does not exist");
  }
  const brief = project.currentBriefVersionId === null
    ? null
    : storage.getWritingBriefVersion(project.currentBriefVersionId);
  if (brief === null || brief.brief.confirmationStatus !== "confirmed") {
    throw new ToolExecutionFault(
      "WRITING_BRIEF_NOT_CONFIRMED",
      "A confirmed writing brief is required before importing webpage material",
    );
  }
  return { project, brief };
}

export function createAuthorWebTool(
  options: CreateAuthorWebToolOptions,
): ToolDefinition<{ url: string }, JsonValue> {
  const authorizedUrls = new Set(options.authorizedUrls.map((url) => url.trim()));
  const policy = new NetworkAccessPolicy();
  const fetcher = options.fetcher ?? new SecureWebFetcher({ policy });

  async function validate(args: ReadAuthorWebArgs, context: ToolExecutionContext): Promise<string> {
    assertProject(options, context);
    if (typeof args.url !== "string" || !authorizedUrls.has(args.url)) {
      throw new ToolExecutionFault(
        "AUTHOR_WEB_URL_NOT_AUTHORIZED",
        "The exact webpage URL was not explicitly authorized by the user",
      );
    }
    const target = await policy.assertAllowed(args.url);
    confirmedBrief(options.storage, options.projectId);
    return target.url;
  }

  return {
    name: "read_author_web",
    version: "1.0.0",
    description: "Read one explicitly user-authorized HTTPS webpage and save its inert text as project material",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", minLength: 1 } },
      required: ["url"],
      additionalProperties: false,
    },
    effect: "local_idempotent",
    permissions,
    async validateTarget(args, context) {
      await validate(args, context);
    },
    async execute(args, context) {
      const requestedUrl = await validate(args, context);
      const materialId = identity(options.projectId, context.operationId, requestedUrl);
      const before = confirmedBrief(options.storage, options.projectId);
      const existing = options.storage.getMaterial(options.projectId, materialId);
      if (existing !== null) {
        if (
          existing.sourceKind !== "web_snapshot" ||
          existing.role !== "source_verified" ||
          existing.trustLabel !== "external_untrusted" ||
          existing.permissionScope !== "project_only"
        ) {
          throw new ToolExecutionFault(
            "IDEMPOTENCY_KEY_REUSED",
            "operationId was already used for different material input",
          );
        }
        if (before.brief.brief.materialIds.includes(existing.id)) {
          return {
            materialId: existing.id,
            contentVersionId: existing.contentVersionId,
            briefVersionId: before.brief.id,
            sourceUrl: existing.sourceReference,
            contentHash: existing.hash,
            truncated: false,
            trustLabel: "external_untrusted",
            instructionAuthority: "none",
          };
        }
      }

      let fetched: SecureWebFetchResult | null = null;
      if (existing === null) {
        try {
          fetched = await fetcher.fetchText(requestedUrl);
          await policy.assertAllowed(fetched.finalUrl);
        } catch (error) {
          if (error instanceof ToolExecutionFault) throw error;
          const code = error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "AUTHOR_WEB_FETCH_FAILED";
          throw new ToolExecutionFault(
            code,
            "The authorized webpage could not be read; no usable material was created",
            true,
          );
        }
        if (fetched.content.truncated) {
          throw new ToolExecutionFault(
            "AUTHOR_WEB_CONTENT_TRUNCATED",
            "The webpage text exceeded the safe limit and was not imported as a complete source; narrow the requested source",
          );
        }
        if (fetched.content.text.trim().length === 0) {
          throw new ToolExecutionFault(
            "AUTHOR_WEB_CONTENT_EMPTY",
            "The authorized webpage did not contain importable text",
          );
        }
      }

      let project = options.storage.inspectProject(options.projectId);
      if (project === null) throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Project does not exist");
      if (existing === null) {
        if (fetched === null) throw new ToolExecutionFault("AUTHOR_WEB_FETCH_FAILED", "The webpage was not fetched");
        value(options.storage.importMaterial({
          operationId: `${context.operationId}:import`,
          projectId: options.projectId,
          expectedProjectRevision: project.revision,
          materialId,
          displayName: `Web source: ${new URL(fetched.finalUrl).hostname}`,
          sourceKind: "web_snapshot",
          sourceReference: fetched.finalUrl,
          role: "source_verified",
          trustLabel: "external_untrusted",
          permissionScope: "project_only",
          content: fetched.content.text,
          actor: { kind: "agent", id: "author-web", runId: context.runId },
        }));
      }

      project = options.storage.inspectProject(options.projectId);
      if (project === null) throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Project does not exist");
      const latestBrief = project.currentBriefVersionId === null
        ? null
        : options.storage.getWritingBriefVersion(project.currentBriefVersionId);
      if (latestBrief === null || latestBrief.brief.confirmationStatus !== "confirmed") {
        throw new ToolExecutionFault(
          "WRITING_BRIEF_NOT_CONFIRMED",
          "The confirmed writing brief changed while importing the webpage",
        );
      }
      const material = options.storage.getMaterial(options.projectId, materialId);
      if (material === null) {
        throw new ToolExecutionFault("AUTHOR_WEB_IMPORT_FAILED", "The webpage snapshot could not be read back");
      }
      const saved = value(options.storage.saveWritingBrief({
        operationId: `${context.operationId}:brief`,
        projectId: options.projectId,
        expectedProjectRevision: project.revision,
        baseVersionId: latestBrief.id,
        brief: {
          ...latestBrief.brief,
          materialIds: [...new Set([...latestBrief.brief.materialIds, material.id])],
        },
        actor: { kind: "agent", id: "author-web", runId: context.runId },
      }));
      const after = options.storage.inspectProject(options.projectId);
      if (after === null || after.currentBriefVersionId !== saved.versionId) {
        throw new ToolExecutionFault("AUTHOR_WEB_BIND_FAILED", "The webpage snapshot was not bound to the current brief");
      }
      return {
        materialId: material.id,
        contentVersionId: material.contentVersionId,
        briefVersionId: saved.versionId,
        sourceUrl: material.sourceReference,
        contentHash: material.hash,
        truncated: false,
        trustLabel: "external_untrusted",
        instructionAuthority: "none",
      };
    },
  };
}
