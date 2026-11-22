import { useEffect, useState } from 'react'
import type { BridgeSnapshot, ClientBridge } from '../../../client-bridge/src/protocol.ts'
import { conversationWorkingCopy } from './interaction.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import css from './WritingAgentShell.module.css'

/** One honest status line, not a simulated sequence of model thoughts. */
export function ConversationWorking({ snapshot, bridge }: { snapshot: BridgeSnapshot; bridge: ClientBridge }) {
  const [now, setNow] = useState(Date.now)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      <div className={css.workingIdentity}><AgentAvatar persona={copy.persona} /><strong role="status">{copy.title}</strong></div>
      <div className={css.workingActions}>
        {snapshot.liveActivity && <span className={css.workingElapsed} aria-live="off">本轮已用时 {copy.elapsedSeconds} 秒</span>}
        <button type="button" onClick={() => void stop()} disabled={stopping || !snapshot.activeRunId}>{stopping ? '正在停止…' : '停止'}</button>
      </div>
    </div>
    <p>{copy.detail}</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
