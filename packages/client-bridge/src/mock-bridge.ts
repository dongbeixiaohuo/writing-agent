import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeHandshake,
  type BridgeSnapshot,
  type ClientBridge,
  type RecoverableRunSummary,
  type RunRecordView,
  type TimelineItem,
  type UiSettings,
} from './protocol.ts'

export interface DeterministicMockOptions {
  latencyMs?: number
}

const INITIAL_TIMELINE: readonly TimelineItem[] = [
  {
    id: 'message-user-1',
    kind: 'message',
    role: 'user',
    body: '请基于已授权的采访纪要，为新品发布准备一版 1200 字左右的公众号初稿。',
    createdAt: '09:30',
  },
  {
    id: 'tool-materials-1',
    kind: 'tool',
    label: '读取材料',
    detail: '采访纪要.md · 产品参数表.xlsx',
    state: 'success',
  },
  {
    id: 'tool-brief-1',
    kind: 'tool',
    label: '确认简报',
    detail: '公众号 · 专业克制 · 目标读者：企业 IT 负责人',
    state: 'success',
  },
  {
    id: 'message-assistant-1',
    kind: 'message',
    role: 'assistant',
    body: '初稿已生成并保存为版本 v3。标题与三段式结构沿用确认后的简报；涉及性能提升的数据仍标为待核查，没有写入未经授权的客户案例。',
    createdAt: '09:31',
  },
]

const COCREATION_TIMELINE: readonly TimelineItem[] = [
  {
    id: 'message-cocreation-user',
    kind: 'message',
    role: 'user',
    body: '我想写一篇面向企业 IT 负责人的文章，解释为什么 AI 内容生产必须保留材料来源和修改过程。',
    createdAt: '10:08',
  },
  {
    id: 'tool-cocreation-research',
    kind: 'tool',
    label: '资料研究 · 研究与证据',
    detail: '已读取 2 份授权材料，1 项数据仍需补证',
    state: 'success',
  },
  {
    id: 'tool-cocreation-outline',
    kind: 'tool',
    label: '选题策划 · 文章提纲',
    detail: '提纲已保存，等待你的判断',
    state: 'success',
  },
]

const COCREATION_STAGES: RunRecordView['stages'] = ([
  ['research', '研究与证据'],
  ['outline', '文章提纲'],
  ['draft', '完整初稿'],
  ['review_editor', '编辑审校'],
  ['review_publish', '发布审校'],
  ['review_reader', '读者审校'],
  ['central_revision', '集中修订'],
  ['language_review', '语言终审'],
  ['fact_check', '事实核查'],
] as const).map(([id, label], index) => ({
  id,
  label,
  status: index < 2 ? 'completed' : 'pending',
  detail: index < 2 ? '结果已持久保存' : '等待前序阶段',
}))

const COCREATION_RUN: RunRecordView = {
  id: 'mock-run-cocreation',
  status: 'waiting_user',
  displayInstruction: '建立可信写作流程的公众号文章',
  startedAt: '2026-09-19T10:08:00.000Z',
  completedAt: null,
  stopReason: 'CO_CREATION_CHECKPOINT',
  modelRequests: 4,
  maxModelRequests: 32,
  toolCalls: 4,
  maxToolCalls: 40,
  totalTokens: 1840,
  stages: COCREATION_STAGES,
  completedStages: 2,
  totalStages: COCREATION_STAGES.length,
  publicationReady: false,
}

const COCREATION_RECOVERY: RecoverableRunSummary = {
  runId: COCREATION_RUN.id,
  sessionId: 'session-launch-cocreation',
  status: 'waiting_user',
  stopReason: 'CO_CREATION_CHECKPOINT',
  checkpointStage: 'outline',
  nextStage: 'draft',
}

