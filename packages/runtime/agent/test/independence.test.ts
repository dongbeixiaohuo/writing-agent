import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const productionRoots = [
  "packages/writing-core",
  "packages/writing-pack",
  "packages/application",
  "packages/storage",
  "packages/runtime/llm",
  "packages/runtime/tools",
  "packages/runtime/session",
  "packages/runtime/agent",
  "packages/model-adapters/openai-compatible",
  "apps/cli",
];

function sourceFiles(path: string): string[] {
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" ? [] : sourceFiles(child);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  });
}

describe("independent runtime production closure", () => {
  it("does not import or launch an external DSH or Claude agent engine", () => {
    const forbiddenImports =
      /(?:from\s+|import\s*\()["'][^"']*(?:deepseek-harness|claude-agent-sdk|@anthropic-ai\/claude-agent-sdk)[^"']*["']/i;
    const forbiddenLaunch =
      /\b(?:spawn|spawnSync|exec|execFile|execFileSync)\s*\([^\n]*(?:["']dsh["']|["']claude["'])/i;

    for (const relativeRoot of productionRoots) {
      const absoluteRoot = join(repositoryRoot, relativeRoot);
      for (const file of sourceFiles(absoluteRoot)) {
        const source = readFileSync(file, "utf8");
        assert.doesNotMatch(source, forbiddenImports, file);
        assert.doesNotMatch(source, forbiddenLaunch, file);
      }

      const manifest = JSON.parse(
        readFileSync(join(absoluteRoot, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      const dependencyNames = Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      });
      assert.equal(
        dependencyNames.some((name) =>
          /deepseek-harness|claude-agent-sdk|@anthropic-ai\/claude-agent-sdk/i.test(
            name,
          ),
        ),
        false,
        `${relativeRoot} has an external agent-engine dependency`,
      );
    }
  });
});
