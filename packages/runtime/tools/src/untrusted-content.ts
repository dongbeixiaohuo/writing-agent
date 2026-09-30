import { load } from "cheerio";

export interface UntrustedWebText {
  readonly text: string;
  readonly trustLabel: "external_untrusted";
  readonly instructionAuthority: "none";
  readonly activeContentRemoved: boolean;
  readonly truncated: boolean;
  readonly totalChars: number;
}

const ACTIVE_CONTENT = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "template",
  "noscript",
  "svg",
  "math",
].join(",");

export function extractUntrustedWebText(
  html: string,
  maxChars = 100_000,
): UntrustedWebText {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TypeError("maxChars must be a positive safe integer");
  }
  const $ = load(html, { xmlMode: false, scriptingEnabled: false });
  const active = $(ACTIVE_CONTENT);
  const activeContentRemoved = active.length > 0;
  active.remove();
  const normalized = ($("body").length > 0 ? $("body").text() : $.root().text())
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(normalized);
  return Object.freeze({
    text: characters.slice(0, maxChars).join(""),
    trustLabel: "external_untrusted",
    instructionAuthority: "none",
    activeContentRemoved,
    truncated: characters.length > maxChars,
    totalChars: characters.length,
  });
}
