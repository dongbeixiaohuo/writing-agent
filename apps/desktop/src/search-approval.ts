import type { MessageBoxOptions } from 'electron';
import type { FactSearchConfiguration } from '../../../packages/application/src/fact-search.js';

export function searchApprovalOptions(request: Parameters<NonNullable<FactSearchConfiguration['authorizeQuery']>>[0]): MessageBoxOptions {
  const route = request.providers.map(provider => provider === 'parallel' ? 'Parallel' : 'Tavily').join(' → 失败时使用 ');
  return {
    type: 'question', title: '确认外部事实搜索',
    message: '是否把以下检索词发送给搜索服务？',
    detail: `检索词（将原样发送）：\n${request.query}\n\n搜索服务：${route}\n请确认其中不含私人经历、客户机密或其他不希望外发的信息。${request.providers.includes('tavily') ? '使用 Tavily 可能消耗 Tavily 配额。' : ''}\n不发送也可以继续：本轮将仅用已有材料与模型复核，并说明未联网验证的限制。`,
    buttons: ['不发送，使用已有材料', '同意发送并搜索'],
    defaultId: 0, cancelId: 0, noLink: true,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}
