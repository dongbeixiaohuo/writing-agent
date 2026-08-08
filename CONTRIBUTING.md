# 贡献指南

感谢你考虑为 写稿Agent 做出贡献！

## 如何贡献

### 报告 Bug

如果你发现了 Bug，请在 [GitHub Issues](https://github.com/dongbeixiaohuo/writing-agent/issues) 提交，包含：

1. **Bug 描述**：清晰描述问题
2. **复现步骤**：如何触发这个 Bug
3. **预期行为**：你期望发生什么
4. **实际行为**：实际发生了什么
5. **环境信息**：
   - Claude Code 版本
   - 操作系统
   - 相关 Skill 版本

### 提交新功能建议

在 [GitHub Discussions](https://github.com/dongbeixiaohuo/writing-agent/discussions) 讨论你的想法，包含：

1. **功能描述**：你想要什么功能
2. **使用场景**：为什么需要这个功能
3. **实现思路**：（可选）你认为如何实现

### 提交代码

1. **Fork 项目**
   ```bash
   # 在 GitHub 上点击 Fork 按钮
   git clone https://github.com/dongbeixiaohuo/写稿Agent.git
   cd 写稿Agent
   ```

2. **创建特性分支**
   ```bash
   git checkout -b feature/你的功能名
   ```

3. **编写代码**
   - 遵循现有代码风格
   - 更新相关文档
   - 如果修改 Skill，更新版本号
   - 只修改 `claude-runtime/` 唯一源，再执行 `npm run sync:claude-runtime`，不要分别手改 `.claude/` 和插件镜像

4. **测试**
   - 执行 `npm ci`
   - 执行 `npm run check`
   - 涉及插件安装时，再执行联网隔离安装测试

5. **提交**
   ```bash
   git add .
   git commit -m "feat: 添加XXX功能"
   ```

6. **推送并创建 PR**
   ```bash
   git push origin feature/你的功能名
   # 在 GitHub 上创建 Pull Request
   ```

## Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式（不影响功能）
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建/工具相关

示例：
```
feat: 新增标题设计模块
fix: 修复字数统计误差问题
docs: 更新 FAQ 文档
```

## Skill 开发规范

如果你要添加新的 Skill：

1. **目录结构**
   ```
   claude-runtime/skills/你的Skill名/
   ├── SKILL.md          # Skill 定义文件
   └── README.md         # （可选）详细说明
   ```

2. **SKILL.md 格式**
   ```markdown
   ---
   name: skill-name
   description: 简短描述
   ---

   # Skill 名称

   ## 指令 (Instructions)
   [详细指令]

   ## 示例 (Examples)
   [使用示例]

   ## 最佳实践 (Best Practices)
   [最佳实践]

   ## 版本记录 (Version History)
   [版本历史]
   ```

3. **版本号规范**
   - 新 Skill 从 v1.0.0 开始
   - 遵循语义化版本号

## 文档规范

- 使用 Markdown 格式
- 中文文档优先
- 提供清晰的示例
- 更新 CHANGELOG.md

## 代码审查

所有 PR 都会经过审查，审查重点：

- 功能是否符合项目目标
- 代码质量
- 文档完整性
- 是否破坏现有功能

## 行为准则

- 尊重所有贡献者
- 建设性反馈
- 欢迎新手
- 禁止骚扰和歧视

## 许可证

提交代码即表示你同意将代码以 MIT 许可证发布。

---

**有问题？** 在 [Discussions](https://github.com/dongbeixiaohuo/writing-agent/discussions) 提问。
