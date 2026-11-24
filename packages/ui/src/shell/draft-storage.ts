const unsavedDrafts = new Map<string, unknown>()
const SAVE_FAILURE = '草稿保存失败，文字暂存在当前页面；请复制备份后再刷新或退出。'
/** Browser-local drafts never become published body versions. Writes are synchronous before navigation. */
export function draftKey(kind: string, ...owner: string[]): string {
  return `writing-agent:draft:v1:${kind}:${JSON.stringify(owner)}`
}
export function readDraft<T>(key: string, fallback: T): { value: T; error: string | null } {
  if (unsavedDrafts.has(key)) return { value: unsavedDrafts.get(key) as T, error: SAVE_FAILURE }
  try {
    const raw = localStorage.getItem(key)
    return { value: raw === null ? fallback : JSON.parse(raw) as T, error: null }
  } catch { return { value: fallback, error: '草稿恢复失败，请勿关闭页面。' } }
}
export function saveDraft(key: string, value: unknown): string | null {
  try { localStorage.setItem(key, JSON.stringify(value)); unsavedDrafts.delete(key); return null }
  catch { unsavedDrafts.set(key, value); return SAVE_FAILURE }
}

export function clearNewProjectDraftIfMatches(workspaceId: string, submittedText: string): string | null {
  const key = draftKey('new', workspaceId)
  const saved = readDraft(key, '')
  return saved.value === submittedText ? saveDraft(key, '') : saved.error
}

/** Delete only drafts belonging to a successfully deleted project. */
export function removeProjectDrafts(workspaceId: string, projectId: string): string | null {
  try {
    const keys = new Set([...unsavedDrafts.keys(), ...Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))])
    for (const key of keys) {
      if (!key) continue
      const prefix = ['composer', 'paragraphs'].map(kind => `writing-agent:draft:v1:${kind}:`).find(value => key.startsWith(value))
      if (!prefix) continue
      const owner = JSON.parse(key.slice(prefix.length))
      if (Array.isArray(owner) && owner[0] === workspaceId && owner[1] === projectId) { unsavedDrafts.delete(key); localStorage.removeItem(key) }
    }
    return null
  } catch { return '会话已删除，但本机的未发送草稿未能清理。' }
}
