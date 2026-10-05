import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeCommandOptions,
  type BridgeHandshake,
  type BridgeSnapshot,
  type ClientBridge,
  type CreateProjectInput,
  type DeliveryExportView,
  type ExportPublicationOptions,
  type RunTraceDetail,
  type RunTraceDetailInput,
  type UiSettings,
} from "./protocol.js";

export interface WebClientBridgeOptions {
  readonly baseUrl: string;
  readonly bootstrapCapability: string;
  readonly fetchImpl?: typeof fetch;
  readonly operationIdFactory?: () => string;
  readonly pollDelayMs?: number;
}

interface ErrorEnvelope {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export class WebBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WebBridgeError";
  }
}

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
    previewDocument: {
      id: null,
      title: "正在连接本地服务",
      version: 0,
      status: "empty",
      body: "正在读取已持久保存的项目状态。",
    },
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
      notice:
        "来源关系仅说明产物如何形成；核查通过表示该输入快照通过既定流程，不承诺事实绝对正确。",
    },
    deliveryWorkspace: {
      bodyVersionId: null,
      projectRevision: 0,
      gateStatus: "not_checked",
      formalExportEnabled: false,
      exports: [],
      notice:
        "工作备份不代表可发布；正式 TXT/HTML 仅在当前正文、标题、证据与核查快照一致时生成。",
    },
    settings: {
      theme: "system",
      language: "zh-CN",
      contentFontSize: 14,
      providerLabel: "本地服务连接中",
      credentialReference: null,
    },
    activeRunId: null,
    brief: null,
    recoverableRuns: [],
    lastError: null,
    environmentNotice: "正在连接受保护的本地服务",
    composerHint: "连接完成后可提交写作指令",
  };
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebBridgeError(
      "INVALID_HOST_RESPONSE",
      "Local runtime returned an invalid response",
      502,
    );
  }
  return value as Record<string, unknown>;
}

function responseSnapshot(value: unknown): BridgeSnapshot {
  const record = responseRecord(value);
  if (
    typeof record.revision !== "number" ||
    typeof record.generation !== "number" ||
    typeof record.workspaceId !== "string" ||
    record.mode !== "application" ||
    !Array.isArray(record.projects) ||
    !Array.isArray(record.sessions)
  ) {
    throw new WebBridgeError(
      "INVALID_HOST_SNAPSHOT",
      "Local runtime snapshot does not match the client protocol",
      502,
    );
  }
  return record as unknown as BridgeSnapshot;
}

function responseDeliveryExport(value: unknown): DeliveryExportView {
  const record = responseRecord(value);
  if (
    typeof record.id !== "string" ||
    typeof record.operationId !== "string" ||
    (record.mode !== "working_copy" && record.mode !== "publication") ||
    (record.format !== "markdown" && record.format !== "txt" && record.format !== "html") ||
    (record.state !== "prepared" && record.state !== "completed") ||
    typeof record.relativePath !== "string" ||
    typeof record.contentHash !== "string"
  ) {
    throw new WebBridgeError(
      "INVALID_HOST_RESPONSE",
      "Local runtime returned an invalid export record",
      502,
    );
  }
  return record as unknown as DeliveryExportView;
}

