import { useEffect, useState } from 'react'
import type { BridgeSnapshot, ClientBridge } from '../../../client-bridge/src/protocol.ts'
import { conversationWorkingCopy } from './interaction.ts'
import { MarkdownContent } from './MarkdownContent.tsx'
import css from './WritingAgentShell.module.css'

/** One honest status line, not a simulated sequence of model thoughts. */
export function ConversationWorking({ snapshot, bridge }: { snapshot: BridgeSnapshot; bridge: ClientBridge }) {
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [materialIndex, setMaterialIndex] = useState(0)
  const materials = snapshot.liveActivity?.materials ?? []
  const materialKey = materials.map(item => item.id).join(':')
  useEffect(() => { setMaterialIndex(0) }, [materialKey])
  useEffect(() => {
    if (materials.length < 2 || snapshot.liveReply) return
    // Present already supplied materials once, then hold the last excerpt.
    // Never simulate another model request or endlessly replay a progress loop.
    const timer = setInterval(() => setMaterialIndex(index => Math.min(index + 1, materials.length - 1)), 6000)
    return () => clearInterval(timer)
  }, [materialKey, materials.length, !!snapshot.liveReply])
  const material = materials[Math.min(materialIndex, materials.length - 1)]
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
    {material && !snapshot.liveReply && <aside className={css.workPreview} data-material-preview aria-label="已提供素材预览">
      <strong>{material.label} · {Math.min(materialIndex + 1, materials.length)} / {materials.length}</strong>
      <MarkdownContent content={material.text} />
      <small>已提供给当前专家的内容节选，不是模型新回复。最终答复生成后此预览会收起。</small>
    </aside>}
    {error && <p role="alert">{error}</p>}
  </section>
}
