/**
 * Compatibility preflight for the vendored Readability runtime.
 * This file intentionally performs no network or eval-based loading.
 */

(function checkVendoredReadability() {
  if (typeof globalThis.Readability !== "function") {
    return {
      success: false,
      ready: false,
      error: "Readability is not loaded; evaluate scripts/Readability.js before the extractor",
    };
  }

  return {
    success: true,
    ready: true,
    source: "vendored",
    version: "0.6.0",
  };
})();
