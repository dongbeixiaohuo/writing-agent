import assert from 'node:assert/strict'
import test from 'node:test'
import { checkpointCopy } from '../src/shell/interaction.ts'

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
import { publicationGateNotice } from '../src/shell/publication-gate.ts'
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

test('stale and passed gates are distinguished without a false blocker', () => {
  assert.match(
    publicationGateNotice(factWorkspace({ status: 'stale', assessment: null }))?.title ?? '',
    /核查结果已失效/u,
  )
  assert.equal(publicationGateNotice(factWorkspace({ status: 'passed', assessment: { ...factWorkspace().assessment!, status: 'passed', blockers: [] } })), null)
})
