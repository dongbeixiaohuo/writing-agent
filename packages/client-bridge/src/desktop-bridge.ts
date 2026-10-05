import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeCommandOptions,
  type BridgeHandshake,
  type BridgeSnapshot,
  type ClientBridge,
  type CreateProjectInput,
  type DeliveryExportView,
  type ExportPublicationOptions,
  type PublicationLayoutPreset,
  type ResumeRunOptions,
  type RunTraceDetail,
  type RunTraceDetailInput,
  type UiSettings,
} from "./protocol.js";

export type DesktopRpcMethod =
  | 'searchStatus'
  | 'configureSearch'
  | 'testSearchConnection'
  | "handshake"
  | "getSnapshot"
  | "getRunTraceDetail"
  | "selectProject"
  | "selectSession"
  | "updateSettings"
  | "createProject"
  | "renameProject"
  | "updateBrief"
  | "confirmBrief"
  | "sendMessage"
  | "startConversation"
  | "confirmConversation"
  | "runFactCheck"
  | "cancelRun"
  | "resumeRun"
  | "proposeRevision"
  | "acceptRevision"
  | "rejectRevision"
  | "saveBody"
  | "setBlockLock"
  | "rollbackBody"
  | "saveWorkingCopy"
  | "exportPublication"
  | "savePublicationAs"
  | "revealPublication"
  | "revealProviderConfig"
  | "refresh"
  | "providerStatus"
  | "providerDetails"
  | "testProviderConnection"
  | "configureProvider"
  | "selectProvider"
  | "listProviderModels"
  | "previewDiagnostics"
  | "exportDiagnostics"
  | "selectLegacyMigrationSource"
  | "applyLegacyMigration"
  | "backupWorkspace"
  | "selectWorkspaceRestoreBackup"
  | "applyWorkspaceRestore"
  | "deleteProject";

export const DESKTOP_RPC_METHODS = Object.freeze([
  'searchStatus',
  'configureSearch',
  'testSearchConnection',
  "handshake",
  "getSnapshot",
  "getRunTraceDetail",
  "selectProject",
  "selectSession",
  "updateSettings",
  "createProject",
  "renameProject",
  "updateBrief",
  "confirmBrief",
  "sendMessage",
  "startConversation",
  "confirmConversation",
  "runFactCheck",
  "cancelRun",
  "resumeRun",
  "proposeRevision",
  "acceptRevision",
  "rejectRevision",
  "saveBody",
  "setBlockLock",
  "rollbackBody",
  "saveWorkingCopy",
  "exportPublication",
  "savePublicationAs",
  "revealPublication",
  "revealProviderConfig",
  "refresh",
  "providerStatus",
  "providerDetails",
  "testProviderConnection",
  "configureProvider",
  "selectProvider",
  "listProviderModels",
  "previewDiagnostics",
  "exportDiagnostics",
  "selectLegacyMigrationSource",
  "applyLegacyMigration",
  "backupWorkspace",
  "selectWorkspaceRestoreBackup",
  "applyWorkspaceRestore",
  "deleteProject",
] as const satisfies readonly DesktopRpcMethod[]);

export interface DesktopDiagnosticPreviewView {
  readonly createdAt: string;
  readonly includedFiles: readonly string[];
  readonly excludedDataClasses: readonly string[];
  readonly confirmationHash: string;
}

export type DesktopDiagnosticExportResultView =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      readonly fileName: string;
      readonly byteLength: number;
      readonly sha256: string;
    };

export type DesktopLegacySourceKind = "manifest" | "desktop_v0_1";

export interface DesktopLegacyMigrationPlanView {
  readonly planHash: string;
  readonly sourceKind: DesktopLegacySourceKind;
  readonly createdAt: string;
  readonly projects: readonly {
    readonly name: string;
    readonly mode: "quick" | "deep";
    readonly artifactCount: number;
    readonly legacyFactStatus: string;
    readonly migratedFactStatus: "not_checked";
    readonly styleStatus: "not_present" | "legacy_unknown";
  }[];
  readonly credentialDisposition: "excluded_requires_explicit_consent";
  readonly warnings: readonly string[];
  readonly spaceCheck: {
    readonly requiredBytes: number;
    readonly availableBytes: number;
    readonly ok: boolean;
  };
}

