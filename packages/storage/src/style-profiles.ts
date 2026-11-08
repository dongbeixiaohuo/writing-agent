import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { StyleDraftSchema, StyleProfileSchema, STYLE_PERSONAL_PROFILE_LIMIT, validateStyleSamples, type StyleDraft, type StyleProfile, type StyleProfileSummary } from '../../writing-core/src/style-profile.js';
import { builtinStyleProfile, builtinStyleProfiles } from '../../writing-core/src/builtin-styles.js';
import { styleExampleText, styleParagraphs, styleStatistics } from '../../writing-core/src/style-package.js';

/** Workspace-local library. Applied briefs keep their own immutable card snapshot. */
export class StyleProfileStore {
  constructor(private readonly database: DatabaseSync, private readonly readOnly = false) {}

  list(): StyleProfileSummary[] {
    const saved = this.database.prepare('SELECT profile_json FROM style_profiles WHERE deleted = 0 ORDER BY rowid DESC').all()
      .map(row => StyleProfileSchema.parse(JSON.parse(row.profile_json as string)));
    return [...builtinStyleProfiles(), ...saved].map(p => {
      return { id: p.id, name: p.name, version: p.version, updatedAt: p.updatedAt, sampleCount: p.sampleCount, summary: p.summary, ...(p.builtin ? { builtin: true as const } : {}) };
    });
  }

  get(id: string): StyleProfile {
    const builtin = builtinStyleProfile(id);
    if (builtin) return builtin;
    const row = this.database.prepare('SELECT profile_json FROM style_profiles WHERE id = ? AND deleted = 0').get(id);
    if (!row) throw new Error('STYLE_PROFILE_NOT_FOUND');
    return StyleProfileSchema.parse(JSON.parse(row.profile_json as string));
  }

  save(id: string | null, expectedVersion: number | null, value: StyleDraft): StyleProfile {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    if (id !== null && builtinStyleProfile(id)) throw new Error('STYLE_BUILTIN_READ_ONLY');
    const draft = StyleDraftSchema.parse(value);
    const samples = validateStyleSamples(draft.samples);
    if (draft.sampleCount !== samples.length) throw new Error('STYLE_INPUT_INVALID');
    // Examples are optional. Preserve the usable card without storing invented quotations.
    const rules = draft.rules.map(rule => {
      const evidence = rule.evidence.filter(item => samples.find(sample => sample.id === item.sampleId)?.text.includes(item.quote));
      return { ...rule, evidence, confidence: new Set(evidence.map(item => item.sampleId)).size >= 2 ? 'recurring' as const : 'sample' as const };
    });
    if (id === null && expectedVersion !== null || id !== null && expectedVersion === null) throw new Error('STYLE_VERSION_CONFLICT');
    if (id === null && this.list().filter(profile => !profile.builtin).length >= STYLE_PERSONAL_PROFILE_LIMIT) throw new Error('STYLE_LIBRARY_FULL');
    const pack = draft.package && { ...draft.package, statistics: styleStatistics(samples), snippets: draft.package.snippets.filter(item => {
      const sample = samples.find(sample => sample.id === item.sampleId);
      if (draft.package!.version === 3) return !!sample && !!item.paragraphIds && item.paragraphId === item.paragraphIds[0]
        && styleExampleText(sample.text, item.paragraphIds) === item.quote;
      const paragraph = sample && styleParagraphs(sample.text).find(paragraph => paragraph.id === item.paragraphId.split(':')[0]);
      return paragraph?.text.includes(item.quote) === true;
    }) };
    const profile: StyleProfile = { ...draft, ...(pack ? { package: pack } : {}), samples, rules, id: id ?? randomUUID(), version: (expectedVersion ?? 0) + 1, updatedAt: new Date().toISOString() };
    const json = JSON.stringify(profile);
    if (id === null) {
      this.database.prepare('INSERT INTO style_profiles(id, version, profile_json) VALUES (?, ?, ?)').run(profile.id, profile.version, json);
    } else {
      const result = this.database.prepare('UPDATE style_profiles SET version = ?, profile_json = ? WHERE id = ? AND version = ? AND deleted = 0').run(profile.version, json, id, expectedVersion!);
      if (result.changes !== 1) throw new Error('STYLE_VERSION_CONFLICT');
    }
    return this.get(profile.id);
  }

  remove(id: string, expectedVersion: number): void {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    if (builtinStyleProfile(id)) throw new Error('STYLE_BUILTIN_READ_ONLY');
    const result = this.database.prepare('UPDATE style_profiles SET deleted = 1 WHERE id = ? AND version = ? AND deleted = 0').run(id, expectedVersion);
    if (result.changes !== 1) throw new Error('STYLE_VERSION_CONFLICT');
  }
}
