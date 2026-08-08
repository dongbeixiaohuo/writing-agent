/**
 * Shared outbound URL policy for page navigation and remote image downloads.
 */

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isPrivateIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

export function isPrivateIp(address) {
  if (net.isIP(address) === 4) return isPrivateIpv4(address);
  if (net.isIP(address) !== 6) return true;

  const value = address.toLowerCase().split("%")[0];
  if (value.startsWith("::ffff:")) {
    return isPrivateIp(value.slice("::ffff:".length));
  }
  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("100:") ||
    value.startsWith("2001:2:") ||
    value.startsWith("2001:db8:") ||
    value.startsWith("64:ff9b:1:")
  );
}

export function isSafeRemoteUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".localdomain") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home")
    ) {
      return false;
    }
    return net.isIP(hostname) === 0 || !isPrivateIp(hostname);
  } catch {
    return false;
  }
}

export async function resolveSafeAddress(value) {
  const parsed = value instanceof URL ? value : new URL(value);
  if (!isSafeRemoteUrl(parsed.href)) {
    throw new Error("Blocked unsafe remote URL");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) {
    return { address: hostname, family: net.isIP(hostname) };
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Blocked remote host resolving to a private or reserved address");
  }
  return addresses[0];
}

export function safeLookup(address, family) {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export async function requestOnce({ parsed, resolved, timeoutMs = 15_000 }) {
  const client = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      parsed,
      {
        method: "HEAD",
        lookup: safeLookup(resolved.address, resolved.family),
        headers: { "User-Agent": "writing-agent-url-preflight/1.0" },
      },
      (response) => {
        const result = {
          statusCode: response.statusCode || 0,
          location: response.headers.location || null,
        };
        response.resume();
        resolve(result);
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Remote URL preflight timeout")));
    request.on("error", reject);
    request.end();
  });
}

export async function inspectNavigationUrl(
  value,
  {
    maxRedirects = 3,
    timeoutMs = 15_000,
    resolveAddress = resolveSafeAddress,
    requestOnce: inspectRequest = requestOnce,
  } = {},
) {
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("maxRedirects must be an integer between 0 and 10");
  }

  let currentUrl = String(value);
  const redirects = [];
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (!isSafeRemoteUrl(currentUrl)) {
      throw new Error("Blocked unsafe remote URL");
    }

    const parsed = new URL(currentUrl);
    const resolved = await resolveAddress(parsed);
    const response = await inspectRequest({ parsed, resolved, timeoutMs });
    if (!REDIRECT_STATUSES.has(response.statusCode)) {
      return {
        finalUrl: parsed.href,
        statusCode: response.statusCode,
        redirects,
        resolvedAddress: resolved.address,
      };
    }

    if (!response.location) {
      throw new Error("Remote URL redirect is missing a Location header");
    }
    if (redirectCount >= maxRedirects) {
      throw new Error("Too many remote URL redirects");
    }

    const nextUrl = new URL(response.location, parsed).href;
    redirects.push({ from: parsed.href, to: nextUrl, statusCode: response.statusCode });
    currentUrl = nextUrl;
  }
}
