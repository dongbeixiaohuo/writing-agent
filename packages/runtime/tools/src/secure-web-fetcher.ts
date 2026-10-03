import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
  type AllowedNetworkTarget,
  NetworkAccessPolicy,
} from "./network-policy.js";
import {
  extractUntrustedWebText,
  UntrustedWebContentError,
  type UntrustedWebText,
} from "./untrusted-content.js";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = "WritingAgent/1.0 secure-source-reader";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "text/plain",
]);

export type SecureWebFetchErrorCode =
  | "WEB_ARTICLE_ACCESS_RESTRICTED"
  | "WEB_ARTICLE_CONTENT_MISSING"
  | "WEB_ARTICLE_UNAVAILABLE"
  | "WEB_CONTENT_TYPE_DENIED"
  | "WEB_ENCODING_INVALID"
  | "WEB_HTTP_STATUS_REJECTED"
  | "WEB_REDIRECT_INVALID"
  | "WEB_REDIRECT_LIMIT_EXCEEDED"
  | "WEB_REQUEST_ABORTED"
  | "WEB_REQUEST_FAILED"
  | "WEB_RESPONSE_TOO_LARGE";

export class SecureWebFetchError extends Error {
  constructor(public readonly code: SecureWebFetchErrorCode, message: string) {
    super(message);
    this.name = "SecureWebFetchError";
  }
}

export interface SecureWebTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Uint8Array;
}

export type SecureWebRequest = (
  target: AllowedNetworkTarget,
  signal?: AbortSignal,
) => Promise<SecureWebTransportResponse>;

export interface SecureWebFetcherOptions {
  readonly policy: NetworkAccessPolicy;
  readonly request?: SecureWebRequest;
  readonly maxBytes?: number;
  readonly maxChars?: number;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

export interface SecureWebFetchResult {
  readonly finalUrl: string;
  readonly redirectCount: number;
  readonly contentType: "application/xhtml+xml" | "text/html" | "text/plain";
  readonly bodyHash: string;
  readonly content: UntrustedWebText;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertValidUserAgent(value: string): void {
  if (
    value.trim().length === 0 ||
    value.length > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("userAgent must be a non-empty HTTP header value");
  }
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] =
      typeof value === "string" ? value : value?.join(", ");
  }
  return Object.freeze(normalized);
}

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [candidate, value] of Object.entries(headers)) {
    if (candidate.toLowerCase() === expected) return value;
  }
  return undefined;
}

function contentTypeOf(
  headers: Readonly<Record<string, string | undefined>>,
): SecureWebFetchResult["contentType"] {
  const raw = headerValue(headers, "content-type") ?? "";
  const mime = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(mime)) {
    throw new SecureWebFetchError(
      "WEB_CONTENT_TYPE_DENIED",
      "The response content type is not allowed",
    );
  }
  return mime as SecureWebFetchResult["contentType"];
}

function toUntrustedPlainText(text: string, maxChars: number): UntrustedWebText {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  return Object.freeze({
    text: characters.slice(0, maxChars).join(""),
    trustLabel: "external_untrusted",
    instructionAuthority: "none",
    activeContentRemoved: false,
    truncated: characters.length > maxChars,
    totalChars: characters.length,
  });
}

function createPinnedRequest(
  maxBytes: number,
  timeoutMs: number,
  userAgent: string,
): SecureWebRequest {
  return async (target, signal) => {
    if (signal?.aborted) {
      throw new SecureWebFetchError("WEB_REQUEST_ABORTED", "The network request was aborted");
    }
    const targetUrl = new URL(target.url);
    const pinnedAddress = target.resolvedAddresses[0];
    if (pinnedAddress === undefined) {
      throw new SecureWebFetchError(
        "WEB_REQUEST_FAILED",
        "The approved network target has no pinned address",
      );
    }
    const family = isIP(pinnedAddress);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        callback(null, [{ address: pinnedAddress, family }]);
        return;
      }
      callback(null, pinnedAddress, family);
    };

    return new Promise<SecureWebTransportResponse>((resolve, reject) => {
      let settled = false;
      let request: ReturnType<typeof httpsRequest> | undefined;
      let activeResponse: IncomingMessage | undefined;
      const onAbort = (): void => {
        finish(new SecureWebFetchError("WEB_REQUEST_ABORTED", "The network request was aborted"));
        activeResponse?.destroy();
        request?.destroy();
      };
      const finish = (
        error: SecureWebFetchError | null,
        response?: SecureWebTransportResponse,
      ): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error !== null) reject(error);
        else if (response !== undefined) resolve(response);
      };
      const requestTransport = targetUrl.protocol === 'http:' ? httpRequest : httpsRequest;
      request = requestTransport(
        targetUrl,
        {
          method: "GET",
          headers: {
            accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
            "accept-encoding": "identity",
            "user-agent": userAgent,
          },
          lookup,
          ...(targetUrl.protocol === 'https:' ? { servername: targetUrl.hostname } : {}),
          timeout: timeoutMs,
        },
        (response) => {
          activeResponse = response;
          const headers = normalizeHeaders(response.headers);
          const declaredLength = Number.parseInt(headers["content-length"] ?? "", 10);
          if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            response.destroy();
            finish(
              new SecureWebFetchError(
                "WEB_RESPONSE_TOO_LARGE",
                "The response exceeds the configured byte limit",
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.byteLength;
            if (received > maxBytes) {
              response.destroy();
              finish(
                new SecureWebFetchError(
                  "WEB_RESPONSE_TOO_LARGE",
                  "The response exceeds the configured byte limit",
                ),
              );
              return;
            }
            chunks.push(bytes);
          });
          response.on("end", () => {
            finish(null, {
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks),
            });
          });
          response.on("error", () => {
            finish(
              new SecureWebFetchError(
                "WEB_REQUEST_FAILED",
                "The network response could not be read",
              ),
            );
          });
        },
      );
      request.on("timeout", () => {
        request.destroy();
        finish(
          new SecureWebFetchError(
            "WEB_REQUEST_FAILED",
            "The network request timed out",
          ),
        );
      });
      request.on("error", () => {
        finish(
          new SecureWebFetchError(
            "WEB_REQUEST_FAILED",
            "The network request failed",
          ),
        );
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      request.end();
    });
  };
}

