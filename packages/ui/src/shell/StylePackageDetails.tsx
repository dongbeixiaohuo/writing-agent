import { STYLE_METRIC_LABELS, STYLE_PATTERN_LABELS, type StylePackage, type StyleMetric } from '../../../writing-core/src/style-package.js'
import type { StyleLibraryResult, StyleSample } from '../../../writing-core/src/style-profile.js'
import css from './StyleLibraryDialog.module.css'

const number = (key: StyleMetric, value: number) => key.endsWith('Rate') ? `${Math.round(value * 100)}%` : value.toLocaleString('zh-CN')
export function StylePackageDetails({ pack, samples }: { pack: StylePackage; samples: readonly StyleSample[] }) {
  return <div className={css.packageDetails}>
    {pack.patterns.length > 0 && <details open><summary>写法与结构</summary><ul>{pack.patterns.map((pattern, index) => <li key={index}><strong>{STYLE_PATTERN_LABELS[pattern.kind]}</strong>：{pattern.instruction}</li>)}</ul></details>}
    <details><summary>样文统计 · {pack.statistics.articles.length} 篇的实际区间</summary>
      <p>由程序统计完整导入文本，不由模型估算。排除空白字符，每个非空行视为一段，以中英文问号、叹号和中文句号分句；小标题按 Markdown 标记识别。区间用于观察，不是写作配额或相似度评分。</p>
      <table><thead><tr><th>指标</th><th>最小值–最大值</th></tr></thead><tbody>{(Object.keys(STYLE_METRIC_LABELS) as StyleMetric[]).map(key => <tr key={key}><td>{STYLE_METRIC_LABELS[key]}</td><td>{number(key, pack.statistics.ranges[key].min)}–{number(key, pack.statistics.ranges[key].max)}</td></tr>)}</tbody></table>
      <ul>{pack.statistics.articles.map(article => <li key={article.sampleId}>{article.title} · {article.metrics.characters} 字符 · {article.metrics.paragraphs} 段</li>)}</ul>
    </details>
    <details><summary>句式片段 · {pack.snippets.length} 条</summary><p>只学句式和节奏，不沿用人物、事实、立场或亲历。写作时按阶段选取少量片段。</p>
      {pack.snippets.length ? pack.snippets.map((snippet, index) => <blockquote key={index}><small>{samples.find(sample => sample.id === snippet.sampleId)?.title ?? snippet.sampleId} · {snippet.paragraphId.split(':')[0]} · {STYLE_PATTERN_LABELS[snippet.kind]}</small><p>{snippet.quote}</p></blockquote>) : <p>本次没有选出片段，核心风格卡仍可正常使用。</p>}
    </details>
  </div>
}
export function StylePreviewComparison({ evaluation }: { evaluation: NonNullable<StyleLibraryResult['evaluation']> }) {
  return <details className={css.packageDetails}><summary>试写对照 · 查看节奏差异</summary><p>这是程序统计的形式差异，不代表风格优劣，也不是盲测或复刻成功证明。短文与长样文的篇幅不同，不比较总字数和标题数量。</p>
    {evaluation.differences.length ? <table><thead><tr><th>指标</th><th>试写</th><th>样文区间</th></tr></thead><tbody>{evaluation.differences.map(row => <tr key={row.metric}><td>{STYLE_METRIC_LABELS[row.metric]}</td><td>{number(row.metric, row.actual)}</td><td>{number(row.metric, row.min)}–{number(row.metric, row.max)}</td></tr>)}</tbody></table> : <p>所比较的节奏指标均在样文区间内。请继续阅读正文判断实际效果。</p>}
    {evaluation.repeatedSnippets.length > 0 && <p>试写直接复用了 {evaluation.repeatedSnippets.length} 条较长片段，建议改写。这里仅检查已选片段，不是对全部样文的查重。</p>}
  </details>
}
