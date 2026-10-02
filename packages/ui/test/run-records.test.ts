import assert from 'node:assert/strict'
import test from 'node:test'

import type { RunRecordView } from '../../client-bridge/src/protocol.ts'
import { runProgressSummary, runStatusLabel, runStopReasonLabel } from '../src/shell/run-records.ts'
import * as progress from '../src/shell/run-records.ts'
import { checkpointCopy, checkpointResumeInstruction, composerRecoveryMode, recoveryContinueAction, stageRoleCopy } from '../src/shell/interaction.ts'

function record(overrides: Partial<RunRecordView> = {}): RunRecordView {
  return {
    id: 'run-1',
    status: 'running',
    displayInstruction: '写一篇说明稿',
    startedAt: '2026-09-18T10:00:00.000Z',
    completedAt: null,
    stopReason: null,
    modelRequests: 4,
    maxModelRequests: 12,
    toolCalls: 3,
    maxToolCalls: 12,
    totalTokens: 1200,
    stages: [
      { id: 'research', label: '研究与证据', status: 'completed', detail: '已保存' },
      { id: 'outline', label: '文章提纲', status: 'completed', detail: '已保存' },
      { id: 'draft', label: '完整初稿', status: 'running', detail: '正在处理' },
    ],
    completedStages: 2,
    totalStages: 3,
    publicationReady: false,
    ...overrides,
  }
}

test('internal loop protection is not presented as a user spending budget', () => {
  assert.equal(runStatusLabel('budget_exhausted'), '已触发运行保护');
  assert.match(runStopReasonLabel('BUDGET_EXHAUSTED'), /内部调用上限/u);
  assert.doesNotMatch(runStopReasonLabel('BUDGET_EXHAUSTED'), /缩小|预算已用完/u);
  assert.match(runStopReasonLabel('MODEL_QUOTA_EXHAUSTED'), /服务商账户/u);
});

test('a paused invalid-output stage does not look like an expert still running', () => {
  const run = record({status:'waiting_user',stopReason:'STAGE_OUTPUT_NOT_SAVED'});
  assert.match(progress.runDisplayStatus(run),/保存未完成.*暂停/);
  assert.match(runProgressSummary(run),/保存校验/);
  assert.doesNotMatch(runProgressSummary(run),/正在处理|外部请求结果未知/);
});

test('invalid model output is explained without an internal code or blaming the user configuration', () => {
  const message = runStopReasonLabel('MODEL_RESPONSE_INVALID');
  assert.match(message, /回复.*格式/u);
  assert.doesNotMatch(message, /MODEL_RESPONSE_INVALID|检查.*配置|更换模型/u);
});

test('output truncation is not described as a schema error or account quota problem', () => {
  assert.match(runStopReasonLabel('MODEL_OUTPUT_TRUNCATED'), /输出.*上限/u);
  assert.doesNotMatch(runStopReasonLabel('MODEL_OUTPUT_TRUNCATED'), /格式校验|账户|MODEL_OUTPUT_TRUNCATED/u);
});

test('missing writing inputs ask for an answer instead of approval or a generic retry', () => {
  const recovery = {
    runId: 'run-1', sessionId: 'session-1', status: 'waiting_user' as const,
    stopReason: 'WRITING_INPUT_REQUIRED', checkpointStage: null, nextStage: 'research' as const,
    inputRequest: { reason: '材料只有 test，无法确定文章内容。', questions: ['具体想写什么主题？', '有哪些可用的事实或个人经历？'] },
  }
  const copy = checkpointCopy(recovery, undefined)
  assert.equal(copy.title, '需要补充信息，写作已暂停')
  assert.equal(copy.description, recovery.inputRequest.reason)
  assert.equal(copy.primaryAction, '补充并继续')
  assert.match(runProgressSummary(record({ status: 'waiting_user', stopReason: recovery.stopReason, completedStages: 0 })), /等待你补充.*不会继续/u)
  assert.match(runStopReasonLabel(recovery.stopReason), /补充/u)
  assert.equal(composerRecoveryMode([recovery], 'session-1'), 'answer')
  assert.equal(composerRecoveryMode([recovery], 'other-session'), null)
  assert.equal(composerRecoveryMode([{ ...recovery, stopReason: 'UNKNOWN_EXTERNAL_OUTCOME' }], 'session-1'), 'decision')
})

test('run progress copy exposes the current stage instead of a generic running state', () => {
  assert.equal(runStatusLabel('running'), '正在写作')
  assert.equal(runProgressSummary(record()), '已完成 2/3 · 正在处理：完整初稿')
})

test('author discussion completion is not mislabeled as failed delivery', () => {
  const run = record({ purpose: 'writing-pack:author-conversation', status: 'completed', stages: [], totalStages: 0, completedStages: 0 });
  assert.equal(progress.runDisplayStatus(run), '本轮交流已保存');
  assert.match(runProgressSummary(run), /交流已保存/u);
  assert.doesNotMatch(runProgressSummary(run), /交付条件|核查问题/u);
  assert.equal(progress.runSavedStageLabel(run), '对话交流 · 不计为写作阶段');
});

test('run history includes the actual author reply instead of sending the user elsewhere to find it', () => {
  const replyPreview = '你想用哪一个标题？确认标题后继续核查。';
  assert.equal(runProgressSummary(record({ purpose: 'writing-pack:author-conversation', status: 'completed', replyPreview })), replyPreview);
});

