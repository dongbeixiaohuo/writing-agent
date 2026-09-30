import { UI_BRIDGE_PROTOCOL_VERSION, type ClientBridge } from "../../../packages/client-bridge/src/protocol.js";
import type {
  DesktopRpcRequest,
  DesktopRpcResponse,
} from "../../../packages/client-bridge/src/desktop-bridge.js";

function rpcError(code: string, message: string): DesktopRpcResponse {
  return { ok: false, error: { code, message } };
}

const publicMessages: Readonly<Record<string, string>> = {
  SEARCH_API_KEY_REQUIRED: '启用 Tavily 前请填写 API Key。',
  SEARCH_SETTINGS_INVALID: '搜索配置格式无效，请检查后重新保存。',
  SEARCH_SETTINGS_BUSY: '正在保存搜索配置，请稍后重试。',
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
