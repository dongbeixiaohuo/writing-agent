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
  const [testing, setTesting] = useState<'parallel' | 'tavily' | null>(null)
  const [dirty, setDirty] = useState(false)
  const busy = saving || testing !== null
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
    setDirty(true)
  }
  const verify = async (provider: 'parallel' | 'tavily'): Promise<SearchSettingsView | undefined> => {
    if (!host.testSearchConnection) return undefined
    setTesting(provider)
    setError(null)
    setSettings(current => current === null ? current : {
      ...current, verification: { ...current.verification, [provider]: undefined },
    })
    try {
      const result = await host.testSearchConnection(provider)
      setSettings(result)
      return result
    } catch {
      setError('连接验证未完成，请稍后重试；未验证成功不标记为可用。')
      return undefined
    } finally { setTesting(null) }
  }
  const connection = (provider: 'parallel' | 'tavily') => {
    const result = dirty || testing === provider ? undefined : settings?.verification?.[provider]
    return <div className={css.searchConnection}>
      <span className={result?.status === 'available' ? css.searchConnectionAvailable : css.settingHint} role="status">
        {testing === provider ? '正在发送公开测试查询…' : result?.status === 'available' ? '● 已验证可用' : result?.status === 'failed' ? '验证未通过' : '未验证'}
      </span>
      {result && <small className={css.settingHint}>{new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })} · {(result.elapsedMs / 1000).toFixed(1)} 秒 · {result.message}</small>}
      <button type="button" className={css.secondaryAction} disabled={busy || dirty || !host.testSearchConnection || (provider === 'tavily' && !settings?.tavilyKeyConfigured)} onClick={() => void verify(provider)}>验证 {provider === 'tavily' ? 'Tavily' : 'Parallel'} 连接</button>
    </div>
  }
  const save = async (): Promise<void> => {
    if (settings === null || validation !== null) return
    try {
      setSaving(true)
      setError(null)
      setNotice(null)
      const result = await host.configureSearch!(searchSettingsInput(settings, apiKey))
      setSettings(result)
      setDirty(false)
      setApiKey('')
      setNotice('搜索设置已保存；已保存不代表服务可用。')
      if (result.parallelEnabled) await verify('parallel')
      if (result.tavilyEnabled || apiKey.trim()) await verify('tavily')
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
        <div className={css.searchProviderCard}>
          <label className={css.searchProviderToggle}>
          <span className={css.searchProviderCopy}><strong>Parallel</strong><small>免费搜索，无需 Key，有服务限额；启用后作为第一搜索来源。</small></span>
          <input type="checkbox" role="switch" aria-label="启用 Parallel 搜索" checked={settings.parallelEnabled} disabled={busy} onChange={event => update({ parallelEnabled: event.target.checked })} />
          </label>
          {connection('parallel')}
        </div>
        <div className={css.searchProviderCard}>
          <label className={css.searchProviderToggle}>
            <span className={css.searchProviderCopy}><strong>Tavily</strong><small>需要 API Key，用量按 Tavily 账户套餐计费；可单独使用，也可作为 Parallel 失败时的备用。</small></span>
            <input type="checkbox" role="switch" aria-label="启用 Tavily 搜索" checked={settings.tavilyEnabled} disabled={busy} onChange={event => update({ tavilyEnabled: event.target.checked })} />
          </label>
          <label className={css.formField}><span>Tavily API Key</span><input aria-label="Tavily API Key" type="password" autoComplete="new-password" value={apiKey} disabled={busy} onChange={event => { setApiKey(event.target.value); setNotice(null); setError(null); setDirty(true) }} placeholder={settings.tavilyKeyConfigured ? '已配置，留空保留现有 Key' : '输入 Tavily API Key'} />
            <small className={css.settingHint}>{settings.tavilyKeyConfigured ? '已保存 Key；页面不会读回密钥原文。' : '尚未配置 Key。'}</small></label>
          {connection('tavily')}
        </div>
      </div>

      {settings.parallelEnabled && settings.tavilyEnabled && <div className={css.searchRouteNotice} role="status"><strong>搜索顺序</strong><span>Parallel 优先 → 失败时自动切换 Tavily</span></div>}
      <p className={css.settingHint}>连接验证会向所选服务发送固定公开查询“中华人民共和国成立日期 1949年10月1日”，不读取你的文章；Tavily 每次验证会消耗一次 basic 搜索请求的用量。可用标记仅代表本次启动中最近一次验证，修改配置或重启后需重新验证。</p>
      <p className={css.settingHint}>每次核查运行最多 6 次不同检索（失败也计数），相同查询复用结果。单次联网总时限 20 秒，每个 HTTP 请求最多 8 秒；双服务共享时限并为备用服务保留机会。不自动重复失败请求，停止后不继续付费回退。</p>
      <p className={css.settingHint}>开启并保存即允许自动搜索公开事实，不再逐次弹窗。检索词会发送给已启用的服务；请勿将私人或客户机密作为检索内容。具体检索词、服务、耗时与结果可在运行记录查看；关闭全部服务后不再联网，仅使用已有材料与模型复核。公开 HTTP 和 HTTPS 来源均可读取。已保存的历史核查结果不会自动更新。</p>
      {!settings.parallelEnabled && !settings.tavilyEnabled && <div className={css.searchWarning} role="status"><strong>未启用外部搜索</strong><span>仅由大模型结合已有材料和自身知识再做一次事实性核查，未联网验证。文章仍可能存在事实性错误，请注意核对重要信息。</span></div>}
      {settings.credentialPersistence === 'session' && settings.tavilyKeyConfigured && <div className={css.searchWarning} role="status"><strong>Key 仅本次启动可用</strong><span>系统凭据存储不可用，重启桌面应用后需重新填写 Tavily API Key。</span></div>}
      {validation !== null && <p className={css.searchValidation} role="alert">{validation}</p>}
      {notice !== null && <p className={css.providerNotice} role="status">{notice}</p>}
      <div className={css.searchActions}><span className={css.settingHint}>API Key 留空会保留已有凭据，不会从桌面端读回。</span><button className={css.primaryAction} type="button" disabled={busy || validation !== null} onClick={() => void save()}>{testing ? '正在验证连接…' : saving ? '正在保存…' : '保存并验证搜索设置'}</button></div>
    </>}
  </section>
}
