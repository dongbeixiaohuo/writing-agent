import type { SearchSettingsInput, SearchSettingsView } from '../../../client-bridge/src/desktop-bridge.ts'

export function searchSettingsValidation(
  settings: Pick<SearchSettingsView, 'tavilyEnabled' | 'tavilyKeyConfigured' | 'deepseekEnabled' | 'deepseekKeyConfigured' | 'searchLimit'>,
  apiKey: string,
  deepseekApiKey = '',
): string | null {
  if (settings.searchLimit !== undefined && (!Number.isSafeInteger(settings.searchLimit) || settings.searchLimit < 1 || settings.searchLimit > 30)) {
    return '每轮搜索上限须为 1—30 的整数。';
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
  settings: Pick<SearchSettingsView, 'parallelEnabled' | 'tavilyEnabled' | 'deepseekEnabled' | 'searchLimit'>,
  apiKey: string,
  deepseekApiKey = '',
): SearchSettingsInput {
  const trimmedKey = apiKey.trim()
  return {
    parallelEnabled: settings.parallelEnabled,
    tavilyEnabled: settings.tavilyEnabled,
    ...(settings.deepseekEnabled === undefined ? {} : { deepseekEnabled: settings.deepseekEnabled }),
    ...(deepseekApiKey.trim() ? { deepseekApiKey: deepseekApiKey.trim() } : {}),
    ...(settings.searchLimit === undefined ? {} : { searchLimit: settings.searchLimit }),
    ...(trimmedKey.length === 0 ? {} : { tavilyApiKey: trimmedKey }),
  }
}

export function searchSettingsRoute(settings: Pick<SearchSettingsView, 'deepseekEnabled' | 'parallelEnabled' | 'tavilyEnabled'>): string[] {
  return [settings.deepseekEnabled ? 'DeepSeek' : null, settings.parallelEnabled ? 'Parallel' : null,
    settings.tavilyEnabled ? 'Tavily' : null].filter((name): name is string => name !== null);
}
