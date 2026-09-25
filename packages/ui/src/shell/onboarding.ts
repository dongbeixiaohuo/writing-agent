import type {
  CreateProjectInput,
  UpdateBriefInput,
} from "../../../client-bridge/src/protocol.js";
import type {
  DesktopProviderConnectionResultView,
  DesktopProviderSetupInput,
} from "../../../client-bridge/src/desktop-bridge.js";

export interface ProjectSetupForm {
  readonly name: string;
  readonly mode: "quick" | "deep";
  readonly topic: string;
  readonly genre: CreateProjectInput["genre"];
  readonly audience: string;
  readonly targetCharacters: string;
  readonly constraints: string;
  readonly interactionMode: CreateProjectInput["interactionMode"];
  readonly authorVoice: string;
  readonly styleReference: string;
  readonly styleDecision: CreateProjectInput["styleDecision"];
  readonly directionDecision: CreateProjectInput["directionDecision"];
  readonly platform: string;
  readonly publicationGoal: CreateProjectInput["publicationGoal"];
  readonly materials: readonly {
    readonly name: string;
    readonly content: string;
    readonly role: CreateProjectInput["materials"][number]["role"];
    readonly sourceKind: CreateProjectInput["materials"][number]["sourceKind"];
    readonly sourceReference: string;
  }[];
}

export type BriefUpdateForm = Omit<ProjectSetupForm, "name" | "mode" | "materials">;

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(code);
  return normalized;
}

const SETUP_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  PROJECT_LENGTH_INVALID: "目标字符数需要在 100 到 1,000,000 之间。",
  PROJECT_NAME_REQUIRED: "请填写项目名称。",
  PROJECT_TOPIC_REQUIRED: "请填写写作主题。",
  PROJECT_AUDIENCE_REQUIRED: "请填写目标读者。",
  PROJECT_MATERIAL_NAME_REQUIRED: "请填写材料名称。",
  PROJECT_MATERIAL_REQUIRED: "请粘贴至少一段材料正文。",
  PROJECT_MATERIAL_FILE_TYPE_INVALID: "仅支持 UTF-8 编码的 TXT、MD 或 Markdown 文件。",
  PROJECT_MATERIAL_FILE_TOO_LARGE: "单份材料不能超过 2 MB。",
  PROJECT_MATERIAL_FILE_READ_FAILED: "材料文件读取失败，请确认文件可访问后重试。",
  PROJECT_MATERIAL_URL_INVALID: "网页快照来源必须是有效的 HTTPS 地址。",
  PROJECT_STYLE_FILE_TYPE_INVALID: "风格文件仅支持 UTF-8 编码的 TXT、MD 或 Markdown。",
  PROJECT_STYLE_FILE_TOO_LARGE: "风格文件不能超过 64 KB。",
  PROJECT_STYLE_FILE_READ_FAILED: "风格文件读取失败，请确认文件可访问后重试。",
  PROVIDER_URL_REQUIRED: "请填写 API 地址。",
  PROVIDER_URL_INVALID: "API 地址格式不正确。",
  PROVIDER_HTTPS_REQUIRED: "API 地址必须使用 HTTPS。",
  PROVIDER_ID_REQUIRED: "请填写配置名称。",
  PROVIDER_MODEL_REQUIRED: "请填写模型名称。",
  PROVIDER_API_KEY_REQUIRED: "请填写 API Key。",
};

export async function materialPatchFromFile(file: {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}): Promise<{
  readonly name: string;
  readonly content: string;
  readonly sourceKind: "utf8_file";
  readonly sourceReference: string;
}> {
  const name = file.name.trim();
  if (!/\.(?:txt|md|markdown)$/iu.test(name)) {
    throw new Error("PROJECT_MATERIAL_FILE_TYPE_INVALID");
  }
  if (file.size > 2_000_000) throw new Error("PROJECT_MATERIAL_FILE_TOO_LARGE");
  let content: string;
  try {
    content = await file.text();
  } catch {
    throw new Error("PROJECT_MATERIAL_FILE_READ_FAILED");
  }
  if (content.trim().length === 0) throw new Error("PROJECT_MATERIAL_REQUIRED");
  if (content.length > 2_000_000) throw new Error("PROJECT_MATERIAL_FILE_TOO_LARGE");
  return {
    name,
    content,
    sourceKind: "utf8_file",
    sourceReference: name,
  };
}

