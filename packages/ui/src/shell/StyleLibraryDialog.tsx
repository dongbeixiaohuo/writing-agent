import { useEffect, useRef, useState } from 'react'
import {
  STYLE_SAMPLE_LIMIT, STYLE_IMPORT_ERRORS, ensureStyleSampleCapacity, normalizeStyleUrl, validateStyleSamples,
  type StyleImportItem, type StyleImportError,
  type StyleDraft,
  type StyleLibraryCommand,
  type StyleLibraryResult,
  type StyleProfile,
  type StyleProfileSummary,
  type StyleSample,
} from '../../../writing-core/src/style-profile.js'
import { CheckIcon, CloseIcon, EditIcon, PlusIcon, TrashIcon } from './Icons.tsx'
import css from './StyleLibraryDialog.module.css'
import { StylePackageDetails, StylePreviewComparison } from './StylePackageDetails.tsx'
import { STYLE_CARD_LIMIT } from '../../../writing-core/src/style-package.js'
import { MarkdownContent } from './MarkdownContent.tsx'

export interface StyleLibraryHost { styleLibrary?(command: StyleLibraryCommand): Promise<StyleLibraryResult> }

export function supportsStyleLibrary(host: unknown): host is StyleLibraryHost {
  return typeof host === 'object' && host !== null && 'styleLibrary' in host && typeof (host as StyleLibraryHost).styleLibrary === 'function'
}

function errorText(reason: unknown): string {
  if (reason instanceof Error && Object.hasOwn(STYLE_IMPORT_ERRORS, reason.message)) return STYLE_IMPORT_ERRORS[reason.message as StyleImportError]
  return reason instanceof Error && reason.message.trim() ? reason.message : '风格库操作未完成，请重试。'
}

export function prepareStyleLinks(input: string, samples: readonly StyleSample[]): { urls: string[]; duplicateCount: number } {
  const tokens = input.trim().split(/[\s，；]+/u).filter(Boolean)
  if (!tokens.length) throw new Error('STYLE_SOURCE_URL_INVALID')
  const known = new Set(samples.filter(sample => sample.kind === 'web' && sample.sourceReference).map(sample => normalizeStyleUrl(sample.sourceReference!)))
  const urls: string[] = []; let duplicateCount = 0
  for (const token of tokens) {
    const url = normalizeStyleUrl(token)
    if (known.has(url)) { duplicateCount++; continue }
    known.add(url); urls.push(url)
  }
  ensureStyleSampleCapacity(samples.length, urls.length)
  return { urls, duplicateCount }
}

