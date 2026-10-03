import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import type {
  BodyBlockView,
  BridgeSnapshot,
  ClientBridge,
  PublicationLayoutPreset,
  RevisionProposalSummary,
} from '../../client-bridge/src/protocol.ts'
import type { UiPanelRenderContext } from '../../ui/src/extensions/contracts.ts'
import { CloseIcon, DocumentIcon } from '../../ui/src/shell/Icons.tsx'
import { MarkdownContent } from '../../ui/src/shell/MarkdownContent.tsx'
import css from '../../ui/src/shell/WritingAgentShell.module.css'
import { deliveryActionState } from '../../ui/src/shell/delivery.ts'
import { parseEvidenceLedgerView } from './evidence-ledger-view.js'
import { factClaimStatusLabel } from './fact-claim-view.js'

type WritingPanelTab = 'read' | 'edit' | 'process' | 'versions' | 'facts' | 'delivery'

function documentWriteEnabled(snapshot: BridgeSnapshot): boolean {
  return snapshot.mode === 'application' &&
    snapshot.connection !== 'offline' &&
    snapshot.activeRunId === null
}

export async function guardedDocumentWrite<T>(bridge: ClientBridge, action: () => Promise<T>): Promise<T> {
  if (!documentWriteEnabled(bridge.getSnapshot())) {
    throw new Error('当前有任务正在运行，请等待完成或停止后再修改、回滚或保存正文')
  }
  return action()
}

function RevisionDiff({ proposal }: { proposal: RevisionProposalSummary }) {
  return (
    <section className={css.diffCard} aria-label={`修改提案 ${proposal.id}`}>
      <div className={css.diffHeader}>
        <strong>差异预览</strong>
        <span className={clsx(css.proposalStatus, proposal.status === 'conflicted' && css.proposalConflict)}>
          {proposal.status === 'proposed' ? '等待接受' : proposal.status === 'accepted' ? '已接受' : proposal.status === 'rejected' ? '已取消' : proposal.status === 'conflicted' ? `冲突 · ${proposal.conflictCode ?? '内容已变化'}` : '已撤回'}
        </span>
      </div>
      <div className={css.diffInstruction}>{proposal.instruction}</div>
      {proposal.diff.map((entry, index) => (
        <div className={css.diffBody} key={`${proposal.id}:${String(index)}`}>
          {entry.before !== null && <del>{entry.before}</del>}
          {entry.after !== null && <ins>{entry.after}</ins>}
        </div>
      ))}
    </section>
  )
}

function shortHash(value: string | null): string {
  return value === null ? '未声明' : `${value.slice(0, 10)}…${value.slice(-6)}`
}

function EvidenceLedgerContent({ content }: { content: string }) {
  const ledger = parseEvidenceLedgerView(content)
  if (ledger === null) return <div className={css.processContent}>{content}</div>
  const reliabilityLabels: Readonly<Record<string, string>> = {
    high: '高可信',
    medium: '中等可信',
    low: '低可信',
  }
  const verificationLabels: Readonly<Record<string, string>> = {
    user_provided: '用户提供',
    externally_verified: '外部核验',
    unverified: '尚未核验',
  }
  return (
    <>
      <p className={css.factNotice}>{ledger.claims.length} 条可引用证据；正文事实只能在下列使用边界内展开。</p>
      {ledger.claims.length === 0 ? (
        <p className={css.factEmpty}>本次研究没有形成可入账事实，请查看研究备注。</p>
      ) : (
        <div className={css.processList}>{ledger.claims.map(claim => (
          <article className={css.processItem} key={claim.evidenceId}>
            <div>
              <strong>{claim.evidenceId}</strong>
              <span>{reliabilityLabels[claim.reliability] ?? claim.reliability} · {verificationLabels[claim.verificationStatus] ?? claim.verificationStatus}</span>
            </div>
            <p>{claim.claimText}</p>
            <div className={css.processContent}>直接依据：{claim.sourceQuote}</div>
            <small>来源：{claim.sourceTitle} · {claim.sourcePublisher} · 类型 {claim.claimType}</small>
            <small>使用边界：{claim.useBoundary}</small>
          </article>
        ))}</div>
      )}
      <div className={css.processContent}>研究备注：{ledger.notes}</div>
    </>
  )
}

