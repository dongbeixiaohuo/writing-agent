import { STYLE_METRIC_LABELS, STYLE_PATTERN_LABELS, type StylePackage, type StyleMetric } from '../../../writing-core/src/style-package.js'
import type { StyleLibraryResult, StyleSample } from '../../../writing-core/src/style-profile.js'
import css from './StyleLibraryDialog.module.css'

const number = (key: StyleMetric, value: number) => key.endsWith('Rate') ? `${Math.round(value * 100)}%` : value.toLocaleString('zh-CN')
export function StylePackageDetails({ pack, samples }: { pack: StylePackage; samples: readonly StyleSample[] }) {
  return <div className={css.packageDetails}>
    {pack.version === 2 && <p>这是旧版风格包，仍可使用。重新提取并保存，可获得完整写作指南和连贯示例；旧项目保留原选择，需重新选择更新后的风格。</p>}
    {pack.patterns.length > 0 && <details><summary>写法与结构 · {pack.patterns.length} 条具体选择</summary><ul>{pack.patterns.map((pattern, index) => <li key={index}><strong>{pattern.name ?? STYLE_PATTERN_LABELS[pattern.kind]}</strong>：{pattern.instruction}{pattern.whenToUse && <p>适用：{pattern.whenToUse}</p>}{pattern.avoid && <p>不要误用：{pattern.avoid}</p>}</li>)}</ul><p>以上是提取时的分析记录；实际写作以你编辑后的指南为准。</p></details>}
    <details><summary>样文统计 · {pack.statistics.articles.length} 篇的实际区间</summary>
      <p>由程序统计完整导入文本，不由模型估算。排除空白字符，每个非空行视为一段，以中英文问号、叹号和中文句号分句；小标题按 Markdown 标记识别。区间用于观察，不是写作配额或相似度评分。</p>
      <table><thead><tr><th>指标</th><th>最小值–最大值</th></tr></thead><tbody>{(Object.keys(STYLE_METRIC_LABELS) as StyleMetric[]).map(key => <tr key={key}><td>{STYLE_METRIC_LABELS[key]}</td><td>{number(key, pack.statistics.ranges[key].min)}–{number(key, pack.statistics.ranges[key].max)}</td></tr>)}</tbody></table>
      <ul>{pack.statistics.articles.map(article => <li key={article.sampleId}>{article.title} · {article.metrics.characters} 字符 · {article.metrics.paragraphs} 段</li>)}</ul>
    </details>
    <details open={pack.version === 3}><summary>{pack.version === 3 ? '连贯原文示范' : '句式片段'} · {pack.snippets.length} 条</summary><p>学习选材、推理、叙述和语言，保留示范上下文；不沿用人物、事实、立场或亲历。写作时按阶段选取完整示例。</p>
      {pack.snippets.length ? pack.snippets.map((snippet, index) => <div key={index}><blockquote><small>{samples.find(sample => sample.id === snippet.sampleId)?.title ?? snippet.sampleId} · {snippet.paragraphIds?.join(' → ') ?? snippet.paragraphId.split(':')[0]} · {STYLE_PATTERN_LABELS[snippet.kind]}</small>{snippet.quote.split('\n\n').map((paragraph, i) => <p key={i}>{paragraph}</p>)}</blockquote>{snippet.explanation && <p><strong>写法分析：</strong>{snippet.explanation}</p>}{snippet.application && <p><strong>如何迁移：</strong>{snippet.application}</p>}</div>) : <p>本次没有选出片段，核心风格卡仍可正常使用。</p>}
    </details>
    {!!pack.contrasts?.length && <details><summary>同题表达对照 · 分析模型创作</summary><p>这些对照用于解释写法差异，不是作者原文，也不作为新文章的事实来源。</p>{pack.contrasts.map((c,i) => <div key={i}><p><strong>普通写法：</strong>{c.plain}</p><p><strong>风格写法：</strong>{c.styled}</p><p><strong>差别：</strong>{c.explanation}</p></div>)}</details>}
  </div>
}
export function StylePreviewComparison({ evaluation }: { evaluation: NonNullable<StyleLibraryResult['evaluation']> }) {
  return <details className={css.packageDetails}><summary>试写对照 · 查看节奏差异</summary><p>这是程序统计的形式差异，不代表风格优劣，也不是盲测或复刻成功证明。短文与长样文的篇幅不同，不比较总字数和标题数量。</p>
    {evaluation.differences.length ? <table><thead><tr><th>指标</th><th>试写</th><th>样文区间</th></tr></thead><tbody>{evaluation.differences.map(row => <tr key={row.metric}><td>{STYLE_METRIC_LABELS[row.metric]}</td><td>{number(row.metric, row.actual)}</td><td>{number(row.metric, row.min)}–{number(row.metric, row.max)}</td></tr>)}</tbody></table> : <p>所比较的节奏指标均在样文区间内。请继续阅读正文判断实际效果。</p>}
    {evaluation.repeatedSnippets.length > 0 && <p>试写直接复用了 {evaluation.repeatedSnippets.length} 条较长片段，建议改写。这里仅检查已选片段，不是对全部样文的查重。</p>}
  </details>
}
