import { useEffect, useRef, useState } from 'react'
import type { BridgeSnapshot, ClientBridge, PublicationLayoutPreset } from '../../../client-bridge/src/protocol.ts'
import type { DesktopHostConfiguration, DesktopPublicationSaveResult } from '../../../client-bridge/src/desktop-bridge.ts'
import { deliveryActionState } from './delivery.ts'
import css from './WritingAgentShell.module.css'

const exportErrors: Record<string, string> = {
  FACT_GATE_NOT_PASSED: '当前版本尚未通过事实核查，请先处理核查问题再导出。',
  EXPORT_SELECTION_CHANGED: '稿件或项目已变化，请查看当前版本后重新导出。',
  EXPORT_ALREADY_SAVING: '已有保存窗口打开，请先完成或取消上一次保存。',
  EXPORT_WRITING_ACTIVE: '文章仍在处理中，请等待处理结束后再导出。',
  EXPORT_DESTINATION_INVALID: '请使用对应的 HTML 或 TXT 扩展名，并选择工作区之外的保存位置。',
  EXPORT_RECEIPT_NOT_FOUND: '未找到刚才保存的文件，可能已被移动或删除，请重新导出。',
}

export function ConversationExportCard({ bridge, snapshot, hostConfiguration, onInspect, onContentChange }: {
  bridge: ClientBridge
  snapshot: BridgeSnapshot
  hostConfiguration?: DesktopHostConfiguration | undefined
  onInspect: () => void
  onContentChange: () => void
}) {
  const [format, setFormat] = useState<'html' | 'txt'>('html')
  const [layout, setLayout] = useState<PublicationLayoutPreset>('clean')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Exclude<DesktopPublicationSaveResult, { cancelled: true }> | null>(null)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const available = deliveryActionState(snapshot.deliveryWorkspace, snapshot.mode === 'application' && snapshot.connection !== 'offline')
  const writing = snapshot.activeRunId !== null || snapshot.connection === 'running'
  const ready = available.publicationEnabled && !writing
  if (snapshot.previewDocument.status === 'empty' || snapshot.deliveryWorkspace.bodyVersionId === null) return null
  const gate = snapshot.deliveryWorkspace.gateStatus
  const description = snapshot.connection === 'offline' ? '本地服务尚未连接，请恢复连接后再导出。'
    : snapshot.mode === 'mock' ? '当前为界面预览，不能导出真实稿件。'
    : writing ? '文章仍在处理中，处理结束并通过核查后，可在这里导出。'
    : gate === 'stale' ? '稿件已修改，需要重新核查当前版本后再导出。'
    : gate === 'blocked' ? '请先处理上方核查问题。你可以直接在对话中提出修改意见。'
    : gate === 'checking' ? '正在核查当前版本，完成后会在这里显示可用操作。'
    : gate === 'error' ? '核查未完成，请查看原因并重新核查。'
    : !ready ? '当前版本尚未通过事实核查，完成核查后才能正式导出。'
    : hostConfiguration ? '点击“导出文章”选择保存位置。导出的是当前已核查版本，不会自动发布到外部平台。'
    : '导出当前已核查版本到本地工作区，不会自动发布到外部平台。'

  const perform = async (reveal = false) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(null); setNotice(null)
    if (!reveal) setSaved(null)
    try {
      if (reveal && saved && hostConfiguration) {
        await hostConfiguration.revealPublication(saved.receiptId)
      } else if (hostConfiguration) {
        const result = await hostConfiguration.savePublicationAs({ projectId: snapshot.selectedProjectId,
          bodyVersionId: snapshot.deliveryWorkspace.bodyVersionId!, format, layoutPreset: layout })
        if (!mounted.current) return
        if (result.cancelled) setNotice('已取消导出，没有保存新的文件。')
        else { setSaved(result); setNotice('文章已导出。') }
      } else {
        const result = await bridge.exportPublication(format, { layoutPreset: layout })
        if (mounted.current) setNotice(`已保存到本地工作区：${result.relativePath}`)
      }
    } catch (reason) {
      const code = reason && typeof reason === 'object' && 'code' in reason ? String(reason.code) : ''
      if (mounted.current) setError(exportErrors[code] ?? '操作未完成，请检查保存目录的权限和可用空间后重试。稿件仍保存在本机。')
    } finally {
      inFlight.current = false
      if (mounted.current) { setBusy(false); onContentChange() }
    }
  }
  const runLocal = async (action: 'backup' | 'recheck') => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setError(null); setNotice(null)
    try {
      if (action === 'recheck') { await bridge.runFactCheck(); if (mounted.current) setNotice('正在独立核查当前稿件，不会重写正文。') }
      else { const result = await bridge.saveWorkingCopy(); if (mounted.current) setNotice(`工作备份已保存：${result.relativePath}。这是工作稿备份，不代表可以正式发布。`) }
    } catch { if (mounted.current) setError('操作尚未完成。请先确认发布标题和证据材料，稿件仍在本机。') }
    finally { inFlight.current = false; if (mounted.current) { setBusy(false); onContentChange() } }
  }
  return <section className={css.conversationExport} aria-label="文章导出" data-ready={ready}>
    <span className={css.exportEyebrow}>{ready ? '✓ 可以交付' : '稿件已在本机保存'}</span>
    <h2>{ready ? '当前版本可以正式导出' : '正式导出尚未就绪'}</h2>
    <p>{description}</p>
    <div className={css.exportActions}>
      <label>文件格式<select aria-label="导出文件格式" value={format} disabled={busy || !ready} onChange={event => setFormat(event.target.value as 'html' | 'txt')}>
        <option value="html">排版文章 · HTML（推荐）</option>
        <option value="txt">纯文本 · TXT</option>
      </select></label>
      {format === 'html' && <label>排版样式<select aria-label="导出排版样式" value={layout} disabled={busy || !ready} onChange={event => setLayout(event.target.value as PublicationLayoutPreset)}>
        <option value="clean">清爽阅读</option><option value="editorial">杂志长文</option><option value="compact">紧凑报告</option>
      </select></label>}
      <button className={css.primaryAction} type="button" disabled={busy || !ready} onClick={() => void perform()}>{busy ? '正在处理…' : '导出文章'}</button>
      <button className={css.secondaryAction} type="button" disabled={busy || writing || snapshot.mode !== 'application' || snapshot.connection === 'offline'} onClick={() => void runLocal('backup')}>保存工作备份</button>
      {!ready && !writing && gate !== 'checking' && <button className={css.secondaryAction} type="button" disabled={busy || snapshot.mode !== 'application' || snapshot.connection === 'offline'} onClick={() => void runLocal('recheck')}>重新核查</button>}
      {!ready && !writing && gate !== 'checking' && <button className={css.secondaryAction} type="button" onClick={onInspect}>查看核查详情</button>}
    </div>
    {ready && <p className={css.exportHint}>{format === 'html' ? 'HTML 保留标题、段落和排版，保存后用浏览器打开即可阅读。' : 'TXT 适合复制正文或继续编辑，不保留排版样式。'}</p>}
    <div aria-live="polite" role="status">
      {notice && <p>{notice}</p>}
      {saved && <div className={css.exportReceipt}><span>保存位置：{saved.savedPath}</span><button type="button" className={css.secondaryAction} disabled={busy} onClick={() => void perform(true)}>打开所在文件夹</button></div>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>
}
