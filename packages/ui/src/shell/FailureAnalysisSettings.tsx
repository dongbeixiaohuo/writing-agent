import { useEffect, useState } from 'react'
import type { DesktopFailureAnalysisStatus, DesktopHostConfiguration } from '../../../client-bridge/src/desktop-bridge.ts'
import type { GroupModelSelection } from '../../../client-bridge/src/model-groups.ts'
import css from './WritingAgentShell.module.css'

const selectionValue = (selection: GroupModelSelection | null): string =>
  selection ? JSON.stringify([selection.profileId, selection.model]) : ''

export function FailureAnalysisSettings({ host }: { host: DesktopHostConfiguration }) {
  const [status, setStatus] = useState<DesktopFailureAnalysisStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = Boolean(host.failureAnalysisStatus && host.configureFailureAnalysisModel)

  useEffect(() => {
    if (!host.failureAnalysisStatus) return
    let current = true
    void host.failureAnalysisStatus().then(value => {
      if (current) setStatus(value)
    }).catch(() => {
      if (current) setError('暂时无法读取分析模型。请重新打开设置。')
    })
    return () => { current = false }
  }, [host])

  async function save(selection: GroupModelSelection | null) {
    if (!host.configureFailureAnalysisModel || saving) return
    setSaving(true)
    setError(null)
    try {
      setStatus(await host.configureFailureAnalysisModel(selection))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '分析模型未保存，请重试。')
    } finally {
      setSaving(false)
    }
  }

  if (!supported) return null
  const selected = selectionValue(status?.selection ?? null)
  const choices = status?.choices ?? []
  const unavailable = selected !== '' && !choices.some(choice => selectionValue(choice.selection) === selected)
  return <section className={css.dataCard} aria-labelledby="failure-analysis-settings-title">
    <div className={css.dataCardHeader}><div>
      <strong id="failure-analysis-settings-title">报错分析</strong>
      <p>在运行记录点击「分析这次报错」时，才会向所选模型发送脱敏的步骤状态。</p>
    </div></div>
    <label className={css.formField}>
      <span>分析模型</span>
      <select aria-label="分析模型" value={selected} disabled={status === null || saving} onChange={event => {
        const choice = choices.find(item => selectionValue(item.selection) === event.target.value)
        void save(choice?.selection ?? null)
      }}>
        <option value="">不启用报错分析</option>
        {unavailable && <option value={selected} disabled>{status!.selection!.model} · 不可用</option>}
        {choices.map(choice => <option key={selectionValue(choice.selection)} value={selectionValue(choice.selection)}>{choice.label}</option>)}
      </select>
    </label>
    {status?.notice && <small className={css.settingHint}>{status.notice}</small>}
    {status !== null && choices.length === 0 && <small className={css.settingHint}>请先在「模型」中验证一个可用模型。</small>}
    {unavailable && choices.length > 0 && <small className={css.settingHint}>请重新验证原模型，或在这里换一个。</small>}
    {saving && <small className={css.settingHint} role="status">正在保存…</small>}
    {error && <div className={css.editorError} role="alert">{error}</div>}
  </section>
}
