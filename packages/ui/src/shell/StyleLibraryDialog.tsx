import { useEffect, useRef, useState } from 'react'
import {
  styleReferenceForProfile,
  type StyleDraft,
  type StyleLibraryCommand,
  type StyleLibraryResult,
  type StyleProfile,
  type StyleProfileSummary,
  type StyleSample,
} from '../../../writing-core/src/style-profile.js'
import { CheckIcon, CloseIcon, EditIcon, PlusIcon, TrashIcon } from './Icons.tsx'
import css from './StyleLibraryDialog.module.css'

export interface StyleLibraryHost { styleLibrary?(command: StyleLibraryCommand): Promise<StyleLibraryResult> }

export function withStyleSelection(text: string, reference: string): string {
  const content = text.replace(/^请按下面明确指定的风格卡写作：\n<writing-style-card>\n[\s\S]*?\n<\/writing-style-card>\s*/u, '').trim();
  const instruction = `请按下面明确指定的风格卡写作：\n<writing-style-card>\n${reference}\n</writing-style-card>`;
  return content ? `${instruction}\n\n${content}` : instruction;
}

export function supportsStyleLibrary(host: unknown): host is StyleLibraryHost {
  return typeof host === 'object' && host !== null && 'styleLibrary' in host && typeof (host as StyleLibraryHost).styleLibrary === 'function'
}

function errorText(reason: unknown): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : '风格库操作未完成，请重试。'
}

