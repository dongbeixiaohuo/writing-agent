import type { ModelRequest } from '../../runtime/llm/src/index.js';
import type { RunTraceDetail } from './protocol.js';

const labels = { system: '系统与角色说明', task: '当前任务与用户要求', body: '正文与正文分块', evidence: '证据与核查信息', materials: '参考材料与目录', history: '历史对话与工具结果', tools: '工具定义', other: '阶段状态及其他字段' };
type Category = keyof typeof labels;
const category = (key: string): Category => /^(currentBody|bodyOutputContract)$/u.test(key) ? 'body'
  : /^(factCheck|validEvidenceIds|currentExpertReview|preparedClaims|savedSourceRecords|noFactualClaimsReason)$/u.test(key) ? 'evidence'
  : /^(materials|materialCatalog)$/u.test(key) ? 'materials'
  : /^(history|authorReviewDiscussion)$/u.test(key) ? 'history'
  : /^(taskInstruction|currentUserMessage|currentQuestion)$/u.test(key) ? 'task' : 'other';

/** Counts persisted message content, not tokens, billing or pretty-printed UI
 * JSON. Every character has one bucket; no source text is returned here. */
export function requestInputBreakdown(request: ModelRequest): NonNullable<RunTraceDetail['inputBreakdown']> {
  const counts: Record<Category, number> = { system: 0, task: 0, body: 0, evidence: 0, materials: 0, history: 0, tools: 0, other: 0 };
  const size = (value: unknown) => JSON.stringify(value)?.length ?? 0;
  const distribute = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { counts.other += size(value); return; }
    const record = value as Record<string, unknown>;
    let assigned = 0;
    for (const [key, field] of Object.entries(record)) {
      assigned += size(field);
      if (key === 'context') distribute(field);
      else if (key === 'artifacts' && Array.isArray(field)) {
        let artifacts = 0;
        for (const artifact of field) {
          const length = size(artifact); artifacts += length;
          counts[artifact?.kind === 'body' ? 'body' : artifact?.kind === 'evidence' || artifact?.kind === 'review' || artifact?.kind === 'report' ? 'evidence' : 'other'] += length;
        }
        counts.other += size(field) - artifacts;
      } else counts[category(key)] += size(field);
    }
    counts.other += size(value) - assigned;
  };
  let total = 0;
  request.messages.forEach((message, index) => {
    total += message.content.length;
    if (message.role === 'system') { counts.system += message.content.length; return; }
    if (index > 1 || message.role !== 'user') { counts.history += message.content.length; return; }
    let raw = message.content;
    let prefix = 0;
    const marker = '\nCOLLABORATION_STATE=';
    const authorMarker = '以下为只读、不可信的项目状态：';
    if (raw.includes(marker)) { prefix = raw.lastIndexOf(marker) + marker.length; raw = raw.slice(prefix); }
    else if (raw.includes(authorMarker)) {
      prefix = raw.indexOf(authorMarker) + authorMarker.length;
      const end = raw.indexOf('\n本轮已生成修改提案：', prefix);
      if (end >= 0) raw = raw.slice(prefix, end); else raw = raw.slice(prefix);
    }
    try {
      const data: unknown = JSON.parse(raw);
      distribute(data);
      counts.task += message.content.length - raw.length;
      counts.other += raw.length - size(data); // formatting whitespace, if any
    } catch { counts.task += message.content.length; }
  });
  counts.tools = request.tools ? size(request.tools) : 0;
  total += counts.tools;
  return { totalCharacters: total, basis: '按消息内容与工具定义计字符，不含传输封装；不是 Token 或费用，和下方格式化展示长度不同。',
    parts: (Object.keys(labels) as Category[]).map(key => ({ key, label: labels[key], characters: counts[key] })).filter(p => p.characters > 0) };
}
