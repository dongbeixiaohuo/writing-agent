import { ToolExecutionFault } from '../../runtime/tools/src/index.js';
import type { StoragePort, MutationResult } from '../../writing-core/src/index.js';

export interface PublicationCandidate { title: string; opening: string | null; distributionCopy: string | null; rationale: string }
export interface PublicationCandidates { id: string; bodyVersionId: string; candidates: PublicationCandidate[] }
const KEY = 'author-publication-candidates';
export const PUBLICATION_SELECTION_WAIT_REASON = '正文已润色，正式核查前还需要确认发布标题。当前标题只是候选，不代表你已选择。';

function comparableTitle(value: string): string {
  return value.trim().normalize('NFKC');
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
export function publicationSelectionIndex(userText: string, saved: PublicationCandidates | null): number | null {
  if (!saved) return null;
  const exactTitle = saved.candidates.findIndex(candidate => candidate.title === userText.trim());
  if (exactTitle >= 0) return exactTitle + 1;
  const text = userText.trim().replace(/[。！!\s]+$/u, '');
  const number = text.match(/^(?:那就|我就|就|我)?(?:选用|选择|选|采用|确认|用|定)(?:第)?([1-6一二三四五六])(?:个|项|号)?(?:标题|方案)?(?:吧|就行|即可|好了)?(?:[，,](?:正文别动|保留正文|不改正文))?$/u)?.[1]
    ?? text.match(/^第([1-6一二三四五六])(?:个|项|号)(?:标题|方案)?(?:就行|就好|吧)?$/u)?.[1]
    ?? text.match(/^([1-6一二三四五六])$/u)?.[1];
  if (number) {
    const index = /^[1-6]$/u.test(number) ? Number(number) : '一二三四五六'.indexOf(number) + 1;
    return saved.candidates[index - 1] ? index : null;
  }
  const index = saved.candidates.findIndex(c => [`确认标题：${c.title}`, `确认标题:${c.title}`, `选用标题：${c.title}`,
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
  const saved = value(storage.commitArtifactVersion({ projectId, operationId, expectedProjectRevision: project.revision,
    kind: 'report', logicalKey: KEY, baseVersionId: getPublicationCandidates(storage, projectId)?.id ?? null,
    content: JSON.stringify({ bodyVersionId, candidates }), reason: 'publication-candidates-not-selected', actor: runId ? { kind: 'agent', id: 'title', runId } : { kind: 'runtime', id: 'publication-candidates' } }));
  return { id: saved.versionId, bodyVersionId, candidates };
}

/** The model chooses a proposed index; only the actual user operation can authorize it. */
export function choosePublicationCandidate(storage: StoragePort, projectId: string, operationId: string, userText: string, candidateVersionId: string | undefined, index: number) {
  const saved = getPublicationCandidates(storage, projectId);
  const project = storage.inspectProject(projectId)!;
  if (!saved || saved.bodyVersionId !== project.latestBodyVersionId) throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE', 'Candidate version or article changed; ask for a fresh selection');
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
  if (!exact && chosenIndex !== index) throw new ToolExecutionFault('USER_SELECTION_REQUIRED', '用户尚未明确选定这个方案。请先回应其疑问或修改意见；只有明确选择才能锁定，不能把讨论、否定或修改要求当成同意。');
  const content = `- 选择状态：已锁定\n- 最终标题：「${candidate.title}」\n- 选择来源：用户明确选择\n- 候选版本：${saved.id}\n- 对应正文：${saved.bodyVersionId}\n` +
    (candidate.distributionCopy === null ? '- 分发文案范围：本次不包含分发文案\n' : `- 分发文案选择：随所选方案确认\n- 最终分发文案：${candidate.distributionCopy}\n`);
  const result = value(storage.commitArtifactVersion({ projectId, operationId, expectedProjectRevision: project.revision, kind: 'title', logicalKey: 'main',
    baseVersionId: project.currentTitleVersionId, content, reason: 'author-publication-selection', actor: { kind: 'user', id: 'conversation-user' } }));
  return { titleVersionId: result.versionId, title: candidate.title, distributionCopy: candidate.distributionCopy, bodyUnchanged: true,
    openingRequiresSeparateRevisionAcceptance: candidate.opening !== null };
}
