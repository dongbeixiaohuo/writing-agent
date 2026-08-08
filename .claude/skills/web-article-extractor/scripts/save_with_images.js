/**
 * Save extracted article JSON as Markdown and optionally download remote images.
 * Runs as an ES module because the repository declares `type: module`.
 */

import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveSafeAddress, safeLookup } from "./remote_url_policy.js";

export { isSafeRemoteUrl } from "./remote_url_policy.js";

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

async function openImageResponse(value, redirectsRemaining) {
  const parsed = new URL(value);
  const resolved = await resolveSafeAddress(parsed);
  const client = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(
      parsed,
      {
        lookup: safeLookup(resolved.address, resolved.family),
        headers: { "User-Agent": "writing-agent-image-downloader/1.0" },
      },
      async (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.resume();
          if (redirectsRemaining <= 0 || !response.headers.location) {
            reject(new Error("Too many image redirects"));
            return;
          }
          try {
            const redirectUrl = new URL(response.headers.location, parsed).href;
            resolve(await openImageResponse(redirectUrl, redirectsRemaining - 1));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Image request failed with HTTP ${status}`));
          return;
        }
        resolve(response);
      },
    );
    request.setTimeout(30_000, () => request.destroy(new Error("Image download timeout")));
    request.on("error", reject);
  });
}

export async function downloadImage(
  value,
  filepath,
  { maxBytes = DEFAULT_MAX_IMAGE_BYTES, maxRedirects = DEFAULT_MAX_REDIRECTS } = {},
) {
  const response = await openImageResponse(value, maxRedirects);
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    response.resume();
    throw new Error(`Blocked non-image content type: ${contentType || "missing"}`);
  }
  const declaredLength = Number(response.headers["content-length"] || 0);
  if (declaredLength > maxBytes) {
    response.resume();
    throw new Error(`Image exceeds ${maxBytes} byte limit`);
  }

  const temporaryPath = `${filepath}.part`;
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  let bytes = 0;
  try {
    await new Promise((resolve, reject) => {
      const output = createWriteStream(temporaryPath, { flags: "wx" });
      const fail = (error) => {
        response.destroy();
        output.destroy();
        reject(error);
      };
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          fail(new Error(`Image exceeds ${maxBytes} byte limit`));
          return;
        }
        if (!output.write(chunk)) response.pause();
      });
      output.on("drain", () => response.resume());
      response.on("end", () => output.end(resolve));
      response.on("error", fail);
      output.on("error", fail);
    });
    await fs.rename(temporaryPath, filepath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

export function generateFilename(value, index) {
  try {
    const parsed = new URL(value);
    const rawExtension = path.extname(parsed.pathname).toLowerCase();
    const extension = /^\.(?:avif|gif|jpe?g|png|webp)$/.test(rawExtension) ? rawExtension : ".img";
    const basename = path.basename(parsed.pathname, rawExtension).replace(/[^a-zA-Z0-9-_]/g, "");
    return `image-${index}-${basename || "asset"}${extension}`;
  } catch {
    return `image-${index}-asset.img`;
  }
}

export function sanitizeFilename(filename) {
  const sanitized = String(filename || "article")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 160);
  return sanitized || "article";
}

export function resolveImagesSubdir(value = "images") {
  const raw = String(value || "images").trim();
  const portable = raw.replace(/\\/g, "/");
  const segments = portable.split("/");
  if (
    !raw ||
    path.isAbsolute(raw) ||
    /^[a-zA-Z]:/.test(raw) ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    /[\u0000-\u001f<>:"|?*]/.test(raw)
  ) {
    throw new Error("图片子目录必须是输出目录内的相对路径");
  }
  return segments.join(path.sep);
}

async function uniqueOutputStem(outputDir, initialStem) {
  let stem = initialStem;
  for (let suffix = 2; ; suffix += 1) {
    const markdownPath = path.join(outputDir, `${stem}.md`);
    const metadataPath = path.join(outputDir, `${stem}.json`);
    const [markdownExists, metadataExists] = await Promise.all([
      fs.access(markdownPath).then(() => true, () => false),
      fs.access(metadataPath).then(() => true, () => false),
    ]);
    if (!markdownExists && !metadataExists) {
      return stem;
    }
    stem = `${initialStem}-${suffix}`;
  }
}

export async function saveArticleWithImages(articleData, outputDir, options = {}) {
  const downloadImages = options.downloadImages !== false;
  const imagesSubdir = resolveImagesSubdir(options.imagesSubdir || "images");
  const portableImagesSubdir = imagesSubdir.split(path.sep).join("/");
  const maxConcurrentDownloads = Math.max(1, Math.min(Number(options.maxConcurrentDownloads) || 3, 5));
  const maxImageBytes = Number(options.maxImageBytes) || DEFAULT_MAX_IMAGE_BYTES;

  await fs.mkdir(outputDir, { recursive: true });
  let markdown = String(articleData.markdown || "");
  const downloadedImages = [];
  const failures = [];
  const images = Array.isArray(articleData.images) ? articleData.images : [];

  if (downloadImages && images.length) {
    const imagesDir = path.join(outputDir, imagesSubdir);
    await fs.mkdir(imagesDir, { recursive: true });
    for (let offset = 0; offset < images.length; offset += maxConcurrentDownloads) {
      const batch = images.slice(offset, offset + maxConcurrentDownloads);
      await Promise.all(batch.map(async (image, batchIndex) => {
        const index = offset + batchIndex;
        const source = String(image?.src || "");
        const filename = generateFilename(source, index);
        const filepath = path.join(imagesDir, filename);
        const relativePath = path.posix.join(portableImagesSubdir, filename);
        try {
          await downloadImage(source, filepath, { maxBytes: maxImageBytes });
          downloadedImages.push({ original: source, local: relativePath, alt: image.alt || "" });
          markdown = markdown.split(source).join(relativePath);
        } catch (error) {
          failures.push({ image: source, error: error instanceof Error ? error.message : String(error) });
        }
      }));
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const stem = await uniqueOutputStem(outputDir, `${date}-${sanitizeFilename(articleData.title)}`);
  const markdownPath = path.join(outputDir, `${stem}.md`);
  const metadataPath = path.join(outputDir, `${stem}.json`);
  await fs.writeFile(markdownPath, markdown, "utf8");
  await fs.writeFile(
    metadataPath,
    JSON.stringify({
      ...articleData,
      markdown: undefined,
      downloadedImages,
      imageFailures: failures,
      savedAt: new Date().toISOString(),
      files: { markdown: path.basename(markdownPath), imagesDir: downloadImages ? portableImagesSubdir : null },
    }, null, 2),
    "utf8",
  );

  return {
    success: true,
    outputDir,
    markdownFile: markdownPath,
    metadataFile: metadataPath,
    imagesDownloaded: downloadedImages.length,
    imagesFailed: failures.length,
    totalImages: images.length,
  };
}

async function main() {
  const [dataFile, outputDir] = process.argv.slice(2);
  if (!dataFile || !outputDir) {
    console.error("Usage: node save_with_images.js <article-data.json> <output-dir>");
    process.exitCode = 1;
    return;
  }
  const articleData = JSON.parse(await fs.readFile(dataFile, "utf8"));
  const result = await saveArticleWithImages(articleData, outputDir);
  console.log(JSON.stringify(result, null, 2));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