export function mergeStyleImports(current: readonly StyleSample[], items: readonly StyleImportItem[]): { samples: StyleSample[]; items: StyleImportItem[] } {
  ensureStyleSampleCapacity(current.length, items.length)
  let samples = [...current]
  const results = items.map((item): StyleImportItem => {
    if (item.status === 'failed') return item
    try { samples = validateStyleSamples([...samples, item.sample]); return item }
    catch (reason) {
      const code = reason instanceof Error && Object.hasOwn(STYLE_IMPORT_ERRORS, reason.message) ? reason.message as StyleImportError : 'STYLE_DOCUMENT_INVALID'
      return { status: 'failed', label: item.label, code }
    }
  })
  return { samples, items: results }
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
  const [importItems, setImportItems] = useState<readonly StyleImportItem[]>([])
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const [importActivity, setImportActivity] = useState<string | null>(null)
  const [topic, setTopic] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [evaluation, setEvaluation] = useState<StyleLibraryResult['evaluation']>(undefined)
  const [dirty, setDirty] = useState(false)
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null)
  const [analysisNow, setAnalysisNow] = useState(0)
  const [busy, setBusy] = useState(false)
  const [activeAction, setActiveAction] = useState<StyleLibraryCommand['action'] | null>(null)
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
    if (mountedRef.current) { setBusy(true); setActiveAction(command.action); setError(null) }
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
        if (mountedRef.current) { setBusy(false); setActiveAction(null) }
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

  const reset = (): void => { setProfile(null); setDraft(null); setName(''); setPasteTitle('粘贴样文'); setPasteText(''); setUrl(''); setTopic(''); setPreview(null); setError(null); setDirty(false); setImportItems([]); setImportNotice(null) }
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
      if (mountedRef.current) { setBusy(false); setActiveAction(null); setAnalysisStartedAt(null); setImportActivity(null) }
    }
  }

  const addPaste = (): void => {
    const text = pasteText.trim()
    if (!text) { setError('请先粘贴一段样文。'); return }
    try {
      const merged = validateStyleSamples([...samples, { id: newSampleId(), title: pasteTitle.trim() || '粘贴样文', kind: 'text', sourceReference: null, text }])
      resetAnalysis(merged); setError(null)
    } catch (reason) { setError(errorText(reason)); return }
    setPasteText('')
  }

  const addRemote = async (kind: 'source' | 'import'): Promise<void> => {
    if (busyRef.current || cancellingRef.current) return
    let links: ReturnType<typeof prepareStyleLinks> | null = null
    try {
      if (kind === 'source') links = prepareStyleLinks(url, samples)
      else ensureStyleSampleCapacity(samples.length, 1)
    } catch (reason) { setError(errorText(reason)); return }
    setError(null); setImportItems([])
    setImportNotice(links?.duplicateCount ? `已忽略 ${links.duplicateCount} 个重复链接。` : null)
    if (links && !links.urls.length) return
    setImportActivity(links ? `正在读取 ${links.urls.length} 篇网页样文，完成后请你确认内容。` : '请在文件窗口选择样文，选好后会在这里显示。')
    const operationToken = requestId.current + 1
    const result = await invoke(links ? { action: 'sources', urls: links.urls, remainingSlots: STYLE_SAMPLE_LIMIT - samples.length } : { action: 'import', remainingSlots: STYLE_SAMPLE_LIMIT - samples.length })
    if (!mountedRef.current || operationToken !== requestId.current) return
    setImportActivity(null)
    if (!result || result.cancelled) return
    const items = result.items ?? (result.sample ? [{ label: result.sample.title, status: 'loaded' as const, sample: result.sample }] : [])
    try {
      const merged = mergeStyleImports(samples, items)
      setImportItems(merged.items)
      if (merged.samples.length > samples.length) resetAnalysis(merged.samples)
      if (links) setUrl(merged.items.filter(item => item.status === 'failed' && item.code !== 'STYLE_SAMPLE_DUPLICATE').map(item => item.label).join('\n'))
    } catch (reason) { setError(errorText(reason)) }
  }

  const openProfile = async (id: string): Promise<void> => {
    const result = await invoke({ action: 'get', id })
    if (!result?.profile) return
    setProfile(result.profile); setDraft(result.profile); setName(result.profile.name); setPreview(null); setDirty(false); setImportItems([]); setImportNotice(null); setUrl('')
  }

  const analyze = async (): Promise<void> => {
    const draftName = name.trim()
    if (!draftName) { setError('请填写风格名称。'); return }
    if (samples.length === 0) { setError('请至少添加一份样文。'); return }
    try { ensureStyleSampleCapacity(0, samples.length) } catch (reason) { setError(errorText(reason)); return }
    const startedAt = Date.now()
    setAnalysisNow(startedAt); setAnalysisStartedAt(startedAt)
    const result = await invoke({ action: 'analyze', name: draftName, samples })
    if (mountedRef.current) setAnalysisStartedAt(null)
    if (result?.draft) { setDraft(result.draft); setPreview(null); setDirty(true) }
  }

  const save = async (): Promise<void> => {
    if (!draft) { setError('请先提取风格。'); return }
    const input: StyleDraft = {
      name: profile?.builtin && name.trim() === profile.name ? `${profile.name}（副本）` : name.trim() || draft.name, card: draft.card, summary: draft.summary, rules: draft.rules, notes: draft.notes,
      samples: draft.samples, sampleCount: draft.sampleCount, analyzedCharacters: draft.analyzedCharacters,
      totalCharacters: draft.totalCharacters, elapsedMs: draft.elapsedMs, modelRequests: draft.modelRequests,
      ...(draft.package ? { package: draft.package } : {}),
    }
    const result = await invoke({ action: 'save', id: profile?.builtin ? null : profile?.id ?? null, expectedVersion: profile?.builtin ? null : profile?.version ?? null, draft: input })
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
    setPreview(null); setEvaluation(undefined)
    const result = await invoke({ action: 'preview', card: draft.card, topic: topic.trim(), ...(draft.package ? { package: draft.package } : {}) })
    if (result?.preview) { setPreview(result.preview); setEvaluation(result.evaluation) }
  }

  return <div className={css.overlay} role="presentation" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
    <section ref={dialogRef} className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="style-library-title">
      <header className={css.header}><div><h2 id="style-library-title">风格库</h2><p>提取时，样文会发送给你配置的模型。网页只会在点击“批量读取网页”后访问。</p></div>{busy ? <button type="button" className={css.cancelButton} onClick={() => void cancelActive()}>取消任务</button> : <button type="button" className={css.iconButton} aria-label="关闭风格库" onClick={onClose}><CloseIcon /></button>}</header>
      {error && <p className={css.error} role="alert">{error}</p>}
      {activeAction === 'analyze' && <p className={css.operationStatus} role="status">风格分析 Agent 正在阅读样文，提炼有辨识度的写法和示例。</p>}
      {activeAction === 'preview' && <p className={css.operationStatus} role="status">内容主笔 Agent 正在按这套风格试写，完成后请你看看效果。</p>}
      <div className={css.layout}>
        <aside className={css.library} aria-label="已保存风格">
          <div className={css.libraryHead}><strong>已保存</strong><button type="button" className={css.textButton} disabled={busy} onClick={reset}><PlusIcon size={14} />新建</button></div>
          {profiles.length === 0 ? <p className={css.empty}>还没有保存的风格。</p> : profiles.map(item => <button type="button" key={item.id} disabled={busy} className={css.profileRow} aria-current={profile?.id === item.id ? 'true' : undefined} onClick={() => void openProfile(item.id)}><strong>{item.name}</strong><span>{item.builtin ? '内置风格' : `${item.sampleCount} 份样本`} · {formatTime(item.updatedAt)}</span><small>{item.summary}</small></button>)}
        </aside>
        <div className={css.editor}>
          <div className={css.editorTitle}><div><h3>{profile ? `${profile.builtin ? '内置' : '编辑'}：${profile.name}` : '新建风格'}</h3><p>{profile ? `版本 v${profile.version} · ${formatTime(profile.updatedAt)}${profile.builtin ? ' · 修改后另存为个人副本' : ''}` : '添加样文后提取，不强制固定分析维度。'}</p></div>{profile && !profile.builtin && <button type="button" className={css.dangerButton} disabled={busy} onClick={() => void deleteProfile()}><TrashIcon size={14} />删除</button>}</div>
          <label className={css.field}><span>风格名称</span><input value={name} maxLength={160} disabled={busy} placeholder="例如：克制的商业观察" onChange={event => { setName(event.target.value); setDirty(true) }} /></label>
          <section className={css.samples} aria-label="样本文本"><div className={css.sectionHead}><strong>样本（{samples.length}/{STYLE_SAMPLE_LIMIT} · {sampleCharacters.toLocaleString('zh-CN')} 字）</strong><span>支持粘贴、TXT/MD/DOCX 和 HTTP(S) 网页；单篇仅形成初步观察，多篇尽量来自同一作者和相近场景</span></div>
            <p className={css.importHelp}>联合分析最多 {STYLE_SAMPLE_LIMIT} 份，文档、网页和粘贴文字合计；超出后请减少或分组，不会自动截取前十份。文档可一次多选，链接每行一个。</p>
            {samples.length >= STYLE_SAMPLE_LIMIT && <p className={css.importHelp} role="status">已达 {STYLE_SAMPLE_LIMIT} 份上限，请先移除样本再添加，或直接点击“提取风格”。</p>}
            {samples.length > 0 && <ul>{samples.map(sample => <li key={sample.id}><div><strong>{sample.title}</strong><small>{sample.kind === 'web' ? '网页' : sample.kind === 'document' ? '文档' : '粘贴'} · 样本文本 {sample.text.length.toLocaleString('zh-CN')} 字</small></div><button type="button" aria-label={`移除样本 ${sample.title}`} disabled={busy} onClick={() => resetAnalysis(samples.filter(item => item.id !== sample.id))}><CloseIcon size={14} /></button></li>)}</ul>}
            <div className={css.addPaste}><input value={pasteTitle} disabled={busy} aria-label="样文标题" maxLength={300} onChange={event => setPasteTitle(event.target.value)} /><textarea value={pasteText} disabled={busy} rows={3} placeholder="粘贴一段代表性样文" onChange={event => setPasteText(event.target.value)} /><button type="button" className={css.secondaryButton} disabled={busy || samples.length >= STYLE_SAMPLE_LIMIT} onClick={addPaste}>添加粘贴样文</button></div>
            <div className={css.sourceRow}><textarea value={url} disabled={busy} rows={3} maxLength={24_000} aria-label="网页样文链接" placeholder="粘贴多个公众号或网页的完整链接，每行一个" onChange={event => setUrl(event.target.value)} /><div className={css.sourceActions}><button type="button" className={css.secondaryButton} disabled={busy || samples.length >= STYLE_SAMPLE_LIMIT} onClick={() => void addRemote('source')}>批量读取网页</button><button type="button" className={css.secondaryButton} disabled={busy || samples.length >= STYLE_SAMPLE_LIMIT} onClick={() => void addRemote('import')}>批量导入文档</button></div></div>
            {importNotice && <p className={css.importHelp} role="status">{importNotice}</p>}
            {error === STYLE_IMPORT_ERRORS.STYLE_SAMPLE_LIMIT_EXCEEDED && <p className={`${css.error} ${css.importLimitNotice}`} aria-label="批量数量限制" role="status">{error}</p>}
            {importActivity && <p className={css.importHelp} role="status">{importActivity}</p>}
            {importItems.length > 0 && <div className={css.importResults} aria-label="批量导入结果"><p>本批成功添加 {importItems.filter(item => item.status === 'loaded').length} 份，未添加 {importItems.filter(item => item.status === 'failed').length} 份。</p><ul>{importItems.map((item, index) => <li key={`${index}:${item.label}`}><span>{item.label}</span><small>{item.status === 'loaded' ? '已添加' : STYLE_IMPORT_ERRORS[item.code]}</small></li>)}</ul>{importItems.some(item => item.status === 'failed') && <p>成功项已保留。失败链接留在输入框中，可重新点击“批量读取网页”；失败文档可重新选择导入。</p>}</div>}
          </section>
          <div className={css.actions}><button type="button" className={css.primaryButton} disabled={busy || samples.length === 0} onClick={() => void analyze()}>{analysisStartedAt === null ? '提取风格' : `正在提取… ${Math.floor((analysisNow - analysisStartedAt) / 1000)} 秒`}</button>{draft !== null && draft.sampleCount > 0 && <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => void save()}><CheckIcon size={14} />{profile?.builtin ? '另存为个人风格' : '保存到风格库'}</button>}{draft !== null && draft.sampleCount > 0 && analysisStartedAt === null && (draft.modelRequests === 0 ? <span>内置风格 · 可直接试写</span> : <span>已分析 {draft.analyzedCharacters.toLocaleString('zh-CN')} 字样文（共 {draft.totalCharacters.toLocaleString('zh-CN')} 字）</span>)}</div>
          {draft !== null && draft.sampleCount > 0 && <section className={css.card}>
            <label className={css.field}><span>写作指南（可编辑）</span><textarea rows={12} maxLength={STYLE_CARD_LIMIT} disabled={busy} value={draft.card} onChange={event => { setDraft(current => current ? { ...current, card: event.target.value } : current); setDirty(true); setPreview(null) }} /></label>
            <p>{draft.summary}</p><p>{draft.modelRequests === 0 ? '这是预先设计的写法，样文只演示表达。可以直接选用和试写；修改后保存为个人风格，不改变内置版本。' : '这是根据样文归纳的写法，供你调整使用，不是风格对错的判定。可以直接编辑、试写，再保存；手动修改不会重新调用模型。'}</p>
            {!!draft.notes?.length && <div className={css.analysisNotes} role="note" aria-label="提取提示"><strong>提取提示</strong><ul>{draft.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>}
            {draft.package ? <StylePackageDetails pack={draft.package} samples={samples} /> : <p>这是旧版风格卡，可以继续选用；点击“提取风格”可用已有样文重新分析，保存后升级。</p>}
            {draft.package?.version !== 3 && <ul className={css.rules}>{draft.rules.map((rule, ruleIndex) => <li key={`${rule.dimension}:${ruleIndex}`}>
              <div><strong>{rule.dimension}</strong>：{rule.instruction}</div>
              {rule.evidence.length > 0 && <details><summary>查看样文例句（可选）</summary>{rule.evidence.map((evidence, index) => <blockquote key={`${evidence.sampleId}:${index}`}>{samples.find(sample => sample.id === evidence.sampleId)?.title ?? '样本'}：{evidence.quote}</blockquote>)}</details>}
            </li>)}</ul>}
          </section>}
          {draft !== null && draft.sampleCount > 0 && <section className={css.preview}><div><strong>按主题试写（可选）</strong><p>生成约 800–1200 字的短文，看看这套写法用于新主题的效果。试写不会覆盖项目正文。</p></div><input value={topic} disabled={busy} placeholder="输入一个主题" maxLength={1000} onChange={event => setTopic(event.target.value)} /><button type="button" className={css.secondaryButton} disabled={busy || !topic.trim()} onClick={() => void previewCard()}>{activeAction === 'preview' ? '正在试写…' : '试写'}</button>{preview && <><MarkdownContent className={css.previewText} content={preview} />{evaluation && draft.package && <StylePreviewComparison evaluation={evaluation} />}</>}</section>}
          {profile && onSelect && <button type="button" className={css.selectButton} disabled={busy || dirty} title={dirty ? '请先保存当前修改后再选用' : undefined} onClick={() => { onSelect(profile); onClose() }}><EditIcon size={14} />{dirty ? '请先保存修改' : '选用此风格'}</button>}
        </div>
      </div>
    </section>
  </div>
}
