import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { strFromU8, unzipSync } from "fflate";

import {
  DiagnosticBundleError,
  prepareDiagnosticBundle,
  writeDiagnosticBundle,
} from "../src/index.js";

const fakeKey = "sk-diagnostic-fixture-not-a-real-key";
const privatePath = "C:\\Users\\customer\\private\\article.md";
const privateArticle = "这是不应进入诊断包的私人正文。";
const privatePrompt = "把客户内部方案全文发送出去。";

function fixtureSnapshot() {
  return {
    application: {
      version: "1.0.0-dev",
      build: "wa015-fixture",
      platform: "win32",
      arch: "x64",
      privatePath,
    },
    provider: {
      id: "anthropic-primary",
      protocol: "anthropic-messages",
      model: "fixture-tool-model",
      capabilities: {
        streaming: true,
        tools: "supported",
        usage: "reported",
      },
      connection: {
        status: "failed",
        errorCode: "AUTH_FAILED",
        errorMessage: `Bearer ${fakeKey} at ${privatePath}`,
      },
      apiKey: fakeKey,
      baseURL: "https://provider.invalid/v1?token=secret",
    },
    runtime: {
      status: "stopped",
      stopReason: "budget_exhausted",
      counts: {
        modelCalls: 24,
        retries: 2,
        toolCalls: 31,
        majorRevisions: 2,
      },
      budget: {
        maxModelSteps: 24,
        maxRetries: 2,
        maxToolCalls: 32,
        maxMajorRevisions: 2,
      },
      usage: {
        inputTokens: null,
        outputTokens: null,
        cost: {
          status: "unknown",
          amount: 0,
          currency: "USD",
          priceVersion: null,
          verifiedAt: null,
        },
      },
      articleBody: privateArticle,
      prompt: privatePrompt,
      rawLogs: [`Authorization: Bearer ${fakeKey}`],
    },
    security: {
      credentialPersistence: "system",
      systemCredentialStoreAvailable: true,
      networkPolicy: "enforced",
      externalContentTrust: "external_untrusted",
      htmlActiveContent: "removed",
      rendererDirectProviderAccess: false,
      upstreamTelemetryEnabled: false,
      developerPath: privatePath,
    },
    rawLogs: [`API_KEY=${fakeKey}`, privatePath],
  };
}

describe("redacted diagnostic bundle", () => {
  it("previews and exports only allowlisted aggregate fields", () => {
    const prepared = prepareDiagnosticBundle(fixtureSnapshot(), {
      sections: ["application", "provider", "runtime", "security"],
      createdAt: "2026-09-17T08:00:00.000Z",
    });
    const preview = JSON.stringify(prepared.manifest);

    assert.equal(prepared.manifest.schemaVersion, 1);
    assert.deepEqual(prepared.manifest.includedFiles, [
      "application.json",
      "provider.json",
      "runtime.json",
      "security.json",
    ]);
    assert.deepEqual(prepared.manifest.excludedDataClasses, [
      "api_keys_and_credential_values",
      "article_and_material_content",
      "full_prompts_and_tool_results",
      "personal_paths",
      "raw_logs_and_exception_messages",
    ]);
    assert.match(prepared.manifest.confirmationHash, /^[a-f0-9]{64}$/u);
    for (const secret of [
      fakeKey,
      privatePath,
      privateArticle,
      privatePrompt,
      "provider.invalid",
    ]) {
      assert.equal(preview.includes(secret), false);
    }

    const outputDirectory = mkdtempSync(join(tmpdir(), "wa-diagnostics-"));
    try {
      const written = writeDiagnosticBundle(prepared, {
        outputDirectory,
        confirmationHash: prepared.manifest.confirmationHash,
        fileName: "diagnostic-test.zip",
      });
      assert.equal(written.outputPath, join(outputDirectory, "diagnostic-test.zip"));
      assert.equal(written.byteLength > 0, true);
      assert.match(written.sha256, /^[a-f0-9]{64}$/u);

      const archive = unzipSync(new Uint8Array(readFileSync(written.outputPath)));
      assert.deepEqual(Object.keys(archive).sort(), [
        "application.json",
        "manifest.json",
        "provider.json",
        "runtime.json",
        "security.json",
      ]);
      const allContent = Object.values(archive)
        .map((bytes) => strFromU8(bytes))
        .join("\n");
      for (const secret of [
        fakeKey,
        privatePath,
        privateArticle,
        privatePrompt,
        "provider.invalid",
      ]) {
        assert.equal(allContent.includes(secret), false);
      }

      const provider = JSON.parse(strFromU8(archive["provider.json"]!)) as {
        connection: { status: string; errorCode: string };
      };
      assert.deepEqual(provider.connection, {
        status: "failed",
        errorCode: "AUTH_FAILED",
      });
      const runtime = JSON.parse(strFromU8(archive["runtime.json"]!)) as {
        usage: { cost: { status: string; amount: number | null } };
      };
      assert.deepEqual(runtime.usage.cost, {
        status: "unknown",
        amount: null,
        currency: null,
        priceVersion: null,
        verifiedAt: null,
      });
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("requires an exact preview confirmation before writing anything", () => {
    const prepared = prepareDiagnosticBundle(fixtureSnapshot(), {
      sections: ["application", "provider"],
      createdAt: "2026-09-17T08:00:00.000Z",
    });
    const outputDirectory = mkdtempSync(join(tmpdir(), "wa-diagnostics-confirm-"));
    try {
      assert.throws(
        () =>
          writeDiagnosticBundle(prepared, {
            outputDirectory,
            confirmationHash: "0".repeat(64),
            fileName: "should-not-exist.zip",
          }),
        (error: unknown) =>
          error instanceof DiagnosticBundleError &&
          error.code === "DIAGNOSTIC_CONFIRMATION_MISMATCH",
      );
      assert.deepEqual(readdirSync(outputDirectory), []);
      assert.equal(existsSync(join(outputDirectory, "should-not-exist.zip")), false);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("rejects empty selections, unsafe names and existing targets", () => {
    assert.throws(
      () =>
        prepareDiagnosticBundle(fixtureSnapshot(), {
          sections: [],
          createdAt: "2026-09-17T08:00:00.000Z",
        }),
      { name: "DiagnosticBundleError", code: "DIAGNOSTIC_SELECTION_REQUIRED" },
    );

    const prepared = prepareDiagnosticBundle(fixtureSnapshot(), {
      sections: ["security"],
      createdAt: "2026-09-17T08:00:00.000Z",
    });
    const outputDirectory = mkdtempSync(join(tmpdir(), "wa-diagnostics-conflict-"));
    try {
      assert.throws(
        () =>
          writeDiagnosticBundle(prepared, {
            outputDirectory,
            confirmationHash: prepared.manifest.confirmationHash,
            fileName: "../escape.zip",
          }),
        { name: "DiagnosticBundleError", code: "DIAGNOSTIC_FILE_NAME_INVALID" },
      );

      const target = join(outputDirectory, "existing.zip");
      writeFileSync(target, "keep-existing", "utf8");
      assert.throws(
        () =>
          writeDiagnosticBundle(prepared, {
            outputDirectory,
            confirmationHash: prepared.manifest.confirmationHash,
            fileName: "existing.zip",
          }),
        { name: "DiagnosticBundleError", code: "DIAGNOSTIC_TARGET_EXISTS" },
      );
      assert.equal(readFileSync(target, "utf8"), "keep-existing");
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
