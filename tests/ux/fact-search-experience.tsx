import React from 'react';
import { createRoot } from 'react-dom/client';
import { RunTrace } from '../../packages/ui/src/shell/RunTrace.tsx';
import { MarkdownContent } from '../../packages/ui/src/shell/MarkdownContent.tsx';
import { factCheckCompletionSummary } from '../../packages/client-bridge/src/fact-summary.ts';
import type { RunRecordView } from '../../packages/client-bridge/src/protocol.ts';
import '../../packages/ui/src/theme/global.css';
import '../../packages/ui/src/shell/RunTrace.css';

// Synthetic records only: no model, real search key, or workspace is accessed.
const records: RunRecordView[] = [{ id: 'fixture', status: 'completed', purpose: 'fact-check', displayInstruction: '公开事实核查 · 隔离样例',
  startedAt: '2026-10-02T01:00:00Z', completedAt: '2026-10-03T03:00:04Z', stopReason: null, modelRequests: 2, maxModelRequests: 4,
  toolCalls: 2, maxToolCalls: 6, totalTokens: 100, stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
  diagnostics: { segments: [], trace: [
    { id: 'model-timeout', segmentId: 's', kind: 'model', occurredAt: '2026-10-02T01:00:00Z', completedAt: '2026-10-02T01:03:00Z',
      status: 'failed', label: '模型首个响应超时', durationMs: 180000, errorCode: 'TIMEOUT', transport: { phase: 'first_response', timeoutMs: 180000, elapsedMs: 180000, firstResponseMs: null, lastActivityMs: null } },
    { id: 'search-timeout', segmentId: 's', kind: 'tool', technicalName: 'search_fact_sources', occurredAt: '2026-10-03T03:00:00Z', completedAt: '2026-10-03T03:00:02Z',
      status: 'failed', label: '搜索服务失败样例', durationMs: 2000, errorCode: 'SEARCH_HTTP_429', inputPreview: '公开日期', outputPreview: 'Tavily 已发出 1 个 HTTP 请求，服务返回错误。' },
    { id: 'source-denied', segmentId: 's', kind: 'tool', technicalName: 'read_fact_source', occurredAt: '2026-10-03T03:00:03Z', completedAt: '2026-10-03T03:00:04Z',
      status: 'failed', label: '来源记录匹配失败样例', durationMs: 4, errorCode: 'FACT_SOURCE_NOT_IN_LEDGER', inputPreview: '未在当前来源记录中匹配到读取目标' },
  ] } }];
const summary = factCheckCompletionSummary({ payload: { coverage: { body: true, title: true, distributionCopy: true }, claims: [
  { claimText: '报告记录的开馆时间是上午九点', location: '第 2 段', status: 'SUPPORTED', supportScope: 'full',
    evidenceSummary: '已提供的报告第 3 页列出开馆时间为 09:00，与文中表述一致。', sourceReference: '已提供报告，第 3 页' },
  { claimText: '文中使用了历史人物的生卒年代', location: '第 4 段', status: 'SUPPORTED', supportScope: 'full',
    evidenceSummary: '模型知识复核，未联网验证；发布前建议再查权威人物资料。', sourceReference: 'model-knowledge:unverified' },
] } });
createRoot(document.getElementById('root')!).render(<main style={{ margin: '24px auto', maxWidth: 1280, padding: 16 }}>
  <h1>事实核查体验 · 隔离验收</h1>
  <p>合成失败与核查结论，不访问模型、不读取或修改真实配置。</p>
  <RunTrace records={records} activeRunId={null} />
  <section style={{ margin: '32px 0', padding: 24, border: '1px solid #ddd', borderRadius: 16 }}>
    <h2>核查完成后的主对话</h2>
    <MarkdownContent content={summary} />
  </section>
</main>);
