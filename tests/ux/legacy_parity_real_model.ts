// User-authorized three-scenario UAT. Uses existing credentials, only synthetic data.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';

if (process.argv[2] !== '--allow-real-model') throw new Error('Explicit --allow-real-model required');
const workspaceParent = resolve('output/legacy-parity-real-workspaces');
mkdirSync(workspaceParent, { recursive: true });
const root = mkdtempSync(join(workspaceParent, 'run-'));
const evidenceRoot = resolve('output/legacy-parity-real', root.split(/[\\/]/u).at(-1)!);
mkdirSync(evidenceRoot, { recursive: true });
const body = '# 留给明天的纸条\n\n本文是虚构练习，不叙述作者真实经历。\n\n关电脑前，叙述者把明天想做的一件小事写在纸上。有时只写“把桌面收拾一下”。写完就把纸留在键盘边，第二天看到后再决定做不做。\n\n叙述者喜欢这种没有打卡、没有评分的小习惯，偶尔没做也不觉得失败。';
const reports: Record<string, unknown>[] = [];
const selectedScenario = process.argv[3];
const allScenarios = ['discussion_revision', 'title_fact_check', 'style_illustration'];
if (selectedScenario && !allScenarios.includes(selectedScenario)) throw new Error('Unknown scenario');
for (const scenario of selectedScenario ? [selectedScenario] : allScenarios) {
  const workspacePath = join(root, scenario);
  const seed = openWorkspaceStorage({ workspacePath });
  const actor = { kind: 'user', id: 'synthetic-uat-author' } as const;
  const projectId = `uat-${scenario}`;
  seed.createProject({ projectId, operationId: 'create', name: `迁移验收 ${scenario}`, mode: 'quick', actor });
  const revision = () => seed.inspectProject(projectId)!.revision;
  assert.equal(seed.importMaterial({ projectId, operationId: 'material', expectedProjectRevision: revision(), materialId: 'sample', displayName: '授权虚构练习',
    sourceKind: 'pasted_text', sourceReference: 'synthetic-uat', role: 'illustrative', trustLabel: 'user_provided_untrusted', permissionScope: 'project_only', content: body, actor }).ok, true);
  assert.equal(seed.saveWritingBrief({ projectId, operationId: 'brief', expectedProjectRevision: revision(), baseVersionId: null, actor,
    brief: { schemaVersion: 1, topic: '留给明天的纸条', genre: 'narrative_observation', audience: '生活随笔读者', lengthTarget: { targetCharacters: 300 },
      materialIds: ['sample'], constraints: ['只能使用给定虚构练习材料，不增加事实、场景或效果；明确虚构，禁止冒充作者亲历。'], interactionMode: 'co_creation',
      authorAuthorization: { voice: '平实克制', styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
      platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' } }).ok, true);
  for (const [kind, content] of [['body', body], ['evidence', JSON.stringify({ claims: [], notes: '用户明确授权的虚构练习，仅表达虚构叙述者主观感受，不包含外部事实，不可增加材料之外的新场景。' })]] as const) {
    assert.equal(seed.commitArtifactVersion({ projectId, operationId: kind, expectedProjectRevision: revision(), kind, logicalKey: 'main', baseVersionId: null, content, reason: 'synthetic UAT fixture', actor }).ok, true);
  }
  seed.createSession({ projectId, sessionId: 'uat-session', purpose: 'writing-pack:author-conversation' });
  seed.close();
  const host = new DesktopApplicationHost({ workspacePath, providerProfilePath: join(process.env.APPDATA!, 'Writing Agent', 'provider.json'), applicationVersion: '1.0.0-rc.12' });
  const bridge = host.bridge;
  let failure: string | null = null;
  const messages: { user: string; reply: unknown }[] = [];
  async function turn(text: string) {
    const started = await bridge.sendMessage(text);
    const deadline = Date.now() + 8 * 60_000;
    let stable = 0;
    while (Date.now() < deadline) {
      await bridge.refresh();
      const snapshot = bridge.getSnapshot();
      const run = snapshot.runRecords.find(r => r.id === started.runId);
      if (run && !['running', 'queued', 'paused'].includes(run.status) && snapshot.activeRunId === null) {
        if (++stable >= 2) {
          messages.push({ user: text, reply: snapshot.timelineBySession[snapshot.selectedSessionId] });
          assert.equal(run.status, 'completed', `author turn ${run.status}: ${run.stopReason}`);
          console.log(JSON.stringify({ scenario, turn: messages.length, status: run.status, requests: run.modelRequests }));
          return snapshot;
        }
      } else stable = 0;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    const active = bridge.getSnapshot().activeRunId;
    if (active) await bridge.cancelRun(active);
    throw new Error('UAT_TURN_TIMEOUT');
  }
  try {
    const status = await host.providerStatus();
    assert.equal(status.configured, true); assert.equal(status.model, 'MiniMax-M3');
    await bridge.selectSession(projectId, 'uat-session');
    const before = bridge.getSnapshot().revisionWorkspace;
    if (scenario === 'discussion_revision') {
      await turn('先不要改正文。请给两个改善“关电脑前”这一段节奏的思路，分别编号。');
      assert.equal(bridge.getSnapshot().deliveryWorkspace.bodyVersionId, before.bodyVersionId);
      await turn('采用你刚才第一个思路。只压缩包含“关电脑前”的那个段落，其他段落、虚构标注和标题都别动。请生成修改建议供我确认，不直接覆盖稿件。');
      const proposal = bridge.getSnapshot().revisionWorkspace.proposals.find(p => p.status === 'proposed');
      assert.ok(proposal, 'real model must use the actual revision proposal tool');
      const target = before.blocks.find(b => b.content.includes('关电脑前'))!;
      assert.deepEqual(proposal.diff.map(d => d.targetBlockId), [target.id]);
      assert.equal(bridge.getSnapshot().deliveryWorkspace.bodyVersionId, before.bodyVersionId);
      await bridge.acceptRevision(proposal.id);
      for (const block of before.blocks.filter(b => b.id !== target.id)) assert.ok(bridge.getSnapshot().revisionWorkspace.blocks.some(b => b.content === block.content));
    } else if (scenario === 'title_fact_check') {
      await turn('请安排标题专家，基于当前虚构练习文章给三个不同标题，每个配一句克制的分发文案和推荐理由。不要增加功效承诺，不改正文；保存候选让我选择。');
      await turn('我选第二个，正文别动');
      assert.equal(bridge.getSnapshot().deliveryWorkspace.bodyVersionId, before.bodyVersionId);
      await turn('正文别动，请只重新执行一次事实核查，覆盖我选择的标题和分发文案。');
      assert.equal(bridge.getSnapshot().factCheckWorkspace.status, 'passed');
      await bridge.exportPublication('txt');
    } else {
      await turn('请读取 jiubian 的原版风格档案，结合当前稿件给两个可借鉴的表达特点，并说明档案验证状态。不改正文，不把风格当成事实或已经验证的效果。');
      await turn('请安排配图专家，针对当前文章策划一幅配图，说明插入位置、目的、画面和替代文本，保存方案让我确认。仅做策划，不调用图片服务、不生成图片文件。');
      await turn('确认配图方案，仅保存策划');
      assert.equal(bridge.getSnapshot().deliveryWorkspace.bodyVersionId, before.bodyVersionId);
    }
  } catch (error) { failure = error instanceof Error ? error.message : 'UAT_FAILED'; process.exitCode = 1; }
  finally {
    await bridge.refresh();
    const snapshot = bridge.getSnapshot();
    const report = { scenario, outcome: failure ? 'failed' : 'passed', failure, workspacePath, checkedAt: new Date().toISOString(),
      messages, runs: snapshot.runRecords, factStatus: snapshot.factCheckWorkspace.status, body: snapshot.previewDocument, proposals: snapshot.revisionWorkspace.proposals };
    host.close();
    const readback = openWorkspaceStorage({ workspacePath });
    try {
      const project = readback.inspectProject(projectId)!;
      const artifacts = { title: project.currentTitleVersionId ? readback.getArtifactVersion(project.currentTitleVersionId) : null,
        candidates: readback.listArtifactVersions(projectId, 'report', 'author-publication-candidates'),
        illustrations: readback.listArtifactVersions(projectId, 'report', 'author-illustration-plan') };
      if (!failure && scenario === 'style_illustration') {
        try {
          assert.ok(artifacts.illustrations.at(-1), 'Illustration plan must actually be persisted');
          const plan = JSON.parse(artifacts.illustrations.at(-1)!.content);
          assert.equal(plan.status, 'confirmed'); assert.deepEqual(plan.imageFiles, []); assert.equal(plan.generationAvailable, false);
          assert.ok(readback.listEvents(projectId).some(e => e.type === 'tool.completed' && (e.payload.result as any)?.toolName === 'read_legacy_style'));
        } catch (error) { report.failure = error instanceof Error ? error.message : 'READBACK_FAILED'; report.outcome = 'failed'; process.exitCode = 1; }
      }
      writeFileSync(join(evidenceRoot, `${scenario}.json`), JSON.stringify({ ...report, artifacts }, null, 2));
      reports.push({ scenario, outcome: report.outcome, failure, runs: snapshot.runRecords.map(r => ({ status: r.status, modelRequests: r.modelRequests })) });
    } finally { readback.close(); }
    console.log(JSON.stringify({ scenario, outcome: report.outcome, failure, evidenceRoot }));
  }
}
writeFileSync(join(evidenceRoot, 'summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(), scenarios: reports, root }, null, 2));
