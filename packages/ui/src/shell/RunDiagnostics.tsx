import React from 'react'
import type { DiagnosticOperationStatus, RunDiagnosticDecision, RunDiagnosticsView, WritingWorkflowStageId } from '../../../client-bridge/src/protocol.ts'
import { stageRoleCopy } from './interaction.ts'

const STATUS: Readonly<Record<DiagnosticOperationStatus, string>> = {
  pending: '进行中', completed: '已完成', failed: '失败', outcome_unknown: '结果未知',
}

function assignmentLabel(decision: RunDiagnosticDecision): string {
  const role = decision.actor === 'director' ? '写作导演' : decision.actor === 'title' ? '标题策划' : stageRoleCopy(decision.stage as WritingWorkflowStageId)?.role ?? decision.actor ?? '专家'
  const status = ({ dispatched: '已分派', finished: '已结束', rework: '安排返工', waiting_user: '等待用户' } as Record<string, string>)[decision.status ?? ''] ?? decision.status
  return [role, status, decision.stage ? `(${decision.stage})` : null].filter(Boolean).join(' · ')
}

function compactMaterialLabel(label: string): string {
  return label.replace(/^(需求对话) ([\da-f]{8})-[\da-f-]+$/iu, '$1 · $2')
}

function tally(value: { count: number; completed: number; failed: number; pending: number; outcomeUnknown: number }): string {
  return `${value.count} 次 · 完成 ${value.completed} · 失败 ${value.failed}${value.outcomeUnknown ? ` · 结果未知 ${value.outcomeUnknown}` : ''}${value.pending ? ` · 进行中 ${value.pending}` : ''}`
}

function usage(value: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null): string {
  if (value === null || [value.inputTokens, value.outputTokens, value.totalTokens].every(item => item === null)) return '用量未报告'
  return `输入 ${value.inputTokens ?? '未报告'} · 输出 ${value.outputTokens ?? '未报告'} · 总计 ${value.totalTokens ?? '未报告'} Token`
}

function streamTime(value: number | null | undefined): string {
  return value === undefined ? '未记录' : value === null ? '未收到' : `${(value / 1000).toFixed(1)} 秒`
}

export function RunDiagnostics({ diagnostics }: { diagnostics: RunDiagnosticsView }) {
  return <div className="run-diagnostics">
    {diagnostics.segments.map(segment => <section className="run-diagnostics-segment" key={segment.id}>
      <h4><span>{segment.label}</span><small> ｜ {segment.modelRequests.length} 次模型请求 · {segment.toolGroups.reduce((sum, group) => sum + group.count, 0)} 次工具调用</small></h4>
      {segment.decisions.length > 0 && <div className="run-diagnostics-block">
        <h5>导演与专家任务</h5>
        <ol>{segment.decisions.map(decision => <li key={decision.id}>
          <strong>{assignmentLabel(decision)}</strong>
          {decision.reason && <details className="run-diagnostics-reason"><summary>任务说明 · {decision.reason.replace(/\s+/gu, ' ').slice(0, 72)}{decision.reason.length > 72 ? '…' : ''}</summary><p>{decision.reason}</p></details>}
        </li>)}</ol>
      </div>}
      {segment.toolGroups.length > 0 && <div className="run-diagnostics-block">
        <h5>工具操作</h5>
        <p className="run-diagnostics-help">Agent 负责判断和生成内容；工具负责读取、保存或调度。工具完成不等于整篇文章完成。</p>
        {segment.toolGroups.map(group => <details className="run-diagnostics-group" key={group.toolName}>
          <summary><strong>{group.label}</strong><span> · {tally(group)}</span></summary>
          <dl className="run-diagnostics-tool-info">
            <dt>工具名称：</dt><dd><code>{group.toolName}</code>{group.category ? ` · ${group.category}` : ''}</dd>
            <dt>作用：</dt><dd>{group.description ?? '此历史快照未包含工具用途说明。'}</dd>
            <dt>调用者：</dt><dd>{group.callers?.map(caller => `${caller.label}（${caller.count} 次）`).join('、') || '未记录调用者'}</dd>
            <dt>执行结果：</dt><dd>{group.outcomes?.length ? group.outcomes.map(outcome => `${outcome.label}（${outcome.count} 次）`).join('；') : tally(group)}</dd>
          </dl>
          {group.targets && <ul>{group.targets.map(target => <li key={`${target.id}:${target.versionId ?? ''}`}>
            <span>{compactMaterialLabel(target.label)}</span>
            <small>{tally(target)}{target.versionId ? ` · 版本 ${target.versionId.slice(0, 8)}` : ''}</small>
            <details className="run-diagnostics-identifiers"><summary>查看完整标识</summary><p>材料 / 稿件 ID：{target.id}<br />版本 ID：{target.versionId ?? '未记录'}</p></details>
            {target.errorCodes.length > 0 && <small className="run-diagnostics-error">失败 code：{target.errorCodes.join('、')}</small>}
          </li>)}</ul>}
          {group.errorCodes.length > 0 && <p className="run-diagnostics-error">失败 code：{group.errorCodes.join('、')}</p>}
        </details>)}
      </div>}
      {segment.modelRequests.length > 0 && <details className="run-diagnostics-block run-diagnostics-models">
        <summary>模型请求 · {segment.modelRequests.length} 次 · 失败 {segment.modelRequests.filter(request => request.status === 'failed').length} · 结果未知 {segment.modelRequests.filter(request => request.status === 'outcome_unknown').length}</summary>
        <ol>{segment.modelRequests.map((request, index) => <li key={request.id}>
          <span>模型请求 {index + 1} · {STATUS[request.status]} · {request.durationMs === null ? '耗时未确定' : `${(request.durationMs / 1000).toFixed(1)} 秒`}</span>
          <small>{usage(request.usage)}{request.errorCode ? ` · ${request.errorCode}` : ''}</small>
          {request.stream && <small>连接（响应头）：{streamTime(request.stream.headersMs)}
            {request.stream.reasoningEvents !== undefined && <> · 推理活动：首次 {streamTime(request.stream.firstReasoningMs)}，最后 {streamTime(request.stream.lastReasoningMs)}，共 {request.stream.reasoningEvents} 次</>}
            {' · '}有效内容：首次 {streamTime(request.stream.firstContentMs)}，最后 {streamTime(request.stream.lastContentMs)}，共 {request.stream.contentEvents} 次 · 总耗时：{request.durationMs === null ? '未确定' : `${(request.durationMs / 1000).toFixed(1)} 秒`}</small>}
          {request.transport && <small>客户端停止等待：{request.transport.phase === 'first_response' ? '首次有效响应超时' : '流式内容停滞'} · 时限 {request.transport.timeoutMs / 1000} 秒（不代表服务商返回错误）</small>}
          {request.providerHttpStatus && <small>服务商 HTTP 状态：{request.providerHttpStatus}</small>}
        </li>)}</ol>
      </details>}
    </section>)}
  </div>
}
