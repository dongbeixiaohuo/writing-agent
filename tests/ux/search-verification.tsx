import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { SearchSettings } from '../../packages/ui/src/shell/SearchSettings.tsx';
import { RunTrace } from '../../packages/ui/src/shell/RunTrace.tsx';
import type { DesktopHostConfiguration, SearchSettingsView } from '../../packages/client-bridge/src/desktop-bridge.ts';
import type { RunRecordView, RunTraceDetail } from '../../packages/client-bridge/src/protocol.ts';
import '../../packages/ui/src/theme/global.css';
import '../../packages/ui/src/shell/RunTrace.css';

let settings: SearchSettingsView = { parallelEnabled: false, tavilyEnabled: true, tavilyKeyConfigured: true, credentialPersistence: 'system' };
const attempts = { tavily: 0, parallel: 0 };
const host = {
  searchStatus: async () => ({ ...settings }),
  configureSearch: async (input) => { settings = { ...settings, parallelEnabled: input.parallelEnabled, tavilyEnabled: input.tavilyEnabled, verification: {} }; return { ...settings }; },
  testSearchConnection: async provider => {
    attempts[provider]++;
    await new Promise(resolve => setTimeout(resolve, 500));
    // A failed repeat probe deliberately tests removal of an old green availability mark.
    const success = attempts[provider] % 2 === 1;
    settings = { ...settings, verification: { ...settings.verification, [provider]: {
      status: success ? 'available' : 'failed', checkedAt: new Date().toISOString(), elapsedMs: 500,
      message: success ? '隔离测试连接成功' : '隔离测试连接失败（SEARCH_HTTP_401）',
    } } };
    return { ...settings };
  },
} satisfies Pick<DesktopHostConfiguration, 'searchStatus' | 'configureSearch' | 'testSearchConnection'>;
const records: RunRecordView[] = [{ id: 'r', status: 'completed', purpose: 'fact-check', displayInstruction: '核查公开事实',
  startedAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-03T03:00:00Z', stopReason: null, modelRequests: 1, maxModelRequests: 4,
  toolCalls: 1, maxToolCalls: 6, totalTokens: 100, stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
  diagnostics: { segments: [], trace: [
    { id: 'old', segmentId: 's', kind: 'model', occurredAt: '2026-10-01T01:00:00Z', completedAt: '2026-10-01T01:00:01Z', status: 'completed', label: '较早的模型请求', durationMs: 1000, errorCode: null },
    { id: 'new', segmentId: 's', kind: 'tool', technicalName: 'search_fact_sources', occurredAt: '2026-10-03T03:00:00Z', completedAt: '2026-10-03T03:00:02Z', status: 'completed', label: '搜索事实来源', durationMs: 2000, errorCode: null,
      inputPreview: '公开事实测试', outputPreview: 'Tavily：1 个 HTTP 请求 · 成功 · 检索结果待核实' },
  ] } }];
function App() {
  const [dispatched, setDispatched] = useState(false);
  const message = dispatched ? 'Tavily 已发出第 1 个 HTTP 请求，等待响应' : '已按搜索设置自动授权，正在准备 Tavily 请求';
  const liveRecords = records.map(record => ({ ...record, status: 'running' as const, completedAt: null,
    diagnostics: { ...record.diagnostics!, trace: record.diagnostics!.trace!.map(step => step.id === 'new'
      ? { ...step, status: 'pending' as const, completedAt: null, outputPreview: message } : step) },
  }));
  const loadDetail = useCallback(async (runId: string, stepId: string): Promise<RunTraceDetail> => ({ runId, stepId,
    requestId: null, callId: 'search-fixture', provider: null, model: null, notes: [],
    sections: [{ id: 'output', label: '实时搜索详情', format: 'text', text: message, totalCharacters: message.length, truncated: false }],
  }), [message]);
  return <main style={{ margin: '24px auto', maxWidth: 1250, padding: 16 }}>
  <h1>搜索设置 · 隔离验收</h1><p>使用实际 React 组件和模拟宿主，不访问模型、不读取或修改真实配置。</p>
  <SearchSettings host={host as DesktopHostConfiguration} />
  <button onClick={() => setDispatched(true)}>模拟 Tavily 发出请求</button>
  <RunTrace records={liveRecords} activeRunId="r" loadDetail={loadDetail} now={Date.parse('2026-10-03T03:00:03Z')} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
