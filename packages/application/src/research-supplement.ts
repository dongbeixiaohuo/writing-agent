import { createHash } from 'node:crypto';
import type { ArtifactVersion, JsonValue, StoragePort, WritingBrief } from '../../writing-core/src/index.js';
import type { SessionStore } from '../../runtime/session/src/index.js';
import { ToolExecutionFault, ToolRegistry, type ToolDefinition, type ToolExecutionContext } from '../../runtime/tools/src/index.js';
import { createFactSearchTools, factSearchResultUrls, independentQueryKey, OUTLINE_SEARCH_ORIGIN, type FactSearchResult } from './fact-search.js';
import { createFactSourceTool } from './fact-web.js';
import type { ConfirmedWritingFocus, PrewritingAssessment } from './prewriting.js';
import { hasBonusCalculationDetails, type ResearchReading } from './research-readings.js';

type ResearchSearch = ReturnType<typeof createFactSearchTools>;
type History = Pick<SessionStore, 'listRunEvents'> & Pick<StoragePort, 'inspectProject'>;

export function usesPublicSources(brief: Pick<WritingBrief, 'genre'> | undefined) {
  return brief?.genre === 'explanatory_analysis' || brief?.genre === 'argument_commentary';
}

function site(url: string) {
  try {
    const host = new URL(url).hostname;
    const labels = host.split('.');
    const tail = labels.slice(-2).join('.');
    return /^(?:com|net|org|gov|edu|co)\.[a-z]{2}$/u.test(tail) ? labels.slice(-3).join('.') : tail;
  } catch {
    return '';
  }
}

export function selectedSourceCoverage(plan: PrewritingAssessment, readings: readonly ResearchReading[]) {
  const groups = new Map<string, Set<string>>();
  const matched = (plan.readingRoute?.moments ?? []).flatMap(moment => {
    const reading = readings.find(source => source.url === moment.sourceUrl);
    return reading ? [{ reading, quote: moment.quote.replace(/\s/gu, '') }] : [];
  });
  for (const { reading, quote } of matched) {
    const domain = site(reading.finalUrl);
    if (!domain) continue;
    const group = matched.find(other => other.reading.bodyHash === reading.bodyHash ||
      (quote.length >= 24 && other.quote === quote));
    const identity = site(group?.reading.finalUrl ?? reading.finalUrl);
    const passages = groups.get(identity) ?? new Set<string>();
    passages.add(quote);
    groups.set(identity, passages);
  }
  const counts = [...groups.values()].map(passages => passages.size);
  const selected = counts.reduce((total, count) => total + count, 0);
  return {
    independentSources: groups.size,
    selected,
    largestShare: selected ? Math.max(...counts) / selected : 0,
  };
}

function operation(runId: string) { return `outline-research-supplement:${runId}`; }

const queryHasPrivateDetails = /[\r\n@]|(?:密码|密钥|手机号|身份证)|\b(?:api[_ -]?key|password|bearer)\b|(?:\+?86[- ]?)?1[3-9]\d{9}/iu;

