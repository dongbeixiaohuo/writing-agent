export declare const UI_BRIDGE_PROTOCOL_VERSION = 23;
export type ThemeMode = 'light' | 'dark' | 'system';
export type ConnectionState = 'ready' | 'running' | 'offline';
export type ToolState = 'pending' | 'success' | 'failure' | 'cancelled';
export type BridgeMode = 'application' | 'mock';
export interface BridgeHandshake {
    protocolVersion: number;
    clientBuild: string;
    runtimeBuild: string;
    capabilities: readonly string[];
    mock: boolean;
    persistsUserProjects: boolean;
    workspaceId: string;
}
export interface ProjectSummary {
    id: string;
    name: string;
    sessionIds: readonly string[];
    revision: number;
    latestProjectSeq: number;
}
export interface SessionSummary {
    id: string;
    projectId: string;
    title: string;
    relativeTime: string;
    status: 'idle' | 'running' | 'interrupted' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
}
export interface ChatMessage {
    stage?: WritingWorkflowStageId;
    actorLabel?: string;
    /** Recorded stage activity up to this saved result; excludes author waits. */
    activeDurationMs?: number;
    streaming?: 'generating' | 'saving';
    audience?: 'diagnostic';
    id: string;
    kind: 'message';
    role: 'user' | 'assistant';
    body: string;
    createdAt: string;
}
export interface ToolActivity {
    audience?: 'conversation';
    id: string;
    kind: 'tool';
    label: string;
    detail: string;
    state: ToolState;
}
export type TimelineItem = ChatMessage | ToolActivity;
export type WritingWorkflowStageId = 'research' | 'outline' | 'draft' | 'review_editor' | 'review_publish' | 'review_reader' | 'central_revision' | 'language_review' | 'fact_check';
export interface WorkflowStageView {
    id: WritingWorkflowStageId;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    detail: string;
    /** Recorded model/tool active time, accumulated across resumes; null for legacy missing actor data. */
    activeDurationMs?: number | null;
}
export interface RunRecordView {
    activity?: readonly TimelineItem[];
    diagnostics?: RunDiagnosticsView;
    purpose?: string;
    waitingFor?: 'publication_selection';
    replyPreview?: string;
    id: string;
    status: 'queued' | 'running' | 'waiting_user' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'budget_exhausted' | 'interrupted';
    displayInstruction: string;
    startedAt: string;
    completedAt: string | null;
    stopReason: string | null;
    modelRequests: number;
    maxModelRequests: number;
    toolCalls: number;
    maxToolCalls: number;
    totalTokens: number | null;
    stages: readonly WorkflowStageView[];
    completedStages: number;
    totalStages: number;
    publicationReady: boolean;
}
export type DiagnosticOperationStatus = 'pending' | 'completed' | 'failed' | 'outcome_unknown';
export interface RunDiagnosticModelRequest {
    stream?: {
        headersMs: number | null;
        /** Optional for compatibility with run records written before reasoning activity timing existed. */
        firstReasoningMs?: number | null;
        /** Optional for compatibility with run records written before reasoning activity timing existed. */
        lastReasoningMs?: number | null;
        /** Activity count only; no private reasoning text is persisted. */
        reasoningEvents?: number;
        firstContentMs: number | null;
        lastContentMs: number | null;
        contentEvents: number;
    };
    transport?: {
        phase: 'first_response' | 'stream_idle';
        timeoutMs: number;
        elapsedMs: number;
        firstResponseMs: number | null;
        lastActivityMs: number | null;
    };
    providerHttpStatus?: number;
    id: string;
    status: DiagnosticOperationStatus;
    durationMs: number | null;
    errorCode: string | null;
    usage: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
    } | null;
}
export interface RunDiagnosticToolTarget {
    id: string;
    label: string;
    versionId: string | null;
    count: number;
    completed: number;
    failed: number;
    pending: number;
    outcomeUnknown: number;
    errorCodes: readonly string[];
}
export interface RunDiagnosticToolGroup {
    toolName: string;
    label: string;
    description?: string;
    category?: string;
    callers?: readonly {
        label: string;
        count: number;
    }[];
    outcomes?: readonly {
        label: string;
        count: number;
    }[];
    count: number;
    completed: number;
    failed: number;
    pending: number;
    outcomeUnknown: number;
    errorCodes: readonly string[];
    targets?: readonly RunDiagnosticToolTarget[];
}
export interface RunDiagnosticDecision {
    id: string;
    actor: string | null;
    stage: string | null;
    status: string | null;
    reason: string | null;
}
export interface RunDiagnosticSegment {
    id: string;
    label: string;
    startedAt: string;
    modelRequests: readonly RunDiagnosticModelRequest[];
    toolGroups: readonly RunDiagnosticToolGroup[];
    decisions: readonly RunDiagnosticDecision[];
}
export interface RunDiagnosticTraceStep {
    id: string;
    segmentId: string;
    occurredAt: string;
    completedAt: string | null;
    kind: 'model' | 'tool' | 'agent';
    status: DiagnosticOperationStatus;
    label: string;
    technicalName?: string;
    httpStatus?: number;
    requestId?: string;
    actorLabel?: string;
    durationMs: number | null;
    inputPreview?: string;
    outputPreview?: string;
    errorCode: string | null;
    stream?: RunDiagnosticModelRequest['stream'];
    transport?: RunDiagnosticModelRequest['transport'];
    providerHttpStatus?: number;
}
export interface RunDiagnosticsView {
    segments: readonly RunDiagnosticSegment[];
    /** Optional so older mock/browser snapshots remain readable. */
    trace?: readonly RunDiagnosticTraceStep[];
}
export interface RunTraceDetailInput {
    projectId: string;
    sessionId: string;
    runId: string;
    stepId: string;
}
export interface RunTraceDetail {
    runId: string;
    stepId: string;
    requestId: string | null;
    callId: string | null;
    provider: string | null;
    model: string | null;
    inputBreakdown?: {
        totalCharacters: number;
        basis: string;
        parts: readonly {
            key: string;
            label: string;
            characters: number;
        }[];
    };
    sections: readonly {
        id: 'input' | 'output' | 'schema';
        label: string;
        format: 'json' | 'text';
        text: string;
        totalCharacters: number;
        truncated: boolean;
    }[];
    notes: readonly string[];
}
export interface MaterialSummaryView {
    id: string;
    displayName: string;
    sourceKind: 'pasted_text' | 'utf8_file' | 'web_snapshot' | 'legacy_import';
    role: 'user_firsthand' | 'source_verified' | 'illustrative';
    trustLabel: 'user_provided_untrusted' | 'external_untrusted' | 'legacy_unknown';
    importedAt: string;
}
export interface WorkflowArtifactView {
    id: string;
    kind: 'evidence' | 'outline' | 'review';
    stage: 'research' | 'outline' | 'review_editor' | 'review_publish' | 'review_reader';
    label: string;
    content: string;
    createdAt: string;
    runId: string | null;
    bodyVersionId: string | null;
}
export interface MaterialProcessWorkspace {
    materials: readonly MaterialSummaryView[];
    evidence: WorkflowArtifactView | null;
    outline: WorkflowArtifactView | null;
    reviews: readonly WorkflowArtifactView[];
    notice: string;
}
export interface PreviewDocument {
    id: string | null;
    title: string;
    version: number;
    status: 'empty' | 'draft' | 'review';
    body: string;
}
export type RevisionEditType = 'replace' | 'delete' | 'insert_before' | 'insert_after';
export interface RevisionEditRequest {
    type: RevisionEditType;
    targetBlockId: string;
    baseBlockHash: string;
    content?: string;
}
export interface BodyBlockView {
    id: string;
    ordinal: number;
    kind: 'heading' | 'paragraph' | 'list' | 'blockquote' | 'code' | 'thematic_break';
    content: string;
    contentHash: string;
    locked: boolean;
}
export interface BodyVersionSummary {
    id: string;
    ordinal: number;
    reason: string;
    actorLabel: string;
    createdAt: string;
    current: boolean;
}
export interface RevisionDiffView {
    type: RevisionEditType;
    targetBlockId: string;
    before: string | null;
    after: string | null;
}
export interface RevisionProposalSummary {
    id: string;
    baseBodyVersionId: string;
    instruction: string;
    status: 'proposed' | 'accepted' | 'rejected' | 'conflicted' | 'withdrawn';
    conflictCode: 'REVISION_CONFLICT' | 'LOCK_CONFLICT' | null;
    diff: readonly RevisionDiffView[];
    createdAt: string;
}
export interface RevisionWorkspace {
    bodyVersionId: string | null;
    projectRevision: number;
    blocks: readonly BodyBlockView[];
    versions: readonly BodyVersionSummary[];
    proposals: readonly RevisionProposalSummary[];
}
export type FactGateViewStatus = 'not_checked' | 'checking' | 'passed' | 'blocked' | 'error' | 'stale';
export interface FactClaimView {
    claimId: string;
    claimText: string;
    location: string;
    status: 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED' | 'BROKEN_LINK' | 'NEEDS_USER_SOURCE';
    risk: 'red' | 'yellow' | 'green';
    supportScope: 'full' | 'partial' | 'none';
    evidenceId: string | null;
    sourceReference: string | null;
    evidenceSummary: string;
    recommendedAction: string;
    checkReason?: 'key_fact' | 'suspected_error';
    verificationMethod?: 'external_source' | 'material_comparison' | 'model_review';
    verificationRecordIds?: readonly string[];
}
export interface FactCheckWorkspace {
    status: FactGateViewStatus;
    snapshot: {
        id: string;
        policyVersion: string;
        bodyVersionId: string;
        bodyHash: string;
        titleVersionId: string;
        titleHash: string;
        distributionCopyHash: string | null;
        evidenceVersionId: string;
        evidenceHash: string;
    } | null;
    assessment: {
        status: 'passed' | 'blocked';
        claimsHash: string;
        reportHash: string;
        blockers: readonly string[];
        claims: readonly FactClaimView[];
    } | null;
    invalidations: readonly {
        reason: 'body_version_changed' | 'title_version_changed' | 'evidence_version_changed';
        changedVersionId: string;
        createdAt: string;
    }[];
    provenance: readonly {
        fromId: string;
        relation: 'DERIVED_FROM' | 'USES_MATERIAL' | 'CHANGED_BY_DECISION' | 'REVIEWED_IN' | 'CHECKED_IN' | 'EXPORTED_AS';
        toId: string;
        evidenceRef: string | null;
    }[];
    notice: string;
}
export type DeliveryExportFormat = 'markdown' | 'txt' | 'html';
export interface DeliveryExportView {
    id: string;
    operationId: string;
    mode: 'working_copy' | 'publication';
    format: DeliveryExportFormat;
    state: 'prepared' | 'completed';
    gateStatus: FactGateViewStatus;
    relativePath: string;
    manifestRelativePath: string | null;
    contentHash: string;
    createdAt: string;
    completedAt: string | null;
}
export interface DeliveryWorkspace {
    bodyVersionId: string | null;
    projectRevision: number;
    gateStatus: FactGateViewStatus;
    formalExportEnabled: boolean;
    exports: readonly DeliveryExportView[];
    notice: string;
}
export interface BriefSummary {
    versionId: string;
    topic: string;
    genre: 'argument_commentary' | 'explanatory_analysis' | 'narrative_observation' | 'practical_experience';
    audience: string;
    targetCharacters: number;
    constraints: readonly string[];
    interactionMode: 'autonomous' | 'co_creation';
    authorVoice: string | null;
    styleReference: string | null;
    styleDecision: 'user_confirmed' | 'user_delegated' | 'unspecified';
    confirmationStatus: 'tentative' | 'confirmed';
    directionDecision: 'user_confirmed' | 'user_delegated' | 'tentative';
    platform: string | null;
    publicationGoal: 'primary' | 'secondary' | 'not_applicable';
    materialCount: number;
}
export interface RecoverableRunSummary {
    checkpointApproval?: CheckpointApproval;
    runId: string;
    sessionId: string;
    status: 'interrupted' | 'waiting_user' | 'budget_exhausted';
    stopReason: string | null;
    checkpointStage: WritingWorkflowStageId | null;
    nextStage: WritingWorkflowStageId | null;
    validationFailure?: {
        code: string;
        tool: string;
        explanation: string;
    };
    interruption?: {
        source: 'model' | 'tool';
        cause: 'timeout' | 'unknown';
        replyAccepted: boolean;
        timeoutPhase?: 'first_response' | 'stream_idle';
        timeoutMs?: number;
    };
    inputRequest?: {
        reason: string;
        questions: readonly string[];
        kind?: 'publication_selection' | 'search_recovery';
        searchRecovery?: {
            requestId: string;
            kind: 'timeout' | 'failure' | 'limit';
            query: string;
            used: number;
            limit: number;
            attemptsUsed: number;
            attemptsLimit: number;
            reason: string;
        };
        candidates?: readonly {
            title: string;
            rationale: string;
            distributionCopy: string | null;
        }[];
    };
}
export interface UiSettings {
    theme: ThemeMode;
    language: 'zh-CN';
    contentFontSize: number;
    providerLabel: string;
    credentialReference: string | null;
}
export interface BridgeSnapshot {
    liveActivity?: {
        runId: string;
        requestId: string;
        actor: string;
        phase: 'waiting' | 'connected' | 'receiving';
        startedAt: number;
        lastActivityAt: number | null;
        segmentStartedAt?: number;
        requestOrdinal?: number;
        workPreview?: {
            label: string;
            text: string;
        };
        lastEventKind?: 'reasoning' | 'content' | 'tool_arguments';
        receivedEvents?: number;
        activeTool?: {
            name: string;
            startedAt: number;
        };
        materials?: readonly {
            id: string;
            label: string;
            text: string;
        }[];
    } | null;
    liveReply?: {
        runId: string;
        requestId: string;
        text: string;
        id?: string;
        stage?: string;
        phase?: 'generating' | 'saving';
    } | null;
    revision: number;
    generation: number;
    workspaceId: string;
    mode: BridgeMode;
    connection: ConnectionState;
    selectedProjectId: string;
    selectedSessionId: string;
    projects: readonly ProjectSummary[];
    sessions: readonly SessionSummary[];
    timelineBySession: Readonly<Record<string, readonly TimelineItem[]>>;
    runRecords: readonly RunRecordView[];
    materialProcessWorkspace: MaterialProcessWorkspace;
    previewDocument: PreviewDocument;
    revisionWorkspace: RevisionWorkspace;
    factCheckWorkspace: FactCheckWorkspace;
    deliveryWorkspace: DeliveryWorkspace;
    settings: UiSettings;
    activeRunId: string | null;
    brief: BriefSummary | null;
    conversationIntake?: {
        phase: 'collecting' | 'proposal' | 'confirmed';
        summary: string;
        proposalVersionId: string | null;
    } | null;
    recoverableRuns: readonly RecoverableRunSummary[];
    lastError: {
        code: string;
        message: string;
    } | null;
    environmentNotice: string;
    composerHint: string;
}
export interface BridgeCommandOptions {
    operationId?: string;
}
export interface ResumeRunOptions extends BridgeCommandOptions {
    factSearchDecision?: {
        requestId: string;
        action: 'retry' | 'extend' | 'continue';
    };
    feedback?: string;
    checkpointApproval?: CheckpointApproval;
}
export interface CheckpointApproval {
    eventSeq: number;
    bodyVersionId: string | null;
    briefVersionId: string | null;
}
export type PublicationLayoutPreset = 'clean' | 'editorial' | 'compact';
export interface ExportPublicationOptions extends BridgeCommandOptions {
    layoutPreset?: PublicationLayoutPreset;
}
export interface CreateProjectMaterialInput {
    name: string;
    content: string;
    role: 'user_firsthand' | 'source_verified' | 'illustrative';
    sourceKind: 'pasted_text' | 'utf8_file' | 'web_snapshot';
    sourceReference: string | null;
}
export interface CreateProjectInput {
    name: string;
    mode: 'quick' | 'deep';
    topic: string;
    genre: 'argument_commentary' | 'explanatory_analysis' | 'narrative_observation' | 'practical_experience';
    audience: string;
    targetCharacters: number;
    constraints: readonly string[];
    interactionMode: 'autonomous' | 'co_creation';
    authorVoice: string | null;
    styleReference: string | null;
    styleDecision: 'user_confirmed' | 'user_delegated' | 'unspecified';
    directionDecision: 'user_confirmed' | 'user_delegated' | 'tentative';
    platform: string | null;
    publicationGoal: 'primary' | 'secondary' | 'not_applicable';
    materials: readonly CreateProjectMaterialInput[];
}
export type UpdateBriefInput = Omit<CreateProjectInput, 'name' | 'mode' | 'materials'>;
export interface ClientBridge {
    handshake(): Promise<BridgeHandshake>;
    getSnapshot(): BridgeSnapshot;
    getRunTraceDetail(input: RunTraceDetailInput): Promise<RunTraceDetail>;
    subscribe(listener: () => void): () => void;
    selectProject(projectId: string): Promise<void>;
    selectSession(projectId: string, sessionId: string): Promise<void>;
    updateSettings(patch: Partial<Pick<UiSettings, 'theme' | 'contentFontSize'>>): Promise<void>;
    createProject(input: CreateProjectInput, options?: BridgeCommandOptions): Promise<{
        projectId: string;
    }>;
    /** Optional only for protocol-22 test doubles; protocol-23 hosts implement it. */
    renameProject?(projectId: string, name: string, options?: BridgeCommandOptions): Promise<void>;
    updateBrief(input: UpdateBriefInput, options?: BridgeCommandOptions): Promise<void>;
    confirmBrief(options?: BridgeCommandOptions): Promise<void>;
    startConversation(text: string, options?: BridgeCommandOptions): Promise<{
        runId: string;
    }>;
    confirmConversation(proposalVersionId: string, options?: BridgeCommandOptions): Promise<{
        runId: string;
    }>;
    sendMessage(text: string, options?: BridgeCommandOptions): Promise<{
        runId: string;
    }>;
    runFactCheck(options?: BridgeCommandOptions): Promise<{
        runId: string;
    }>;
    cancelRun(runId: string, options?: BridgeCommandOptions): Promise<void>;
    resumeRun(runId: string, decision: 'resume' | 'retry_unknown', options?: ResumeRunOptions): Promise<void>;
    proposeRevision(input: {
        baseBodyVersionId: string;
        instruction: string;
        constraints?: readonly string[];
        edits: readonly RevisionEditRequest[];
    }, options?: BridgeCommandOptions): Promise<{
        proposalId: string;
    }>;
    acceptRevision(proposalId: string, options?: BridgeCommandOptions): Promise<{
        versionId: string;
        status: 'created' | 'no_change';
    }>;
    rejectRevision(proposalId: string, reason: string, options?: BridgeCommandOptions): Promise<void>;
    saveBody(baseBodyVersionId: string, content: string, reason: string, options?: BridgeCommandOptions): Promise<{
        versionId: string;
        status: 'created' | 'no_change';
    }>;
    setBlockLock(baseBodyVersionId: string, blockId: string, blockHash: string, action: 'lock' | 'unlock', options?: BridgeCommandOptions): Promise<void>;
    rollbackBody(targetVersionId: string, reason: string, options?: BridgeCommandOptions): Promise<{
        versionId: string;
    }>;
    saveWorkingCopy(options?: BridgeCommandOptions): Promise<DeliveryExportView>;
    exportPublication(format: 'txt' | 'html', options?: ExportPublicationOptions): Promise<DeliveryExportView>;
    refresh(): Promise<void>;
    dispose(): void;
}
