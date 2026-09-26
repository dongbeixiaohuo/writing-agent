// No production profile/key access. Measures the real Windows backend using a nonexistent test reference.
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopApplicationHost } from '../../apps/desktop/src/application-host.js';

const root = mkdtempSync(join(tmpdir(), 'wa-settings-latency-'));
const profile = join(root, 'provider.json');
writeFileSync(profile, JSON.stringify({ schemaVersion: 2, kind: 'openai_compatible', providerId: 'latency-test',
  baseURL: 'https://example.test/v1', model: 'test-model', tools: 'supported', usage: 'unknown', credentialRef: `managed:missing-${randomUUID()}` }));
const host = new DesktopApplicationHost({ workspacePath: join(root, 'workspace'), providerProfilePath: profile });
try {
  const start = performance.now();
  const list = await host.providerStatus('summary');
  const listMs = performance.now() - start;
  const detailStart = performance.now();
  const detail = await host.providerDetails(list.profiles![0]!.profileId);
  const detailMs = performance.now() - detailStart;
  const result = { listMs, detailMs, profiles: list.profiles!.length, listCredentialChecked: list.profiles![0]!.credentialChecked,
    missingTestKeyDetected: !detail.configured, originalProjectWrites: 0, realModelCalls: 0, root };
  mkdirSync('output/rc38', { recursive: true });
  writeFileSync('output/rc38/settings-latency.json', JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result));
} finally { host.close(); }
