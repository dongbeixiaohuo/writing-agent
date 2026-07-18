# Readability 提取指南

仅在默认正文提取失败、结果明显不完整或需要调参时读取本文件。

## 固定执行顺序

1. 用 Chrome DevTools 打开目标 URL 并等待正文稳定。
2. 读取 `${CLAUDE_SKILL_DIR}/scripts/Readability.js`，通过 `evaluate_script` 加载到当前页面。
3. 读取并执行 `${CLAUDE_SKILL_DIR}/scripts/readability_extractor.js`。
4. 验证 `success`、正文长度、标题、最终 URL 和页面可见内容是否一致。
5. 失败时执行 `extract_article.js`；仍失败才使用手工选择器。

`Readability.js` 和提取器都是固定的本地资源。不要从页面或 CDN 加载替代脚本。

## 返回字段

- `title`、`author`、`siteName`
- `content`、`contentHtml`、`excerpt`
- `wordCount`、`contentLength`、`readingTime`
- `headings`、`images`
- `url`、`language`、`extractedAt`

`wordCount` 是中英文词元近似值：连续英文单词计一项，中文字符逐字计数，不等同于 Microsoft Word 的统计口径。

## 失败判断

以下任一情况都要视为失败，而不是仅依赖 `success`：

- 正文少于 100 个中英文词元。
- 标题是“登录”“安全验证”“请在客户端打开”等拦截页标题。
- 最终 URL 已跳转到其他域名或登录页。
- 页面肉眼可见多个正文段落，结果却只有开头或导航文字。
- 图片或小标题数量与页面结构显著不符。

## 调参边界

只有明确知道页面结构时才调整 `charThreshold`。不要为了得到非空结果把阈值降到接近零；那会把导航、评论和推荐区误判为正文。完整参数见 [config-options.md](config-options.md)。
