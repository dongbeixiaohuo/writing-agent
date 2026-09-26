import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { DesktopHostConfiguration, DesktopProviderSetupInput, DesktopProviderStatusView, DesktopSavedProviderView } from '../../../client-bridge/src/desktop-bridge.ts'
import { PROVIDER_PRESETS, PROVIDER_PROTOCOL_LABELS, PROVIDER_CHANNELS, providerRegionLabel, providerProductLabel, applyProviderPreset, identifyProviderPreset, RESPONSES_PREFERRED_OVER_CHAT } from '../../../client-bridge/src/provider-presets.ts'
import { ProviderPresetPicker } from './ProviderPresetPicker.tsx'
import { commandErrorMessage, normalizeProviderSetup, providerConnectionMessage, setupErrorMessage } from './onboarding.ts'
import { PlusIcon, TrashIcon } from './Icons.tsx'
import css from './WritingAgentShell.module.css'

const emptyForm = (): DesktopProviderSetupInput => ({ profileId: null, displayName: '',
  kind: 'openai_compatible', providerId: 'custom', baseURL: '', model: '', tools: 'supported',
  usage: 'reported', apiKey: '', persistence: 'system' })

export function ProviderSettings({ host }: { host: DesktopHostConfiguration | undefined }) {
  const [status, setStatus] = useState<DesktopProviderStatusView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<'preset' | 'custom'>('preset')
  const [presetId, setPresetId] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [models, setModels] = useState<string[]>([''])
  const [selectedModel, setSelectedModel] = useState(0)
  const [catalog, setCatalog] = useState<readonly string[]>([])
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [checkingKey, setCheckingKey] = useState(false)
  const [changePreset, setChangePreset] = useState(false)
  const editRequest = useRef(0)

  useEffect(() => {
    let active = true
    if (!host) { setLoading(false); return }
    void host.providerStatus('summary').then(value => { if (active) setStatus(value) })
      .catch(() => { if (active) setError('模型配置读取失败，请重新打开设置。') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false; editRequest.current++ }
  }, [host])

  const profiles = status?.profiles ?? []
  const existing = profiles.find(profile => profile.profileId === form.profileId)
  const preset = PROVIDER_PRESETS.find(item => item.id === presetId)
  const matchesPreset = preset?.kind === form.kind && preset.baseURL === form.baseURL.trim().replace(/\/+$/u, '')
  const presetModels = mode === 'preset' && matchesPreset ? preset?.modelExamples ?? [] : []
  const suggestedModels = [...new Set([...catalog, ...presetModels])]
  const canReuseKey = existing?.configured === true && existing.kind === form.kind &&
    existing.baseURL.replace(/\/+$/u, '') === form.baseURL.trim().replace(/\/+$/u, '')
  const update = (patch: Partial<DesktopProviderSetupInput>) => { setForm(current => ({ ...current, ...patch })); setError(null) }

  const openEditor = (profile?: DesktopSavedProviderView) => {
    const request = ++editRequest.current
    setCheckingKey(false)
    setChangePreset(false)
    setError(null); setNotice(null); setCatalog([]); setEditing(true)
    if (!profile) {
      setForm(emptyForm()); setModels(['']); setSelectedModel(0); setMode('preset'); setPresetId(''); return
    }
    setForm({ profileId: profile.profileId, displayName: profile.displayName, providerId: profile.providerId,
      baseURL: profile.baseURL, kind: profile.kind, model: profile.model, tools: profile.tools,
      usage: profile.usage, apiKey: '', persistence: profile.credentialPersistence === 'session' ? 'session' : 'system' })
    setModels([...profile.models]); setSelectedModel(Math.max(0, profile.models.indexOf(profile.model)))
    const id = identifyProviderPreset(profile)
    setPresetId(id === 'custom' ? '' : id); setMode(id === 'custom' ? 'custom' : 'preset')
    if (host) {
      setCheckingKey(true)
      void host.providerDetails(profile.profileId).then(detail => {
        if (editRequest.current !== request) return
        setStatus(current => current ? { ...current, profiles: (current.profiles ?? []).map(p => p.profileId === detail.profileId ? detail : p) } : current)
        setForm(current => ({ ...current, persistence: detail.credentialPersistence === 'session' ? 'session' : 'system' }))
      }).catch(reason => {
        if (editRequest.current === request) setError(explain(reason, '已保存的 Key 检查失败，可以重新填写 Key 后保存。'))
      }).finally(() => { if (editRequest.current === request) setCheckingKey(false) })
    }
  }

  const choosePreset = (id: string) => {
    const next = applyProviderPreset(form, id)
    setForm({ ...next, displayName: PROVIDER_PRESETS.find(item => item.id === id)?.offering.provider ?? '' })
    setPresetId(id); setModels(['']); setSelectedModel(0); setCatalog([]); setError(null)
  }

  const explain = (reason: unknown, fallback: string) => {
    const copy = commandErrorMessage(reason, '')
    return copy || setupErrorMessage(reason, fallback)
  }

  const save = async () => {
    if (!host) return
    setError(null); setNotice(null)
    try {
      const input = normalizeProviderSetup({ ...form, models, model: models[selectedModel] ?? '' })
      setBusy(true)
      editRequest.current++; setCheckingKey(false)
      const saved = await host.configureProvider(input)
      setStatus(saved); setChoices({}); setEditing(false); setForm(emptyForm())
      setNotice(`已使用 ${saved.model}。已有项目的下一次消息、确认或重试都会使用此模型。正在验证连接…`)
      const result = await host.testProviderConnection()
      setStatus(current => current ? { ...current, connectionTest: result } : current)
      const copy = providerConnectionMessage(result)
      setNotice(`已使用 ${saved.model}。已有项目下次继续时生效。`)
      if (!result.ok) setError(`配置已保存。${copy.text}`)
    } catch (reason) { setError(explain(reason, '模型配置未保存')) }
    finally { setBusy(false) }
  }

  const select = async (profile: DesktopSavedProviderView) => {
    if (!host) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const saved = await host.selectProvider(profile.profileId, choices[profile.profileId] ?? profile.model)
      setStatus(saved)
      setNotice(`已切换为 ${saved.model}。已有项目的下一次消息、确认或重试都会使用此模型。`)
    } catch (reason) { setError(explain(reason, '模型切换失败')) }
    finally { setBusy(false) }
  }

  const testConnection = async () => {
    if (!host) return
    setBusy(true); setError(null)
    try {
      const result = await host.testProviderConnection()
      setStatus(current => current ? { ...current, connectionTest: result } : current)
      if (!result.ok) setError(providerConnectionMessage(result).text)
    } catch (reason) { setError(explain(reason, '连接验证失败')) }
    finally { setBusy(false) }
  }

  const loadModels = async () => {
    if (!host) return
    setBusy(true); setError(null)
    try {
      const items = await host.listProviderModels({ ...form, model: models[selectedModel]?.trim() || 'catalog-probe' })
      setCatalog(items)
      setNotice(`已获取 ${items.length} 个模型。可以在模型 ID 输入框中选择，或手动填写。目录不代表已验证工具调用能力。`)
    } catch (reason) { setError(explain(reason, '模型目录读取失败，可以手动填写模型 ID。')) }
    finally { setBusy(false) }
  }

  return <div className={css.providerSettings}>
    <h3 className={css.settingsSectionTitle}>模型</h3>
    <p className={css.providerLead}>{editing
      ? (existing ? `编辑 ${existing.displayName} 的连接、Key 和模型。` : '添加供应商和 API 密钥，选择本次写作使用的模型。')
      : '添加供应商和 API 密钥，选择本次写作使用的模型。'}</p>
    {!editing && <p className={css.settingHint}>模型选择对所有项目生效，包括已有对话；从下一次请求开始使用。</p>}
    {!host ? <p className={css.aboutCopy}>请在桌面版中添加和切换模型。</p> : <>
      {loading && <p role="status">正在读取模型配置…</p>}
      {!editing && <>
      <div className={css.providerList} aria-label="已保存的模型供应商">
        {profiles.map(profile => {
          const identity = PROVIDER_PRESETS.find(item => item.id === identifyProviderPreset(profile))
          const active = status?.activeProfileId === profile.profileId
          const model = choices[profile.profileId] ?? profile.model
          const selected = active && model === status?.model
          return <section className={css.providerCard} key={profile.profileId}>
            <div className={css.providerCardHeading}>
              <div className={css.providerIdentity}><strong>{profile.displayName}</strong>
                <span className={clsx(css.providerDot, profile.configured && css.providerDotReady)} aria-label={profile.credentialChecked === false ? '配置已保存，Key 尚未检查' : profile.configured ? '已保存 Key' : '需要填写 Key'} />
                {active && <span className={css.providerCurrent}>当前使用</span>}
              </div>
              <button type="button" className={css.secondaryAction} disabled={busy} onClick={() => openEditor(profile)} aria-label={`编辑 ${profile.displayName}`}>编辑</button>
            </div>
            <p className={css.settingHint} aria-label={`${profile.displayName} 的配置类型`}>{identity
              ? `预设参考：${providerRegionLabel(identity.offering)} · ${providerProductLabel(identity.offering)} · ${PROVIDER_CHANNELS[identity.offering.channel]}`
              : '自定义连接 · 地区 / 套餐未确认'} · {PROVIDER_PROTOCOL_LABELS[profile.kind]}</p>
            {identity && ['shared', 'token', 'coding', 'agent', 'step', 'subscription'].includes(identity.offering.product) && <p className={css.settingHint}>套餐与扣费方式以 Key 的实际权益为准，未通过连接验证核实。</p>}
            <div className={css.providerModelChoice}>
              <label className={css.formField}><span>使用模型</span><select aria-label={`${profile.displayName} 的模型`} value={model}
                onChange={event => setChoices(current => ({ ...current, [profile.profileId]: event.target.value }))} disabled={busy}>
                {profile.models.map(id => <option value={id} key={id}>{id}</option>)}
              </select></label>
              <button type="button" className={selected ? css.secondaryAction : css.primaryAction} disabled={busy || selected || (profile.credentialChecked !== false && !profile.configured)} onClick={() => void select(profile)}>{selected ? '正在使用' : '使用此模型'}</button>
              {active && <button type="button" className={css.providerCustomize} disabled={busy} onClick={() => void testConnection()}>验证连接</button>}
            </div>
            <p className={css.settingHint}>{profile.credentialChecked === false ? '配置已保存 · 编辑或使用时检查 Key' : !profile.configured ? '未找到可用 Key，请点击编辑补充。' : active && status?.connectionTest
              ? providerConnectionMessage(status.connectionTest).text : 'Key 已保存 · 连接尚未验证'}{profile.credentialPersistence === 'session' ? ' · Key 仅本次启动可用' : ''}</p>
          </section>
        })}
      </div>
      {notice && <p className={css.providerNotice} role="status">{notice}</p>}
      {error && <div className={css.editorError} role="alert">{error}</div>}
      <button type="button" className={css.addProviderButton} disabled={busy || loading} onClick={() => openEditor()}><PlusIcon />添加模型供应商</button>
      </>}
      {editing && <>
        {error && <div className={css.editorError} role="alert">{error}</div>}
        <fieldset className={css.providerEditor} disabled={busy}>
          <legend className={css.srOnly}>{existing ? '编辑模型供应商' : '添加模型供应商'}</legend>
          <div className={css.providerTabs} role="tablist" aria-label="供应商配置方式">
            <button type="button" role="tab" aria-selected={mode === 'preset'} onClick={() => setMode('preset')}>预置模型供应商</button>
            <button type="button" role="tab" aria-selected={mode === 'custom'} onClick={() => setMode('custom')}>自定义模型 API</button>
          </div>
          <p className={css.providerIntro}>{mode === 'preset' ? '先按购买页面核对国内 / 国际站和套餐，再选择接口协议，填写该账号的 Key 和模型 ID。' : '连接中转服务或自部署模型，填写服务地址、协议和模型 ID。'}</p>
          {mode === 'preset' && <>{form.profileId !== null && !changePreset
            ? <div className={css.providerPresetInfo} aria-label="当前供应商预设">
                <strong>{preset ? preset.label : '自定义连接'}</strong>
                <p className={css.settingHint}>正在编辑已保存的配置，直接修改下面的 Key、模型和显示名称即可；只有更换供应商时才需要展开预设目录。</p>
                <button type="button" className={css.secondaryAction} onClick={() => setChangePreset(true)}>更换供应商预设</button>
              </div>
            : <ProviderPresetPicker key={form.profileId ?? 'new'} selectedId={presetId} onSelect={choosePreset} />}
          {preset && <div className={css.providerPresetInfo} aria-label="预设连接信息">
            <p className={css.settingHint}>当前配置 · 搜索不会更改下面的配置，点击结果才会切换。</p>
            {Object.hasOwn(RESPONSES_PREFERRED_OVER_CHAT, preset.id) && <p className={css.settingHint}>此配置使用已保存的 Chat Completions 协议，继续保留；不会自动迁移到 Responses。</p>}
            {matchesPreset ? <><strong>{preset.offering.provider}</strong><dl>
              <div><dt>账号地区</dt><dd>{providerRegionLabel(preset.offering)}</dd></div>
              <div><dt>服务 / 套餐</dt><dd>{providerProductLabel(preset.offering)}</dd></div>
              <div><dt>接入渠道</dt><dd>{PROVIDER_CHANNELS[preset.offering.channel]}</dd></div>
            </dl></> : <strong>已自定义连接，地区与套餐归属未确认</strong>}
            <dl><div><dt>API 协议</dt><dd>{PROVIDER_PROTOCOL_LABELS[form.kind]}</dd></div>
              <div><dt>请求地址</dt><dd>{form.baseURL}</dd></div></dl>
            <p className={css.settingHint}>{matchesPreset ? preset.note : '当前地址已不同于所选预设。请自行核对协议与 Key，不再使用该预设的套餐说明和模型目录。'}</p>
          </div>}
          <details className={css.advancedSettings}><summary>通用 API、套餐和协议有什么区别？</summary>
            <p className={css.settingHint}>通用 API 通常按用量或平台额度计费；Coding Plan、Token Plan 等按各自套餐权益计费，不能把网页会员当作 API 额度。Chat Completions、Responses、Messages 是请求格式，不是套餐名称。</p>
            <p className={css.settingHint}>国内 / 国际标识用于区分账号入口，不承诺数据存储位置。套餐可能限制应用范围，请核对官方规则；连接成功不代表一定扣套餐额度。未列出的地区、业务空间或专属网关请用自定义配置，不会自动切换到其他地址。</p>
            <p className={css.settingHint}>KAT-Coder 需要账号专属接入点 ID，目前未做一键预设；Azure 资源模板与 OAuth 登录也不等同于普通 API Key 配置。</p>
          </details></>}
          <label className={css.formField}><span>显示名称</span><input aria-label="供应商显示名称" value={form.displayName ?? ''} placeholder="例如：我的 MiniMax" onChange={event => update({ displayName: event.target.value })} /></label>
          {mode === 'custom' && <div className={css.providerTransport}>
            <label className={css.formField}><span>API 地址</span><input aria-label="API 地址" value={form.baseURL} placeholder="填写服务商提供的 HTTPS 基础地址" onChange={event => update({ baseURL: event.target.value, apiKey: '' })} /></label>
            <label className={css.formField}><span>API 协议</span><select aria-label="API 协议" value={form.kind} onChange={event => update({ kind: event.target.value as DesktopProviderSetupInput['kind'], apiKey: '' })}>
              <option value="openai_compatible">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic_compatible">Anthropic Messages</option>
            </select></label>
          </div>}
          <label className={css.formField}><span>API Key</span><input aria-label="API Key" type="password" autoComplete="new-password" value={form.apiKey} onChange={event => update({ apiKey: event.target.value })}
            placeholder={canReuseKey ? '已保存，留空可继续使用；输入新 Key 可替换' : '输入此供应商的 API Key'} />
            <small className={css.settingHint}>{canReuseKey ? '修改模型名称不需要重新填写 Key。' : 'Key 优先保存在 Windows 凭据管理器，不会显示在配置文件中。'}</small></label>
          {checkingKey && <p className={css.settingHint} role="status">正在检查此供应商已保存的 Key，其他设置可以先编辑…</p>}
          <details className={css.advancedSettings}>
            <summary>自定义设置</summary>
            <div className={css.providerTransport}>
              <label className={css.formField}><span>配置标识</span><input aria-label="配置标识" value={form.providerId} placeholder="例如：my-provider" onChange={event => update({ providerId: event.target.value })} /></label>
              {mode === 'preset' && <><label className={css.formField}><span>API 地址</span><input aria-label="API 地址" value={form.baseURL} onChange={event => update({ baseURL: event.target.value, apiKey: '' })} /></label>
                <button type="button" className={css.providerCustomize} onClick={() => setMode('custom')}>修改协议或使用自定义 API</button></>}
            </div>
          </details>
          <div className={css.providerModelsHeader}><div><strong>模型目录</strong><p className={css.settingHint}>填写服务商提供的完整模型 ID，并选择要使用的模型。</p></div>
            <button type="button" className={css.providerCustomize} disabled={!form.baseURL || (!canReuseKey && !form.apiKey)} onClick={() => void loadModels()}>获取可用模型</button></div>
          {presetModels.length > 0 && <p className={css.settingHint}>输入框提供收录时的模型 ID 示例，可直接填写其他 ID；示例不代表你的账号已开通，不会自动选中。</p>}
          <datalist id="provider-model-catalog">{suggestedModels.map(id => <option key={id} value={id} />)}</datalist>
          <div className={css.providerModelRows}>{models.map((id, index) => <div className={css.providerModelRow} key={index}>
            <input type="radio" name="provider-current-model" aria-label={`使用第 ${index + 1} 个模型`} checked={selectedModel === index} onChange={() => setSelectedModel(index)} />
            <input aria-label={`模型 ID ${index + 1}`} list="provider-model-catalog" value={id} placeholder={preset?.modelHint ?? '例如：服务商控制台中的模型 ID'}
              onChange={event => setModels(current => current.map((value, i) => i === index ? event.target.value : value))} />
            <button type="button" className={css.miniButton} aria-label={`移除第 ${index + 1} 个模型`} disabled={models.length === 1} onClick={() => {
              setModels(current => current.filter((_, i) => i !== index)); setSelectedModel(current => current === index ? 0 : current > index ? current - 1 : current)
            }}><TrashIcon /></button>
          </div>)}</div>
          <button type="button" className={clsx(css.secondaryAction, css.providerAddModel)} onClick={() => setModels(current => [...current, ''])} disabled={models.length >= 100}><PlusIcon />添加模型</button>
          <p className={css.settingHint}>保存后会发送一条最小请求来验证连接，可能产生少量模型费用。正在生成回复时，请先停止或等本轮结束再切换。</p>
          <div className={css.providerEditorActions}><button type="button" className={css.secondaryAction} onClick={() => { editRequest.current++; setCheckingKey(false); setEditing(false); setForm(emptyForm()); setError(null) }}>取消</button>
            <button type="button" className={css.primaryAction} disabled={checkingKey && !form.apiKey} onClick={() => void save()}>{busy ? '处理中…' : '保存并验证连接'}</button></div>
        </fieldset></>}
      {busy && <p className={css.settingHint} role="status">正在处理模型配置，请稍候…</p>}
    </>}
  </div>
}
