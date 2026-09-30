// Exercise the actual shared renderer: unchanged history must not be reparsed
// for every live fragment. No application data, IPC or model calls.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { marked } from 'marked';
import { MarkdownContent } from '../../packages/ui/src/shell/MarkdownContent';
let historyParses = 0; let liveParses = 0;
const lexer = marked.lexer;
marked.lexer = ((text: string, options: any) => {
  if (text.startsWith('# 历史')) historyParses++;
  else liveParses++;
  return lexer(text, options);
}) as typeof marked.lexer;
const history = Array.from({length: 80}, (_, i) => `# 历史 ${i}\n\n${'这是一段已保存的专家建议，不应随着每个新片段反复解析。\n\n'.repeat(40)}`);
const root = createRoot(document.getElementById('root')!);
function render(fragment: number) {
  flushSync(() => root.render(<>{history.map((text, i) => <MarkdownContent key={i} content={text}/>)}<MarkdownContent content={`# 新回复\n\n${'正在输出'.repeat(fragment)}`}/></>));
}
render(1); const initial = historyParses;
const start = performance.now();
for (let i = 2; i <= 31; i++) render(i);
(window as any).result = {initial, repeatedHistoryParses: historyParses - initial, liveParses, durationMs: performance.now() - start};
