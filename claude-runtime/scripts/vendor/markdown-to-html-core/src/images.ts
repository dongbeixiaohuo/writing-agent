import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

export interface ImagePlaceholder {
  originalPath: string;
  placeholder: string;
  alt?: string;
}

export interface ResolvedImageInfo extends ImagePlaceholder {
  localPath: string;
}

export function replaceMarkdownImagesWithPlaceholders(
  markdown: string,
  placeholderPrefix: string,
): {
  images: ImagePlaceholder[];
  markdown: string;
} {
  const images: ImagePlaceholder[] = [];
  let imageCounter = 0;

  const rewritten = markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
    const placeholder = `${placeholderPrefix}${++imageCounter}`;
    images.push({
      alt,
      originalPath: src,
      placeholder,
    });
    return placeholder;
  });

  return { images, markdown: rewritten };
}

export function getImageExtension(urlOrPath: string): string {
  const match = urlOrPath.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i);
  return match ? match[1]!.toLowerCase() : "png";
}

function isPrivateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a! >= 224
    );
  }
  if (net.isIP(address) !== 6) return true;
  const value = address.toLowerCase().split("%")[0]!;
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  return value === "::" || value === "::1" || value.startsWith("fc") ||
    value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("2001:db8:");
}

async function resolveRemoteImage(url: string): Promise<{ parsed: URL; address: string; family: number }> {
  const parsed = new URL(url);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("Blocked unsafe image URL");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Blocked unsafe image URL");
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error("Blocked unsafe image URL");
  }
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Blocked unsafe image host");
  }
  return { parsed, ...addresses[0]! };
}

async function requestImage(url: string, redirectsRemaining: number): Promise<http.IncomingMessage> {
  const { parsed, address, family } = await resolveRemoteImage(url);
  const protocol = parsed.protocol === "https:" ? https : http;
  return await new Promise((resolve, reject) => {
    const request = protocol.get(parsed, {
      headers: { "User-Agent": "writing-agent-image-downloader/1.0" },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        if (!response.headers.location || redirectsRemaining <= 0) {
          reject(new Error("Too many image redirects"));
          return;
        }
        const target = new URL(response.headers.location, parsed).href;
        void requestImage(target, redirectsRemaining - 1).then(resolve).catch(reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Failed to download image: HTTP ${status}`));
        return;
      }
      resolve(response);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("Download timeout")));
    request.on("error", reject);
  });
}

function redactRemoteUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

export async function downloadFile(url: string, destPath: string): Promise<void> {
  const maxBytes = 10 * 1024 * 1024;
  const response = await requestImage(url, 3);
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    response.resume();
    throw new Error(`Blocked non-image content type: ${contentType || "missing"}`);
  }
  const declaredLength = Number(response.headers["content-length"] || 0);
  if (declaredLength > maxBytes) {
    response.resume();
    throw new Error("Image exceeds 10 MiB limit");
  }

  const tempPath = `${destPath}.part`;
  let bytes = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(tempPath, { flags: "wx" });
      const fail = (error: Error) => {
        response.destroy();
        file.destroy();
        reject(error);
      };
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          fail(new Error("Image exceeds 10 MiB limit"));
          return;
        }
        if (!file.write(chunk)) response.pause();
      });
      file.on("drain", () => response.resume());
      response.on("end", () => file.end(resolve));
      response.on("error", fail);
      file.on("error", fail);
    });
    fs.renameSync(tempPath, destPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export async function resolveImagePath(
  imagePath: string,
  baseDir: string,
  tempDir: string,
  logLabel = "baoyu-md",
): Promise<string> {
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    const hash = createHash("md5").update(imagePath).digest("hex").slice(0, 8);
    const ext = getImageExtension(imagePath);
    const localPath = path.join(tempDir, `remote_${hash}.${ext}`);

    if (!fs.existsSync(localPath)) {
      console.error(`[${logLabel}] Downloading: ${redactRemoteUrl(imagePath)}`);
      await downloadFile(imagePath, localPath);
    }
    return localPath;
  }

  const resolved = path.isAbsolute(imagePath)
    ? imagePath
    : path.resolve(baseDir, imagePath);
  return resolveLocalWithFallback(resolved, logLabel);
}

export async function resolveContentImages(
  images: ImagePlaceholder[],
  baseDir: string,
  tempDir: string,
  logLabel = "baoyu-md",
): Promise<ResolvedImageInfo[]> {
  const resolved: ResolvedImageInfo[] = [];

  for (const image of images) {
    resolved.push({
      ...image,
      localPath: await resolveImagePath(image.originalPath, baseDir, tempDir, logLabel),
    });
  }

  return resolved;
}

function resolveLocalWithFallback(resolved: string, logLabel: string): string {
  if (fs.existsSync(resolved)) {
    return resolved;
  }

  const ext = path.extname(resolved);
  const base = ext ? resolved.slice(0, -ext.length) : resolved;
  const alternatives = [
    `${base}.webp`,
    `${base}.jpg`,
    `${base}.jpeg`,
    `${base}.png`,
    `${base}.gif`,
    `${base}_original.png`,
    `${base}_original.jpg`,
  ].filter((candidate) => candidate !== resolved);

  for (const alternative of alternatives) {
    if (!fs.existsSync(alternative)) continue;
    console.error(
      `[${logLabel}] Image fallback: ${path.basename(resolved)} -> ${path.basename(alternative)}`,
    );
    return alternative;
  }

  return resolved;
}
