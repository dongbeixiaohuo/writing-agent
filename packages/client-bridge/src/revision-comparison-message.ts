import type { RevisionComparisonView } from '../../application/src/revision-comparison.js';

function quote(text: string): string {
  return text.split(/\r?\n/u).map(line => '> ' + line).join('\n');
}

export function revisionComparisonMessage(comparison: RevisionComparisonView): string {
  const version = comparison.selected === 'original' ? '初稿' : '集中修订稿';
  const sections = ['**修订对照**', '采用' + version + '。' + comparison.reason];
  for (const [label, observations] of [['收益', comparison.gains], ['损失', comparison.losses]] as const) {
    if (observations.length === 0) continue;
    sections.push('**' + label + '**');
    for (const { before, after, why } of observations) {
      sections.push('**改前**\n\n' + quote(before) + '\n\n**改后**\n\n' + quote(after) + '\n\n' + why);
    }
  }
  return sections.join('\n\n');
}
