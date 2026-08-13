# dsh-skill

dsh（DeepSeek Harness）skill 兼容层：让按 dsh 规范编写的 skill（SKILL.md + YAML frontmatter）无缝接入 seek-agent。

## 用途

dsh 生态的 skill 是纯指令文档：目录形态 `<name>/SKILL.md` 或扁平形态 `<name>.md`，首部 YAML frontmatter 声明 `name`（kebab-case 必填）/ `description`（必填）/ `whenToUse`（可选）/ `disable-model-invocation`（可选）/ `user-invocable`（可选）/ `metadata`（可选）。本 skill 按 dsh 的发现根规范扫描并解析这些文件，把正文作为按需加载的指令提供给模型。

## 可用工具

| 工具 | 功能 |
|------|------|
| `dsh_skill_catalog` | 列出所有已发现的 dsh skill（name + description + whenToUse + 来源） |
| `dsh_skill` | 按名称加载某个 dsh skill 的完整正文（`<skill_content>` 指令块 + 资源基准目录） |

## 发现位置（按优先级）

1. 工作区（git 根）`.dsh/skills/`（project-dsh）
2. 工作区（git 根）`.agents/skills/`（project-agents）
3. 环境变量 `SEEK_DSH_SKILL_DIRS` 指定的目录（分号/逗号分隔，custom）
4. `~/.dsh/skills/`（user-dsh）
5. `~/.agents/skills/`（user-agents）

同名 skill 按 rank 优先（rank 小的赢）；解析失败（缺 frontmatter/缺 name/非法名称）静默跳过。

## 与 dsh 原版的一致性

- frontmatter 规则与 `deepseek-harness/packages/skill/skill-filesystem/src/index.ts` 的 `parseSkillFile` 对齐
- 目录发现 rank 与 `roots()` 对齐（100/200/300/400/500）
- `dsh_skill` 返回格式对齐 dsh tool-skill 的 `<skill_content>` / `<skill_resources>` / `<skill_instructions>` 三段

## 使用流程

```
1. 模型判断任务可能匹配某个 dsh skill → dsh_skill_catalog 查看目录
2. 命中 → dsh_skill({name}) 加载正文
3. 遵循正文指令；需要资源（scripts/references）时用文件工具按资源基准目录读取
4. 无关 skill 不加载
```
