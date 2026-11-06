import { UI_BRIDGE_PROTOCOL_VERSION, type ClientBridge } from "../../../packages/client-bridge/src/protocol.js";
import { WORKFLOW_COMMAND_MESSAGES } from '../../../packages/client-bridge/src/workflow-errors.js';
import { STYLE_SAMPLE_LIMIT_MESSAGE } from '../../../packages/writing-core/src/style-profile.js';
import type {
  DesktopRpcRequest,
  DesktopRpcResponse,
} from "../../../packages/client-bridge/src/desktop-bridge.js";

function rpcError(code: string, message: string): DesktopRpcResponse {
  return { ok: false, error: { code, message } };
}

const publicMessages: Readonly<Record<string, string>> = {
  MODEL_GROUPS_INVALID: '分组模型配置无效，请重新选择。',
  MODEL_GROUP_UNAVAILABLE: '分组指定的模型尚未通过验证或配置已变化。请在模型设置中重新验证、选择其他模型或改为跟随默认。',
  STYLE_INPUT_INVALID: '风格资料格式不正确，请检查名称、样文数量和长度后重试。',
  STYLE_SAMPLE_LIMIT_EXCEEDED: STYLE_SAMPLE_LIMIT_MESSAGE,
  STYLE_SOURCE_URL_INVALID: '请输入 HTTP 或 HTTPS 链接，每行一个；请移除非链接文字后重试。',
  STYLE_SAMPLE_DUPLICATE: '同一篇样文已添加，请移除重复内容；重复样文不会提高置信度。',
  STYLE_SAMPLE_ID_DUPLICATE: '样文编号重复，请移除重复样文后重新添加。',
  STYLE_SAMPLE_TOTAL_TOO_LARGE: '样文总量超过 300,000 字符，请分组提取。',
  STYLE_DOCUMENT_TOO_LARGE: '文档超过 4 MB，或正文超过 100,000 字符，请选取代表性内容。',
  STYLE_DOCUMENT_INVALID: '未能提取文档文字，请检查 Word 文件，或粘贴正文。扫描图片暂不支持。',
  STYLE_DOCUMENT_ENCODING: '文本编码无法识别，请另存为 UTF-8 或直接粘贴文字。',
  STYLE_DOCUMENT_TYPE: '请选择 DOCX、TXT 或 Markdown 文档；旧版 DOC、PDF 和扫描件暂不支持。',
  STYLE_DOCUMENT_PICKER_REQUIRED: '请通过桌面客户端的“导入文档”选择文件。',
  STYLE_SOURCE_TOO_LARGE: '网页正文过长，未将截断内容当作完整样文；请粘贴有代表性的正文。',
  STYLE_SOURCE_FAILED: '网页读取未完成，可能是网络或网站访问限制。请稍后重试，或复制正文粘贴到样文中。',
  STYLE_PROFILE_NOT_FOUND: '风格已被删除或变化，请刷新风格库。',
  STYLE_VERSION_CONFLICT: '风格已被其他操作修改，请重新打开最新版本后编辑；当前文章的风格快照不受影响。',
  STYLE_LIBRARY_FULL: '风格库已达 50 项，请先移除不再需要的风格。',
  STYLE_LIBRARY_BUSY: '风格任务正在处理，请等待完成或先取消。',
  STYLE_ANALYSIS_TIMEOUT: '模型未在 120 秒内完成风格任务，本次已停止。样文仍保留，可以稍后重试。',
  STYLE_ANALYSIS_CANCELLED: '风格任务已取消，未保存新的结果。',
  STYLE_MODEL_RESPONSE_INVALID: '模型未返回可读取的风格描述（内容为空或格式损坏）。样文已保留，请重试提取；这不是样文风格不合格。',
  STYLE_PREVIEW_RESPONSE_INVALID: '模型试写格式不完整，可稍后重试；已保存的风格不变。',
  STYLE_MODEL_INCOMPLETE: '模型连接结束但未完成输出，请稍后重试；样文仍保留。',
  STYLE_MODEL_OUTPUT_TRUNCATED: '模型输出被截断，本次未保存；请稍后重试或减少样文。',
  STYLE_MODEL_OUTPUT_TOO_LARGE: '模型输出超出本次范围，已停止且未保存；可稍后重试。',
  STYLE_MODEL_FAILED: '模型请求未成功完成，请检查模型连接后重试；样文仍保留。',
  TRACE_SCOPE_MISMATCH: '记录不属于当前对话，请返回当前对话重新选择。',
  TRACE_SELECTION_INVALID: '记录选择无效，请重新选择执行步骤。',
  TRACE_STEP_NOT_FOUND: '未找到这一步的持久记录，可能尚未保存。',
  ...WORKFLOW_COMMAND_MESSAGES,
  SEARCH_API_KEY_REQUIRED: '启用需要 Key 的搜索服务前，请填写该服务独立的 API Key。',
  SEARCH_SETTINGS_INVALID: '搜索配置格式无效，请检查后重新保存。',
  SEARCH_SETTINGS_BUSY: '正在保存或验证搜索配置，请稍后重试。',
  SEARCH_SETTINGS_SAVE_FAILED: '搜索设置未能保存，已保留旧配置与凭据，请稍后重试。',
  SEARCH_SETTINGS_ROLLBACK_FAILED: '搜索设置保存失败，部分凭据未能恢复；未确认可用，请重新配置对应 Key 并验证连接。',
  PROVIDER_API_KEY_REQUIRED: '请填写此供应商的 API Key；同一地址的已有配置可以留空沿用。',
  PROVIDER_PROFILE_NOT_FOUND: '这项模型配置已变化，请重新打开模型设置。',
  PROVIDER_SETTINGS_BUSY: '正在保存模型配置，请稍后重试。',
  PROVIDER_CATALOG_UNAVAILABLE: '暂时无法获取模型目录，可以直接填写服务商提供的模型 ID。',
  EMPTY_MESSAGE: '未收到要发送的内容，请输入内容后再发送。',
  FACT_GATE_NOT_PASSED: '当前版本尚未通过事实核查，请先处理核查问题再导出。',
  EXPORT_SELECTION_CHANGED: '稿件或项目已变化，请查看当前版本后重新导出。',
  EXPORT_WRITING_ACTIVE: '文章仍在处理中，请等待处理结束后再导出。',
  EXPORT_ALREADY_SAVING: '已有保存窗口打开，请先完成或取消上一次保存。',
  EXPORT_DESTINATION_INVALID: '请使用对应的 HTML 或 TXT 扩展名，并选择工作区之外的保存位置。',
  EXPORT_SAVE_FAILED: '文章未保存成功，请检查目录权限和可用空间后重试。',
  EXPORT_RECEIPT_NOT_FOUND: '未找到刚才保存的文件，可能已被移动或删除，请重新导出。',
  INTAKE_PROPOSAL_CONFLICT: "The writing proposal changed; review the current proposal before confirming",
  UNKNOWN_OUTCOME_REQUIRES_CONFIRMATION: "Confirm retrying the unknown model outcome before continuing",
  MESSAGE_TOO_LONG: "The message must not exceed 20,000 characters",
  MODEL_CONFIGURATION_REQUIRED: "Configure a model before starting a conversation",
  ACTIVE_RUNS_PRESENT: "Stop active writing runs before changing the model provider",
  BRIEF_CONFIRMATION_REQUIRED: "The writing brief must be confirmed before writing",
  BRIEF_NOT_FOUND: "The current writing brief is unavailable",
  BRIEF_VERSION_CONFLICT: "The writing brief changed; refresh before writing",
  DESKTOP_HOST_CLOSED: "Desktop host is closed",
  DESKTOP_PROVIDER_INPUT_INVALID: "Desktop provider configuration is invalid",
  DESKTOP_PROVIDER_PROFILE_INVALID: "Desktop provider profile is invalid",
  INSECURE_PROVIDER_URL_REJECTED: "Provider URL must use HTTPS",
  LOCK_CONFLICT: "The requested content is locked",
  MODEL_PROVIDER_REQUIRED: "A model provider must be configured before writing",
  MODEL_TOOLS_UNVERIFIED: "The selected model is not verified for tool calling",
  PROJECT_NOT_FOUND: "The selected project is unavailable",
  PROJECT_REVISION_CONFLICT: "The project changed; refresh before writing",
  PROJECT_SELECTION_REQUIRED: "A project must be selected before writing",
  PROVIDER_URL_INVALID: "Provider URL is invalid",
  REVISION_BUDGET_EXCEEDS_PLAN: "The revision budget exceeds the writing plan",
  REVISION_CONFLICT: "The project changed; refresh before saving",
  RUN_ALREADY_ACTIVE: "A writing run is already active",
  USER_INSTRUCTION_TOO_LARGE: "The writing instruction is too large",
  WRITING_BRIEF_REQUIRED: "A writing brief is required before writing",
  WRITING_INPUT_ANSWER_REQUIRED: "Answer the pending writing questions before continuing",
  CHECKPOINT_FEEDBACK_TOO_LONG: "Writing feedback must not exceed 4,000 characters",
  CHECKPOINT_FEEDBACK_NOT_ALLOWED: '当前不是可反馈的共创节点，请刷新后查看最新进度。',
  DIAGNOSTIC_CONFIRMATION_MISMATCH: "The diagnostic preview no longer matches; preview it again",
  DIAGNOSTIC_FILE_NAME_INVALID: "The diagnostic file name is invalid",
  DIAGNOSTIC_PREPARATION_REQUIRED: "Preview the diagnostic bundle before exporting it",
  DIAGNOSTIC_TARGET_EXISTS: "The selected diagnostic file already exists",
  DIAGNOSTIC_WRITE_FAILED: "The diagnostic bundle could not be written",
  LEGACY_DATABASE_CORRUPT: "The selected legacy database is damaged",
  LEGACY_DATABASE_NOT_FOUND: "The selected legacy database does not exist",
  LEGACY_MANIFEST_INVALID: "The selected legacy manifest is invalid",
  LEGACY_PROJECT_MANIFEST_NOT_FOUND: "A legacy project manifest is missing",
  LEGACY_PROJECTS_EMPTY: "The selected legacy source contains no projects",
  LEGACY_SCHEMA_INVALID: "The selected legacy database structure is incomplete",
  LEGACY_SCHEMA_UNSUPPORTED: "The selected legacy database version is unsupported",
  LEGACY_SOURCE_INVALID: "The selected legacy source is not a supported directory",
  LEGACY_SOURCE_NOT_FOUND: "The selected legacy source does not exist",
  LEGACY_TEXT_INVALID: "A legacy text file is not valid UTF-8",
  MIGRATION_CONFIRMATION_MISMATCH: "The migration preview no longer matches; scan it again",
  MIGRATION_PLAN_STALE: "The legacy source changed after scanning; scan it again",
  TARGET_INSIDE_SOURCE: "The current workspace cannot be inside the legacy source",
  TARGET_NOT_WRITABLE: "The current workspace is not writable",
  TARGET_SPACE_INSUFFICIENT: "There is not enough free space for this migration",
  BACKUP_DESTINATION_EXISTS: "The selected backup file already exists",
  BACKUP_TARGET_IS_LIVE_DATABASE: "The live workspace database cannot be used as its own backup",
  BACKUP_VERIFICATION_FAILED: "The workspace backup failed integrity verification",
  DATABASE_NOT_FOUND: "The selected workspace backup does not exist",
  UNRECOGNIZED_DATABASE: "The selected file is not a recognized Writing Agent workspace backup",
  SCHEMA_UNSUPPORTED: "The selected workspace backup uses an unsupported schema version",
  RESTORE_CONFIRMATION_MISMATCH: "Type the required confirmation text before restoring the workspace",
  RESTORE_CONFIRMATION_STALE: "The selected workspace backup changed; choose and inspect it again",
  RESTORE_SOURCE_IS_TARGET: "The live workspace database cannot be restored from itself",
  RESTORE_TARGET_MISSING: "The live workspace database is unavailable",
  RESTORE_VERIFICATION_FAILED: "The restored workspace failed integrity verification",
  PROJECT_DELETE_CONFIRMATION_MISMATCH: "The project name confirmation does not match",
  PROJECT_DELETE_RUN_ACTIVE: "Stop the selected project's active task before deleting it",
  STORAGE_WRITE_FAILED: "The workspace change was rolled back",
  STORAGE_READ_ONLY: "The workspace is read-only",
};

