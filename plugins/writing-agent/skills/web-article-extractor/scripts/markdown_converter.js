/**
 * Convert the current article to Markdown without loading executable CDN code.
 * Evaluate Readability.js in the page before evaluating this file.
 */

(function convertCurrentArticleToMarkdown() {
  function countWords(text) {
    const value = String(text || "").trim();
    if (!value) return 0;
    const cjk = value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || [];
    const latin = value
      .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ")
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
    return cjk.length + latin.length;
  }

  function yamlString(value) {
    return `"${String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n]+/g, " ")}"`;
  }

  function safePageUrl(value) {
    try {
      const parsed = new URL(value, window.location.href);
      return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function normalizeMarkdown(value) {
    return value
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function nodeToMarkdown(node, images) {
    if (node.nodeType === 3) {
      return node.textContent || "";
    }
    if (node.nodeType !== 1) {
      return "";
    }

    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes)
      .map((child) => nodeToMarkdown(child, images))
      .join("");

    if (/^h[1-6]$/.test(tag)) {
      return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    }
    if (["p", "div", "section", "article", "figure", "figcaption"].includes(tag)) {
      return `\n\n${children().trim()}\n\n`;
    }
    if (tag === "br") return "\n";
    if (["strong", "b"].includes(tag)) return `**${children().trim()}**`;
    if (["em", "i"].includes(tag)) return `*${children().trim()}*`;
    if (tag === "blockquote") {
      return `\n\n${children().trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "pre") return `\n\n\`\`\`\n${node.textContent || ""}\n\`\`\`\n\n`;
    if (tag === "code") return `\`${children().trim()}\``;
    if (tag === "li") return `\n- ${children().trim()}`;
    if (["ul", "ol"].includes(tag)) return `\n${children()}\n`;
    if (tag === "a") {
      const label = children().trim();
      const href = safePageUrl(node.getAttribute("href") || "");
      return href ? `[${label || href}](${href})` : label;
    }
    if (tag === "img") {
      const src = safePageUrl(
        node.currentSrc || node.getAttribute("src") || node.getAttribute("data-src") || "",
      );
      if (!src) return "";
      const image = { src, alt: node.getAttribute("alt") || "", title: node.getAttribute("title") || "" };
      images.push(image);
      return `![${image.alt.replace(/[\[\]]/g, "")}](${src})`;
    }
    if (["script", "style", "noscript", "iframe", "object", "embed", "form"].includes(tag)) {
      return "";
    }
    return children();
  }

  try {
    if (typeof globalThis.Readability !== "function") {
      throw new Error("Readability is not loaded; evaluate scripts/Readability.js first");
    }
    const article = new globalThis.Readability(document.cloneNode(true), {
      charThreshold: 500,
      keepClasses: false,
    }).parse();
    if (!article) throw new Error("Readability could not identify an article");

    const container = document.createElement("div");
    container.innerHTML = article.content;
    const images = [];
    const bodyMarkdown = normalizeMarkdown(nodeToMarkdown(container, images));
    const canonicalUrl = safePageUrl(
      document.querySelector('link[rel="canonical"]')?.href || window.location.href,
    );
    const wordCount = countWords(article.textContent);
    const frontmatter = [
      "---",
      `title: ${yamlString(article.title)}`,
      article.byline ? `author: ${yamlString(article.byline)}` : "",
      article.siteName ? `source: ${yamlString(article.siteName)}` : "",
      `url: ${yamlString(canonicalUrl)}`,
      "---",
    ].filter(Boolean).join("\n");
    const markdown = `${frontmatter}\n\n# ${article.title}\n\n${bodyMarkdown}\n`;

    return {
      success: true,
      markdown,
      title: article.title,
      author: article.byline || null,
      siteName: article.siteName || null,
      url: window.location.href,
      canonicalUrl,
      excerpt: article.excerpt || null,
      wordCount,
      readingTime: Math.max(1, Math.ceil(wordCount / 300)),
      images,
      imageCount: images.length,
      extractedAt: new Date().toISOString(),
      extractionMethod: "readability-vendored+dom-markdown",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      url: window.location.href,
      extractionMethod: "readability-vendored+dom-markdown",
    };
  }
})();