export interface DesktopLegacyMigrationResultView {
  readonly status: "completed";
  readonly sourceKind: DesktopLegacySourceKind;
  readonly sourceUnchanged: true;
  readonly projects: readonly {
    readonly projectId: string;
    readonly name: string;
    readonly artifactVersionCount: number;
    readonly factGateStatus: "not_checked";
    readonly styleStatus: "not_present" | "legacy_unknown";
  }[];
}

export type DesktopWorkspaceBackupResultView =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      readonly fileName: string;
      readonly byteLength: number;
      readonly sha256: string;
      readonly schemaVersion: number;
    };

export interface DesktopWorkspaceRestorePreviewView {
  readonly confirmationHash: string;
  readonly confirmationPhrase: "恢复工作区";
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly schemaVersion: number;
  readonly projectCount: number;
}

export interface DesktopWorkspaceRestoreResultView {
  readonly restarting: true;
  readonly restoredProjectCount: number;
  readonly safetyBackupFileName: string;
  readonly safetyBackupSha256: string;
}

export interface DesktopProviderSetupInput {
  readonly profileId?: string | null;
  readonly displayName?: string;
  readonly models?: readonly string[];
  readonly kind: "openai_compatible" | "openai_responses" | "anthropic_compatible";
  readonly providerId: string;
  readonly baseURL: string;
  readonly model: string;
  readonly tools: "supported" | "unsupported";
  readonly usage: "reported" | "unknown";
  readonly apiKey: string;
  readonly persistence: "system" | "session";
}

export interface DesktopSavedProviderView {
  readonly credentialChecked?: boolean;
  readonly profileId: string;
  readonly displayName: string;
  readonly kind: DesktopProviderSetupInput['kind'];
  readonly providerId: string;
  readonly baseURL: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly tools: DesktopProviderSetupInput['tools'];
  readonly usage: DesktopProviderSetupInput['usage'];
  readonly configured: boolean;
  readonly credentialPersistence: DesktopProviderStatusView['credentialPersistence'];
  // Set when a connection test passed for this profile; survives restarts.
  readonly verifiedAt?: string | null;
}

export interface DesktopProviderStatusView {
  readonly credentialChecked?: boolean;
  readonly activeProfileId?: string | null;
  readonly profiles?: readonly DesktopSavedProviderView[];
  readonly configured: boolean;
  readonly kind: "openai_compatible" | "openai_responses" | "anthropic_compatible" | null;
  readonly providerId: string | null;
  readonly baseURL: string | null;
  readonly model: string | null;
  readonly tools: "supported" | "unsupported" | null;
  readonly usage: "reported" | "unknown" | null;
  readonly credentialReference: string | null;
  readonly credentialPersistence: "system" | "session" | "environment" | "missing";
  readonly fallbackReason: "system_unavailable" | "system_write_failed" | null;
  readonly connectionTest: DesktopProviderConnectionResultView | null;
}

export type DesktopProviderConnectionResultView =
  | {
      readonly ok: true;
      readonly provider: string;
      readonly model: string;
      readonly adapterVersion: string;
      readonly streaming: "supported";
      readonly tools: "supported" | "not_tested";
      readonly usage: "reported" | "not_reported";
    }
  | {
      readonly ok: false;
      readonly provider: string;
      readonly model: string;
      readonly adapterVersion: string;
      readonly stage:
        | "authentication"
        | "cancelled"
        | "model"
        | "network"
        | "provider"
        | "stream"
        | "tools";
      readonly errorCode: string;
      readonly retryable: boolean;
      // Sanitized upstream error reason when the provider returned one.
      readonly providerDetail?: string;
    };

export interface DesktopRpcRequest {
  readonly protocolVersion: typeof UI_BRIDGE_PROTOCOL_VERSION;
  readonly method: DesktopRpcMethod;
  readonly args: readonly unknown[];
}

export type DesktopRpcResponse =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly snapshot?: BridgeSnapshot;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface DesktopRendererApi {
  invoke(request: DesktopRpcRequest): Promise<DesktopRpcResponse>;
  subscribe(listener: (snapshot: BridgeSnapshot) => void): () => void;
}

export interface DesktopPublicationSaveInput {
  readonly projectId: string;
  readonly bodyVersionId: string;
  readonly format: 'txt' | 'html';
  readonly layoutPreset: PublicationLayoutPreset;
}