type ResearchGap = NonNullable<PrewritingAssessment['researchGap']>;
type SupplementEvidence = NonNullable<ResearchReading['supplementEvidence']>;
const MAX_SOURCE_READS = 6;
function supplementGaps(plan: PrewritingAssessment, focus?: ConfirmedWritingFocus): ResearchGap[] {
  const requested = [...(plan.researchGaps ?? []), ...(plan.researchGap ? [plan.researchGap] : [])];
  if (!focus?.workplacePay) return requested;
  return requested.filter(({ query }) => /老板|主管|上司|员工|职工|公司|企业/u.test(query) &&
    /奖金|绩效工资|加薪|调薪|谈钱|谈薪|待遇/u.test(query) &&
    /提问|问|谈|解释|回应|反馈|争议|质疑|拒绝|回避|对待|分配|公开|告知|协商|格局|在乎/u.test(query));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sourceKey(url: string) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

function officialPublication(url: string) {
  const host = new URL(url).hostname;
  return /(?:^|\.)(?:szse\.cn|sse\.com\.cn|neeq\.com\.cn|court\.gov\.cn|hshfy\.sh\.cn)$/u.test(host);
}

function bonusConversation(text: string) {
  return /奖金|绩效工资|加薪|调薪|谈钱|谈薪|工资待遇/u.test(text) && /(?:员工|职工).{0,16}(?:问|质疑|申诉|不清楚|协商)|(?:主管|老板|公司).{0,16}(?:回答|叮嘱|回避|解释|回应|告知|拒绝)/u.test(text);
}

function bonusEvidence(url: string, text: string): SupplementEvidence | null {
  if (hasBonusCalculationDetails(text)) {
    // A named employer in a vendor story or a forum proposal is not proof of adoption.
    if (officialPublication(url) && /本院(?:认为|查明|认定)|法院(?:审理|查明|认定)|董事会.{0,14}(?:审议|通过)|招股说明书|问询函.{0,16}回复|公司编制有/u.test(text) &&
        !/初步构思|请大家帮我看看|拟定的算例/u.test(text)) {
      return { kind: 'documented_rule', useBoundary: '仅说明这份原文所载企业、岗位和期间的口径。判决的当事人说法与法院认定分别归属，不推及其他公司的奖金。' };
    }
    return { kind: 'calculation_example', useBoundary: '只可用作算法示意或方案草稿。不能据此说某公司已经实行，也不能用它推算报道人物的奖金。' };
  }
  if (bonusConversation(text)) return { kind: 'reported_context', useBoundary: '只说明原文记载的沟通、回应或争议，不能据此补出实际计算规则。' };
  return null;
}

type Candidate = { url: string; title: string; excerpt: string; operationId: string; rank: number };
const pdfLink = (url: string) => /(?:\.pdf|\/flws2pdf\.jsp)$/iu.test(new URL(url).pathname);
const snippetKey = (text: string) => text.replace(/[\s\p{P}]/gu, '');
function matchingExcerpt(left: string, right: string) {
  if (left.length < 200 || right.length < 200) return false;
  for (let offset = 0; offset + 200 <= left.length; offset += 50) {
    if (right.includes(left.slice(offset, offset + 200))) return true;
  }
  return false;
}
function rankedCandidates(events: ReturnType<SessionStore['listRunEvents']>, bonusFocused: boolean) {
  const candidates = events.flatMap(event => {
    if (event.type !== 'tool.completed') return [];
    const found = asObject(event.payload.result)?.result as FactSearchResult | undefined;
    if (found?.mode !== 'external') return [];
    const operationId = event.operationId;
    let hits: unknown;
    try { hits = JSON.parse(found.evidenceText); } catch { hits = null; }
    const urls = factSearchResultUrls(found.evidenceText);
    const rows = Array.isArray(hits) ? hits.flatMap(hit => {
      const item = asObject(hit);
      if (typeof item?.url !== 'string') return [];
      try {
        const url = new URL(item.url).href;
        return urls.includes(url) ? [{ url, title: String(item.title ?? ''), excerpt: String(item.excerpt ?? '') }] : [];
      } catch { return []; }
    }) : urls.map(url => ({ url, title: '', excerpt: found.evidenceText }));
    return rows.map(row => {
      const sample = `${row.title}\n${row.excerpt}`;
      const hasCalculation = hasBonusCalculationDetails(sample);
      const official = officialPublication(row.url);
      const rank = !bonusFocused ? 1 : bonusConversation(sample) ? (official ? 6 : 5) : hasCalculation ? (official ? 4 : 2) :
        official && /奖金|绩效工资/u.test(sample) ? 1 : 0;
      return { ...row, rank, operationId };
    });
  });
  return candidates.filter(candidate => candidate.rank > 0).sort((a, b) => b.rank - a.rank ||
    (bonusFocused ? Number(pdfLink(a.url)) - Number(pdfLink(b.url)) : 0));
}

/** Supplemented sources stay bound to the same run, research and brief. */
function supplementalResearchReadings(storage: History, runId: string, research: ArtifactVersion): ResearchReading[] {
  const events = storage.listRunEvents(runId).filter(event => event.projectId === research.projectId &&
    event.operationId.startsWith(operation(runId) + ':'));
  const briefVersionId = storage.inspectProject(research.projectId)?.currentBriefVersionId;
  if (!briefVersionId) return [];
  const requests = new Set(events.filter(event => event.type === 'tool.requested' && event.payload.toolName === 'read_fact_source' &&
    event.payload.researchVersionId === research.id && event.payload.briefVersionId === briefVersionId).map(event => event.operationId));
  return events.flatMap(event => {
    if (event.type !== 'tool.completed' || !requests.has(event.operationId)) return [];
    const saved = asObject(event.payload.result);
    const reading = asObject(saved?.result);
    if (saved?.ok !== true || saved.toolName !== 'read_fact_source' ||
        typeof reading?.requestedUrl !== 'string' || typeof reading.finalUrl !== 'string' ||
        typeof reading.text !== 'string' || typeof reading.bodyHash !== 'string' || reading.instructionAuthority !== 'none' ||
        event.payload.supplementEvidence === null) return [];
    const supplementEvidence = event.payload.supplementEvidence as SupplementEvidence | undefined;
    return [{ url: reading.requestedUrl, finalUrl: reading.finalUrl, text: reading.text.slice(0, 6000),
      bodyHash: reading.bodyHash, truncated: reading.truncated === true || reading.text.length > 6000, instructionAuthority: 'none',
      ...(supplementEvidence ? { supplementEvidence } : {}) }];
  });
}

export function withResearchSupplement(storage: History, runId: string, research: ArtifactVersion,
  readings: ResearchReading[], plan?: PrewritingAssessment): ResearchReading[] {
  const available = [...readings];
  for (const source of supplementalResearchReadings(storage, runId, research)) {
    if (source.text.trim() && !available.some(reading => reading.bodyHash === source.bodyHash || sourceKey(reading.finalUrl) === sourceKey(source.finalUrl)) &&
        (!plan || plan.readingRoute?.moments.some(moment => moment.sourceUrl === source.url))) available.push(source);
  }
  return available;
}

export interface OutlineSupplement {
  (context: ToolExecutionContext, plan: PrewritingAssessment, readings: readonly ResearchReading[], research: ArtifactVersion,
    focus?: ConfirmedWritingFocus): Promise<JsonValue | null> | undefined;
}

export function createOutlineSupplement(storage: StoragePort & Pick<SessionStore, 'listRunEvents' | 'recordRunEvent' | 'getRun'>,
  projectId: string, search: ResearchSearch, source?: ToolDefinition<{ url: string }, JsonValue>): OutlineSupplement {
  const reader = source ?? createFactSourceTool({ storage, projectId, searchEnabled: search.enabled, isDiscoveredSource: search.isDiscoveredSource });
  const registry = ToolRegistry.create([...search.definitions, reader as unknown as ToolDefinition<never, JsonValue>]);
  return (context, plan, readings, research, focus) => {
    if (!search.automatic() || !context.permissionGrant.permissions.includes('network:https:read') ||
        !search.budget(context.runId).canSearch) return;
    const coverage = selectedSourceCoverage(plan, readings);
    const { runId, abortSignal } = context;
    const events = storage.listRunEvents(runId);
    const searches = events.filter(event => event.type === 'tool.requested' && event.payload.toolName === 'search_research_sources');
    const attempted = new Set(searches.map(event => independentQueryKey(String(asObject(event.payload.arguments)?.query ?? ''))));
    const candidates = supplementGaps(plan, focus).filter(gap =>
      !queryHasPrivateDetails.test(gap.query) && Array.from(gap.query).length <= 128 && !attempted.has(independentQueryKey(gap.query)));
    let sequence = searches.filter(event => event.payload.origin === OUTLINE_SEARCH_ORIGIN).length;
    const parent = events.findLast(event => event.operationId === context.operationId && event.type === 'tool.requested');
    const requestId = parent?.payload.requestId;
    const briefVersionId = storage.inspectProject(projectId)?.currentBriefVersionId;
    if (typeof requestId !== 'string' || !briefVersionId) return;
    const recentEvents = () => storage.listRunEvents(runId);
    const pendingReads = (history: ReturnType<SessionStore['listRunEvents']>): Candidate[] => {
      const bound = history.filter(event => event.type === 'tool.requested' && event.payload.origin === OUTLINE_SEARCH_ORIGIN &&
        event.payload.researchVersionId === research.id && event.payload.briefVersionId === briefVersionId);
      const searchesForPlan = bound.filter(event => event.payload.toolName === 'search_research_sources');
      const latestSearch = searchesForPlan.at(-1)?.operationId;
      if (!latestSearch) return [];
      const read = bound.filter(event => event.payload.toolName === 'read_fact_source');
      const remaining = MAX_SOURCE_READS - read.filter(event => event.operationId.startsWith(latestSearch + ':source:')).length;
      if (remaining <= 0) return [];
      const seen = new Set([...readings.map(item => sourceKey(item.finalUrl)), ...history.flatMap(event => {
        const url = asObject(event.payload.arguments)?.url;
        return event.type === 'tool.requested' && event.payload.toolName === 'read_fact_source' && typeof url === 'string' ? [sourceKey(url)] : [];
      })]);
      const titles = new Set(read.map(event => event.payload.sourceTitle).filter(Boolean));
      const selected: Candidate[] = [];
      const excerpts: { url: string; text: string }[] = [];
      for (const candidate of rankedCandidates(history.filter(event => event.operationId === latestSearch), Boolean(focus?.workplacePay))) {
        if (selected.length === remaining) break;
        const key = sourceKey(candidate.url);
        const title = candidate.title.split(' - ')[0]!.trim();
        if (seen.has(key) || (title && titles.has(title))) continue;
        const excerpt = snippetKey(candidate.excerpt);
        if (excerpts.some(other => (
          excerpt.length >= 200 && (excerpt.includes(other.text.slice(0, 200)) || other.text.includes(excerpt.slice(0, 200)))) ||
          (site(other.url) === site(candidate.url) && pdfLink(other.url) !== pdfLink(candidate.url) && matchingExcerpt(excerpt, other.text)))) continue;
        seen.add(key);
        if (title) titles.add(title);
        if (excerpt.length >= 200) excerpts.push({ url: candidate.url, text: excerpt });
        selected.push(candidate);
      }
      return selected;
    };
    if (!candidates.length && !pendingReads(events).length) return;
    const stillRunning = () => !abortSignal.aborted && storage.getRun(runId)?.status === 'running';
    async function runTool(toolName: string, operationId: string, args: Record<string, JsonValue>, extra: Record<string, JsonValue> = {}) {
      if (!stillRunning()) throw new ToolExecutionFault('ABORTED', '写前补查已停止。');
      storage.recordRunEvent({ projectId, runId, operationId, type: 'tool.requested', payload: {
        actor: 'outline', requestId, callId: operationId, toolName, arguments: args, origin: OUTLINE_SEARCH_ORIGIN,
        researchVersionId: research.id, briefVersionId, ...extra,
      } });
      const result = await registry.execute({ id: operationId, name: toolName, arguments: args, rawArguments: JSON.stringify(args) },
        { ...context, operationId });
      if (!stillRunning()) throw new ToolExecutionFault('ABORTED', '写前补查已停止。');
      const raw = result.ok && toolName === 'read_fact_source' ? asObject(result.result) : undefined;
      const classification = focus?.workplacePay && typeof raw?.text === 'string' && typeof raw.finalUrl === 'string'
        ? bonusEvidence(raw.finalUrl, raw.text.slice(0, 6000)) : undefined;
      storage.recordRunEvent({ projectId, runId, operationId, type: result.ok ? 'tool.completed' : 'tool.failed',
        payload: { requestId, callId: operationId, result: result as unknown as JsonValue,
          ...(classification !== undefined ? { supplementEvidence: classification } : {}) } });
      return result;
    }
    async function readCandidates() {
      for (const candidate of pendingReads(recentEvents())) {
        const sourceId = `${candidate.operationId}:source:${createHash('sha256').update(sourceKey(candidate.url)).digest('hex')}`;
        await runTool('read_fact_source', sourceId, { url: candidate.url },
          { sourceTitle: candidate.title.split(' - ')[0]!.trim(), relevanceRank: candidate.rank });
      }
      return withResearchSupplement(storage, runId, research, [...readings]).length > readings.length;
    }
    const reviewMaterials = { message: '已补读候选原文。选能把原题写具体的片段；够写就提交，不再提补查。按照 supplementEvidence.useBoundary 使用，算例不能当作真实公司规则。' };
    return (async () => {
      if (pendingReads(events).length && await readCandidates()) return reviewMaterials;
      for (const gap of candidates) {
        if (!search.budget(runId).canSearch) break;
        const key = independentQueryKey(gap.query);
        if (attempted.has(key)) continue;
        attempted.add(key);
        const op = `${operation(runId)}:${++sequence}`;
        await runTool('search_research_sources', op, { query: gap.query }, { angle: gap.angle, coverage });
        if (await readCandidates()) return reviewMaterials;
      }
      return null;
    })();
  };
}
