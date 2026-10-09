import type {
  BridgeSnapshot,
  RecoverableRunSummary,
  RunRecordView,
  WritingWorkflowStageId,
} from '../../../client-bridge/src/protocol.ts'

export function conversationWorkingCopy(activity: BridgeSnapshot['liveActivity'], now: number) {
  const labels: Record<string, string> = {
    director: '正在核对已有内容，安排下一步', intake: '正在梳理你的想法', author: '正在处理你的修改意见',
    research: '正在整理参考材料与写作依据', outline: '正在整理文章提纲', draft: '正在起草文章',
    review_editor: '正在检查文章结构与表达', review_publish: '正在检查发布注意事项', review_reader: '三个模拟读者正在独立阅读',
    central_revision: '正在按审校意见修改文章', language_review: '正在润色文字', title: '正在构思标题', fact_check: '正在核对文章中的事实',
  }
  const elapsedSeconds = activity ? Math.max(0, Math.floor((now - (activity.segmentStartedAt ?? activity.startedAt)) / 1000)) : 0
  if (activity?.activeTool) {
    const seconds = Math.max(0, Math.floor((now - activity.activeTool.startedAt) / 1000))
    const name = activity.activeTool.name
    return { title: name === 'search_fact_sources' ? '正在搜索事实来源' : name === 'read_fact_source' ? '正在读取来源原文' : '正在处理工具操作',
      detail: `本次工具操作已用时 ${seconds} 秒。上方是本次执行累计时间，包含此前阶段。${name === 'search_fact_sources' || name === 'read_fact_source' ? '等待外部服务返回；超时会说明未能查证，不会把搜索失败当作核查通过。' : '运行记录可查看具体操作与结果。'}你可以随时停止，已保存稿件不会丢失。`, elapsedSeconds }
  }
  const requestSeconds = activity ? Math.max(0, Math.floor((now - activity.startedAt) / 1000)) : 0
  if (activity?.actor === 'review_reader') return { title:labels.review_reader!,
    detail:`三个读者并行阅读同一篇文章，不看彼此的反应。下方显示完成状态，结束后按身份合并；内部结构化输出不会作为聊天回复显示。当前批次已用时 ${requestSeconds} 秒，可随时停止。`, elapsedSeconds }
  const idle = activity?.lastActivityAt ? Math.max(0, Math.floor((now - activity.lastActivityAt) / 1000)) : 0
  const detail = !activity ? '有新回复会直接显示在这里。'
    : activity.phase === 'receiving' ? idle >= 30 ? `已收到部分模型数据，${idle} 秒未收到新内容；仍在等待，你可以停止。`
      : activity.lastEventKind === 'reasoning' ? `模型服务仍在处理，尚未收到可展示的答复。已接收 ${activity.receivedEvents ?? 1} 次数据活动；本界面不会展示或推测私有推理，收到可展示答复后会直接流式显示。`
      : activity.lastEventKind === 'tool_arguments' ? '模型正在准备操作。下方逐步展示可公开的任务说明或检索词，操作是否成功以运行记录为准。'
      : '已收到模型数据。下方可展示已读取素材；最终回复会在生成时逐步显示。'
    : activity.phase === 'connected' ? '模型服务已连接，正在等待模型回复。'
    : requestSeconds >= 30 ? '仍在等待模型回复，比平时稍久。你可以继续等待，也可以停止。' : '正在等待模型回复，有新内容会直接显示在这里。'
  const context: Record<string, string> = {
    director: '正在检查已有信息是否足够，并安排下一步；确实缺少信息时会在这里问你。',
    research: '正在核对材料能支持哪些内容，为提纲准备依据；可阅读的提纲会在生成时逐步显示。',
    fact_check: '正在对照当前稿件、标题和材料核查事实；核查完成后会说明结果及是否需要调整。',
    title: '正在结合当前正文拟定标题候选，整理好后会请你选择或提出修改意见。',
  }
  return { title: activity ? labels[activity.actor] ?? '正在处理你的消息' : '已收到，正在处理你的消息',
    detail: `${activity && context[activity.actor] ? `${context[activity.actor]} ` : ''}${detail}${activity ? ` 当前请求已等待 ${requestSeconds} 秒；上方计时是本次执行的累计时间，包含此前阶段，不是当前阶段耗时。` : ''}`, elapsedSeconds }
}

