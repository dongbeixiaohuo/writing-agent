import { resolve, sep } from "node:path";

export const DESKTOP_APP_ORIGIN = "writing-agent://app";
export {
  DESKTOP_BRIDGE_CHANNEL,
  DESKTOP_SNAPSHOT_CHANNEL,
} from "./channels.js";

export interface SecureWebPreferences {
  readonly preload: string;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly webviewTag: false;
}

export function createSecureWebPreferences(preload: string): SecureWebPreferences {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
  };
}

export function isTrustedIpcSender(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "writing-agent:" && parsed.host === "app";
  } catch {
    return false;
  }
}

export const isAllowedNavigation = isTrustedIpcSender;

function assetError(code: string): Error {
  return new Error(`DESKTOP_ASSET_${code}`);
}

export function resolveRendererAsset(root: string, url: string): string {
  if (!url.startsWith(`${DESKTOP_APP_ORIGIN}/`)) throw assetError("ORIGIN_INVALID");
  const rawPath = url.slice(DESKTOP_APP_ORIGIN.length).split(/[?#]/u, 1)[0] ?? "/";
  if (/(?:^|\/)(?:\.\.|%2e%2e)(?:\/|$)/iu.test(rawPath)) {
    throw assetError("TRAVERSAL_REJECTED");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw assetError("URL_INVALID");
  }
  if (parsed.protocol !== "writing-agent:" || parsed.host !== "app") {
    throw assetError("ORIGIN_INVALID");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    throw assetError("ENCODING_INVALID");
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    throw assetError("PATH_INVALID");
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relative);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw assetError("TRAVERSAL_REJECTED");
  }
  return target;
}
