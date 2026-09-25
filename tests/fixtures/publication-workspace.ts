import assert from 'node:assert/strict';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';

// A real, snapshot-bound gate without a paid model call. Never opens user data.
export function seedPublicationWorkspace(workspacePath: string, passed = true, secondProject = false): string {
  const storage = openWorkspaceStorage({ workspacePath });
  const actor = { kind: 'user', id: 'publication-fixture' } as const;
  const projectId = 'publication-fixture';
  try {
    assert.equal(storage.createProject({ operationId: 'create', projectId, name: '夜跑随想', mode: 'quick', actor }).ok, true);
    let revision = 0;
    const commit = (kind: 'body' | 'title' | 'evidence', content: string) => {
      const result = storage.commitArtifactVersion({ operationId: kind, projectId, expectedProjectRevision: revision,
        kind, logicalKey: 'main', baseVersionId: null, content, reason: 'isolated export fixture', actor });
      assert.equal(result.ok, true);
      revision = result.projectRevision;
      return result.result.versionId;
    };
    const bodyVersionId = commit('body', '# 夜跑随想\n\n我喜欢在夜色中慢慢跑步。\n\n## 一点感受\n\n**放慢脚步**，留意自己的呼吸。');
    const titleVersionId = commit('title', '- 选择状态：已锁定\n- 最终标题：夜跑随想\n- 平台分发文案：\n- 分发文案选择：A\n- 最终分发文案：一点个人感受\n');
    const evidenceVersionId = commit('evidence', JSON.stringify({ claims: [], notes: '仅为个人感受' }));
    if (passed) {
      const snapshot = storage.createFactCheckSnapshot({ operationId: 'snapshot', projectId, expectedProjectRevision: revision,
        bodyVersionId, titleVersionId, evidenceVersionId, actor });
      assert.equal(snapshot.ok, true);
      const assessment = storage.evaluateFactCheckSnapshot({ operationId: 'assessment', projectId, expectedProjectRevision: snapshot.projectRevision,
        snapshotId: snapshot.result.snapshotId, actor, payload: { schemaVersion: 'fact-check-v2', snapshotId: snapshot.result.snapshotId,
          bodyVersionId, titleVersionId, coverage: { body: true, title: true, distributionCopy: true }, claims: [], noFactualClaimsReason: '文章仅为个人感受，不含外部事实主张。' } });
      assert.equal(assessment.ok, true);
    }
    storage.createSession({ sessionId: 'export-session', projectId, purpose: 'writing-pack:draft' });
    if (secondProject) storage.createProject({ operationId: 'other', projectId: 'other-project', name: '另一个项目', mode: 'quick', actor });
    return bodyVersionId;
  } finally { storage.close(); }
}
