import clsx from 'clsx'
import { RunDiagnostics } from './RunDiagnostics.tsx'
import { RunTrace, type RunTraceProps } from './RunTrace.tsx'
import './RunTrace.css'
import { ConversationWorking } from './ConversationWorking.tsx'
import { conversationWithPreview } from './conversation-stream.ts'
import './RunDiagnostics.css'
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type {
  BriefSummary,
  BridgeHandshake,
  BridgeSnapshot,
  ClientBridge,
  RecoverableRunSummary,
  RunRecordView,
  TimelineItem,
} from '../../../client-bridge/src/protocol.ts'
import type {
  DesktopDiagnosticExportResultView,
  DesktopDiagnosticPreviewView,
  DesktopHostConfiguration,
  DesktopLegacyMigrationPlanView,
  DesktopLegacyMigrationResultView,
  DesktopLegacySourceKind,
  DesktopProviderStatusView,
  DesktopWorkspaceBackupResultView,
  DesktopWorkspaceRestorePreviewView,
  DesktopWorkspaceRestoreResultView,
} from '../../../client-bridge/src/desktop-bridge.ts'
import { BrandMark } from '../brand/BrandMark.tsx'
import {
  WRITING_AGENT_BRAND,
  type WritingAgentBrand,
} from '../brand/config.ts'
import {
  panelInstanceKey,
  type WritingUiRegistry,
} from '../extensions/contracts.ts'
import {
  applyThemeMode,
  createThemeStyle,
  THEME_MODE_OPTIONS,
  WRITING_AGENT_LAYOUT,
  WRITING_AGENT_THEME,
  type WritingAgentLayoutConfig,
  type WritingAgentThemeConfig,
} from '../theme/config.ts'
import appFrameCss from '../upstream/layout/AppFrame.module.css'
import { computeColumns } from '../upstream/layout/columns.ts'
import { Button } from '../upstream/primitives/Button.tsx'
import inputCss from '../upstream/conversation/InputBar.module.css'
import sidebarCss from '../upstream/sidebar/SidebarRoot.module.css'
import {
  ArrowUpIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  FolderIcon,
  MonitorIcon,
  MoonIcon,
  PanelIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  StopIcon,
  SunIcon,
  TrashIcon,
  ToolIcon,
} from './Icons.tsx'
import css from './WritingAgentShell.module.css'
import { aboutVersionView } from './about.ts'
import { conversationFollowTarget, CONVERSATION_FOLLOW_THRESHOLD } from './conversation-follow.ts'
import { checkpointCopy, composerRecoveryMode, recoveryContinueAction, stageRoleCopy, stageRoleLabel, runRecordsTabLabel } from './interaction.ts'
import { MarkdownContent } from './MarkdownContent.tsx'
import { runProgressSummary, runDisplayStatus, runSavedStageLabel, runStopReasonLabel } from './run-records.ts'
import { publicationGateNotice, factVerificationNotice } from './publication-gate.ts'
import { ConversationExportCard } from './ConversationExportCard.tsx'
import { ConversationRevisionCard } from './ConversationRevisionCard.tsx'
import { projectNavigationTarget } from './project-navigation.ts'
import { ProviderSettings } from './ProviderSettings.tsx'
import { SearchSettings } from './SearchSettings.tsx'
import {
  commandErrorMessage,
  dataActionErrorMessage,
  materialPatchFromFile,
  normalizeBriefUpdate,
  normalizeProjectSetup,
  setupErrorMessage,
  styleReferenceFromFile,
  type BriefUpdateForm,
  type ProjectSetupForm,
} from './onboarding.ts'

export interface WritingAgentShellProps {
  bridge: ClientBridge
  extensions: WritingUiRegistry
  brand?: WritingAgentBrand
  themeConfig?: WritingAgentThemeConfig
  layout?: WritingAgentLayoutConfig
  hostConfiguration?: DesktopHostConfiguration
}

type SettingsSection = 'general' | 'models' | 'search' | 'data' | 'about'

function useFrameWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth)

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      if (next !== undefined) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return width
}

const DIALOG_FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString('zh-CN')} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function useModalDialog(onClose: () => void): RefObject<HTMLElement> {
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE))
      .filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true')
    const initialFocus = dialog.querySelector<HTMLElement>('[data-initial-focus]') ?? focusable()[0]
    initialFocus?.focus()

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusable()
      if (elements.length === 0) {
        event.preventDefault()
        return
      }
      const first = elements[0]
      const last = elements[elements.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active)) {
        event.preventDefault()
        first?.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousFocus?.focus()
    }
  }, [])

  return dialogRef
}

