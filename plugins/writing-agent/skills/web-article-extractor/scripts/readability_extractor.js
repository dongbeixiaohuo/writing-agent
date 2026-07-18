/**
 * Extract the current page with the vendored Mozilla Readability runtime.
 * Evaluate Readability.js in the page before evaluating this file.
 */

(function extractReadableArticle() {
  function countWords(text) {
    const value = String(text || "").trim();
    if (!value) return 0;
    const cjk = value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || [];
    const latin = value
      .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ")
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
    return cjk.length + latin.length;
  }

  try {
    if (typeof globalThis.Readability !== "function") {
      throw new Error("Readability is not loaded; evaluate scripts/Readability.js first");
    }

    const reader = new globalThis.Readability(document.cloneNode(true), {
      debug: false,
      charThreshold: 500,
      keepClasses: false,
    });
    const article = reader.parse();
    if (!article) {
      throw new Error("Readability could not identify an article");
    }

    const container = document.createElement("div");
    container.innerHTML = article.content;
    const images = Array.from(container.querySelectorAll("img"))
      .map((image) => ({
        src: image.currentSrc || image.src || image.getAttribute("data-src") || "",
        alt: image.alt || "",
        title: image.title || "",
      }))
      .filter((image) => /^https?:\/\//i.test(image.src));
    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: (heading.textContent || "").trim(),
      }))
      .filter((heading) => heading.text);
    const wordCount = countWords(article.textContent);

    return {
      success: true,
      extractionMethod: "readability-vendored",
      extractedAt: new Date().toISOString(),
      title: article.title,
      content: article.textContent,
      contentHtml: article.content,
      excerpt: article.excerpt || article.textContent.slice(0, 300),
      author: article.byline || null,
      publishedTime: article.publishedTime || null,
      siteName: article.siteName || null,
      language: article.lang || document.documentElement.lang || null,
      dir: article.dir || null,
      wordCount,
      contentLength: article.length,
      readingTime: Math.max(1, Math.ceil(wordCount / 300)),
      headings,
      images,
      url: window.location.href,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      extractionMethod: "readability-vendored",
      url: window.location.href,
    };
  }
})();
