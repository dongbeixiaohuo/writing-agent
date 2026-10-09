import assert from 'node:assert/strict'
import test from 'node:test'
import { checkpointCopy, composerRecoveryMode, recoveryContinueAction, conversationWorkingCopy } from '../src/shell/interaction.ts'
import type { RecoverableRunSummary } from '../../client-bridge/src/protocol.ts'

test('all-reader failure has an explicit retry action, not author-approval or input homework', () => {
  const recovery:RecoverableRunSummary = {runId:'r', sessionId:'s', status:'waiting_user', stopReason:'PARALLEL_TEXT_ALL_FAILED', checkpointStage:null, nextStage:null};
  const copy = checkpointCopy(recovery, undefined);
  assert.equal(copy.role, '模拟读者');
  assert.equal(copy.primaryAction, '重试模拟读者');
  assert.match(copy.description, /只重试读者阶段/);
  assert.deepEqual(recoveryContinueAction(recovery), {kind:'resume', decision:'resume'});
  assert.equal(composerRecoveryMode([recovery], 's'), 'decision');
})

test('reader confirmation invites author reactions rather than editorial instructions', () => {
  const recovery:RecoverableRunSummary = {runId:'r', sessionId:'s', status:'waiting_user', stopReason:'CO_CREATION_CHECKPOINT',
    checkpointStage:'review_reader', nextStage:'central_revision'};
  const copy = checkpointCopy(recovery, undefined);
  assert.equal(copy.role, '模拟读者');
  assert.match(copy.title, /感受.*怎么看/);
  assert.doesNotMatch(copy.title, /建议/);
  assert.match(copy.description, /写作导演.*你的取舍/);
  assert.match(copy.feedbackPlaceholder, /我更希望/);
})

test('live timer names execution accumulation rather than the current stage and resets at resume boundary', () => {
  const activity = { runId: 'r', requestId: 'q', actor: 'outline', phase: 'waiting' as const,
    startedAt: 320000, segmentStartedAt: 0, lastActivityAt: null, requestOrdinal: 1 }
  const copy = conversationWorkingCopy(activity, 410000)
  assert.equal(copy.elapsedSeconds, 410)
  assert.match(copy.detail, /当前请求已等待 90 秒/u)
  assert.match(copy.detail, /包含此前阶段，不是当前阶段耗时/u)
  assert.equal(conversationWorkingCopy({ ...activity, segmentStartedAt: 400000, startedAt: 400000 }, 410000).elapsedSeconds, 10)
})

test('version-bound confirmation and legacy rework gates use a direct action and leave conversation available', () => {
  for (const stopReason of ['CO_CREATION_CHECKPOINT', 'TOOL_FAILURE_LOOP']) {
    const recovery: RecoverableRunSummary = { runId:'r', sessionId:'s', status:'waiting_user', stopReason,
      checkpointStage:'central_revision', nextStage:'language_review',
      checkpointApproval:{ eventSeq:7, bodyVersionId:'body', briefVersionId:'brief' } }
    assert.deepEqual(recoveryContinueAction(recovery), {kind:'resume', decision:'resume'})
    assert.equal(composerRecoveryMode([recovery], 's'), 'answer')
    assert.match(checkpointCopy(recovery, undefined).primaryAction, /认可当前阶段/u)
    if (stopReason === 'TOOL_FAILURE_LOOP') assert.match(checkpointCopy(recovery, undefined).description, /不再让模型重新判断按钮含义/u)
  }
})

test('checkpoint action names the next expert, including title before fact checking', () => {
  const checkpoint = (checkpointStage: RecoverableRunSummary['checkpointStage'], nextStage: RecoverableRunSummary['nextStage']) =>
    checkpointCopy({ runId: 'r', sessionId: 's', status: 'waiting_user', stopReason: 'CO_CREATION_CHECKPOINT', checkpointStage, nextStage }, undefined)
  assert.match(checkpoint('outline', 'draft').primaryAction, /内容主笔/u)
  assert.match(checkpoint('language_review', 'fact_check').primaryAction, /标题策划/u)
  assert.match(checkpoint('language_review', 'fact_check').description, /标题.*事实/u)
  assert.match(checkpoint('review_editor', 'review_publish').description, /修改.*本阶段|返工/u)
})

