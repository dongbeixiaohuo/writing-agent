/** Repeat the actual isolated outline request; observe only, never execute tools. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { ConversationStreamPreview } from '../../packages/application/src/conversation-stream.js';
const report = JSON.parse(readFileSync(resolve('output/stream-stage/real-result.json'), 'utf8'));
assert.ok(report.root.startsWith(join(tmpdir(), 'writing-agent-stream-stage-')));
const storage = openWorkspaceStorage({ workspacePath: report.root });
const request = structuredClone(storage.listRequestSnapshots(report.cases.at(-1).runId).findLast(s => s.request.messages[0]?.content.includes('ACTOR=outline'))!.request);
storage.close();
request.requestId = `stream-probe-${randomUUID()}`;
Object.defineProperty(request, 'signal', { value: AbortSignal.timeout(180000) });
const profile = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(profile.model, 'MiniMax-M3');
const provider = createConfiguredProvider(profile, createDefaultCredentialBroker());
const preview = new ConversationStreamPreview();
const start = performance.now();
const chunks: { ms: number; chars: number; previewChars: number }[] = [];
let finishReason: string | null = null; let toolCalls = 0; let usage: unknown = null;
const base = { projectId: 'probe', sessionId: 'probe', runId: 'probe', requestId: request.requestId, actor: 'outline', outputPreview: { id: 'probe-output', stage: 'outline' as const } };
preview.observe({ ...base, lifecycle: 'started', event: null });
for await (const event of provider.stream(request)) {
  preview.observe({ ...base, event });
  if (event.type === 'text_delta') chunks.push({ ms: Math.round(performance.now() - start), chars: event.delta.length, previewChars: preview.get('probe', 'probe', 'probe')?.text.length ?? 0 });
  if (event.type === 'tool_call_complete') toolCalls++;
  if (event.type === 'usage') usage = event.usage;
  if (event.type === 'completed') finishReason = event.finishReason;
}
const result = { durationMs: Math.round(performance.now() - start), firstTextMs: chunks[0]?.ms, chunks, finishReason, toolCalls, usage, originalProjectWrites: 0 };
writeFileSync(resolve('output/stream-stage/repeat-probe.json'), JSON.stringify(result, null, 2));
assert.equal(finishReason, 'stop'); assert.equal(toolCalls, 0); assert.ok(chunks.length > 3);
assert.ok(chunks[0]!.previewChars < chunks.at(-1)!.previewChars);
console.log(JSON.stringify({ ...result, chunks: chunks.length }));
