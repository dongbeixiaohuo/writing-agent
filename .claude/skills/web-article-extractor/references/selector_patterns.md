# Common Selector Patterns for Article Extraction

This reference provides CSS selector patterns for identifying main article content across popular website platforms and content management systems.

## Generic Patterns

### Semantic HTML5
```css
article                    /* Most modern sites */
main                       /* Main content area */
[role="main"]             /* ARIA main role */
article[role="main"]      /* Combined approach */
```

### Common Class Names
```css
.article-content          /* Generic article wrapper */
.post-content            /* Blog posts */
.entry-content           /* WordPress default */
.content-body            /* News sites */
.story-body              /* News articles */
.article-body            /* Magazine style */
```

### Common IDs
```css
#article                  /* Simple article ID */
#content                 /* Generic content */
#main-content            /* Main content area */
#post-content            /* Blog posts */
```

## Platform-Specific Patterns

### WordPress
```css
.entry-content           /* Default theme */
.post-content            /* Many themes */
article.post             /* Post wrapper */
.hentry                  /* hAtom microformat */
.single-post             /* Single post pages */
```

### Medium
```css
article                  /* Main article tag */
.postArticle-content    /* Article content */
section[data-field]     /* Content sections */
```

### Ghost
```css
.post-content           /* Main content */
.kg-card                /* Ghost cards */
article.post            /* Post wrapper */
```

### Substack
```css
.post-content           /* Article content */
.body                   /* Content body */
.available-content      /* Available content */
```

### Blogger
```css
.post-body              /* Post content */
.entry-content          /* Alternative */
article.post            /* Post wrapper */
```

## News Sites

### General News
```css
.story-body             /* Common pattern */
.article-body           /* Article content */
.article-text           /* Text content */
#article-body           /* ID-based */
[itemprop="articleBody"] /* Schema.org */
```

### New York Times
```css
.StoryBodyCompanionColumn  /* Article text */
article section            /* Content sections */
```

### The Guardian
```css
.article-body-commercial-selector  /* Main content */
.content__article-body            /* Alternative */
```

### BBC
```css
.story-body             /* Article body */
article[role="article"] /* Semantic article */
```

## Technical Documentation

### Read the Docs
```css
.document               /* Main document */
.body                   /* Content body */
[role="main"]          /* Main content */
```

### GitBook
```css
.page-inner            /* Page content */
.markdown-section      /* Markdown content */
```

### Docusaurus
```css
.markdown              /* Markdown content */
article                /* Article wrapper */
.theme-doc-markdown    /* Themed markdown */
```

## Metadata Selectors

### Title
```css
h1                                    /* Main heading */
meta[property="og:title"]            /* Open Graph */
meta[name="twitter:title"]           /* Twitter Card */
```

### Author
```css
[rel="author"]                       /* Link to author */
.author-name                         /* Author name */
.byline                             /* Byline */
meta[name="author"]                 /* Meta author */
[itemprop="author"]                 /* Schema.org */
```

### Date
```css
time                                 /* HTML5 time element */
time[datetime]                       /* With datetime attr */
.publish-date                        /* Publish date class */
.entry-date                         /* Entry date */
meta[property="article:published_time"]  /* Open Graph */
[itemprop="datePublished"]          /* Schema.org */
```

### Description
```css
meta[name="description"]             /* Meta description */
meta[property="og:description"]      /* Open Graph */
meta[name="twitter:description"]     /* Twitter Card */
.article-subtitle                    /* Subtitle */
.entry-summary                       /* Summary */
```

### Images
```css
article img                          /* Images in article */
.article-image                       /* Article images */
[itemprop="image"]                  /* Schema.org */
meta[property="og:image"]           /* Open Graph */
```

## Elements to Exclude

### Navigation & UI
```css
nav                     /* Navigation */
header                  /* Page header */
footer                  /* Page footer */
aside                   /* Sidebar */
.sidebar               /* Sidebar class */
.menu                  /* Menus */
```

### Advertisements
```css
.ad                    /* Ad class */
.advertisement         /* Advertisement */
.sponsored             /* Sponsored content */
[id*="ad"]            /* IDs containing 'ad' */
.promo                /* Promotions */
```

### Social & Comments
```css
.social-share          /* Social sharing */
.share-buttons        /* Share buttons */
.comments             /* Comments section */
.related-posts        /* Related posts */
.recommended          /* Recommendations */
```

## Best Practices

1. **Priority Order**: Try semantic selectors first (article, main), then common classes, then fallback to heuristics
2. **Multiple Selectors**: Use comma-separated list to try multiple patterns
3. **Validation**: Check if selected element has sufficient paragraph count (≥2-3)
4. **Text Density**: Calculate text-to-HTML ratio to identify content-rich elements
5. **Fallback**: Always have a fallback to document.body if no good match found
6. **Context**: Consider page type (blog post vs news article vs documentation)

## Heuristic Approach

When selectors fail, use algorithmic approach:

```javascript
// Find element with highest content score
function scoreElement(element) {
  const paragraphCount = element.querySelectorAll('p').length;
  const textLength = element.innerText.length;
  const linkDensity = calculateLinkDensity(element);
  
  return (paragraphCount * textLength) / (1 + linkDensity);
}
```

Factors to consider:
- Paragraph count (more is better)
- Text length (longer is better)
- Link density (lower is better for articles)
- Text-to-HTML ratio (higher is better)
- Position in DOM (center/main area preferred)
