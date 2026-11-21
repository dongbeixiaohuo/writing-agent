import { useEffect, useRef, useState } from 'react'
import type { BridgeCommandOptions, BridgeSnapshot, ClientBridge } from '../../../client-bridge/src/protocol.js'
import { clearNewProjectDraftIfMatches, draftKey, readDraft, saveDraft } from './draft-storage.js'

interface PendingCreation {
  operationId: string
  text: string
  styleSelection?: BridgeCommandOptions['styleSelection']
}

// Chromium can lose a just-written draft when the desktop process is killed.
// Commit the receipt with strict durability *before* the host can start a paid request.
type ReceiptAction = { reserve: PendingCreation } | { remove: string | undefined }
async function receipt(workspace: string, action?: ReceiptAction): Promise<PendingCreation | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('writing-agent-creation-receipts', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('pending')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
    open.onblocked = () => reject(Error('CREATE_RECEIPT_BLOCKED'))
  })
  try {
    return await new Promise<PendingCreation | null>((resolve, reject) => {
      const tx = db.transaction('pending', action ? 'readwrite' : 'readonly', { durability: 'strict' })
      const store = tx.objectStore('pending')
      const get = store.get(workspace)
      let previous: PendingCreation | null = null
      let reason: string | undefined
      get.onsuccess = () => {
        previous = get.result ?? null
        if (action && 'remove' in action && action.remove === undefined) { store.delete(workspace); return }
        if (previous && (typeof previous.operationId !== 'string' || !previous.operationId || typeof previous.text !== 'string')) {
          reason = 'CREATE_RECEIPT_UNREADABLE'
          tx.abort()
        } else if (action && 'reserve' in action && !previous) store.add(action.reserve, workspace)
        else if (action && 'remove' in action && previous) {
          if (previous.operationId === action.remove) store.delete(workspace)
          else { reason = 'CREATE_RECEIPT_CHANGED'; tx.abort() }
        }
      }
      tx.oncomplete = () => resolve(previous)
      tx.onabort = () => reject(Error(reason ?? tx.error?.message ?? 'CREATE_RECEIPT_UNAVAILABLE'))
    })
  } finally { db.close() }
}

export function useConversationCreation(bridge: ClientBridge, snapshot: BridgeSnapshot) {
  const [pending, setPending] = useState<PendingCreation | null>(null)
  const [notice, setNotice] = useState('')
  const [checking, setChecking] = useState(false)
  const opened = useRef('')
  const busy = useRef(false)
  const workspace = snapshot.workspaceId
  const ready = Boolean(workspace && snapshot.mode === 'application' && snapshot.connection !== 'offline')
  useEffect(() => {
    if (!ready) return
    let active = true
    void receipt(workspace).then(record => { if (active && !busy.current) setPending(record) })
      .catch(() => { if (active) setNotice('上次新建的回执记录无法读取。请先核对侧栏项目，再决定是否另起一篇。') })
    return () => { active = false }
  }, [workspace, ready])

  const project = pending ? snapshot.projects.find(p => p.id === 'project:' + pending.operationId) : undefined
  useEffect(() => {
    if (!pending || !project || busy.current || !ready) return
    const identity = workspace + '/' + pending.operationId
    if (opened.current === identity) return
    opened.current = identity
    const first = project.initialConversation
    if (first) {
      const error = clearNewProjectDraftIfMatches(workspace, pending.text)
      if (error) setNotice(error)
    } else if (!project.readIssue) {
      const target = draftKey('composer', workspace, project.id, '')
      const previous = readDraft(target, '')
      const error = previous.error ?? (!previous.value ? saveDraft(target, pending.text) : null)
      if (error) setNotice(error)
    }
    const selection = first ? bridge.selectSession(project.id, first.sessionId) : bridge.selectProject(project.id)
    void selection.catch(() => setNotice('项目已落库，自动打开未完成，可在侧栏选择该项目。'))
  }, [bridge, workspace, ready, pending, project])

  async function forget(operationId?: string) {
    await receipt(workspace, { remove: operationId })
    setPending(null)
    opened.current = ''
  }

  async function send(record: PendingCreation) {
    busy.current = true
    try {
      const result = await bridge.startConversation(record.text, { operationId: record.operationId,
        ...(record.styleSelection !== undefined ? { styleSelection: record.styleSelection } : {}) })
      await forget(record.operationId)
      return result
    } catch (error) {
      setPending(record)
      void bridge.refresh().catch(() => setNotice('暂时无法核对新建结果。连接恢复后可以再次核对。'))
      throw error
    } finally { busy.current = false }
  }

  async function start(text: string, options?: BridgeCommandOptions) {
    if (snapshot.mode !== 'application') return bridge.startConversation(text, options)
    if (!ready || busy.current) throw Error('PROJECT_CREATE_CHECK_PENDING')
    const record: PendingCreation = { operationId: crypto.randomUUID(), text,
      ...(options?.styleSelection !== undefined ? { styleSelection: options.styleSelection } : {}) }
    try {
      const previous = await receipt(workspace, { reserve: record })
      if (previous) { setPending(previous); throw Error('PROJECT_CREATE_CHECK_PENDING') }
    } catch (error) {
      if (error instanceof Error && error.message === 'PROJECT_CREATE_CHECK_PENDING') throw error
      setNotice('新建回执无法保存。请先核对已有项目并检查本机存储。')
      throw Error('PROJECT_CREATE_RECEIPT_UNAVAILABLE')
    }
    return send(record)
  }

  async function recheck(resubmit: boolean) {
    if (!pending || busy.current || checking) return
    setChecking(true)
    try {
      await bridge.refresh()
      const current = bridge.getSnapshot()
      if (current.connection === 'offline' || current.lastError) throw Error('offline')
      if (current.projects.some(p => p.id === 'project:' + pending.operationId)) {
        opened.current = ''
        setPending({ ...pending })
      } else if (resubmit) {
        const record = await receipt(workspace)
        if (!record || record.operationId !== pending.operationId) throw Error('changed')
        await send(record)
        const error = clearNewProjectDraftIfMatches(workspace, record.text)
        setNotice(error ?? '已按原编号提交新建。')
      }
    } catch { setNotice('本次核对或提交未完成。已保留原编号，可重新核对。') }
    finally { setChecking(false) }
  }

  async function acknowledge() {
    try { await forget(pending?.operationId); setNotice(''); return true }
    catch { setNotice('回执记录未能清除，请检查本机存储后重试。'); return false }
  }

  async function canOpenNew() {
    if (snapshot.mode !== 'application') return true
    if (!ready || busy.current) return false
    try {
      const record = await receipt(workspace)
      if (!record) return true
      opened.current = ''
      setPending(record)
    } catch { setNotice('上次新建的回执无法核对，请检查本机存储后重试。') }
    return false
  }

  return { start, pending, project, notice, checking, recheck, acknowledge, canOpenNew }
}
