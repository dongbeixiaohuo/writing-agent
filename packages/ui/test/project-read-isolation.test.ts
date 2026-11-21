import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('all-bad project UI exposes a real raw export, explicit workspace restore and recheck entry without a composer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-project-isolation-ui-'));
  const output = join(directory, 'render.cjs');
  try {
    buildSync({ stdin: { contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { WritingAgentShell } from './packages/ui/src/shell/WritingAgentShell.tsx';
      import { createDeterministicMockBridge } from './packages/client-bridge/src/mock-bridge.ts';
      const bridge = createDeterministicMockBridge({latencyMs: 0});
      const original = bridge.getSnapshot();
      const snapshot = { ...original, selectedSessionId: '', sessions: [],
        projects: original.projects.map(p => ({ ...p, sessionIds: [], readIssue: { code: 'PROJECT_BRIEF_INVALID', stage: '读取写作简报', message: '项目简报无法读取；原始数据已保留。' } })) };
      bridge.getSnapshot = () => snapshot;
      const extensions = {extensionIds: [], listLaunchers: () => [], getPanel: () => undefined};
      const hostConfiguration = { exportProjectRecovery: async () => ({cancelled: false, fileName: 'project.json'}),
        repairProjectFromBackup: async () => ({cancelled: true}) };
      export const html = renderToStaticMarkup(React.createElement(WritingAgentShell, {bridge, extensions, hostConfiguration}));
      bridge.dispose();
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: output,
      jsx: 'automatic', loader: {'.css': 'empty'}, logLevel: 'silent' });
    const { html } = createRequire(import.meta.url)(output) as { html: string };
    assert.match(html, /aria-label="项目修复"/);
    assert.match(html, /导出此项目原始数据/);
    assert.match(html, /从备份修复此项目/);
    assert.match(html, /打开备份恢复/);
    assert.match(html, /还原会替换整个工作区，影响所有项目/);
    assert.match(html, /重新检查项目/);
    assert.match(html, /新建其他项目/);
    assert.doesNotMatch(html, /<textarea/);
    assert.match(html, /需要修复/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