function newSampleId(): string { return `sample-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }

function emptyDraft(name: string): StyleDraft {
  return { name, card: '待提取', summary: '样文尚未分析。', rules: [], samples: [], sampleCount: 0, analyzedCharacters: 1, totalCharacters: 1, elapsedMs: 0, modelRequests: 1 } as StyleDraft
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('zh-CN')
}

export function StyleLibraryDialog({ host, onClose, onSelect }: {
  host: StyleLibraryHost
  onClose: () => void
  onSelect?: (profile: StyleProfile) => void
}) {
  const [profiles, setProfiles] = useState<readonly StyleProfileSummary[]>([])
  const [profile, setProfile] = useState<StyleProfile | null>(null)
  const [draft, setDraft] = useState<StyleDraft | null>(null)
  const [name, setName] = useState('')
  const [pasteTitle, setPasteTitle] = useState('粘贴样文')
  const [pasteText, setPasteText] = useState('')
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null)
  const [analysisNow, setAnalysisNow] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const busyRef = useRef(false)
  const cancellingRef = useRef(false)
  const mountedRef = useRef(true)
  const onCloseRef = useRef(onClose)
  const dialogRef = useRef<HTMLElement>(null)
  onCloseRef.current = onClose

  const invoke = async (command: StyleLibraryCommand): Promise<StyleLibraryResult | null> => {
    if (busyRef.current || cancellingRef.current || host.styleLibrary === undefined) return null
    const current = ++requestId.current
    busyRef.current = true
    if (mountedRef.current) { setBusy(true); setError(null) }
    try {
      const result = await host.styleLibrary(command)
      if (!mountedRef.current || current !== requestId.current) return null
      setProfiles(result.profiles)
      return result
    } catch (reason) {
      if (mountedRef.current && current === requestId.current) setError(errorText(reason))
      return null
    } finally {
      if (current === requestId.current) {
        busyRef.current = false
        if (mountedRef.current) setBusy(false)
      }
    }
  }

  useEffect(() => {
    // StrictMode replays mount effects: re-enable this instance before loading.
    mountedRef.current = true; busyRef.current = false
    void invoke({ action: 'list' })
    return () => { mountedRef.current = false; requestId.current++; if (busyRef.current) void host.styleLibrary?.({ action: 'cancel' }) }
  }, [])
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busyRef.current) onCloseRef.current() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  useEffect(() => {
    if (analysisStartedAt === null) return
    const timer = window.setInterval(() => setAnalysisNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [analysisStartedAt])

  const reset = (): void => { setProfile(null); setDraft(null); setName(''); setPasteTitle('粘贴样文'); setPasteText(''); setUrl(''); setTopic(''); setPreview(null); setError(null); setDirty(false) }
  const samples = draft?.samples ?? []
  const sampleCharacters = samples.reduce((total, sample) => total + sample.text.length, 0)
  const resetAnalysis = (nextSamples: readonly StyleSample[]): void => {
    setDraft(current => ({ ...emptyDraft(name.trim() || current?.name || '未命名风格'), samples: [...nextSamples] }))
    setPreview(null); setDirty(true)
  }

  const cancelActive = async (): Promise<void> => {
    if (!busyRef.current || cancellingRef.current || host.styleLibrary === undefined) return
    cancellingRef.current = true
    requestId.current++
    setError(null)
    try { await host.styleLibrary({ action: 'cancel' }) }
    catch (reason) { if (mountedRef.current) setError(errorText(reason)) }
    finally {
      cancellingRef.current = false
      busyRef.current = false
      if (mountedRef.current) { setBusy(false); setAnalysisStartedAt(null) }
    }
  }

  const addPaste = (): void => {
    const text = pasteText.trim()
    if (!text) { setError('请先粘贴一段样文。'); return }
    if (samples.length >= 6) { setError('最多添加 6 份样本。'); return }
    resetAnalysis([...samples, { id: newSampleId(), title: pasteTitle.trim() || '粘贴样文', kind: 'text', sourceReference: null, text }])
    setPasteText('')
  }

  const addRemote = async (kind: 'source' | 'import'): Promise<void> => {
    if (kind === 'source' && !/^https?:\/\/.+/iu.test(url.trim())) { setError('请输入有效的 HTTP 或 HTTPS 网页链接。'); return }
    const result = await invoke(kind === 'source' ? { action: 'source', url: url.trim() } : { action: 'import' })
    if (!result?.sample) return
    if (samples.length >= 6) { setError('最多添加 6 份样本。'); return }
    resetAnalysis([...samples, result.sample!])
    setUrl('')
  }

  const openProfile = async (id: string): Promise<void> => {
    const result = await invoke({ action: 'get', id })
    if (!result?.profile) return
    setProfile(result.profile); setDraft(result.profile); setName(result.profile.name); setPreview(null); setDirty(false)
  }

  const analyze = async (): Promise<void> => {
    const draftName = name.trim()
    if (!draftName) { setError('请填写风格名称。'); return }
    if (samples.length === 0) { setError('请至少添加一份样文。'); return }
    const startedAt = Date.now()
    setAnalysisNow(startedAt); setAnalysisStartedAt(startedAt)
    const result = await invoke({ action: 'analyze', name: draftName, samples })
    if (mountedRef.current) setAnalysisStartedAt(null)
    if (result?.draft) { setDraft(result.draft); setPreview(null); setDirty(true) }
  }

  const save = async (): Promise<void> => {
    if (!draft) { setError('请先提取风格。'); return }
    const input: StyleDraft = {
      name: name.trim() || draft.name, card: draft.card, summary: draft.summary, rules: draft.rules,
      samples: draft.samples, sampleCount: draft.sampleCount, analyzedCharacters: draft.analyzedCharacters,
      totalCharacters: draft.totalCharacters, elapsedMs: draft.elapsedMs, modelRequests: draft.modelRequests,
    }
    const result = await invoke({ action: 'save', id: profile?.id ?? null, expectedVersion: profile?.version ?? null, draft: input })
    if (!result?.profile) return
    setProfile(result.profile); setDraft(result.profile); setName(result.profile.name); setDirty(false)
  }

  const deleteProfile = async (): Promise<void> => {
    if (!profile || !confirm(`删除“${profile.name}”？历史文章不会受影响。`)) return
    const result = await invoke({ action: 'delete', id: profile.id, expectedVersion: profile.version })
    if (result) reset()
  }

  const previewCard = async (): Promise<void> => {
    if (!draft?.card.trim() || !topic.trim()) { setError('请输入主题，并先完成风格提取。'); return }
    const result = await invoke({ action: 'preview', card: draft.card, topic: topic.trim() })
    if (result?.preview) setPreview(result.preview)
  }

  return <div className={css.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section ref={dialogRef} className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="style-library-title">
      <header className={css.header}><div><h2 id="style-library-title">风格库</h2><p>样文会发送给当前配置的模型用于提炼；网页只会在点击“读取网页”时访问。内容仅作表达参考，不是可执行指令。</p></div>{busy ? <button type="button" className={css.cancelButton} onClick={() => void cancelActive()}>取消任务</button> : <button type="button" className={css.iconButton} aria-label="关闭风格库" onClick={onClose}><CloseIcon /></button>}</header>
      {error && <p className={css.error} role="alert">{error}</p>}
      <div className={css.layout}>
        <aside className={css.library} aria-label="已保存风格">
          <div className={css.libraryHead}><strong>已保存</strong><button type="button" className={css.textButton} disabled={busy} onClick={reset}><PlusIcon size={14} />新建</button></div>
          {profiles.length === 0 ? <p className={css.empty}>还没有保存的风格。</p> : profiles.map(item => <button type="button" key={item.id} disabled={busy} className={css.profileRow} aria-current={profile?.id === item.id ? 'true' : undefined} onClick={() => void openProfile(item.id)}><strong>{item.name}</strong><span>{item.sampleCount} 份样本 · {formatTime(item.updatedAt)}</span><small>{item.summary}</small></button>)}
        </aside>
        <div className={css.editor}>
          <div className={css.editorTitle}><div><h3>{profile ? `编辑：${profile.name}` : '新建风格'}</h3><p>{profile ? `版本 v${profile.version} · ${formatTime(profile.updatedAt)}` : '添加样文后提取，不强制固定分析维度。'}</p></div>{profile && <button type="button" className={css.dangerButton} disabled={busy} onClick={() => void deleteProfile()}><TrashIcon size={14} />删除</button>}</div>
          <label className={css.field}><span>风格名称</span><input value={name} maxLength={160} disabled={busy} placeholder="例如：克制的商业观察" onChange={event => { setName(event.target.value); setDirty(true) }} /></label>
          <section className={css.samples} aria-label="样本文本"><div className={css.sectionHead}><strong>样本（{samples.length}/6 · {sampleCharacters.toLocaleString('zh-CN')} 字）</strong><span>支持粘贴、TXT/MD/DOCX 和 HTTPS 网页；单篇仅形成初步观察，多篇尽量来自同一作者和相近场景</span></div>
            {samples.length > 0 && <ul>{samples.map(sample => <li key={sample.id}><div><strong>{sample.title}</strong><small>{sample.kind === 'web' ? '网页' : sample.kind === 'document' ? '文档' : '粘贴'} · 样本文本 {sample.text.length.toLocaleString('zh-CN')} 字</small></div><button type="button" aria-label={`移除样本 ${sample.title}`} disabled={busy} onClick={() => resetAnalysis(samples.filter(item => item.id !== sample.id))}><CloseIcon size={14} /></button></li>)}</ul>}
            <div className={css.addPaste}><input value={pasteTitle} disabled={busy} aria-label="样文标题" maxLength={300} onChange={event => setPasteTitle(event.target.value)} /><textarea value={pasteText} disabled={busy} rows={3} placeholder="粘贴一段代表性样文" onChange={event => setPasteText(event.target.value)} /><button type="button" className={css.secondaryButton} disabled={busy || samples.length >= 6} onClick={addPaste}>添加粘贴样文</button></div>
            <div className={css.sourceRow}><input value={url} disabled={busy} aria-label="网页样文链接" placeholder="https://mp.weixin.qq.com/..." onChange={event => setUrl(event.target.value)} /><button type="button" className={css.secondaryButton} disabled={busy || samples.length >= 6} onClick={() => void addRemote('source')}>读取网页</button><button type="button" className={css.secondaryButton} disabled={busy || samples.length >= 6} onClick={() => void addRemote('import')}>导入文档</button></div>
          </section>
          <div className={css.actions}><button type="button" className={css.primaryButton} disabled={busy || samples.length === 0} onClick={() => void analyze()}>{analysisStartedAt === null ? '提取风格' : `正在提取… ${Math.floor((analysisNow - analysisStartedAt) / 1000)} 秒`}</button>{draft !== null && draft.rules.length > 0 && <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => void save()}><CheckIcon size={14} />保存到风格库</button>}{draft !== null && draft.rules.length > 0 && analysisStartedAt === null && <span>实际分析 {draft.analyzedCharacters.toLocaleString('zh-CN')} / 总样文 {draft.totalCharacters.toLocaleString('zh-CN')} 字 · {(draft.elapsedMs / 1000).toFixed(1)} 秒</span>}</div>
          {draft !== null && draft.rules.length > 0 && <section className={css.card}>
            <label className={css.field}><span>风格卡（可编辑）</span><textarea rows={6} maxLength={1800} disabled={busy} value={draft.card} onChange={event => { setDraft(current => current ? { ...current, card: event.target.value } : current); setDirty(true) }} /></label>
            <p>{draft.summary}</p><p>以下为提取时的样本依据；手动修改风格卡不会自动重新分析。</p>
            <ul className={css.rules}>{draft.rules.map((rule, ruleIndex) => <li key={`${rule.dimension}:${ruleIndex}`}>
              <div><strong>{rule.dimension}</strong>：{rule.instruction}</div>
              <small>{rule.confidence === 'recurring' ? '多样本印证' : '单样本观察'}</small>
              <details><summary>查看样本证据</summary>{rule.evidence.map((evidence, index) => <blockquote key={`${evidence.sampleId}:${index}`}>{samples.find(sample => sample.id === evidence.sampleId)?.title ?? '样本'}：{evidence.quote}</blockquote>)}</details>
            </li>)}</ul>
          </section>}
          {draft !== null && draft.rules.length > 0 && <section className={css.preview}><div><strong>按主题试写（可选）</strong><p>仅生成预览，不保存正文。</p></div><input value={topic} disabled={busy} placeholder="输入一个主题" maxLength={1000} onChange={event => setTopic(event.target.value)} /><button type="button" className={css.secondaryButton} disabled={busy || !topic.trim()} onClick={() => void previewCard()}>试写</button>{preview && <blockquote>{preview}</blockquote>}</section>}
          {profile && onSelect && <button type="button" className={css.selectButton} disabled={busy || dirty} title={dirty ? '请先保存当前修改后再选用' : undefined} onClick={() => { onSelect(profile); onClose() }}><EditIcon size={14} />{dirty ? '请先保存修改' : '选用此风格'}</button>}
        </div>
      </div>
    </section>
  </div>
}