export async function styleReferenceFromFile(file: {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}): Promise<string> {
  const name = file.name.trim();
  if (!/\.(?:txt|md|markdown)$/iu.test(name)) {
    throw new Error("PROJECT_STYLE_FILE_TYPE_INVALID");
  }
  if (file.size > 64_000) throw new Error("PROJECT_STYLE_FILE_TOO_LARGE");
  let content: string;
  try {
    content = await file.text();
  } catch {
    throw new Error("PROJECT_STYLE_FILE_READ_FAILED");
  }
  const normalized = content.trim();
  if (normalized.length === 0) throw new Error("PROJECT_STYLE_FILE_READ_FAILED");
  if (normalized.length > 64_000) throw new Error("PROJECT_STYLE_FILE_TOO_LARGE");
  return `[导入风格文件：${name}]\n${normalized}`;
}

const COMMAND_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INTAKE_PROPOSAL_CONFLICT: "写作方向已发生变化，请先看最新建议再确认。",
  UNKNOWN_OUTCOME_REQUIRES_CONFIRMATION: "上次模型请求的结果未知，请先选择“确认重试并继续”，系统不会自行重复请求。",
  MESSAGE_TOO_LONG: "这一段超过 20,000 字符，请分几次发送。",
  MODEL_CONFIGURATION_REQUIRED: "先在设置中连接模型，就可以直接开始交流。",
  ACTIVE_RUNS_PRESENT: "已有写作任务正在运行，请等待完成或停止后再修改模型设置。",
  BRIEF_CONFIRMATION_REQUIRED: "请先确认写作简报和方向。",
  BRIEF_NOT_FOUND: "当前写作简报不可用，请重新打开项目后重试。",
  BRIEF_VERSION_CONFLICT: "写作目标已变化，请确认最新写作简报后重试。",
  CHECKPOINT_FEEDBACK_NOT_ALLOWED: "当前不是可反馈的共创节点，请刷新后查看最新进度。",
  WRITING_INPUT_ANSWER_REQUIRED: "请先回答对话中的问题或补充材料；只说“继续”无法补齐缺少的信息。",
  CHECKPOINT_FEEDBACK_TOO_LONG: "本次修改意见过长，请精简到 4,000 字符以内。",
  DESKTOP_COMMAND_FAILED: "本次操作未能完成，原因尚未确认。请重试；若仍失败，请反馈操作位置和时间。",
  DESKTOP_PROVIDER_INPUT_INVALID: "模型配置格式无效，请检查填写内容。",
  DESKTOP_PROVIDER_PROFILE_INVALID: "已保存的模型配置无法读取，请重新保存。",
  INSECURE_PROVIDER_URL_REJECTED: "API 地址必须使用 HTTPS。",
  MODEL_PROVIDER_REQUIRED: "尚未配置可用模型，请先在模型设置中完成配置。",
  MODEL_TOOLS_UNVERIFIED: "当前模型尚未确认支持工具调用，请在模型设置中检查配置。",
  PROJECT_NOT_FOUND: "当前项目不可用，请重新选择或创建项目。",
  PROJECT_REVISION_CONFLICT: "项目内容已变化，请刷新后重试。",
  PROJECT_SELECTION_REQUIRED: "请先选择或创建一个项目。",
  PROVIDER_URL_INVALID: "API 地址格式不正确。",
  REVISION_BUDGET_EXCEEDS_PLAN: "当前写作模式的修订设置不兼容，请重新打开项目后重试。",
  REVISION_CONFLICT: "项目内容已变化，请刷新后重试。",
  RUN_ALREADY_ACTIVE: "已有写作任务正在运行，请等待完成或先停止。",
  USER_INSTRUCTION_TOO_LARGE: "本次写作要求过长，请精简到 20,000 字符以内。",
  WRITING_BRIEF_REQUIRED: "请先确认写作简报和方向。",
};

export function setupErrorMessage(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;
  return SETUP_ERROR_MESSAGES[reason.message] ?? `${fallback}：${reason.message}`;
}

export function commandErrorMessage(reason: unknown, fallback: string): string {
  if (typeof reason !== "object" || reason === null) return fallback;
  const candidate = "code" in reason && typeof reason.code === "string"
    ? reason.code
    : reason instanceof Error
      ? reason.message
      : null;
  return candidate === null ? fallback : COMMAND_ERROR_MESSAGES[candidate] ?? fallback;
}