function Timeline({ items, brand, footer, diagnostic = false }: { items: readonly TimelineItem[]; brand: WritingAgentBrand; footer?: ReactNode; diagnostic?: boolean }) {
  if (items.length === 0 && footer === undefined) return <p className={css.emptyTimeline}>此会话还没有内容。</p>
  return (
    <div className={css.timeline} aria-live="polite">
      {items.filter(item => diagnostic || (item.kind === 'message' ? item.audience !== 'diagnostic' : item.audience === 'conversation')).map(item => item.kind === 'message' ? (
        <article
          className={clsx(css.message, item.role === 'user' ? css.userMessage : css.assistantMessage)}
          data-conversation-message={item.role}
          data-message-id={item.id}
          aria-label={item.streaming ? '正在生成的回复' : undefined}
          aria-busy={item.streaming ? true : undefined}
          key={item.id}
        >
          {item.role === 'assistant' && item.stage && <header className={css.expertHeading} data-expert-stage={item.stage}>
            <span className={css.expertBadge} aria-hidden="true">{stageRoleCopy(item.stage).role.slice(0, 1)}</span>
            <div><strong>{stageRoleLabel(item.stage)}</strong><span>{stageRoleCopy(item.stage).action}</span></div>
          </header>}
          {item.role === 'assistant' && !item.stage && item.actorLabel && <header className={css.expertHeading} data-actor-label={item.actorLabel}>
            <span className={css.expertBadge} aria-hidden="true">{item.actorLabel.slice(0, 1)}</span>
            <div><strong>{item.actorLabel}</strong></div>
          </header>}
          <MarkdownContent content={item.body.replace(/^按刚才确认的方向继续：(#+\s)/u, '按刚才确认的方向继续：\n\n$1')} className={css.messageBody} />
          <div className={css.messageMeta}>{item.streaming ? `${item.streaming === 'saving' ? '正在保存' : '正在生成'} · 尚未保存` : `${item.role === 'user' ? '你' : item.stage ? stageRoleLabel(item.stage) : item.actorLabel ?? brand.assistantName} · ${item.createdAt}`}
            {!item.streaming && item.role === 'assistant' && item.activeDurationMs != null && ` · 本阶段活动耗时 ${Math.round(item.activeDurationMs / 1000)} 秒（排除等待确认）`}
          </div>
        </article>
      ) : (
        <div className={css.toolRow} key={item.id}>
          <span className={clsx(css.toolState, item.state === 'pending' && css.toolPending, item.state === 'failure' && css.toolFailure)}>
            {item.state === 'success' ? <CheckIcon /> : <ToolIcon />}
          </span>
          <strong>{item.label}</strong>
          <span>· {item.detail}</span>
        </div>
      ))}
      {footer}
    </div>
  )
}

function WorkflowProgress({ run, detailed = false }: { run: RunRecordView; detailed?: boolean }) {
  const percent = run.totalStages === 0
    ? 0
    : Math.round((run.completedStages / run.totalStages) * 100)
  return <section className={clsx(css.workflowProgress, detailed && css.workflowProgressDetailed)} aria-label="写作工作流进度">
    <div className={css.workflowProgressHeader}>
      <div><span className={css.runStatus} data-run-status={run.status}>{runDisplayStatus(run)}</span><strong>{runProgressSummary(run)}</strong></div>
      {run.totalStages > 0 && <span>{runSavedStageLabel(run)}</span>}
    </div>
    {run.totalStages > 0 && <>
      {detailed && <div className={css.workflowProgressTrack} aria-label="阶段保存进度，不代表交付就绪"><span style={{ width: `${percent}%` }} /></div>}
      <ol className={detailed ? css.stageExecutionList : css.workflowStages}>
        {run.stages.map(stage => <li key={stage.id} data-stage-status={stage.status}>
          <span className={css.workflowStageIcon}>{stage.status === 'completed' ? <CheckIcon /> : <ToolIcon />}</span>
          <div><strong>{stage.label}</strong><small>{stageRoleCopy(stage.id).role}{detailed ? ` · ${stage.detail}` : ''}</small>
            {stage.activeDurationMs != null && <small>已记录活动耗时 {Math.round(stage.activeDurationMs / 1000)} 秒（含恢复与返工，排除等待确认）</small>}
            {detailed && <><p>{stageRoleCopy(stage.id).action}</p>
              {(run.diagnostics?.segments.some(segment => segment.decisions.some(decision => decision.stage === stage.id))) && <details>
                <summary>查看本阶段分派与返工记录</summary>
                {run.diagnostics?.segments.flatMap(segment => segment.decisions.filter(decision => decision.stage === stage.id).map(decision =>
                  <p key={decision.id}><small>{segment.label} · {decision.status === 'rework' ? '返工' : '导演安排'}</small>{decision.reason}</p>))}
              </details>}
            </>}
          </div>
        </li>)}
      </ol>
    </>}
  </section>
}

export function CheckpointDecisionCard({
  bridge,
  recovery,
  run,
  onInspect,
  onContinued,
  runActive,
  canApproveCheckpoint,
}: {
  bridge: ClientBridge
  recovery: RecoverableRunSummary
  run: RunRecordView | undefined
  onInspect: () => void
  onContinued: () => void
  runActive: boolean
  canApproveCheckpoint: boolean
}) {
  const copy = checkpointCopy(recovery, run)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isCheckpoint = recovery.stopReason === 'CO_CREATION_CHECKPOINT' || !!recovery.checkpointApproval
  const needsInput = recovery.stopReason === 'WRITING_INPUT_REQUIRED'
  const isTitleDiscussion = recovery.inputRequest?.kind === 'publication_selection'
  const searchRecovery = recovery.inputRequest?.kind === 'search_recovery' ? recovery.inputRequest.searchRecovery : undefined

  const decideSearch = async (action: 'retry' | 'extend' | 'continue'): Promise<void> => {
    if (busy || !searchRecovery) return
    try {
      setBusy(true); setError(null)
      await bridge.resumeRun(recovery.runId, 'resume', { factSearchDecision: { requestId: searchRecovery.requestId, action } })
      onContinued()
    } catch (reason) { setError(commandErrorMessage(reason, '搜索决定未能保存，请重试。')) }
    finally { setBusy(false) }
  }

  const resume = async (): Promise<void> => {
    if (busy) return
    try {
      setBusy(true)
      setError(null)
      const action = recoveryContinueAction(recovery)
      if (recovery.checkpointApproval) await bridge.resumeRun(recovery.runId, 'resume', { checkpointApproval: recovery.checkpointApproval })
      else if (action.kind === 'message') await bridge.sendMessage(action.text)
      else await bridge.resumeRun(recovery.runId, action.decision)
      onContinued()
    } catch (reason) {
      setError(commandErrorMessage(reason, '继续运行失败，请重试。'))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (busy) return
    try {
      setBusy(true)
      setError(null)
      await bridge.cancelRun(recovery.runId)
    } catch (reason) {
      setError(commandErrorMessage(reason, '结束本轮失败，请重试。'))
    } finally {
      setBusy(false)
    }
  }

  // Normal confirmation is asked once, at the end of the saved timeline result.
  // Keep cancellation available without creating a second conversation card.
  if (isCheckpoint && !isTitleDiscussion) return <div className={css.checkpointActions} data-conversation-recovery="true" aria-label="共创确认操作">
    <p className={css.checkpointDescription}>{copy.description}</p>
    <button className={css.textActionNeutral} type="button" disabled={busy || runActive} onClick={() => void stop()}>结束本轮</button>
    {canApproveCheckpoint && <button className={css.primaryAction} type="button" disabled={busy || runActive} onClick={() => void resume()}>
      {busy ? '正在继续…' : copy.primaryAction}
    </button>}
    {error !== null && <p className={css.checkpointError} role="alert">{error}</p>}
  </div>

  return <section className={css.checkpointCard} data-conversation-recovery="true"
    aria-label={searchRecovery ? '搜索恢复决定' : isTitleDiscussion ? '待选标题' : needsInput ? '待补充信息' : isCheckpoint ? '共创决策' : '写作暂停'}>
    <div className={css.checkpointHeader}>
      <div className={css.checkpointRole} aria-hidden="true">{copy.role.slice(0, 1)}</div>
      <div><span>{copy.role} · {copy.eyebrow}</span><h2>{copy.title}</h2></div>
    </div>
    <p className={css.checkpointDescription}>{copy.description}</p>
    {searchRecovery && <p>检索词：{searchRecovery.query}<br />检索额度 {searchRecovery.used}/{searchRecovery.limit} · 网络尝试 {searchRecovery.attemptsUsed}/{searchRecovery.attemptsLimit}。不再搜索不会丢弃已有来源，结论会明确说明未联网核对的条目。</p>}
    {needsInput && !!recovery.inputRequest?.questions.length && <ol>{recovery.inputRequest.questions.map((question, index) => <li key={index}>{question}</li>)}</ol>}
    {isTitleDiscussion && !!recovery.inputRequest?.candidates?.length && <ol aria-label="标题候选">
      {recovery.inputRequest.candidates.map((candidate, index) => <li key={index}><strong>{candidate.title}</strong>
        <details><summary>查看标题说明与分发文案</summary><p>{candidate.rationale}</p>{candidate.distributionCopy && <p>分发文案：{candidate.distributionCopy}</p>}</details></li>)}
    </ol>}
    {(isCheckpoint || needsInput) && <p className={css.checkpointReplyHint}>
      {isTitleDiscussion ? '你想用哪一个？在下方主对话中告诉我，例如“就用第二个吧”；也可以继续提意见。确认标题后继续核查，正文不重写。'
        : needsInput ? '在下方主对话中回答或补充即可；有疑问也可以直接问我。'
          : '在下方主对话中告诉我是否继续，或直接提出修改意见。'}
    </p>}
    {error !== null && <p className={css.checkpointError} role="alert">{error}</p>}
    <div className={css.checkpointActions}>
      <button className={css.textActionNeutral} type="button" disabled={busy || runActive} onClick={() => void stop()}>结束本轮</button>
      <div>
        <button className={css.secondaryAction} type="button" disabled={busy} onClick={onInspect}>打开稿件与过程</button>
        {searchRecovery && <><button className={css.secondaryAction} type="button" disabled={busy || runActive} onClick={() => void decideSearch('continue')}>不再搜索，继续核查</button>
          <button className={css.primaryAction} type="button" disabled={busy || runActive} onClick={() => void decideSearch(searchRecovery.kind === 'limit' ? 'extend' : 'retry')}>{searchRecovery.kind === 'limit' ? '追加3次搜索' : '重试本次搜索'}</button></>}
        {!searchRecovery && !isCheckpoint && !needsInput && <button className={css.primaryAction} type="button" disabled={busy || runActive} onClick={() => void resume()}>
          {busy ? '正在继续…' : copy.primaryAction}
        </button>}
      </div>
    </div>
  </section>
}

function PublicationGateNoticeCard({
  snapshot,
  onInspect,
}: {
  snapshot: BridgeSnapshot
  onInspect: () => void
}) {
  if (snapshot.previewDocument.status === 'empty') return null
  const hasQuestion = snapshot.recoverableRuns.some(run => run.sessionId === snapshot.selectedSessionId && run.status === 'waiting_user' && (run.stopReason === 'WRITING_INPUT_REQUIRED' || run.stopReason === 'CO_CREATION_CHECKPOINT'))
  const notice = publicationGateNotice(snapshot.factCheckWorkspace, snapshot.connection === 'running' ? 'agent_handling' : hasQuestion ? 'author_question' : 'idle')
  if (notice === null) return null
  return <section
    className={clsx(css.publicationGateNotice, notice.tone === 'danger' ? css.publicationGateDanger : css.publicationGateWarning)}
    data-gate-status={snapshot.factCheckWorkspace.status}
    role="alert"
  >
    <div className={css.publicationGateHeader}>
      <div><span>{notice.eyebrow}</span><h2>{notice.title}</h2></div>
      <button type="button" onClick={onInspect}>查看并处理</button>
    </div>
    <p>{notice.description}</p>
    {notice.items.length > 0 && <ul className={css.publicationGateItems}>
      {notice.items.map(item => <li key={item.id}>
        <strong>{item.summary}</strong>
        <span>建议：{item.action}</span>
      </li>)}
    </ul>}
  </section>
}

export function RunRecords({ records, activeRunId, liveActivity, loadDetail }: { records: readonly RunRecordView[]; activeRunId?: string | null; liveActivity?: BridgeSnapshot['liveActivity']; loadDetail?: RunTraceProps['loadDetail'] }) {
  if (records.length === 0) return <div className={css.emptyRunRecords}><strong>还没有运行记录</strong><span>提交第一条写作指令后，这里会显示每个阶段的真实进度、用量和结果。</span></div>
  return <div className={css.runRecords}>
    <div className={css.runRecordsIntro}><h2>运行记录</h2><p>按时间查看 Agent、模型和工具的实际执行过程。选择一步查看当时的输入、回复、工具参数、结果与耗时；只有实际调用了搜索才会显示搜索记录。详情按需读取，历史缺失不会补造。</p></div>
    <RunTrace records={records} activeRunId={activeRunId} liveActivity={liveActivity} loadDetail={loadDetail} />
    <details><summary>写作阶段与累计用量</summary>
    {[...records].reverse().map(run => <article className={css.runRecordCard} key={run.id}>
      <div className={css.runRecordHeader}>
        <div><span>{run.purpose === 'writing-pack:intake' ? '需求交流' : run.purpose === 'writing-pack:author-conversation' ? '改稿与讨论' : run.totalStages > 1 ? `写作流程 · ${run.totalStages} 个阶段` : run.purpose === 'writing-pack:fact-check' ? '专项事实核查' : '专项处理'}{run.diagnostics ? ` · ${run.diagnostics.segments.length} 次执行（含续接）` : ''}</span><h3>{run.displayInstruction.startsWith('按刚才确认的方向继续：') ? '按已确认的写作方向继续' : run.displayInstruction}</h3></div>
        <time dateTime={run.startedAt}>{new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(run.startedAt))}</time>
      </div>
      <WorkflowProgress run={run} detailed />
      <dl className={css.runUsage}>
        <div><dt>本执行段模型请求</dt><dd>{run.modelRequests} / {run.maxModelRequests}</dd></div>
        <div><dt>本执行段工具调用</dt><dd>{run.toolCalls} / {run.maxToolCalls}</dd></div>
        <div><dt>本记录累计 Token</dt><dd>{run.totalTokens === null ? '服务商未报告' : run.totalTokens.toLocaleString('zh-CN')}</dd></div>
      </dl>
      {run.stopReason !== null && run.status !== 'completed' && <p className={css.runStopReason}>当前状态：{run.waitingFor === 'publication_selection' ? runProgressSummary(run) : runStopReasonLabel(run.stopReason)}</p>}
      {run.diagnostics && run.diagnostics.segments.length > 0
        ? <details className={css.runActivity}><summary>执行详情 · 模型、工具与调度记录</summary><RunDiagnostics diagnostics={run.diagnostics} /></details>
        : (run.activity?.length ?? 0) > 0 && <details className={css.runActivity}><summary>执行详情 · 模型、工具与调度记录</summary><Timeline items={run.activity!} brand={WRITING_AGENT_BRAND} diagnostic /></details>}
    </article>)}</details>
  </div>
}

interface ComposerSubmission {
  restoreFocus: boolean
  pendingDraft: string
}

function ModelSwitchMenu({ host, currentLabel, offline, running, onOpenSettings }: {
  host: DesktopHostConfiguration
  currentLabel: string
  offline: boolean
  running: boolean
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<DesktopProviderStatusView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('mousedown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const toggle = async (): Promise<void> => {
    if (busy) return
    if (open) { setOpen(false); return }
    setOpen(true); setLoading(true); setError(null)
    try { setStatus(await host.providerStatus('summary')) }
    catch (reason) { setError(commandErrorMessage(reason, '模型配置读取失败，请重试。')) }
    finally { setLoading(false) }
  }

  const choose = async (profileId: string, model: string): Promise<void> => {
    if (busy) return
    setBusy(true); setError(null)
    try { await host.selectProvider(profileId, model); setOpen(false) }
    catch (reason) { setError(commandErrorMessage(reason, '模型切换失败，请稍后重试。')) }
    finally { setBusy(false) }
  }

  // summary mode intentionally skips credential reads, so `configured` is
  // always false and `credentialChecked` is false for every profile. Treat
  // "not checked" as "key was saved at some point"; the host still verifies
  // the credential on selectProvider and reports a missing key then.
  const choices = (status?.profiles ?? []).filter(profile => profile.configured || profile.credentialChecked === false)
    .flatMap(profile => profile.models.map(model => ({ profile, model })))

  return <div className={css.modelSwitchRoot} ref={rootRef}>
    <button type="button" aria-label={`切换模型，当前 ${currentLabel}`} aria-expanded={open} aria-haspopup="menu"
      onClick={() => void toggle()}
      className={clsx(css.connectionPill, css.connectionAction, offline && css.connectionOffline, running && css.connectionRunning)}>
      {currentLabel}⌄</button>
    {open && <div className={css.modelSwitchMenu} role="menu" aria-label="可切换的模型">
      {loading && <p className={css.modelSwitchHint} role="status">正在读取已配置的模型…</p>}
      {busy && <p className={css.modelSwitchHint} role="status">正在切换模型，请稍候…</p>}
      {!loading && error === null && choices.length === 0 && <p className={css.modelSwitchHint}>没有已保存 Key 的模型可切换，请先在模型设置中完成配置。</p>}
      {!loading && choices.map(({ profile, model }) => {
        const active = profile.profileId === status?.activeProfileId && model === status.model
        return <button key={`${profile.profileId}:${model}`} type="button" role="menuitemradio" aria-checked={active}
          className={css.modelSwitchItem} disabled={busy || active} onClick={() => void choose(profile.profileId, model)}>
          <span className={css.modelSwitchItemMain}>{model}<small>{profile.displayName}</small></span>
          {active && <span className={css.modelSwitchCurrent}>当前使用</span>}
        </button>
      })}
      {error !== null && <p className={css.modelSwitchError} role="alert">{error}</p>}
      <div className={css.modelSwitchFooter}>
        <button type="button" className={css.providerCustomize} onClick={() => { setOpen(false); onOpenSettings() }}>管理模型设置…</button>
      </div>
    </div>}
  </div>
}

function ConversationMinimap({ scrollRef, itemCount }: {
  scrollRef: RefObject<HTMLElement | null>
  itemCount: number
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [markers, setMarkers] = useState<readonly { top: number; height: number }[]>([])
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const [scrollable, setScrollable] = useState(false)

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    const measure = (): void => {
      const scrollHeight = container.scrollHeight
      const canScroll = scrollHeight > container.clientHeight + 1
      setScrollable(canScroll)
      const trackHeight = trackRef.current?.clientHeight ?? 0
      if (!canScroll || trackHeight <= 0) {
        setMarkers([])
        return
      }
      const base = container.getBoundingClientRect().top
      const next: { top: number; height: number }[] = []
      container.querySelectorAll('[data-message-id]').forEach(element => {
        const rect = element.getBoundingClientRect()
        next.push({
          top: ((rect.top - base + container.scrollTop) / scrollHeight) * trackHeight,
          height: Math.max(2, (rect.height / scrollHeight) * trackHeight),
        })
      })
      setMarkers(next)
      setViewport({
        top: (container.scrollTop / scrollHeight) * trackHeight,
        height: (container.clientHeight / scrollHeight) * trackHeight,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [scrollRef, itemCount, scrollable])

  useEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    let raf = 0
    const onScroll = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const trackHeight = trackRef.current?.clientHeight ?? 0
        const scrollHeight = container.scrollHeight
        if (trackHeight <= 0 || scrollHeight <= 0) return
        setViewport({
          top: (container.scrollTop / scrollHeight) * trackHeight,
          height: (container.clientHeight / scrollHeight) * trackHeight,
        })
      })
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => { container.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [scrollRef])

  const jump = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const container = scrollRef.current
    const track = trackRef.current
    if (container === null || track === null) return
    const rect = track.getBoundingClientRect()
    const fraction = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    container.scrollTo({ top: fraction * container.scrollHeight - container.clientHeight / 2, behavior: 'smooth' })
  }

  return <div
    ref={trackRef}
    className={css.minimap}
    style={{ display: scrollable ? undefined : 'none' }}
    role="presentation"
    aria-label="对话位置快速定位"
    onClick={jump}
  >
    {scrollable && <>
      <div className={css.minimapViewport} style={{ top: viewport.top, height: viewport.height }} />
      {markers.map((marker, index) => <div key={index} className={css.minimapMarker} style={{ top: marker.top, height: marker.height }} />)}
    </>}
  </div>
}

function Composer({ bridge, hero = false, newProject = false, initialDraft = '', focusRequest = 0, onSubmitted, onHandoffConsumed, onConfigureModel, hostConfiguration }: {
  bridge: ClientBridge
  hero?: boolean
  newProject?: boolean
  initialDraft?: string
  focusRequest?: number
  onSubmitted?: (submission: ComposerSubmission) => void
  onHandoffConsumed?: () => void
  onConfigureModel?: () => void
  hostConfiguration?: DesktopHostConfiguration | undefined
}) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const editorRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(initialDraft)
  const submittingRef = useRef(false)
  // The editable DOM owns the text and IME composition. React only needs the
  // two button/placeholder flags, not a rerender for every character.
  const [draftEmpty, setDraftEmpty] = useState(initialDraft.length === 0)
  const [draftSendable, setDraftSendable] = useState(initialDraft.trim().length > 0)
  const [composing, setComposing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const running = snapshot.activeRunId !== null
  const recoveryMode = composerRecoveryMode(snapshot.recoverableRuns, snapshot.selectedSessionId)
  const waitingForRecovery = recoveryMode === 'decision'
  const modelConfigured = snapshot.settings.credentialReference !== null
  const writable = snapshot.connection !== 'offline' && modelConfigured && (newProject || !waitingForRecovery)

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (editor !== null && initialDraft.length > 0 && (editor.textContent ?? '').length === 0) {
      editor.textContent = initialDraft
    }
  }, [])

  useLayoutEffect(() => {
    if (focusRequest > 0) editorRef.current?.focus()
    onHandoffConsumed?.()
  }, [focusRequest])

  const submit = async (): Promise<void> => {
    if (draftRef.current.trim().length === 0 || running || submittingRef.current || !writable) return
    const submittedDraft = draftRef.current
    const editor = editorRef.current
    const editorWasFocused = document.activeElement === editor
    try {
      setError(null)
      submittingRef.current = true
      setSubmitting(true)
      if (newProject || snapshot.selectedProjectId.length === 0) await bridge.startConversation(submittedDraft)
      else await bridge.sendMessage(submittedDraft)
      const pendingDraft = draftRef.current === submittedDraft ? '' : draftRef.current
      draftRef.current = pendingDraft
      setDraftEmpty(pendingDraft.length === 0)
      setDraftSendable(pendingDraft.trim().length > 0)
      if (editorRef.current !== null && pendingDraft.length === 0) editorRef.current.textContent = ''
      const activeElement = document.activeElement
      const restoreFocus = editorWasFocused && (
        activeElement === editor || activeElement === document.body || activeElement === null || !activeElement.isConnected
      )
      onSubmitted?.({ restoreFocus, pendingDraft })
      requestAnimationFrame(() => {
        const currentEditor = editorRef.current
        const currentActive = document.activeElement
        if (restoreFocus && currentEditor !== null && (
          currentActive === currentEditor || currentActive === document.body || currentActive === null || !currentActive.isConnected
        )) currentEditor.focus()
      })
    } catch (reason) {
      setError(commandErrorMessage(reason, '写作命令提交失败，请稍后重试。'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
      event.preventDefault()
      void submit()
    }
  }

  const stop = async (): Promise<void> => {
    if (snapshot.activeRunId === null) return
    try {
      setError(null)
      await bridge.cancelRun(snapshot.activeRunId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '停止运行失败')
    }
  }

  return (
    <div className={clsx(inputCss.root, hero && inputCss.hero, hero && css.heroComposer)}>
      <div className={inputCss.card}>
        <div className={inputCss.scroll}>
          <div className={inputCss.grow}>
            <div
              ref={editorRef}
              className={clsx(inputCss.input, css.composerInput)}
              contentEditable={writable}
              role="textbox"
              aria-label="写作指令"
              aria-multiline="true"
              data-composer-composing={composing ? '' : undefined}
              suppressContentEditableWarning
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onInput={event => {
                const nextDraft = event.currentTarget.textContent ?? ''
                draftRef.current = nextDraft
                setDraftEmpty(nextDraft.length === 0)
                setDraftSendable(nextDraft.trim().length > 0)
              }}
              onKeyDown={onKeyDown}
            />
            {draftEmpty && <div className={inputCss.placeholder}>
              {!modelConfigured
                  ? '请先配置模型，再开始写作'
                  : !newProject && waitingForRecovery
                    ? snapshot.recoverableRuns.some(run => run.sessionId === snapshot.selectedSessionId && run.interruption?.source === 'model')
                      ? '写作暂时暂停，请点击上方的“重试这一步”'
                      : '写作暂时暂停，请先选择上方的恢复操作'
                  : newProject || snapshot.brief?.confirmationStatus !== 'confirmed'
                    ? '说说你的想法，或直接粘贴材料，我们一起把文章想清楚…'
                  : recoveryMode === 'answer'
                    ? '在这里回答问题、确认方向或提出修改意见…'
                  : '描述想写的内容，或说明要处理的材料…'}
            </div>}
          </div>
        </div>
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <span className={css.composerContext}>{newProject || snapshot.brief?.confirmationStatus !== 'confirmed' ? '从一句想法开始，边聊边完善' : '可随时补充材料、调整方向或提出修改'}</span>
          </div>
          <div className={inputCss.trailing}>
            {modelConfigured
              ? (hostConfiguration !== undefined
                ? <ModelSwitchMenu host={hostConfiguration} currentLabel={snapshot.settings.providerLabel} offline={snapshot.connection === 'offline'} running={running} onOpenSettings={() => onConfigureModel?.()} />
                : <button type="button" aria-label={`切换模型，当前 ${snapshot.settings.providerLabel}`} onClick={onConfigureModel} className={clsx(css.connectionPill, css.connectionAction, snapshot.connection === 'offline' && css.connectionOffline, running && css.connectionRunning)}>{snapshot.settings.providerLabel}⌄</button>)
              : <button className={clsx(css.connectionPill, css.connectionAction, css.connectionUnconfigured)} type="button" onClick={onConfigureModel}>模型未配置 · 去设置</button>}
            <button
              className={inputCss.primary}
              type="button"
              aria-label={running ? '停止生成' : submitting ? '正在启动写作' : '发送'}
              disabled={!running && (submitting || !draftSendable || !writable)}
              onClick={() => running ? void stop() : void submit()}
            >
              {running ? <StopIcon /> : <ArrowUpIcon />}
            </button>
          </div>
        </div>
      </div>
      {(!hero || submitting || error !== null) && (
        <div
          className={css.statusLine}
          role={error === null ? 'status' : 'alert'}
          aria-live="polite"
        >
          {error ?? (submitting ? '正在启动写作…' : snapshot.composerHint)}
        </div>
      )}
    </div>
  )
}

const DEFAULT_PROJECT_SETUP: ProjectSetupForm = {
  name: '',
  mode: 'deep',
  topic: '',
  genre: 'explanatory_analysis',
  audience: '',
  targetCharacters: '1200',
  constraints: '不得虚构材料未包含的事实',
  interactionMode: 'co_creation',
  authorVoice: '',
  styleReference: '',
  styleDecision: 'unspecified',
  directionDecision: 'tentative',
  platform: '',
  publicationGoal: 'not_applicable',
  materials: [{
    name: '写作材料',
    content: '',
    role: 'source_verified',
    sourceKind: 'pasted_text',
    sourceReference: '',
  }],
}

const PROJECT_SETUP_STEPS = [
  { role: '选题策划', title: '先说说，你这次真正想写什么？', hint: '先锁定问题和目标，不急着一次填完所有设置。' },
  { role: '读者研究', title: '谁会读它，读完希望发生什么？', hint: '读者、文体和发布场景会直接影响结构与表达。' },
  { role: '创作导演', title: '希望我怎样与你配合？', hint: '可以逐步确认，也可以授权系统连续推进。' },
  { role: '资料研究', title: '哪些材料可以作为这篇文章的依据？', hint: '材料决定事实边界；没有来源的细节不会被包装成已核实。' },
] as const

function ProjectSetupDialog({
  bridge,
  onClose,
  onCreated,
  previewOnly = false,
}: {
  bridge: ClientBridge
  onClose: () => void
  onCreated: () => void
  previewOnly?: boolean
}) {
  const [form, setForm] = useState<ProjectSetupForm>(DEFAULT_PROJECT_SETUP)
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose)

  const updateMaterial = (
    index: number,
    patch: Partial<ProjectSetupForm['materials'][number]>,
  ): void => {
    setForm(current => ({
      ...current,
      materials: current.materials.map((material, materialIndex) =>
        materialIndex === index ? { ...material, ...patch } : material),
    }))
  }

  const focusInvalidField = (reason: unknown): void => {
    if (!(reason instanceof Error)) return
    const field = dialogRef.current?.querySelector<HTMLElement>(`[data-error-code="${reason.message}"]`)
    window.requestAnimationFrame(() => field?.focus())
  }

  const importMaterialFile = async (index: number, file: File): Promise<void> => {
    try {
      setError(null)
      updateMaterial(index, await materialPatchFromFile(file))
    } catch (reason) {
      setError(setupErrorMessage(reason, '材料文件读取失败'))
    }
  }

  const importStyleFile = async (file: File): Promise<void> => {
    try {
      setError(null)
      const styleReference = await styleReferenceFromFile(file)
      setForm(current => ({ ...current, styleReference, styleDecision: 'user_confirmed' }))
    } catch (reason) {
      setError(setupErrorMessage(reason, '风格文件读取失败'))
    }
  }

  const save = async (): Promise<void> => {
    try {
      setSaving(true)
      setError(null)
      await bridge.createProject(normalizeProjectSetup({
        ...form,
        name: form.name.trim().length > 0 ? form.name : form.topic,
      }))
      onCreated()
      onClose()
    } catch (reason) {
      setError(setupErrorMessage(reason, '项目创建失败'))
      focusInvalidField(reason)
    } finally {
      setSaving(false)
    }
  }

  const focusStepField = (selector: string): void => {
    window.requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(selector)?.focus())
  }

  const nextStep = (): void => {
    setError(null)
    if (step === 0 && form.topic.trim().length === 0) {
      setError('先告诉我这篇内容要解决什么问题。')
      focusStepField('[data-error-code="PROJECT_TOPIC_REQUIRED"]')
      return
    }
    if (step === 1 && form.audience.trim().length === 0) {
      setError('请描述最主要的目标读者。')
      focusStepField('[data-error-code="PROJECT_AUDIENCE_REQUIRED"]')
      return
    }
    if (step === 1 && (!/^\d+$/u.test(form.targetCharacters) || Number(form.targetCharacters) < 100)) {
      setError('目标篇幅至少为 100 字符，请填写有效数字。')
      focusStepField('[data-error-code="PROJECT_LENGTH_INVALID"]')
      return
    }
    setStep(current => Math.min(PROJECT_SETUP_STEPS.length - 1, current + 1))
    focusStepField('[data-step-initial]')
  }

  const previousStep = (): void => {
    setError(null)
    setStep(current => Math.max(0, current - 1))
    focusStepField('[data-step-initial]')
  }

  const currentStep = PROJECT_SETUP_STEPS[step]!

  return <div className={css.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className={clsx(css.setupDialog, css.guidedSetupDialog)} role="dialog" aria-modal="true" aria-labelledby="project-setup-title" aria-describedby="project-setup-description">
      <div className={css.setupHeader}>
        <div><h2 id="project-setup-title">手动建立写作简报</h2><p id="project-setup-description">这是可选的字段编辑工具。若希望一起讨论方向，关闭后直接在主对话中说出你的想法即可。</p></div>
        <button className={css.miniButton} type="button" aria-label="关闭新建项目" onClick={onClose}><CloseIcon /></button>
      </div>

      <ol className={css.setupProgress} aria-label="简报创建进度">
        {PROJECT_SETUP_STEPS.map((item, index) => <li key={item.role} data-step-status={index === step ? 'current' : index < step ? 'completed' : 'pending'}>
          <span>{index < step ? <CheckIcon /> : index + 1}</span><strong>{item.role}</strong>
        </li>)}
      </ol>

      <div className={css.guidedPrompt}>
        <div className={css.guidedAvatar} aria-hidden="true">{currentStep.role.slice(0, 1)}</div>
        <div><span>{currentStep.role} · 第 {step + 1}/{PROJECT_SETUP_STEPS.length} 步</span><h3>{currentStep.title}</h3><p>{currentStep.hint}</p></div>
      </div>

      {error !== null && <div className={css.editorError} role="alert">{error}</div>}

      {step === 0 && <div className={css.guidedAnswer}>
        <label className={css.formField}><span>写作主题</span><textarea data-initial-focus data-step-initial data-error-code="PROJECT_TOPIC_REQUIRED" rows={4} placeholder="例如：为什么上一代互联网巨头未必能继续主导 AI 时代？希望重点解释哪些机制？" value={form.topic} onChange={event => setForm(current => ({ ...current, topic: event.target.value }))} /></label>
        <label className={css.formField}><span>项目名称（可选）</span><input data-error-code="PROJECT_NAME_REQUIRED" placeholder="留空时自动使用写作主题" value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
        <div className={css.choiceGroup} role="group" aria-label="写作方向">
          <span>目前对方向的把握</span>
          <div className={css.choiceGrid}>
            <button type="button" aria-pressed={form.directionDecision === 'user_confirmed'} className={form.directionDecision === 'user_confirmed' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, directionDecision: 'user_confirmed' }))}><strong>方向已经明确</strong><small>按我描述的角度推进</small></button>
            <button type="button" aria-pressed={form.directionDecision === 'tentative'} className={form.directionDecision === 'tentative' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, directionDecision: 'tentative' }))}><strong>还需要一起梳理</strong><small>先形成提纲，再由我确认</small></button>
            <button type="button" aria-pressed={form.directionDecision === 'user_delegated'} className={form.directionDecision === 'user_delegated' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, directionDecision: 'user_delegated' }))}><strong>授权系统选择</strong><small>在材料边界内决定角度</small></button>
          </div>
        </div>
      </div>}

      {step === 1 && <div className={css.guidedAnswer}>
        <label className={css.formField}><span>目标读者</span><input data-step-initial data-error-code="PROJECT_AUDIENCE_REQUIRED" placeholder="例如：关注 AI 行业变化的互联网从业者" value={form.audience} onChange={event => setForm(current => ({ ...current, audience: event.target.value }))} /></label>
        <div className={css.choiceGroup} role="group" aria-label="文章文体"><span>希望用哪种方式写</span><div className={clsx(css.choiceGrid, css.choiceGridFour)}>
          {([
            ['explanatory_analysis', '解释分析', '把机制讲清楚'],
            ['argument_commentary', '观点评论', '提出并论证判断'],
            ['narrative_observation', '叙事观察', '用经历与场景展开'],
            ['practical_experience', '实用经验', '给出可执行方法'],
          ] as const).map(([value, label, hint]) => <button type="button" key={value} aria-pressed={form.genre === value} className={form.genre === value ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, genre: value }))}><strong>{label}</strong><small>{hint}</small></button>)}
        </div></div>
        <div className={css.formGrid}>
          <label className={css.formField}><span>目标字符数</span><input data-error-code="PROJECT_LENGTH_INVALID" inputMode="numeric" placeholder="例如：3000" value={form.targetCharacters} onChange={event => setForm(current => ({ ...current, targetCharacters: event.target.value }))} /></label>
          <label className={css.formField}><span>发布平台（可选）</span><input placeholder="例如：微信公众号" value={form.platform} onChange={event => setForm(current => ({ ...current, platform: event.target.value, publicationGoal: event.target.value.trim().length > 0 ? 'primary' : 'not_applicable' }))} /></label>
          <label className={css.formField}><span>发布目标</span><select value={form.publicationGoal} onChange={event => setForm(current => ({ ...current, publicationGoal: event.target.value as ProjectSetupForm['publicationGoal'] }))}><option value="not_applicable">工作稿 / 暂不发布</option><option value="primary">主要发布渠道</option><option value="secondary">二次分发</option></select></label>
        </div>
      </div>}

      {step === 2 && <div className={css.guidedAnswer}>
        <div className={css.choiceGroup} role="group" aria-label="写作模式"><span>工作深度</span><div className={css.choiceGrid}>
          <button data-step-initial type="button" aria-pressed={form.mode === 'deep'} className={form.mode === 'deep' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, mode: 'deep' }))}><strong>深度写作</strong><small>研究、提纲、初稿、三类审校、修订与事实核查</small></button>
          <button type="button" aria-pressed={form.mode === 'quick'} className={form.mode === 'quick' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, mode: 'quick' }))}><strong>快速成稿</strong><small>较少阶段与模型调用，适合短内容</small></button>
        </div></div>
        <div className={css.choiceGroup} role="group" aria-label="协作方式"><span>互动方式</span><div className={css.choiceGrid}>
          <button type="button" aria-pressed={form.interactionMode === 'co_creation'} className={form.interactionMode === 'co_creation' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, interactionMode: 'co_creation' }))}><strong>逐步共创（推荐）</strong><small>提纲、初稿和审校后停下来听取你的意见</small></button>
          <button type="button" aria-pressed={form.interactionMode === 'autonomous'} className={form.interactionMode === 'autonomous' ? css.choiceSelected : undefined} onClick={() => setForm(current => ({ ...current, interactionMode: 'autonomous' }))}><strong>连续推进</strong><small>除阻断问题外，自动完成全部阶段</small></button>
        </div></div>
        <div className={css.formGrid}>
          <label className={css.formField}><span>作者声音（可选）</span><input placeholder="例如：直接、克制、带真实经验" value={form.authorVoice} onChange={event => setForm(current => ({ ...current, authorVoice: event.target.value }))} /></label>
          <label className={css.formField}><span>风格决定</span><select value={form.styleDecision} onChange={event => setForm(current => ({ ...current, styleDecision: event.target.value as ProjectSetupForm['styleDecision'] }))}><option value="unspecified">暂不指定</option><option value="user_confirmed">使用我指定的风格</option><option value="user_delegated">授权系统选择</option></select></label>
          <label className={clsx(css.formField, css.formWide)}><span>风格参考（可选）</span><textarea rows={3} placeholder="描述喜欢的节奏、语气和禁忌，或导入现有风格文件" value={form.styleReference} onChange={event => setForm(current => ({ ...current, styleReference: event.target.value, styleDecision: event.target.value.trim().length > 0 ? 'user_confirmed' : current.styleDecision }))} /></label>
          <div className={css.formField}><span>导入现有风格</span><label className={css.filePicker}><input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => {
            const file = event.currentTarget.files?.[0]
            if (file !== undefined) void importStyleFile(file)
            event.currentTarget.value = ''
          }} /><span>选择 TXT / MD 风格文件</span></label></div>
        </div>
      </div>}

      {step === 3 && <div className={css.guidedAnswer}>
        <label className={css.formField}><span>本篇约束（每行一条）</span><textarea data-step-initial rows={3} placeholder="例如：不得虚构作者亲历；避免空泛趋势判断" value={form.constraints} onChange={event => setForm(current => ({ ...current, constraints: event.target.value }))} /></label>
        <section className={css.materialSetup}>
          <div className={css.materialSetupHeader}><div><strong>参考材料</strong><span>可添加多份材料；网页材料同时保存 HTTPS 来源和当前文本快照。</span></div><button type="button" className={css.secondaryAction} onClick={() => setForm(current => ({ ...current, materials: [...current.materials, { name: '', content: '', role: 'source_verified', sourceKind: 'pasted_text', sourceReference: '' }] }))}>添加材料</button></div>
          {form.materials.map((material, index) => <div className={css.materialCard} key={index}>
            <div className={css.materialCardHeader}><strong>材料 {index + 1}</strong>{form.materials.length > 1 && <button type="button" className={css.textAction} onClick={() => setForm(current => ({ ...current, materials: current.materials.filter((_, materialIndex) => materialIndex !== index) }))}>移除</button>}</div>
            <div className={css.formGrid}>
              <label className={css.formField}><span>材料名称</span><input data-error-code="PROJECT_MATERIAL_NAME_REQUIRED" placeholder="例如：访谈纪要" value={material.name} onChange={event => updateMaterial(index, { name: event.target.value })} /></label>
              <label className={css.formField}><span>材料类型</span><select value={material.role} onChange={event => updateMaterial(index, { role: event.target.value as ProjectSetupForm['materials'][number]['role'] })}><option value="source_verified">可核实资料（报告 / 文档）</option><option value="user_firsthand">亲历信息（访谈 / 经验）</option><option value="illustrative">示例素材（仅作参考）</option></select></label>
              <label className={css.formField}><span>来源形式</span><select value={material.sourceKind} onChange={event => updateMaterial(index, { sourceKind: event.target.value as ProjectSetupForm['materials'][number]['sourceKind'], sourceReference: '' })}><option value="pasted_text">粘贴文本</option><option value="utf8_file">本地 TXT / Markdown 文件</option><option value="web_snapshot">网页文本快照</option></select></label>
              {material.sourceKind === 'utf8_file' && <div className={css.formField}><span>本地文件</span><label className={css.filePicker}><input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => {
                const file = event.currentTarget.files?.[0]
                if (file !== undefined) void importMaterialFile(index, file)
                event.currentTarget.value = ''
              }} /><span>{material.sourceReference.length > 0 ? `重新选择（当前：${material.sourceReference}）` : '选择 TXT / MD 文件'}</span></label></div>}
              {material.sourceKind === 'web_snapshot' && <label className={css.formField}><span>来源链接（HTTPS）</span><input data-error-code="PROJECT_MATERIAL_URL_INVALID" placeholder="输入完整 HTTPS 来源链接" value={material.sourceReference} onChange={event => updateMaterial(index, { sourceReference: event.target.value })} /></label>}
              <label className={clsx(css.formField, css.formWide)}><span>材料正文</span><textarea data-error-code="PROJECT_MATERIAL_REQUIRED" rows={6} placeholder="粘贴已获授权使用的原始材料…" value={material.content} onChange={event => updateMaterial(index, { content: event.target.value })} /></label>
            </div>
          </div>)}
        </section>
        <div className={css.setupReviewStrip}>
          <strong>下一步仍会让你复核</strong><span>{form.mode === 'deep' ? '深度写作' : '快速成稿'} · {form.interactionMode === 'co_creation' ? '逐步共创' : '连续推进'} · {form.materials.length} 份材料</span>
        </div>
      </div>}

      <div className={css.setupActions}>
        <span className={css.settingHint}>{previewOnly
          ? '当前是交互演示；可以查看完整流程，但不会创建或保存项目。'
          : '当前答案会保存在这台电脑上；创建后不会立即调用模型。'}</span>
        <div className={css.connectionActions}>
          <button type="button" className={css.secondaryAction} onClick={step === 0 ? onClose : previousStep}>{step === 0 ? '取消' : '上一步'}</button>
          {step < PROJECT_SETUP_STEPS.length - 1
            ? <button type="button" className={css.primaryAction} onClick={nextStep}>继续</button>
            : <button type="button" className={css.primaryAction} disabled={saving || previewOnly} onClick={() => void save()}>{previewOnly ? '演示环境不保存' : saving ? '正在创建…' : '建立简报并复核'}</button>}
        </div>
      </div>
    </section>
  </div>
}

