import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { savePublicationCandidates, choosePublicationCandidate, getPublicationCandidates, isPublicationSelectionCurrent,
  isPublicationSelectionWait, isUsablePublicationTitle, publicationSelectionIndex, selectedPublicationContext } from '../src/publication-choice.js';

it('accepts unambiguous everyday title choices without turning objections or questions into consent', () => {
  const saved = { id: 'c', bodyVersionId: 'b', candidates: ['忙不是通行证', '功劳不能兑换特权', '把标准放回原位'].map(title => ({ title, opening: null, distributionCopy: null, rationale: '对比角度' })) };
  for (const message of ['就用第二个吧', '那就选第二个', '第二个就行', '用《功劳不能兑换特权》吧', '2', '第二个', '功劳不能兑换特权']) assert.equal(publicationSelectionIndex(message, saved), 2, message);
  for (const message of ['不要选第二个', '第二个更好吗？', '第二个不错，但还要修改', '就用第二个吧？', '引用原话：就用第二个吧', '选第二个，但把特权换掉', '继续', '选第六个']) assert.equal(publicationSelectionIndex(message, saved), null, message);
});

it('keeps candidates separate, binds title choice to exact version, and leaves distribution copy optional', () => {
  const directory = mkdtempSync(join(tmpdir(), 'publication-choice-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const actor = { kind: 'user', id: 'test' } as const;
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: '文章', mode: 'quick', actor });
    const body = storage.commitArtifactVersion({ projectId: 'p', operationId: 'body', expectedProjectRevision: storage.inspectProject('p')!.revision, kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 旧题\n\n正文不变。', reason: 'test', actor });
    assert.equal(body.ok, true);
    const bodyId = storage.inspectProject('p')!.latestBodyVersionId!;
    const candidate = savePublicationCandidates(storage, 'p', 'candidates', bodyId, [
      { title: '慢下来', opening: null, distributionCopy: '一次关于慢生活的观察。', rationale: '克制的观察' },
      { title: '窗边', opening: '可选开头，尚未替换正文。', distributionCopy: '从窗边重新观察日常。', rationale: '具体的意象' },
    ]);
    assert.equal(storage.inspectProject('p')!.currentTitleVersionId, null);
    assert.throws(() => choosePublicationCandidate(storage, 'p', 'invented', '请给我两个标题', candidate.id, 2), { code: 'USER_SELECTION_REQUIRED' });
    const selected = choosePublicationCandidate(storage, 'p', 'selected', '我选第二个，正文别动', candidate.id, 2);
    assert.match(storage.getArtifactVersion(selected.titleVersionId)!.content, /最终标题：「窗边」/u);
    assert.doesNotMatch(storage.getArtifactVersion(selected.titleVersionId)!.content, /最终分发文案/u);
    assert.equal(selected.distributionCopy, null);
    assert.deepEqual(selectedPublicationContext(storage, 'p'), { titleVersionId: selected.titleVersionId,
      selectionStatus: 'confirmed', finalTitle: '窗边', distributionCopy: null, distributionCopyOptional: true,
      bodyHeadingIsWorkingTitle: true });
    assert.equal(storage.inspectProject('p')!.latestBodyVersionId, bodyId);
    assert.equal(isPublicationSelectionCurrent(storage, 'p'), true);
    assert.equal(getPublicationCandidates(storage, 'p')!.id, candidate.id);
    assert.throws(() => choosePublicationCandidate(storage, 'p', 'mismatch', '我选第一个', candidate.id, 2), { code: 'USER_SELECTION_REQUIRED' });
    storage.commitArtifactVersion({ projectId: 'p', operationId: 'changed', expectedProjectRevision: storage.inspectProject('p')!.revision, kind: 'body', logicalKey: 'main', baseVersionId: bodyId, content: '# 新稿\n\n正文已变。', reason: 'test', actor });
    assert.equal(isPublicationSelectionCurrent(storage, 'p'), true, 'editing body invalidates fact results, not the author\'s chosen title');
    const reselected = choosePublicationCandidate(storage, 'p', 'edited', '我选第二个', candidate.id, 2);
    assert.equal(reselected.bodyChangedSinceCandidates, true, 'body edits require fresh verification, not another selection');
    assert.notEqual(storage.getFactCheckStatus('p').status, 'passed');
    const newBodyId = storage.inspectProject('p')!.latestBodyVersionId!;
    savePublicationCandidates(storage, 'p', 'replacement', newBodyId, [{ title: '另一种安静', opening: null, distributionCopy: null, rationale: '新方案' }]);
    assert.throws(() => choosePublicationCandidate(storage, 'p', 'stale-batch', '我选第二个', candidate.id, 2), { code: 'PUBLICATION_CANDIDATES_STALE' }, 'a replaced candidate batch still cannot reuse an old ordinal');
    assert.throws(() => savePublicationCandidates(storage, 'p', 'ambiguous', storage.inspectProject('p')!.latestBodyVersionId!, [
      { title: '同名', opening: null, distributionCopy: 'A', rationale: 'A' },
      { title: '同名', opening: null, distributionCopy: 'B', rationale: 'B' },
    ]), { code: 'PUBLICATION_CANDIDATES_AMBIGUOUS' });
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('recognizes publication-selection waits and rejects only structurally invalid or body-paragraph titles', () => {
  const body = 'This opening paragraph is prose in English. It contains a second complete sentence.\n\nThe article continues here.';
  assert.equal(isUsablePublicationTitle(body.split(/\r?\n/u)[0]!, body), false);
  assert.equal(isUsablePublicationTitle('A deliberately long but valid English publication title that should not be rejected by language-specific length guesses', body), true);
  assert.equal(isUsablePublicationTitle('A title\nwith a second line', body), false);
  assert.equal(isUsablePublicationTitle('Explicit heading', '# Explicit heading\n\nBody.'), true);
  assert.equal(isPublicationSelectionWait({ kind: 'publication_selection', reason: 'new structured wait' }), true);
  assert.equal(isPublicationSelectionWait({ reason: '正文已润色，正式核查前还需要确认发布标题。当前标题只是候选，不代表你已选择。' }), true);
  assert.equal(isPublicationSelectionWait({ reason: '普通写作问题' }), false);
});

it('refuses to persist an opening paragraph as a publication candidate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'publication-choice-invalid-title-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const actor = { kind: 'user', id: 'test' } as const;
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: '文章', mode: 'quick', actor });
    const opening = '正文首段没有标题。不能把这一整段文字直接显示成候选标题。';
    storage.commitArtifactVersion({ projectId: 'p', operationId: 'body', expectedProjectRevision: storage.inspectProject('p')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: null, content: `${opening}\n\n第二段。`, reason: 'test', actor });
    assert.throws(() => savePublicationCandidates(storage, 'p', 'bad-candidate', storage.inspectProject('p')!.latestBodyVersionId!, [
      { title: opening, opening: null, distributionCopy: null, rationale: '错误回退' },
    ]), { code: 'PUBLICATION_CANDIDATES_INVALID' });
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('does not lock or accept a legacy opening-paragraph candidate as a current publication selection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'publication-choice-legacy-title-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  const actor = { kind: 'user', id: 'test' } as const;
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: '文章', mode: 'quick', actor });
    const opening = '这是没有标题的正文首段。它过去被错误地当成了标题候选。';
    storage.commitArtifactVersion({ projectId: 'p', operationId: 'body', expectedProjectRevision: storage.inspectProject('p')!.revision,
      kind: 'body', logicalKey: 'main', baseVersionId: null, content: `${opening}\n\n第二段。`, reason: 'test', actor });
    const bodyId = storage.inspectProject('p')!.latestBodyVersionId!;
    const rawCandidates = storage.commitArtifactVersion({ projectId: 'p', operationId: 'legacy-candidates', expectedProjectRevision: storage.inspectProject('p')!.revision,
      kind: 'report', logicalKey: 'author-publication-candidates', baseVersionId: null,
      content: JSON.stringify({ bodyVersionId: bodyId, candidates: [{ title: opening, opening: null, distributionCopy: null, rationale: '旧回退逻辑' }] }),
      reason: 'publication-candidates-not-selected', actor });
    assert.equal(rawCandidates.ok, true);
    assert.throws(() => choosePublicationCandidate(storage, 'p', 'choose-bad', '我选第一个', rawCandidates.ok ? rawCandidates.result.versionId : '', 1),
      { code: 'PUBLICATION_CANDIDATES_INVALID' });
    storage.commitArtifactVersion({ projectId: 'p', operationId: 'legacy-title', expectedProjectRevision: storage.inspectProject('p')!.revision,
      kind: 'title', logicalKey: 'main', baseVersionId: null,
      content: `- 选择状态：已锁定\n- 最终标题：「${opening}」\n- 选择来源：用户明确选择\n- 候选版本：legacy\n- 对应正文：${bodyId}\n- 分发文案范围：本次不包含分发文案\n`,
      reason: 'author-publication-selection', actor });
    assert.equal(isPublicationSelectionCurrent(storage, 'p'), false);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
