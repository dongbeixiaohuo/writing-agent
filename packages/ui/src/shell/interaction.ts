import type {
  BridgeSnapshot,
  RecoverableRunSummary,
  RunRecordView,
  WritingWorkflowStageId,
} from '../../../client-bridge/src/protocol.ts'

export function conversationWorkingCopy(activity: BridgeSnapshot['liveActivity'], now: number) {
  const tasks: Record<string, { title: string; detail: string }> = {
    director: { title: '写作导演 Agent 正在安排下一步', detail: '结合已完成的内容安排后续工作；需要你确认时，会在这里停下来。' },
    intake: { title: '写作助手 Agent 正在梳理你的想法', detail: '结合你的选题和要求，整理这篇文章的写作方向。' },
    author: { title: '写作助手 Agent 正在处理你的意见', detail: '结合当前稿件回应你的想法，确认接下来怎么调整。' },
    research: { title: '资料研究 Agent 正在整理参考材料', detail: '为文章寻找有用的事实、案例和观点，准备写作依据。' },
    outline: { title: '选题策划 Agent 正在整理提纲', detail: '围绕已确认的方向安排文章结构，完成后请你过目。' },
    draft: { title: '内容主笔 Agent 正在撰写初稿', detail: '按照提纲和选定的风格展开正文，新内容会逐步显示。' },
    review_editor: { title: '编辑审校 Agent 正在审读文章', detail: '检查结构、论证和表达，整理值得修改的地方。' },
    review_publish: { title: '发布审校 Agent 正在检查发布风险', detail: '结合发布平台，检查容易引起误解或需要调整的内容。' },
    review_reader: { title: '模拟读者 Agent 正在独立阅读', detail: '三位模拟读者会分别说出阅读感受，完成后放在一起供你参考。' },
    central_revision: { title: '内容主笔 Agent 正在修改文章', detail: '结合审校意见和你的取舍，完善这一版正文。' },
    language_review: { title: '终审 Agent 正在复核修订稿', detail: '检查审校发现的问题是否真正解决，清理工作备注和生硬表达，保留文章的语气与个性。' },
    title: { title: '标题策划 Agent 正在构思标题', detail: '结合正文拟定标题候选，完成后请你选择或提出修改意见。' },
    fact_check: { title: '事实核查 Agent 正在核对文章', detail: '对照正文、标题和参考来源，检查重要事实是否可靠。' },
    fact_extract: { title: '事实核查 Agent 正在整理待核对的内容', detail: '从文章中找出需要确认的事实，准备逐一核查。' },
  }
  const elapsedSeconds = activity ? Math.max(0, Math.floor((now - (activity.segmentStartedAt ?? activity.startedAt)) / 1000)) : 0
  const task = activity && tasks[activity.actor] || { title: '写作助手 Agent 正在处理你的消息', detail: '有新回复会显示在这里。' }
  const toolTasks: Record<string, { title: string; detail: string }> = {
    search_research_sources: { title: '资料研究 Agent 正在查找参考资料', detail: '补充与选题相关的资料，供后续写作参考。' },
    search_fact_sources: { title: '事实核查 Agent 正在寻找可靠来源', detail: '为需要核对的内容查找依据，核查结果会在完成后告诉你。' },
    read_fact_source: { title: '事实核查 Agent 正在查阅来源原文', detail: '对照原文核实文章中的说法。' },
  }
  const current = activity?.activeTool ? toolTasks[activity.activeTool.name] ?? task : task
  // Describe the assigned work, never infer thoughts from transport events.
  const lastUpdate = activity?.activeTool?.startedAt ?? activity?.lastActivityAt ?? activity?.startedAt
  const waiting = lastUpdate !== undefined && now - lastUpdate >= 30_000
  return { ...current, detail: waiting
    ? `${current.detail} 这一步暂时还没有新回复，你可以继续等待，也可以停止。`
    : current.detail, elapsedSeconds }
}

export function runRecordsTabLabel(count: number, activeRunId: string | null, activity?: BridgeSnapshot['liveActivity']) {
  return activeRunId ? '运行记录（进行中）' : '运行记录'
}

export interface StageRoleCopy {
  readonly role: string
  readonly action: string
}

const STAGE_ROLE_COPY: Readonly<Record<WritingWorkflowStageId, StageRoleCopy>> = {
  research: { role: '资料研究', action: '整理参考资料与写作依据' },
  outline: { role: '选题策划', action: '形成文章方向与提纲' },
  draft: { role: '内容主笔', action: '完成第一版全文' },
  review_editor: { role: '编辑审校', action: '检查结构与论证' },
  review_publish: { role: '发布审校', action: '检查平台与发布风险' },
  review_reader: { role: '模拟读者', action: '分别阅读文章，分享各自的感受' },
  central_revision: { role: '内容主笔', action: '集中处理审校意见' },
  language_review: { role: '终审与文字打磨', action: '复核修订结果，清理工作备注和机械表达，保留作者声音' },
  fact_check: { role: '事实核查', action: '核对文章中的重要事实' },
}

export function stageRoleCopy(stage: WritingWorkflowStageId): StageRoleCopy {
  return STAGE_ROLE_COPY[stage]
}

