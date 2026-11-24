export const SEARCH_PROVIDERS = ['parallel', 'keenable', 'deepseek', 'tavily'] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];

const PROVIDER_NAMES: Record<SearchProvider, string> = {
  parallel: 'Parallel', keenable: 'Keenable', deepseek: 'DeepSeek', tavily: 'Tavily',
};

export type SearchProviderFlags = {
  readonly parallelEnabled: boolean;
  readonly keenableEnabled?: boolean;
  readonly deepseekEnabled?: boolean;
  readonly tavilyEnabled: boolean;
};

export function isSearchProvider(value: unknown): value is SearchProvider {
  return SEARCH_PROVIDERS.some(provider => provider === value);
}

export function searchProviderName(provider: SearchProvider): string {
  return PROVIDER_NAMES[provider];
}

export function enabledSearchProviders(settings: SearchProviderFlags): SearchProvider[] {
  return SEARCH_PROVIDERS.filter(provider => settings[`${provider}Enabled`]);
}