export function dataActionErrorMessage(reason: unknown, fallback: string): string {
  if (typeof reason !== "object" || reason === null) return fallback;
  const code = "code" in reason && typeof reason.code === "string"
    ? reason.code
    : reason instanceof Error
      ? reason.message
      : null;
  if (code === null) return fallback;
  const messages: Readonly<Record<string, string>> = {
    ACTIVE_RUNS_PRESENT: "请先完成或停止当前写作任务，再执行数据操作。",
    DIAGNOSTIC_CONFIRMATION_MISMATCH: "诊断预览已变化，请重新预览后再导出。",
    DIAGNOSTIC_PREPARATION_REQUIRED: "请先预览诊断包内容。",
    DIAGNOSTIC_TARGET_EXISTS: "所选文件已经存在，请换一个文件名后重试。",
    DIAGNOSTIC_WRITE_FAILED: "诊断包写入失败，请检查目标目录权限或磁盘空间。",
    LEGACY_DATABASE_CORRUPT: "旧版数据库已损坏，未执行导入。",
    LEGACY_DATABASE_NOT_FOUND: "没有找到所选旧版数据库。",
    LEGACY_MANIFEST_INVALID: "所选目录中的 run_manifest.json 无法识别。",
    LEGACY_PROJECT_MANIFEST_NOT_FOUND: "旧版项目缺少必要的 project.json。",
    LEGACY_PROJECTS_EMPTY: "所选旧数据中没有可导入项目。",
    LEGACY_SCHEMA_INVALID: "旧版数据库结构不完整，未执行导入。",
    LEGACY_SCHEMA_UNSUPPORTED: "暂不支持这个旧版数据库版本。",
    LEGACY_SOURCE_INVALID: "请选择真实的旧项目目录，不支持快捷方式或符号链接。",
    LEGACY_SOURCE_NOT_FOUND: "没有找到所选旧项目目录。",
    LEGACY_TEXT_INVALID: "旧项目中存在非 UTF-8 文本，未执行导入。",
    MIGRATION_CONFIRMATION_MISMATCH: "迁移预览已变化，请重新扫描后再导入。",
    MIGRATION_PLAN_STALE: "旧数据在扫描后发生变化，请重新扫描。",
    TARGET_INSIDE_SOURCE: "当前工作区不能位于旧项目目录内部。",
    TARGET_NOT_WRITABLE: "当前工作区不可写，无法导入。",
    TARGET_SPACE_INSUFFICIENT: "可用磁盘空间不足，无法安全备份并导入。",
    BACKUP_DESTINATION_EXISTS: "所选备份文件已经存在，请换一个文件名。",
    BACKUP_TARGET_IS_LIVE_DATABASE: "不能把正在使用的数据库作为备份目标。",
    BACKUP_VERIFICATION_FAILED: "备份未通过完整性校验，没有生成可用备份。",
    DATABASE_NOT_FOUND: "没有找到所选备份文件；当前工作区没有变化。",
    UNRECOGNIZED_DATABASE: "所选文件不是可识别的 Writing Agent 工作区备份。",
    SCHEMA_UNSUPPORTED: "所选备份来自不受支持的版本，未执行恢复。",
    RESTORE_CONFIRMATION_MISMATCH: "恢复确认与预览不一致，未替换当前工作区。",
    RESTORE_CONFIRMATION_STALE: "备份文件在预览后发生变化，请重新选择并检查。",
    RESTORE_SOURCE_IS_TARGET: "不能用正在运行的工作区数据库恢复自身。",
    RESTORE_TARGET_MISSING: "当前工作区数据库不存在，未执行恢复。",
    RESTORE_VERIFICATION_FAILED: "恢复副本未通过完整性校验，程序将保留恢复前数据。",
    PROJECT_DELETE_CONFIRMATION_MISMATCH: "输入的项目名称不一致，未删除任何数据。",
    PROJECT_DELETE_RUN_ACTIVE: "这个项目仍在写作中。请先停止该项目的任务，再删除；其他项目不受影响。",
    PROJECT_NOT_FOUND: "这个项目已经不存在，请关闭弹窗并刷新项目列表。",
    PROJECT_REVISION_CONFLICT: "项目内容刚刚发生变化，本次未删除。请关闭弹窗后重新确认。",
    STORAGE_WRITE_FAILED: "本次数据操作未能写入，已回滚，没有删除任何数据。请检查磁盘空间及工作区权限后重试。",
    STORAGE_READ_ONLY: "工作区当前为只读，未删除任何数据。请检查工作区写入权限。",
  };
  return messages[code] ?? fallback;
}

