import { load } from "cheerio";

export interface UntrustedWebText {
  readonly text: string;
  readonly title?: string;
  readonly author?: string;
  readonly contentSelector?: string;
  readonly trustLabel: "external_untrusted";
  readonly instructionAuthority: "none";
  readonly activeContentRemoved: boolean;
  readonly truncated: boolean;
  readonly totalChars: number;
}

export type UntrustedWebContentErrorCode =
  | "ARTICLE_ACCESS_RESTRICTED"
  | "ARTICLE_BODY_MISSING"
  | "ARTICLE_REMOVED"
  | "ARTICLE_VERIFICATION_REQUIRED";

export class UntrustedWebContentError extends Error {
  constructor(
    public readonly code: UntrustedWebContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UntrustedWebContentError";
  }
}

export interface UntrustedWebExtractionContext {
  readonly url?: string;
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

const NON_ARTICLE_CONTENT = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "[role='navigation']",
].join(",");

const ARTICLE_BLOCKS = [
  "address",
  "article",
  "blockquote",
  "div",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "pre",
  "section",
  "table",
  "tr",
].join(",");

function normalizedInlineText(value: string, maxChars: number): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return Array.from(normalized).slice(0, maxChars).join("");
}

function normalizedArticleText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v\u00a0 ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isWechatUrl(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    return new URL(value).hostname.toLowerCase() === "mp.weixin.qq.com";
  } catch {
    return false;
  }
}

function extractWechatArticle(
  html: string,
  maxChars: number,
  url: string,
): UntrustedWebText {
  const $ = load(html, { xmlMode: false, scriptingEnabled: false });
  const active = $(ACTIVE_CONTENT);
  const activeContentRemoved = active.length > 0;
  active.remove();

  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    // The fetcher supplies an already validated URL. Keep direct helper calls inert.
  }
  const pageText = $("body").text().replace(/\s+/gu, " ").trim();
  if (pathname.includes("wappoc_appmsgcaptcha")) {
    throw new UntrustedWebContentError(
      "ARTICLE_VERIFICATION_REQUIRED",
      "The WeChat article requires interactive verification",
    );
  }

  const article = $("#js_content").first().clone();
  article.find(NON_ARTICLE_CONTENT).remove();
  article.find("br").replaceWith("\n");
  article.find(ARTICLE_BLOCKS).append("\n\n");
  const normalized = normalizedArticleText(article.text());

  if (normalized.length === 0) {
    if (
      /(?:环境异常|安全验证)/u.test(pageText) &&
      /(?:验证|继续访问)/u.test(pageText)
    ) {
      throw new UntrustedWebContentError(
        "ARTICLE_VERIFICATION_REQUIRED",
        "The WeChat article requires interactive verification",
      );
    }
    if (/(?:该内容已被发布者删除|此内容因违规无法查看|内容已删除|内容已被删除)/u.test(pageText)) {
      throw new UntrustedWebContentError(
        "ARTICLE_REMOVED",
        "The WeChat article is unavailable or has been removed",
      );
    }
    if (/(?:请在微信(?:客户端)?中?打开|访问过于频繁|暂时无法访问)/u.test(pageText)) {
      throw new UntrustedWebContentError(
        "ARTICLE_ACCESS_RESTRICTED",
        "The WeChat article is not accessible in this reader",
      );
    }
    throw new UntrustedWebContentError(
      "ARTICLE_BODY_MISSING",
      "The WeChat response did not contain an article body",
    );
  }

  const title = normalizedInlineText($("#activity-name").first().text(), 500);
  const author = normalizedInlineText($("#js_name").first().text(), 200);
  const combined = title === undefined ? normalized : `${title}\n\n${normalized}`;
  const characters = Array.from(combined);
  return Object.freeze({
    text: characters.slice(0, maxChars).join(""),
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    contentSelector: "#js_content",
    trustLabel: "external_untrusted",
    instructionAuthority: "none",
    activeContentRemoved,
    truncated: characters.length > maxChars,
    totalChars: characters.length,
  });
}

export function extractUntrustedWebText(
  html: string,
  maxChars = 100_000,
  context: UntrustedWebExtractionContext = {},
): UntrustedWebText {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
    throw new TypeError("maxChars must be a positive safe integer");
  }
  if (isWechatUrl(context.url)) {
    return extractWechatArticle(html, maxChars, context.url as string);
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
