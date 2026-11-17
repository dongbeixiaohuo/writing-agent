/** Carry a citation URL with its text; local file paths and credentials are not citations. */
export function sourceReferenceMetadata(reference: string | null): { sourceReference?: string } {
  if (!reference) return {};
  try {
    const url = new URL(reference);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? { sourceReference: reference } : {};
  } catch { return {}; }
}
