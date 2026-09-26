import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { PROVIDER_REGIONS, PROVIDER_PRODUCTS, PROVIDER_PROTOCOL_LABELS, PROVIDER_CHANNELS, filterProviderPresets, providerRegionLabel, providerProductLabel } from '../../../client-bridge/src/provider-presets.ts'
import css from './WritingAgentShell.module.css'

const PAGE_SIZE = 12

// Keep typing state inside the picker: editing a query must not rerender the
// credential editor, model directory or saved-profile list on each keystroke.
export const ProviderPresetPicker = memo(function ProviderPresetPicker({ selectedId, onSelect }: {
  selectedId: string; onSelect: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState('')
  const [product, setProduct] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const list = useRef<HTMLUListElement>(null)
  const results = useMemo(() => filterProviderPresets(query, { region, product }), [query, region, product])
  useEffect(() => { if (list.current) list.current.scrollTop = 0 }, [query, region, product])
  const reset = () => { setQuery(''); setRegion(''); setProduct(''); setLimit(PAGE_SIZE) }
  return <section className={css.providerPicker} aria-label="查找预置供应商">
    <label className={css.formField}><span>搜索供应商</span><input type="search" aria-label="搜索预置供应商" value={query}
      placeholder="名称、协议或模型 ID，例如：智谱 国内 Coding" aria-controls="provider-search-results"
      onChange={event => { setQuery(event.target.value); setLimit(PAGE_SIZE) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') event.preventDefault()
        if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button')?.focus() }
      }} /></label>
    <div className={css.providerFilters}>
      <label className={css.formField}><span>账号地区</span><select aria-label="筛选账号地区" value={region}
        onChange={event => { setRegion(event.target.value); setLimit(PAGE_SIZE) }}>
        <option value="">全部地区</option>{Object.entries(PROVIDER_REGIONS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <label className={css.formField}><span>服务 / 套餐类型</span><select aria-label="筛选服务类型" value={product}
        onChange={event => { setProduct(event.target.value); setLimit(PAGE_SIZE) }}>
        <option value="">全部类型</option>{Object.entries(PROVIDER_PRODUCTS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
    </div>
    <div className={css.providerSearchHeading}>
      <p className={css.settingHint} role="status" aria-live="polite">{results.length ? `找到 ${results.length} 个匹配配置，点击下面的结果选择。` : '没有匹配的预设，可以清空筛选或使用自定义模型 API。'}</p>
      {(query || region || product) && <button type="button" className={css.providerCustomize} onClick={reset}>清空筛选</button>}
    </div>
    <ul ref={list} id="provider-search-results" className={css.providerSearchResults} aria-label="供应商搜索结果">
      {results.slice(0, limit).map(item => <li key={item.id}><button type="button" data-provider-id={item.id}
        aria-label={`选择 ${item.label}`} aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>
        <span><strong>{item.offering.provider}</strong><span>{selectedId === item.id ? '已选择' : PROVIDER_CHANNELS[item.offering.channel]}</span></span>
        <span>{providerRegionLabel(item.offering)} · {providerProductLabel(item.offering)} · {PROVIDER_PROTOCOL_LABELS[item.kind]}</span>
      </button></li>)}
    </ul>
    {results.length > limit && <button type="button" className={css.providerCustomize} onClick={() => setLimit(current => current + PAGE_SIZE)}>显示更多（已显示 {limit} / {results.length}）</button>}
    <p className={css.settingHint}>同一服务和套餐同时收录两种 OpenAI 协议时，只展示 Responses。现有 Chat 配置继续保留，需要其他协议可使用自定义 API。</p>
  </section>
})
