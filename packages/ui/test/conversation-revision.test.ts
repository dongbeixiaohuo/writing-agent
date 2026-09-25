import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('shows model-generated paragraph changes and acceptance in the main conversation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-revision-card-'));
  try {
    const output = join(directory, 'render.cjs');
    buildSync({ stdin: { contents: `
      import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
      import { ConversationRevisionCard } from './packages/ui/src/shell/ConversationRevisionCard.tsx';
      export function render(body='b1') { return renderToStaticMarkup(React.createElement(ConversationRevisionCard, {
        bridge:{}, onContentChange:()=>{}, snapshot:{ mode:'application', connection:'ready', activeRunId:null,
          revisionWorkspace:{bodyVersionId:body,proposals:[{id:'proposal',status:'proposed',baseBodyVersionId:'b1',instruction:'缩短第二段',
            diff:[{type:'replace',targetBlockId:'paragraph',before:'原段落',after:'新段落'}]}]} }
      })); }
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: output,
      jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
    const { render } = createRequire(import.meta.url)(output);
    const html = render();
    assert.match(html, /原段落/u); assert.match(html, /新段落/u);
    assert.match(html, /接受这次修改/u); assert.match(html, /保留原稿/u);
    assert.match(render('new-body'), /稿件已变化/u);
    assert.match(render('new-body'), /<button[^>]*disabled=""[^>]*>接受这次修改/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
