import { Fragment, memo, type ReactNode } from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkCjkFriendly from 'remark-cjk-friendly'
import type { PhrasingContent } from 'mdast'

import css from './WritingAgentShell.module.css'

// Keep marked's GFM tables/lists. Only its unparsed CJK emphasis text needs the
// same CJK-aware grammar used by publication export; never rewrite saved bytes.
const cjkParser = unified().use(remarkParse).use(remarkCjkFriendly)
function cjkInline(raw: string, key: string): ReactNode[] | null {
  if (!/[\u3000-\u9fff]/u.test(raw) || !/[*_]/u.test(raw)) return null
  const root = cjkParser.parse(raw)
  const paragraph = root.children.length === 1 ? root.children[0] : undefined
  if (paragraph?.type !== 'paragraph' || !paragraph.children.some(n => n.type === 'strong' || n.type === 'emphasis')) return null
  const render = (nodes: readonly PhrasingContent[], prefix: string): ReactNode[] => nodes.map((node, i) => {
    const id = `${prefix}:${i}`
    if (node.type === 'strong') return <strong key={id}>{render(node.children, id)}</strong>
    if (node.type === 'emphasis') return <em key={id}>{render(node.children, id)}</em>
    if (node.type === 'inlineCode') return <code key={id}>{node.value}</code>
    if (node.type === 'break') return <br key={id} />
    if (node.type === 'link') {
      const href = safeHref(node.url)
      return href ? <a key={id} href={href} target="_blank" rel="noreferrer">{render(node.children, id)}</a>
        : <Fragment key={id}>{render(node.children, id)}</Fragment>
    }
    if ('value' in node) return <Fragment key={id}>{node.value}</Fragment>
    if ('children' in node) return <Fragment key={id}>{render(node.children, id)}</Fragment>
    return <Fragment key={id}>{raw.slice(node.position?.start.offset, node.position?.end.offset)}</Fragment>
  })
  return render(paragraph.children, key)
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

function inlineTokens(tokens: readonly Token[] | undefined, keyPrefix: string): ReactNode[] {
  if (tokens === undefined) return []
  return tokens.map((token, index) => {
    const key = `${keyPrefix}:${String(index)}`
    if (token.type === 'strong') return <strong key={key}>{inlineTokens(token.tokens, key)}</strong>
    if (token.type === 'em') return <em key={key}>{inlineTokens(token.tokens, key)}</em>
    if (token.type === 'del') return <del key={key}>{inlineTokens(token.tokens, key)}</del>
    if (token.type === 'codespan') return <code key={key}>{token.text}</code>
    if (token.type === 'br') return <br key={key} />
    if (token.type === 'link') {
      const href = safeHref(token.href)
      const content = inlineTokens(token.tokens, key)
      return href === null
        ? <Fragment key={key}>{content}</Fragment>
        : <a key={key} href={href} target="_blank" rel="noreferrer">{content}</a>
    }
    if (token.type === 'image') {
      const href = safeHref(token.href)
      return href === null
        ? <span key={key}>图片：{token.text}</span>
        : <a key={key} href={href} target="_blank" rel="noreferrer">图片：{token.text}</a>
    }
    if (token.type === 'html' || token.type === 'tag') return <Fragment key={key}>{token.text}</Fragment>
    if (token.type === 'escape' || token.type === 'text') {
      const nested = 'tokens' in token ? inlineTokens(token.tokens, key) : []
      return <Fragment key={key}>{nested.length > 0 ? nested : token.type === 'text' ? cjkInline(token.raw, key) ?? token.text : token.text}</Fragment>
    }
    return <Fragment key={key}>{'text' in token ? String(token.text) : token.raw}</Fragment>
  })
}

function tableCell(cell: Tokens.TableCell, key: string): ReactNode {
  return cell.header
    ? <th key={key}>{inlineTokens(cell.tokens, key)}</th>
    : <td key={key}>{inlineTokens(cell.tokens, key)}</td>
}

function blockTokens(tokens: readonly Token[], keyPrefix: string): ReactNode[] {
  return tokens.flatMap((token, index): ReactNode[] => {
    const key = `${keyPrefix}:${String(index)}`
    if (token.type === 'space' || token.type === 'def') return []
    if (token.type === 'heading') {
      const content = inlineTokens(token.tokens, key)
      if (token.depth === 1) return [<h1 key={key}>{content}</h1>]
      if (token.depth === 2) return [<h2 key={key}>{content}</h2>]
      return [<h3 key={key}>{content}</h3>]
    }
    if (token.type === 'paragraph') return [<p key={key}>{inlineTokens(token.tokens, key)}</p>]
    if (token.type === 'text') {
      const content = 'tokens' in token && token.tokens !== undefined
        ? inlineTokens(token.tokens, key)
        : token.text
      return [<p key={key}>{content}</p>]
    }
    if (token.type === 'list') {
      const list = token as Tokens.List
      const items = list.items.map((item: Tokens.ListItem, itemIndex: number) => (
        <li key={`${key}:item:${String(itemIndex)}`}>
          {blockTokens(item.tokens, `${key}:item:${String(itemIndex)}`)}
        </li>
      ))
      return list.ordered
        ? [<ol key={key} start={typeof list.start === 'number' ? list.start : undefined}>{items}</ol>]
        : [<ul key={key}>{items}</ul>]
    }
    if (token.type === 'blockquote') return [<blockquote key={key}>{blockTokens((token as Tokens.Blockquote).tokens, key)}</blockquote>]
    if (token.type === 'code') return [<pre key={key}><code>{token.text}</code></pre>]
    if (token.type === 'hr') return [<hr key={key} />]
    if (token.type === 'table') return [
      <div className={css.markdownTableWrap} key={key}>
        <table>
          <thead><tr>{(token as Tokens.Table).header.map((cell: Tokens.TableCell, cellIndex: number) => tableCell(cell, `${key}:head:${String(cellIndex)}`))}</tr></thead>
          <tbody>{(token as Tokens.Table).rows.map((row: Tokens.TableCell[], rowIndex: number) => <tr key={`${key}:row:${String(rowIndex)}`}>{row.map((cell: Tokens.TableCell, cellIndex: number) => tableCell(cell, `${key}:row:${String(rowIndex)}:${String(cellIndex)}`))}</tr>)}</tbody>
        </table>
      </div>,
    ]
    if (token.type === 'html') return [<p key={key}>{token.text}</p>]
    return [<p key={key}>{'text' in token ? String(token.text) : token.raw}</p>]
  })
}

// Live snapshots change frequently. Already-saved messages have immutable text;
// do not reparse the entire conversation on every stream fragment or status tick.
export const MarkdownContent = memo(function MarkdownContent({ content, className }: { content: string; className?: string | undefined }) {
  let tokens: readonly Token[]
  try {
    tokens = marked.lexer(content, { gfm: true, breaks: true })
  } catch {
    return <div className={className ?? css.markdownContent}><p>{content}</p></div>
  }
  return <div className={className === undefined ? css.markdownContent : `${css.markdownContent} ${className}`}>
    {blockTokens(tokens, 'markdown')}
  </div>
})
