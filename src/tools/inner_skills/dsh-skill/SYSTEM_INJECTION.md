## dsh skill 兼容层

本环境可加载 dsh（DeepSeek Harness）规范的 skill：目录形态 `<name>/SKILL.md` 或扁平 `<name>.md`，首部 YAML frontmatter 声明 `name` 与 `description`，正文为指令文档。

- 用 `dsh_skill_catalog` 查看可用 dsh skill 目录（name + description + 适用场景）
- 任务与某个 skill 相关时，用 `dsh_skill({name})` 加载其完整正文，并遵循其中的指令
- skill 正文可能引用其目录下的资源（scripts/references 等），需要时用文件工具按返回的资源基准目录读取
- 同一时间只加载与当前任务相关的 skill，不要批量加载无关 skill
- 发现位置：工作区 `.dsh/skills/`、`.agents/skills/`、`SEEK_DSH_SKILL_DIRS` 指定目录、`~/.dsh/skills`、`~/.agents/skills`