function initialSnapshot(): BridgeSnapshot {
  return {
    revision: 1,
    generation: 1,
    workspaceId: 'mock-workspace',
    mode: 'mock',
    connection: 'ready',
    selectedProjectId: 'project-launch',
    selectedSessionId: 'session-launch-cocreation',
    projects: [
      { id: 'project-launch', name: '新品发布项目', sessionIds: ['session-launch-cocreation', 'session-launch-draft', 'session-launch-outline'], revision: 3, latestProjectSeq: 8 },
      { id: 'project-case', name: '客户案例专题', sessionIds: ['session-case-interview'], revision: 1, latestProjectSeq: 3 },
    ],
    sessions: [
      { id: 'session-launch-cocreation', projectId: 'project-launch', title: '共创写作', relativeTime: '现在', status: 'waiting_user' },
      { id: 'session-launch-draft', projectId: 'project-launch', title: '公众号初稿', relativeTime: '刚刚', status: 'completed' },
      { id: 'session-launch-outline', projectId: 'project-launch', title: '文章提纲', relativeTime: '昨天', status: 'completed' },
      { id: 'session-case-interview', projectId: 'project-case', title: '访谈材料整理', relativeTime: '3 天', status: 'completed' },
    ],
    timelineBySession: {
      'session-launch-cocreation': COCREATION_TIMELINE,
      'session-launch-draft': INITIAL_TIMELINE,
      'session-launch-outline': [{
        id: 'message-outline-1', kind: 'message', role: 'assistant', createdAt: '昨天',
        body: '## 写作提纲\n\n1. **业务问题**：为什么内容生产需要可追溯\n2. **产品价值**：材料、修改与核查进入同一流程\n3. **落地路径**：从授权材料到可交付稿件\n4. **行动建议**：先建立事实边界，再开始写作',
      }],
      'session-case-interview': [{
        id: 'message-case-1', kind: 'message', role: 'assistant', createdAt: '3 天前',
        body: '访谈材料已建立来源索引；客户名称仍保持匿名。',
      }],
    },
    runRecords: [COCREATION_RUN],
    materialProcessWorkspace: {
      materials: [
        {
          id: 'mock-material-interview',
          displayName: '采访纪要.md',
          sourceKind: 'utf8_file',
          role: 'source_verified',
          trustLabel: 'user_provided_untrusted',
          importedAt: '2026-09-15T08:50:00.000Z',
        },
      ],
      evidence: {
        id: 'evidence-launch-v1',
        kind: 'evidence',
        stage: 'research',
        label: '研究与证据',
        content: '只使用已授权采访纪要；性能提升数据仍缺少可发布来源。',
        createdAt: '2026-09-15T09:05:00.000Z',
        runId: 'mock-run-launch',
        bodyVersionId: null,
      },
      outline: {
        id: 'outline-launch-v1',
        kind: 'outline',
        stage: 'outline',
        label: '文章提纲',
        content: '## 写作提纲\n\n1. **业务问题**：为什么内容生产需要可追溯\n2. **产品价值**：材料、修改与核查进入同一流程\n3. **落地路径**：从授权材料到可交付稿件\n4. **行动建议**：先建立事实边界，再开始写作',
        createdAt: '2026-09-15T09:10:00.000Z',
        runId: 'mock-run-launch',
        bodyVersionId: null,
      },
      reviews: [],
      notice: '演示模式展示隔离样例；正式项目只读取本机持久数据。',
    },
    previewDocument: {
      id: 'artifact-launch-v3',
      title: '让内容生产回到可验证的业务流程',
      version: 3,
      status: 'draft',
      body: '企业内容生产真正困难的部分，不是写出第一段，而是让每个观点都有来源、每次修改都可追踪。\n\nWriting Agent 把材料、简报、生成、核查和版本保存放进同一条工作流，让团队知道内容从哪里来、当前处于什么状态。\n\n此处是隔离的演示数据；正式入口只展示 Application Service 已持久提交的稿件。',
    },
    revisionWorkspace: {
      bodyVersionId: 'artifact-launch-v3',
      projectRevision: 3,
      blocks: [
        {
          id: 'mock-block-1', ordinal: 0, kind: 'paragraph',
          content: '企业内容生产真正困难的部分，不是写出第一段，而是让每个观点都有来源、每次修改都可追踪。',
          contentHash: 'a'.repeat(64), locked: true,
        },
        {
          id: 'mock-block-2', ordinal: 1, kind: 'paragraph',
          content: 'Writing Agent 把材料、简报、生成、核查和版本保存放进同一条工作流，让团队知道内容从哪里来、当前处于什么状态。',
          contentHash: 'b'.repeat(64), locked: false,
        },
        {
          id: 'mock-block-3', ordinal: 2, kind: 'paragraph',
          content: '此处是隔离的演示数据；正式入口只展示 Application Service 已持久提交的稿件。',
          contentHash: 'c'.repeat(64), locked: false,
        },
      ],
      versions: [
        { id: 'artifact-launch-v1', ordinal: 1, reason: '结构初稿', actorLabel: 'Writing Agent', createdAt: '2026-09-15T09:00:00.000Z', current: false },
        { id: 'artifact-launch-v2', ordinal: 2, reason: '补充材料', actorLabel: '用户', createdAt: '2026-09-15T09:20:00.000Z', current: false },
        { id: 'artifact-launch-v3', ordinal: 3, reason: '当前草稿', actorLabel: 'Writing Agent', createdAt: '2026-09-15T09:31:00.000Z', current: true },
      ],
      proposals: [],
    },
    factCheckWorkspace: {
      status: 'blocked',
      snapshot: {
        id: 'fact-snapshot-launch-v3',
        policyVersion: 'fact-check-v2-ts-v1',
        bodyVersionId: 'artifact-launch-v3',
        bodyHash: 'd'.repeat(64),
        titleVersionId: 'title-launch-v1',
        titleHash: 'e'.repeat(64),
        distributionCopyHash: null,
        evidenceVersionId: 'evidence-launch-v1',
        evidenceHash: 'f'.repeat(64),
      },
      assessment: {
        status: 'blocked',
        claimsHash: '1'.repeat(64),
        reportHash: '2'.repeat(64),
        blockers: ['C001'],
        claims: [{
          claimId: 'C001',
          claimText: '涉及性能提升的数据',
          location: '正文第 2 段',
          status: 'UNSUPPORTED',
          risk: 'yellow',
          supportScope: 'none',
          evidenceId: null,
          sourceReference: null,
          evidenceSummary: '当前材料没有支持该数据的出处。',
          recommendedAction: '删除具体数字，或补充可核验来源后重新核查。',
        }],
      },
      invalidations: [],
      provenance: [
        { fromId: 'fact-snapshot-launch-v3', relation: 'CHECKED_IN', toId: 'artifact-launch-v3', evidenceRef: 'assessment-mock-1' },
        { fromId: 'fact-snapshot-launch-v3', relation: 'CHECKED_IN', toId: 'title-launch-v1', evidenceRef: 'assessment-mock-1' },
        { fromId: 'fact-snapshot-launch-v3', relation: 'CHECKED_IN', toId: 'evidence-launch-v1', evidenceRef: 'assessment-mock-1' },
      ],
      notice: '来源关系仅说明产物如何形成；核查通过表示该输入快照通过既定流程，不承诺事实绝对正确。',
    },
    deliveryWorkspace: {
      bodyVersionId: 'artifact-launch-v3',
      projectRevision: 3,
      gateStatus: 'blocked',
      formalExportEnabled: false,
      exports: [],
      notice: '工作备份不代表可发布；正式 TXT/HTML 仅在当前正文、标题、证据与核查快照一致时生成。',
    },
    settings: {
      theme: 'system',
      language: 'zh-CN',
      contentFontSize: 14,
      providerLabel: 'OpenAI-compatible（未连接）',
      credentialReference: null,
    },
    activeRunId: null,
    brief: {
      versionId: 'brief-launch-v1',
      topic: '新品发布公众号文章',
      genre: 'explanatory_analysis',
      audience: '企业 IT 负责人',
      targetCharacters: 1200,
      constraints: ['不得虚构数据'],
      interactionMode: 'co_creation',
      authorVoice: '专业、克制',
      styleReference: null,
      styleDecision: 'user_delegated',
      confirmationStatus: 'confirmed',
      directionDecision: 'user_confirmed',
      platform: '微信公众号',
      publicationGoal: 'primary',
      materialCount: 2,
    },
    recoverableRuns: [COCREATION_RECOVERY],
    lastError: null,
    environmentNotice: '界面移植预览，未接入真实写作',
    composerHint: 'Enter 发送 · Shift+Enter 换行 · 本地确定性 Mock',
  }
}

