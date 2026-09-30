import { useEffect, useState } from 'react'
import type {
  DesktopHostConfiguration,
  SearchSettingsView,
} from '../../../client-bridge/src/desktop-bridge.ts'
import css from './WritingAgentShell.module.css'
import {
  searchSettingsInput,
  searchSettingsValidation,
} from './search-settings.ts'

export function SearchSettings({ host }: { host: DesktopHostConfiguration | undefined }) {
  const [settings, setSettings] = useState<SearchSettingsView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const available = host?.searchStatus !== undefined && host.configureSearch !== undefined

  useEffect(() => {
    if (!available) return
    let active = true
    setLoading(true)
    setError(null)
    void host.searchStatus!().then(result => {
      if (active) setSettings(result)
    }).catch(() => {
      if (active) setError('暂时无法读取搜索设置，请稍后重试。')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [available, host])

  if (!available) {
    return <section className={css.searchSettings}>
      <h3 className={css.settingsSectionTitle}>搜索</h3>
      <p className={css.aboutCopy}>外部搜索设置仅在支持该功能的桌面版中可用。当前环境不会读取或保存搜索凭据。</p>
    </section>
  }

  const validation = settings === null ? null : searchSettingsValidation(settings, apiKey)
  const update = (patch: Partial<Pick<SearchSettingsView, 'parallelEnabled' | 'tavilyEnabled'>>): void => {
    setSettings(current => current === null ? current : { ...current, ...patch })
    setNotice(null)
    setError(null)
  }
  const save = async (): Promise<void> => {
    if (settings === null || validation !== null) return
    try {
      setSaving(true)
      setError(null)
      setNotice(null)
      const result = await host.configureSearch!(searchSettingsInput(settings, apiKey))
      setSettings(result)
      setApiKey('')
      setNotice('搜索设置已保存。')
    } catch (reason) {
      setError(reason instanceof Error && reason.message.length > 0
        ? `搜索设置保存失败：${reason.message}`
        : '搜索设置保存失败，请稍后重试。')
    } finally {
      setSaving(false)
    }
  }

  return <section className={css.searchSettings}>
    <div className={css.searchHeading}>
      <div><h3 className={css.settingsSectionTitle}>搜索</h3><p>为事实核查补充外部来源。搜索结果仍需要经过来源和证据审查。</p></div>
      <span className={css.searchPrivacyBadge}>凭据不回显</span>
    </div>
    {loading && <p className={css.settingHint} role="status">正在读取搜索设置…</p>}
    {error !== null && <div className={css.editorError} role="alert">{error}</div>}
    {settings !== null && <>
      <div className={css.searchProviderList}>
        <label className={css.searchProviderCard}>
          <span className={css.searchProviderCopy}><strong>Parallel</strong><small>免费搜索，无需 Key，有服务限额；启用后作为第一搜索来源。</small></span>
          <input type="checkbox" role="switch" aria-label="启用 Parallel 搜索" checked={settings.parallelEnabled} disabled={saving} onChange={event => update({ parallelEnabled: event.target.checked })} />
        </label>
        <div className={css.searchProviderCard}>
          <label className={css.searchProviderToggle}>
            <span className={css.searchProviderCopy}><strong>Tavily</strong><small>需要 API Key，用量按 Tavily 账户套餐计费；可单独使用，也可作为 Parallel 失败时的备用。</small></span>
            <input type="checkbox" role="switch" aria-label="启用 Tavily 搜索" checked={settings.tavilyEnabled} disabled={saving} onChange={event => update({ tavilyEnabled: event.target.checked })} />
          </label>
          <label className={css.formField}><span>Tavily API Key</span><input aria-label="Tavily API Key" type="password" autoComplete="new-password" value={apiKey} disabled={saving} onChange={event => { setApiKey(event.target.value); setNotice(null); setError(null) }} placeholder={settings.tavilyKeyConfigured ? '已配置，留空保留现有 Key' : '输入 Tavily API Key'} />
            <small className={css.settingHint}>{settings.tavilyKeyConfigured ? '已保存 Key；页面不会读回密钥原文。' : '尚未配置 Key。'}</small></label>
        </div>
      </div>

      {settings.parallelEnabled && settings.tavilyEnabled && <div className={css.searchRouteNotice} role="status"><strong>搜索顺序</strong><span>Parallel 优先 → 失败时自动切换 Tavily</span></div>}
      <p className={css.settingHint}>开启后，桌面端会先展示具体检索词和搜索服务，得到你的确认后才发送；请勿同意发送私人或客户机密。不发送则本轮仅使用已有材料与模型复核。设置会用于下一步事实核查，已保存的历史核查结果不会自动更新。</p>
      {!settings.parallelEnabled && !settings.tavilyEnabled && <div className={css.searchWarning} role="status"><strong>未启用外部搜索</strong><span>仅由大模型结合已有材料和自身知识再做一次事实性核查，未联网验证。文章仍可能存在事实性错误，请注意核对重要信息。</span></div>}
      {settings.credentialPersistence === 'session' && settings.tavilyKeyConfigured && <div className={css.searchWarning} role="status"><strong>Key 仅本次启动可用</strong><span>系统凭据存储不可用，重启桌面应用后需重新填写 Tavily API Key。</span></div>}
      {validation !== null && <p className={css.searchValidation} role="alert">{validation}</p>}
      {notice !== null && <p className={css.providerNotice} role="status">{notice}</p>}
      <div className={css.searchActions}><span className={css.settingHint}>API Key 留空会保留已有凭据，不会从桌面端读回。</span><button className={css.primaryAction} type="button" disabled={saving || validation !== null} onClick={() => void save()}>{saving ? '正在保存…' : '保存搜索设置'}</button></div>
    </>}
  </section>
}
