/**
 * Web Article Content Extractor
 * 
 * Extracts main article content using a simplified Readability-like algorithm.
 * Returns structured data including title, author, content, and metadata.
 */

(function() {
  function countWords(text) {
    const value = String(text || '').trim();
    if (!value) return 0;
    const cjk = value.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || [];
    const latin = value
      .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ')
      .match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [];
    return cjk.length + latin.length;
  }

  // Helper: Calculate text density score
  function getTextDensity(element) {
    const text = element.innerText || '';
    const html = element.innerHTML || '';
    return text.length / Math.max(html.length, 1);
  }

  // Helper: Count paragraphs
  function countParagraphs(element) {
    return element.querySelectorAll('p').length;
  }

  // Helper: Get clean text
  function getCleanText(element) {
    // Remove script and style elements
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script, style, nav, header, footer, aside, .ad, .advertisement, .social-share, .comments').forEach(el => el.remove());
    return clone.innerText.trim();
  }

  // Find main article container
  function findArticleContainer() {
    // Try common article selectors first
    const selectors = [
      'article[role="main"]',
      'article.post-content',
      'article.entry-content',
      'main article',
      '[role="main"] article',
      'article',
      'main',
      '[role="main"]',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.content-body',
      '#article',
      '#content',
      '.story-body'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && countParagraphs(element) >= 2) {
        return element;
      }
    }

    // Fallback: Find element with highest paragraph count and text density
    const candidates = Array.from(document.querySelectorAll('div, section, article'));
    let bestCandidate = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const paragraphCount = countParagraphs(candidate);
      const textDensity = getTextDensity(candidate);
      const score = paragraphCount * textDensity;

      if (score > bestScore && paragraphCount >= 3) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    return bestCandidate || document.body;
  }

  // Extract metadata
  function extractMetadata() {
    const metadata = {};

    // Title
    metadata.title = 
      document.querySelector('h1')?.innerText ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('meta[name="twitter:title"]')?.content ||
      document.title;

    // Author
    metadata.author = 
      document.querySelector('[rel="author"]')?.innerText ||
      document.querySelector('meta[name="author"]')?.content ||
      document.querySelector('.author-name')?.innerText ||
      document.querySelector('.byline')?.innerText ||
      null;

    // Publish date
    metadata.publishDate = 
      document.querySelector('time')?.getAttribute('datetime') ||
      document.querySelector('meta[property="article:published_time"]')?.content ||
      document.querySelector('.publish-date')?.innerText ||
      null;

    // Description
    metadata.description = 
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      null;

    // Images
    const mainContainer = findArticleContainer();
    const images = Array.from(mainContainer.querySelectorAll('img'))
      .map(img => ({
        src: img.src,
        alt: img.alt || null,
        width: img.naturalWidth || null,
        height: img.naturalHeight || null
      }))
      .filter(img => img.width > 200 && img.height > 200); // Filter small images

    metadata.images = images;

    // Tags/Categories
    const keywords = document.querySelector('meta[name="keywords"]')?.content;
    metadata.tags = keywords ? keywords.split(',').map(t => t.trim()) : [];

    return metadata;
  }

  // Main extraction
  try {
    const container = findArticleContainer();
    const metadata = extractMetadata();
    
    // Get clean content
    const content = getCleanText(container);

    // Extract headings structure
    const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map(h => ({
        level: parseInt(h.tagName.substring(1)),
        text: h.innerText.trim()
      }));

    return {
      success: true,
      title: metadata.title,
      author: metadata.author,
      publishDate: metadata.publishDate,
      description: metadata.description,
      content: content,
      contentLength: content.length,
      wordCount: countWords(content),
      images: metadata.images,
      tags: metadata.tags,
      headings: headings,
      url: window.location.href,
      extractedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      fallbackContent: document.body.innerText.substring(0, 5000)
    };
  }
})();
