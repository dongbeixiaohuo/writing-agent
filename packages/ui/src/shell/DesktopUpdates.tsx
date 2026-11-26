import { useEffect, useState } from 'react'
import type { DesktopUpdateAction, DesktopUpdateApi, DesktopUpdateState } from '../../../client-bridge/src/desktop-update.ts'
import { hasUnsavedDrafts } from './draft-storage.ts'
import css from './WritingAgentShell.module.css'

export function useDesktopUpdates(api?: DesktopUpdateApi) {
  const [state, setState] = useState<DesktopUpdateState>({ phase: 'disabled' })
  const [actionError, setActionError] = useState('')
  useEffect(() => {
    if (!api) return
    let received = false
    let active = true
    const unsubscribe = api.subscribe(next => {
      received = true
      setState(next)
    })
    void api.request('status').then(next => {
      if (active && !received) setState(next)
    }).catch(() => {
      if (active && !received) setActionError('暂时无法读取软件更新状态。')
    })
    return () => { active = false; unsubscribe() }
  }, [api])

  useEffect(() => {
    if (!api || state.phase !== 'ready') return
    const installWhenSaved = () => {
      if (!hasUnsavedDrafts()) void api.request('install').catch(() => setActionError('暂时无法启动更新，可以在「关于」重试。'))
    }
    installWhenSaved()
    const timer = setInterval(installWhenSaved, 2_000)
    return () => clearInterval(timer)
  }, [api, state.phase])

  function act(action: DesktopUpdateAction) {
    setActionError('')
    if (action === 'install' && hasUnsavedDrafts()) {
      setActionError('有草稿还没保存成功。请先复制备份或重试保存。')
      return
    }
    void api?.request(action).catch(() => setActionError(action === 'open-release' ? '暂时打不开 GitHub 下载页。' : '更新服务暂时不可用，请稍后重试。'))
  }

  return { state, act, actionError }
}

export function DesktopUpdates({ update, about = false }: { update: ReturnType<typeof useDesktopUpdates>; about?: boolean }) {
  const { state, act, actionError } = update
  if (state.phase === 'disabled') return about && actionError ? <p role="status">{actionError}</p> : null
  if (!about && (state.phase === 'idle' || state.phase === 'current' || state.phase === 'checking' ||
    (state.phase === 'available' && state.deferred) ||
    (state.phase === 'error' && state.operation === 'check'))) return null

  const busy = state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'installing'
  const button = (label: string, action: DesktopUpdateAction, primary = false) =>
    <button type="button" className={primary ? css.primaryAction : css.secondaryAction} onClick={() => act(action)}>{label}</button>
  return <section className={about ? css.aboutUpdate : css.updateBanner} aria-label="软件更新">
    <div role="status" aria-live="polite">
      {state.phase === 'idle' && '可检查 GitHub 上是否有桌面新版。'}
      {state.phase === 'current' && '当前已是最新版本。'}
      {state.phase === 'checking' && '正在检查更新…'}
      {state.phase === 'available' && <strong>发现新版本 {state.version}</strong>}
      {state.phase === 'downloading' && <>正在下载 {state.version} <progress max={100} value={state.percent} aria-label="更新下载进度" /> {state.percent}%</>}
      {state.phase === 'ready' && `${state.version} 已下载。等当前任务结束、草稿保存后，将自动安装并重新打开。`}
      {state.phase === 'installing' && `正在安装 ${state.version}，Writing Agent 将重新打开。`}
      {state.phase === 'error' && state.message}
      {actionError && <p>{actionError}</p>}
    </div>
    {state.phase === 'available' && <div className={css.updateActions}>
      {state.installInApp ? button('立即更新', 'download', true) : button('打开 GitHub 下载页', 'open-release', true)}
      {!about && button('稍后', 'defer')}
    </div>}
    {state.phase === 'error' && state.operation !== 'check' && <div className={css.updateActions}>
      {state.operation === 'download' ? button('重试下载', 'download', true) : button('重试安装', 'install', true)}
      {button('打开 GitHub 下载页', 'open-release')}
    </div>}
    {about && !busy && !(state.phase === 'error' && state.operation === 'install') && button('检查更新', 'check')}
  </section>
}