export function stageRoleLabel(stage: WritingWorkflowStageId): string {
  return stage === 'fact_check' ? '事实核查专员' : stage === 'review_reader' ? '模拟读者' : `${stageRoleCopy(stage).role}专家`
}

export interface CheckpointCopy {
  readonly role: string
  readonly eyebrow: string
  readonly title: string
  readonly description: string
  readonly feedbackPlaceholder: string
  readonly primaryAction: string
}

export function checkpointCopy(
  recovery: RecoverableRunSummary,
  run: RunRecordView | undefined,
): CheckpointCopy {
  if (recovery.inputRequest?.kind === 'search_recovery') return { role: '事实核查', eyebrow: '搜索等待你的决定',
    title: recovery.inputRequest.searchRecovery?.kind === 'limit' ? '搜索已到本轮上限' : '搜索服务未取得结果',
    description: '事实核查 Agent 暂时无法继续查找来源。你可以继续搜索，或使用已有资料完成核查；缺少依据的内容会单独说明。', feedbackPlaceholder: '', primaryAction: '选择搜索处理方式' };
  if (recovery.stopReason === 'TOOL_NO_PROGRESS') return {
    role: '写作助手', eyebrow: '已暂停 · 已保存内容保留', title: '写作助手 Agent 暂时没能完成这一步',
    description: '你的材料和已保存的成果都还在，可以重试这一步。如果再次遇到问题，可查看运行记录了解原因。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'PROVIDER_RETRY_DEFERRED') {
    const timestamp = recovery.retryNotBefore;
    const retryTime = timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000
      ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : null;
    return { role: '写作助手', eyebrow: '已暂停 · 已保存内容保留', title: '这一步需要稍后再试',
      description: `${retryTime ? `请在 ${retryTime} 后重试。` : '请稍后重试，或在设置中选择其他可用模型。'}你的材料和已保存的成果都还在。`,
      feedbackPlaceholder: '', primaryAction: '稍后重试这一步' };
  }
  if (recovery.stopReason === 'PARALLEL_TEXT_ALL_FAILED') return {
    role:'模拟读者', eyebrow:'读者反馈未完成', title:'模拟读者 Agent 暂时没能完成反馈',
    description:'稿件和之前的审校意见都还在。你可以只重试读者反馈这一步，收到反馈后再决定怎么改稿。',
    feedbackPlaceholder:'', primaryAction:'重试模拟读者',
  }
  if (recovery.stopReason === 'TOOL_FAILURE_LOOP' && recovery.checkpointApproval) return {
    role: '写作助手', eyebrow: '当前成果已保存 · 需要确认', title: '请确认这一版是否可以继续',
    description: `认可当前成果后，点击下方按钮继续；需要修改，也可以在对话中说明。${recovery.checkpointStage === 'language_review'
      ? '下一步由标题策划 Agent 拟定标题；你选定标题后，再进行事实核查。'
      : recovery.nextStage ? `下一步由「${stageRoleCopy(recovery.nextStage).role}」${stageRoleCopy(recovery.nextStage).action}。` : ''}`,
    feedbackPlaceholder: '', primaryAction: recovery.checkpointStage === 'language_review' ? '认可当前阶段，交给标题策划'
      : recovery.nextStage ? `认可当前阶段，交给${stageRoleCopy(recovery.nextStage).role}` : '认可当前阶段，继续',
  }
  if (recovery.stopReason === 'STAGE_OUTPUT_NOT_SAVED') return {
    role: '写作助手', eyebrow: '已暂停 · 上一版内容保留', title: '这一步未能保存，上一版稿件仍在',
    description: '这次生成的内容没有保存成功。可以重试这一步，无需重新提供材料；具体原因可在运行记录中查看。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'TOOL_FAILURE_LOOP') return {
    role: '写作助手', eyebrow: '已暂停 · 已保存内容保留', title: '这一步未能完成，已保存内容仍在',
    description: '写作助手 Agent 遇到问题，暂时停在了这里。可以重试这一步，无需重新提供材料；具体原因可在运行记录中查看。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'BUDGET_EXHAUSTED') {
    return { role: '写作助手', eyebrow: '自动处理已暂停 · 已保存内容保留', title: '这一步还没有完成，可以从这里继续',
      description: '这一轮已经处理了一段时间，先暂停在这里。已保存稿件和已确认标题保留，继续后会接着完成剩余工作。继续可能产生额外模型费用。',
      feedbackPlaceholder: '', primaryAction: '继续未完成步骤' }
  }
  if (recovery.inputRequest?.kind === 'publication_selection') {
    return { role: '标题策划', eyebrow: '一起确定标题 · 正文已保存', title: '这些标题合适吗？可以选择，也可以继续讨论',
      description: recovery.inputRequest.reason, feedbackPlaceholder: '例如：都不满意，换一批更克制的；或：就用第二个吧', primaryAction: '发送意见' }
  }
  if (recovery.stopReason === 'WRITING_INPUT_REQUIRED') {
    return {
      role: '写作助手', eyebrow: '等待你补充信息',
      title: '需要补充信息，写作已暂停',
      description: recovery.inputRequest?.reason ?? '当前信息不足以继续，请补充主题或相关材料。',
      feedbackPlaceholder: '回答上面的问题，也可以直接在主对话输入框回复',
      primaryAction: '补充并继续',
    }
  }
  const completedStage = recovery.checkpointStage ?? run?.stages
    .filter(stage => stage.status === 'completed')
    .at(-1)?.id ?? null
  const nextStage = recovery.nextStage ?? run?.stages
    .find(stage => stage.status === 'pending' || stage.status === 'running')?.id ?? null
  const completed = completedStage === null ? null : stageRoleCopy(completedStage)
  const next = nextStage === null ? null : stageRoleCopy(nextStage)

  if (recovery.stopReason !== 'CO_CREATION_CHECKPOINT') {
    if (recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME' && recovery.interruption?.source === 'model') {
      return {
        role: '写作助手', eyebrow: recovery.interruption.replyAccepted ? '已收到你的回复 · 这一步暂时中断' : '回复尚未完成 · 写作暂时暂停',
        title: '回复还没有完成，这一步已暂停',
        description: '写作助手 Agent 没能完成这次回复，未完成的内容没有作为正式成果保存。已保存的内容仍在，可以重试这一步，无需重新填写。',
        feedbackPlaceholder: '', primaryAction: '重试这一步',
      }
    }
    return {
      role: '写作助手',
      eyebrow: '需要你的决定',
      title: recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME'
        ? '还无法确认上次操作是否完成'
        : '上次写作中断，可以接着继续',
      description: recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME'
        ? '无法确定上次操作是否完成，系统已暂停自动执行。请先在运行记录中检查，再决定是否重试；重试可能重复执行该操作。'
        : '已保存的材料、稿件和决定都还在，可以从当前状态继续。',
      feedbackPlaceholder: '可补充本次恢复时需要注意的事项（可选）',
      primaryAction: recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME'
        ? '确认重试并继续'
        : '从已保存状态继续',
    }
  }

  return {
    role: completed?.role ?? '共创协作',
    eyebrow: '阶段成果已保存 · 等待你的决定',
    title: completedStage === 'outline'
      ? '提纲已经形成，方向对吗？'
      : completedStage === 'draft'
        ? '第一版全文已经完成，要按这个方向审校吗？'
        : completedStage === 'review_reader'
          ? '三个模拟读者的感受，你怎么看？'
        : completedStage?.startsWith('review_')
          ? `${completed?.role}已经完成，先核对这一轮建议好吗？`
          : '当前阶段已经完成，是否继续？',
    description: completedStage === 'language_review'
      ? '下一步由标题策划 Agent 拟定标题；你选定标题后，再进行事实核查。需要调整的内容，会交给内容主笔 Agent 修改。'
      : completedStage === 'review_reader'
      ? '下一步由「写作导演」结合文章目标和你的取舍解读，再交给「修订主笔」。这些只是模拟感受，不按票数改稿；你可以先讨论，也可以认可后继续。'
      : next === null
      ? '请先查看当前成果；确认后继续下一步。'
      : `下一步由${next.role} Agent ${next.action}。你可以直接认可，也可以先提出修改要求。`,
    feedbackPlaceholder: completedStage === 'outline'
      ? '例如：保留前两部分，把第三部分改成案例拆解，不要写趋势预测'
      : completedStage === 'draft'
        ? '例如：压到 3000 字，开头更直接，结尾不要喊口号'
        : completedStage === 'review_reader'
          ? '例如：我更希望保留现在的开头，只处理第二位读者没看懂的地方'
        : '例如：优先处理事实边界和结构问题，保留现在的语气',
    primaryAction: completedStage === 'language_review' ? '认可当前阶段，交给标题策划'
      : next ? `认可当前阶段，交给${next.role}` : '认可当前阶段，继续',
  }
}

export function checkpointResumeInstruction(feedback: string): string {
  const normalized = feedback.trim()
  return normalized.length === 0
    ? '认可当前阶段，继续下一步'
    : normalized
}

export type RecoveryContinueAction =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'resume'; readonly decision: 'resume' | 'retry_unknown' }

export function recoveryContinueAction(recovery: RecoverableRunSummary): RecoveryContinueAction {
  if (recovery.checkpointApproval) return { kind: 'resume', decision: 'resume' }
  if (recovery.stopReason === 'CO_CREATION_CHECKPOINT') {
    return { kind: 'message', text: checkpointResumeInstruction('') }
  }
  return {
    kind: 'resume',
    decision: recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME' ? 'retry_unknown' : 'resume',
  }
}

export function composerRecoveryMode(runs: readonly RecoverableRunSummary[], sessionId: string): 'answer' | 'decision' | null {
  const pending = runs.filter(run => run.sessionId === sessionId)
  if (pending.some(run => run.stopReason === 'WRITING_INPUT_REQUIRED' || run.stopReason === 'CO_CREATION_CHECKPOINT' || run.checkpointApproval)) return 'answer'
  return pending.length > 0 ? 'decision' : null
}
