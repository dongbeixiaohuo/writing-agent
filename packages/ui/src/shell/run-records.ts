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
    UNKNOWN_EXTERNAL_OUTCOME: '外部请求结果未知，需要你决定是否重试',
    USER_CANCELLED: '你已停止这次运行',
    BUDGET_EXHAUSTED: '已达到程序内部调用上限，本轮已停止；这不是服务商账户额度不足，已保存内容仍保留',
    MODEL_BUDGET_EXHAUSTED: '本次运行已达到模型请求上限',
    TOOL_BUDGET_EXHAUSTED: '本次运行已达到工具调用上限',
    REVISION_BUDGET_EXHAUSTED: '本次运行已达到重大修订上限',
    MODEL_UNSUPPORTED: '当前模型不可用，请检查模型 ID 或重新验证连接',
    MODEL_RESPONSE_INVALID: '模型回复未通过格式校验，本轮未完成；你的输入仍保留，可以重试，反复出现请反馈运行记录',
    STAGE_OUTPUT_NOT_SAVED: '本阶段生成结果反复未通过保存校验，已停止自动重写；上一版稿件保留。这是阶段输出问题，不是账户额度或连接问题',
    TOOL_FAILURE_LOOP: '程序提交反复被同一门禁拒绝，已停止自动重试；已保存内容保留。这是内容校验问题，不是账户额度或连接问题',
    MODEL_OUTPUT_TRUNCATED: '模型回复达到单次输出长度上限而被截断，本阶段未完成；残缺内容未保存，已有阶段仍保留，无需重填资料',
    MODEL_AUTHENTICATION_FAILED: '模型鉴权失败，请检查 API Key',
    MODEL_RATE_LIMITED: '服务商限流，请稍后重试',
    MODEL_QUOTA_EXHAUSTED: '模型额度不足，请检查服务商账户',
    MODEL_NETWORK_ERROR: '无法连接模型服务，请检查网络与 Base URL',
    MATERIAL_READ_REQUIRED: '授权材料尚未全部读取，写作未继续',
  }
  return labels[reason] ?? `运行已停止（${reason}）`
}

export function runProgressSummary(run: RunRecordView): string {
  if (run.stopReason === 'STAGE_OUTPUT_NOT_SAVED' || run.stopReason === 'TOOL_FAILURE_LOOP') return runStopReasonLabel(run.stopReason);
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
    return run.publicationReady
      ? `全部 ${run.totalStages} 个阶段已保存 · 事实核查通过，可正式导出`
      : '阶段结果已保存 · 尚未达到交付条件，请处理核查问题'
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
  return run.stopReason ?? '这次运行没有可用的阶段记录'
}

export function runDisplayStatus(run: RunRecordView): string {
  if (run.stopReason === 'STAGE_OUTPUT_NOT_SAVED') return '保存未完成 · 自动重写已暂停';
  if (run.stopReason === 'TOOL_FAILURE_LOOP') return '提交未通过 · 自动重试已暂停';
  if (run.status === 'waiting_user' && run.waitingFor === 'publication_selection') return '等待你选择标题';
  if (['writing-pack:intake', 'writing-pack:author-conversation'].includes(run.purpose ?? '') && run.status === 'completed') return '本轮交流已保存';
  if (run.status === 'completed' && !run.publicationReady) return '尚未完成交付'
  return runStatusLabel(run.status)
}

export function runSavedStageLabel(run: RunRecordView): string {
  if (run.purpose === 'writing-pack:author-conversation') return '对话交流 · 不计为写作阶段';
  if (run.purpose === 'writing-pack:intake') return '对话澄清 · 尚未进入写作阶段';
  return `${run.completedStages}/${run.totalStages} 阶段已保存`
}
