import type { NormalizedProviderConfig } from '../../../packages/runtime/provider-config/src/index.js';

/** Small style tasks need a final answer, not the vendor's implicit max-effort
 * reasoning. This request-local default never changes saved model settings.
 * Explicit provider effort is preserved. MiniMax docs: /docs/guides/text-generation. */
export function styleProviderConfig(config: NormalizedProviderConfig): NormalizedProviderConfig {
  if (!/(?:^|\/)MiniMax-M3\.1-Flash(?:-Preview)?$/iu.test(config.model)) return config;
  const extra = config.extraBody ?? {};
  if (config.kind === 'openai_compatible') return { ...config, extraBody: { reasoning_effort: 'low', ...extra } };
  const field = config.kind === 'openai_responses' ? 'reasoning' : 'output_config';
  const existing = typeof extra[field] === 'object' && extra[field] !== null && !Array.isArray(extra[field]) ? extra[field] as Record<string, unknown> : {};
  return { ...config, extraBody: { ...extra, [field]: { effort: 'low', ...existing } } };
}
