## 用途

本技能用于**创建新的 inner_skill**。当你需要新增一个可被 AI 调用的技能模块时，使用本技能可以自动生成标准化的 skill 目录结构、配置文件和代码骨架，无需手动拼接样板代码。

### 可用工具

| 工具 | 功能 | 典型输出 |
|------|------|----------|
| `create_skill` | **创建**一个新的 skill，生成目录结构、配置、文档和代码骨架 | 新 skill 的路径和文件清单 |
| `list_skills` | **列出**所有已注册的 inner_skills 及其启用状态 | 技能名 + 启用状态 |
| `skill_creator_prompt_get` | **获取**本技能的完整说明文档（SKILL.md） | SKILL.md 内容 |

### 使用流程建议

```
1. list_skills → 确认新技能名不重复
2. create_skill(skillName, tools) → 生成完整技能骨架
3. 编辑生成的工具实现文件，填充具体逻辑
```

### 生成的文件结构

```
src/tools/inner_skills/<skill-name>/
  enable.json          # 启用配置 {"enable":true}
  SKILL.md             # 技能说明文档（需补充具体内容）
  references/          # 参考文件目录（可存放示例、模板等）
  index.ts             # 入口，导出 tools 对象（自动注入 prompt-get）
  <tool-name>.ts       # 各工具的实现文件（每个工具一个文件）
  prompt-get.ts        # [自动生成] 获取本技能 SKILL.md 的工具
```

### 自动注入的 prompt-get

每个新建技能都自动附带 `prompt-get` 工具，名称为 `<skill-dir>-prompt-get`（例如 `my-analyzer-prompt-get`），用于在上下文中随时获取该技能的使用说明。无需手动定义，`index.ts` 中自动注册。
