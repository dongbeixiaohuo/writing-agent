import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from '../../../runtime/llm/src/index.js'
import { collaborationState } from '../../../application/test/collaboration-fixture.js'
import { collaborationTurn } from './collaboration-turn.js'

export class ImmediateWorkflowProvider extends ModelProviderBase {
  constructor(id = 'workflow-test-provider') {
    super(id, '1.0.0', {
      protocol: 'mock',
      streaming: 'supported',
      tools: 'supported',
      usage: 'unknown',
    })
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    if (collaborationState(request) !== null) {
      const turn = collaborationTurn(request, {
        research: JSON.stringify({ claims: [], notes: '合成测试材料不包含外部事实。' }),
        outline: '# 提纲\n\n1. 背景\n2. 方法\n3. 结论',
        draft: '# 回归草稿\n\n快速项目已成功生成初稿。',
        review_editor: '结构清楚，没有发现材料越权。',
        review_reader: '读者可以理解当前稿件。',
        review_publish: '发布边界明确。',
        central_revision: '# 回归草稿\n\n快速项目已完成集中修订。',
        language_review: '# 回归草稿\n\n快速项目已完成完整工作流。',
      });
      if (turn !== null) yield* turn;
      else { yield { type: 'text_delta', delta: '已保存并通过门禁。' }; yield { type: 'completed', finishReason: 'stop' }; }
      return;
    }
    const toolMessages = request.messages.filter(message => message.role === 'tool')
    const materialRead = toolMessages.some(
      message => message.role === 'tool' && message.name === 'read_material',
    )
    if (!materialRead) {
      const userMessage = request.messages.find(message => message.role === 'user')
      const catalogMatch = userMessage?.role === 'user'
        ? userMessage.content.match(/授权材料目录：(\[[^\n]+\])/u)
        : null
      const catalog = JSON.parse(catalogMatch?.[1] ?? '[]') as Array<{
        id: string
        contentVersionId: string
      }>
      const material = catalog[0]
      if (material !== undefined) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: `read-${request.requestId}`,
          name: 'read_material',
          argumentsDelta: JSON.stringify({
            materialId: material.id,
            contentVersionId: material.contentVersionId,
            offset: 0,
            maxChars: 20_000,
          }),
        }
        yield { type: 'completed', finishReason: 'tool_calls' }
        return
      }
    }

    if (!toolMessages.some(message => message.role === 'tool' && message.name === 'assess_writing_readiness')) {
      yield { type: 'tool_call_delta', index: 0, id: `ready-${request.requestId}`,
        name: 'assess_writing_readiness', argumentsDelta: JSON.stringify({ status: 'ready', reason: '合成材料足以支撑本测试文章。', questions: [] }) }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }
    const submittedStages = toolMessages
      .filter(message => message.role === 'tool' && message.name === 'submit_writing_stage')
      .map(message => {
        if (message.role !== 'tool') return ''
        const result = JSON.parse(message.content) as { result?: { stage?: string } }
        return result.result?.stage ?? ''
      })
    const stages = [
      ['research', JSON.stringify({ claims: [], notes: '合成测试材料不包含外部事实。' })],
      ['outline', '# 提纲\n\n1. 背景\n2. 方法\n3. 结论'],
      ['draft', '# 回归草稿\n\n快速项目已成功生成初稿。'],
      ['review_editor', '结构清楚，没有发现材料越权。'],
      ['review_reader', '读者可以理解当前稿件。'],
      ['central_revision', '# 回归草稿\n\n快速项目已完成集中修订。'],
      ['language_review', '# 回归草稿\n\n快速项目已完成完整工作流。'],
    ] as const
    const next = stages[submittedStages.length]
    if (next !== undefined) {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: `stage-${next[0]}-${request.requestId}`,
        name: 'submit_writing_stage',
        argumentsDelta: JSON.stringify({ stage: next[0], content: next[1] }),
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }

    const factSubmitted = toolMessages.some(
      message => message.role === 'tool' && message.name === 'submit_fact_check',
    )
    if (!factSubmitted) {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: `fact-${request.requestId}`,
        name: 'submit_fact_check',
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: '合成测试正文没有需要外部核实的事实主张。',
        }),
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }

    yield { type: 'text_delta', delta: '完整写作工作流已经保存。' }
    yield { type: 'completed', finishReason: 'stop' }
  }
}
