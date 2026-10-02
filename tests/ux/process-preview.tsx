import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationWorking } from '../../packages/ui/src/shell/ConversationWorking.tsx';
import { MarkdownContent } from '../../packages/ui/src/shell/MarkdownContent.tsx';
import { RunTrace } from '../../packages/ui/src/shell/RunTrace.tsx';
import { createDeterministicMockBridge } from '../../packages/client-bridge/src/mock-bridge.ts';
import type { BridgeSnapshot, RunRecordView } from '../../packages/client-bridge/src/protocol.ts';
import '../../packages/ui/src/theme/global.css';
import '../../packages/ui/src/shell/RunTrace.css';

const bridge = createDeterministicMockBridge();
const base = bridge.getSnapshot();
const startedAt = Date.now() - 75000;
const body = '# 安静的片刻\n\n窗边的光线慢慢暗下来。我给这一天留了一点安静。\n\n不急着安排下一件事，也不必解释这一刻有什么用。';
function App() {
  const [mode, setMode] = useState('waiting');
  const [count, setCount] = useState(0);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (mode !== 'streaming') return;
    const timer = setInterval(() => setCount(n => Math.min(n + 5, body.length)), 70);
    return () => clearInterval(timer);
  }, [mode]);
  const activity: NonNullable<BridgeSnapshot['liveActivity']> = {
    runId: 'demo', requestId: 'q3', actor: mode === 'search' ? 'fact_check' : 'language_review', phase: 'receiving',
    startedAt, segmentStartedAt: startedAt, lastActivityAt: Date.now(), requestOrdinal: 3, lastEventKind: 'reasoning', receivedEvents: 36,
    materials: [{ id: 'body', label: '本次提供的稿件', text: body }, { id: 'review', label: '已保存的审校建议', text: '保持叙事顺序，只做必要的语言润色。不补造亲历。' }],
    ...(mode === 'process' ? { workPreview: { label: '下一步任务说明 · 整理中，尚未执行', text: step ? '核对文中的假期日期，正文保持不变。' : '核对文中的假期' } } : {}),
    ...(mode === 'search' ? { activeTool: { name: 'search_fact_sources', startedAt: Date.now() - 5000 } } : {}),
  };
  const record: RunRecordView = { id: 'demo', displayInstruction: '润色后核对事实', status: 'running', startedAt: new Date(startedAt).toISOString(), completedAt: null,
    stopReason: null, modelRequests: 3, maxModelRequests: 24, toolCalls: 2, maxToolCalls: 32, totalTokens: null,
    stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
    diagnostics: { segments: [], trace: [{ id: 'q1', requestId: 'q1', segmentId: 's', kind: 'model', actorLabel: '写作导演', label: '模型响应', status: 'completed',
      occurredAt: new Date(startedAt).toISOString(), completedAt: new Date(startedAt + 63000).toISOString(), durationMs: 63000,
      inputPreview: '检查当前写作信息', outputPreview: '返回 1 个工具调用', errorCode: null,
      stream: { headersMs: 4300, firstContentMs: 62000, lastContentMs: 63000, contentEvents: 8 } },
    { id: 'read', segmentId: 's', kind: 'tool', actorLabel: '写作导演', label: '读取参考材料', technicalName: 'read_material', status: 'completed',
      occurredAt: new Date(startedAt + 63000).toISOString(), completedAt: new Date(startedAt + 63042).toISOString(), durationMs: 42,
      inputPreview: '材料：已确认方向', outputPreview: '已读取指定材料版本', errorCode: null }] } };
  const snapshot = { ...base, activeRunId: 'demo', liveActivity: activity,
    liveReply: mode === 'streaming' ? { runId: 'demo', requestId: 'q3', text: body.slice(0, count) } : null };
  return <main style={{ maxWidth: 1100, margin: '25px auto', padding: 24, overflow: 'auto', height: '95vh' }}>
    <h1>过程可见性回归 · 隔离合成数据</h1>
    <nav style={{ display: 'flex', gap: 12, marginBottom: 30 }}>
      <button onClick={() => { setMode('waiting'); setCount(0); }}>等待素材</button>
      <button onClick={() => { setMode('process'); setStep(0); }}>过程开始</button>
      <button onClick={() => setStep(1)}>过程追加</button>
      <button onClick={() => { setMode('streaming'); setCount(0); }}>生成最终答复</button>
      <button onClick={() => setMode('saved')}>保存完成</button>
      <button onClick={() => setMode('search')}>搜索进行中</button>
    </nav>
    {mode === 'streaming' && <article data-final-preview><MarkdownContent content={body.slice(0, count)} /></article>}
    {mode === 'saved' ? <article data-saved-body><h2>语言终审 · 已保存</h2><MarkdownContent content={body} /><p>润色后的这一版你认可吗？</p></article>
      : <ConversationWorking snapshot={snapshot} bridge={bridge} />}
    <h2>运行轨迹</h2>
    <RunTrace records={[record]} activeRunId="demo" liveActivity={activity} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
