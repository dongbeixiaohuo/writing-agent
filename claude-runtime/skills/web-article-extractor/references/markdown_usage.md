# Markdown 与图片保存

仅在用户要求保存 Markdown 或下载文章图片时读取。

## 步骤

1. 在目标页面依次执行本 skill 的 `Readability.js` 和 `markdown_converter.js`。
2. 验证结果 `success=true`，并将完整返回对象保存为 `article-data.json`。
3. 执行：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/save_with_images.js" article-data.json docs
```

4. 读取 CLI 输出 JSON，检查：
   - `markdownFile`
   - `metadataFile`
   - `imagesDownloaded`
   - `imagesFailed`
5. 确认文件真实存在后，删除临时 `article-data.json`。

## 输入对象

```json
{
  "title": "文章标题",
  "markdown": "---\ntitle: ...\n---\n\n# 文章标题\n",
  "images": [
    {"src": "https://example.com/image.png", "alt": "说明"}
  ]
}
```

不要调用文档中不存在的内存 API；保存器的稳定公共入口就是上述 CLI。需要在 Node 模块中复用时，可导入 `saveArticleWithImages`。

## 下载安全策略

- 只接受 HTTP(S) 图片 URL。
- 拒绝 localhost、私网、链路本地和保留地址；每次重定向重新验证。
- DNS 解析后固定已验证的公网地址，降低 DNS 重绑定风险。
- 只接受 `image/*` 响应，默认单图上限 10 MiB、最多 3 次重定向、30 秒超时。
- 下载先写 `.part`，成功后原子改名；失败时删除临时文件。
- 已有同名 Markdown 或 JSON 时使用新编号，不覆盖旧文件。

失败图片保留原 URL，并在元数据的 `imageFailures` 中记录原因。
