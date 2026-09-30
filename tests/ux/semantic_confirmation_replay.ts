/** Real-model language interpretation, synthetic workspaces only. Never advances a user's project. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderCatalog } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { AgentRuntime, FinalOutputContinuationRequiredError } from '../../packages/runtime/agent/src/index.js';
import { ToolRegistry } from '../../packages/runtime/tools/src/index.js';
import { createConversationIntent, type AuthorIntent } from '../../packages/application/src/conversation-intent.js';

const catalog = loadDesktopProviderCatalog(join(process.env.APPDATA!, 'Writing Agent', 'provider.json'));
const entry = catalog.profiles.find(p => p.id === catalog.activeProfileId && /minimax/i.test(p.config.model))
  ?? catalog.profiles.find(p => /minimax/i.test(p.config.model));
assert.ok(entry, 'An existing MiniMax configuration is required');
const provider = createConfiguredProvider(entry.config, createDefaultCredentialBroker());
const root = mkdtempSync(join(tmpdir(), 'wa-semantic-confirmation-'));
const cases: { text: string; stage?: string; expected: AuthorIntent; index?: number; context?: unknown }[] = [
  ...['认同', '认可；', '我觉得你说的这些都挺对的，往下做吧', '行呀，后面的交给你了', '没啥要补充的，这轮就这么定了'].map(text => ({ text, stage: 'review_reader', expected: 'approve_checkpoint' as const })),
  ...['不同意', '还没确认', '认可第一点，但第二点为什么要改？', '先别交给下一位，解释一下', '你刚才说“同意就继续”，我还没答应呢'].map(text => ({ text, stage: 'review_reader', expected: 'discuss' as const })),
  { text: '方向我喜欢，但提纲的第二部分换成对比结构，改好给我看看', stage: 'outline', expected: 'revise_checkpoint' },
  { text: '这个方向我挺满意的，就这样开始吧', expected: 'confirm_direction', context: { pendingDirection: '写给公众号读者的一千字观察，第二人称，不虚构亲历。请确认这个写作方向。' } },
  { text: '确认，但改成写给管理者', expected: 'revise_direction', context: { pendingDirection: '写给普通读者的夜跑入门文章，等待确认。' } },
  { text: '我更喜欢那个讲窗边的，就它吧', expected: 'select_title', index: 2 },
  { text: '都不错，可以的', expected: 'clarify_title_selection' },
  { text: '你觉得第二个好在哪？先别选', expected: 'discuss' },
  { text: '这几个不太行，再给我弄三个短一点的，正文不用碰', expected: 'generate_titles' },
  { text: '这个配图安排我觉得挺好，就保留它吧，不需要生成图片', expected: 'confirm_illustrations', context: { pendingIllustrationPlan: { id: 'plan1', status: 'proposed', items: ['开头之后插入窗边光影图'], generationAvailable: false }, question: '这个配图策划可以吗？只保存方案，不生成图片。' } },
  { text: '文章不用再改，帮我把里面的事实重新过一遍', expected: 'fact_check', context: { currentArticleSaved: true, titleAlreadySelected: true } },
  { text: '给我解释一下核查是怎么做的，别真的去执行', expected: 'discuss', context: { currentArticleSaved: true } },
  { text: '以后写东西都别用套话开头，这点帮我一直记着', expected: 'remember_preference', context: { currentArticleSaved: true } },
  { text: '之前让你记的写作习惯不用了，忘掉吧', expected: 'forget_preferences', context: { savedPreferences: ['开头不要套话'] } },
  { text: '这篇开头别用套话就行，其他文章不用管', expected: 'discuss', context: { currentArticleSaved: true } },
];
const results: unknown[] = [];
for (let offset = 0; offset < cases.length; offset += 2) await Promise.all(cases.slice(offset, offset + 2).map(async (sample, n) => {
  const id = offset + n, storage = openWorkspaceStorage({ workspacePath: join(root, String(id)) });
  try {
    storage.createProject({ projectId: 'p', operationId: 'p', name: '独立语义验收', mode: 'quick', actor: { kind: 'user', id: 'fixture' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'fixture' });
    if (sample.stage) {
      storage.startRun({ projectId: 'p', sessionId: 's', runId: 'writing', planVersion: 'fixture' });
      storage.pauseRun({ projectId: 'p', runId: 'writing', operationId: 'pause', reason: 'CO_CREATION_CHECKPOINT', payload: { stage: sample.stage, nextStage: sample.stage === 'outline' ? 'draft' : 'central_revision' } });
    }
    const context = sample.context ?? (sample.stage ? { currentExpertReview: { stage: sample.stage, content: '建议删除文末自检清单；保留三层分析结构；压缩术语解释。' },
      history: [{ role: 'assistant', content: '这一轮建议你认可吗？可以继续讨论；明确认可后由修订主笔处理。' }] }
      : { pendingPublicationSelection: true, publicationCandidates: { candidates: [{ title: '慢一点' }, { title: '窗边的安静' }, { title: '留一点空白' }] }, history: [{ role: 'assistant', content: '三个标题你想用哪一个？也可以提出修改。' }] });
    const allowed: AuthorIntent[] = sample.stage ? ['approve_checkpoint', ...(sample.stage.startsWith('review_') ? [] : ['revise_checkpoint'] as const), 'discuss'] : sample.expected.includes('direction')
      ? ['confirm_direction', 'revise_direction', 'discuss'] : ['select_title', 'clarify_title_selection', 'generate_titles', 'confirm_illustrations', 'plan_illustrations', 'fact_check', 'full_writing', 'remember_preference', 'forget_preferences', 'discuss'];
    const intent = createConversationIntent({ storage, projectId: 'p', sessionId: 's', userMessage: sample.text, context, allowedIntents: allowed });
    const runtime = new AgentRuntime({ provider, sessions: storage, tools: ToolRegistry.create([intent.definition]), requestPolicy: id => intent.policy(id),
      completeAfterTool: output => output.ok && intent.result() ? { content: '意图已保存', artifactVersionId: intent.result()!.artifactVersionId } : null,
      finalOutputCommitter: { commit: async () => { throw new FinalOutputContinuationRequiredError('AUTHOR_OUTPUT_REQUIRED', 'Structured intent required', '请仅调用 interpret_author_reply 保存本轮意图，不输出普通回复。'); } } });
    const start = Date.now();
    const result = await runtime.start({ projectId: 'p', sessionId: 's', purpose: 'semantic-validation', model: entry.config.model,
      parameters: { maxOutputTokens: 1024 }, systemPrompt: 'Interpret the current reply with the scoped policy.', userMessage: sample.text, displayInstruction: sample.text,
      grantedPermissions: ['author:intent'], budget: { maxModelRequests: 2, maxToolCalls: 2, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } }).result;
    const actual = intent.result();
    const passed = result.ok && actual?.intent === sample.expected && (sample.index === undefined || actual.selectionIndex === sample.index);
    const row = { text: sample.text, expected: sample.expected, actual: actual?.intent ?? null, selectedIndex: actual?.selectionIndex ?? null, passed, ms: Date.now() - start,
      usage: storage.getRun(result.runId)?.usage, stopReason: storage.getRun(result.runId)?.stopReason };
    results.push(row); console.log(JSON.stringify(row));
  } finally { storage.close(); }
}));
mkdirSync(resolve('output/semantic-confirmation'), { recursive: true });
writeFileSync(resolve('output/semantic-confirmation/minimax-results.json'), JSON.stringify({ model: entry.config.model, root, originalProjectWrites: 0, results }, null, 2));
assert.ok(results.every((r: any) => r.passed), 'Semantic cases failed; inspect report before delivery');