const GENRE_LABELS: Readonly<Record<BriefSummary['genre'], string>> = {
  argument_commentary: '观点评论',
  explanatory_analysis: '解释分析',
  narrative_observation: '叙事观察',
  practical_experience: '实用经验',
}

function BriefEditDialog({ bridge, brief, onClose }: {
  bridge: ClientBridge
  brief: BriefSummary
  onClose: () => void
}) {
  const [form, setForm] = useState<BriefUpdateForm>({
    topic: brief.topic,
    genre: brief.genre,
    audience: brief.audience,
    targetCharacters: String(brief.targetCharacters),
    constraints: brief.constraints.join('\n'),
    interactionMode: brief.interactionMode,
    authorVoice: brief.authorVoice ?? '',
    styleReference: brief.styleReference ?? '',
    styleDecision: brief.styleDecision,
    directionDecision: brief.directionDecision,
    platform: brief.platform ?? '',
    publicationGoal: brief.publicationGoal,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose)

  const importStyleFile = async (file: File): Promise<void> => {
    try {
      setError(null)
      const styleReference = await styleReferenceFromFile(file)
      setForm(current => ({ ...current, styleReference, styleDecision: 'user_confirmed' }))
    } catch (reason) {
      setError(setupErrorMessage(reason, '风格文件读取失败'))
    }
  }

  const save = async (): Promise<void> => {
    try {
      setSaving(true)
      setError(null)
      await bridge.updateBrief(normalizeBriefUpdate(form))
      onClose()
    } catch (reason) {
      setError(setupErrorMessage(reason, '写作简报保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return <div className={css.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} className={css.setupDialog} role="dialog" aria-modal="true" aria-labelledby="brief-edit-title">
      <div className={css.setupHeader}><div><h2 id="brief-edit-title">修改写作简报</h2><p>材料保持不变；修改后的简报需要再次确认，才会进入写作。</p></div><button className={css.miniButton} type="button" aria-label="关闭修改简报" onClick={onClose}><CloseIcon /></button></div>
      {error !== null && <div className={css.editorError} role="alert">{error}</div>}
      <div className={css.formGrid}>
        <label className={clsx(css.formField, css.formWide)}><span>写作主题</span><input data-initial-focus placeholder="这篇内容要解决什么问题？" value={form.topic} onChange={event => setForm(current => ({ ...current, topic: event.target.value }))} /></label>
        <label className={css.formField}><span>文体</span><select value={form.genre} onChange={event => setForm(current => ({ ...current, genre: event.target.value as BriefUpdateForm['genre'] }))}><option value="explanatory_analysis">解释分析</option><option value="argument_commentary">观点评论</option><option value="narrative_observation">叙事观察</option><option value="practical_experience">实用经验</option></select></label>
        <label className={css.formField}><span>目标读者</span><input value={form.audience} onChange={event => setForm(current => ({ ...current, audience: event.target.value }))} /></label>
        <label className={css.formField}><span>目标字符数</span><input inputMode="numeric" value={form.targetCharacters} onChange={event => setForm(current => ({ ...current, targetCharacters: event.target.value }))} /></label>
        <label className={css.formField}><span>协作方式</span><select value={form.interactionMode} onChange={event => setForm(current => ({ ...current, interactionMode: event.target.value as BriefUpdateForm['interactionMode'] }))}><option value="autonomous">自主推进</option><option value="co_creation">逐步共创</option></select></label>
        <label className={css.formField}><span>发布平台（可选）</span><input value={form.platform} onChange={event => setForm(current => ({ ...current, platform: event.target.value }))} /></label>
        <label className={css.formField}><span>发布目标</span><select value={form.publicationGoal} onChange={event => setForm(current => ({ ...current, publicationGoal: event.target.value as BriefUpdateForm['publicationGoal'] }))}><option value="not_applicable">工作稿 / 暂不发布</option><option value="primary">主要发布渠道</option><option value="secondary">二次分发</option></select></label>
        <label className={css.formField}><span>作者声音（可选）</span><input value={form.authorVoice} onChange={event => setForm(current => ({ ...current, authorVoice: event.target.value }))} /></label>
        <label className={css.formField}><span>风格参考（可选）</span><textarea rows={3} value={form.styleReference} onChange={event => setForm(current => ({ ...current, styleReference: event.target.value }))} /></label>
        <div className={css.formField}><span>导入现有风格</span><label className={css.filePicker}><input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={event => {
          const file = event.currentTarget.files?.[0]
          if (file !== undefined) void importStyleFile(file)
          event.currentTarget.value = ''
        }} /><span>选择 TXT / MD 风格文件</span></label></div>
        <label className={css.formField}><span>风格决定</span><select value={form.styleDecision} onChange={event => setForm(current => ({ ...current, styleDecision: event.target.value as BriefUpdateForm['styleDecision'] }))}><option value="unspecified">尚未指定</option><option value="user_confirmed">使用我指定的风格</option><option value="user_delegated">授权 Agent 选择</option></select></label>
        <label className={css.formField}><span>方向决定</span><select value={form.directionDecision} onChange={event => setForm(current => ({ ...current, directionDecision: event.target.value as BriefUpdateForm['directionDecision'] }))}><option value="tentative">继续待确认</option><option value="user_confirmed">方向已经明确</option><option value="user_delegated">授权 Agent 选择方向</option></select></label>
        <label className={clsx(css.formField, css.formWide)}><span>本篇约束（每行一条）</span><textarea rows={4} value={form.constraints} onChange={event => setForm(current => ({ ...current, constraints: event.target.value }))} /></label>
      </div>
      <div className={css.setupActions}><span className={css.settingHint}>保存后回到简报确认页。</span><div className={css.connectionActions}><button type="button" className={css.secondaryAction} onClick={onClose}>取消</button><button type="button" className={css.primaryAction} disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存修改'}</button></div></div>
    </section>
  </div>
}

function BriefConfirmationCard({ brief, confirming, error, onConfirm, onEdit }: {
  brief: BriefSummary
  confirming: boolean
  error: string | null
  onConfirm: () => void
  onEdit: () => void
}) {
  const gaps = [
    brief.directionDecision === 'tentative' ? '写作方向将在确认后锁定' : null,
    brief.styleDecision === 'unspecified' ? '尚未指定风格，主笔将以作者声音和文体为准' : null,
    brief.authorVoice === null ? '尚未提供作者声音，不会虚构作者亲历' : null,
    brief.materialCount === 0 ? '没有参考材料，系统不得声称已核验外部资料' : null,
  ].filter((value): value is string => value !== null)

  return <section className={css.briefReview} aria-label="待确认写作简报">
    <div className={css.briefReviewHeader}><div><span>写作简报 · 待确认</span><h2>{brief.topic}</h2></div><span className={css.briefMode}>{brief.interactionMode === 'autonomous' ? '自主推进' : '逐步共创'}</span></div>
    <dl className={css.briefGrid}>
      <div><dt>目标读者</dt><dd>{brief.audience}</dd></div>
      <div><dt>文体与篇幅</dt><dd>{GENRE_LABELS[brief.genre]} · 约 {brief.targetCharacters} 字符</dd></div>
      <div><dt>平台</dt><dd>{brief.platform ?? '暂未指定'}</dd></div>
      <div><dt>材料</dt><dd>{brief.materialCount} 份已授权材料</dd></div>
      <div><dt>作者声音</dt><dd>{brief.authorVoice ?? '暂未指定'}</dd></div>
      <div><dt>风格</dt><dd>{brief.styleReference ?? (brief.styleDecision === 'user_delegated' ? '已授权 Agent 选择' : '暂未指定')}</dd></div>
    </dl>
    {brief.constraints.length > 0 && <div className={css.briefConstraints}><strong>本篇约束</strong><span>{brief.constraints.join(' · ')}</span></div>}
    {gaps.length > 0 && <div className={css.briefGaps}><strong>确认前请留意</strong><ul>{gaps.slice(0, 2).map(gap => <li key={gap}>{gap}</li>)}</ul></div>}
    {error !== null && <div className={css.editorError} role="alert">{error}</div>}
    <div className={css.briefActions}><span>确认后 Writing Agent 才会按这份简报启动工作流。</span><div className={css.connectionActions}><button className={css.secondaryAction} type="button" disabled={confirming} onClick={onEdit}>返回修改</button><button className={css.primaryAction} type="button" disabled={confirming} onClick={onConfirm}>{confirming ? '正在确认…' : '确认简报并开始'}</button></div></div>
  </section>
}

function DeleteProjectDialog({
  project,
  hostConfiguration,
  onClose,
  onDeleted,
}: {
  project: BridgeSnapshot['projects'][number]
  hostConfiguration: DesktopHostConfiguration
  onClose: () => void
  onDeleted: (projectName: string) => void
}) {
  const [confirmation, setConfirmation] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose)
  const confirmed = confirmation.trim() === project.name

  const remove = async (): Promise<void> => {
    if (!confirmed || deleting) return
    try {
      setDeleting(true)
      setError(null)
      await hostConfiguration.deleteProject(project.id, confirmation)
      onDeleted(project.name)
    } catch (reason) {
      setError(dataActionErrorMessage(reason, '项目删除失败，没有删除任何数据。'))
    } finally {
      setDeleting(false)
    }
  }

  return <div className={css.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && !deleting && onClose()}>
    <section ref={dialogRef} className={clsx(css.setupDialog, css.deleteProjectDialog)} role="dialog" aria-modal="true" aria-labelledby="delete-project-title">
      <div className={css.setupHeader}>
        <div><h2 id="delete-project-title">删除项目“{project.name}”？</h2><p>这会永久删除该项目的材料、对话、稿件、版本、核查与运行记录，其他项目不受影响。</p></div>
        <button className={css.miniButton} type="button" aria-label="关闭删除项目确认" disabled={deleting} onClick={onClose}><CloseIcon /></button>
      </div>
      <div className={css.deleteProjectWarning}>此操作无法撤销。如需保留数据，请先在“设置 → 数据与诊断”中备份工作区。</div>
      {error !== null && <div className={css.editorError} role="alert">{error}</div>}
      <label className={css.formField}><span>输入完整项目名称 <strong>{project.name}</strong> 以确认</span><input data-initial-focus aria-label="输入项目名称确认删除" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></label>
      <div className={css.setupActions}>
        <span className={css.settingHint}>只有名称完全一致后才能删除。</span>
        <div className={css.connectionActions}><button className={css.secondaryAction} type="button" disabled={deleting} onClick={onClose}>取消</button><button className={css.dangerAction} type="button" disabled={!confirmed || deleting} onClick={() => void remove()}>{deleting ? '正在删除…' : '永久删除项目'}</button></div>
      </div>
    </section>
  </div>
}

function RenameProjectDialog({ project, bridge, onClose, onRenamed }: {
  project: BridgeSnapshot['projects'][number]
  bridge: ClientBridge
  onClose: () => void
  onRenamed: (name: string) => void
}) {
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose)
  const normalizedName = name.trim()
  const save = async (): Promise<void> => {
    if (!normalizedName || Array.from(normalizedName).length > 60 || saving) return
    try {
      setSaving(true)
      setError(null)
      if (bridge.renameProject === undefined) throw new Error('PROJECT_RENAME_UNSUPPORTED')
      await bridge.renameProject(project.id, normalizedName)
      onRenamed(normalizedName)
      onClose()
    } catch (reason) {
      setError(commandErrorMessage(reason, '项目重命名失败，请重试。'))
    } finally {
      setSaving(false)
    }
  }
  return <section ref={dialogRef} className={css.setupDialog} role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
    <header className={css.setupHeader}>
      <div><h2 id="rename-project-title">重命名项目</h2><p>项目名称只用于侧边栏识别，不会修改文章的发布标题。</p></div>
      <button className={css.miniButton} type="button" aria-label="关闭项目重命名" onClick={onClose}><CloseIcon /></button>
    </header>
    <label className={css.formField}><span>项目名称</span><input data-initial-focus aria-label="项目名称" value={name} maxLength={60} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save() }} /></label>
    {error !== null && <div className={css.setupError} role="alert">{error}</div>}
    <footer className={css.setupFooter}>
      <button className={css.secondaryAction} type="button" disabled={saving} onClick={onClose}>取消</button>
      <button className={css.primaryAction} type="button" disabled={saving || !normalizedName || normalizedName === project.name || Array.from(normalizedName).length > 60} onClick={() => void save()}>{saving ? '保存中…' : '保存名称'}</button>
    </footer>
  </section>
}

function SettingsDialog({
  bridge,
  brand,
  hostConfiguration,
  initialSection,
  onClose,
}: {
  bridge: ClientBridge
  brand: WritingAgentBrand
  hostConfiguration?: DesktopHostConfiguration
  initialSection: SettingsSection
  onClose: () => void
}) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [diagnosticPreview, setDiagnosticPreview] = useState<DesktopDiagnosticPreviewView | null>(null)
  const [diagnosticResult, setDiagnosticResult] = useState<DesktopDiagnosticExportResultView | null>(null)
  const [diagnosticBusy, setDiagnosticBusy] = useState(false)
  const [legacySourceKind, setLegacySourceKind] = useState<DesktopLegacySourceKind>('manifest')
  const [migrationPlan, setMigrationPlan] = useState<DesktopLegacyMigrationPlanView | null>(null)
  const [migrationResult, setMigrationResult] = useState<DesktopLegacyMigrationResultView | null>(null)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [backupResult, setBackupResult] = useState<DesktopWorkspaceBackupResultView | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [restorePreview, setRestorePreview] = useState<DesktopWorkspaceRestorePreviewView | null>(null)
  const [restoreResult, setRestoreResult] = useState<DesktopWorkspaceRestoreResultView | null>(null)
  const [restoreConfirmation, setRestoreConfirmation] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteResult, setDeleteResult] = useState<string | null>(null)
  const [aboutHandshake, setAboutHandshake] = useState<BridgeHandshake | null>(null)
  const [aboutError, setAboutError] = useState<string | null>(null)
  const dialogRef = useModalDialog(onClose)

  useEffect(() => {
    if (section !== 'about') return
    let active = true
    setAboutError(null)
    void bridge.handshake().then(handshake => {
      if (active) setAboutHandshake(handshake)
    }).catch(() => {
      if (active) setAboutError('暂时无法读取版本信息；重新打开设置后再试。')
    })
    return () => { active = false }
  }, [bridge, section])

  const themeOptions: readonly { value: typeof THEME_MODE_OPTIONS[number]['value']; label: string; icon: ReactNode }[] = THEME_MODE_OPTIONS.map(option => ({
    ...option,
    icon: option.value === 'system'
      ? <MonitorIcon size={22} />
      : option.value === 'light'
        ? <SunIcon size={22} />
        : <MoonIcon size={22} />,
  }))

  const updateAppearance = async (
    patch: Parameters<ClientBridge['updateSettings']>[0],
  ): Promise<void> => {
    try {
      setSettingsError(null)
      await bridge.updateSettings(patch)
    } catch (reason) {
      setSettingsError(reason instanceof Error ? reason.message : '外观设置保存失败')
    }
  }

  const previewDiagnostics = async (): Promise<void> => {
    if (hostConfiguration === undefined) return
    try {
      setDiagnosticBusy(true)
      setDiagnosticResult(null)
      setSettingsError(null)
      setDiagnosticPreview(await hostConfiguration.previewDiagnostics())
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '诊断包预览失败，请稍后重试。'))
    } finally {
      setDiagnosticBusy(false)
    }
  }

  const exportDiagnostics = async (): Promise<void> => {
    if (hostConfiguration === undefined || diagnosticPreview === null) return
    try {
      setDiagnosticBusy(true)
      setSettingsError(null)
      const result = await hostConfiguration.exportDiagnostics(diagnosticPreview.confirmationHash)
      setDiagnosticResult(result)
      if (!result.cancelled) setDiagnosticPreview(null)
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '诊断包导出失败，请稍后重试。'))
    } finally {
      setDiagnosticBusy(false)
    }
  }

  const scanLegacySource = async (): Promise<void> => {
    if (hostConfiguration === undefined) return
    try {
      setMigrationBusy(true)
      setMigrationPlan(null)
      setMigrationResult(null)
      setSettingsError(null)
      setMigrationPlan(await hostConfiguration.selectLegacyMigrationSource(legacySourceKind))
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '旧项目扫描失败，请检查所选数据。'))
    } finally {
      setMigrationBusy(false)
    }
  }

  const applyLegacyMigration = async (): Promise<void> => {
    if (hostConfiguration === undefined || migrationPlan === null) return
    try {
      setMigrationBusy(true)
      setSettingsError(null)
      const result = await hostConfiguration.applyLegacyMigration(migrationPlan.planHash)
      setMigrationResult(result)
      setMigrationPlan(null)
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '旧项目导入失败；旧数据未被修改。'))
    } finally {
      setMigrationBusy(false)
    }
  }

  const backupWorkspace = async (): Promise<void> => {
    if (hostConfiguration === undefined) return
    try {
      setBackupBusy(true)
      setBackupResult(null)
      setSettingsError(null)
      setBackupResult(await hostConfiguration.backupWorkspace())
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '工作区备份失败，请稍后重试。'))
    } finally {
      setBackupBusy(false)
    }
  }

  const selectWorkspaceRestoreBackup = async (): Promise<void> => {
    if (hostConfiguration === undefined) return
    try {
      setRestoreBusy(true)
      setRestorePreview(null)
      setRestoreResult(null)
      setRestoreConfirmation('')
      setSettingsError(null)
      setRestorePreview(await hostConfiguration.selectWorkspaceRestoreBackup())
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '备份检查失败；当前工作区没有变化。'))
    } finally {
      setRestoreBusy(false)
    }
  }

  const applyWorkspaceRestore = async (): Promise<void> => {
    if (hostConfiguration === undefined || restorePreview === null) return
    try {
      setRestoreBusy(true)
      setRestoreResult(null)
      setSettingsError(null)
      setRestoreResult(await hostConfiguration.applyWorkspaceRestore(
        restorePreview.confirmationHash,
        restoreConfirmation,
      ))
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '工作区恢复失败；程序将重启并保留恢复前数据。'))
    } finally {
      setRestoreBusy(false)
    }
  }

  const deleteSelectedProject = async (): Promise<void> => {
    if (hostConfiguration === undefined || snapshot.selectedProjectId.length === 0) return
    try {
      setDeleteBusy(true)
      setDeleteResult(null)
      setSettingsError(null)
      const name = snapshot.projects.find(project => project.id === snapshot.selectedProjectId)?.name
      if (name === undefined) throw new Error('PROJECT_NOT_FOUND')
      await hostConfiguration.deleteProject(snapshot.selectedProjectId, deleteConfirmation)
      setDeleteConfirmation('')
      setDeleteResult(`项目“${name}”已永久删除；其他项目未受影响。`)
    } catch (reason) {
      setSettingsError(dataActionErrorMessage(reason, '项目删除失败，没有删除任何数据。'))
    } finally {
      setDeleteBusy(false)
    }
  }

  const selectedProjectForData = snapshot.projects.find(project => project.id === snapshot.selectedProjectId)
  const diagnosticFileLabels: Readonly<Record<string, string>> = {
    'application.json': '应用版本与运行平台',
    'provider.json': '模型类型、模型 ID 与连接状态',
    'runtime.json': '最近一次运行状态、用量与预算',
    'security.json': '凭据保存与安全策略状态',
  }
  const excludedDiagnosticLabels: Readonly<Record<string, string>> = {
    api_keys_and_credential_values: 'API Key 与凭据值',
    article_and_material_content: '文章正文与材料内容',
    full_prompts_and_tool_results: '完整提示词与工具结果',
    personal_paths: '个人文件路径',
    raw_logs_and_exception_messages: '原始日志与异常详情',
  }
  const aboutVersion = aboutHandshake === null ? null : aboutVersionView(aboutHandshake)

  return (
    <div className={clsx(css.overlay, css.settingsOverlay)} role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className={css.settingsDialog} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className={css.settingsNav} aria-label="设置分类">
          <h2 className={css.settingsHeading} id="settings-title">设置</h2>
          {([['general', '通用'], ['models', '模型'], ['search', '搜索'], ['data', '数据与诊断'], ['about', '关于']] as const).map(([value, label]) => (
            <button
              className={clsx(css.settingsNavButton, section === value && css.settingsNavActive)}
              key={value}
              type="button"
              onClick={() => setSection(value)}
            >
              {value === 'general' ? <SettingsIcon /> : value === 'models' ? <ToolIcon /> : value === 'search' ? <SearchIcon /> : value === 'data' ? <FolderIcon /> : <BrandMark size={16} />}
              {label}
            </button>
          ))}
        </nav>
        <div className={css.settingsMain}>
          <div className={css.settingsToolbar}>
            <button className={css.miniButton} type="button" aria-label="关闭设置" data-initial-focus onClick={onClose}><CloseIcon /></button>
          </div>
          <div className={css.settingsContent}>
            {settingsError !== null && <div className={css.editorError} role="alert">{settingsError}</div>}
            {section === 'general' && <>
              <h3 className={css.settingsSectionTitle}>通用</h3>
              <div className={css.settingRow}>
                <div><div className={css.settingLabel}>外观</div><div className={css.settingHint}>立即应用到当前界面</div></div>
                <div className={css.themeOptions}>
                  {themeOptions.map(option => (
                    <button
                      className={clsx(css.themeButton, snapshot.settings.theme === option.value && css.themeSelected)}
                      type="button"
                      key={option.value}
                      aria-pressed={snapshot.settings.theme === option.value}
                      onClick={() => void updateAppearance({ theme: option.value })}
                    >
                      {option.icon}{option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className={css.settingRow}>
                <div><div className={css.settingLabel}>正文字号</div><div className={css.settingHint}>聊天与预览区域</div></div>
                <select
                  className={inputCss.select}
                  aria-label="正文字号"
                  value={snapshot.settings.contentFontSize}
                  onChange={event => void updateAppearance({ contentFontSize: Number(event.target.value) })}
                >
                  <option value="13">小</option><option value="14">标准</option><option value="16">大</option>
                </select>
              </div>
            </>}
            <div hidden={section !== 'models'}><ProviderSettings host={hostConfiguration} /></div>
            {section === 'search' && <SearchSettings host={hostConfiguration} />}
            {section === 'data' && <>
              <h3 className={css.settingsSectionTitle}>数据与诊断</h3>
              {hostConfiguration === undefined ? (
                <p className={css.aboutCopy}>旧项目迁移和诊断包导出仅在桌面版可用。</p>
              ) : <div className={css.dataTools}>
                <section className={css.dataCard}>
                  <div className={css.dataCardHeader}>
                    <div><strong>脱敏诊断包</strong><p>先预览字段，再由你选择保存位置。诊断包不会包含正文、材料、Key、完整提示词或个人路径。</p></div>
                    <button className={css.secondaryAction} type="button" disabled={diagnosticBusy} onClick={() => void previewDiagnostics()}>{diagnosticBusy ? '处理中…' : '预览诊断内容'}</button>
                  </div>
                  {diagnosticPreview !== null && <div className={css.dataPreview}>
                    <strong>将包含</strong>
                    <ul>{diagnosticPreview.includedFiles.map(file => <li key={file}>{diagnosticFileLabels[file] ?? file}</li>)}</ul>
                    <strong>明确排除</strong>
                    <ul>{diagnosticPreview.excludedDataClasses.map(item => <li key={item}>{excludedDiagnosticLabels[item] ?? item}</li>)}</ul>
                    <small>预览校验：{diagnosticPreview.confirmationHash.slice(0, 12)}…</small>
                    <button className={css.primaryAction} type="button" disabled={diagnosticBusy} onClick={() => void exportDiagnostics()}>确认以上内容并导出 ZIP</button>
                  </div>}
                  {diagnosticResult !== null && <div className={css.dataResult} role="status">{diagnosticResult.cancelled
                    ? '已取消导出，没有写入文件。'
                    : `诊断包已导出：${diagnosticResult.fileName} · ${formatBytes(diagnosticResult.byteLength)} · SHA-256 ${diagnosticResult.sha256.slice(0, 12)}…`}</div>}
                </section>

                <section className={css.dataCard}>
                  <div className={css.dataCardHeader}>
                    <div><strong>导入旧项目</strong><p>只读扫描旧数据，先显示差异和空间检查；确认后备份来源与现有目标，再导入为新项目。</p></div>
                  </div>
                  <div className={css.dataControls}>
                    <label className={css.formField}><span>旧数据类型</span><select value={legacySourceKind} disabled={migrationBusy} onChange={event => {
                      setLegacySourceKind(event.target.value as DesktopLegacySourceKind)
                      setMigrationPlan(null)
                      setMigrationResult(null)
                    }}><option value="manifest">旧 articles 项目目录</option><option value="desktop_v0_1">旧桌面版 0.1 数据库</option></select></label>
                    <button className={css.secondaryAction} type="button" disabled={migrationBusy} onClick={() => void scanLegacySource()}>{migrationBusy ? '正在检查…' : '选择来源并只读扫描'}</button>
                  </div>
                  {migrationPlan !== null && <div className={css.dataPreview}>
                    <strong>扫描结果：{migrationPlan.projects.length} 个项目</strong>
                    <div className={css.dataProjectList}>{migrationPlan.projects.map((project, index) => <article key={`${project.name}:${String(index)}`}>
                      <span>{project.name}</span><small>{project.mode === 'deep' ? '深度模式' : '快速模式'} · {project.artifactCount} 个历史产物 · 旧核查 {project.legacyFactStatus}</small>
                    </article>)}</div>
                    <p className={migrationPlan.spaceCheck.ok ? css.dataSafe : css.dataDanger}>空间检查：需要 {formatBytes(migrationPlan.spaceCheck.requiredBytes)}，可用 {formatBytes(migrationPlan.spaceCheck.availableBytes)} · {migrationPlan.spaceCheck.ok ? '通过' : '空间不足'}</p>
                    <ul>
                      <li>旧源保持只读，导入前建立独立备份。</li>
                      <li>旧会话历史不会被伪造；旧核查统一变为“尚未核查”。</li>
                      <li>模型 Key 不随项目迁移，旧风格保留为待确认来源。</li>
                    </ul>
                    <small>迁移校验：{migrationPlan.planHash.slice(0, 12)}…</small>
                    <button className={css.primaryAction} type="button" disabled={migrationBusy || !migrationPlan.spaceCheck.ok} onClick={() => void applyLegacyMigration()}>确认备份并导入这些项目</button>
                  </div>}
                  {migrationResult !== null && <div className={css.dataResult} role="status">已导入 {migrationResult.projects.length} 个项目，旧源保持不变。关闭设置后可在左侧项目列表打开；正式交付前需重新核查。</div>}
                </section>

                <section className={css.dataCard}>
                  <div className={css.dataCardHeader}>
                    <div><strong>工作区备份</strong><p>生成经过 SQLite 完整性校验的整库备份，包含本机工作区中的项目、版本、决定和运行记录，但不包含 Windows 凭据管理器中的 Key。</p></div>
                    <button className={css.secondaryAction} type="button" disabled={backupBusy} onClick={() => void backupWorkspace()}>{backupBusy ? '正在备份…' : '选择位置并备份'}</button>
                  </div>
                  {backupResult !== null && <div className={css.dataResult} role="status">{backupResult.cancelled
                    ? '已取消备份，没有写入文件。'
                    : `工作区备份已完成：${backupResult.fileName} · ${formatBytes(backupResult.byteLength)} · schema v${backupResult.schemaVersion} · SHA-256 ${backupResult.sha256.slice(0, 12)}…`}</div>}
                </section>

                <section className={clsx(css.dataCard, css.dangerCard)}>
                  <div className={css.dataCardHeader}>
                    <div><strong>从整库备份恢复</strong><p>先只读检查你选定的备份。确认后会自动保存当前工作区的安全副本，再替换工作区并重启；Windows 凭据管理器中的模型 Key 不受影响。</p></div>
                    <button className={css.secondaryAction} type="button" disabled={restoreBusy} onClick={() => void selectWorkspaceRestoreBackup()}>{restoreBusy ? '正在检查…' : '选择备份并检查'}</button>
                  </div>
                  {restorePreview !== null && <div className={css.dataPreview}>
                    <strong>将恢复：{restorePreview.fileName}</strong>
                    <p>{restorePreview.projectCount} 个项目 · {formatBytes(restorePreview.byteLength)} · schema v{restorePreview.schemaVersion}</p>
                    <small>备份校验：SHA-256 {restorePreview.sha256.slice(0, 12)}…</small>
                    <ul>
                      <li>当前完整工作区会先自动保存到本机 restore-backups 目录。</li>
                      <li>恢复会替换当前项目、稿件、版本与运行记录，不会合并两个工作区。</li>
                      <li>只使用当前预览的同一份备份；文件变化后必须重新检查。</li>
                    </ul>
                    <div className={css.deleteControls}>
                      <label className={css.formField}><span>输入“{restorePreview.confirmationPhrase}”确认替换并重启</span><input aria-label="恢复工作区确认" value={restoreConfirmation} onChange={event => setRestoreConfirmation(event.target.value)} placeholder={restorePreview.confirmationPhrase} /></label>
                      <button className={css.dangerAction} type="button" disabled={restoreBusy || restoreConfirmation.trim() !== restorePreview.confirmationPhrase} onClick={() => void applyWorkspaceRestore()}>{restoreBusy ? '正在创建安全备份并恢复…' : '恢复工作区并重启'}</button>
                    </div>
                  </div>}
                  {restoreResult !== null && <div className={css.dataResult} role="status">已恢复 {restoreResult.restoredProjectCount} 个项目；恢复前安全备份为 {restoreResult.safetyBackupFileName}。程序正在重启…</div>}
                </section>

                <section className={clsx(css.dataCard, css.dangerCard)}>
                  <div className={css.dataCardHeader}>
                    <div><strong>永久删除当前项目</strong><p>{selectedProjectForData === undefined ? '当前没有可删除的项目。' : `将删除“${selectedProjectForData.name}”的材料、稿件、版本、核查与运行记录，不影响其他项目。建议先备份工作区。`}</p></div>
                  </div>
                  {selectedProjectForData !== undefined && <div className={css.deleteControls}>
                    <label className={css.formField}><span>输入完整项目名称以确认</span><input value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} placeholder={selectedProjectForData.name} /></label>
                    <button className={css.dangerAction} type="button" disabled={deleteBusy || deleteConfirmation.trim() !== selectedProjectForData.name} onClick={() => void deleteSelectedProject()}>{deleteBusy ? '正在删除…' : '永久删除此项目'}</button>
                  </div>}
                  {deleteResult !== null && <div className={css.dataResult} role="status">{deleteResult}</div>}
                </section>
              </div>}
            </>}
            {section === 'about' && <>
              <h3 className={css.settingsSectionTitle}>{brand.aboutTitle}</h3>
              <section className={css.aboutProductCard} aria-label="版本信息">
                <BrandMark size={48} />
                <div className={css.aboutProductIdentity}>
                  <strong className={css.aboutProductName}>{brand.productName}</strong>
                  <span className={css.aboutVersion} data-testid="about-version">版本 {aboutVersion?.version ?? '读取中…'}</span>
                  <span className={css.aboutReleaseBadge}>{aboutVersion?.releaseLabel ?? '正在读取版本'}</span>
                </div>
              </section>
              {aboutVersion !== null && <p className={css.aboutReleaseExplanation}>{aboutVersion.releaseExplanation}</p>}
              {aboutError !== null && <div className={css.editorError} role="alert">{aboutError}</div>}
              <p className={css.aboutCopy}>{snapshot.mode === 'mock'
                ? '当前是隔离的界面演示环境，不读取或保存真实用户项目。'
                : '项目数据和模型 Key 都保存在这台电脑上；写作内容只会发往你自己配置的模型服务。'}</p>
              {aboutVersion !== null && <details className={css.aboutDetails}>
                <summary>反馈问题时使用</summary>
                <dl>
                  <div><dt>应用构建</dt><dd>{aboutVersion.buildLabel}</dd></div>
                  <div><dt>写作运行时</dt><dd>{aboutVersion.runtimeLabel}</dd></div>
                  <div><dt>界面协议</dt><dd>{aboutVersion.protocolLabel}</dd></div>
                </dl>
              </details>}
            </>}
          </div>
        </div>
      </section>
    </div>
  )
}

export function WritingAgentShell({
  bridge,
  extensions,
  brand = WRITING_AGENT_BRAND,
  themeConfig = WRITING_AGENT_THEME,
  layout = WRITING_AGENT_LAYOUT,
  hostConfiguration,
}: WritingAgentShellProps) {
  const snapshot = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot)
  const frameRef = useRef<HTMLDivElement>(null)
  const conversationScrollRef = useRef<HTMLDivElement>(null)
  const followLatestRef = useRef(true)
  const streamedMessageIdRef = useRef<string | null>(null)
  const visibleConversationRef = useRef<string | null>(null)
  const frameWidth = useFrameWidth(frameRef)
  const [sidebarClosed, setSidebarClosed] = useState(false)
  const [narrowExpanded, setNarrowExpanded] = useState(false)
  const [activePanelId, setActivePanelId] = useState<string | null>(null)
  const [activePanelView, setActivePanelView] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [projectSetupOpen, setProjectSetupOpen] = useState(false)
  const [briefEditOpen, setBriefEditOpen] = useState(false)
  const [hero, setHero] = useState(() => snapshot.selectedSessionId.length === 0)
  const [newProjectIntent, setNewProjectIntent] = useState(() => snapshot.selectedProjectId.length === 0)
  const [activeTab, setActiveTab] = useState<'conversation' | 'runs'>('conversation')
  const loadTraceDetail = useCallback((runId: string, stepId: string) => bridge.getRunTraceDetail({
    projectId: snapshot.selectedProjectId, sessionId: snapshot.selectedSessionId, runId, stepId,
  }), [bridge, snapshot.selectedProjectId, snapshot.selectedSessionId])
  const [showJumpLatest, setShowJumpLatest] = useState(false)
  const [briefConfirming, setBriefConfirming] = useState(false)
  const [briefConfirmationError, setBriefConfirmationError] = useState<string | null>(null)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [projectActionNotice, setProjectActionNotice] = useState<string | null>(null)
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<BridgeSnapshot['projects'][number] | null>(null)
  const [renameProjectTarget, setRenameProjectTarget] = useState<BridgeSnapshot['projects'][number] | null>(null)
  const [composerHandoff, setComposerHandoff] = useState<{ id: number, draft: string, restoreFocus: boolean } | null>(null)
  const activePanel = activePanelId === null ? undefined : extensions.getPanel(activePanelId)
  const rightOpen = activePanel !== undefined
  const narrow = frameWidth < layout.sidebarAutoCollapseWidth
  const sidebarCollapsed = sidebarClosed || (narrow && !narrowExpanded)
  const columns = computeColumns(
    frameWidth,
    sidebarCollapsed ? 0 : layout.sidebarWidth,
    rightOpen ? layout.rightPanelWidth : 0,
  )
  const selectedSession = snapshot.sessions.find(session => session.id === snapshot.selectedSessionId)
  const selectedProject = snapshot.projects.find(project => project.id === snapshot.selectedProjectId)
  const otherRunningSession = snapshot.sessions.find(session => session.projectId === snapshot.selectedProjectId &&
    session.id !== snapshot.selectedSessionId && session.status === 'running')
  const timeline = conversationWithPreview(snapshot.timelineBySession[snapshot.selectedSessionId] ?? [], snapshot.liveReply, snapshot.activeRunId)
  if (snapshot.liveReply?.id && snapshot.liveReply.runId === snapshot.activeRunId) streamedMessageIdRef.current = snapshot.liveReply.id
  const selectedRecoveries = snapshot.recoverableRuns.filter(run => run.sessionId === snapshot.selectedSessionId)
  const selectedRecoveryKey = selectedRecoveries.map(run => `${run.runId}:${run.status}:${run.stopReason ?? ''}`).join('|')
  const checkpointApprovalRunId = selectedRecoveries.some(run => run.stopReason === 'WRITING_INPUT_REQUIRED')
    ? null
    : selectedRecoveries.findLast(run => run.stopReason === 'CO_CREATION_CHECKPOINT' || run.checkpointApproval)?.runId ?? null
  const modelConfigured = snapshot.settings.credentialReference !== null
  const latestRun = snapshot.runRecords.at(-1)

  const latestMessageTarget = (scrollBody: HTMLDivElement): number => {
    const recoveries = scrollBody.querySelectorAll<HTMLElement>('[data-conversation-recovery]')
    const recovery = recoveries.item(recoveries.length - 1)
    if (recovery !== null) {
      const top = recovery.getBoundingClientRect().top - scrollBody.getBoundingClientRect().top + scrollBody.scrollTop - 12
      const bottom = recovery.getBoundingClientRect().bottom - scrollBody.getBoundingClientRect().top + scrollBody.scrollTop + 12
      return conversationFollowTarget(scrollBody, top, bottom)
    }
    const messages = scrollBody.querySelectorAll<HTMLElement>('[data-conversation-message]')
    const message = messages.item(messages.length - 1)
    const top = message === null ? null : message.getBoundingClientRect().top - scrollBody.getBoundingClientRect().top + scrollBody.scrollTop - 12
    // Saving removes aria-busy, not the reader's place in the streamed article.
    const streamed = message?.getAttribute('aria-busy') === 'true' || (streamedMessageIdRef.current !== null && message?.dataset.messageId === streamedMessageIdRef.current)
    const liveBottom = message && streamed ? message.getBoundingClientRect().bottom - scrollBody.getBoundingClientRect().top + scrollBody.scrollTop + 12 : undefined
    return conversationFollowTarget(scrollBody, top, liveBottom)
  }

  const scrollToLatest = (): void => {
    const scrollBody = conversationScrollRef.current
    if (scrollBody !== null) scrollBody.scrollTop = latestMessageTarget(scrollBody)
  }

  const forceFollowLatest = (): void => {
    followLatestRef.current = true
    setShowJumpLatest(false)
    requestAnimationFrame(scrollToLatest)
  }

  const handleConversationScroll = (): void => {
    if (activeTab !== 'conversation') return
    const scrollBody = conversationScrollRef.current
    if (scrollBody === null) return
    followLatestRef.current = scrollBody.scrollTop >= latestMessageTarget(scrollBody) - CONVERSATION_FOLLOW_THRESHOLD
    setShowJumpLatest(!followLatestRef.current)
  }

  const openSettings = (section: SettingsSection): void => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }

  const openWritingPanel = (panelId: string, initialView?: string): void => {
    setActivePanelView(initialView)
    setActivePanelId(panelId)
  }

  const openSession = async (projectId: string, sessionId: string): Promise<void> => {
    try {
      setNavigationError(null)
      await bridge.selectSession(projectId, sessionId)
      setNewProjectIntent(false)
      setActiveTab('conversation')
      setHero(false)
      forceFollowLatest()
    } catch (reason) {
      setNavigationError(commandErrorMessage(reason, '无法打开这个写作会话，请重试。'))
    }
  }

  const startNewConversation = async (projectId: string): Promise<void> => {
    try {
      setNavigationError(null)
      setProjectActionNotice(null)
      await bridge.selectProject(projectId)
      setNewProjectIntent(false)
      setActiveTab('conversation')
      setHero(true)
    } catch (reason) {
      setNavigationError(commandErrorMessage(reason, '无法在这个项目中开始新对话，请重试。'))
    }
  }

  const openProject = async (project: BridgeSnapshot['projects'][number]): Promise<void> => {
    const target = projectNavigationTarget(project, snapshot.sessions, snapshot.selectedSessionId)
    if (target.kind === 'new_conversation') {
      await startNewConversation(target.projectId)
      return
    }
    await openSession(target.projectId, target.sessionId)
  }

  const confirmBrief = async (): Promise<void> => {
    try {
      setBriefConfirming(true)
      setBriefConfirmationError(null)
      const proposalId = snapshot.conversationIntake?.proposalVersionId
      if (proposalId) {
        await bridge.confirmConversation(proposalId)
        forceFollowLatest()
      } else {
        await bridge.confirmBrief()
      }
    } catch (reason) {
      setBriefConfirmationError(commandErrorMessage(reason, '写作简报确认失败，请重试。'))
    } finally {
      setBriefConfirming(false)
    }
  }

  const beginNewProject = (): void => {
    setNewProjectIntent(true)
    setHero(true)
    setActiveTab('conversation')
    setNavigationError(null)
    setBriefConfirmationError(null)
  }

  useEffect(() => applyThemeMode(snapshot.settings.theme), [snapshot.settings.theme])
  useEffect(() => {
    // Desktop handshake arrives after the first render; do not hide a restored
    // waiting conversation behind the welcome screen with a disabled composer.
    if (snapshot.selectedSessionId.length > 0) { setHero(false); setNewProjectIntent(false) }
  }, [snapshot.selectedSessionId])
  useEffect(() => {
    document.title = brand.productName
  }, [brand.productName])
  useEffect(() => {
    if (activePanelId !== null && extensions.getPanel(activePanelId) === undefined) {
      setActivePanelId(null)
      setActivePanelView(undefined)
    }
  }, [activePanelId, extensions])
  useEffect(() => {
    if (!narrow) setNarrowExpanded(false)
  }, [narrow])
  useLayoutEffect(() => {
    if (hero) {
      visibleConversationRef.current = null
      return
    }
    if (visibleConversationRef.current !== snapshot.selectedSessionId) {
      visibleConversationRef.current = snapshot.selectedSessionId
      followLatestRef.current = true
      setShowJumpLatest(false)
    }
    if (followLatestRef.current) scrollToLatest()
  }, [hero, activeTab, snapshot.selectedSessionId, timeline, snapshot.liveReply?.text, latestRun?.completedStages, latestRun?.status, selectedRecoveryKey, snapshot.deliveryWorkspace.gateStatus])

  return (
    <main
      ref={frameRef}
      className={clsx(css.shell, appFrameCss.frame)}
      style={{
        ...createThemeStyle(themeConfig, snapshot.settings.contentFontSize),
        gridTemplateColumns: `${columns.sidebar}px minmax(0, ${columns.center}px) ${columns.rightbar}px`,
      }}
    >
      <aside className={appFrameCss.sidebarCol} aria-label="项目和会话">
        <div className={clsx(sidebarCss.root, sidebarCollapsed && sidebarCss.collapsed)}>
          <div className={sidebarCss.logoRow}>
            {!sidebarCollapsed && <button className={sidebarCss.brand} type="button" onClick={beginNewProject}>
              <span className={sidebarCss.brandIdentity}>
                <span className={sidebarCss.brandMark}><BrandMark /></span>
                <span className={clsx(sidebarCss.brandName, css.brandText)}>{brand.productName} <span className={css.brandTag}>{snapshot.mode === 'mock' ? '演示' : '本地'}</span></span>
              </span>
            </button>}
            <button
              className={clsx(sidebarCss.iconButton, sidebarCss.toggle)}
              type="button"
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              onClick={() => narrow ? setNarrowExpanded(value => !value) : setSidebarClosed(value => !value)}
            >
              {sidebarCollapsed && <span className={sidebarCss.railMark}><BrandMark /></span>}
              <span className={sidebarCss.panelIcon}><PanelIcon /></span>
            </button>
          </div>
          <button className={sidebarCss.newSession} type="button" aria-label="新建项目" onClick={beginNewProject}>
            <PlusIcon /><span className={sidebarCss.newSessionLabel}>新建项目</span>
          </button>
          <div className={sidebarCss.panelList}>
            {extensions.listLaunchers('sidebar.primary').map(launcher => (
              <button
                className={sidebarCss.panelRow}
                type="button"
                key={launcher.id}
                aria-label={launcher.label}
                onClick={() => openWritingPanel(launcher.panelId)}
              >
                <span className={sidebarCss.panelGlyph}>{launcher.icon ?? <PanelIcon />}</span>
                {!sidebarCollapsed && <span className={sidebarCss.panelTitle}>{launcher.label}</span>}
              </button>
            ))}
          </div>
          <div className={sidebarCss.regionArea}>
            {!sidebarCollapsed && <div className={css.workspaceHeader}><span>项目</span><div className={css.workspaceActions}><button className={css.miniButton} type="button" aria-label="添加项目" onClick={beginNewProject}><PlusIcon /></button></div></div>}
            {!sidebarCollapsed && snapshot.projects.map(project => (
              <div className={css.projectGroup} key={project.id}>
                <div className={css.projectRowFrame} data-project-row>
                  <button
                    className={clsx(css.projectRow, !newProjectIntent && project.id === snapshot.selectedProjectId && css.projectActive)}
                    type="button"
                    aria-label={project.name}
                    aria-current={!newProjectIntent && project.id === snapshot.selectedProjectId ? 'true' : undefined}
                    onClick={() => void openProject(project)}
                  >
                    <span className={css.projectIdentity}><FolderIcon /><span>{project.name}</span></span>
                  </button>
                  <button
                    className={css.projectRenameButton}
                    type="button"
                    aria-label={`重命名项目“${project.name}”`}
                    title="重命名项目"
                    onClick={() => {
                      setProjectActionNotice(null)
                      setRenameProjectTarget(project)
                    }}
                  ><EditIcon /></button>
                  {hostConfiguration !== undefined && <button
                    className={css.projectDeleteButton}
                    type="button"
                    aria-label={`删除项目“${project.name}”`}
                    title="删除项目"
                    onClick={() => {
                      setProjectActionNotice(null)
                      setDeleteProjectTarget(project)
                    }}
                  ><TrashIcon /></button>}
                  {!newProjectIntent && project.id === snapshot.selectedProjectId && <span className={css.projectCurrent}>当前</span>}
                  <button
                    className={css.projectNewConversationButton}
                    type="button"
                    aria-label={`在项目“${project.name}”中新建对话`}
                    title="在此项目中新建对话"
                    onClick={() => void startNewConversation(project.id)}
                  ><PlusIcon /></button>
                </div>
                {snapshot.sessions.filter(session => session.projectId === project.id).map(session => (
                  <button
                    className={clsx(css.sessionRow, session.id === snapshot.selectedSessionId && !hero && css.sessionActive)}
                    type="button"
                    key={session.id}
                    aria-current={session.id === snapshot.selectedSessionId && !hero ? 'page' : undefined}
                    onClick={() => void openSession(project.id, session.id)}
                  >
                    <span className={css.sessionIdentity}><span className={css.sessionIndicator} aria-hidden="true" /><span className={css.sessionTitle}>{session.title}</span></span>
                    <span className={session.id === snapshot.selectedSessionId && !hero ? css.sessionCurrent : css.relativeTime}>{session.id === snapshot.selectedSessionId && !hero ? '正在查看' : session.relativeTime}</span>
                  </button>
                ))}
              </div>
            ))}
            {!sidebarCollapsed && navigationError !== null && <p className={css.navigationError} role="alert">{navigationError}</p>}
            {!sidebarCollapsed && projectActionNotice !== null && <p className={css.projectActionNotice} role="status">{projectActionNotice}</p>}
          </div>
          <div className={sidebarCss.footArea}>
            <div className={sidebarCss.settingsArea}>
              <button className={sidebarCss.panelRow} type="button" onClick={() => openSettings('general')}>
                <span className={sidebarCss.panelGlyph}><SettingsIcon /></span>{!sidebarCollapsed && <span className={sidebarCss.panelTitle}>设置</span>}
              </button>
            </div>
          </div>
        </div>
      </aside>

      <section className={clsx(appFrameCss.centerCol, css.center)} aria-label="写作会话">
        <div className={clsx(css.previewBanner, snapshot.mode === 'application' && css.applicationBanner)}>
          <span className={css.previewDot} />
          {snapshot.connection === 'offline'
            ? `本地服务连接已中断${snapshot.lastError === null ? '' : `：${snapshot.lastError.code}`}`
            : snapshot.environmentNotice}
        </div>
        {!hero && <header className={css.header}>
          <div className={css.titleRow}>
            <div className={css.breadcrumbs}><span className={css.crumbMuted}>{selectedProject?.name}</span><span>/</span><span>{selectedSession?.title}</span></div>
            <div className={css.headerActions}>
              {extensions.listLaunchers('conversation.actions').map(launcher => (
                <Button
                  size="sm"
                  variant="toolbar"
                  icon={launcher.icon ?? <PanelIcon />}
                  aria-label={launcher.label}
                  key={launcher.id}
                  onClick={() => {
                    if (activePanelId === launcher.panelId) {
                      setActivePanelId(null)
                      setActivePanelView(undefined)
                    } else {
                      openWritingPanel(launcher.panelId)
                    }
                  }}
                >
                  {launcher.label}
                </Button>
              ))}
            </div>
          </div>
          <div className={css.tabs}><button className={clsx(css.tab, activeTab === 'conversation' && css.tabActive)} type="button" onClick={() => {
            setActiveTab('conversation')
            if (composerRecoveryMode(snapshot.recoverableRuns, snapshot.selectedSessionId) === 'decision') forceFollowLatest()
          }}>对话</button><button className={clsx(css.tab, activeTab === 'runs' && css.tabActive)} type="button" onClick={() => setActiveTab('runs')}>{runRecordsTabLabel(snapshot.runRecords.length, snapshot.activeRunId, snapshot.liveActivity)}</button></div>
        </header>}
        {otherRunningSession && <div className={css.modelSetupNotice} role="status">
          <span>本项目的另一个对话正在运行。可以前往查看进度或停止；完成后再继续当前对话。</span>
          <button type="button" onClick={() => void openSession(otherRunningSession.projectId, otherRunningSession.id)}>查看运行中的对话</button>
        </div>}
        {hero ? <div className={css.heroStage}>
          <div className={css.heroCopy}><h1>{!newProjectIntent && selectedProject !== undefined ? `在“${selectedProject.name}”中开始新对话` : '今天想写什么？'}</h1><p>一句想法、一段材料，或者一个还没想清楚的问题，都可以从这里开始。</p></div>
          {!modelConfigured && snapshot.mode === 'application' && <div className={css.modelSetupNotice}><span>先连接你的模型，然后就可以直接开始交流。</span><button type="button" onClick={() => openSettings('models')}>配置模型</button></div>}
          <Composer bridge={bridge} hero newProject={newProjectIntent} onSubmitted={submission => {
            setComposerHandoff(current => ({ id: (current?.id ?? 0) + 1, draft: submission.pendingDraft, restoreFocus: submission.restoreFocus }))
            setNewProjectIntent(false)
            setActiveTab('conversation')
            setHero(false)
            forceFollowLatest()
          }} onConfigureModel={() => openSettings('models')} hostConfiguration={hostConfiguration} />
          <details className={css.optionalSetup}><summary>高级设置（可选）</summary>
            <p>习惯自己指定字段时，可以使用这些工具；也可以直接在对话中说明要求。</p>
            <button className={css.secondaryAction} type="button" onClick={() => setProjectSetupOpen(true)}>手动建立项目</button>
            {!newProjectIntent && snapshot.brief !== null && <button className={css.secondaryAction} type="button" onClick={() => setBriefEditOpen(true)}>查看写作设置</button>}
            {!newProjectIntent && snapshot.brief?.confirmationStatus === 'tentative' && snapshot.conversationIntake?.phase !== 'proposal' && <BriefConfirmationCard brief={snapshot.brief} confirming={briefConfirming} error={briefConfirmationError} onConfirm={() => void confirmBrief()} onEdit={() => setBriefEditOpen(true)} />}
          </details>
        </div> : activeTab === 'conversation' ? <>
          <div className={css.conversationWrap}>
          <div ref={conversationScrollRef} className={css.scrollBody} data-conversation-feed="true" onScroll={handleConversationScroll}>
            {snapshot.lastError?.code === 'CONVERSATION_HANDOFF_FAILED' && <p className={css.navigationError} role="alert">{snapshot.lastError.message}</p>}
            {latestRun !== undefined && latestRun.stages.length > 0 && <WorkflowProgress run={latestRun} />}
            <Timeline items={timeline} brand={brand} footer={<>
              {snapshot.connection === 'running' && <ConversationWorking snapshot={snapshot} bridge={bridge} />}
              {selectedRecoveries.map(recovery => <CheckpointDecisionCard
                key={recovery.runId}
                bridge={bridge}
                recovery={recovery}
                run={snapshot.runRecords.find(run => run.id === recovery.runId)}
                runActive={snapshot.activeRunId !== null}
                canApproveCheckpoint={recovery.runId === checkpointApprovalRunId}
                onInspect={() => {
                  const launcher = extensions.listLaunchers('conversation.actions')[0]
                  if (launcher !== undefined) openWritingPanel(launcher.panelId, 'process')
                }}
                onContinued={forceFollowLatest}
              />)}
            {snapshot.conversationIntake?.phase === 'proposal' && <section className={css.intakeConfirmation} aria-label="确认写作方向">
              <MarkdownContent content={snapshot.conversationIntake.summary} />
              <p>这个方向符合你的想法吗？也可以直接在下方告诉我怎么调整。</p>
              <button className={css.primaryAction} type="button" disabled={briefConfirming || snapshot.connection === 'running'} onClick={() => void confirmBrief()}>{briefConfirming ? '正在确认…' : '按这个方向继续'}</button>
              {briefConfirmationError !== null && <p role="alert">{briefConfirmationError}</p>}
            </section>}
            <PublicationGateNoticeCard snapshot={snapshot} onInspect={() => {
              const launcher = extensions.listLaunchers('conversation.actions')[0]
              if (launcher !== undefined) openWritingPanel(launcher.panelId, 'facts')
            }} />
            <ConversationRevisionCard key={`${snapshot.selectedProjectId}:${snapshot.selectedSessionId}:revisions`} bridge={bridge} snapshot={snapshot} onContentChange={forceFollowLatest} />
            {snapshot.deliveryWorkspace.bodyVersionId !== null && snapshot.previewDocument.body.trim().length > 0 && <section className={css.manuscriptLink} aria-label="当前稿件">
              <div><strong>当前稿件</strong><p>{snapshot.deliveryWorkspace.gateStatus === 'passed' ? '已通过核查流程 · 可阅读或导出' : '工作稿已保存 · 尚未完成核查'}</p>{snapshot.deliveryWorkspace.gateStatus === 'passed' && <p>{factVerificationNotice(snapshot.factCheckWorkspace)}</p>}</div>
              <button className={css.primaryAction} type="button" onClick={() => {
                const launcher = extensions.listLaunchers('conversation.actions')[0]
                if (launcher !== undefined) openWritingPanel(launcher.panelId, 'read')
              }}>查看当前稿件</button>
            </section>}
            </>} />
          </div>
          <ConversationMinimap scrollRef={conversationScrollRef} itemCount={timeline.length} />
          </div>
          {showJumpLatest && <button className={css.jumpLatest} type="button" onClick={forceFollowLatest}>回到最新进度 ↓</button>}
          <div className={css.composerSeat}><Composer
            bridge={bridge}
            initialDraft={composerHandoff?.draft ?? ''}
            focusRequest={composerHandoff?.restoreFocus ? composerHandoff.id : 0}
            onHandoffConsumed={() => setComposerHandoff(null)}
            onSubmitted={forceFollowLatest}
            onConfigureModel={() => openSettings('models')}
            hostConfiguration={hostConfiguration}
          /></div>
        </> : <div className={css.runRecordsScroll}><RunRecords key={`${snapshot.selectedProjectId}:${snapshot.selectedSessionId}`} records={snapshot.runRecords} activeRunId={snapshot.activeRunId} liveActivity={snapshot.liveActivity} loadDetail={loadTraceDetail} /></div>}
      </section>

      <aside className={appFrameCss.rightbarCol} aria-label={activePanel?.label ?? '扩展面板'}>
        {activePanel !== undefined && columns.rightbar > 0 && (
          <div key={panelInstanceKey(activePanel.id, snapshot.selectedProjectId)} className={css.extensionPanelHost}>
            <Suspense fallback={<div className={css.emptyDocument}>正在加载面板…</div>}>
              {activePanel.render({
                bridge,
                snapshot,
                exportControls: <ConversationExportCard key={`${snapshot.selectedProjectId}:${snapshot.deliveryWorkspace.bodyVersionId}`} bridge={bridge} snapshot={snapshot} hostConfiguration={hostConfiguration} onContentChange={() => {}} onInspect={() => setActivePanelView('facts')} />,
                closePanel: () => {
                  setActivePanelId(null)
                  setActivePanelView(undefined)
                },
                ...(activePanelView === undefined ? {} : { initialView: activePanelView }),
              })}
            </Suspense>
          </div>
        )}
      </aside>
      {settingsOpen && <div className={appFrameCss.overlayLayer}><SettingsDialog bridge={bridge} brand={brand} initialSection={settingsSection} {...(hostConfiguration === undefined ? {} : { hostConfiguration })} onClose={() => setSettingsOpen(false)} /></div>}
      {projectSetupOpen && <div className={appFrameCss.overlayLayer}><ProjectSetupDialog bridge={bridge} previewOnly={snapshot.mode === 'mock'} onCreated={() => { setNewProjectIntent(false); setHero(true) }} onClose={() => setProjectSetupOpen(false)} /></div>}
      {briefEditOpen && snapshot.brief !== null && <div className={appFrameCss.overlayLayer}><BriefEditDialog bridge={bridge} brief={snapshot.brief} onClose={() => setBriefEditOpen(false)} /></div>}
      {deleteProjectTarget !== null && hostConfiguration !== undefined && <div className={appFrameCss.overlayLayer}><DeleteProjectDialog
        project={deleteProjectTarget}
        hostConfiguration={hostConfiguration}
        onClose={() => setDeleteProjectTarget(null)}
        onDeleted={projectName => {
          setDeleteProjectTarget(null)
          setNavigationError(null)
          setProjectActionNotice(`已删除项目“${projectName}”。`)
          setNewProjectIntent(bridge.getSnapshot().selectedProjectId.length === 0)
          setHero(true)
        }}
      /></div>}
      {renameProjectTarget !== null && <div className={appFrameCss.overlayLayer}><RenameProjectDialog
        project={renameProjectTarget}
        bridge={bridge}
        onClose={() => setRenameProjectTarget(null)}
        onRenamed={name => setProjectActionNotice(`项目已重命名为“${name}”。`)}
      /></div>}
    </main>
  )
}
