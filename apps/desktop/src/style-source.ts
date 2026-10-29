import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { unzipSync } from 'fflate';
import { load } from 'cheerio';
import { StyleSampleSchema, type StyleSample } from '../../../packages/writing-core/src/style-profile.js';
import { NetworkAccessPolicy, SecureWebFetcher } from '../../../packages/runtime/tools/src/index.js';
import type { AuthorWebFetcher } from '../../../packages/application/src/author-web.js';

const MAX_BYTES = 4 * 1024 * 1024;

export function decodeStyleDocument(fileName: string, bytes: Uint8Array): StyleSample {
  if (bytes.byteLength > MAX_BYTES) throw new Error('STYLE_DOCUMENT_TOO_LARGE');
  const extension = extname(fileName).toLowerCase();
  let text: string;
  if (extension === '.docx') {
    try {
      const entry = unzipSync(bytes, { filter: entry => {
        if (entry.name !== 'word/document.xml') return false;
        if (entry.originalSize > MAX_BYTES) throw new Error('STYLE_DOCUMENT_TOO_LARGE');
        return true;
      } })['word/document.xml'];
      if (!entry || entry.length > MAX_BYTES) throw new Error('STYLE_DOCUMENT_INVALID');
      const $ = load(new TextDecoder('utf-8', { fatal: true }).decode(entry), { xml: true });
      $('w\\:tab').replaceWith(' '); $('w\\:br').replaceWith('\n');
      text = $('w\\:p').map((_, paragraph) => $(paragraph).text()).get().join('\n\n');
    } catch (error) {
      if (error instanceof Error && error.message === 'STYLE_DOCUMENT_TOO_LARGE') throw error;
      throw new Error('STYLE_DOCUMENT_INVALID');
    }
  } else if (['.txt', '.md', '.markdown'].includes(extension)) {
    try {
      const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch { throw new Error('STYLE_DOCUMENT_ENCODING'); }
  } else throw new Error('STYLE_DOCUMENT_TYPE');
  if (text.length > 100_000) throw new Error('STYLE_DOCUMENT_TOO_LARGE');
  if (!text.trim() || text.includes('\0')) throw new Error('STYLE_DOCUMENT_INVALID');
  return StyleSampleSchema.parse({ id: randomUUID(), title: basename(fileName), kind: 'document', sourceReference: basename(fileName), text });
}

/** Only called with a path returned by the native picker, never a renderer path. */
export async function readStyleDocument(path: string): Promise<StyleSample> {
  const file = await open(path, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_BYTES) throw new Error('STYLE_DOCUMENT_TOO_LARGE');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await file.read(buffer, count, buffer.length - count, null);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    return decodeStyleDocument(path, buffer.subarray(0, count));
  } finally { await file.close(); }
}

export async function readStyleUrl(url: string, signal: AbortSignal, fetcher?: AuthorWebFetcher): Promise<StyleSample> {
  // SecureWebFetcher checks public targets, DNS and redirects; never bypass access checks.
  const reader = fetcher ?? new SecureWebFetcher({ policy: new NetworkAccessPolicy({ allowHttp: true }), timeoutMs: 30_000 });
  const page = await reader.fetchText(url, signal).catch(() => { throw new Error(signal.aborted ? 'STYLE_ANALYSIS_CANCELLED' : 'STYLE_SOURCE_FAILED'); });
  if (signal.aborted) throw new Error('STYLE_ANALYSIS_CANCELLED');
  if (page.content.truncated) throw new Error('STYLE_SOURCE_TOO_LARGE');
  return StyleSampleSchema.parse({ id: randomUUID(), title: page.content.title || new URL(page.finalUrl).hostname,
    kind: 'web', sourceReference: page.finalUrl, text: page.content.text });
}
