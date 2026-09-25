// Explicitly authorized, bounded real-provider UAT. Never imports a production workspace.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';
import type { CreateProjectInput } from '../../packages/client-bridge/src/protocol.js';

const [scenario, testId, approval, resumeFlag] = process.argv.slice(2);
if (resumeFlag !== undefined && (!['--resume-existing', '--retry-complete', '--resume-retry', '--final-complete', '--resume-final', '--acceptance-complete'].includes(resumeFlag) || scenario !== 'complete')) throw new Error('Only the existing complete scenario can resume/retry');
if (!['missing', 'outline', 'complete'].includes(scenario ?? '') || !/^cr002-[a-z0-9-]{8,48}$/u.test(testId ?? '') || approval !== '--allow-real-model') {
  throw new Error('Usage: tsx tests/ux/cr002_real_model.ts missing|outline|complete cr002-<test-id> --allow-real-model');
}
const root = join(tmpdir(), `writing-agent-desktop-test-${testId}`);
const evidenceRoot = resolve('output', testId!);
mkdirSync(evidenceRoot, { recursive: true });
const host = new DesktopApplicationHost({
  workspacePath: join(root, 'workspace'),
  providerProfilePath: join(process.env.APPDATA!, 'Writing Agent', 'provider.json'),
  applicationVersion: '1.0.0-rc.7',
});
const bridge = host.bridge;
const sample = '这是用于软件验收的虚构练习材料，不冒充作者真实经历：叙述者每晚关电脑前，把明天想做的一件小事写在纸上。有时只写“把桌面收拾一下”。写完就把纸留在键盘边，第二天看到后再决定做不做。叙述者喜欢这种没有打卡、没有评分的小习惯；偶尔没做也不觉得失败。文章只表达这一虚构叙述者的主观感受，不提出习惯能提高效率、改善心理或适用于他人的事实结论。';
const input: CreateProjectInput = {
  name: `CR002 ${scenario} 桌面体验`, mode: 'deep',
  topic: scenario === 'missing' ? 'test' : '留一张写着小事的纸给明天',
  genre: 'narrative_observation', audience: '喜欢生活随笔的普通读者', targetCharacters: 600,
  constraints: ['只使用给定材料，禁止补造人物、数字、事件和效果。', '虚构练习必须明确标注，不冒充真实经历；只写主观感受，不引入外部事实。'],
  interactionMode: scenario === 'complete' ? 'autonomous' : 'co_creation',
  authorVoice: '平实克制，不说教', styleReference: null, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed',
  platform: null, publicationGoal: 'not_applicable',
  materials: [{ name: '验收合成材料', content: scenario === 'missing' ? 'test' : sample, role: 'illustrative', sourceKind: 'pasted_text', sourceReference: null }],
};