test('version permission failures are explained as program conflicts, not missing user evidence', () => {
  const copy = checkpointCopy({ runId: 'r', sessionId: 's', status: 'waiting_user', stopReason: 'TOOL_FAILURE_LOOP', checkpointStage: null, nextStage: null,
    validationFailure: { code: 'TOOL_PERMISSION_DENIED', tool: 'read_artifact_version', explanation: '调度读取版本与权限冲突。这不是文章事实核查不通过，也不是你缺少材料。' } }, undefined)
  assert.match(copy.title, /读取版本.*程序冲突/)
  assert.match(copy.description, /不是文章事实核查不通过/)
  assert.equal(copy.primaryAction, '重试这一步')
})

test('repeated stage-save rejection offers one explicit retry without claiming a connection failure', () => {
  const copy = checkpointCopy({ runId:'r', sessionId:'s', status:'waiting_user', stopReason:'STAGE_OUTPUT_NOT_SAVED', checkpointStage:null, nextStage:'language_review' }, undefined)
  assert.equal(copy.primaryAction, '重试这一步')
  assert.match(copy.title, /上一版稿件仍在/)
  assert.match(copy.description, /保存校验/)
  assert.doesNotMatch(copy.title, /超时|连接|额度/)
})

test('protected writing offers explicit continuation without asking for title confirmation again', () => {
  const copy = checkpointCopy({ runId: 'r', sessionId: 's', status: 'budget_exhausted', stopReason: 'BUDGET_EXHAUSTED', checkpointStage: null, nextStage: null }, undefined)
  assert.equal(copy.primaryAction, '继续未完成步骤')
  assert.match(copy.description, /不重做/)
})

import type {
  FactCheckWorkspace,
  ProjectSummary,
  SessionSummary,
} from '../../client-bridge/src/protocol.ts'
import { publicationGateNotice, factVerificationNotice } from '../src/shell/publication-gate.ts'
import {
  projectNavigationTarget,
  resumeSessionForProject,
} from '../src/shell/project-navigation.ts'

const project: ProjectSummary = {
  id: 'project-a',
  name: '既有项目',
  sessionIds: ['session-old', 'session-waiting', 'session-latest'],
  revision: 3,
  latestProjectSeq: 8,
}

const sessions: readonly SessionSummary[] = [
  { id: 'session-old', projectId: 'project-a', title: '旧会话', relativeTime: '昨天', status: 'completed' },
  { id: 'session-waiting', projectId: 'project-a', title: '待确认', relativeTime: '刚刚', status: 'waiting_user' },
  { id: 'session-latest', projectId: 'project-a', title: '最新会话', relativeTime: '现在', status: 'completed' },
  { id: 'session-other', projectId: 'project-b', title: '其他项目', relativeTime: '现在', status: 'running' },
]

function factWorkspace(overrides: Partial<FactCheckWorkspace> = {}): FactCheckWorkspace {
  return {
    status: 'blocked',
    snapshot: null,
    assessment: {
      status: 'blocked',
      claimsHash: 'claims',
      reportHash: 'report',
      blockers: ['C001'],
      claims: [{
        claimId: 'C001',
        claimText: '性能提升 40%',
        location: '正文第二段',
        status: 'NEEDS_USER_SOURCE',
        risk: 'red',
        supportScope: 'none',
        evidenceId: null,
        sourceReference: null,
        evidenceSummary: '没有可发布来源',
        recommendedAction: '补充来源，或删除具体比例',
      }],
    },
    invalidations: [],
    provenance: [],
    notice: '核查说明',
    ...overrides,
  }
}

