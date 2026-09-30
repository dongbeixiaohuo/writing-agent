import type { SearchSettingsInput, SearchSettingsView } from '../../../client-bridge/src/desktop-bridge.ts'

export function searchSettingsValidation(
  settings: Pick<SearchSettingsView, 'tavilyEnabled' | 'tavilyKeyConfigured'>,
  apiKey: string,
): string | null {
  if (settings.tavilyEnabled && !settings.tavilyKeyConfigured && apiKey.trim().length === 0) {
    return '启用 Tavily 前需要填写 API Key。'
  }
  return null
}

export function searchSettingsInput(
  settings: Pick<SearchSettingsView, 'parallelEnabled' | 'tavilyEnabled'>,
  apiKey: string,
): SearchSettingsInput {
  const trimmedKey = apiKey.trim()
  return {
    parallelEnabled: settings.parallelEnabled,
    tavilyEnabled: settings.tavilyEnabled,
    ...(trimmedKey.length === 0 ? {} : { tavilyApiKey: trimmedKey }),
  }
}