export class SecureWebFetcher {
  readonly #policy: NetworkAccessPolicy;
  readonly #request: SecureWebRequest;
  readonly #maxBytes: number;
  readonly #maxChars: number;
  readonly #maxRedirects: number;

  constructor(options: SecureWebFetcherOptions) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    assertPositiveSafeInteger(maxBytes, "maxBytes");
    assertPositiveSafeInteger(maxChars, "maxChars");
    assertNonNegativeSafeInteger(maxRedirects, "maxRedirects");
    assertPositiveSafeInteger(timeoutMs, "timeoutMs");
    assertValidUserAgent(userAgent);
    this.#policy = options.policy;
    this.#maxBytes = maxBytes;
    this.#maxChars = maxChars;
    this.#maxRedirects = maxRedirects;
    this.#request = options.request ?? createPinnedRequest(maxBytes, timeoutMs, userAgent);
  }

  async fetchText(input: string, signal?: AbortSignal): Promise<SecureWebFetchResult> {
    if (signal?.aborted) {
      throw new SecureWebFetchError("WEB_REQUEST_ABORTED", "The network request was aborted");
    }
    let target = await this.#policy.assertAllowed(input);
    if (signal?.aborted) {
      throw new SecureWebFetchError("WEB_REQUEST_ABORTED", "The network request was aborted");
    }
    let redirectCount = 0;

    while (true) {
      let response: SecureWebTransportResponse;
      try {
        response = await this.#request(target, signal);
      } catch (error) {
        if (error instanceof SecureWebFetchError) throw error;
        throw new SecureWebFetchError(
          "WEB_REQUEST_FAILED",
          "The network request failed",
        );
      }

      if (response.body.byteLength > this.#maxBytes) {
        throw new SecureWebFetchError(
          "WEB_RESPONSE_TOO_LARGE",
          "The response exceeds the configured byte limit",
        );
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, "location");
        if (location === undefined || location.trim().length === 0) {
          throw new SecureWebFetchError(
            "WEB_REDIRECT_INVALID",
            "The redirect response did not include a valid target",
          );
        }
        if (redirectCount >= this.#maxRedirects) {
          throw new SecureWebFetchError(
            "WEB_REDIRECT_LIMIT_EXCEEDED",
            "The response exceeded the redirect limit",
          );
        }
        target = await this.#policy.assertAllowedRedirect(target.url, location);
        if (signal?.aborted) {
          throw new SecureWebFetchError("WEB_REQUEST_ABORTED", "The network request was aborted");
        }
        redirectCount += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new SecureWebFetchError(
          "WEB_HTTP_STATUS_REJECTED",
          "The remote server returned an unsuccessful status",
        );
      }

      const contentType = contentTypeOf(response.headers);
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
      } catch {
        throw new SecureWebFetchError(
          "WEB_ENCODING_INVALID",
          "The response is not valid UTF-8 text",
        );
      }
      let content: UntrustedWebText;
      try {
        content =
          contentType === "text/plain"
            ? toUntrustedPlainText(decoded, this.#maxChars)
            : extractUntrustedWebText(decoded, this.#maxChars, { url: target.url });
      } catch (error) {
        if (!(error instanceof UntrustedWebContentError)) throw error;
        if (
          error.code === "ARTICLE_ACCESS_RESTRICTED" ||
          error.code === "ARTICLE_VERIFICATION_REQUIRED"
        ) {
          throw new SecureWebFetchError(
            "WEB_ARTICLE_ACCESS_RESTRICTED",
            "The article requires interactive access that this reader will not bypass",
          );
        }
        if (error.code === "ARTICLE_REMOVED") {
          throw new SecureWebFetchError(
            "WEB_ARTICLE_UNAVAILABLE",
            "The article is unavailable",
          );
        }
        throw new SecureWebFetchError(
          "WEB_ARTICLE_CONTENT_MISSING",
          "The response did not contain an article body",
        );
      }
      return Object.freeze({
        finalUrl: target.url,
        redirectCount,
        contentType,
        bodyHash: createHash("sha256").update(response.body).digest("hex"),
        content,
      });
    }
  }
}
