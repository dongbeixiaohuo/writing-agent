import React, { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import type { BridgeSnapshot, DiagnosticOperationStatus, RunDiagnosticTraceStep, RunRecordView, RunTraceDetail } from '../../../client-bridge/src/protocol.ts'
import { RunDiagnostics } from './RunDiagnostics.tsx'

const MarkdownContent = lazy(async () => ({ default: (await import('./MarkdownContent.tsx')).MarkdownContent }))

const INITIAL_ROWS = 60
const PAGE_ROWS = 60

const STATUS: Readonly<Record<DiagnosticOperationStatus, string>> = {
  pending: '进行中', completed: '已完成', failed: '失败', outcome_unknown: '结果未知',
}

const ACTOR: Readonly<Record<string, string>> = {
  director: '写作导演', intake: '需求澄清助手', author: '作者交流', research: '资料研究', outline: '选题策划',
  draft: '内容主笔', review_editor: '编辑审校', review_publish: '发布审校', review_reader: '读者审校',
  central_revision: '修订主笔', language_review: '语言终审', title: '标题策划', fact_check: '事实核查',
}

const TOOL_LABEL: Readonly<Record<string, string>> = {
  search_fact_sources: '搜索事实来源', read_fact_source: '阅读事实来源原文', read_material: '读取参考材料',
  read_artifact_version: '读取历史版本', assess_writing_readiness: '检查写作信息', director_decide: '导演调度',
  submit_writing_stage: '保存写作阶段', submit_fact_check: '提交事实核查', submit_publication_candidates: '保存发布标题候选',
  respond_writing_intake: '保存需求交流', respond_author: '保存作者交流',
}

const TABS = [
  { id: 'overview', label: '概览' }, { id: 'input', label: '输入' }, { id: 'output', label: '输出' },
  { id: 'schema', label: 'Schema' }, { id: 'timing', label: '时序' },
] as const

type InspectorTab = typeof TABS[number]['id']
type RunTraceLiveActivity = NonNullable<BridgeSnapshot['liveActivity']>

export interface DetailLoadState {
  key: string | null
  request: number
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error' | 'unavailable'
  detail: RunTraceDetail | null
  message: string | null
}

type DetailLoadAction =
  | { type: 'start'; key: string; request: number }
  | { type: 'resolve'; key: string; request: number; detail: RunTraceDetail }
  | { type: 'reject'; key: string; request: number; message: string }
  | { type: 'not_persisted'; key: string; request: number }
  | { type: 'unavailable'; key: string; request: number }

export const INITIAL_DETAIL_LOAD_STATE: DetailLoadState = {
  key: null, request: 0, status: 'idle', detail: null, message: null,
}

export function reduceDetailLoadState(state: DetailLoadState, action: DetailLoadAction): DetailLoadState {
  if (action.type === 'start') return { key: action.key, request: action.request, status: 'loading', detail: null, message: null }
  if (action.key !== state.key || action.request !== state.request) return state
  if (action.type === 'resolve') return {
    ...state, status: action.detail.sections.length === 0 ? 'missing' : 'ready', detail: action.detail, message: null,
  }
  if (action.type === 'reject') return { ...state, status: 'error', detail: null, message: action.message }
  if (action.type === 'not_persisted') return { ...state, status: 'missing', detail: null, message: '尚未保存步骤详情' }
  return { ...state, status: 'unavailable', detail: null, message: null }
}

function duration(ms: number | null): string {
  if (ms === null) return '耗时未确定'
  if (ms < 1000) return `${ms} 毫秒`
  const seconds = Math.round(ms / 100) / 10
  if (seconds < 60) return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes} 分${remainder ? ` ${remainder} 秒` : ''}`
}

function clock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.valueOf()) ? '时间未记录' : date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function metric(ms: number | null): string {
  return ms === null ? '未收到' : duration(ms)
}

function liveModelLabel(activity: RunTraceLiveActivity): string {
  if (activity.lastEventKind === 'reasoning') return '模型内部处理中'
  if (activity.lastEventKind === 'content') return '正在返回可展示内容'
  if (activity.lastEventKind === 'tool_arguments') return '正在准备工具调用'
  if (activity.phase === 'waiting') return '等待模型响应'
  if (activity.phase === 'connected') return '模型已连接，等待有效内容'
  return '模型正在返回响应'
}

function liveStep(activity: RunTraceLiveActivity): RunDiagnosticTraceStep {
  return {
    id: `live:${activity.requestId}`, segmentId: `live:${activity.runId}`, occurredAt: new Date(activity.startedAt).toISOString(),
    completedAt: null, kind: 'model', status: 'pending', label: liveModelLabel(activity), requestId: activity.requestId,
    actorLabel: ACTOR[activity.actor] ?? activity.actor, durationMs: null, inputPreview: `第 ${activity.requestOrdinal ?? 1} 次模型请求`, errorCode: null,
  }
}

function liveToolStep(activity: RunTraceLiveActivity): RunDiagnosticTraceStep {
  const tool = activity.activeTool!
  return {
    id: `live-tool:${activity.requestId}:${tool.name}`, segmentId: `live:${activity.runId}`, occurredAt: new Date(tool.startedAt).toISOString(),
    completedAt: null, kind: tool.name === 'director_decide' ? 'agent' : 'tool', status: 'pending',
    label: TOOL_LABEL[tool.name] ?? '工具执行中', technicalName: tool.name, requestId: activity.requestId, actorLabel: ACTOR[activity.actor] ?? activity.actor,
    durationMs: null, errorCode: null,
  }
}

function compactTask(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 36 ? `${compact.slice(0, 36)}…` : compact
}

function selectionKey(runId: string, stepId: string): string {
  return JSON.stringify([runId, stepId])
}

function loadError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '详细历史读取失败。'
}

function displayStatus(record: RunRecordView, step: RunDiagnosticTraceStep): 'pending' | 'settled' {
  return step.status === 'pending' && (record.status === 'running' || record.status === 'queued') ? 'pending' : 'settled'
}

export function isNearTraceTail(metrics: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, threshold = 48): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

function SectionContent({ detail, sectionId }: { detail: RunTraceDetail | null; sectionId: 'input' | 'output' | 'schema' }) {
  const section = detail?.sections.find(item => item.id === sectionId)
  if (!section) return <p className="run-trace-missing">该步骤没有保存{sectionId === 'input' ? '输入或工具参数' : sectionId === 'output' ? '响应或工具结果' : '结构化 Schema'}。</p>
  return <div className="run-trace-payload">
    <div className="run-trace-payload-heading"><strong>{section.label}</strong><span>{section.totalCharacters.toLocaleString('zh-CN')} 字符{section.truncated ? ' · 已截断展示' : ''}</span></div>
    {section.format === 'json' ? <pre><code>{section.text}</code></pre> : <Suspense fallback={<pre><code>{section.text}</code></pre>}><MarkdownContent content={section.text} className="run-trace-markdown" /></Suspense>}
    {section.truncated && <p className="run-trace-notice">这是持久化详情的安全截断版本；界面不会自动请求未展示部分。</p>}
  </div>
}

export interface RunTraceProps {
  records: readonly RunRecordView[]
  activeRunId?: string | null | undefined
  liveActivity?: RunTraceLiveActivity | null | undefined
  loadDetail?: ((runId: string, stepId: string) => Promise<RunTraceDetail>) | undefined
  /** Test/SSR clock override; the interactive view refreshes once a second when omitted. */
  now?: number
}

export function RunTrace({ records, activeRunId = null, liveActivity = null, loadDetail, now }: RunTraceProps) {
  const [currentTime, setCurrentTime] = useState(() => now ?? Date.now())
  const [query, setQuery] = useState('')
  const [visibleRows, setVisibleRows] = useState(INITIAL_ROWS)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview')
  const [detailState, dispatchDetail] = useReducer(reduceDetailLoadState, INITIAL_DETAIL_LOAD_STATE)
  const detailRequest = useRef(0)
  const selectedStatus = useRef<{ key: string; status: 'pending' | 'settled' } | null>(null)
  const selectedIdentity = useRef<{ key: string; runId: string; requestId: string | undefined; kind: RunDiagnosticTraceStep['kind']; technicalName: string | undefined } | null>(null)
  const ledgerRef = useRef<HTMLElement | null>(null)
  const followingTail = useRef(true)
  const positionedScope = useRef<string | null>(null)
  const previousLatestKey = useRef<string | null>(null)
  const pendingScrollRestore = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const [showJumpLatest, setShowJumpLatest] = useState(false)

  useEffect(() => {
    if (now !== undefined) { setCurrentTime(now); return }
    if (activeRunId === null) return
    const timer = setInterval(() => setCurrentTime(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [activeRunId, now])

  const timeline = useMemo(() => records.flatMap(record => {
    const live = activeRunId === record.id && liveActivity?.runId === record.id ? liveActivity : null
    const liveActor = live ? ACTOR[live.actor] ?? live.actor : null
    let persisted = [...(record.diagnostics?.trace ?? [])].map(step => live?.requestId === step.requestId && !step.actorLabel && liveActor ? { ...step, actorLabel: liveActor } : step)
    if (live?.activeTool) {
      const activeTool = live.activeTool
      const liveRequestId = live.requestId
      persisted = persisted.map(step => step.kind === 'model' && step.requestId === liveRequestId && step.status === 'pending'
        ? { ...step, status: 'completed' as const, label: '模型响应', completedAt: new Date(activeTool.startedAt).toISOString(), durationMs: Math.max(0, activeTool.startedAt - Date.parse(step.occurredAt)), outputPreview: step.outputPreview ?? '已发起工具调用' }
        : step)
      if (!persisted.some(step => step.status === 'pending' && step.technicalName === activeTool.name)) persisted.push(liveToolStep(live))
    } else if (live && !persisted.some(step => step.kind === 'model' && step.requestId === live.requestId)) persisted.push(liveStep(live))
    const segmentLabels = new Map(record.diagnostics?.segments.map(segment => [segment.id, segment.label]) ?? [])
    const latestPendingId = persisted.findLast(step => step.status === 'pending')?.id
    return persisted.map(step => ({ record, live, step, latestPendingId, segmentLabel: segmentLabels.get(step.segmentId) ?? '执行段未记录', key: selectionKey(record.id, step.id) }))
  }).map((entry, order) => ({ ...entry, order }))
    .sort((left, right) => Date.parse(left.step.occurredAt) - Date.parse(right.step.occurredAt) || left.order - right.order),
  [records, activeRunId, liveActivity])

  const filteredTimeline = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return timeline
    return timeline.filter(({ record, step, segmentLabel }) => [record.displayInstruction, segmentLabel, step.label, step.actorLabel, step.technicalName, step.inputPreview, step.outputPreview, step.errorCode, step.requestId]
      .some(value => value?.toLocaleLowerCase('zh-CN').includes(needle)))
  }, [timeline, query])

  useEffect(() => setVisibleRows(INITIAL_ROWS), [query])

  const shownTimeline = filteredTimeline.slice(Math.max(0, filteredTimeline.length - visibleRows))
  const hiddenRows = Math.max(0, filteredTimeline.length - shownTimeline.length)
  const selectedEntry = timeline.find(entry => entry.key === selectedKey) ?? null
  const selectionIsShown = shownTimeline.some(entry => entry.key === selectedKey)
  const latestShownKey = shownTimeline.at(-1)?.key ?? null
  const ledgerScope = records[0]?.id ?? ''

  useEffect(() => {
    const ledger = ledgerRef.current
    if (!ledger) return
    const restore = pendingScrollRestore.current
    if (restore) {
      pendingScrollRestore.current = null
      ledger.scrollTop = restore.scrollTop + ledger.scrollHeight - restore.scrollHeight
      followingTail.current = isNearTraceTail(ledger)
      setShowJumpLatest(!followingTail.current)
      previousLatestKey.current = latestShownKey
      return
    }
    if (positionedScope.current !== ledgerScope) {
      positionedScope.current = ledgerScope
      ledger.scrollTop = ledger.scrollHeight
      followingTail.current = true
      setShowJumpLatest(false)
    } else if (previousLatestKey.current !== latestShownKey) {
      if (followingTail.current) ledger.scrollTop = ledger.scrollHeight
      else setShowJumpLatest(true)
    }
    previousLatestKey.current = latestShownKey
  }, [ledgerScope, latestShownKey, shownTimeline.length])

  const requestDetail = useCallback((runId: string, stepId: string, key: string) => {
    const request = ++detailRequest.current
    dispatchDetail({ type: 'start', key, request })
    if (stepId.startsWith('live:') || stepId.startsWith('live-tool:')) {
      dispatchDetail({ type: 'not_persisted', key, request })
      return
    }
    if (!loadDetail) { dispatchDetail({ type: 'unavailable', key, request }); return }
    void loadDetail(runId, stepId).then(
      detail => dispatchDetail({ type: 'resolve', key, request, detail }),
      error => dispatchDetail({ type: 'reject', key, request, message: loadError(error) }),
    )
  }, [loadDetail])

  const selectEntry = useCallback((entry: typeof timeline[number]) => {
    setSelectedKey(entry.key)
    setActiveTab('overview')
    selectedStatus.current = { key: entry.key, status: displayStatus(entry.record, entry.step) }
    selectedIdentity.current = { key: entry.key, runId: entry.record.id, requestId: entry.step.requestId, kind: entry.step.kind, technicalName: entry.step.technicalName }
    requestDetail(entry.record.id, entry.step.id, entry.key)
  }, [requestDetail])

  useEffect(() => {
    const identity = selectedIdentity.current
    if (selectedEntry || !selectedKey || identity?.key !== selectedKey || !identity.requestId) return
    const replacement = timeline.find(entry => entry.record.id === identity.runId
      && !entry.step.id.startsWith('live:') && !entry.step.id.startsWith('live-tool:')
      && entry.step.kind === identity.kind && entry.step.requestId === identity.requestId
      && entry.step.technicalName === identity.technicalName)
    if (!replacement) return
    selectedIdentity.current = { ...identity, key: replacement.key }
    selectedStatus.current = { key: replacement.key, status: displayStatus(replacement.record, replacement.step) }
    setSelectedKey(replacement.key)
    requestDetail(replacement.record.id, replacement.step.id, replacement.key)
  }, [requestDetail, selectedEntry, selectedKey, timeline])

  useEffect(() => {
    if (!selectedEntry) return
    const next = displayStatus(selectedEntry.record, selectedEntry.step)
    const previous = selectedStatus.current
    if (previous?.key === selectedEntry.key && previous.status === 'pending' && next === 'settled') requestDetail(selectedEntry.record.id, selectedEntry.step.id, selectedEntry.key)
    selectedStatus.current = { key: selectedEntry.key, status: next }
  }, [requestDetail, selectedEntry])

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown') nextIndex = Math.min(shownTimeline.length - 1, currentIndex + 1)
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1)
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = shownTimeline.length - 1
    if (nextIndex === null || nextIndex === currentIndex) return
    event.preventDefault()
    const next = shownTimeline[nextIndex]
    if (!next) return
    selectEntry(next)
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLButtonElement>('[data-trace-key]')].find(element => element.dataset.traceKey === next.key)?.focus())
  }

  function trackLedgerScroll() {
    const ledger = ledgerRef.current
    if (!ledger) return
    const nearTail = isNearTraceTail(ledger)
    followingTail.current = nearTail
    setShowJumpLatest(!nearTail)
  }

  function loadOlderRows() {
    const ledger = ledgerRef.current
    if (ledger) pendingScrollRestore.current = { scrollHeight: ledger.scrollHeight, scrollTop: ledger.scrollTop }
    setVisibleRows(value => value + PAGE_ROWS)
  }

  function jumpToLatest() {
    const ledger = ledgerRef.current
    if (!ledger) return
    followingTail.current = true
    setShowJumpLatest(false)
    if (typeof ledger.scrollTo === 'function') ledger.scrollTo({ top: ledger.scrollHeight, behavior: 'smooth' })
    else ledger.scrollTop = ledger.scrollHeight
  }

  if (timeline.length === 0) return <p className="run-trace-empty">还没有可显示的模型、Agent 或工具执行记录。</p>

  const selectedStep = selectedEntry?.step ?? null
  const selectedRecord = selectedEntry?.record ?? null
  const selectedLive = selectedEntry?.live && selectedStep?.kind === 'model' && selectedStep.status === 'pending' && selectedEntry.live.requestId === selectedStep.requestId ? selectedEntry.live : null
  const selectedRunOngoing = selectedRecord?.status === 'running' || selectedRecord?.status === 'queued'
  const selectedStopped = selectedStep?.status === 'pending' && !selectedRunOngoing
  const selectedIsCurrent = Boolean(selectedEntry && selectedRunOngoing && activeRunId === selectedRecord?.id && selectedStep?.status === 'pending')
  const selectedElapsed = selectedStep ? Math.max(0, currentTime - Date.parse(selectedStep.occurredAt)) : 0
  const detail = detailState.key === selectedKey ? detailState.detail : null

  return <div className="run-trace" aria-label="运行轨迹">
    <div className="run-trace-toolbar">
      <label><span className="run-trace-visually-hidden">搜索运行轨迹</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="在输入与结果摘要中搜索" /></label>
      <span>{query ? `找到 ${filteredTimeline.length} 条` : `显示最近 ${shownTimeline.length} 条，共 ${filteredTimeline.length} 条`}</span>
    </div>

    <div className="run-trace-workspace">
      <section className="run-trace-ledger" aria-label="运行步骤账本" ref={ledgerRef} onScroll={trackLedgerScroll}>
        {hiddenRows > 0 && <button type="button" className="run-trace-load-older" onClick={loadOlderRows}>加载更早 {Math.min(PAGE_ROWS, hiddenRows)} 条</button>}
        {shownTimeline.length === 0 ? <p className="run-trace-search-empty">没有匹配的输入、结果或步骤。</p> : <ol className="run-trace-list" role="listbox" aria-label="可选择的运行步骤">
          {shownTimeline.map((entry, index) => {
            const { record, live, step, latestPendingId, segmentLabel, key } = entry
            const liveModel = live !== null && step.kind === 'model' && live.requestId === step.requestId && step.status === 'pending' ? live : null
            const runOngoing = record.status === 'running' || record.status === 'queued'
            const stoppedPending = step.status === 'pending' && !runOngoing
            const isActivePending = runOngoing && activeRunId === record.id && step.status === 'pending' && (liveModel !== null || step.id === latestPendingId)
            const activeElapsed = Math.max(0, currentTime - Date.parse(step.occurredAt))
            const label = liveModel ? liveModelLabel(liveModel) : step.label
            const liveDetail = liveModel ? `${liveModel.lastEventKind === 'reasoning' ? '检测到模型内部处理活动；不展示私有推理内容。' : ''}${liveModel.receivedEvents ? ` 已接收 ${liveModel.receivedEvents} 个响应事件。` : ''}`.trim() : ''
            const stoppedDetail = stoppedPending ? `运行已结束，未记录${step.kind === 'model' ? '模型响应' : step.kind === 'tool' ? '工具完成' : 'Agent 调度完成'}结果。` : ''
            const stoppedElapsed = record.completedAt ? duration(Math.max(0, Date.parse(record.completedAt) - Date.parse(step.occurredAt))) : '结束耗时未记录'
            const isSelected = key === selectedKey
            return <li className={`run-trace-step run-trace-${step.kind} run-trace-${stoppedPending ? 'stopped' : step.status}${isActivePending ? ' run-trace-current' : ''}${isSelected ? ' run-trace-selected' : ''}`}
              key={key} role="presentation" data-run-id={record.id} data-step-id={step.id}>
              <button type="button" className="run-trace-select" role="option" aria-selected={isSelected} tabIndex={isSelected || (!selectionIsShown && index === 0) ? 0 : -1}
                aria-current={isActivePending ? 'step' : undefined} data-trace-key={key} onClick={() => selectEntry(entry)} onKeyDown={event => moveSelection(event, index)}>
                <time dateTime={step.occurredAt}>{clock(step.occurredAt)}</time><span className="run-trace-marker" aria-hidden="true" />
                <span className="run-trace-content">
                  <span className="run-trace-context" title={record.displayInstruction}>任务：{compactTask(record.displayInstruction)} · {segmentLabel}</span>
                  <span className="run-trace-summary"><strong>{step.actorLabel ? `${step.actorLabel} · ` : ''}{label}</strong><span className="run-trace-status">{stoppedPending ? '已停止等待' : STATUS[step.status]}</span>
                    {isActivePending && <span className="run-trace-current-label">当前活动</span>}<span>{stoppedPending ? stoppedElapsed : isActivePending ? `${step.kind === 'model' ? '已等待' : '已进行'} ${Math.floor(activeElapsed / 1000)} 秒` : duration(step.durationMs)}</span></span>
                  {liveDetail && <span className="run-trace-live-detail">{liveDetail}</span>}{stoppedDetail && <span className="run-trace-live-detail">{stoppedDetail}</span>}
                  {step.inputPreview && <span className="run-trace-preview"><b>输入</b>{step.inputPreview}</span>}{step.outputPreview && <span className="run-trace-preview"><b>输出</b>{step.outputPreview}</span>}
                  {step.stream && <span className="run-trace-stream">响应头 {metric(step.stream.headersMs)} · 首个有效内容（首个内容事件） {metric(step.stream.firstContentMs)} · 最后内容 {metric(step.stream.lastContentMs)}</span>}
                  {step.errorCode && <span className="run-trace-error">{step.errorCode}</span>}
                </span>
              </button>
            </li>
          })}
        </ol>}
        {showJumpLatest && <button type="button" className="run-trace-jump-latest" onClick={jumpToLatest}>回到最新步骤 <span aria-hidden="true">↓</span></button>}
      </section>

      <aside className="run-trace-inspector" aria-label="步骤详情检查器">
        <header><span>STEP INSPECTOR</span><h3>{selectedStep ? `${selectedStep.actorLabel ? `${selectedStep.actorLabel} · ` : ''}${selectedStep.label}` : '选择左侧步骤查看真实请求与结果'}</h3>
          {selectedEntry && <p>{selectedEntry.segmentLabel} · {clock(selectedStep!.occurredAt)}</p>}</header>
        <div className="run-trace-tabs" role="tablist" aria-label="详情分类">
          {TABS.map(tab => <button type="button" role="tab" key={tab.id} aria-selected={activeTab === tab.id} aria-controls="run-trace-panel" disabled={!selectedEntry} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
        </div>
        <div id="run-trace-panel" className="run-trace-panel" role="tabpanel">
          {!selectedEntry && <div className="run-trace-inspector-empty"><span aria-hidden="true">↳</span><p>选择一次模型请求、工具调用或 Agent 调度。详情只在选择后读取，不会批量加载历史载荷。</p></div>}
          {selectedEntry && activeTab === 'overview' && <div className="run-trace-overview">
            <dl className="run-trace-meta">
              <div><dt>状态</dt><dd>{selectedStopped ? '已停止等待' : STATUS[selectedStep!.status]}{selectedIsCurrent ? ' · 当前活动' : ''}</dd></div><div><dt>类型</dt><dd>{selectedStep!.kind === 'model' ? '模型请求' : selectedStep!.kind === 'tool' ? '工具调用' : 'Agent 调度'}</dd></div>
              <div><dt>耗时</dt><dd>{selectedStopped ? '运行结束前未完成' : selectedIsCurrent ? `${Math.floor(selectedElapsed / 1000)} 秒，仍在进行` : duration(selectedStep!.durationMs)}</dd></div><div><dt>技术名称</dt><dd>{selectedStep!.technicalName ?? '—'}</dd></div>
            </dl>
            {selectedStep!.inputPreview && <div className="run-trace-overview-summary"><span>输入摘要</span><p>{selectedStep!.inputPreview}</p></div>}{selectedStep!.outputPreview && <div className="run-trace-overview-summary"><span>结果摘要</span><p>{selectedStep!.outputPreview}</p></div>}
            {detailState.key === selectedKey && detailState.status === 'loading' && <p className="run-trace-notice" role="status">正在读取所选步骤的持久化详情…</p>}
            {detailState.key === selectedKey && detailState.status === 'error' && <div className="run-trace-load-error" role="alert"><strong>详细历史读取失败</strong><p>{detailState.message}</p><button type="button" onClick={() => requestDetail(selectedRecord!.id, selectedStep!.id, selectedKey!)}>重试</button></div>}
            {detailState.key === selectedKey && detailState.status === 'unavailable' && <p className="run-trace-notice">当前宿主尚未连接详细历史读取能力；账本摘要和时序仍可查看。</p>}
            {detailState.key === selectedKey && detailState.status === 'missing' && <div className="run-trace-missing-history"><strong>{detailState.message ?? '没有可用的原始历史'}</strong><p>{detailState.message ? '当前活动仍在内存中，完成并写入账本后才可读取请求、结果与 Schema。' : '该步骤存在于运行账本中，但没有保存请求、结果或 Schema。早期记录与中断写入可能出现此情况。'}</p></div>}
            {detail && <><dl className="run-trace-identifiers"><div><dt>Provider</dt><dd>{detail.provider ?? '未记录'}</dd></div><div><dt>Model</dt><dd>{detail.model ?? '未记录'}</dd></div><div><dt>Request ID</dt><dd>{detail.requestId ?? '未记录'}</dd></div><div><dt>Call ID</dt><dd>{detail.callId ?? '未记录'}</dd></div></dl>
              {detail.notes.length > 0 && <ul className="run-trace-notes">{detail.notes.map((note, index) => <li key={`${String(index)}:${note}`}>{note}</li>)}</ul>}</>}
            {selectedLive?.lastEventKind === 'reasoning' && <p className="run-trace-private-note">检测到模型内部处理活动。检查器不会展示或请求私有推理内容。</p>}
          </div>}
          {selectedEntry && (activeTab === 'input' || activeTab === 'output' || activeTab === 'schema') && <>{detailState.key === selectedKey && detailState.status === 'loading'
            ? <p className="run-trace-notice" role="status">正在读取{TABS.find(tab => tab.id === activeTab)?.label}…</p>
            : detailState.key === selectedKey && detailState.status === 'error'
              ? <div className="run-trace-load-error" role="alert"><strong>详细历史读取失败</strong><p>{detailState.message}</p><button type="button" onClick={() => requestDetail(selectedRecord!.id, selectedStep!.id, selectedKey!)}>重试</button></div>
              : detailState.key === selectedKey && detailState.status === 'unavailable' ? <p className="run-trace-notice">当前宿主尚未连接详细历史读取能力。</p> : <SectionContent detail={detail} sectionId={activeTab} />}</>}
          {selectedEntry && activeTab === 'timing' && <div className="run-trace-timing"><dl className="run-trace-meta">
            <div><dt>开始</dt><dd>{new Date(selectedStep!.occurredAt).toLocaleString('zh-CN', { hour12: false })}</dd></div><div><dt>完成</dt><dd>{selectedStep!.completedAt ? new Date(selectedStep!.completedAt).toLocaleString('zh-CN', { hour12: false }) : selectedStopped ? '运行已结束，步骤未完成' : '仍在进行'}</dd></div>
            <div><dt>总耗时</dt><dd>{selectedIsCurrent ? `${duration(selectedElapsed)}（进行中）` : duration(selectedStep!.durationMs)}</dd></div><div><dt>HTTP 状态</dt><dd>{selectedStep!.providerHttpStatus ?? '未报告'}</dd></div></dl>
            {selectedStep!.stream && <dl className="run-trace-waterfall"><div><dt>响应头</dt><dd>{metric(selectedStep!.stream.headersMs)}</dd></div><div><dt>首个有效内容</dt><dd>{metric(selectedStep!.stream.firstContentMs)}</dd></div><div><dt>最后内容</dt><dd>{metric(selectedStep!.stream.lastContentMs)}</dd></div><div><dt>内容事件</dt><dd>{selectedStep!.stream.contentEvents}</dd></div></dl>}
            {selectedStep!.transport && <div className="run-trace-transport"><strong>等待停止</strong><p>{selectedStep!.transport.phase === 'first_response' ? '首次有效响应超时' : '流式内容停滞'} · 本地时限 {duration(selectedStep!.transport.timeoutMs)}</p></div>}
            {!selectedStep!.stream && !selectedStep!.transport && <p className="run-trace-missing">该步骤没有更细的流式时序。</p>}
          </div>}
        </div>
      </aside>
    </div>

    {records.some(record => record.diagnostics) && <details className="run-trace-legacy"><summary>查看旧版分段统计</summary>{records.filter(record => record.diagnostics).map(record => <section key={record.id}><h4>{compactTask(record.displayInstruction)}</h4><RunDiagnostics diagnostics={record.diagnostics!} /></section>)}</details>}
  </div>
}