function MaterialProcessPanel({ snapshot }: { snapshot: BridgeSnapshot }) {
  const workspace = snapshot.materialProcessWorkspace
  const roleLabels = {
    user_firsthand: '作者一手材料',
    source_verified: '参考来源',
    illustrative: '示例素材',
  } as const
  const sourceLabels = {
    pasted_text: '粘贴文本',
    utf8_file: '本地文件',
    web_snapshot: '网页文本快照',
    legacy_import: '旧项目迁移',
  } as const
  const trustLabels = {
    user_provided_untrusted: '用户提供 · 按不可信内容处理',
    external_untrusted: '外部来源 · 待核验',
    legacy_unknown: '旧数据 · 信任状态未知',
  } as const
  const bodyLabel = (bodyVersionId: string | null): string => {
    if (bodyVersionId === null) return '未记录绑定版本'
    const version = snapshot.revisionWorkspace.versions.find(candidate => candidate.id === bodyVersionId)
    return version === undefined ? '已绑定初稿' : `绑定正文 v${version.ordinal}`
  }

  return (
    <div className={css.factScroll}>
      <section className={css.factSummary}>
        <div className={css.factSummaryHeader}>
          <strong>材料与写作过程</strong>
          <span>{workspace.materials.length} 份材料 · {workspace.reviews.length} 份独立审校</span>
        </div>
        <p>这里不是运行日志：它展示实际写作输入，以及研究、提纲和审校形成的可阅读产物。</p>
      </section>

      <section className={css.factSection}>
        <h3>本次项目材料</h3>
        {workspace.materials.length === 0 ? (
          <p className={css.factEmpty}>当前项目没有已导入材料。</p>
        ) : (
          <div className={css.processList}>{workspace.materials.map(material => (
            <article className={css.processItem} key={material.id}>
              <div><strong>{material.displayName}</strong><span>{roleLabels[material.role]}</span></div>
              <p>{sourceLabels[material.sourceKind]} · {trustLabels[material.trustLabel]}</p>
              <small>导入于 {new Date(material.importedAt).toLocaleString('zh-CN')}</small>
            </article>
          ))}</div>
        )}
      </section>

      <section className={css.factSection}>
        <h3>研究与证据</h3>
        {workspace.evidence === null ? (
          <p className={css.factEmpty}>尚未形成研究与证据产物。</p>
        ) : (
          <EvidenceLedgerContent content={workspace.evidence.content} />
        )}
      </section>

      <section className={css.factSection}>
        <h3>文章提纲</h3>
        {workspace.outline === null ? (
          <p className={css.factEmpty}>尚未形成提纲。</p>
        ) : (
          <MarkdownContent content={workspace.outline.content} className={css.processContent} />
        )}
      </section>

      <section className={css.factSection}>
        <h3>独立审校意见</h3>
        {workspace.reviews.length === 0 ? (
          <p className={css.factEmpty}>尚未形成独立审校意见。</p>
        ) : (
          <div className={css.processList}>{workspace.reviews.map(review => (
            <article className={css.processItem} key={review.id}>
              <div><strong>{review.label}</strong><span>{bodyLabel(review.bodyVersionId)}</span></div>
              <MarkdownContent content={review.content} className={css.processContent} />
              <small>{new Date(review.createdAt).toLocaleString('zh-CN')}</small>
            </article>
          ))}</div>
        )}
        <p className={css.factNotice}>{workspace.notice}</p>
      </section>
    </div>
  )
}