export function providerConnectionMessage(
  result: DesktopProviderConnectionResultView,
): { readonly tone: "success" | "failure"; readonly text: string } {
  if (result.ok) {
    return {
      tone: "success",
      text: result.tools === "supported"
        ? "连接验证通过：鉴权、模型、流式响应和工具调用均可用。"
        : "基础连接验证通过，但尚未验证工具调用能力。",
    };
  }
  const messages: Readonly<Record<string, string>> = {
    AUTH_FAILED: "API Key 无效或没有访问权限，请更新 Key 后重试。",
    INVALID_REQUEST: "服务拒绝了测试请求，请检查服务类型、API 地址和模型 ID。",
    MODEL_RESPONSE_INVALID: "模型响应格式不兼容，请检查服务类型或更换模型。",
    MODEL_OUTPUT_TRUNCATED: "模型回复达到单次输出长度上限，连接验证未完成；这不是 API Key 或账户额度错误。",
    MODEL_UNSUPPORTED: result.stage === "tools"
      ? "当前模型不支持写作所需的工具调用，请更换支持工具调用的模型。"
      : "模型名称不可用，请检查服务商提供的模型 ID。",
    NETWORK_ERROR: "无法连接模型服务，请检查 API 地址和网络。",
    PROVIDER_UNAVAILABLE: "模型服务暂不可用，请稍后重试。",
    QUOTA_EXCEEDED: "模型账户额度不足，请检查余额或套餐。",
    RATE_LIMITED: "请求过于频繁，请稍后再验证。",
    TIMEOUT: "连接测试超时，请检查网络或稍后重试。",
  };
  return {
    tone: "failure",
    text: messages[result.errorCode] ?? "连接验证失败，请检查配置后重试。",
  };
}

export function normalizeProjectSetup(form: ProjectSetupForm): CreateProjectInput {
  const brief = normalizeBriefUpdate(form);
  const materials = form.materials
    .filter((material) =>
      material.name.trim().length > 0 ||
      material.content.trim().length > 0 ||
      material.sourceReference.trim().length > 0)
    .map((material) => {
      const sourceReference = material.sourceReference.trim();
      if (material.sourceKind === "web_snapshot") {
        let parsed: URL;
        try {
          parsed = new URL(sourceReference);
        } catch {
          throw new Error("PROJECT_MATERIAL_URL_INVALID");
        }
        if (parsed.protocol !== "https:") {
          throw new Error("PROJECT_MATERIAL_URL_INVALID");
        }
      }
      return {
        name: required(material.name, "PROJECT_MATERIAL_NAME_REQUIRED"),
        content: required(material.content, "PROJECT_MATERIAL_REQUIRED"),
        role: material.role,
        sourceKind: material.sourceKind,
        sourceReference: sourceReference.length === 0 ? null : sourceReference,
      };
    });
  return {
    name: required(form.name, "PROJECT_NAME_REQUIRED"),
    mode: form.mode,
    ...brief,
    materials,
  };
}

export function normalizeBriefUpdate(form: BriefUpdateForm): UpdateBriefInput {
  const targetCharacters = Number(form.targetCharacters);
  if (!Number.isSafeInteger(targetCharacters) || targetCharacters < 100 || targetCharacters > 1_000_000) {
    throw new Error("PROJECT_LENGTH_INVALID");
  }
  return {
    topic: required(form.topic, "PROJECT_TOPIC_REQUIRED"),
    genre: form.genre,
    audience: required(form.audience, "PROJECT_AUDIENCE_REQUIRED"),
    targetCharacters,
    constraints: form.constraints
      .split(/\r?\n/u)
      .map((constraint) => constraint.trim())
      .filter((constraint) => constraint.length > 0),
    interactionMode: form.interactionMode,
    authorVoice: form.authorVoice.trim() || null,
    styleReference: form.styleReference.trim() || null,
    styleDecision: form.styleDecision,
    directionDecision: form.directionDecision,
    platform: form.platform.trim() || null,
    publicationGoal: form.publicationGoal,
  };
}

export function normalizeProviderSetup(
  form: DesktopProviderSetupInput,
): DesktopProviderSetupInput {
  const baseURL = required(form.baseURL, "PROVIDER_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("PROVIDER_URL_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("PROVIDER_HTTPS_REQUIRED");
  return {
    kind: form.kind,
    providerId: required(form.providerId, "PROVIDER_ID_REQUIRED"),
    baseURL,
    model: required(form.model, "PROVIDER_MODEL_REQUIRED"),
    tools: form.tools,
    usage: form.usage,
    apiKey: required(form.apiKey, "PROVIDER_API_KEY_REQUIRED"),
    persistence: form.persistence,
  };
}
