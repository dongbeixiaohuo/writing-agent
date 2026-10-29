import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import {
  conversationNavigationCapacity,
  conversationNavigationIndex,
  conversationNavigationMarkers,
  conversationNavigationTarget,
} from './conversation-follow.ts'
import css from './WritingAgentShell.module.css'

interface MessageAnchor {
  readonly id: string
  readonly top: number
  readonly element: HTMLElement
}

/** A compact message index, independent of message length and the native scrollbar. */
export function ConversationNavigator({ scrollRef, conversationKey }: {
  scrollRef: RefObject<HTMLElement | null>
  conversationKey: string
}) {
  const navigationRef = useRef<HTMLElement>(null)
  const [view, setView] = useState<{ messages: readonly MessageAnchor[], active: number, capacity: number }>({
    messages: [], active: -1, capacity: 0,
  })

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (container === null) return
    let messages: readonly MessageAnchor[] = []
    let frame = 0
    let needsMeasurement = false
    let content: Element | null = null

    const update = (): void => {
      const active = conversationNavigationIndex(container, messages.map(message => message.top))
      const capacity = conversationNavigationCapacity(container.clientHeight)
      setView(previous => previous.messages === messages && previous.active === active && previous.capacity === capacity
        ? previous : { messages, active, capacity })
    }
    const measure = (): void => {
      const base = container.getBoundingClientRect().top
      messages = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'), element => ({
        id: element.dataset.messageId!,
        top: element.getBoundingClientRect().top - base + container.scrollTop,
        element,
      }))
      const nextContent = container.querySelector('[data-conversation-timeline]')
      if (nextContent !== content) {
        if (content !== null) resizeObserver.unobserve(content)
        content = nextContent
        if (content !== null) resizeObserver.observe(content)
      }
      update()
    }
    const schedule = (remeasure: boolean): void => {
      needsMeasurement ||= remeasure
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (needsMeasurement) { needsMeasurement = false; measure() }
        else update()
      })
    }
    const resizeObserver = new ResizeObserver(() => schedule(true))
    // Observe content as well as the viewport: streaming and image loads can grow
    // messages without resizing the scroll container or changing message count.
    const mutationObserver = new MutationObserver(() => schedule(true))
    const onScroll = (): void => schedule(false)
    resizeObserver.observe(container)
    mutationObserver.observe(container, { childList: true, characterData: true, subtree: true })
    container.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver.disconnect()
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollRef, conversationKey])

  const jump = (index: number): void => {
    const container = scrollRef.current
    const message = view.messages[index]
    if (container === null || message === undefined || !container.contains(message.element)) return
    const top = message.element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    // Do not let smooth animation race the live reply's auto-follow behavior.
    const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches || container.querySelector('[aria-busy="true"]') !== null
    container.scrollTo({ top: conversationNavigationTarget(container, top), behavior: instant ? 'auto' : 'smooth' })
    navigationRef.current?.focus({ preventScroll: true })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || view.active < 0) return
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? view.messages.length - 1
      : event.key === 'ArrowUp' ? Math.max(0, view.active - 1)
      : event.key === 'ArrowDown' ? Math.min(view.messages.length - 1, view.active + 1) : null
    if (index === null) return
    event.preventDefault()
    jump(index)
  }

  const markers = conversationNavigationMarkers(view.messages.length, view.active, view.capacity)
  if (markers.length === 0) return null
  return <nav ref={navigationRef} className={css.conversationNavigator} tabIndex={0}
    aria-label="对话位置快速定位" aria-description="使用上下方向键切换消息，Home 到开头，End 到末尾。" onKeyDown={onKeyDown}>
    {markers.map(index => <button key={view.messages[index]!.id} type="button" tabIndex={-1}
      className={css.conversationNavigationMarker} aria-current={index === view.active ? 'location' : undefined}
      aria-label={`跳转到第 ${index + 1} 条消息，共 ${view.messages.length} 条`} onClick={() => jump(index)}>
      <span aria-hidden="true" />
    </button>)}
  </nav>
}
