import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { SessionStore } from '../../runtime/session/src/index.js';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';
import type { StoragePort, MutationResult } from '../../writing-core/src/index.js';

export interface PublicationCandidate { title: string; opening: string | null; distributionCopy: string | null; rationale: string }
export interface PublicationCandidates { id: string; bodyVersionId: string; candidates: PublicationCandidate[] }
export type PublicationCandidateSubmission = { candidates?: PublicationCandidate[]; replacements?: { index: number; title: string }[] };

const titleField = { type: 'string', minLength: 1, maxLength: 200 };
export const publicationCandidateSubmissionSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: { type: 'array', minItems: 1, maxItems: 6, items: {
      type: 'object', properties: { title: titleField, opening: { type: ['string', 'null'], maxLength: 4000 },
        distributionCopy: { type: ['string', 'null'], maxLength: 2000 }, rationale: { type: 'string', minLength: 1, maxLength: 2000 } },
      required: ['title', 'opening', 'distributionCopy', 'rationale'], additionalProperties: false,
    } },
    replacements: { type: 'array', minItems: 1, maxItems: 6, items: {
      type: 'object', properties: { index: { type: 'integer', minimum: 1, maximum: 6 }, title: titleField },
      required: ['index', 'title'], additionalProperties: false,
    } },
  },
} as const;

const KEY = 'author-publication-candidates';
export const PUBLICATION_SELECTION_WAIT_REASON = '正文已润色，正式核查前还需要确认发布标题。当前标题只是候选，不代表你已选择。';

