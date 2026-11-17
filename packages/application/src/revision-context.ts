import type { ModelMessage } from '../../runtime/llm/src/index.js';
import type { BoundReviewFinding } from './review-closure.js';
import { bodyArticleBaseline } from './workflow-tools.js';

/** Only author-cited passages cross into a structural rewrite as old prose.
 * A citation can be a rejection: keep the author's words with it, not a made-up
 * instruction to preserve it. Full drafts remain bound to the independent audit. */
export function redevelopmentReference(body: string, authorReplies: readonly string[]) {
  const article = bodyArticleBaseline(body);
  return {
    requiredTitle: article.split(/\r?\n/u).find(line => /^#\s/u.test(line)) ?? null,
    authorCitations: authorReplies.flatMap(authorInstruction => {
      const quotes = [...authorInstruction.matchAll(/[“「"]([^”」"\n]{6,})[”」"]/gu)]
        .map(match => match[1]!).filter(quote => article.includes(quote));
      return [...new Set(quotes)].map(quote => ({ quote, authorInstruction }));
    }),
  };
}

/** Diagnosed problems stay available; old example prose and reviewer answers
 * do not become a draft template. The audit still receives the full findings. */
export function redevelopmentProblems(findings: readonly BoundReviewFinding[]) {
  return findings.filter(f => f.severity === 'required').map(({ id, kind, issue, repairTarget, evidenceIds }) =>
    ({ id, kind, issue, repairTarget, evidenceIds }));
}

/** A resumed scope may contain tool results from the former projection. Remove
 * both halves of those calls, while preserving legitimate source reads. */
export function redevelopmentHistory(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const blocked = new Set(['read_artifact_version', 'read_review_discussion']);
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === 'tool' && blocked.has(message.name)) return [];
    if (message.role !== 'assistant' || !message.toolCalls?.some(call => blocked.has(call.name))) return [message];
    const toolCalls = message.toolCalls.filter(call => !blocked.has(call.name));
    return toolCalls.length ? [{ ...message, content: '', toolCalls }] : [];
  });
}
