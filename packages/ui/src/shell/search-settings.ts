import type { SearchSettingsInput, SearchSettingsView } from '../../../client-bridge/src/desktop-bridge.ts'
import { MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT, SEARCH_LIMIT_KEYS, isSearchLimit, type SearchLimits } from '../../../writing-core/src/search-limits.ts'
import { enabledSearchProviders, searchProviderName, type SearchProviderFlags } from '../../../writing-core/src/search-providers.ts'

export function searchSettingsValidation(
  settings: Pick<SearchSettingsView, 'tavilyEnabled' | 'tavilyKeyConfigured' | 'deepseekEnabled' | 'deepseekKeyConfigured'> & SearchLimits,
  apiKey: string,
  deepseekApiKey = '',
): string | null {
  if (SEARCH_LIMIT_KEYS.some(key => settings[key] !== undefined && !isSearchLimit(settings[key]!))) {
    return `各阶段查询批次参考须为 ${MIN_SEARCH_LIMIT}—${MAX_SEARCH_LIMIT} 的整数。`;
  }
  if (settings.tavilyEnabled && !settings.tavilyKeyConfigured && apiKey.trim().length === 0) {
    return '启用 Tavily 前需要填写 API Key。'
  }
  if (settings.deepseekEnabled && !settings.deepseekKeyConfigured && !deepseekApiKey.trim()) {
    return '启用 DeepSeek 搜索前需要填写独立的 API Key。';
  }
  return null
}

export function searchSettingsInput(
  settings: SearchProviderFlags & SearchLimits,
  apiKey: string,
  deepseekApiKey = '',
): SearchSettingsInput {
  const trimmedKey = apiKey.trim()
  return {
    parallelEnabled: settings.parallelEnabled,
    ...(settings.keenableEnabled === undefined ? {} : { keenableEnabled: settings.keenableEnabled }),
    tavilyEnabled: settings.tavilyEnabled,
    ...(settings.deepseekEnabled === undefined ? {} : { deepseekEnabled: settings.deepseekEnabled }),
    ...(deepseekApiKey.trim() ? { deepseekApiKey: deepseekApiKey.trim() } : {}),
    ...Object.fromEntries(SEARCH_LIMIT_KEYS.flatMap(key => settings[key] === undefined ? [] : [[key, settings[key]]])),
    ...(trimmedKey.length === 0 ? {} : { tavilyApiKey: trimmedKey }),
  }
}

export function searchSettingsRoute(settings: SearchProviderFlags): string[] {
  return enabledSearchProviders(settings).map(searchProviderName);
}