export function safeDesktopFailure(error: unknown): DesktopRpcResponse {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.message)
      ? error.message
      : null;
  const code = typeof candidate === "string" && Object.hasOwn(publicMessages, candidate)
    ? candidate
    : typeof candidate === 'string' && candidate.startsWith('STYLE_MODEL_') ? 'STYLE_MODEL_FAILED'
    : "DESKTOP_COMMAND_FAILED";
  return rpcError(code, publicMessages[code] ?? "Desktop command failed");
}

export async function dispatchDesktopRpc(
  bridge: ClientBridge,
  request: DesktopRpcRequest,
): Promise<DesktopRpcResponse> {
  if (request.protocolVersion !== UI_BRIDGE_PROTOCOL_VERSION) {
    return rpcError(
      "PROTOCOL_VERSION_MISMATCH",
      "Desktop client and runtime protocol versions are incompatible",
    );
  }
  if (!Array.isArray(request.args)) {
    return rpcError("DESKTOP_REQUEST_INVALID", "Desktop request arguments are invalid");
  }
  try {
    let result: unknown;
    switch (request.method) {
      case "handshake":
        result = await bridge.handshake();
        break;
      case "getSnapshot":
        result = bridge.getSnapshot();
        break;
      case "getRunTraceDetail":
        // Read-only inspection never resends the entire conversation snapshot.
        return { ok: true, result: await bridge.getRunTraceDetail(...request.args as Parameters<ClientBridge['getRunTraceDetail']>) };
      case "selectProject":
        result = await bridge.selectProject(...request.args as [string]);
        break;
      case "selectSession":
        result = await bridge.selectSession(...request.args as [string, string]);
        break;
      case "updateSettings":
        result = await bridge.updateSettings(...request.args as Parameters<ClientBridge["updateSettings"]>);
        break;
      case "createProject":
        result = await bridge.createProject(...request.args as Parameters<ClientBridge["createProject"]>);
        break;
      case "renameProject":
        if (bridge.renameProject === undefined) throw new Error("PROJECT_RENAME_UNSUPPORTED");
        result = await bridge.renameProject(...request.args as [string, string, { operationId?: string }?]);
        break;
      case "updateBrief":
        result = await bridge.updateBrief(...request.args as Parameters<ClientBridge["updateBrief"]>);
        break;
      case "confirmBrief":
        result = await bridge.confirmBrief(...request.args as Parameters<ClientBridge["confirmBrief"]>);
        break;
      case "sendMessage":
        result = await bridge.sendMessage(...request.args as Parameters<ClientBridge["sendMessage"]>);
        break;
      case "startConversation":
        result = await bridge.startConversation(...request.args as Parameters<ClientBridge["startConversation"]>);
        break;
      case "confirmConversation":
        result = await bridge.confirmConversation(...request.args as Parameters<ClientBridge["confirmConversation"]>);
        break;
      case "runFactCheck":
        result = await bridge.runFactCheck(...request.args as Parameters<ClientBridge["runFactCheck"]>);
        break;
      case "cancelRun":
        result = await bridge.cancelRun(...request.args as Parameters<ClientBridge["cancelRun"]>);
        break;
      case "resumeRun":
        result = await bridge.resumeRun(...request.args as Parameters<ClientBridge["resumeRun"]>);
        break;
      case "proposeRevision":
        result = await bridge.proposeRevision(...request.args as Parameters<ClientBridge["proposeRevision"]>);
        break;
      case "acceptRevision":
        result = await bridge.acceptRevision(...request.args as Parameters<ClientBridge["acceptRevision"]>);
        break;
      case "rejectRevision":
        result = await bridge.rejectRevision(...request.args as Parameters<ClientBridge["rejectRevision"]>);
        break;
      case "saveBody":
        result = await bridge.saveBody(...request.args as Parameters<ClientBridge["saveBody"]>);
        break;
      case "setBlockLock":
        result = await bridge.setBlockLock(...request.args as Parameters<ClientBridge["setBlockLock"]>);
        break;
      case "rollbackBody":
        result = await bridge.rollbackBody(...request.args as Parameters<ClientBridge["rollbackBody"]>);
        break;
      case "saveWorkingCopy":
        result = await bridge.saveWorkingCopy(...request.args as Parameters<ClientBridge["saveWorkingCopy"]>);
        break;
      case "exportPublication":
        result = await bridge.exportPublication(...request.args as Parameters<ClientBridge["exportPublication"]>);
        break;
      case "refresh":
        result = await bridge.refresh();
        break;
      default:
        return rpcError("DESKTOP_METHOD_NOT_ALLOWED", "Desktop method is not allowlisted");
    }
    return { ok: true, result: result ?? null, snapshot: bridge.getSnapshot() };
  } catch (error) {
    return safeDesktopFailure(error);
  }
}
