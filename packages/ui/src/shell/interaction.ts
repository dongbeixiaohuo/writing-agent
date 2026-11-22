import type {
  BridgeSnapshot,
  RecoverableRunSummary,
  RunRecordView,
  WritingWorkflowStageId,
} from '../../../client-bridge/src/protocol.ts'

import { agentPersonas, personaForActor, type AgentPersona } from './agent-personas.ts'

interface WorkingCopy { title: string; detail: string }

const workingTasks: Readonly<Record<string, WorkingCopy>> = {
  intake: { title: '在琢磨选题', detail: '你刚才有几句话值得展开，我把能写的方向理一理，你来挑。' },
  author: { title: '在看你的改稿意见', detail: '我对着稿子看看，你想改的是这一句，还是这一段的意思。' },
  director: { title: '在安排下一步', detail: '到哪一步了我来盯。轮到你拍板，我就来喊你。' },
  research: { title: '在翻手头的材料', detail: '我挑挑里面有哪些人、哪些事，能让这个题写得更具体。' },
  outline: { title: '在排文章顺序', detail: '从哪儿讲起，哪件事放后面读着更有劲，我先排一版给你看。' },
  draft: { title: '在写第一版', detail: '按你选的路子落笔。写到哪儿，你就能看到哪儿。' },
  review_editor: { title: '在读初稿', detail: '哪段讲得挺好，哪段说了半天还在原地，我都给你圈出来。' },
  review_publish: { title: '在看发出去的效果', detail: '我站在头一回看这篇文章的读者那边，看看哪句话容易被读岔。' },
  review_reader: { title: '在各看各的', detail: '看看谁读到哪儿想划走，谁看到哪儿又想往下翻。' },
  central_revision: { title: '在回头改稿', detail: '按你定下来的改法，先动那几处最影响阅读的地方。' },
  language_review: { title: '在读修订稿', detail: '上轮说的问题，我回头看看是不是真改顺了。顺手收掉稿子里的工作备注，把你的语气留住。' },
  title: { title: '在憋标题', detail: '我拟几个给你挑。得让人想点开，点开后也得是这么回事。' },
  fact_extract: { title: '在挑需要核对的句子', detail: '我把稿子里的年份、数字、引语和具体说法挑出来，看看哪些还拿不准。' },
  fact_check: { title: '在对材料', detail: '手头的原文先对一遍。还有哪句存疑，就接着查哪句。' },
}

const workingTools: Readonly<Record<string, WorkingCopy & { persona: AgentPersona }>> = {
  search_research_sources: { persona: 'research', title: '在找一条新线索', detail: '就看眼下缺的这件事有没有更具体的例子。够写了，就回来接着写。' },
  search_fact_sources: { persona: 'fact-check', title: '在查一句话的来历', detail: '这句光靠现有材料还说不准，我去看看能不能找到出处。' },
  read_fact_source: { persona: 'fact-check', title: '在翻原文', detail: '摘要就那么几行，我去看看原文前后到底怎么说。' },
}

const fallbackWorking: WorkingCopy = { title: '在看你的消息', detail: '收到了，有回复就接在这里。' }

