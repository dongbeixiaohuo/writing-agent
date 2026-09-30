import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export interface NetworkAccessPolicyOptions {
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

export interface AllowedNetworkTarget {
  readonly url: string;
  readonly resolvedAddresses: readonly string[];
}

export class NetworkPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:2::", 48],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6");
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) return !blockedIpv6.check(address, "ipv6");
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home")
  );
}

export class NetworkAccessPolicy {
  readonly #resolveHost: (hostname: string) => Promise<readonly string[]>;

  constructor(options: NetworkAccessPolicyOptions = {}) {
    this.#resolveHost = options.resolveHost ?? defaultResolveHost;
  }

  async assertAllowed(input: string): Promise<AllowedNetworkTarget> {
    let target: URL;
    try {
      target = new URL(input);
    } catch {
      throw new NetworkPolicyError("NETWORK_URL_INVALID", "The network target is invalid");
    }
    if (target.protocol !== "https:") {
      throw new NetworkPolicyError(
        "NETWORK_PROTOCOL_DENIED",
        "Only HTTPS network targets are allowed",
      );
    }
    if (target.username.length > 0 || target.password.length > 0) {
      throw new NetworkPolicyError(
        "NETWORK_CREDENTIALS_DENIED",
        "Credentials must not be embedded in network URLs",
      );
    }
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    if (isBlockedHostname(hostname)) {
      throw new NetworkPolicyError(
        "NETWORK_PRIVATE_TARGET_DENIED",
        "Local and private network targets are not allowed",
      );
    }

    let addresses: readonly string[];
    if (isIP(hostname) !== 0) {
      addresses = [hostname];
    } else {
      try {
        addresses = await this.#resolveHost(hostname);
      } catch {
        throw new NetworkPolicyError(
          "NETWORK_TARGET_UNRESOLVED",
          "The network target could not be resolved",
        );
      }
    }
    if (addresses.length === 0) {
      throw new NetworkPolicyError(
        "NETWORK_TARGET_UNRESOLVED",
        "The network target could not be resolved",
      );
    }
    if (addresses.some((address) => !isPublicAddress(address))) {
      throw new NetworkPolicyError(
        "NETWORK_PRIVATE_TARGET_DENIED",
        "Local, private and metadata network targets are not allowed",
      );
    }

    target.hash = "";
    return Object.freeze({
      url: target.toString(),
      resolvedAddresses: Object.freeze([...new Set(addresses)].sort()),
    });
  }

  async assertAllowedRedirect(
    sourceUrl: string,
    redirectUrl: string,
  ): Promise<AllowedNetworkTarget> {
    let resolved: string;
    try {
      resolved = new URL(redirectUrl, sourceUrl).toString();
    } catch {
      throw new NetworkPolicyError(
        "NETWORK_URL_INVALID",
        "The redirect target is invalid",
      );
    }
    return this.assertAllowed(resolved);
  }
}