let runId: string | null = null;
let outcome = 'failed';
let failure: string | null = null;
async function waitForBoundary() {
  const deadline = Date.now() + 12 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await bridge.refresh();
    const snapshot = bridge.getSnapshot();
    const run = snapshot.runRecords.find(candidate => candidate.id === runId);
    const stamp = `${run?.status}/${run?.modelRequests}/${run?.completedStages}/${run?.stopReason}`;
    if (stamp !== last) {
      console.log(JSON.stringify({ scenario, status: run?.status, modelRequests: run?.modelRequests, stagesSaved: run?.completedStages, stopReason: run?.stopReason }));
      last = stamp;
    }
    if (run !== undefined && !['running', 'queued', 'paused'].includes(run.status)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  if (runId !== null) await bridge.cancelRun(runId);
  throw new Error('SCENARIO_DEADLINE_EXCEEDED');
}

try {
  const status = await host.providerStatus();
  assert.equal(status.configured, true, 'Existing credential must be available; never silently use a mock');
  assert.equal(status.model, 'MiniMax-M3');
  if (resumeFlag !== undefined) {
    const prior = JSON.parse(readFileSync(join(evidenceRoot, resumeFlag === '--acceptance-complete' ? 'complete-final-resumed.json' : resumeFlag === '--resume-final' ? 'complete-final.json' : resumeFlag === '--resume-retry' ? 'complete-retry.json' : 'complete.json'), 'utf8'));
    runId = prior.runId;
    await bridge.refresh();
    const project = bridge.getSnapshot().projects.find(project => project.name === input.name);
    assert.ok(project, 'Resume must reuse the isolated scenario project');
    await bridge.selectProject(project.id);
    // Cancel only the orphan created by the earlier harness selecting a project instead of its session.
    for (const orphan of bridge.getSnapshot().runRecords.filter(run => run.id !== runId && ['running', 'queued', 'paused', 'interrupted'].includes(run.status))) {
      await bridge.cancelRun(orphan.id);
    }
    const waiting = prior.waiting.find((run: { runId: string; sessionId: string }) => run.runId === runId);
    assert.ok(waiting, 'The original waiting run must still exist');
    await bridge.selectSession(project.id, waiting.sessionId);
    if (resumeFlag === '--acceptance-complete') {
      // This old run has only six requests left. Preserve its failed history,
      // explicitly cancel it, and use the current bounded budget for the same scenario.
      await bridge.cancelRun(runId);
      runId = (await bridge.sendMessage('请重新完成当前生活随笔的修订、审校和核查。必须先修改正文：删去材料没有提供的屏幕暗下、笔尖停顿、第二天早上抬头、天快亮、窗外光线、合上本子等新增场景。只用原始虚构练习材料中的写纸条、留在键盘旁、次日决定做不做、不打卡不评分与偶尔没做也不觉得失败这些内容，保留虚构标注，只表达主观感受。材料边界优先于约600字，可以更短，不为凑字数扩写事件。只交付文章正文；先完成修改，再独立核查，不将旧稿反复核查当作修改。')).runId;
    } else if (resumeFlag === '--retry-complete' || resumeFlag === '--final-complete') {
      runId = (await bridge.sendMessage(resumeFlag === '--final-complete'
        ? '请基于当前已保存的生活随笔，按原始虚构练习材料完成写作、审校和核查。保留虚构标注和材料边界，只把文章正文作为稿件。'
        : '请按原始虚构练习材料重新完成这篇生活随笔。此前生成中断，语言终审误把审校意见写进正文；请重新形成完整文章，不把审校报告当成稿件。')).runId;
    } else {
      const resumed = await bridge.sendMessage(resumeFlag === '--resume-final'
        ? '请修改当前文章后重新核查：删去材料没有提供的屏幕暗下、笔尖停在半途、第二天早上抬头、天快亮、窗外光线、合上本子等具体场景，不能把这些自行添加的情节当成材料事实。只保留原材料中的写纸条、留在键盘旁、次日决定做不做及不打卡不评分的主观感受，保留虚构练习标注。材料边界优先于约600字，可以更短，不为凑字数扩写事件。请先修正文，再独立核查；不要把需要修改的问题直接判定为通过。'
        : resumeFlag === '--resume-retry'
        ? '请核查这一轮已保存的最新文章，而不是此前被替换的审校报告。原始虚构练习材料和范围不变，无需补充外部事实。'
        : '继续完成原写作任务，技术 ID 由系统自动绑定，无新增业务缺口。');
      assert.equal(resumed.runId, runId);
    }
  } else {
    await bridge.createProject(input);
    await bridge.confirmBrief();
    runId = (await bridge.sendMessage(scenario === 'missing' ? '开始' : '请按给定的虚构练习材料写作。')).runId;
  }
  let snapshot = await waitForBoundary();
  if (scenario === 'missing') {
    const waiting = snapshot.recoverableRuns.find(run => run.runId === runId);
    assert.equal(waiting?.stopReason, 'WRITING_INPUT_REQUIRED');
    assert.ok((waiting?.inputRequest?.questions.length ?? 0) > 0);
    assert.equal(snapshot.previewDocument.status, 'empty');
    assert.equal(snapshot.runRecords.find(run => run.id === runId)?.completedStages, 0);
  } else if (scenario === 'outline') {
    let waiting = snapshot.recoverableRuns.find(run => run.runId === runId);
    assert.equal(waiting?.checkpointStage, 'outline');
    const firstOutline = snapshot.materialProcessWorkspace.outline?.content;
    assert.ok(firstOutline);
    const resumed = await bridge.sendMessage('先修改提纲：从“偶尔没做也不觉得失败”开头，再回到写纸条的动作；不要按时间顺序展开。请先给我看修改后的提纲，暂时不要写正文。');
    assert.equal(resumed.runId, runId);
    snapshot = await waitForBoundary();
    waiting = snapshot.recoverableRuns.find(run => run.runId === runId);
    assert.equal(waiting?.checkpointStage, 'outline');
    assert.notEqual(snapshot.materialProcessWorkspace.outline?.content, firstOutline);
    assert.equal(snapshot.previewDocument.status, 'empty');
  } else {
    assert.equal(snapshot.runRecords.find(run => run.id === runId)?.status, 'completed');
    assert.equal(snapshot.factCheckWorkspace.status, 'passed');
    assert.ok(snapshot.previewDocument.body.length > 0);
    assert.doesNotMatch(snapshot.previewDocument.body, /本稿语言底子|建议优先处理|整体可保留/u, 'Review report must never replace article');
    const timeline = JSON.stringify(snapshot.timelineBySession[snapshot.selectedSessionId]);
    assert.match(timeline, /写作导演/u);
  }
  outcome = 'passed';
} catch (error) {
  failure = error instanceof Error ? error.message : 'unknown error';
  process.exitCode = 1;
} finally {
  const snapshot = bridge.getSnapshot();
  // Only synthetic fixture content and safe projected state; never keys or raw provider responses.
  const report = { scenario, outcome, failure, checkedAt: new Date().toISOString(), root, runId,
    runs: snapshot.runRecords, waiting: snapshot.recoverableRuns,
    factStatus: snapshot.factCheckWorkspace.status,
    timeline: snapshot.timelineBySession[snapshot.selectedSessionId],
    outline: snapshot.materialProcessWorkspace.outline,
    preview: snapshot.previewDocument,
  };
  const evidencePath = join(evidenceRoot, `${scenario}${resumeFlag === '--acceptance-complete' ? '-acceptance' : resumeFlag === '--resume-final' ? '-final-resumed' : resumeFlag === '--final-complete' ? '-final' : resumeFlag === '--resume-retry' ? '-retry-resumed' : resumeFlag === '--retry-complete' ? '-retry' : resumeFlag ? '-resumed' : ''}.json`);
  writeFileSync(evidencePath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ scenario, outcome, failure, evidence: evidencePath }));
  host.close();
}