function FactCheckPanel({
  bridge,
  snapshot,
  busy,
  run,
}: {
  bridge: ClientBridge
  snapshot: BridgeSnapshot
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const workspace = snapshot.factCheckWorkspace
  const statusLabels = {
    not_checked: '尚未核查',
    checking: '核查中',
    passed: '快照已通过',
    blocked: '存在阻断',
    error: '核查失败',
    stale: '结果已失效',
  } as const
  const statusDetails = {
    not_checked: '当前项目还没有与正文、标题和证据账本绑定的核查快照。',
    checking: '输入已经冻结，等待核查结果写入。',
    passed: '此输入快照通过既定核查流程；这不等于承诺事实绝对正确。',
    blocked: '至少一项事实没有满足完整支持条件，不能作为正式交付依据。',
    error: '核查流程没有形成可用结果，应重新核查。',
    stale: '核查后输入发生变化；历史报告保留，但不能冒充当前结果。',
  } as const
  const reasonLabels = {
    body_version_changed: '正文版本已变化',
    title_version_changed: '标题或分发文案已变化',
    evidence_version_changed: '证据账本已变化',
  } as const
  const relationLabels = {
    DERIVED_FROM: '来自',
    USES_MATERIAL: '使用材料',
    CHANGED_BY_DECISION: '受决定影响',
    REVIEWED_IN: '经过审校',
    CHECKED_IN: '纳入核查',
    EXPORTED_AS: '导出为',
  } as const
  const canRun = snapshot.mode === 'application' &&
    snapshot.connection !== 'offline' &&
    snapshot.activeRunId === null &&
    snapshot.revisionWorkspace.bodyVersionId !== null &&
    snapshot.settings.credentialReference !== null

  return (
    <div className={css.factScroll}>
      <section className={css.factSummary} data-fact-status={workspace.status}>
        <div className={css.factSummaryHeader}>
          <strong>{statusLabels[workspace.status]}</strong>
          <span>{workspace.assessment?.blockers.length ?? 0} 项阻断</span>
        </div>
        <p>{statusDetails[workspace.status]}</p>
        <div className={css.editorActions}>
          <button type="button" disabled={busy || !canRun} onClick={() => void run(() => bridge.runFactCheck())}>
            {snapshot.activeRunId !== null ? '已有任务正在运行' : workspace.status === 'not_checked' ? '开始事实核查' : '重新核查当前稿件'}
          </button>
        </div>
        {!canRun && snapshot.revisionWorkspace.bodyVersionId !== null && snapshot.activeRunId === null && <p role="status">需要已配置且在线的模型，才能核查当前正文。</p>}
      </section>

      {workspace.snapshot !== null && <section className={css.factSection}>
        <h3>本次核查范围</h3>
        <p>核查结果已绑定当前正文、标题和证据账本；任一内容变化后，旧结果会自动失效。</p>
        <details className={css.factTechnical}>
          <summary>查看快照与版本技术详情</summary>
          <dl className={css.factBindings}>
            <div><dt>快照</dt><dd><code>{workspace.snapshot.id}</code></dd></div>
            <div><dt>正文版本</dt><dd><code>{workspace.snapshot.bodyVersionId}</code><span title={workspace.snapshot.bodyHash}>{shortHash(workspace.snapshot.bodyHash)}</span></dd></div>
            <div><dt>标题版本</dt><dd><code>{workspace.snapshot.titleVersionId}</code><span title={workspace.snapshot.titleHash}>{shortHash(workspace.snapshot.titleHash)}</span></dd></div>
            <div><dt>证据账本</dt><dd><code>{workspace.snapshot.evidenceVersionId}</code><span title={workspace.snapshot.evidenceHash}>{shortHash(workspace.snapshot.evidenceHash)}</span></dd></div>
            <div><dt>分发文案</dt><dd><span title={workspace.snapshot.distributionCopyHash ?? undefined}>{shortHash(workspace.snapshot.distributionCopyHash)}</span></dd></div>
            <div><dt>门禁策略</dt><dd><code>{workspace.snapshot.policyVersion}</code></dd></div>
          </dl>
        </details>
      </section>}

      {workspace.assessment !== null && <section className={css.factSection}>
        <h3>核查结论</h3>
        {workspace.assessment.claims.length === 0
          ? <p className={css.factEmpty}>没有识别到需要外部来源支持的事实主张；系统仍已完整覆盖正文和标题。</p>
          : <div className={css.claimList}>{workspace.assessment.claims.map(claim => (
              <article className={clsx(css.claimCard, workspace.assessment?.blockers.includes(claim.claimId) && css.claimBlocked)} key={claim.claimId}>
                <div><strong>{factClaimStatusLabel(claim)}</strong><span>{claim.location} · 风险 {claim.risk === 'red' ? '高' : claim.risk === 'yellow' ? '中' : '低'}</span></div>
                <p>{claim.claimText}</p>
                <small>核查依据：{claim.evidenceSummary}</small>
                <small>建议处理：{claim.recommendedAction}</small>
                <small>来源：{claim.sourceReference ?? claim.evidenceId ?? '尚未提供'}</small>
              </article>
            ))}</div>}
        <details className={css.factTechnical}>
          <summary>查看报告校验值</summary>
          <div className={css.factHashes}>
            <span title={workspace.assessment.claimsHash}>claims {shortHash(workspace.assessment.claimsHash)}</span>
            <span title={workspace.assessment.reportHash}>report {shortHash(workspace.assessment.reportHash)}</span>
          </div>
        </details>
      </section>}

      {workspace.invalidations.length > 0 && <section className={css.factSection}>
        <h3>失效记录</h3>
        <div className={css.invalidationList}>{workspace.invalidations.map((invalidation, index) => (
          <div key={`${invalidation.changedVersionId}:${String(index)}`}>
            <strong>{reasonLabels[invalidation.reason]}</strong>
            <span><code>{invalidation.changedVersionId}</code> · {new Date(invalidation.createdAt).toLocaleString('zh-CN')}</span>
          </div>
        ))}</div>
      </section>}

      <section className={css.factSection}>
        <h3>来源关系</h3>
        {workspace.provenance.length === 0
          ? <p className={css.factEmpty}>当前还没有可展示的来源关系。</p>
          : <div className={css.provenanceList}>{workspace.provenance.slice(-50).map((edge, index) => (
              <div key={`${edge.fromId}:${edge.relation}:${edge.toId}:${String(index)}`}>
                <code>{shortHash(edge.fromId)}</code><strong>{relationLabels[edge.relation]}</strong><code>{shortHash(edge.toId)}</code>
                <span>记录依据：{edge.evidenceRef === null ? '系统持久事件' : shortHash(edge.evidenceRef)}</span>
              </div>
            ))}</div>}
        <p className={css.factNotice}>{workspace.notice}</p>
      </section>
    </div>
  )
}

function DeliveryPanel({
  bridge,
  snapshot,
  busy,
  run,
  exportControls,
}: {
  bridge: ClientBridge
  snapshot: BridgeSnapshot
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
  exportControls?: ReactNode
}) {
  const workspace = snapshot.deliveryWorkspace
  const [layoutPreset, setLayoutPreset] = useState<PublicationLayoutPreset>('clean')
  const available = deliveryActionState(
    workspace,
    snapshot.mode === 'application' && snapshot.connection !== 'offline',
  )
  const gateLabels = {
    not_checked: '尚未核查',
    checking: '核查中',
    passed: '当前快照已通过',
    blocked: '存在阻断',
    error: '核查失败',
    stale: '结果已失效',
  } as const

  return (
    <div className={css.factScroll}>
      {exportControls ?? <>
      <section className={css.factSummary} data-fact-status={workspace.gateStatus}>
        <div className={css.factSummaryHeader}>
          <strong>工作备份与正式交付分开处理</strong>
          <span>{gateLabels[workspace.gateStatus]}</span>
        </div>
        <p>{workspace.notice}</p>
      </section>

      <section className={css.factSection}>
        <h3>工作备份</h3>
        <p>保存当前 Markdown 原文和状态清单。即使尚未核查或核查已失效也可以备份，但文件会明确标记为不可发布。</p>
        <div className={css.editorActions}>
          <button
            type="button"
            disabled={busy || snapshot.activeRunId !== null || !available.workingCopyEnabled}
            onClick={() => void run(() => guardedDocumentWrite(bridge, () => bridge.saveWorkingCopy()))}
          >
            保存 Markdown 工作备份
          </button>
        </div>
      </section>

      <section className={css.factSection}>
        <h3>正式导出</h3>
        <p>TXT 与 HTML 使用同一份当前快照门禁；正文、标题、证据或核查报告任一变化都会阻止导出。</p>
        <div className={css.layoutPresetField}>
          <strong>HTML 排版风格</strong>
          <div className={css.layoutPresetGrid} role="radiogroup" aria-label="HTML 排版风格">
            {([
              ['clean', '清爽阅读', '通用文章与公众号预览'],
              ['editorial', '杂志长文', '衬线字体与更宽松留白'],
              ['compact', '紧凑报告', '高信息密度与清晰层级'],
            ] as const).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={layoutPreset === value}
                className={clsx(css.layoutPresetCard, layoutPreset === value && css.layoutPresetSelected)}
                onClick={() => setLayoutPreset(value)}
              >
                <span className={css.layoutPreview} data-layout-preset={value} aria-hidden="true"><i /><i /><i /></span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </button>
            ))}
          </div>
        </div>
        <div className={css.editorActions}>
          <button
            type="button"
            disabled={busy || !available.publicationEnabled}
            onClick={() => void run(() => bridge.exportPublication('txt'))}
          >
            导出正式 TXT
          </button>
          <button
            type="button"
            disabled={busy || !available.publicationEnabled}
            onClick={() => void run(() => bridge.exportPublication('html', { layoutPreset }))}
          >
            导出{layoutPreset === 'clean' ? '清爽' : layoutPreset === 'editorial' ? '杂志' : '紧凑'} HTML
          </button>
        </div>
        {!available.publicationEnabled && <p role="status">正式导出需当前核查状态为 passed；失败不会覆盖已有文件。</p>}
      </section>

      </>}
      <section className={css.factSection}>
        <h3>导出记录</h3>
        {workspace.exports.length === 0 ? (
          <p>当前项目还没有导出记录。</p>
        ) : (
          <div className={css.versionList}>
            {[...workspace.exports].reverse().map(record => (
              <div className={css.versionRow} key={record.id}>
                <div>
                  <strong>{record.mode === 'working_copy' ? '工作备份' : '正式交付'} · {record.format.toUpperCase()}</strong>
                  <p>{record.relativePath}</p>
                  <span>{record.state} · {record.gateStatus} · {new Date(record.completedAt ?? record.createdAt).toLocaleString('zh-CN')}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export function WritingWorkbenchPanel({
  bridge,
  snapshot,
  closePanel,
  initialView,
  exportControls,
}: UiPanelRenderContext) {
  const requestedTab: WritingPanelTab = initialView === 'process' ||
    initialView === 'versions' ||
    initialView === 'facts' ||
    initialView === 'delivery' || initialView === 'edit' || initialView === 'read'
    ? initialView
    : 'read'
  const [tab, setTab] = useState<WritingPanelTab>(requestedTab)
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const [replacement, setReplacement] = useState('')
  const [instruction, setInstruction] = useState('局部修改正文段落')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workspace = snapshot.revisionWorkspace
  const writable = snapshot.mode === 'application' && snapshot.connection !== 'offline'
  const documentWritable = documentWriteEnabled(snapshot)
  const pending = workspace.proposals.filter(proposal => proposal.status === 'proposed')

  useEffect(() => {
    setEditingBlockId(null)
    setReplacement('')
    setError(null)
  }, [snapshot.selectedProjectId, workspace.bodyVersionId])

  useEffect(() => {
    setTab(requestedTab)
  }, [requestedTab])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (reason) {
      const code = reason instanceof Error && 'code' in reason ? String(reason.code) : null
      setError(code === null
        ? reason instanceof Error ? reason.message : '操作失败'
        : `${code}：${reason instanceof Error ? reason.message : '操作失败'}`)
    } finally {
      setBusy(false)
    }
  }

  const beginEdit = (block: BodyBlockView): void => {
    setEditingBlockId(block.id)
    setReplacement(block.content)
    setInstruction('局部修改正文段落')
    setError(null)
  }

  const propose = (block: BodyBlockView): void => {
    if (!documentWritable || workspace.bodyVersionId === null || replacement.trim().length === 0) return
    void run(async () => {
      await guardedDocumentWrite(bridge, () => bridge.proposeRevision({
        baseBodyVersionId: workspace.bodyVersionId as string,
        instruction,
        constraints: ['不得修改任何已锁定块'],
        edits: [{
          type: 'replace',
          targetBlockId: block.id,
          baseBlockHash: block.contentHash,
          content: replacement,
        }],
      }))
      setEditingBlockId(null)
      setReplacement('')
    })
  }

  const toggleLock = (block: BodyBlockView): void => {
    if (!documentWritable || workspace.bodyVersionId === null) return
    void run(() => guardedDocumentWrite(bridge, () => bridge.setBlockLock(
      workspace.bodyVersionId as string,
      block.id,
      block.contentHash,
      block.locked ? 'unlock' : 'lock',
    )))
  }

  return (
    <div className={css.rightPanel}>
      <div className={css.rightHeader}>
        <DocumentIcon />
        <span className={css.rightTitle}>{snapshot.previewDocument.title}</span>
        <span className={clsx(css.readonlyBadge, writable && css.editableBadge)}>
          {writable ? '版本保护编辑' : '演示只读'}
        </span>
        <button className={css.miniButton} type="button" aria-label="关闭稿件面板" onClick={closePanel}><CloseIcon /></button>
      </div>
      <div className={css.panelTabs} role="tablist" aria-label="稿件面板">
        <button className={clsx(css.panelTab, tab === 'read' && css.panelTabActive)} type="button" role="tab" aria-selected={tab === 'read'} onClick={() => setTab('read')}>阅读稿件</button>
        <button className={clsx(css.panelTab, tab === 'edit' && css.panelTabActive)} type="button" role="tab" aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>稿件与差异</button>
        <button className={clsx(css.panelTab, tab === 'process' && css.panelTabActive)} type="button" role="tab" aria-selected={tab === 'process'} onClick={() => setTab('process')}>材料与过程</button>
        <button className={clsx(css.panelTab, tab === 'versions' && css.panelTabActive)} type="button" role="tab" aria-selected={tab === 'versions'} onClick={() => setTab('versions')}>版本历史</button>
        <button className={clsx(css.panelTab, tab === 'facts' && css.panelTabActive)} type="button" role="tab" aria-selected={tab === 'facts'} onClick={() => setTab('facts')}>核查与来源</button>
        <button className={clsx(css.panelTab, tab === 'delivery' && css.panelTabActive)} type="button" role="tab" aria-selected={tab === 'delivery'} onClick={() => setTab('delivery')}>导出与备份</button>
      </div>
      <div className={css.rightMeta}>
        正文 v{snapshot.previewDocument.version} · 项目修订 {workspace.projectRevision} · {workspace.blocks.length} 个内容块
      </div>
      {error !== null && <div className={css.editorError} role="alert">{error}</div>}
      {tab === 'read' ? (
        <div className={css.manuscriptReader} aria-label="稿件阅读">
          {snapshot.previewDocument.body.trim() ? <>
            <p>{snapshot.deliveryWorkspace.gateStatus === 'passed' ? '当前版本已通过核查' : '当前为工作稿，尚未完成核查'}</p>
            <button className={css.secondaryAction} type="button" onClick={() => setTab('delivery')}>导出与备份</button>
            <MarkdownContent content={snapshot.previewDocument.body} />
          </> : <p>还没有已保存的稿件。写作完成后会在这里显示。</p>}
        </div>
      ) : tab === 'process' ? (
        <MaterialProcessPanel snapshot={snapshot} />
      ) : tab === 'delivery' ? (
        <DeliveryPanel bridge={bridge} snapshot={snapshot} busy={busy} run={run} exportControls={exportControls} />
      ) : tab === 'facts' ? (
        <FactCheckPanel bridge={bridge} snapshot={snapshot} busy={busy} run={run} />
      ) : workspace.bodyVersionId === null ? (
        <div className={css.emptyDocument}>尚无已保存正文；生成草稿后才能进行块级修改。</div>
      ) : tab === 'edit' ? (
        <div className={css.revisionScroll}>
          {workspace.blocks.map(block => (
            <section className={clsx(css.blockCard, block.locked && css.blockLocked)} key={block.id} data-block-id={block.id}>
              <div className={css.blockToolbar}>
                <span>{block.kind === 'heading' && block.ordinal === 0 ? '标题' : `块 ${block.ordinal + 1} · ${block.kind}`}</span>
                <div className={css.blockActions}>
                  <button type="button" disabled={!documentWritable || busy} onClick={() => toggleLock(block)}>{block.kind === 'heading' && block.ordinal === 0 ? (block.locked ? '显式解锁标题' : '锁定标题') : (block.locked ? '显式解锁' : '锁定')}</button>
                  <button type="button" disabled={!documentWritable || busy || block.locked} onClick={() => beginEdit(block)}>{block.kind === 'heading' && block.ordinal === 0 ? '修改标题' : '局部修改'}</button>
                </div>
              </div>
              {editingBlockId === block.id ? (
                <div className={css.blockEditor}>
                  <textarea aria-label={`编辑块 ${block.ordinal + 1}`} value={replacement} onChange={event => setReplacement(event.target.value)} />
                  <input aria-label="修改说明" value={instruction} onChange={event => setInstruction(event.target.value)} />
                  <div className={css.editorActions}>
                    <button type="button" disabled={!documentWritable || busy || replacement.trim().length === 0 || instruction.trim().length === 0} onClick={() => propose(block)}>生成差异预览</button>
                    <button type="button" disabled={busy} onClick={() => setEditingBlockId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <div className={css.blockContent}>{block.content}</div>
              )}
            </section>
          ))}
          {pending.map(proposal => (
            <div className={css.proposalActionsCard} key={proposal.id}>
              <RevisionDiff proposal={proposal} />
              <div className={css.editorActions}>
                <button type="button" disabled={!documentWritable || busy} onClick={() => void run(() => guardedDocumentWrite(bridge, () => bridge.acceptRevision(proposal.id)))}>接受并创建新版本</button>
                <button type="button" disabled={!documentWritable || busy} onClick={() => void run(() => guardedDocumentWrite(bridge, () => bridge.rejectRevision(proposal.id, '用户取消差异')))}>取消提案</button>
              </div>
            </div>
          ))}
          {workspace.proposals.filter(proposal => proposal.status === 'conflicted').slice(-3).map(proposal => <RevisionDiff key={proposal.id} proposal={proposal} />)}
        </div>
      ) : (
        <div className={css.versionList}>
          {[...workspace.versions].reverse().map(version => (
            <div className={clsx(css.versionRow, version.current && css.versionCurrent)} key={version.id}>
              <div><strong>v{version.ordinal}{version.current ? ' · 当前' : ''}</strong><p>{version.reason}</p><span>{version.actorLabel} · {new Date(version.createdAt).toLocaleString('zh-CN')}</span></div>
              {!version.current && <button type="button" disabled={!documentWritable || busy} onClick={() => void run(() => guardedDocumentWrite(bridge, () => bridge.rollbackBody(version.id, `回退到 v${version.ordinal}`)))}>回退到此版</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
