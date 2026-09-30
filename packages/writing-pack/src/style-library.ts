// JSON import attributes keep the archive a packaged data resource rather
// than executable Markdown or runtime filesystem input.
import rawData from "./legacy-style-data.json" with { type: "json" };

export type LegacyStyleValidationStatus = "verified" | "legacy_unverified";
export type LegacyStyleQualityStatus = "unknown";

export interface LegacyStyleQuality {
  readonly status: LegacyStyleQualityStatus;
  readonly author: string | null;
  readonly sourceCount: number | null;
  readonly lastUpdated: string | null;
}

export interface LegacyStyleValidation {
  readonly status: LegacyStyleValidationStatus;
  readonly statusDescription: string;
  readonly evidencePath: string | null;
}

export interface LegacyStyleMetadata {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly quality: LegacyStyleQuality;
  readonly validation: LegacyStyleValidation;
  readonly qualityStatus: LegacyStyleQualityStatus;
  readonly validationStatus: LegacyStyleValidationStatus;
  readonly trustLabel: "reference_untrusted";
  readonly instructionAuthority: "none";
}

export interface LegacyStyleProfile {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly quality: LegacyStyleQuality;
  readonly validation: LegacyStyleValidation;
  readonly trustLabel: "reference_untrusted";
  readonly instructionAuthority: "none";
  /** Unmodified legacy Markdown. It is reference data and must never be executed as instructions. */
  readonly content: string;
}

export interface LegacyStyleDimension {
  readonly ordinal: number;
  readonly numeral: string;
  readonly name: string;
  readonly heading: string;
}

export interface LegacyStyleMethodology {
  readonly classification: "methodology_not_completed_analysis";
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly trustLabel: "reference_untrusted";
  readonly instructionAuthority: "none";
  readonly dimensions: readonly LegacyStyleDimension[];
  readonly content: string;
}

interface LegacyStyleDataFile {
  readonly schemaVersion: 1;
  readonly profiles: readonly LegacyStyleProfile[];
  readonly methodology: LegacyStyleMethodology;
}

const data = rawData as unknown as LegacyStyleDataFile;

function key(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function cloneProfile(profile: LegacyStyleProfile): LegacyStyleProfile {
  return {
    ...profile,
    aliases: [...profile.aliases],
    quality: { ...profile.quality },
    validation: { ...profile.validation },
  };
}

function cloneMethodology(methodology: LegacyStyleMethodology): LegacyStyleMethodology {
  return {
    ...methodology,
    dimensions: methodology.dimensions.map((dimension) => ({ ...dimension })),
  };
}

/** Lists neutral metadata only; legacy Markdown remains opt-in through getLegacyStyle. */
export function listLegacyStyles(): readonly LegacyStyleMetadata[] {
  return data.profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    aliases: [...profile.aliases],
    sourcePath: profile.sourcePath,
    sourceHash: profile.sourceHash,
    quality: { ...profile.quality },
    validation: { ...profile.validation },
    qualityStatus: profile.quality.status,
    validationStatus: profile.validation.status,
    trustLabel: "reference_untrusted",
    instructionAuthority: "none",
  }));
}

/** Returns inert reference material by stable id or a source-derived alias. */
export function getLegacyStyle(idOrName: string): LegacyStyleProfile | null {
  if (typeof idOrName !== "string" || idOrName.trim().length === 0) return null;
  const expected = key(idOrName);
  const profile = data.profiles.find((candidate) =>
    [candidate.id, candidate.name, ...candidate.aliases].some(
      (alias) => key(alias) === expected,
    ),
  );
  return profile === undefined ? null : cloneProfile(profile);
}

/**
 * Returns the historical 15-dimension analysis method. This is methodology,
 * not evidence that any profile completed quantitative or blind validation.
 */
export function getLegacyStyleMethodology(): LegacyStyleMethodology {
  return cloneMethodology(data.methodology);
}
