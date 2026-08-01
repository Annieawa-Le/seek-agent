# 预制员工库（Manager 模式参考）

Manager 模式在拆解任务后，可以从这里挑选预制员工直接 `spawn_worker`，无需每次重写提示词。
每位员工都有自己的**名字和性格**；每个文件包含：**名字**、**性格**、**角色定位**、
**适用场景**、**systemPrompt 模板**（`----SYSTEM_PROMPT_START/END----` 包裹）与
**推荐工具组**（`----TOOLS_START/END----` 包裹，JSON 数组）。

> 提示：也可以调用 `list_workers` / `get_worker` / `spawn_worker` 工具快速查询与创建，不必手动读文件。

## 员工清单

| 名字 | 员工 id | 角色 | 性格 | 一句话定位 |
|------|---------|------|------|-----------|
| 小码 | `code-implementer` | 代码实现员 | 专注实干，讨厌废话 | 按需求实现代码，遵循项目现有模式 |
| 老审 | `code-reviewer` | 代码审查员 | 毒舌但专业，只讲证据 | 只读审查代码质量与正确性，输出报告 |
| 阿修 | `bug-fixer` | Bug 修复员 | 侦探型，不找到根因不罢休 | 复现→定位根因→最小修复→验证闭环 |
| 测测 | `tester` | 测试工程师 | 天生较真，专挑边界异常 | 按项目框架编写/运行测试，分析失败 |
| 小研 | `researcher` | 调研分析员 | 刨根问底，结论要有出处 | 代码库+外部资料调研，产出方案对比报告 |
| 文文 | `documenter` | 文档撰写员 | 细腻温和，表达清晰 | 写 README/设计文档/PR 描述，内容与实现一致 |
| 小鱼 | `social-fish` | 信息收集员 | 轻微摸鱼但手很快 | 混迹公开信息/社交网站，识图 + 真实浏览器收集情报，写入仅整文件 |

## 使用方式（Manager 视角）

1. **规划**：把任务拆成独立子任务，判断每个子任务适合哪个员工（或组合）
2. **一键派发**：`spawn_worker(worker: "code-implementer")`
   从员工库直接创建 mission 子模型，身份（名字+性格）、systemPrompt 与 tools 自动装配
   （只接受 mission）；`name` 可省略，省略时用员工默认名字，也可显式传 `name` 自定义
3. **派活**：`agent_task(name: "<上面创建的名字>", task: "<任务描述>")`
4. **监控验收**：`agent_query` 查状态，`a_submission` 提交后对照验收标准检查，不合格重新派发
5. **补充**：需要精细控制时用 `get_worker` 拿模板后手动 `spawn_agent`；工具组/提示词可按任务增删，多员工可并行派发

## 如何新增员工

1. 在 `src/prompts/workers/` 下新建 `<id>.md`，复制现有文件结构（`## 名字` / `## 性格` + `----SYSTEM_PROMPT_START/END----` + `----TOOLS_START/END----`）
2. 在 README 清单中补一行
3. `list_workers` / `get_worker` / `spawn_worker` 会自动扫描目录，无需改代码


