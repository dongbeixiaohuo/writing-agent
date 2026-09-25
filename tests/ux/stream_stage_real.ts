/** Paid isolated MiniMax checks. Never reads/writes the author's workspace. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelProvider } from '../../packages/runtime/llm/src/index.js';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';

const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(config.model, 'MiniMax-M3');
const resume = process.argv.includes('--resume-last') ? JSON.parse(readFileSync(resolve('output/stream-stage/real-result.json'), 'utf8')) : null;
const root = resume?.root ?? mkdtempSync(join(tmpdir(), 'writing-agent-stream-stage-'));
assert.ok(root.startsWith(join(tmpdir(), 'writing-agent-stream-stage-')), 'isolated test workspace only');
const storage = openWorkspaceStorage({ workspacePath: root });
const real = createConfiguredProvider(config, createDefaultCredentialBroker());
const output = resolve('output/stream-stage'); mkdirSync(output, { recursive: true });
const requests: any[] = resume?.requests ?? []; const cases: any[] = resume?.cases ?? [];
const provider: ModelProvider = {
  id: real.id, adapterVersion: real.adapterVersion, capabilities: real.capabilities,
  capabilitiesFor: m => real.capabilitiesFor(m), snapshotRequest: r => real.snapshotRequest(r),
  async *stream(request) {
    const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    const start = performance.now();
    const sample: any = { actor: state.actor, stage: state.stage, choice: request.parameters.toolChoice, textChunks: [], toolChunks: [], text: '' };
    requests.push(sample);
    console.log(JSON.stringify({ phase: 'request', actor: state.actor, n: requests.length }));
    for await (const event of real.stream(request)) {
      if (event.type === 'text_delta') { sample.textChunks.push({ ms: Math.round(performance.now() - start), chars: event.delta.length }); sample.text += event.delta; }
      if (event.type === 'tool_call_delta') sample.toolChunks.push({ ms: Math.round(performance.now() - start), name: event.name, chars: event.argumentsDelta.length });
      if (event.type === 'usage') sample.usage = event.usage;
      yield event;
    }
    sample.durationMs = Math.round(performance.now() - start);
  },
};
const app = new WritingApplicationService({ storage, provider });
const actor = { kind: 'user', id: 'isolated-validation' } as const;
try {
  for (const [index, topic] of (resume ? ['一个人天天精神内耗怎么办'] : ['一个人天天精神内耗怎么办', '在周末给自己留一点安静']).entries()) {
    const projectId = `isolated-${index}`;
    if (!resume) {
    app.createProject({ projectId, operationId: projectId, name: topic, mode: 'quick', actor });
    const brief = app.saveWritingBrief({ projectId, operationId: `${projectId}-brief`, expectedProjectRevision: storage.inspectProject(projectId)!.revision, baseVersionId: null, actor,
      brief: { schemaVersion: 1, topic, genre: 'narrative_observation', audience: '普通成年上班族', lengthTarget: { targetCharacters: 1000 }, materialIds: [],
        constraints: ['公众号个人观察短文，方法七成、感受三成。一般生活建议，不作医学诊断，不引用数据、名人语录，不虚构亲历。不需要事实型案例；使用明确假设的通用场景。先形成提纲等作者确认，不能写正文。作者已选定结构：按事前反复想、事中纠结、事后反刍三个环节，每个环节一个简单动作。开头用明确假设的晚上回放白天某句话的场景，结尾轻微和解。此结构和视角已经确认，无需提供分类候选或再次征求场景偏好；其余非关键遣词由专家提出方案供后续提纲确认。'],
        interactionMode: 'co_creation', authorAuthorization: { voice: '克制自然，第二人称', styleReference: null, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
        platform: '微信公众号', publicationGoal: 'primary', confirmationStatus: 'confirmed' } });
    assert.ok(brief.ok, JSON.stringify(brief));
    }
    const project = storage.inspectProject(projectId)!;
    const input = { projectId, expectedProjectRevision: project.revision, expectedBriefVersionId: project.currentBriefVersionId!, model: config.model,
      parameters: { temperature: 0 }, budget: { maxModelRequests: 24, maxToolCalls: 32, maxRetriesPerRequest: 1, maxMajorRevisions: 1 } };
    const handle = resume ? app.resumeDraft({ ...input, runId: cases.at(-1).runId, operationId: `test-answer-${Date.now()}`, decision: 'resume',
      userInstruction: '已确认：事前B2，把万一换成下一步是什么；事中C2，60秒做最小版本；事后D2，那件事过去了。结尾选克制：够了，少耗一点是一点。开头某句话保持模糊不写关系类型。其余非关键遣词和安排请专家自主拟定，直接形成提纲等我看；不能写正文。' }) : app.startDraft(input);
    const start = performance.now(); const previews: { ms: number; chars: number }[] = [];
    const timer = setInterval(() => {
      const reply = app.getLiveReply(projectId, handle.sessionId, handle.runId);
      if (reply?.text && previews.at(-1)?.chars !== reply.text.length) previews.push({ ms: Math.round(performance.now() - start), chars: reply.text.length });
    }, 100);
    let result;
    try { result = await handle.result; } finally { clearInterval(timer); }
    const outline = storage.listArtifactVersions(projectId, 'outline', 'main').at(-1);
    cases.push({ topic, runId: result.runId, status: storage.getRun(result.runId)?.status, stopReason: storage.getRun(result.runId)?.stopReason,
      previews, savedChars: outline?.content.length, events: storage.listRunEvents(result.runId) });
    writeFileSync(join(output, 'real-result.json'), JSON.stringify({ root, model: config.model, requests, cases }, null, 2));
    assert.equal(storage.getRun(result.runId)?.stopReason, 'CO_CREATION_CHECKPOINT');
    assert.equal(storage.inspectProject(projectId)!.latestBodyVersionId, null);
    const generated = requests.filter(r => r.stage === 'outline').at(-1)!;
    assert.equal(outline?.content.trim(), generated.text.trim());
    assert.ok(generated.textChunks.length > 3, 'must receive actual text deltas, not full tool arguments');
    assert.ok(previews.length > 3, 'application must expose intermediate text before persistence');
    console.log(JSON.stringify({ phase: 'PASS', topic, firstVisibleMs: previews[0]?.ms, samples: previews.length, stageFirstTextMs: generated.textChunks[0]?.ms, stageDurationMs: generated.durationMs }));
  }
} finally { storage.close(); }
