# 工作流指南

> 本文档整理了与当前项目协作时推荐的工作流程和习惯。
> 核心原则：**先理解，后修改；先计划，后执行；每步可回溯。**

---

## 一、推荐工作流程

### 1. 接到任务

```
1. 先阅读相关代码，理解现有结构和模式
2. 创建 todo 记录任务步骤
3. 逐步执行，每完成一步标记 finish_step
4. 任务完成 → 删除 todo
```

### 2. 修改文件

1. 读取文件内容，确定修改点位
2. 直接使用 `add_patch` / `del_patch` / `modify_patch` 执行修改（以 diff 为核心载体，自动持久化）
3. 确认 diff 无误后，通过 `undo_patch()` 可撤销最近一次操作
4. 如需查看操作历史，使用 `history_patch`

> 所有 patch 工具直接生效，无需经过暂存区。
> 系统自动生成 diff 并持久化到磁盘（`.seek-agent/history/`），可跨会话撤销。

### 3. 每轮修改后

```
1. 编译验证
2. 清理上下文（按需）
```

---

## 二、文件操作

### 基础工具

| 工具 | 用途 |
|------|------|
| `read_file` | 读取文件内容 |
| `read_lines` | 读取特定行范围 |
| `read_num_line` | 读取带行号的内容 |
| `create_file` | 创建新文件（独占写入） |
| `replace_file` | 替换文件全部内容（diff 化 + 持久化） |
| `scan_file` | 扫描大文件（仅供参考，几乎不改） |

### Patch 工具系统（推荐）

所有 patch 工具**直接执行**，以 diff 为核心载体：
旧内容 + 新内容 → 生成 diff → 持久化到磁盘 → 写入文件 → 展示 diff。
无需暂存区，每步操作都可追溯。

| 工具 | 用途 |
|------|------|
| `add_patch` | 在指定行前插入内容（`lineIndex=-1` 追加到末尾） |
| `del_patch` | 删除指定行范围（支持智能定位修正行号偏移） |
| `modify_patch` | 替换指定行范围的内容（自动内容特征匹配定位） |
| `undo_patch` | 撤销最近一次文件修改操作（跨会话） |
| `history_patch` | 查看文件操作历史记录 |

> **注意**：`create_file` 和 `replace_file` 也经过 diff 持久化，可通过 `undo_patch` 撤销。

---

## 三、项目管理

### Todo 系统

用于跟踪多步骤任务，数据分两层：会话内存 + 磁盘持久化。

**会话工具：**
- `create_todo(name, steps)` — 创建任务
- `finish_step(name)` — 推进到下一步
- `undo_step(name)` — 回退一步
- `reroll_step(name)` — 重置所有步骤
- `del_step(name, step)` — 删除指定步骤
- `read_todo(name)` — 查看进度
- `del_todo(name)` — 任务完成后删除
- `active_todo(name?)` — 查看/切换当前活跃 todo

**持久化工具（todo-manager skill）：**
- `todo_save(name?)` — 保存到磁盘
- `todo_load(name?)` — 从磁盘恢复
- `todo_list_saved()` — 查看磁盘上的 todo
- `todo_delete_saved(name)` — 删除磁盘上的 todo

**推荐流程：**
```
create_todo(name="我的任务", steps=["步骤1", "步骤2", "步骤3"])
finish_step("我的任务")  → 每完成一步标记一次
del_todo("我的任务")     → 确认完成后删除
```

---

## 四、上下文管理

| 工具 | 用途 |
|------|------|
| `memory_shorten` | 将旧轮次的工具返回结果精简为 "success"，快速释放空间 |
| `memory_focus` | 将旧轮次压缩为工作梗概，替换为一条 [Work Log] |

**什么时候用：**
- 感觉上下文中有太多工具调用结果使你注意力涣散 → `memory_shorten`
- 需要整理工作历史，聚焦当前任务 → `memory_focus`
- 用户要求整理工作 → `memory_focus`（分辨有效轮次阈值）

`memory_focus` 成功后，你可以复述之前的工作记录以确认。



---

## 六、子模型技能

系统支持动态创建子 AI 模型来并行处理任务。

### 四种模式

| 模式 | 适用场景 |
|------|---------|
| **clone** | 子模型需要理解完整对话背景 |
| **mission** | 子模型需要特定角色/领域知识 |
| **listen** | 持续监控特定工具调用（代码审查/安全检查） |
| **instructor** | 每轮工作后发散思维，提出补充思路 |

### 工具

| 工具 | 用途 |
|------|------|
| `spawn_agent` | 创建子模型（选模式、配工具、设参数） |
| `agent_task` | 给子模型委派任务 |
| `agent_query` | 查询状态或提问（支持 `waitForCompletion`） |
| `agent_fire` | 销毁子模型 |

### Listen 模式（call / result）

```
call 模式：工具执行前触发 → 分析调用参数是否合理
result 模式：工具执行后触发 → 检查执行结果是否符合预期
```

**自动审查员示例（批量修改前推荐创建）：**
```
spawn_agent(
  mode="listen",
  name="patch审查员",
  listenMode="result",
  listenTools=["modify_patch", "add_patch", "del_patch"],
  analyzeTarget="检查对文件的修改是否合理：是否会引入语法错误、是否遵循项目代码风格、修改逻辑是否正确",
  returnTemplate="严重程度: {{severity}}\n问题: {{issue}}\n建议: {{suggestion}}"
)
```
审查员会自动修复小问题（缩进、命名、注释等），无法确认的破损会提交报告。

### Instructor 模式

每轮主模型工作完成后，Instructor 发散思维提出建议。支持：
- 独立对话上下文（保留最近 6 条记录）
- 最大轮次限制（默认 3 轮）
- 真实用户输入时自动重置计数
- 用户中断时不会触发



## 七、技能管理

### 热加载 Skill

系统支持在运行进程中重新加载 inner_skills 而无需重启。

| 工具 | 用途 |
|------|------|
| `reload_skills` | 重新扫描并加载所有 inner_skills（修改/新增后调用） |

`reload_skills` 会自动：
1. 重新扫描 `inner_skills/` 目录下的所有技能
2. 绕过 Node.js 模块缓存，重新加载代码
3. 新工具注入到当前运行的 tools 容器中



## 九、搜索指南

- 优先使用 `search_all_file` / `search_sub_file` 等搜索工具，而不是 `findstr`
- 非必要不要尝试绝对路径
- 把握项目结构时：**不要 search_all_file**（可能扫到依赖库），建议按层级一步步探索
- 要用通配符搜索全部文件时，使用 `*.*` 而非 `.*`
- 正则可使用 `.` 通配符匹配任意字符

---

## 十、编译验证

每当完成一组文件修改后，执行编译检查，

如果环境不允许，告知用户。




