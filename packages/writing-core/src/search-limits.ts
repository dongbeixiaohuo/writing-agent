export const DEFAULT_SEARCH_LIMIT = 10;
export const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 30;

export const SEARCH_LIMIT_KEYS = ['researchSearchLimit', 'supplementSearchLimit', 'searchLimit'] as const;
export type SearchLimits = Readonly<Partial<Record<typeof SEARCH_LIMIT_KEYS[number], number>>>;

export function isSearchLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= MIN_SEARCH_LIMIT && value <= MAX_SEARCH_LIMIT;
}
