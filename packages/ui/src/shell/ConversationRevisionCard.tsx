import { useState } from 'react'
import type { BridgeSnapshot, ClientBridge } from '../../../client-bridge/src/protocol.ts'
import css from './WritingAgentShell.module.css'

export function ConversationRevisionCard({ bridge, snapshot, onContentChange }: {
  bridge: ClientBridge; snapshot: BridgeSnapshot; onContentChange: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const proposals = snapshot.revisionWorkspace.proposals.filter(proposal => proposal.status === 'proposed')
  const disabled = busy !== null || snapshot.mode !== 'application' || snapshot.connection === 'offline' || snapshot.activeRunId !== null
  async function resolve(id: string, accept: boolean) {
    setBusy(id); setNotice(null)
    try {
      if (accept) await bridge.acceptRevision(id)
      else await bridge.rejectRevision(id, '用户选择保留原稿')
      setNotice(accept ? '修改已保存为新版本，其他段落保持不变；正式导出前需要重新核查。' : '已保留原稿。')
      onContentChange()
    } catch {
      setNotice('未能应用这次修改，原稿保持不变。请确认稿件版本是否变化，再重新提出修改要求。')
    } finally { setBusy(null) }
  }
  return <>
    {proposals.map(proposal => {
      const stale = proposal.baseBodyVersionId !== snapshot.revisionWorkspace.bodyVersionId
      return <section className={css.conversationExport} aria-label="稿件修改建议" key={proposal.id}>
        <span className={css.exportEyebrow}>修改建议 · 尚未应用</span>
        <h2>{proposal.instruction}</h2>
        <p>{stale ? '稿件已变化，这份建议基于旧版本，请在对话中重新提出修改。' : '只展示本次修改的段落。你接受后才会保存为新版本；也可以继续告诉我怎么调整。'}</p>
        {proposal.diff.map((diff, index) => <div key={`${diff.targetBlockId}:${index}`}>
          {diff.before !== null && <p style={{ whiteSpace: 'pre-wrap' }}><strong>修改前</strong><br /><del>{diff.before}</del></p>}
          {diff.after !== null && <p style={{ whiteSpace: 'pre-wrap' }}><strong>修改后</strong><br /><ins>{diff.after}</ins></p>}
        </div>)}
        <div className={css.exportActions}>
          <button type="button" className={css.primaryAction} disabled={disabled || stale} onClick={() => void resolve(proposal.id, true)}>接受这次修改</button>
          <button type="button" className={css.secondaryAction} disabled={disabled} onClick={() => void resolve(proposal.id, false)}>保留原稿</button>
        </div>
      </section>
    })}
    {notice && <p role="status">{notice}</p>}
  </>
}
