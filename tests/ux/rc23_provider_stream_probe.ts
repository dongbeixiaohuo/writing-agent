/** Explicitly authorized real-model probe; records lengths/timing only, never credentials or content. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';

if (!process.argv.includes('--allow-real-model')) throw new Error('Explicit real model flag required');
const config = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent', 'provider.json'));
if (!config || config.model !== 'MiniMax-M3') throw new Error('Expected configured MiniMax-M3');
const provider = createConfiguredProvider(config, createDefaultCredentialBroker());
const started = performance.now();
const events: unknown[] = [];
for await (const event of provider.stream({
  requestId: crypto.randomUUID(), model: config.model, parameters: { toolChoice: 'required', maxOutputTokens: 2048 },
  messages: [{ role: 'system', content: '使用reply_to_user工具回复作者。只讨论，不写正文。' },
    { role: 'user', content: '想写成年人周末无所事事却又有点内疚的感觉。请给三个不同的切入角度，每个约150字，比较各自优缺点。' }],
  tools: [{ name: 'reply_to_user', description: 'Save public reply', inputSchema: {
    type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false,
  } }], signal: AbortSignal.timeout(90000),
})) {
  events.push({ t: Math.round(performance.now() - started), type: event.type,
    ...('delta' in event ? { length: event.delta.length } : {}),
    ...('argumentsDelta' in event ? { length: event.argumentsDelta.length } : {}),
    ...(event.type === 'error' ? { code: event.error.code } : {}),
    ...(event.type === 'usage' ? { usage: event.usage } : {}),
  });
}
const dir = 'output/rc23-real-streaming'; mkdirSync(dir, { recursive: true });
const path = join(dir, `provider-probe-${Date.now()}.json`);
writeFileSync(path, JSON.stringify({ model: config.model, events }, null, 2));
console.log(JSON.stringify({ path, events }));