export function createDeterministicMockBridge(options: DeterministicMockOptions = {}): ClientBridge {
  const latencyMs = options.latencyMs ?? 320
  const listeners = new Set<() => void>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let sequence = 1
  let snapshot = initialSnapshot()

  const emit = (next: BridgeSnapshot): void => {
    snapshot = { ...next, revision: snapshot.revision + 1 }
    for (const listener of listeners) listener()
  }

  const append = (sessionId: string, ...items: TimelineItem[]): void => {
    emit({
      ...snapshot,
      timelineBySession: {
        ...snapshot.timelineBySession,
        [sessionId]: [...(snapshot.timelineBySession[sessionId] ?? []), ...items],
      },
    })
  }

  const handshake = async (): Promise<BridgeHandshake> => ({
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
    clientBuild: 'wa-ui-baseline-0.1',
    runtimeBuild: 'deterministic-mock',
    capabilities: ['snapshot', 'project.select', 'session.select', 'run.start', 'run.cancel', 'revision.visual-demo', 'settings.update'],
    mock: true,
    persistsUserProjects: false,
    workspaceId: 'mock-workspace',
  })

  return {
    handshake,
    getSnapshot: () => snapshot,
    async getRunTraceDetail(input) {
      if (input.projectId !== snapshot.selectedProjectId || input.sessionId !== snapshot.selectedSessionId) throw new Error('TRACE_SCOPE_MISMATCH');
      return { runId: input.runId, stepId: input.stepId, requestId: null, callId: null, provider: null, model: null,
        sections: [], notes: ['演示模式没有持久化请求快照；此处不模拟真实模型的输入或结果。'] };
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async selectProject(projectId) {
      const project = snapshot.projects.find(candidate => candidate.id === projectId)
      if (project === undefined) throw new Error('MOCK_PROJECT_NOT_FOUND')
      emit({
        ...snapshot,
        generation: snapshot.generation + 1,
        selectedProjectId: projectId,
        selectedSessionId: '',
        runRecords: [],
        recoverableRuns: [],
        activeRunId: null,
      })
    },
    async selectSession(projectId, sessionId) {
      const project = snapshot.projects.find(candidate => candidate.id === projectId)
      const session = snapshot.sessions.find(candidate => candidate.id === sessionId)
      if (project === undefined || session?.projectId !== project.id) {
        throw new Error('MOCK_SESSION_SCOPE_MISMATCH')
      }
      const baseline = initialSnapshot()
      const previewDocument = projectId === 'project-launch'
        ? baseline.previewDocument
        : {
            id: null,
            title: '客户案例专题',
            version: 0,
            status: 'empty' as const,
            body: '此演示项目尚无已保存稿件。',
          }
      const revisionWorkspace = projectId === 'project-launch'
        ? baseline.revisionWorkspace
        : {
            bodyVersionId: null,
            projectRevision: project.revision,
            blocks: [],
            versions: [],
            proposals: [],
          }
      const factCheckWorkspace = projectId === 'project-launch'
        ? baseline.factCheckWorkspace
        : {
            status: 'not_checked' as const,
            snapshot: null,
            assessment: null,
            invalidations: [],
            provenance: [],
            notice: '来源关系仅说明产物如何形成；核查通过表示该输入快照通过既定流程，不承诺事实绝对正确。',
          }
      const deliveryWorkspace = projectId === 'project-launch'
        ? baseline.deliveryWorkspace
        : {
            bodyVersionId: null,
            projectRevision: project.revision,
            gateStatus: 'not_checked' as const,
            formalExportEnabled: false,
            exports: [],
            notice: '工作备份不代表可发布；正式 TXT/HTML 仅在当前正文、标题、证据与核查快照一致时生成。',
          }
      emit({
        ...snapshot,
        generation: snapshot.generation + 1,
        selectedProjectId: projectId,
        selectedSessionId: sessionId,
        runRecords: sessionId === COCREATION_RECOVERY.sessionId ? [COCREATION_RUN] : [],
        recoverableRuns: sessionId === COCREATION_RECOVERY.sessionId ? [COCREATION_RECOVERY] : [],
        previewDocument,
        revisionWorkspace,
        factCheckWorkspace,
        deliveryWorkspace,
      })
    },
    async updateSettings(patch: Partial<Pick<UiSettings, 'theme' | 'contentFontSize'>>): Promise<void> {
      emit({ ...snapshot, settings: { ...snapshot.settings, ...patch } })
    },
    async createProject() {
      throw new Error('MOCK_PROJECT_CREATION_DISABLED')
    },
    async renameProject(projectId, name) {
      const normalizedName = name.trim()
      if (!normalizedName || Array.from(normalizedName).length > 60) throw new Error('PROJECT_NAME_INVALID')
      const project = snapshot.projects.find(candidate => candidate.id === projectId)
      if (project === undefined) throw new Error('PROJECT_NOT_FOUND')
      emit({ ...snapshot, projects: snapshot.projects.map(candidate => candidate.id === projectId
        ? { ...candidate, name: normalizedName, revision: candidate.revision + 1 }
        : candidate) })
    },
    async updateBrief() {
      throw new Error('MOCK_BRIEF_UPDATE_DISABLED')
    },
    async confirmBrief() {
      throw new Error('MOCK_BRIEF_CONFIRMATION_DISABLED')
    },
    async startConversation() {
      throw new Error('MOCK_PROJECT_CREATION_DISABLED')
    },
    async confirmConversation() {
      throw new Error('MOCK_BRIEF_CONFIRMATION_DISABLED')
    },
    async sendMessage(text) {
      const body = text.trim()
      if (body.length === 0) throw new Error('EMPTY_MESSAGE')
      if (snapshot.activeRunId !== null) throw new Error('RUN_ALREADY_ACTIVE')
      const sessionId = snapshot.selectedSessionId
      const runId = `mock-run-${String(sequence++)}`
      const userId = `${runId}-user`
      const toolId = `${runId}-tool`
      append(sessionId,
        { id: userId, kind: 'message', role: 'user', body, createdAt: '预览' },
        { id: toolId, kind: 'tool', label: '分析写作请求', detail: '确定性 mock，不调用模型或真实项目', state: 'pending' },
      )
      emit({ ...snapshot, connection: 'running', activeRunId: runId })
      const timer = setTimeout(() => {
        timers.delete(runId)
        const items = snapshot.timelineBySession[sessionId] ?? []
        emit({
          ...snapshot,
          connection: 'ready',
          activeRunId: null,
          timelineBySession: {
            ...snapshot.timelineBySession,
            [sessionId]: [
              ...items.map(item => item.id === toolId ? { ...item, state: 'success' as const } : item),
              {
                id: `${runId}-assistant`,
                kind: 'message' as const,
                role: 'assistant' as const,
                body: '这是界面移植阶段的确定性响应。真实材料读取、模型调用和稿件保存尚未接入。',
                createdAt: '预览',
              },
            ],
          },
        })
      }, latencyMs)
      timers.set(runId, timer)
      return { runId }
    },
    async runFactCheck() {
      throw new Error('MOCK_FACT_CHECK_DISABLED')
    },
    async cancelRun(runId) {
      const timer = timers.get(runId)
      const recoverable = snapshot.recoverableRuns.find(run => run.runId === runId)
      if (timer === undefined && recoverable !== undefined) {
        emit({
          ...snapshot,
          runRecords: snapshot.runRecords.map(run => run.id === runId
            ? { ...run, status: 'cancelled', stopReason: 'user_stop', completedAt: '2026-09-19T10:10:00.000Z' }
            : run),
          recoverableRuns: snapshot.recoverableRuns.filter(run => run.runId !== runId),
          sessions: snapshot.sessions.map(session => session.id === recoverable.sessionId
            ? { ...session, status: 'cancelled' }
            : session),
        })
        return
      }
      if (timer === undefined || snapshot.activeRunId !== runId) throw new Error('RUN_NOT_ACTIVE')
      clearTimeout(timer)
      timers.delete(runId)
      const sessionId = snapshot.selectedSessionId
      const items = snapshot.timelineBySession[sessionId] ?? []
      emit({
        ...snapshot,
        connection: 'ready',
        activeRunId: null,
        timelineBySession: {
          ...snapshot.timelineBySession,
          [sessionId]: items.map(item => item.id === `${runId}-tool` ? { ...item, state: 'cancelled' as const } : item),
        },
      })
    },
    async resumeRun(runId, decision, options) {
      const recovery = snapshot.recoverableRuns.find(run => run.runId === runId)
      if (recovery === undefined || decision !== 'resume') throw new Error('MOCK_RUN_NOT_RESUMABLE')
      const sessionId = recovery.sessionId
      const feedback = options?.feedback?.trim() || '认可当前阶段，继续下一步'
      const pendingToolId = `${runId}-resume-${String(sequence++)}`
      append(
        sessionId,
        { id: `${pendingToolId}-user`, kind: 'message', role: 'user', body: feedback, createdAt: '现在' },
        { id: pendingToolId, kind: 'tool', label: '内容主笔 · 完整初稿', detail: '正在结合你的意见写作', state: 'pending' },
      )
      emit({
        ...snapshot,
        connection: 'running',
        activeRunId: runId,
        recoverableRuns: snapshot.recoverableRuns.filter(run => run.runId !== runId),
        runRecords: snapshot.runRecords.map(run => run.id === runId
          ? { ...run, status: 'running', stopReason: null }
          : run),
        sessions: snapshot.sessions.map(session => session.id === sessionId
          ? { ...session, status: 'running' }
          : session),
      })
      const timer = setTimeout(() => {
        timers.delete(runId)
        const draftRecovery: RecoverableRunSummary = {
          ...recovery,
          checkpointStage: 'draft',
          nextStage: 'review_editor',
        }
        const items = snapshot.timelineBySession[sessionId] ?? []
        emit({
          ...snapshot,
          connection: 'ready',
          activeRunId: null,
          previewDocument: {
            id: 'artifact-cocreation-draft-v1',
            title: 'AI 内容生产为什么需要一条可信链路',
            version: 1,
            status: 'draft',
            body: '当内容生成变得越来越快，真正稀缺的不是多写一篇，而是回答三个问题：依据从哪里来、判断由谁确认、修改为什么发生。\n\n这份初稿已结合你的意见保留“业务流程”主线，下一步可以继续调整重点和语气。',
          },
          timelineBySession: {
            ...snapshot.timelineBySession,
            [sessionId]: [
              ...items.map(item => item.id === pendingToolId
                ? { ...item, state: 'success' as const, detail: '初稿已保存，等待你的判断' }
                : item),
              {
                id: `${pendingToolId}-assistant`,
                kind: 'message' as const,
                role: 'assistant' as const,
                body: '内容主笔已经按你的意见完成初稿。你可以直接指出要保留、删减或强化的部分，再交给独立审校。',
                createdAt: '现在',
              },
            ],
          },
          runRecords: snapshot.runRecords.map(run => run.id === runId
            ? {
                ...run,
                status: 'waiting_user',
                stopReason: 'CO_CREATION_CHECKPOINT',
                modelRequests: 6,
                toolCalls: 6,
                completedStages: 3,
                stages: run.stages.map(stage => stage.id === 'draft'
                  ? { ...stage, status: 'completed', detail: '初稿已保存，等待用户判断' }
                  : stage),
              }
            : run),
          recoverableRuns: [draftRecovery],
          sessions: snapshot.sessions.map(session => session.id === sessionId
            ? { ...session, status: 'waiting_user' }
            : session),
        })
      }, latencyMs)
      timers.set(runId, timer)
    },
    async proposeRevision() {
      throw new Error('MOCK_REVISION_READ_ONLY')
    },
    async acceptRevision() {
      throw new Error('MOCK_REVISION_READ_ONLY')
    },
    async rejectRevision() {
      throw new Error('MOCK_REVISION_READ_ONLY')
    },
    async saveBody() {
      throw new Error('MOCK_REVISION_READ_ONLY')
    },
    async setBlockLock() {
      throw new Error('MOCK_REVISION_READ_ONLY')
    },
    async rollbackBody() {
      throw new Error('MOCK_REVISION_READ_ONLY')
    },
    async saveWorkingCopy() {
      throw new Error('MOCK_EXPORT_READ_ONLY')
    },
    async exportPublication() {
      throw new Error('MOCK_EXPORT_READ_ONLY')
    },
    async refresh() {
      // Deterministic mock has no external state to replay.
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      listeners.clear()
    },
  }
}
