import { createHash } from 'node:crypto';
import type { ArtifactVersion, MaterialRecord } from '../../writing-core/src/index.js';
import { savedNumberedSearchResults } from './fact-search.js';
import type { SessionStore } from '../../runtime/session/src/index.js';

const MAX_READING_SOURCES = 4;
const MAX_READING_CHARACTERS = 20_000;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function sourceKey(url: string): string {
  try { const parsed = new URL(url); parsed.hash = ''; return parsed.href; } catch { return url; }
}

export interface ResearchReading {
  url: string;
  finalUrl: string;
  text: string;
  bodyHash: string;
  truncated: boolean;
  instructionAuthority: 'none';
  sourceType?: 'search_excerpt';
  sourceTitle?: string;
  publishedDate?: string;
  useBoundary?: string;
  supplementEvidence?: { kind: 'documented_rule' | 'calculation_example' | 'reported_context'; useBoundary: string };
}

/** Pack important passages first without increasing the source or text budget. */
export function fitResearchReadings(readings: readonly ResearchReading[]): ResearchReading[] {
  const selected: ResearchReading[] = [];
  let remaining = MAX_READING_CHARACTERS;
  for (const reading of readings) {
    if (!remaining || selected.length === MAX_READING_SOURCES) break;
    const text = reading.text.slice(0, remaining);
    selected.push(text === reading.text ? reading : { ...reading, text, truncated: true });
    remaining -= text.length;
  }
  return selected;
}

export function hasBonusCalculationDetails(text: string) {
  const payoff = '奖金|绩效工资|奖励(?:比例|基数|(?:的)?(?:分配)?方案)|奖池|13薪';
  const factor = '系数|权重|提成|奖励比例|达成率|乘以|计算公式|×';
  const link = '[^。！？；;\n]{0,110}';
  return /基数|奖池|奖金包|目标奖|年度总收益|毛利额|部门绩效|个人(?:绩效|综合系数)|考核等级/u.test(text) &&
    new RegExp(`(?:${payoff})${link}(?:${factor})|(?:${factor})${link}(?:${payoff})`, 'u').test(text);
}

/** Keep the passages the researcher actually read. A claim table is an index,
 * not a replacement for the people, sequence and detail in the source. */