export type DesktopPublicationSaveResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly receiptId: string; readonly savedPath: string; readonly fileName: string };

export interface SearchSettingsInput {
  readonly parallelEnabled: boolean;
  readonly tavilyEnabled: boolean;
  readonly tavilyApiKey?: string;
}
export interface SearchSettingsView {
  readonly parallelEnabled: boolean;
  readonly tavilyEnabled: boolean;
  readonly tavilyKeyConfigured: boolean;
  readonly credentialPersistence: 'system' | 'session' | 'environment' | 'missing';
  readonly verification?: Partial<Record<'parallel' | 'tavily', SearchConnectionView>>;
}
export interface SearchConnectionView {
  readonly status: 'available' | 'failed';
  readonly checkedAt: string;
  readonly elapsedMs: number;
  readonly message: string;
}
export interface DesktopHostConfiguration {
  searchStatus?(): Promise<SearchSettingsView>;
  configureSearch?(input: SearchSettingsInput): Promise<SearchSettingsView>;
  testSearchConnection?(provider: 'parallel' | 'tavily'): Promise<SearchSettingsView>;
  savePublicationAs(input: DesktopPublicationSaveInput): Promise<DesktopPublicationSaveResult>;
  revealPublication(receiptId: string): Promise<void>;
  revealProviderConfig(): Promise<void>;
  providerStatus(mode?: 'summary'): Promise<DesktopProviderStatusView>;
  providerDetails(profileId: string): Promise<DesktopSavedProviderView>;
  configureProvider(input: DesktopProviderSetupInput): Promise<DesktopProviderStatusView>;
  selectProvider(profileId: string, model: string): Promise<DesktopProviderStatusView>;
  listProviderModels(input: DesktopProviderSetupInput): Promise<readonly string[]>;
  testProviderConnection(): Promise<DesktopProviderConnectionResultView>;
  previewDiagnostics(): Promise<DesktopDiagnosticPreviewView>;
  exportDiagnostics(confirmationHash: string): Promise<DesktopDiagnosticExportResultView>;
  selectLegacyMigrationSource(
    kind: DesktopLegacySourceKind,
  ): Promise<DesktopLegacyMigrationPlanView | null>;
  applyLegacyMigration(planHash: string): Promise<DesktopLegacyMigrationResultView>;
  backupWorkspace(): Promise<DesktopWorkspaceBackupResultView>;
  selectWorkspaceRestoreBackup(): Promise<DesktopWorkspaceRestorePreviewView | null>;
  applyWorkspaceRestore(
    confirmationHash: string,
    confirmationPhrase: string,
  ): Promise<DesktopWorkspaceRestoreResultView>;
  deleteProject(
    projectId: string,
    confirmedName: string,
  ): Promise<{ readonly projectId: string; readonly deleted: true }>;
}

export interface DesktopHostApi extends DesktopRendererApi, DesktopHostConfiguration {}