export class WebClientBridge implements ClientBridge {
  readonly #baseUrl: string;
  readonly #bootstrapCapability: string;
  readonly #fetch: typeof fetch;
  readonly #operationIdFactory: () => string;
  readonly #pollDelayMs: number;
  readonly #listeners = new Set<() => void>();
  #snapshot = emptySnapshot();
  #capability: string | null = null;
  #handshake: BridgeHandshake | null = null;
  #handshakePromise: Promise<BridgeHandshake> | null = null;
  #polling = false;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(options: WebClientBridgeOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("LOCAL_WEB_ORIGIN_REQUIRED");
    }
    this.#baseUrl = url.origin;
    this.#bootstrapCapability = options.bootstrapCapability;
    if (this.#bootstrapCapability.length < 32) {
      throw new Error("BOOTSTRAP_CAPABILITY_REQUIRED");
    }
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#operationIdFactory =
      options.operationIdFactory ?? (() => globalThis.crypto.randomUUID());
    this.#pollDelayMs = options.pollDelayMs ?? 25;
  }

  async handshake(): Promise<BridgeHandshake> {
    this.#ensureLive();
    if (this.#handshake !== null) return this.#handshake;
    if (this.#handshakePromise !== null) return this.#handshakePromise;
    this.#handshakePromise = (async () => {
      const response = await this.#request(
        "/api/v6/handshake",
        { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION },
        this.#bootstrapCapability,
      );
      const handshake = responseRecord(response.handshake) as unknown as BridgeHandshake;
      if (
        handshake.protocolVersion !== UI_BRIDGE_PROTOCOL_VERSION ||
        handshake.mock ||
        !handshake.persistsUserProjects ||
        typeof handshake.workspaceId !== "string"
      ) {
        throw new WebBridgeError(
          "PROTOCOL_VERSION_MISMATCH",
          "Local runtime handshake is incompatible with this client",
          409,
        );
      }
      if (typeof response.capability !== "string" || response.capability.length < 32) {
        throw new WebBridgeError(
          "INVALID_HOST_RESPONSE",
          "Local runtime did not issue a session capability",
          502,
        );
      }
      this.#capability = response.capability;
      this.#handshake = handshake;
      const snapshotResponse = await this.#request(
        "/api/v6/snapshot",
        {},
        this.#capability,
      );
      this.#accept(responseSnapshot(snapshotResponse.snapshot));
      return handshake;
    })();
    try {
      return await this.#handshakePromise;
    } finally {
      this.#handshakePromise = null;
    }
  }

  getSnapshot = (): BridgeSnapshot => this.#snapshot;

  async getRunTraceDetail(input: RunTraceDetailInput): Promise<RunTraceDetail> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest('/api/v6/trace/detail', { ...input, generation: this.#snapshot.generation });
    return response.result as RunTraceDetail;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    this.#schedulePoll(0);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#pollTimer !== null) {
        clearTimeout(this.#pollTimer);
        this.#pollTimer = null;
      }
    };
  };

  async selectProject(projectId: string): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(
      "/api/v6/command/select-project",
      {
        generation: this.#snapshot.generation,
        projectId,
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
  }

  async selectSession(projectId: string, sessionId: string): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(
      "/api/v6/command/select-session",
      {
        generation: this.#snapshot.generation,
        projectId,
        sessionId,
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
  }

  async updateSettings(
    patch: Partial<Pick<UiSettings, "theme" | "contentFontSize">>,
  ): Promise<void> {
    this.#ensureLive();
    const contentFontSize =
      patch.contentFontSize ?? this.#snapshot.settings.contentFontSize;
    const theme = patch.theme ?? this.#snapshot.settings.theme;
    if (![13, 14, 16].includes(contentFontSize)) {
      throw new Error("CONTENT_FONT_SIZE_INVALID");
    }
    if (!(["light", "dark", "system"] as const).includes(theme)) {
      throw new Error("THEME_INVALID");
    }
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/update-settings", {
      generation: this.#snapshot.generation,
      theme,
      contentFontSize,
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async createProject(
    input: CreateProjectInput,
    options: BridgeCommandOptions = {},
  ): Promise<{ projectId: string }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/create-project", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      ...input,
    });
    this.#accept(responseSnapshot(response.snapshot));
    const result = responseRecord(response.result);
    if (typeof result.projectId !== "string") {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime did not return a project ID",
        502,
      );
    }
    return { projectId: result.projectId };
  }

  async renameProject(
    projectId: string,
    name: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/rename-project", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      projectId,
      name,
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async confirmBrief(options: BridgeCommandOptions = {}): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/confirm-brief", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async updateBrief(
    input: Parameters<ClientBridge["updateBrief"]>[0],
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/update-brief", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      ...input,
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async startConversation(text: string, options: BridgeCommandOptions = {}): Promise<{ runId: string }> {
    return this.#conversationCommand("start-conversation", { text }, options);
  }

  async confirmConversation(proposalVersionId: string, options: BridgeCommandOptions = {}): Promise<{ runId: string }> {
    return this.#conversationCommand("confirm-conversation", { proposalVersionId }, options);
  }

  async #conversationCommand(route: string, payload: Record<string, string>, options: BridgeCommandOptions): Promise<{ runId: string }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(`/api/v6/command/${route}`, {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      ...payload,
    });
    this.#accept(responseSnapshot(response.snapshot));
    const result = responseRecord(response.result);
    if (typeof result.runId !== "string") throw new WebBridgeError("INVALID_HOST_RESPONSE", "Local runtime did not return a run ID", 502);
    return { runId: result.runId };
  }

  async sendMessage(
    text: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ runId: string }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/start-run", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      text,
    });
    this.#accept(responseSnapshot(response.snapshot));
    const result = responseRecord(response.result);
    if (typeof result.runId !== "string") {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime did not return a run ID",
        502,
      );
    }
    return { runId: result.runId };
  }

  async runFactCheck(
    options: BridgeCommandOptions = {},
  ): Promise<{ runId: string }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/run-fact-check", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
    });
    this.#accept(responseSnapshot(response.snapshot));
    const result = responseRecord(response.result);
    if (typeof result.runId !== "string") {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime did not return a run ID",
        502,
      );
    }
    return { runId: result.runId };
  }

  async cancelRun(
    runId: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/cancel-run", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      runId,
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async resumeRun(
    runId: string,
    decision: "resume" | "retry_unknown",
    options: Parameters<ClientBridge["resumeRun"]>[2] = {},
  ): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/resume-run", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      runId,
      decision,
      ...(options.feedback === undefined ? {} : { feedback: options.feedback }),
      ...(options.checkpointApproval === undefined ? {} : { checkpointApproval: options.checkpointApproval }),
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async proposeRevision(
    input: Parameters<ClientBridge["proposeRevision"]>[0],
    options: BridgeCommandOptions = {},
  ): Promise<{ proposalId: string }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(
      "/api/v6/command/propose-revision",
      {
        generation: this.#snapshot.generation,
        operationId: options.operationId ?? this.#operationIdFactory(),
        ...input,
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
    const result = responseRecord(response.result);
    if (typeof result.proposalId !== "string") {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime did not return a proposal ID",
        502,
      );
    }
    return { proposalId: result.proposalId };
  }

  async acceptRevision(
    proposalId: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string; status: "created" | "no_change" }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(
      "/api/v6/command/accept-revision",
      {
        generation: this.#snapshot.generation,
        operationId: options.operationId ?? this.#operationIdFactory(),
        proposalId,
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
    return this.#versionResult(response.result);
  }

  async rejectRevision(
    proposalId: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(
      "/api/v6/command/reject-revision",
      {
        generation: this.#snapshot.generation,
        operationId: options.operationId ?? this.#operationIdFactory(),
        proposalId,
        reason,
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
  }

  async saveBody(
    baseBodyVersionId: string,
    content: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string; status: "created" | "no_change" }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/save-body", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      baseBodyVersionId,
      content,
      reason,
    });
    this.#accept(responseSnapshot(response.snapshot));
    return this.#versionResult(response.result);
  }

  async setBlockLock(
    baseBodyVersionId: string,
    blockId: string,
    blockHash: string,
    action: "lock" | "unlock",
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/block-lock", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      baseBodyVersionId,
      blockId,
      blockHash,
      action,
    });
    this.#accept(responseSnapshot(response.snapshot));
  }

  async rollbackBody(
    targetVersionId: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string }> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/command/rollback-body", {
      generation: this.#snapshot.generation,
      operationId: options.operationId ?? this.#operationIdFactory(),
      targetVersionId,
      reason,
    });
    this.#accept(responseSnapshot(response.snapshot));
    const result = responseRecord(response.result);
    if (typeof result.versionId !== "string") {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime did not return a body version ID",
        502,
      );
    }
    return { versionId: result.versionId };
  }

  async saveWorkingCopy(
    options: BridgeCommandOptions = {},
  ): Promise<DeliveryExportView> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest(
      "/api/v6/command/save-working-copy",
      {
        generation: this.#snapshot.generation,
        operationId: options.operationId ?? this.#operationIdFactory(),
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
    return responseDeliveryExport(response.result);
  }

  async exportPublication(
    format: "txt" | "html",
    options: ExportPublicationOptions = {},
  ): Promise<DeliveryExportView> {
    await this.#ensureHandshake();
    if (format !== "txt" && format !== "html") {
      throw new Error("EXPORT_FORMAT_INVALID");
    }
    const response = await this.#sessionRequest(
      "/api/v6/command/export-publication",
      {
        generation: this.#snapshot.generation,
        operationId: options.operationId ?? this.#operationIdFactory(),
        format,
        layoutPreset: options.layoutPreset ?? "clean",
      },
    );
    this.#accept(responseSnapshot(response.snapshot));
    return responseDeliveryExport(response.result);
  }

  async refresh(): Promise<void> {
    await this.#ensureHandshake();
    const response = await this.#sessionRequest("/api/v6/snapshot", {});
    this.#accept(responseSnapshot(response.snapshot));
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer !== null) clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
    this.#listeners.clear();
    this.#capability = null;
  }

  async #ensureHandshake(): Promise<void> {
    this.#ensureLive();
    if (this.#handshake === null) await this.handshake();
  }

  #ensureLive(): void {
    if (this.#disposed) throw new Error("BRIDGE_DISPOSED");
  }

  #accept(next: BridgeSnapshot): void {
    if (
      this.#handshake !== null &&
      next.workspaceId !== this.#handshake.workspaceId
    ) {
      throw new WebBridgeError(
        "WORKSPACE_SCOPE_MISMATCH",
        "Local runtime returned another workspace",
        409,
      );
    }
    if (next.generation < this.#snapshot.generation) return;
    if (
      next.generation === this.#snapshot.generation &&
      next.revision < this.#snapshot.revision
    ) {
      return;
    }
    this.#snapshot = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }

  #schedulePoll(delay: number): void {
    if (
      this.#disposed ||
      this.#listeners.size === 0 ||
      this.#pollTimer !== null ||
      this.#polling
    ) {
      return;
    }
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = null;
      void this.#poll();
    }, delay);
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#disposed || this.#listeners.size === 0) return;
    this.#polling = true;
    try {
      await this.#ensureHandshake();
      const response = await this.#sessionRequest("/api/v6/events/poll", {
        generation: this.#snapshot.generation,
        afterRevision: this.#snapshot.revision,
      });
      this.#accept(responseSnapshot(response.snapshot));
    } catch (error) {
      if (error instanceof WebBridgeError && error.code === "STALE_CLIENT_GENERATION") {
        try {
          await this.refresh();
        } catch {
          this.#offline(error);
        }
      } else {
        this.#offline(error);
      }
    } finally {
      this.#polling = false;
      this.#schedulePoll(this.#pollDelayMs);
    }
  }

  #versionResult(value: unknown): {
    versionId: string;
    status: "created" | "no_change";
  } {
    const result = responseRecord(value);
    if (
      typeof result.versionId !== "string" ||
      (result.status !== "created" && result.status !== "no_change")
    ) {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime returned an invalid body version result",
        502,
      );
    }
    return { versionId: result.versionId, status: result.status };
  }

  #offline(error: unknown): void {
    const code = error instanceof WebBridgeError ? error.code : "LOCAL_SERVICE_OFFLINE";
    if (
      this.#snapshot.connection === "offline" &&
      this.#snapshot.lastError?.code === code
    ) {
      return;
    }
    this.#snapshot = {
      ...this.#snapshot,
      connection: "offline",
      lastError: {
        code,
        message:
          error instanceof Error
            ? error.message
            : "Local Writing Agent service is unavailable",
      },
    };
    this.#emit();
  }

  async #sessionRequest(
    route: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    if (this.#capability === null) {
      throw new WebBridgeError(
        "CAPABILITY_MISSING",
        "Local session capability is unavailable",
        401,
      );
    }
    return this.#request(route, body, this.#capability);
  }

  async #request(
    route: string,
    body: Readonly<Record<string, unknown>>,
    capability: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-writing-agent-protocol": String(UI_BRIDGE_PROTOCOL_VERSION),
          "x-writing-agent-capability": capability,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "same-origin",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new WebBridgeError(
        "LOCAL_SERVICE_OFFLINE",
        "Local Writing Agent service is unavailable",
        0,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new WebBridgeError(
        "INVALID_HOST_RESPONSE",
        "Local runtime returned non-JSON data",
        response.status,
      );
    }
    if (!response.ok) {
      const envelope = payload as ErrorEnvelope;
      const code =
        typeof envelope.error?.code === "string"
          ? envelope.error.code
          : "LOCAL_BRIDGE_REQUEST_FAILED";
      const message =
        typeof envelope.error?.message === "string"
          ? envelope.error.message
          : "Local bridge request failed";
      throw new WebBridgeError(code, message, response.status);
    }
    return responseRecord(payload);
  }
}

export function createWebClientBridge(
  options: WebClientBridgeOptions,
): ClientBridge {
  return new WebClientBridge(options);
}