export function researchReadings(storage: Pick<SessionStore, 'listRunEvents'>, projectId: string, research: ArtifactVersion | null,
  materials: readonly MaterialRecord[] = [], includeAuthorizedSnapshots = false, preferActionExcerpts = false) {
  if (!research || research.projectId !== projectId || research.kind !== 'evidence' || research.actor.kind !== 'agent' ||
      research.actor.id !== 'writing-pack/researcher') return [];
  let ledger: Record<string, unknown> | null;
  try { ledger = object(JSON.parse(research.content)); } catch { return []; }
  const sourceRows = (Array.isArray(ledger?.sources) ? ledger.sources : []).map(object);
  const claims = (Array.isArray(ledger?.claims) ? ledger.claims : []).map(object);
  const urls = new Set([...sourceRows, ...claims]
    .map(row => row?.source_url).filter((url): url is string => typeof url === 'string').map(sourceKey));
  const runId = research.actor.runId;
  const events = storage.listRunEvents(runId).filter(e => e.projectId === projectId &&
    e.runId === runId && e.projectSeq < research.createdEventSeq);
  const requests = new Map(events.filter(e => e.type === 'tool.requested' && e.payload.actor === 'research' &&
    e.payload.toolName === 'read_fact_source').map(e => [e.operationId, e]));
  const searched = savedNumberedSearchResults(events).filter(source => source.searchTool === 'search_research_sources');
  const quotes = claims.flatMap(claim => {
    const url = claim?.source_url ?? sourceRows.find(row => row?.source_id === claim?.source_id)?.source_url;
    const quote = claim?.source_quote;
    const kind = claim?.claim_type;
    return typeof url === 'string' && typeof quote === 'string' && quote.trim().length >= 12 ? [{
      url, quote, action: kind === 'action_step' || kind === 'complaint_procedure', caseReport: kind === 'case_report',
    }] : [];
  });
  // A query may be absent from a ledger URL only when the saved excerpt
  // independently matches the ledger's exact quote at the same article path.
  const sameArticle = (left: string, right: string) => {
    if (sourceKey(left) === sourceKey(right)) return true;
    try {
      const a = new URL(left), b = new URL(right);
      return a.origin === b.origin && a.pathname === b.pathname && a.pathname !== '/' && (!a.search || !b.search);
    } catch { return false; }
  };
  const fromSearch = (url: string, quote: string) => {
    const matches = searched.filter(source => sameArticle(source.url, url) && source.excerpt.includes(quote));
    return matches.find(source => sourceKey(source.url) === sourceKey(url)) ??
      (new Set(matches.map(source => sourceKey(source.url))).size === 1 ? matches[0] : undefined);
  };
  let passages: ResearchReading[] = [];
  const seen = new Set<string>();
  let remaining = MAX_READING_CHARACTERS;
  for (const event of [...events].reverse()) {
    if (event.type !== 'tool.completed') continue;
    const request = requests.get(event.operationId), envelope = object(event.payload.result), result = object(envelope?.result);
    const args = object(request?.payload.arguments);
    const savedSource = request && args?.searchCallId ? searched.find(source => source.searchCallId === args.searchCallId &&
      source.resultNumber === args.resultNumber && source.searchSeq < request.projectSeq) : undefined;
    const url = savedSource?.url ?? args?.url;
    if (!request || envelope?.ok !== true || envelope.toolName !== 'read_fact_source' || envelope.runId !== runId ||
        envelope.operationId !== event.operationId || envelope.callId !== event.payload.callId || request.payload.callId !== event.payload.callId ||
        request.payload.requestId !== event.payload.requestId || request.projectSeq >= event.projectSeq ||
        typeof url !== 'string' || seen.has(sourceKey(url)) || result?.requestedUrl !== url ||
        typeof result.finalUrl !== 'string' || typeof result.text !== 'string' || typeof result.bodyHash !== 'string' ||
        result.instructionAuthority !== 'none') continue;
    const pageText = result.text;
    if (!urls.has(sourceKey(url)) && !urls.has(sourceKey(result.finalUrl)) &&
        !quotes.some(item => fromSearch(item.url, item.quote)?.url === url && pageText.includes(item.quote))) continue;
    const text = pageText.slice(0, remaining);
    if (!text) continue;
    passages.push({ url, finalUrl: result.finalUrl, text, bodyHash: result.bodyHash,
      truncated: result.truncated === true || text.length !== result.text.length, instructionAuthority: 'none' });
    seen.add(sourceKey(url)); remaining -= text.length;
    if (!remaining || passages.length === MAX_READING_SOURCES) break;
  }
  passages.reverse();
  // For a confirmed direction, authorized snapshots remain usable even if
  // research left them out of the ledger. Other scopes use matched sources.
  for (const material of materials) {
    const url = material.sourceReference;
    if (material.projectId !== projectId || !url || (!includeAuthorizedSnapshots && !urls.has(sourceKey(url))) || seen.has(sourceKey(url)) ||
        !(material.sourceKind === 'web_snapshot' || material.role === 'source_verified') ||
        !remaining || passages.length === MAX_READING_SOURCES) continue;
    const text = material.content.slice(0, remaining);
    if (!text) continue;
    passages.push({ url, finalUrl: url, text, bodyHash: createHash('sha256').update(material.content).digest('hex'),
      truncated: text.length !== material.content.length, instructionAuthority: 'none' });
    seen.add(sourceKey(url)); remaining -= text.length;
  }
  const savedExcerpt = ({ url, quote, action }: typeof quotes[number], limit: number): ResearchReading | undefined => {
    const source = fromSearch(url, quote);
    if (!source || passages.some(reading => sameArticle(reading.url, source.url))) return;
    const failedRead = events.some(event => {
      if (event.type !== 'tool.failed') return false;
      const request = requests.get(event.operationId);
      const args = object(request?.payload.arguments);
      return request !== undefined && source.searchSeq < request.projectSeq &&
        (args?.searchCallId === source.searchCallId && args?.resultNumber === source.resultNumber ||
          typeof args?.url === 'string' && sameArticle(args.url, source.url));
    });
    if (!failedRead) return;
    const text = source.excerpt.slice(0, Math.min(4000, limit));
    if (!text.includes(quote)) return;
    return { url: source.url, finalUrl: source.url, text, bodyHash: createHash('sha256').update(text).digest('hex'),
      truncated: true, instructionAuthority: 'none', sourceType: 'search_excerpt',
      ...(source.title ? { sourceTitle: source.title.slice(0, 200) } : {}),
      ...(source.publishedDate ? { publishedDate: source.publishedDate.slice(0, 100) } : {}),
      useBoundary: action && preferActionExcerpts
        ? '本轮留存的搜索摘录，未独立打开原文。只使用摘录明确记载的公开入口、材料和适用范围，不补写界面路径或受理承诺。'
        : '仅为本轮搜索保存的报道摘录，未独立打开原文。按摘录写明报道/调查及受访样本，不推成总体统计；关键数字在终稿按需核实。' };
  };
  if (preferActionExcerpts) {
    // A source for the actual step can take one slot from previously read background.
    for (const entry of quotes.filter(entry => entry.action)) {
      const action = savedExcerpt(entry, 4000);
      if (!action) continue;
      const hasPracticalQuote = (reading: ResearchReading) => Number(quotes.some(item =>
        (item.action || item.caseReport) && sameArticle(item.url, reading.url) && reading.text.includes(item.quote)));
      passages.sort((left, right) => hasPracticalQuote(right) - hasPracticalQuote(left));
      passages = fitResearchReadings([action, ...passages]);
      remaining = MAX_READING_CHARACTERS - passages.reduce((total, reading) => total + reading.text.length, 0);
      break;
    }
  }
  for (const entry of quotes) {
    if (!remaining || passages.length === MAX_READING_SOURCES) break;
    const excerpt = savedExcerpt(entry, remaining);
    if (!excerpt) continue;
    passages.push(excerpt);
    remaining -= excerpt.text.length;
  }
  return passages;
}