export function conversationWorkingCopy(activity: BridgeSnapshot['liveActivity'], now: number) {
  const actor = activity?.actor ?? ''
  const assigned = personaForActor(actor)
  const task = assigned === 'readers' ? workingTasks.review_reader : Object.hasOwn(workingTasks, actor) ? workingTasks[actor] : undefined
  const toolName = activity?.activeTool?.name ?? ''
  const tool = Object.hasOwn(workingTools, toolName) ? workingTools[toolName] : undefined
  const persona = toolName === 'read_fact_source' && (assigned === 'research' || assigned === 'outline')
    ? 'research'
    : tool?.persona ?? assigned ?? 'assistant'
  const current = tool ?? task ?? fallbackWorking
  const elapsedSeconds = activity ? Math.max(0, Math.floor((now - (activity.segmentStartedAt ?? activity.startedAt)) / 1000)) : 0
  const lastUpdate = activity?.activeTool?.startedAt ?? activity?.lastActivityAt ?? activity?.startedAt
  const waiting = lastUpdate !== undefined && now - lastUpdate >= 30_000
  return {
    persona,
    title: agentPersonas[persona] + current.title,
    detail: waiting ? current.detail + ' 这一步还在等回复。你可以再等一会儿，也可以点「停止」。' : current.detail,
    elapsedSeconds,
  }
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
  readonly persona: AgentPersona
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
  if (recovery.inputRequest?.kind === 'search_recovery') return { persona: 'fact-check', eyebrow: '搜索等待你的决定',
    title: recovery.inputRequest.searchRecovery?.kind === 'limit' ? '搜索已到本轮上限' : '搜索服务未取得结果',
    description: '这次没找到可用的来源。可以再搜一次，也可以先用手头的资料核对，拿不准的地方我会告诉你。', feedbackPlaceholder: '', primaryAction: '选择搜索处理方式' };
  const segment = run?.diagnostics?.segments.at(-1)
  const recentActor = run?.diagnostics?.trace?.findLast(step =>
    step.segmentId === segment?.id && (step.kind === 'model' || step.kind === 'tool') && step.actorLabel)?.actorLabel
  const activeStage = run?.stages.findLast(stage => stage.status === 'running' || stage.status === 'failed')?.id
  const persona = personaForActor(recovery.interruption?.actorLabel) ?? personaForActor(recentActor)
    ?? personaForActor(activeStage ?? recovery.checkpointStage ?? recovery.nextStage) ?? 'assistant'

  if (recovery.stopReason === 'TOOL_NO_PROGRESS') return {
    persona, eyebrow: '已暂停 · 已保存内容保留', title: '这一步暂时没跑完',
    description: '你的材料和已保存的成果都还在，可以重试这一步。如果再次遇到问题，可查看运行记录了解原因。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'PROVIDER_RETRY_DEFERRED') {
    const timestamp = recovery.retryNotBefore;
    const retryTime = timestamp !== undefined && Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= 8_640_000_000_000_000
      ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : null;
    return { persona, eyebrow: '已暂停 · 已保存内容保留', title: '这一步需要稍后再试',
      description: `${retryTime ? `请在 ${retryTime} 后重试。` : '请稍后重试，或在设置中选择其他可用模型。'}你的材料和已保存的成果都还在。`,
      feedbackPlaceholder: '', primaryAction: '稍后重试这一步' };
  }
  if (recovery.stopReason === 'PARALLEL_TEXT_ALL_FAILED') return {
    persona: 'readers', eyebrow:'读者反馈未完成', title:'三位读者的反馈还没凑齐',
    description:'稿件和之前的审校意见都还在。你可以只重试读者反馈这一步，收到反馈后再决定怎么改稿。',
    feedbackPlaceholder:'', primaryAction:'重试模拟读者',
  }
  if (recovery.stopReason === 'TOOL_FAILURE_LOOP' && recovery.checkpointApproval) return {
    persona, eyebrow: '当前成果已保存 · 需要确认', title: '请确认这一版是否可以继续',
    description: `认可当前成果后，点击下方按钮继续；需要修改，也可以在对话中说明。${recovery.checkpointStage === 'language_review'
      ? '下一步请何起名拟几个标题。你选好后，查有据再来核对稿件。'
      : recovery.nextStage ? `下一步由${agentPersonas[personaForActor(recovery.nextStage) ?? 'assistant']}${stageRoleCopy(recovery.nextStage).action}。` : ''}`,
    feedbackPlaceholder: '', primaryAction: recovery.checkpointStage === 'language_review' ? '认可当前阶段，交给标题策划'
      : recovery.nextStage ? `认可当前阶段，交给${stageRoleCopy(recovery.nextStage).role}` : '认可当前阶段，继续',
  }
  if (recovery.stopReason === 'STAGE_OUTPUT_NOT_SAVED') return {
    persona, eyebrow: '已暂停 · 上一版内容保留', title: '这一步未能保存，上一版稿件仍在',
    description: '这次生成的内容没有保存成功。可以重试这一步，无需重新提供材料；具体原因可在运行记录中查看。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'TOOL_FAILURE_LOOP') return {
    persona, eyebrow: '已暂停 · 已保存内容保留', title: '这一步未能完成，已保存内容仍在',
    description: '我在这一步停住了。之前保存的内容都还在，点「重试这一步」可以接着来，材料不用重传。想看原因，可以打开运行记录。',
    feedbackPlaceholder: '', primaryAction: '重试这一步',
  }
  if (recovery.stopReason === 'BUDGET_EXHAUSTED') {
    return { persona, eyebrow: '自动处理已暂停 · 已保存内容保留', title: '这一步还没有完成，可以从这里继续',
      description: '这一轮已经处理了一段时间，先暂停在这里。已保存稿件和已确认标题保留，继续后会接着完成剩余工作。继续可能产生额外模型费用。',
      feedbackPlaceholder: '', primaryAction: '继续未完成步骤' }
  }
  if (recovery.inputRequest?.kind === 'publication_selection') {
    return { persona: 'title', eyebrow: '一起确定标题 · 正文已保存', title: '这些标题合适吗？可以选择，也可以继续讨论',
      description: recovery.inputRequest.reason, feedbackPlaceholder: '例如：都不满意，换一批更克制的；或：就用第二个吧', primaryAction: '发送意见' }
  }
  if (recovery.stopReason === 'WRITING_INPUT_REQUIRED') {
    return {
      persona, eyebrow: '等待你补充信息',
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
    const interruption = recovery.interruption
    if (recovery.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME' && interruption?.source === 'model') {
      const reason = interruption.timeoutPhase === 'stream_idle' ? '模型输出停顿超时' :
        interruption.timeoutPhase === 'first_response' ? '等待模型响应超时' :
          interruption.cause === 'timeout' ? '模型请求超时' : '模型请求中断'
      return {
        persona, eyebrow: interruption.replyAccepted ? '已收到你的回复 · 当前阶段已暂停' : '当前阶段已暂停',
        title: `${agentPersonas[persona]}因${reason}暂停`,
        description: '已保存的稿件和确认仍在。上次请求的上游结果未知，点击“重试这一步”会发起新的模型请求，可能再次计费。',
        feedbackPlaceholder: '', primaryAction: '重试这一步',
      }
    }
    return {
      persona,
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
    persona: personaForActor(completedStage) ?? persona,
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
      ? '下一步请何起名拟几个标题。你选好后，查有据再来核对稿件。还想改哪里，可以告诉周一稿。'
      : completedStage === 'review_reader'
      ? '托尼老师会结合你的取舍看这三份感受，再交给周一稿。你可以先聊聊，也可以认可后继续。'
      : next === null
      ? '请先查看当前成果；确认后继续下一步。'
      : `下一步由${agentPersonas[personaForActor(nextStage) ?? 'assistant']}${next.action}。你可以直接认可，也可以先提出修改要求。`,
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