function emptySnapshot(): BridgeSnapshot {
  return {
    revision: 0,
    generation: 0,
    workspaceId: "",
    mode: "application",
    connection: "offline",
    selectedProjectId: "",
    selectedSessionId: "",
    projects: [],
    sessions: [],
    timelineBySession: {},
    runRecords: [],
    materialProcessWorkspace: {
      materials: [],
      evidence: null,
      outline: null,
      reviews: [],
      notice: "连接完成后显示材料与写作过程。",
    },
    previewDocument: { id: null, title: "", version: 0, status: "empty", body: "" },
    revisionWorkspace: {
      bodyVersionId: null,
      projectRevision: 0,
      blocks: [],
      versions: [],
      proposals: [],
    },
    factCheckWorkspace: {
      status: "not_checked",
      snapshot: null,
      assessment: null,
      invalidations: [],
      provenance: [],
      notice: "正在连接桌面运行时",
    },
    deliveryWorkspace: {
      bodyVersionId: null,
      projectRevision: 0,
      gateStatus: "not_checked",
      formalExportEnabled: false,
      exports: [],
      notice: "正在连接桌面运行时",
    },
    settings: {
      theme: "system",
      language: "zh-CN",
      contentFontSize: 14,
      providerLabel: "正在连接",
      credentialReference: null,
    },
    activeRunId: null,
    brief: null,
    recoverableRuns: [],
    lastError: null,
    environmentNotice: "正在连接桌面本地运行时",
    composerHint: "正在连接",
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

export class DesktopClientBridge implements ClientBridge {
  readonly #api: DesktopRendererApi;
  readonly #operationIdFactory: () => string;
  readonly #listeners = new Set<() => void>();
  #snapshot = emptySnapshot();
  #handshake: BridgeHandshake | null = null;
  #hostUnsubscribe: (() => void) | null = null;
  #disposed = false;

  constructor(
    api: DesktopRendererApi,
    operationIdFactory: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.#api = api;
    this.#operationIdFactory = operationIdFactory;
  }

  async handshake(): Promise<BridgeHandshake> {
    this.#ensureLive();
    if (this.#handshake !== null) return this.#handshake;
    const result = record(await this.#invoke("handshake"));
    const handshake = result as unknown as BridgeHandshake;
    if (
      handshake.protocolVersion !== UI_BRIDGE_PROTOCOL_VERSION ||
      handshake.mock ||
      !handshake.persistsUserProjects ||
      typeof handshake.workspaceId !== "string" ||
      handshake.workspaceId.length === 0
    ) {
      throw new Error("PROTOCOL_VERSION_MISMATCH");
    }
    this.#handshake = handshake;
    return handshake;
  }

  getSnapshot = (): BridgeSnapshot => this.#snapshot;

  async getRunTraceDetail(input: RunTraceDetailInput): Promise<RunTraceDetail> {
    return await this.#invoke('getRunTraceDetail', input) as RunTraceDetail;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#ensureLive();
    this.#listeners.add(listener);
    if (this.#hostUnsubscribe === null) {
      this.#hostUnsubscribe = this.#api.subscribe((snapshot) => this.#accept(snapshot));
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#hostUnsubscribe?.();
        this.#hostUnsubscribe = null;
      }
    };
  };

  async selectProject(projectId: string): Promise<void> {
    await this.#invoke("selectProject", projectId);
  }

  async selectSession(projectId: string, sessionId: string): Promise<void> {
    await this.#invoke("selectSession", projectId, sessionId);
  }

  async updateSettings(
    patch: Partial<Pick<UiSettings, "theme" | "contentFontSize">>,
  ): Promise<void> {
    await this.#invoke("updateSettings", patch);
  }

  async createProject(
    input: CreateProjectInput,
    options: BridgeCommandOptions = {},
  ): Promise<{ projectId: string }> {
    const result = record(await this.#invoke(
      "createProject",
      input,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (typeof result.projectId !== "string") {
      throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    }
    return { projectId: result.projectId };
  }

  async renameProject(
    projectId: string,
    name: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#invoke(
      "renameProject",
      projectId,
      name,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    );
  }

  async confirmBrief(options: BridgeCommandOptions = {}): Promise<void> {
    await this.#invoke(
      "confirmBrief",
      { operationId: options.operationId ?? this.#operationIdFactory() },
    );
  }

  async updateBrief(
    input: Parameters<ClientBridge["updateBrief"]>[0],
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#invoke(
      "updateBrief",
      input,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    );
  }

  async startConversation(text: string, options: BridgeCommandOptions = {}): Promise<{ runId: string }> {
    const result = record(await this.#invoke("startConversation", text, {
      operationId: options.operationId ?? this.#operationIdFactory(),
    }));
    if (typeof result.runId !== "string") throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    return { runId: result.runId };
  }

  async confirmConversation(proposalVersionId: string, options: BridgeCommandOptions = {}): Promise<{ runId: string }> {
    const result = record(await this.#invoke("confirmConversation", proposalVersionId, {
      operationId: options.operationId ?? this.#operationIdFactory(),
    }));
    if (typeof result.runId !== "string") throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    return { runId: result.runId };
  }

  async sendMessage(
    text: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ runId: string }> {
    const result = record(await this.#invoke(
      "sendMessage",
      text,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (typeof result.runId !== "string") {
      throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    }
    return { runId: result.runId };
  }

  async runFactCheck(
    options: BridgeCommandOptions = {},
  ): Promise<{ runId: string }> {
    const result = record(await this.#invoke(
      "runFactCheck",
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (typeof result.runId !== "string") {
      throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    }
    return { runId: result.runId };
  }

  async cancelRun(runId: string, options: BridgeCommandOptions = {}): Promise<void> {
    await this.#invoke(
      "cancelRun",
      runId,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    );
  }

  async resumeRun(
    runId: string,
    decision: "resume" | "retry_unknown",
    options: ResumeRunOptions = {},
  ): Promise<void> {
    await this.#invoke(
      "resumeRun",
      runId,
      decision,
      { operationId: options.operationId ?? this.#operationIdFactory(),
        ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
        ...(options.checkpointApproval === undefined ? {} : { checkpointApproval: options.checkpointApproval }) },
    );
  }

  async proposeRevision(
    input: Parameters<ClientBridge["proposeRevision"]>[0],
    options: BridgeCommandOptions = {},
  ): Promise<{ proposalId: string }> {
    const result = record(await this.#invoke(
      "proposeRevision",
      input,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (typeof result.proposalId !== "string") throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    return { proposalId: result.proposalId };
  }

  async acceptRevision(
    proposalId: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string; status: "created" | "no_change" }> {
    const result = record(await this.#invoke(
      "acceptRevision",
      proposalId,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (
      typeof result.versionId !== "string" ||
      (result.status !== "created" && result.status !== "no_change")
    ) throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    return result as { versionId: string; status: "created" | "no_change" };
  }

  async rejectRevision(
    proposalId: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#invoke(
      "rejectRevision",
      proposalId,
      reason,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    );
  }

  async saveBody(
    baseBodyVersionId: string,
    content: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string; status: "created" | "no_change" }> {
    const result = record(await this.#invoke(
      "saveBody",
      baseBodyVersionId,
      content,
      reason,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (
      typeof result.versionId !== "string" ||
      (result.status !== "created" && result.status !== "no_change")
    ) throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    return result as { versionId: string; status: "created" | "no_change" };
  }

  async setBlockLock(
    baseBodyVersionId: string,
    blockId: string,
    blockHash: string,
    action: "lock" | "unlock",
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#invoke(
      "setBlockLock",
      baseBodyVersionId,
      blockId,
      blockHash,
      action,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    );
  }

  async rollbackBody(
    targetVersionId: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string }> {
    const result = record(await this.#invoke(
      "rollbackBody",
      targetVersionId,
      reason,
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ));
    if (typeof result.versionId !== "string") throw new Error("DESKTOP_BRIDGE_RESPONSE_INVALID");
    return { versionId: result.versionId };
  }

  async saveWorkingCopy(options: BridgeCommandOptions = {}): Promise<DeliveryExportView> {
    return await this.#invoke(
      "saveWorkingCopy",
      { operationId: options.operationId ?? this.#operationIdFactory() },
    ) as DeliveryExportView;
  }

  async exportPublication(
    format: "txt" | "html",
    options: ExportPublicationOptions = {},
  ): Promise<DeliveryExportView> {
    return await this.#invoke(
      "exportPublication",
      format,
      {
        operationId: options.operationId ?? this.#operationIdFactory(),
        layoutPreset: options.layoutPreset ?? "clean",
      },
    ) as DeliveryExportView;
  }

  async refresh(): Promise<void> {
    await this.#invoke("refresh");
  }

  dispose(): void {
    this.#disposed = true;
    this.#hostUnsubscribe?.();
    this.#hostUnsubscribe = null;
    this.#listeners.clear();
  }

  async #invoke(method: DesktopRpcMethod, ...args: readonly unknown[]): Promise<unknown> {
    this.#ensureLive();
    const response = await this.#api.invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method,
      args,
    });
    if (!response.ok) {
      const error = new Error(response.error.message) as Error & { code: string };
      error.code = response.error.code;
      throw error;
    }
    if (response.snapshot) this.#accept(response.snapshot);
    return response.result;
  }

  #accept(next: BridgeSnapshot): void {
    const workspaceId = this.#handshake?.workspaceId ?? this.#snapshot.workspaceId;
    if (workspaceId.length > 0 && next.workspaceId !== workspaceId) {
      throw new Error("WORKSPACE_SCOPE_MISMATCH");
    }
    if (next.generation < this.#snapshot.generation) return;
    if (
      next.generation === this.#snapshot.generation &&
      next.revision < this.#snapshot.revision
    ) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #ensureLive(): void {
    if (this.#disposed) throw new Error("BRIDGE_DISPOSED");
  }
}

export function createDesktopClientBridge(api: DesktopRendererApi): ClientBridge {
  return new DesktopClientBridge(api);
}
