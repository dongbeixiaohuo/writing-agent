import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Chinese punctuation emphasis renders without changing code, escapes or HTML safety', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-cjk-'));
  try {
    const file = join(root, 'render.cjs');
    buildSync({ stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import {MarkdownContent} from './packages/ui/src/shell/MarkdownContent.tsx';
      export const render=(content)=>renderToStaticMarkup(React.createElement(MarkdownContent,{content}));`,
      resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: file,
      jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
    const { render } = createRequire(import.meta.url)(file);
    assert.match(render('**第一步，追逐一个你和它绑在一起的问题。**据他在访谈中的描述。'), /<strong>第一步，追逐一个你和它绑在一起的问题。<\/strong>据他/);
    assert.match(render('他说*“先找到问题。”*然后动手。'), /<em>“先找到问题。”<\/em>/);
    assert.match(render('**“重点。”**后续，**正常**粗体。'), /<strong>“重点。”<\/strong>/);
    assert.match(render('`**第一步。**`'), /<code>\*\*第一步。\*\*<\/code>/);
    assert.doesNotMatch(render('\\*\\*第一步。\\*\\*不是加粗'), /<strong>/);
    const unsafe = render('**第一步。**<script>alert(1)</script>[跳转](javascript:alert)');
    assert.doesNotMatch(unsafe, /<script>|href="javascript:/);
    assert.match(render('```markdown\n**第一步。**据他\n```'), /<pre><code>\*\*第一步。\*\*据他/);
    assert.match(render('| 标题 | 内容 |\n| --- | --- |\n| **第一步。**据他 | 好 |'), /<strong>第一步。<\/strong>据他/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
