# Readability 配置选项完整说明

根据 Mozilla 官方文档，`new Readability(document, options)` 支持以下配置选项：

## 配置选项表

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| **debug** | `boolean` | `false` | 是否启用调试日志输出到控制台 |
| **maxElemsToParse** | `number` | `0` | 最大解析元素数量限制（0 = 无限制） |
| **nbTopCandidates** | `number` | `5` | 分析候选内容时考虑的顶级候选者数量 |
| **charThreshold** | `number` | `500` | 文章必须达到的最小字符数才返回结果 |
| **classesToPreserve** | `string[]` | `[]` | 保留的 CSS 类名数组（当 keepClasses 为 false 时） |
| **keepClasses** | `boolean` | `false` | 是否保留所有 HTML 元素的 class 属性 |
| **disableJSONLD** | `boolean` | `false` | 禁用 JSON-LD 格式的 Schema.org 元数据解析 |
| **serializer** | `function` | `el => el.innerHTML` | 自定义内容序列化函数 |
| **allowedVideoRegex** | `RegExp` | 内置正则 | 允许保留的视频 URL 正则表达式 |
| **linkDensityModifier** | `number` | `0` | 链接密度阈值修正值（正数提高阈值，负数降低） |

## 配置示例

### 基础配置（推荐默认）

```javascript
const reader = new Readability(documentClone, {
  debug: false,
  charThreshold: 500
});
```

### 严格模式（高质量文章）

```javascript
const reader = new Readability(documentClone, {
  charThreshold: 1000,      // 更高的字符要求
  nbTopCandidates: 10,      // 更多候选者分析
  linkDensityModifier: -0.2 // 降低链接密度容忍度
});
```

### 宽松模式（短文章）

```javascript
const reader = new Readability(documentClone, {
  charThreshold: 200,       // 较低的字符要求
  maxElemsToParse: 5000,    // 限制解析元素数
  linkDensityModifier: 0.3  // 提高链接密度容忍度
});
```

### 保留样式类（用于进一步处理）

```javascript
const reader = new Readability(documentClone, {
  keepClasses: false,
  classesToPreserve: [
    'caption',     // 图片说明
    'credit',      // 图片版权
    'figure',      // 图片容器
    'highlight',   // 高亮文本
    'pullquote',   // 引用块
    'code-block'   // 代码块
  ]
});
```

### 返回 DOM 元素而非 HTML 字符串

```javascript
const reader = new Readability(documentClone, {
  serializer: el => el  // 返回 DOM 元素本身
});

const article = reader.parse();
// article.content 现在是 DOM Element，可以进一步处理
```

### 自定义视频 URL 白名单

```javascript
const reader = new Readability(documentClone, {
  allowedVideoRegex: /\/\/(youtube|vimeo|bilibili|youku)\.com/i
});
```

## 针对不同网站类型的配置策略

| 网站类型 | 推荐配置 |
|---------|---------|
| **新闻网站** | `charThreshold: 500`, `nbTopCandidates: 8` |
| **博客文章** | `charThreshold: 300`, 默认配置 |
| **学术论文** | `charThreshold: 1500`, `keepClasses: true` |
| **社交媒体** | 使用简化算法（Readability 可能过滤过多） |
| **知乎/掘金** | `charThreshold: 300`, `classesToPreserve: ['RichText']` |

## 动态调整配置

```javascript
async function smartExtract(url, pageType) {
  const configs = {
    'blog': { charThreshold: 300, linkDensityModifier: 0 },
    'news': { charThreshold: 500, nbTopCandidates: 8 },
    'academic': { charThreshold: 1500, disableJSONLD: false },
    'social': { charThreshold: 100, linkDensityModifier: 0.5 }
  };

  const config = configs[pageType] || configs['blog'];
  const reader = new Readability(documentClone, config);
  return reader.parse();
}
```

## 调试技巧

### 启用调试模式

```javascript
const reader = new Readability(documentClone, {
  debug: true  // 在控制台输出详细日志
});
```

### 对比不同配置的效果

```typescript
async function compareConfigs(url) {
  const configs = [
    { name: '默认', options: {} },
    { name: '严格', options: { charThreshold: 1000 } },
    { name: '宽松', options: { charThreshold: 200 } }
  ];

  for (const config of configs) {
    const reader = new Readability(doc.cloneNode(true), config.options);
    const result = reader.parse();
    console.log(`${config.name}:`, {
      contentLength: result?.length,
      title: result?.title
    });
  }
}
```
