import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunTrace } from '../../packages/ui/src/shell/RunTrace.tsx';
import type { RunRecordView, RunTraceDetail } from '../../packages/client-bridge/src/protocol.ts';
import '../../packages/ui/src/theme/global.css';
import '../../packages/ui/src/shell/RunTrace.css';

const baseTime = Date.parse('2026-10-03T02:00:00Z');
function App() {
  const [finished, setFinished] = useState(false);
  const completed = useRef(false);
  const [loads, setLoads] = useState(0);
  const [text, setText] = useState('');
  const [extra, setExtra] = useState(0);
  const failed = useRef(false);
  const loadDetail = useCallback(async (runId: string, stepId: string): Promise<RunTraceDetail> => {
    setLoads(value => value + 1);
    const index = Number(stepId.split('-')[1]);
    await new Promise(resolve => setTimeout(resolve, index === 70 ? 1200 : 25));
    if (index === 72 && !failed.current) { failed.current = true; throw new Error('本地记录读取暂时失败（合成故障）'); }
    const result: RunTraceDetail = { runId, stepId, requestId: `request-${index}`, callId: index === 71 ? 'search-call' : null,
      provider: 'fixture-only', model: 'synthetic', sections: [], notes: ['隔离合成数据，不访问模型和真实用户工作区。'] };
    if (index === 73) return { ...result, notes: ['该历史步骤未记录原始输入与结果。'] };
    return { ...result, sections: [
      { id: 'input', label: index === 71 ? '实际工具参数' : '实际发送的消息与参数', format: 'json',
        text: JSON.stringify(index === 71 ? { query: '2026 假期安排', provider: 'parallel' } : { messages: [{ role: 'user', content: '核对假期，不修改正文' }] }, null, 2), totalCharacters: 88, truncated: false },
      { id: 'output', label: '持久化结果', format: 'text', text: index === 71 ? '# 搜索回执\n\n找到 2 条来源，供后续核对；并不等于核查通过。'
        : index === 79 ? completed.current ? '当前请求已保存完整回复。' : '当前请求还没有完成结果。' : `步骤 ${index} 的实际模型回复。`, totalCharacters: 40, truncated: false },
      { id: 'schema', label: '当次工具定义', format: 'json', text: '{"name":"search_fact_sources","inputSchema":{"type":"object"}}', totalCharacters: 70, truncated: false },
    ] };
  }, []);
  const records = useMemo<RunRecordView[]>(() => [{ id: 'run', displayInstruction: '核对假期天数，保留正文', status: finished ? 'completed' : 'running',
    startedAt: new Date(baseTime).toISOString(), completedAt: finished ? new Date(baseTime + 300000).toISOString() : null, stopReason: null,
    modelRequests: 40, maxModelRequests: 50, toolCalls: 40, maxToolCalls: 50, totalTokens: 15670, stages: [], completedStages: 0, totalStages: 1, publicationReady: false,
    diagnostics: { segments: [{ id: 'segment', label: '执行段 1', startedAt: new Date(baseTime).toISOString(), modelRequests: [], toolGroups: [], decisions: [] }],
      trace: Array.from({ length: 80 + extra }, (_, i) => ({ id: `step-${i}`, segmentId: 'segment', kind: i === 71 ? 'tool' : 'model',
        label: i === 71 ? '搜索事实来源' : i === 72 ? '失败读取样例' : i === 73 ? '缺失历史样例' : `模型回复 ${i}`,
        actorLabel: '事实核查专家', ...(i === 71 ? { technicalName: 'search_fact_sources' } : { requestId: `request-${i}` }),
        status: i === 79 && !finished ? 'pending' : 'completed', occurredAt: new Date(baseTime + i * 3000).toISOString(),
        completedAt: i === 79 && !finished ? null : new Date(baseTime + i * 3000 + 2300).toISOString(), durationMs: 2300,
        inputPreview: i === 71 ? '查询：2026 假期安排' : `核对材料 ${i}`, outputPreview: i === 71 ? '搜索回执：2 条来源，尚未核实' : `步骤 ${i} 的输出节选`, errorCode: null,
        stream: { headersMs: 800, firstContentMs: 900, lastContentMs: 2000, contentEvents: 40 } })) } }], [finished, extra]);
  return <main style={{ padding: 24, maxWidth: 1400, margin: 'auto' }}>
    <h1>运行轨迹详情 · 隔离回归</h1>
    <p>请求次数：<output aria-label="详情读取次数">{loads}</output></p>
    <button onClick={() => { completed.current = true; setFinished(true); }}>完成当前请求</button>
    <button onClick={() => setExtra(count => count + 1)}>新增执行步骤</button>
    <RunTrace records={records} activeRunId={finished ? null : 'run'} loadDetail={loadDetail} now={baseTime + 300000} />
    <label>主对话输入测试<textarea value={text} onChange={event => setText(event.target.value)} /></label>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