test('project navigation resumes the current or actionable existing session', () => {
  assert.equal(resumeSessionForProject(project, sessions, 'session-old'), 'session-old')
  assert.equal(resumeSessionForProject(project, sessions, 'session-other'), 'session-waiting')
  assert.equal(
    resumeSessionForProject({ ...project, sessionIds: ['session-old', 'session-latest'] }, sessions, 'session-other'),
    'session-latest',
  )
  assert.equal(resumeSessionForProject({ ...project, sessionIds: [] }, sessions, ''), null)
})

test('an existing project without sessions opens a new conversation state', () => {
  assert.deepEqual(
    projectNavigationTarget({ ...project, id: 'project-empty', name: 'test', sessionIds: [] }, sessions, ''),
    { kind: 'new_conversation', projectId: 'project-empty' },
  )
})

test('blocked publication gate copy exposes the reason and next action in conversation', () => {
  const notice = publicationGateNotice(factWorkspace())
  assert.notEqual(notice, null)
  assert.match(notice?.title ?? '', /1 项核查问题/u)
  assert.doesNotMatch(JSON.stringify(notice), /需要你处理|暂不能正式交付/u)
  assert.equal(notice?.items[0]?.summary, '性能提升 40%')
  assert.equal(notice?.items[0]?.action, '补充来源，或删除具体比例')
})

test('agent handling and an existing author question suppress duplicate fact notices', () => {
  assert.equal(publicationGateNotice(factWorkspace(), 'agent_handling'), null)
  assert.equal(publicationGateNotice(factWorkspace(), 'author_question'), null)
  assert.equal(publicationGateNotice(factWorkspace({ status: 'stale' }), 'agent_handling'), null)
})

test('old medium/low blockers ask for a fresh lightweight review, not source homework', () => {
  const original = factWorkspace();
  const workspace = factWorkspace({ assessment: { ...original.assessment!, claims: [{ ...original.assessment!.claims[0]!, risk: 'yellow' }] } });
  const notice = publicationGateNotice(workspace);
  assert.match(notice!.title, /轻量规则重新核查/u);
  assert.deepEqual(notice!.items, []);
  assert.match(notice!.description, /无需逐条处理/u);
  assert.equal(workspace.status, 'blocked', 'historic immutable gate is not silently rewritten');
})

test('mixed historic blockers count only important facts in the conversation notice', () => {
  const original = factWorkspace();
  const important = original.assessment!.claims[0]!;
  const workspace = factWorkspace({ assessment: { ...original.assessment!,
    claims: [important, { ...important, claimId: 'ordinary', risk: 'yellow' }],
    blockers: [important.claimId, 'ordinary'],
  } });
  const notice = publicationGateNotice(workspace)!;
  assert.match(notice.title, /1 项核查问题/u);
  assert.deepEqual(notice.items.map(item => item.id), [important.claimId]);
  assert.deepEqual(workspace.assessment!.blockers, [important.claimId, 'ordinary'], 'history is retained');
})

test('stale and passed gates are distinguished without a false blocker', () => {
  assert.match(
    publicationGateNotice(factWorkspace({ status: 'stale', assessment: null }))?.title ?? '',
    /核查结果已失效/u,
  )
  assert.equal(publicationGateNotice(factWorkspace({ status: 'passed', assessment: { ...factWorkspace().assessment!, status: 'passed', blockers: [] } })), null)
})

test('verification disclosure comes from saved evidence, not current search settings', () => {
  const workspace = factWorkspace({ status: 'passed' })
  const claim = workspace.assessment!.claims[0]!
  workspace.assessment = { ...workspace.assessment!, claims: [{ ...claim, sourceReference: 'model-knowledge:unverified' }] }
  assert.match(factVerificationNotice(workspace), /仅模型复核，未联网验证/)
  workspace.assessment = { ...workspace.assessment!, claims: [{ ...claim, sourceReference: 'https://example.com/source' }] }
  assert.match(factVerificationNotice(workspace), /来源引用/)
  assert.doesNotMatch(factVerificationNotice(workspace), /联网验证通过/)
  workspace.assessment = { ...workspace.assessment!, claims: [] }
  assert.match(factVerificationNotice(workspace), /未记录外部事实查证依据/)
})