test('title choice is not described as missing material in run history', () => {
  const run = record({ status: 'waiting_user', stopReason: 'WRITING_INPUT_REQUIRED', waitingFor: 'publication_selection' });
  assert.match(runProgressSummary(run), /标题.*核查/u);
  assert.doesNotMatch(runProgressSummary(run), /补充必要信息/u);
  assert.equal(progress.runDisplayStatus(run), '等待你选择标题');
});

test('completed run copy distinguishes publication-ready and blocked delivery', () => {
  assert.equal(
    runProgressSummary(record({ status: 'completed', completedStages: 3, publicationReady: true })),
    '全部 3 个阶段已保存 · 事实核查通过，可正式导出',
  )
  assert.equal(
    runProgressSummary(record({ status: 'completed', completedStages: 3, publicationReady: false })),
    '阶段结果已保存 · 尚未达到交付条件，请处理核查问题',
  )
  assert.equal(progress.runDisplayStatus(record({ status: 'completed', publicationReady: false })), '尚未完成交付')
  assert.equal(progress.runSavedStageLabel(record({ status: 'completed', completedStages: 3 })), '3/3 阶段已保存')
  assert.doesNotMatch(progress.runSavedStageLabel(record()), /%/u)
})

test('main composer can respond to a co-creation checkpoint, but not retry an unknown outcome', () => {
  const recovery = { runId: 'run-1', sessionId: 'session-1', status: 'waiting_user' as const, stopReason: 'CO_CREATION_CHECKPOINT' }
  assert.equal(composerRecoveryMode([recovery], 'session-1'), 'answer')
  assert.equal(composerRecoveryMode([{ ...recovery, stopReason: 'UNKNOWN_EXTERNAL_OUTCOME' }], 'session-1'), 'decision')
  assert.equal(composerRecoveryMode([
    { ...recovery, runId: 'unknown', stopReason: 'UNKNOWN_EXTERNAL_OUTCOME' },
    recovery,
  ], 'session-1'), 'answer')
})

test('checkpoint approval uses the natural reply path without authorizing an unrelated unknown retry', () => {
  const checkpoint = { runId: 'checkpoint', sessionId: 'session-1', status: 'waiting_user' as const, stopReason: 'CO_CREATION_CHECKPOINT' }
  const unknown = { ...checkpoint, runId: 'unknown', stopReason: 'UNKNOWN_EXTERNAL_OUTCOME' }

  assert.deepEqual(recoveryContinueAction(checkpoint), {
    kind: 'message',
    text: '认可当前阶段，继续下一步',
  })
  assert.deepEqual(recoveryContinueAction(unknown), {
    kind: 'resume',
    decision: 'retry_unknown',
  })
})

test('co-creation checkpoint is described as a saved user decision point', () => {
  assert.equal(runStatusLabel('waiting_user'), '等待你的决定')
  assert.equal(
    runProgressSummary(record({
      status: 'waiting_user',
      stopReason: 'CO_CREATION_CHECKPOINT',
      stages: [
        { id: 'research', label: '研究与证据', status: 'completed', detail: '已保存' },
        { id: 'outline', label: '文章提纲', status: 'completed', detail: '已保存' },
        { id: 'draft', label: '完整初稿', status: 'pending', detail: '等待前序阶段' },
      ],
    })),
    '已保存 2/3 个阶段 · 等待你确认后继续“完整初稿”',
  )
  assert.equal(runStopReasonLabel('CO_CREATION_CHECKPOINT'), '等待你确认当前共创阶段')
  assert.equal(runStopReasonLabel('UNKNOWN_EXTERNAL_OUTCOME'), '外部请求结果未知，需要你决定是否重试')
  assert.equal(runStopReasonLabel('MODEL_UNSUPPORTED'), '当前模型不可用，请检查模型 ID 或重新验证连接')
  assert.equal(runStopReasonLabel('UNLISTED_INTERNAL_CODE'), '运行已停止（UNLISTED_INTERNAL_CODE）')
})

test('title discussion is a choice checkpoint, not missing writing material', () => {
  const copy = checkpointCopy({ runId: 'title', sessionId: 's', status: 'waiting_user', stopReason: 'WRITING_INPUT_REQUIRED',
    checkpointStage: null, nextStage: 'fact_check', inputRequest: { kind: 'publication_selection', reason: '需要讨论标题', questions: ['选题'] } }, undefined)
  assert.match(copy.title, /标题/u)
  assert.doesNotMatch(copy.title + copy.description + copy.feedbackPlaceholder, /补充信息|补齐|缺少|格式/u)
  assert.match(copy.feedbackPlaceholder, /不满意|换|修改/u)
  assert.equal(copy.primaryAction, '发送意见')
})

test('co-creation checkpoints expose a human role, a real next step, and user feedback', () => {
  const copy = checkpointCopy({
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'waiting_user',
    stopReason: 'CO_CREATION_CHECKPOINT',
    checkpointStage: 'outline',
    nextStage: 'draft',
  }, record({ status: 'waiting_user', stopReason: 'CO_CREATION_CHECKPOINT' }))

  assert.equal(copy.role, '选题策划')
  assert.match(copy.title, /提纲/u)
  assert.match(copy.description, /内容主笔/u)
  assert.equal(stageRoleCopy('fact_check').role, '事实核查')
  assert.equal(checkpointResumeInstruction('  压到 3000 字  '), '压到 3000 字')
  assert.equal(checkpointResumeInstruction('   '), '认可当前阶段，继续下一步')
})
