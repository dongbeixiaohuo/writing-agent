import { z } from 'zod';
import definitions from './builtin-styles.json' with { type: 'json' };
import { StyleProfileSchema, STYLE_BUILTIN_PROFILE_LIMIT, type StyleProfile } from './style-profile.js';
import { StylePackageSchema, styleParagraphs, styleStatistics } from './style-package.js';

// Static import keeps the curated configuration inside every desktop bundle.
// Authored examples demonstrate expression, not empirical validation or article facts.
const DefinitionSchema = StyleProfileSchema.pick({
  id: true, version: true, updatedAt: true, name: true, summary: true, card: true, notes: true, samples: true,
}).extend({ patterns: StylePackageSchema.shape.patterns, snippets: StylePackageSchema.shape.snippets }).strict();
const ids = new Set<string>();
const profiles = z.array(DefinitionSchema).max(STYLE_BUILTIN_PROFILE_LIMIT).parse(definitions).map(definition => {
  const { patterns, snippets, ...base } = definition;
  if (!base.id.startsWith('builtin-') || ids.has(base.id)) throw new Error('BUILTIN_STYLE_ID_INVALID');
  ids.add(base.id);
  for (const snippet of snippets) {
    const sample = base.samples.find(item => item.id === snippet.sampleId);
    const paragraph = sample && styleParagraphs(sample.text).find(item => item.id === snippet.paragraphId);
    if (!paragraph?.text.includes(snippet.quote)) throw new Error('BUILTIN_STYLE_SNIPPET_INVALID');
  }
  return StyleProfileSchema.parse({
    ...base, builtin: true, rules: [], sampleCount: base.samples.length,
    analyzedCharacters: 0, totalCharacters: base.samples.reduce((sum, sample) => sum + sample.text.length, 0),
    elapsedMs: 0, modelRequests: 0,
    package: { version: 2, statistics: styleStatistics(base.samples), patterns, snippets },
  });
});

/** Fresh values prevent callers from mutating the bundled definitions. No database writes. */
export function builtinStyleProfiles(): StyleProfile[] {
  return structuredClone(profiles);
}

export function builtinStyleProfile(id: string): StyleProfile | undefined {
  const profile = profiles.find(item => item.id === id);
  return profile && structuredClone(profile);
}
