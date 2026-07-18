import OpenAI from "openai";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";
import { downloadFile } from "./vendor/markdown-to-html-core/src/images.ts";

// 配置 dotenv
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
  } catch {
    return "<invalid-url>";
  }
}

// 配置代理
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
const httpAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// API 配置
const API_BASE = process.env.GEMINI_API_BASE || process.env.THIRD_PARTY_API_BASE || "";
const MODEL_NAME = process.env.IMAGE_MODEL || "gemini-3-pro-image-preview";

interface GenerateImageOptions {
  prompt: string;
  outputPath: string;
  filename?: string;
}

async function saveBinaryFile(fileName: string, content: Buffer): Promise<void> {
  await writeFile(fileName, content);
  console.log(`✅ 图片已保存: ${fileName}`);
}

export function resolveOutputFile(outputPath: string, filename?: string): string {
  const selected = filename || `image_${Date.now()}.png`;
  if (
    !selected ||
    selected !== path.basename(selected) ||
    /[\\/\u0000-\u001f]/.test(selected) ||
    selected === "." ||
    selected === ".."
  ) {
    throw new Error("输出文件名必须是不含路径的普通文件名");
  }
  return path.join(path.resolve(outputPath), selected);
}

async function generateImage(options: GenerateImageOptions): Promise<string> {
  const { prompt, outputPath, filename } = options;

  // 确保输出目录存在
  if (!existsSync(outputPath)) {
    await mkdir(outputPath, { recursive: true });
  }

  console.log(`\n🎨 正在生成图片...`);
  console.log(`📝 提示词: ${prompt.substring(0, 100)}...`);
  if (proxyUrl) {
    console.log(`🔧 使用代理: ${redactUrl(proxyUrl)}`);
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.THIRD_PARTY_API_KEY;
  if (!apiKey) {
    throw new Error("API Key 未设置");
  }

  const isGoogle = API_BASE.includes("googleapis.com");
  const fullPath = resolveOutputFile(outputPath, filename);

  try {
    if (isGoogle) {
      // Google 官方 API
      let baseUrl = API_BASE.replace(/\/$/, "");
      baseUrl = baseUrl.replace(/\/openai$/, "");
      if (!baseUrl.includes("/v1beta")) {
        baseUrl = `${baseUrl}/v1beta`;
      }
      const url = `${baseUrl}/models/${MODEL_NAME}:generateContent`;

      const payload = {
        contents: [{ parts: [{ text: prompt }] }]
      };

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(payload),
        agent: httpAgent
      });

      if (!response.ok) {
        throw new Error(`Google API Error: HTTP ${response.status}`);
      }

      const data: any = await response.json();
      if (data.candidates?.[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
          if (part.inlineData?.mimeType?.startsWith("image")) {
            const buffer = Buffer.from(part.inlineData.data, "base64");
            await saveBinaryFile(fullPath, buffer);
            return fullPath;
          }
        }
      }
      throw new Error("Google API 响应中未找到图片");
    } else {
      // OpenAI 兼容接口
      const client = new OpenAI({
        baseURL: API_BASE,
        apiKey: apiKey,
        httpAgent: httpAgent,
      });

      const result = await client.images.generate({
        model: MODEL_NAME,
        prompt: prompt,
      });

      if (result.data?.[0]) {
        const img = result.data[0];
        if (img.b64_json) {
          const buffer = Buffer.from(img.b64_json, "base64");
          await saveBinaryFile(fullPath, buffer);
        } else if (img.url) {
          await downloadFile(img.url, fullPath);
        }
        return fullPath;
      }
      throw new Error("OpenAI API 响应中未找到图片");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message.split(apiKey).join("[REDACTED]");
    console.error("❌ 生成失败:", safeMessage);
    throw new Error(safeMessage);
  }

  return fullPath;
}

// CLI 入口
async function main() {
  const args = process.argv.slice(2);
  let prompt = "";
  let outputPath = "./output";
  let filename = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt" && args[i + 1]) {
      prompt = args[i + 1];
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1];
      i++;
    } else if (args[i] === "--filename" && args[i + 1]) {
      filename = args[i + 1];
      i++;
    }
  }

  if (!prompt) {
    console.log(`
用法:
  npx tsx scripts/generate_image.ts --prompt "<提示词>" [--output <目录>] [--filename <文件名>]
    `);
    process.exitCode = 1;
    return;
  }

  await generateImage({ prompt, outputPath, filename });
}

export { generateImage, GenerateImageOptions };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