/** The autonomous fallback is derived from the current body, not a new author choice. */
export function defaultFactTitleContent(bodyContent: string): string {
  const lines = bodyContent.split(/\r?\n/u).map(line => line.trim());
  const heading = lines.find(line => /^#{1,6}\s+\S/u.test(line));
  const title = heading ? heading.replace(/^#{1,6}\s+/u, '').trim() : lines.find(Boolean)?.slice(0, 80) ?? '未命名稿件';
  return `- 选择状态：已锁定\n- 最终标题：「${title}」\n- 选择来源：按自主推进模式代选当前稿件标题\n- 分发文案范围：本次不包含分发文案，核查覆盖其缺省状态\n`;
}

function comparableTitle(value: string): string {
  return value.trim().normalize('NFKC');
}

const markdown = unified().use(remarkParse);
type HeadingText = { type: string; children?: readonly HeadingText[]; value?: string; alt?: string | null | undefined };
function headingText(node: HeadingText): string {
  return node.value ?? node.alt ?? (node.children ?? []).map(headingText).join('');
}
const headingKey = (text: string) => comparableTitle(text).replace(/[\s\p{P}]/gu, '');

function collidingTitles(body: string, candidates: readonly PublicationCandidate[]) {
  const subheadings = markdown.parse(body).children.flatMap((node, index) =>
    node.type === 'heading' && (node.depth !== 1 || index !== 0) ? [headingText(node)] : []);
  const byKey = new Map(subheadings.map(heading => [headingKey(heading), heading]));
  return candidates.flatMap((candidate, index) => {
    const key = headingKey(candidate.title);
    const heading = key ? byKey.get(key) : undefined;
    return heading ? [{ index: index + 1, title: candidate.title, heading }] : [];
  });
}

/** A publication title is explicit single-line metadata, never an inferred body paragraph. */
export function isUsablePublicationTitle(title: string, bodyContent?: string): boolean {
  const normalized = comparableTitle(title);
  if (normalized.length === 0 || normalized.length > 200 || /[\r\n]/u.test(title) || /^#{1,6}\s/u.test(normalized)) return false;
  if (bodyContent === undefined) return true;
  const firstLine = bodyContent.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
  if (firstLine === undefined) return true;
  if (/^#\s+\S/u.test(firstLine)) return true;
  const sentenceMarks = firstLine.match(/[。！？.!?](?=\s|$|[^。！？.!?])/gu)?.length ?? 0;
  return comparableTitle(firstLine) !== normalized || sentenceMarks < 2;
}

export function isPublicationSelectionWait(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as { kind?: unknown; reason?: unknown };
  return value.kind === 'publication_selection' || value.reason === PUBLICATION_SELECTION_WAIT_REASON;
}
function value<T>(result: MutationResult<T>): T {
  if (!result.ok) throw new ToolExecutionFault(result.code, result.message);
  return result.result;
}
export function getPublicationCandidates(storage: StoragePort, projectId: string): PublicationCandidates | null {
  const latest = storage.listArtifactVersions(projectId, 'report', KEY).at(-1);
  if (!latest) return null;
  const data = JSON.parse(latest.content) as Omit<PublicationCandidates, 'id'>;
  return { ...data, id: latest.id };
}
export function isPublicationSelectionCurrent(storage: StoragePort, projectId: string): boolean {
  const project = storage.inspectProject(projectId);
  const title = project?.currentTitleVersionId ? storage.getArtifactVersion(project.currentTitleVersionId) : null;
  const body = project?.latestBodyVersionId ? storage.getArtifactVersion(project.latestBodyVersionId) : null;
  const selectedTitle = title?.content.match(/^- 最终标题：「(.*)」$/mu)?.[1];
  return title?.reason === 'author-publication-selection' && body?.kind === 'body' && selectedTitle !== undefined &&
    // Selection is author intent, not a fact-check receipt. Body revisions must
    // invalidate the fact snapshot, not silently erase the selected title.
    isUsablePublicationTitle(selectedTitle, body.content);
}

/** Structured author choice must reach the director as well as the checker.
 * The body H1 remains a working title, not a competing unconfirmed choice. */
export function selectedPublicationContext(storage: StoragePort, projectId: string) {
  if (!isPublicationSelectionCurrent(storage, projectId)) return null;
  const id = storage.inspectProject(projectId)!.currentTitleVersionId!;
  const content = storage.getArtifactVersion(id)!.content;
  return { titleVersionId: id, selectionStatus: 'confirmed' as const,
    finalTitle: content.match(/^- 最终标题：「(.*)」$/mu)![1]!,
    distributionCopy: content.match(/^- 最终分发文案：(.*)$/mu)?.[1] ?? null,
    distributionCopyOptional: true, bodyHeadingIsWorkingTitle: true };
}
export function publicationSelectionIndex(userText: string, saved: PublicationCandidates | null): number | null {
  if (!saved) return null;
  const exactTitle = saved.candidates.findIndex(candidate => candidate.title === userText.trim());
  if (exactTitle >= 0) return exactTitle + 1;
  const text = userText.trim().replace(/[。！!\s]+$/u, '');
  const number = text.match(/^(?:那就|我就|就|我)?(?:选用|选择|选|采用|确认|用|定)(?:第)?([1-6一二三四五六])(?:个|项|号|条)?(?:标题|方案)?(?:吧|就行|即可|好了)?(?:[，,](?:正文别动|保留正文|不改正文))?$/u)?.[1]
    // "选择标题2 / 确认标题2 / 用标题二": verb first, then 标题, then the number.
    ?? text.match(/^(?:那就|我就|就|我)?(?:选用|选择|选|采用|确认|用|定)标题(?:第)?([1-6一二三四五六])(?:个|项|号|条)?(?:吧|就行|即可|好了)?$/u)?.[1]
    // "标题2 / 标题第2条".
    ?? text.match(/^标题(?:第)?([1-6一二三四五六])(?:个|项|号|条)?$/u)?.[1]
    ?? text.match(/^第([1-6一二三四五六])(?:个|项|号|条)(?:标题|方案)?(?:就行|就好|吧)?$/u)?.[1]
    ?? text.match(/^([1-6一二三四五六])$/u)?.[1];
  if (number) {
    const index = /^[1-6]$/u.test(number) ? Number(number) : '一二三四五六'.indexOf(number) + 1;
    return saved.candidates[index - 1] ? index : null;
  }
  const index = saved.candidates.findIndex(c => [`确认标题：${c.title}`, `确认标题:${c.title}`, `确认标题：《${c.title}》`, `确认《${c.title}》`, `选用标题：${c.title}`,
    `用《${c.title}》吧`, `就用《${c.title}》`, `就用「${c.title}」`, `采用《${c.title}》`].includes(text));
  return index < 0 ? null : index + 1;
}
export function savePublicationCandidates(storage: StoragePort, projectId: string, operationId: string, bodyVersionId: string, candidates: PublicationCandidate[], runId?: string): PublicationCandidates {
  const project = storage.inspectProject(projectId)!;
  if (project.latestBodyVersionId !== bodyVersionId) throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE', 'The article changed; prepare candidates for its current version');
  const body = storage.getArtifactVersion(bodyVersionId);
  if (body?.kind !== 'body') throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE', 'The bound article version is unavailable');
  if (!candidates.length || candidates.length > 6 || candidates.some(c => !isUsablePublicationTitle(c.title, body.content) || (c.distributionCopy !== null && /[\r\n]/u.test(c.distributionCopy)))) {
    throw new ToolExecutionFault('PUBLICATION_CANDIDATES_INVALID', 'Use 1–6 candidates with single-line titles and distribution copy');
  }
  if (new Set(candidates.map(c => c.title.trim().normalize('NFKC'))).size !== candidates.length) throw new ToolExecutionFault('PUBLICATION_CANDIDATES_AMBIGUOUS', '候选标题不能同名；请为不同方案使用不同标题，避免误选分发文案。');
  const collisions = collidingTitles(body.content, candidates);
  if (collisions.length) throw new ToolExecutionFault('PUBLICATION_TITLE_HEADING_COLLISION', '发布标题与正文小标题重复。只重出列出的候选标题。', true,
    { bodyVersionId, collisions, correction: '只提交 replacements，每项填原候选 index 和新 title。其余候选、开头、配文和正文由程序保留。' });
  const saved = value(storage.commitArtifactVersion({ projectId, operationId, expectedProjectRevision: project.revision,
    kind: 'report', logicalKey: KEY, baseVersionId: getPublicationCandidates(storage, projectId)?.id ?? null,
    content: JSON.stringify({ bodyVersionId, candidates }), reason: 'publication-candidates-not-selected', actor: runId ? { kind: 'agent', id: 'title', runId } : { kind: 'runtime', id: 'publication-candidates' } }));
  return { id: saved.versionId, bodyVersionId, candidates };
}

/** Repair only the titles identified in a prior rejected batch for this run and body. */
export function submitPublicationCandidates(storage: StoragePort & Pick<SessionStore, 'listRunEvents'>,
  input: { projectId: string; operationId: string; runId: string; bodyVersionId: string; toolName: string },
  submission: PublicationCandidateSubmission): PublicationCandidates {
  const { projectId, operationId, runId, bodyVersionId, toolName } = input;
  const events = storage.listRunEvents(runId).filter(event => event.projectId === projectId && event.runId === runId);
  const lastSaved = events.findLastIndex(event => event.type === 'tool.completed' &&
    (event.payload.result as { toolName?: string } | undefined)?.toolName === toolName);
  const requests = new Map(events.slice(lastSaved + 1).filter(event => event.type === 'tool.requested' &&
    event.payload.toolName === toolName).map(event => [event.operationId, event.payload.arguments as PublicationCandidateSubmission]));
  const failedBatch = events.slice(lastSaved + 1).findLast(event => {
    if (event.type !== 'tool.failed' || !requests.get(event.operationId)?.candidates) return false;
    const error = (event.payload.result as { error?: ToolExecutionFault } | undefined)?.error;
    return error?.code === 'PUBLICATION_TITLE_HEADING_COLLISION' && error.details?.bodyVersionId === bodyVersionId;
  });
  const pending = failedBatch ? requests.get(failedBatch.operationId)?.candidates : undefined;
  if (!pending) {
    if (!submission.candidates || submission.replacements) throw new ToolExecutionFault('PUBLICATION_TITLE_REPAIR_REQUIRED', '本轮没有等待替换的标题，请先提交候选列表。');
    return savePublicationCandidates(storage, projectId, operationId, bodyVersionId, submission.candidates, runId);
  }
  const body = storage.getArtifactVersion(bodyVersionId);
  if (body?.kind !== 'body' || storage.inspectProject(projectId)?.latestBodyVersionId !== bodyVersionId)
    throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE', '正文已经改变，请为当前稿件重新拟题。');
  const collisions = collidingTitles(body.content, pending);
  const edits = new Map(submission.replacements?.map(({ index, title }) => [index, title]));
  if (submission.candidates || edits.size !== collisions.length || edits.size !== submission.replacements?.length ||
      collisions.some(item => !edits.has(item.index))) {
    throw new ToolExecutionFault('PUBLICATION_TITLE_REPAIR_REQUIRED', '只替换与正文小标题重复的候选编号，其他候选会保留。', true,
      { collisions, correction: '提交 replacements，再按列出的 index 填写新 title。' });
  }
  const combined = pending.map((candidate, index) => edits.has(index + 1) ? { ...candidate, title: edits.get(index + 1)! } : candidate);
  return savePublicationCandidates(storage, projectId, operationId, bodyVersionId, combined, runId);
}

/** The model chooses a proposed index; only the actual user operation can authorize it. */
export function choosePublicationCandidate(storage: StoragePort, projectId: string, operationId: string, userText: string, candidateVersionId: string | undefined, index: number,
  interpreted?: { sourceQuote: string; candidateVersionId: string; index: number | null; includeDistributionCopy?: boolean }) {
  const saved = getPublicationCandidates(storage, projectId);
  const project = storage.inspectProject(projectId)!;
  if (!saved) throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE', 'No saved candidates are available');
  // A body edit invalidates verification, not the author's choice of a displayed
  // title. Bind the choice to today's body; the independent fact gate must still
  // check that body, title and distribution copy. A replaced candidate batch is
  // different: its index cannot be silently reused (validated below).
  // The article body id is far more salient than the candidates id; a wrong
  // id must hand the caller the exact correction instead of a loop of guesses.
  const expected = candidateVersionId ?? saved.id;
  if (saved.id !== expected) {
    throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE',
      `candidateVersionId 不匹配：当前候选版本 id 是 publicationCandidates.id=${saved.id}（不是正文 id ${saved.bodyVersionId}）。请改用这个 id 重新调用 choose_publication；省略 candidateVersionId 时会自动使用当前候选版本。`);
  }
  const candidate = saved.candidates[index - 1];
  const body = project.latestBodyVersionId ? storage.getArtifactVersion(project.latestBodyVersionId) : null;
  if (!candidate || body?.kind !== 'body' || !isUsablePublicationTitle(candidate.title, body.content)) {
    throw new ToolExecutionFault('PUBLICATION_CANDIDATES_INVALID', 'The saved title candidate is no longer usable; prepare fresh title options for the current article');
  }
  const text = userText.trim().replace(/[。！!\s]+$/u, '');
  const chosenIndex = publicationSelectionIndex(userText, saved);
  const exact = candidate && [`确认标题：${candidate.title}`, `确认标题:${candidate.title}`, `选用标题：${candidate.title}`].includes(text);
  const semanticSelection = interpreted && interpreted.sourceQuote === userText && interpreted.candidateVersionId === saved.id && interpreted.index === index;
  if (interpreted ? !semanticSelection : !exact && chosenIndex !== index) throw new ToolExecutionFault('USER_SELECTION_REQUIRED', '用户尚未明确选定这个方案。请先回应其疑问或修改意见；只有明确选择才能锁定，不能把讨论、否定或修改要求当成同意。');
  const distributionCopy = interpreted?.includeDistributionCopy === true ? candidate.distributionCopy : null;
  const content = `- 选择状态：已锁定\n- 最终标题：「${candidate.title}」\n- 选择来源：用户明确选择\n- 候选版本：${saved.id}\n- 对应正文：${body.id}\n` +
    (distributionCopy === null ? '- 分发文案范围：本次不包含分发文案（可选，不阻塞核查）\n' : `- 分发文案选择：用户明确选定\n- 最终分发文案：${distributionCopy}\n`);
  const result = value(storage.commitArtifactVersion({ projectId, operationId, expectedProjectRevision: project.revision, kind: 'title', logicalKey: 'main',
    baseVersionId: project.currentTitleVersionId, content, reason: 'author-publication-selection', actor: { kind: 'user', id: 'conversation-user' } }));
  return { titleVersionId: result.versionId, title: candidate.title, distributionCopy, bodyUnchanged: true,
    bodyChangedSinceCandidates: saved.bodyVersionId !== body.id,
    openingRequiresSeparateRevisionAcceptance: candidate.opening !== null };
}
