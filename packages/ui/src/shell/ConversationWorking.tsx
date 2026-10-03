import { useEffect, useState } from 'react'
import type { BridgeSnapshot, ClientBridge } from '../../../client-bridge/src/protocol.ts'
import { conversationWorkingCopy } from './interaction.ts'
import { MarkdownContent } from './MarkdownContent.tsx'
import css from './WritingAgentShell.module.css'

const MATERIAL_EXCERPT_LENGTH = 600

function materialExcerpt(text: string) {
  const normalized = text.trim()
  return normalized.length > MATERIAL_EXCERPT_LENGTH
    ? `${normalized.slice(0, MATERIAL_EXCERPT_LENGTH).trimEnd()}…`
    : normalized
}

/** One honest status line, not a simulated sequence of model thoughts. */
export function ConversationWorking({ snapshot, bridge }: { snapshot: BridgeSnapshot; bridge: ClientBridge }) {
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [materialIndex, setMaterialIndex] = useState(0)
  const materials = snapshot.liveActivity?.materials ?? []
  const materialKey = materials.map(item => item.id).join(':')
  useEffect(() => { setMaterialIndex(0) }, [materialKey])
  const selectedMaterialIndex = Math.min(materialIndex, Math.max(0, materials.length - 1))
  const material = materials[selectedMaterialIndex]
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => { setStopping(false); setError(null) }, [snapshot.activeRunId])
  const copy = conversationWorkingCopy(snapshot.liveActivity, now)
  const stop = async () => {
    if (!snapshot.activeRunId || stopping) return
    setStopping(true)
    try { await bridge.cancelRun(snapshot.activeRunId) }
    catch { setError('未能停止，请再试一次。'); setStopping(false) }
  }
  return <section className={css.conversationWorking} aria-label="写作进行中" data-conversation-working data-conversation-message={snapshot.liveReply ? undefined : 'status'}>
    <div className={css.workingHeading}>
      <strong role="status" aria-label="正在处理你的消息">{copy.title}</strong>
      <div className={css.workingActions}>
        {snapshot.liveActivity && <span className={css.workingElapsed} aria-live="off">本轮已用时 {copy.elapsedSeconds} 秒</span>}
        <button type="button" onClick={() => void stop()} disabled={stopping || !snapshot.activeRunId}>{stopping ? '正在停止…' : '停止'}</button>
      </div>
    </div>
    <p>{copy.detail}</p>
    {snapshot.liveActivity?.workPreview && !snapshot.liveReply && <aside className={css.workPreview} data-work-preview aria-label="临时素材预览">
      <strong>{snapshot.liveActivity.workPreview.label}</strong>
      <MarkdownContent content={snapshot.liveActivity.workPreview.text} />
      <small>正在加工；这份临时预览不会作为最终回复留在主对话中。</small>
    </aside>}
    {material && !snapshot.liveReply && <aside className={css.materialPreview} data-material-preview aria-label="参考材料预览">
      <div className={css.materialPreviewHeader}>
        <strong>参考材料预览（{materials.length} 份）</strong>
        {materials.length > 1 && <select aria-label="选择参考材料" value={selectedMaterialIndex} onChange={event => setMaterialIndex(Number(event.target.value))}>
          {materials.map((item, index) => <option value={index} key={item.id}>{item.label}</option>)}
        </select>}
      </div>
      <p>这是本轮已提供的材料，不是实际进度，不会自动切换。可手动选择并查看节选。</p>
      <details data-material-details>
        <summary>查看“{material.label}”节选</summary>
        <div className={css.materialExcerpt}><MarkdownContent content={materialExcerpt(material.text)} /></div>
        <small>仅展示节选，不是模型新回复或任务完成度。</small>
      </details>
    </aside>}
    {error && <p role="alert">{error}</p>}
  </section>
}
