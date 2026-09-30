import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  ApplicationServiceError,
  WritingApplicationService,
} from "../../../packages/application/src/index.js";
import {
  ModelProviderBase,
  type ModelProvider,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../../packages/runtime/llm/src/index.js";
import {
  createConfiguredProvider,
  parseProviderConfig as parseRuntimeProviderConfig,
  ProviderConfigError,
  type NormalizedProviderConfig,
} from "../../../packages/runtime/provider-config/src/index.js";
import type { CredentialBroker } from "../../../packages/runtime/credentials/src/index.js";
import { AuthorizedPathPolicy } from "../../../packages/runtime/tools/src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import {
  MaterialRoleSchema,
  ProjectModeSchema,
  WritingBriefSchema,
} from "../../../packages/writing-core/src/index.js";
import type { CliIo } from "./index.js";

const MockProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("mock"),
    model: z.string().trim().min(1),
    draftTemplate: z.string().min(1),
  })
  .strict();

type ProviderConfig =
  | z.infer<typeof MockProviderConfigSchema>
  | NormalizedProviderConfig;

class CliInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CliInputError";
  }
}

class PreparationOnlyProvider extends ModelProviderBase {
  constructor() {
    super("preparation-only", "1.0.0", {
      protocol: "mock",
      streaming: "unsupported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    throw new Error("Preparation provider must never be invoked");
  }
}

class DeterministicWritingMockProvider extends ModelProviderBase {
  constructor(
    private readonly model: string,
    private readonly materialId: string,
    private readonly contentVersionId: string,
    private readonly draftTemplate: string,
  ) {
    super("writing-cli-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  override capabilitiesFor(model: string) {
    return {
      ...super.capabilitiesFor(model),
      tools: model === this.model ? ("supported" as const) : ("unsupported" as const),
    };
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const raw = request.messages.find((message) => message.role === "user")?.content.split("\nCOLLABORATION_STATE=")[1];
    const collaboration = raw === undefined ? null : JSON.parse(raw) as {
      actor: string; stage: string | null; nextStage: string | null; ready: boolean; finished: boolean;
      inputVersionIds: string[]; materials: Array<{ content: string }>;
    };
    const expert = collaboration !== null && collaboration.actor !== "director";
    const toolMessages = request.messages.filter((message) => message.role === "tool");
    if (collaboration?.actor === "director") {
      if (collaboration.finished) {
        yield { type: "text_delta", delta: "完整写作工作流和事实门禁已通过。" };
        yield { type: "completed", finishReason: "stop" }; return;
      }
      const ready = collaboration.ready || toolMessages.some((message) => message.name === "assess_writing_readiness" && JSON.parse(message.content).result?.status === "ready");
      if (ready) {
        yield { type: "tool_call_delta", index: 0, id: `mock-director-${request.requestId}`, name: "director_decide",
          argumentsDelta: JSON.stringify({ action: collaboration.nextStage === null ? "finish" : "dispatch", stage: collaboration.nextStage,
            reason: "根据绑定输入安排专家，集中修订处理独立评审意见。", questions: [], inputVersionIds: collaboration.inputVersionIds }) };
        yield { type: "completed", finishReason: "tool_calls" }; return;
      }
    }
    const materialMessage = toolMessages.find(
      (message) => message.role === "tool" && message.name === "read_material",
    );
    if (!expert && materialMessage === undefined && (collaboration?.materials.length ?? 0) === 0) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "mock-read-material",
        name: "read_material",
        argumentsDelta: JSON.stringify({
          materialId: this.materialId,
          contentVersionId: this.contentVersionId,
          offset: 0,
          maxChars: 20_000,
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    const payload = materialMessage === undefined ? { result: { content: collaboration?.materials.map((material) => material.content).join("\n") } } : JSON.parse(materialMessage.content) as {
      result?: { content?: unknown };
    };
    const materialContent = payload.result?.content;
    if (typeof materialContent !== "string") {
      throw new Error("Mock fixture received an invalid material result");
    }
    const readinessAssessed = toolMessages.some(
      (message) =>
        message.role === "tool" && message.name === "assess_writing_readiness",
    );
    if (!expert && !readinessAssessed) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "mock-writing-ready",
        name: "assess_writing_readiness",
        argumentsDelta: JSON.stringify({
          status: "ready",
          reason: "已读取 CLI 授权材料，可以执行有界写作工作流。",
          questions: [],
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    const submittedStages = toolMessages
      .filter((message) => message.role === "tool" && message.name === "submit_writing_stage")
      .map((message) => {
        if (message.role !== "tool") return "";
        const result = JSON.parse(message.content) as { result?: { stage?: string } };
        return result.result?.stage ?? "";
      });
    const deepMode = request.messages.some(
      (message) => message.role === "system" && message.content.includes("review_publish"),
    );
    const stages: readonly (readonly [string, string])[] = [
      ["research", "# 研究与证据\n\n已读取并仅使用用户授权的本地材料。"],
      ["outline", "# 结构\n\n1. 下班后的现场\n2. 散步中的感受\n3. 留给读者的余味"],
      ["draft", this.draftTemplate.replaceAll("{{material}}", materialContent)],
      ["review_editor", "必须修改：无。\n\n可选优化：可补充一个环境细节。\n\n建议保留：克制的第一人称。"],
      ...(deepMode
        ? [["review_publish", "必须修改：无。\n\n可选优化：发布前检查标题。\n\n建议保留：不夸大材料。"]] as const
        : []),
      ["review_reader", "必须修改：无。\n\n可选优化：开头可更快进入现场。\n\n建议保留：清晰的阅读节奏。"],
      ["central_revision", this.draftTemplate.replaceAll("{{material}}", materialContent)],
      ["language_review", this.draftTemplate.replaceAll("{{material}}", materialContent)],
    ];
    const next = expert ? stages.find(([stage]) => stage === collaboration.stage) : stages[submittedStages.length];
    if (next !== undefined) {
      if (expert && next[0] !== 'research' && !request.tools?.some(t => t.name === 'submit_writing_stage')) {
        yield { type: 'text_delta', delta: next[1] };
        yield { type: 'completed', finishReason: 'stop' }; return;
      }
      yield {
        type: "tool_call_delta",
        index: 0,
        id: `mock-stage-${next[0]}`,
        name: "submit_writing_stage",
        argumentsDelta: JSON.stringify({ stage: next[0], content: next[1] }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    const factSubmitted = toolMessages.some(
      (message) => message.role === "tool" && message.name === "submit_fact_check",
    );
    if (!factSubmitted) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "mock-fact-check",
        name: "submit_fact_check",
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: "正文只复述用户授权的一手材料，没有需要外部核实的事实主张。",
        }),
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }

    yield {
      type: "text_delta",
      delta: "完整写作工作流已执行；最终稿、评审和核查结果均已保存。",
    };
    yield { type: "completed", finishReason: "stop" };
  }
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new CliInputError("CLI_OPTION_REQUIRED", `${name} is required`);
  }
  return value;
}

function parseSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CliInputError(
      "INPUT_SCHEMA_INVALID",
      `${label} does not match the required schema`,
    );
  }
  return parsed.data;
}

function strictUtf8(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new CliInputError(
      "INPUT_UTF8_INVALID",
      `Input file must be readable UTF-8 text: ${basename(path)}`,
    );
  }
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(strictUtf8(path)) as unknown;
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError(
      "INPUT_JSON_INVALID",
      `Input file is not valid JSON: ${basename(path)}`,
    );
  }
}

function parseWritingProviderConfig(value: unknown): ProviderConfig {
  const mock = MockProviderConfigSchema.safeParse(value);
  if (mock.success) return mock.data;
  try {
    return parseRuntimeProviderConfig(value);
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      throw new CliInputError(error.code, error.message);
    }
    throw error;
  }
}

function createProvider(
  config: ProviderConfig,
  materialId: string,
  contentVersionId: string,
  credentials: CredentialBroker,
): ModelProvider {
  if (config.kind === "mock") {
    return new DeterministicWritingMockProvider(
      config.model,
      materialId,
      contentVersionId,
      config.draftTemplate,
    );
  }
  return createConfiguredProvider(config, credentials);
}

function requireMutation<T>(
  result:
    | { readonly ok: true; readonly projectRevision: number; readonly result: T }
    | {
        readonly ok: false;
        readonly code: string;
        readonly message: string;
      },
): { readonly projectRevision: number; readonly result: T } {
  if (!result.ok) throw new ApplicationServiceError(result.code, result.message);
  return result;
}

export async function runWritingCommand(
  args: readonly string[],
  workspacePath: string,
  io: CliIo,
  credentials: CredentialBroker,
): Promise<number> {
  const projectId = requiredOption(args, "--project");
  const projectName = requiredOption(args, "--name");
  const mode = parseSchema(
    ProjectModeSchema,
    requiredOption(args, "--mode"),
    "--mode",
  );
  const briefInputPath = requiredOption(args, "--brief");
  const materialInputPath = requiredOption(args, "--material");
  const materialId = requiredOption(args, "--material-id");
  const materialRole = parseSchema(
    MaterialRoleSchema,
    requiredOption(args, "--material-role"),
    "--material-role",
  );
  const providerInputPath = requiredOption(args, "--provider-config");
  const storage = openWorkspaceStorage({ workspacePath });

  try {
    const paths = AuthorizedPathPolicy.create({
      workspaceRoot: workspacePath,
      importedPaths: [briefInputPath, materialInputPath, providerInputPath],
    });
    const briefPath = paths.resolveReadableFile(briefInputPath).path;
    const materialPath = paths.resolveReadableFile(materialInputPath).path;
    const providerPath = paths.resolveReadableFile(providerInputPath).path;
    const brief = parseSchema(
      WritingBriefSchema,
      parseJson(briefPath),
      "--brief",
    );
    const providerConfig = parseWritingProviderConfig(parseJson(providerPath));
    const materialContent = strictUtf8(materialPath);
    if (
      brief.materialIds.length !== 1 ||
      brief.materialIds[0] !== materialId
    ) {
      throw new CliInputError(
        "BRIEF_MATERIAL_MISMATCH",
        "The first CLI run supports one material and its ID must match the brief",
      );
    }

    const preparation = new WritingApplicationService({
      storage,
      provider: new PreparationOnlyProvider(),
    });
    requireMutation(
      preparation.createProject({
        operationId: randomUUID(),
        projectId,
        name: projectName,
        mode,
        actor: { kind: "user", id: "cli-user" },
      }),
    );
    const imported = requireMutation(
      preparation.importMaterial({
        operationId: randomUUID(),
        projectId,
        expectedProjectRevision: 0,
        materialId,
        displayName: basename(materialPath),
        sourceKind: "utf8_file",
        sourceReference: materialPath,
        role: materialRole,
        trustLabel: "user_provided_untrusted",
        permissionScope: "project_only",
        content: materialContent,
        actor: { kind: "user", id: "cli-user" },
      }),
    );
    const savedBrief = requireMutation(
      preparation.saveWritingBrief({
        operationId: randomUUID(),
        projectId,
        expectedProjectRevision: imported.projectRevision,
        baseVersionId: null,
        brief,
        actor: { kind: "user", id: "cli-user" },
      }),
    );
    const decision = requireMutation(
      preparation.recordDecision({
        operationId: randomUUID(),
        projectId,
        expectedProjectRevision: savedBrief.projectRevision,
        decisionId: randomUUID(),
        type: "brief",
        value: {
          confirmationStatus: brief.confirmationStatus,
          styleDecision: brief.authorAuthorization.styleDecision,
          directionDecision: brief.authorAuthorization.directionDecision,
        },
        scope: "current_article",
        sourceEventId: null,
        actor: { kind: "user", id: "cli-user" },
      }),
    );

    const provider = createProvider(
      providerConfig,
      materialId,
      imported.result.contentVersionId,
      credentials,
    );
    const service = new WritingApplicationService({ storage, provider });
    const result = await service.runDraft({
      projectId,
      expectedProjectRevision: decision.projectRevision,
      expectedBriefVersionId: savedBrief.result.versionId,
      model: providerConfig.model,
      parameters: { temperature: 0, toolChoice: "auto" },
      budget: {
        maxModelRequests: 32,
        maxToolCalls: 40,
        maxRetriesPerRequest: 2,
        maxMajorRevisions: mode === "quick" ? 1 : 2,
      },
    });
    if (!result.ok) {
      io.stderr(`Writing run failed: ${result.error.code}`);
      return 1;
    }
    const project = storage.inspectProject(projectId);
    io.stdout(
      JSON.stringify(
        {
          status: "draft_saved",
          validationKind: result.validationKind,
          publicationReady: result.publicationReady,
          projectId,
          runId: result.runId,
          artifactVersionId: result.artifactVersionId,
          modelRequestCount: result.modelRequestCount,
          toolCallCount: result.toolCallCount,
          factGateStatus: project?.factGateStatus ?? "unknown",
          capabilities: result.capabilities,
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    storage.close();
  }
}
