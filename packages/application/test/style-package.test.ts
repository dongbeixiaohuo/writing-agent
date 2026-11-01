import assert from 'node:assert/strict';
import test from 'node:test';
import { styleStatistics, styleMetrics, styleParagraphs, styleContext, evaluateStylePreview, type StylePackage } from '../../writing-core/src/style-package.js';

test('statistics are calculated per sample, with actual min/max and explicit paragraph rules', () => {
  const samples = [{ id: 'a', title: '甲', text: '我来了。\n\n你呢？' }, { id: 'b', title: '乙', text: '走吧！' }];
  const stats = styleStatistics(samples);
  assert.equal(stats.articles[0]!.metrics.characters, 7);
  assert.equal(stats.articles[0]!.metrics.paragraphs, 2);
  assert.equal(stats.articles[0]!.metrics.sentenceMean, 2.5);
  assert.deepEqual(stats.ranges.characters, { min: 3, max: 7 });
  assert.deepEqual(styleParagraphs('甲\r\n\r\n乙'), [{ id: 'p1', text: '甲' }, { id: 'p2', text: '乙' }]);
  assert.equal(styleMetrics('').sentenceMedian, 0);
});

test('stage style context is bounded, includes examples and excludes facts and simulated readers', () => {
  const pack: StylePackage = { version: 2, statistics: styleStatistics([{ id: 'a', title: '甲', text: '先说一件小事。\n再问一个问题？' }]),
    patterns: [{ kind: 'structure', instruction: '从小事追问原因' }, { kind: 'title', instruction: '短设问' }],
    snippets: [{ sampleId: 'a', paragraphId: 'p1', kind: 'opening', quote: '先说一件小事。' }] };
  const selected = { id: 'a', name: '短句', version: 1, card: '具体。'.repeat(400), package: pack };
  assert.equal(styleContext(selected, 'fact_check'), '');
  assert.equal(styleContext(selected, 'review_reader'), '');
  assert.ok(styleContext(selected, 'draft').includes('先说一件小事。'));
  assert.ok(styleContext(selected, 'draft').length <= 4000);
  assert.ok(!styleContext(selected, 'intake').includes(selected.card));
  assert.match(styleContext(null, 'draft'), /不指定风格/u);
  assert.equal(evaluateStylePreview('另一段内容。', pack).repeatedSnippets.length, 0);
});