export function runRecordsTabLabel(count: number, activeRunId: string | null, activity?: BridgeSnapshot['liveActivity']) {
  const live = activeRunId ? activity?.runId === activeRunId && activity.requestOrdinal
    ? `本轮 ${activity.requestOrdinal} 次请求` : '执行中' : ''
  return live ? `运行记录（${live}）` : '运行记录'
}

export interface StageRoleCopy {
  readonly role: string
  readonly action: string
}

const STAGE_ROLE_COPY: Readonly<Record<WritingWorkflowStageId, StageRoleCopy>> = {
  research: { role: '资料研究', action: '整理证据与边界' },
  outline: { role: '选题策划', action: '形成文章方向与提纲' },
  draft: { role: '内容主笔', action: '完成第一版全文' },
  review_editor: { role: '编辑审校', action: '检查结构与论证' },
  review_publish: { role: '发布审校', action: '检查平台与发布风险' },
  review_reader: { role: '模拟读者', action: '三个独立模拟读者并行阅读，只给真实口吻的感受，不是编辑意见' },
  central_revision: { role: '内容主笔', action: '集中处理审校意见' },
  language_review: { role: '去 AI 味与语言润色', action: '消除套话和机械表达，保留作者声音，不编造亲历' },
  fact_check: { role: '事实核查', action: '核对易错或可疑的重要事实，中低风险不阻断' },
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
    description: recovery.inputRequest.reason, feedbackPlaceholder: '', primaryAction: '选择搜索处理方式' };
  if (recovery.stopReason === 'PARALLEL_TEXT_ALL_FAILED') return {
    role:'模拟读者', eyebrow:'读者反馈未完成 · 未自动重试', title:'三个模拟读者都未返回可用感受',
    description:'未保存空反馈，也未继续改稿。可查看运行记录中的具体模型错误，稍后只重试读者阶段；稿件和前面的审校仍保留。重试会再次请求模型并产生用量。',
    feedbackPlaceholder:'', primaryAction:'重试模拟读者',
  }
  if (recovery.stopReason === 'TOOL_FAILURE_LOOP' && recovery.checkpointApproval) return {
    role: '写作助手', eyebrow: '当前成果仍在 · 需要确认', title: '当前决策记录要求修改，流程已暂停',
    description: `请核对当前保存的成果。若认可，点击下方按钮直接确认，不再让模型重新判断按钮含义；如仍需修改，在主对话中说明即可。${recovery.checkpointStage === 'language_review'
      ? '下一步由「标题策划」提出标题候选；确认标题后，再交给「事实核查」专家。核查发现正文问题将返回「内容主笔」集中修订，这是返工。'
      : recovery.nextStage ? `下一步由「${stageRoleCopy(recovery.nextStage).role}」${stageRoleCopy(recovery.nextStage).action}。` : ''}`,
    feedbackPlaceholder: '', primaryAction: recovery.checkpointStage === 'language_review' ? '认可当前阶段，交给标题策划'
      : recovery.nextStage ? `认可当前阶段，交给${stageRoleCopy(recovery.nextStage).role}` : '认可当前阶段，继续',
  }
  if (recovery.stopReason === 'STAGE_OUTPUT_NOT_SAVED') return {
    role: '写作助手', eyebrow: '保存校验未通过 · 自动重写已停止', title: '这一步未能保存，上一版稿件仍在',
    description: '同一阶段反复未通过保存校验，程序已停止继续生成，避免重复刷屏。不是连接或账户额度问题；无需重新提供材料。可查看运行记录中的具体校验原因，或主动重试当前步骤；重试会产生模型用量。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'TOOL_FAILURE_LOOP') return {
    role: '写作助手', eyebrow: '程序操作未通过 · 自动重试已停止', title: recovery.validationFailure?.code === 'TOOL_PERMISSION_DENIED'
      ? '读取版本时发生程序冲突，稿件仍在' : '这一步操作未能完成，已保存内容仍在',
    description: recovery.validationFailure
      ? `${recovery.validationFailure.explanation} 已停止自动重试，避免空转。修复后可重试这一步，不重做已保存内容；重试会产生模型用量。`
      : '程序操作连续未通过校验，已停止自动重试，避免空转。已保存内容保留。请查看运行记录中的错误原因；这不一定是文章事实问题，不必先重新提供材料。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'BUDGET_EXHAUSTED') {
    return { role: '写作助手', eyebrow: '自动处理已暂停 · 已保存内容保留', title: '这一步还没有完成，可以从这里继续',
      description: '本轮自动调用已达到保护上限，不是服务商账户额度不足。已保存稿件和已确认标题保留；继续时不重做已保存阶段，从未完成的步骤接着处理。会再次请求模型并产生用量。',
      feedbackPlaceholder: '', primaryAction: '继续未完成步骤' }
  }
  if (recovery.inputRequest?.kind === 'publication_selection') {
    return { role: '标题策划', eyebrow: '一起确定标题 · 正文已保存', title: '这些标题合适吗？可以选择，也可以继续讨论',
      description: recovery.inputRequest.reason, feedbackPlaceholder: '例如：都不满意，换一批更克制的；或：就用第二个吧', primaryAction: '发送意见' }
  }
  if (recovery.stopReason === 'WRITING_INPUT_REQUIRED') {
    return {
      role: '写作助手', eyebrow: '需要你补充 · 后续步骤尚未执行',
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
        title: recovery.interruption.timeoutPhase === 'first_response' ? '等待模型回复较久，已暂停这一步'
          : recovery.interruption.timeoutPhase === 'stream_idle' ? '模型回复中途停顿，已暂停这一步'
          : recovery.interruption.cause === 'timeout' ? '模型响应超时，这一步还没完成' : '没有收到完整的模型回复，这一步还没完成',
        description: `${recovery.interruption.timeoutPhase ? (recovery.interruption.timeoutPhase === 'first_response'
          ? `等待 ${Math.round((recovery.interruption.timeoutMs ?? 0) / 1000)} 秒仍未收到有效回复，客户端已停止等待。`
          : `已收到部分内容，但连续 ${Math.round((recovery.interruption.timeoutMs ?? 0) / 1000)} 秒没有新内容，客户端已暂停。未完成的内容没有作为正式成果保存。`) : ''}已保存的内容还在，无需重复确认或重新填写。点击“重试这一步”后继续；重试会再次请求模型，可能产生额外用量。`,
        feedbackPlaceholder: '', primaryAction: '重试这一步',
      }
    }
    return {
      role: '运行恢复',
      eyebrow: '需要你的决定',
      title: recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME'
        ? '上次外部请求的结果未知'
        : '上次写作在保存边界处中断',
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
      ? '下一步由「标题策划」提出标题候选；你确认标题后，再由「事实核查」专家核查。若核查发现正文问题，将返回「内容主笔」集中修订并重新核查，这是返工。'
      : completedStage === 'review_reader'
      ? '下一步由「写作导演」结合文章目标和你的取舍解读，再交给「修订主笔」。这些只是模拟感受，不按票数改稿；你可以先讨论，也可以认可后继续。'
      : next === null
      ? '请先查看当前成果；确认后继续下一步。'
      : `下一步由「${next.role}」${next.action}。你可以直接认可，也可以提出修改要求，返工本阶段后再继续。`,
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
