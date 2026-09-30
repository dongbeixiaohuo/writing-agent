import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';

const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(config.model, 'MiniMax-M3');
const root = mkdtempSync(join(tmpdir(), 'writing-agent-rc31-gap-'));
const storage = openWorkspaceStorage({ workspacePath: root });
const app = new WritingApplicationService({ storage, provider: createConfiguredProvider(config, createDefaultCredentialBroker()) });
const actor = { kind: 'user', id: 'isolated-test' } as const;
try {
  app.createProject({ operationId: 'p', projectId: 'p', name: '必要经历缺失验证', mode: 'quick', actor });
  const saved = app.saveWritingBrief({ operationId: 'brief', projectId: 'p', expectedProjectRevision: 0, baseVersionId: null, actor, brief: {
    schemaVersion: 1, topic: '我昨天的一次真实职场冲突', genre: 'practical_experience', audience: '普通上班族', lengthTarget: { targetCharacters: 600 }, materialIds: [],
    constraints: ['只写我的真实经历，不得虚构。尚未提供冲突发生的经过、当事人的话或结果。'], interactionMode: 'co_creation',
    authorAuthorization: { voice: '平实', styleReference: null, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
    platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed',
  } });
  assert.ok(saved.ok);
  const p = storage.inspectProject('p')!;
  const input = { projectId: 'p', expectedProjectRevision: p.revision, expectedBriefVersionId: p.currentBriefVersionId!, model: config.model, parameters: { temperature: 0 }, budget: { maxModelRequests: 8, maxToolCalls: 12, maxRetriesPerRequest: 0, maxMajorRevisions: 1 } };
  console.log(JSON.stringify({ phase: 'missing-experience', root }));
  const run = await app.runDraft({ ...input, userInstruction: '开始吧。' });
  assert.equal(storage.getRun(run.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
  const firstQuestions = storage.listRunEvents(run.runId).findLast(e => e.type === 'run.waiting_user')?.payload;
  await app.resumeDraft({ ...input, expectedProjectRevision: storage.inspectProject('p')!.revision, runId: run.runId, operationId: 'still-incomplete', decision: 'resume', userInstruction: '就是和同事有点不愉快，具体过程我还没说，你先别编。' }).result;
  assert.equal(storage.getRun(run.runId)?.stopReason, 'WRITING_INPUT_REQUIRED');
  assert.equal(storage.listArtifactVersions('p', 'outline', 'main').length, 0);
  assert.equal(storage.listArtifactVersions('p', 'body', 'main').length, 0);
  const out = resolve('output/rc31-dialogue'); mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'real-gap.json'), JSON.stringify({ root, model: config.model, firstQuestions, finalQuestions: storage.listRunEvents(run.runId).findLast(e => e.type === 'run.waiting_user')?.payload, usage: storage.getRun(run.runId)?.usage, noOutlineOrBody: true }, null, 2));
  console.log('MISSING_INFORMATION_STAYS_IN_DIALOGUE');
} finally { storage.close(); }
