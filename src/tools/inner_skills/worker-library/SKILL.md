## 用途

worker-library 是**预制员工库**：为 Manager 模式提供一组有名字、有性格的子模型员工模板，
Manager 拆解任务后可直接按模板 `spawn_worker`，不必每次重写提示词与工具组。

员工资料存放在 `src/prompts/workers/*.md`，每个文件包含：

- `## 名字` / `## 性格` —— 员工人设（spawn_worker 自动注入 systemPrompt）
- `## 角色定位` / `## 适用场景` —— 人读的定位说明
- `----SYSTEM_PROMPT_START/END----` —— 包裹的 systemPrompt 模板
- `----TOOLS_START/END----` —— 包裹的推荐工具组（JSON 数组）

### 可用工具

| 工具 | 功能 |
|------|------|
| `list_workers` | 列出全部预制员工（名字、角色、性格摘要、工具数） |
| `get_worker` | 读取单个员工的完整资料（名字/性格 + systemPrompt 模板 + 推荐工具组） |
| `spawn_worker` | 从预制员工库一键创建 mission 子模型（身份 + 提示词 + 工具自动装配，name 可省略，只接受 mission） |
| `worker-library-prompt-get` | 查看本技能说明文档 |

### 使用流程（Manager 模式）

```
1. 拆解任务 → 判断每个子任务适合哪类员工
2. list_workers → 查看可选员工（每位都有自己的名字和性格）
3. 快速路径：spawn_worker(worker: "code-implementer")
   → 一键创建 mission 子模型，身份（名字+性格）、systemPrompt 与 tools 自动装配
   → name 可省略，省略时用员工默认名字（如"小码"）；也可显式传 name 自定义
4. 精细路径（可选）：get_worker(code-implementer) 拿到模板后
   手动 spawn_agent(mode: "mission", name, tools, systemPrompt, contextAndTask)
5. agent_task 派活 → a_submission 验收 → 需要时 agent_query(name, question) 向员工提问
```

### 自定义员工

在 `src/prompts/workers/` 下新建 `<id>.md`，复制现有文件结构
（`## 名字` / `## 性格` + `----SYSTEM_PROMPT_START/END----` + `----TOOLS_START/END----`），
工具会自动扫描到，无需改代码。


