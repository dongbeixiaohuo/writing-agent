import type { RunRecordView } from '../../../client-bridge/src/protocol.ts'

export function runStatusLabel(status: RunRecordView['status']): string {
  const labels: Readonly<Record<RunRecordView['status'], string>> = {
    queued: '等待启动',
    running: '正在写作',
    waiting_user: '等待你的决定',
    paused: '已暂停',
    completed: '运行完成',
    failed: '运行失败',
    cancelled: '已停止',
    budget_exhausted: '已触发运行保护',
    interrupted: '运行已中断',
  }
  return labels[status]
}

export function runStopReasonLabel(reason: string): string {
  const labels: Readonly<Record<string, string>> = {
    CO_CREATION_CHECKPOINT: '等待你确认当前共创阶段',
    WRITING_INPUT_REQUIRED: '写作已暂停，等待你补充必要信息',
    UNKNOWN_EXTERNAL_OUTCOME: 'App 没收到能确认结果的回复。先查看对话或稿件，再决定是否重试',
    USER_CANCELLED: '你已停止这次运行',
    BUDGET_EXHAUSTED: '这次运行用完了 App 允许的处理次数，已保存的内容还在',
    MODEL_BUDGET_EXHAUSTED: '这次运行已用完可以请求模型的次数',
    TOOL_BUDGET_EXHAUSTED: '这次运行已用完可以调用工具的次数',
    REVISION_BUDGET_EXHAUSTED: '这次运行已用完可以大幅修订的次数',
    MODEL_UNSUPPORTED: '当前模型暂时不能用。可以到模型设置里测试连接或换个模型',
    MODEL_RESPONSE_INVALID: '模型回了话，但回复格式没对上。可以回到对话重试，原来的输入还在',
    STAGE_OUTPUT_NOT_SAVED: '这一步尝试了几次还是没能保存，已暂停。可以重试，上一版稿件还在',
    TOOL_FAILURE_LOOP: '这一步重试了几次仍遇到同样的问题，已经暂停。可以查看最后一步的说明',
    TOOL_NO_PROGRESS: '助手一直读到相同的内容，这一步已暂停。可以使用已有材料重试',
    PROVIDER_RETRY_DEFERRED: '模型服务要求稍后再试。已保存的内容还在，可以在建议时间后继续',
    MODEL_OUTPUT_TRUNCATED: '模型回复太长，被截断了。已经保存的内容还在，可以重试这一步',
    MODEL_AUTHENTICATION_FAILED: '模型服务没有通过账号验证。请在模型设置里检查密钥',
    MODEL_RATE_LIMITED: '服务商限流，请稍后重试',
    MODEL_QUOTA_EXHAUSTED: '模型额度不足，请检查服务商账户',
    MODEL_NETWORK_ERROR: '无法连接模型服务。可以检查网络，或在模型设置里测试连接',
    MATERIAL_READ_REQUIRED: '授权材料尚未全部读取，写作未继续',
  }
  return labels[reason] ?? '这次运行已经停下。可以查看最后一步的说明，再回到对话决定是否重试'
}

export function runProgressSummary(run: RunRecordView): string {
  if (['STAGE_OUTPUT_NOT_SAVED', 'TOOL_FAILURE_LOOP', 'TOOL_NO_PROGRESS', 'PROVIDER_RETRY_DEFERRED'].includes(run.stopReason ?? '')) return runStopReasonLabel(run.stopReason!);
  if (run.status === 'waiting_user' && run.waitingFor === 'publication_selection') return '等待你选择标题 · 确认后继续核查，正文不重写';
  if (run.purpose === 'writing-pack:author-conversation') return run.status === 'completed'
    ? run.replyPreview || '这轮交流已保存，请在主对话中查看回复和下一步'
    : run.status === 'running' ? '正在回应你的想法' : run.stopReason === null ? runStatusLabel(run.status) : runStopReasonLabel(run.stopReason);
  if (run.purpose === 'writing-pack:intake') return run.status === 'completed'
    ? '这轮交流已保存，可以继续讨论或确认方向'
    : run.status === 'running' ? '正在理解你的想法，整理建议' : run.stopReason === null ? runStatusLabel(run.status) : runStopReasonLabel(run.stopReason);
  if (run.status === 'waiting_user' && run.stopReason === 'WRITING_INPUT_REQUIRED') {
    return '等待你补充必要信息 · 后续步骤不会继续'
  }
  if (run.status === 'completed') {
    if (run.publicationReady) return `全部 ${run.totalStages} 个阶段已保存 · 事实核查通过，可正式导出`
    if (run.stages.some(stage => stage.id === 'fact_check' && stage.status === 'completed')) {
      return '本次核查已保存 · 当前稿件能否导出，请查看「稿件与版本」'
    }
    return '阶段结果已保存 · 尚未达到交付条件，请处理核查问题'
  }
  if (run.status === 'waiting_user' && run.stopReason === 'CO_CREATION_CHECKPOINT') {
    const next = run.stages.find(stage => stage.status === 'pending')
    return next === undefined
      ? `已保存 ${run.completedStages}/${run.totalStages} 个阶段 · 等待你的确认`
      : `已保存 ${run.completedStages}/${run.totalStages} 个阶段 · 等待你确认后继续“${next.label}”`
  }
  const current = run.stages.find(stage => stage.status === 'running')
  if (current !== undefined) {
    return `已完成 ${run.completedStages}/${run.totalStages} · 正在处理：${current.label}`
  }
  const failed = run.stages.find(stage => stage.status === 'failed')
  if (failed !== undefined) return `停在“${failed.label}”阶段：${failed.detail}`
  if (run.totalStages > 0) return `已完成 ${run.completedStages}/${run.totalStages}`
  return run.stopReason === null ? '这次运行没有可用的阶段记录' : runStopReasonLabel(run.stopReason)
}

export function runDisplayStatus(run: RunRecordView): string {
  if (run.stopReason === 'STAGE_OUTPUT_NOT_SAVED') return '保存未完成 · 自动重写已暂停';
  if (run.stopReason === 'TOOL_FAILURE_LOOP') return '提交未通过 · 自动重试已暂停';
  if (run.stopReason === 'TOOL_NO_PROGRESS') return '重复读取无进展 · 已暂停';
  if (run.stopReason === 'PROVIDER_RETRY_DEFERRED') return '服务商要求等待 · 已暂停';
  if (run.status === 'waiting_user' && run.waitingFor === 'publication_selection') return '等待你选择标题';
  if (['writing-pack:intake', 'writing-pack:author-conversation'].includes(run.purpose ?? '') && run.status === 'completed') return '本轮交流已保存';
  if (run.status === 'completed' && !run.publicationReady) return run.stages.some(stage => stage.id === 'fact_check' && stage.status === 'completed')
    ? '本次核查已保存' : '尚未完成交付'
  return runStatusLabel(run.status)
}

export function runSavedStageLabel(run: RunRecordView): string {
  if (run.purpose === 'writing-pack:author-conversation') return '对话交流 · 不计为写作阶段';
  if (run.purpose === 'writing-pack:intake') return '对话澄清 · 尚未进入写作阶段';
  return `${run.completedStages}/${run.totalStages} 阶段已保存`
}
