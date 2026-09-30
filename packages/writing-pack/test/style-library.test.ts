import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  getLegacyStyle,
  getLegacyStyleMethodology,
  listLegacyStyles,
} from "../src/style-library.js";
import archive from "../src/legacy-style-data.json" with { type: "json" };

interface SourceRegistry {
  readonly statuses: Readonly<Record<string, string>>;
  readonly styles: readonly {
    readonly name: string;
    readonly file: string;
    readonly verification_status: "verified" | "legacy_unverified";
    readonly evidence_file: string | null;
  }[];
}

const root = resolve(import.meta.dirname, "../../..");
const sourceRegistryPath = resolve(root, "claude-runtime/styles/style_registry.json");
const sourceRegistry = JSON.parse(readFileSync(sourceRegistryPath, "utf8")) as SourceRegistry;

function frontMatter(content: string, field: string): string | number | null {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "mu"));
  if (match?.[1] === undefined) return null;
  const value = match[1].trim().replace(/^['"]|['"]$/gu, "");
  if (value === "null") return null;
  return /^\d+$/u.test(value) ? Number(value) : value;
}

describe("legacy style library", () => {
  it("stores canonical LF text so archive hashes survive a clean cross-platform checkout", () => {
    for (const source of [archive.registrySource, ...archive.profiles, archive.methodology]) {
      assert.equal(source.content.includes("\r"), false, source.sourcePath);
    }
  });

  it("keeps the source registry as importable inert archive data", () => {
    const registryBytes = readFileSync(sourceRegistryPath);
    assert.deepEqual(archive.registrySource, {
      sourcePath: "claude-runtime/styles/style_registry.json",
      sourceHash: createHash("sha256").update(registryBytes).digest("hex"),
      content: registryBytes.toString("utf8"),
    });
  });

  it("packages all seven source profiles byte-for-byte with their real hashes and validation status", () => {
    const listed = listLegacyStyles();
    assert.equal(listed.length, 7);
    assert.deepEqual(
      listed.map((style) => style.name),
      sourceRegistry.styles.map((style) => style.name),
    );

    for (const registryEntry of sourceRegistry.styles) {
      const sourcePath = `claude-runtime/styles/${registryEntry.file}`;
      const sourceBytes = readFileSync(resolve(root, sourcePath));
      const sourceContent = sourceBytes.toString("utf8");
      const expectedHash = createHash("sha256").update(sourceBytes).digest("hex");
      const style = getLegacyStyle(registryEntry.name);

      assert.notEqual(style, null);
      assert.equal(style?.sourcePath, sourcePath);
      assert.equal(style?.sourceHash, expectedHash);
      assert.equal(style?.content, sourceContent);
      assert.equal(style?.validation.status, registryEntry.verification_status);
      assert.equal(style?.validation.evidencePath,
        registryEntry.evidence_file === null
          ? null
          : `claude-runtime/styles/${registryEntry.evidence_file}`,
      );
      assert.equal(style?.validation.statusDescription,
        sourceRegistry.statuses[registryEntry.verification_status],
      );
      assert.deepEqual(style?.quality, {
        status: "unknown",
        author: frontMatter(sourceContent, "author"),
        sourceCount: frontMatter(sourceContent, "source_count"),
        lastUpdated: frontMatter(sourceContent, "last_updated"),
      });
      assert.equal(style?.trustLabel, "reference_untrusted");
      assert.equal(style?.instructionAuthority, "none");
    }
    assert.equal(
      listed.filter((style) => style.validationStatus === "verified").length,
      2,
    );
    assert.equal(
      listed.filter((style) => style.validationStatus === "legacy_unverified").length,
      5,
    );
  });

  it("finds profiles by stable id, registry name, filename stem, and source-derived author alias", () => {
    assert.equal(getLegacyStyle("jiubian")?.name, "jiubian");
    assert.equal(getLegacyStyle("jiubian.md")?.name, "jiubian");
    assert.equal(getLegacyStyle("九边")?.quality.author, "九边");
    assert.equal(getLegacyStyle("碧树西风")?.name, "记忆大师风格");
    assert.equal(getLegacyStyle("  JIUBIAN  ")?.name, "jiubian");
  });

  it("returns null for missing names without exposing a mutable shared profile", () => {
    assert.equal(getLegacyStyle("does-not-exist"), null);
    const first = getLegacyStyle("jiubian")!;
    const second = getLegacyStyle("jiubian")!;
    assert.notEqual(first, second);
    assert.notEqual(first.validation, second.validation);
    assert.notEqual(first.aliases, second.aliases);
  });

  it("exposes the real 15-dimension source only as methodology, not completed analysis", () => {
    const methodology = getLegacyStyleMethodology();
    const sourceBytes = readFileSync(resolve(root, methodology.sourcePath));
    assert.equal(methodology.classification, "methodology_not_completed_analysis");
    assert.equal(methodology.content, sourceBytes.toString("utf8"));
    assert.equal(
      methodology.sourceHash,
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
    assert.equal(methodology.dimensions.length, 15);
    assert.equal(methodology.trustLabel, "reference_untrusted");
    assert.equal(methodology.instructionAuthority, "none");
  });
});
