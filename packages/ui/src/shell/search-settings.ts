import type { SearchSettingsInput, SearchSettingsView } from '../../../client-bridge/src/desktop-bridge.ts'

export function searchSettingsValidation(
  settings: Pick<SearchSettingsView, 'tavilyEnabled' | 'tavilyKeyConfigured' | 'searchLimit'>,
  apiKey: string,
): string | null {
  if (settings.searchLimit !== undefined && (!Number.isSafeInteger(settings.searchLimit) || settings.searchLimit < 1 || settings.searchLimit > 30)) {
    return '每轮搜索上限须为 1—30 的整数。';
  }
  if (settings.tavilyEnabled && !settings.tavilyKeyConfigured && apiKey.trim().length === 0) {
    return '启用 Tavily 前需要填写 API Key。'
  }
  return null
}

export function searchSettingsInput(
  settings: Pick<SearchSettingsView, 'parallelEnabled' | 'tavilyEnabled' | 'searchLimit'>,
  apiKey: string,
): SearchSettingsInput {
  const trimmedKey = apiKey.trim()
  return {
    parallelEnabled: settings.parallelEnabled,
    tavilyEnabled: settings.tavilyEnabled,
    ...(settings.searchLimit === undefined ? {} : { searchLimit: settings.searchLimit }),
    ...(trimmedKey.length === 0 ? {} : { tavilyApiKey: trimmedKey }),
  }
}
