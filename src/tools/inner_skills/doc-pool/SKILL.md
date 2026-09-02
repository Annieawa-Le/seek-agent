# doc-pool — 文件池

把子模型「读阶段」读取的文件片段沉淀为命名文件池，委派员工时可注入池上下文共享背景文件。

## 工具

- `doc_pool{pool_name, name}`：建立「文件池 ↔ 子模型」关联，扫描该子模型已完成的读阶段并填充池；之后循环自动记录/移除。
- `doc-pool-prompt-get`：本技能文档。

## 工作流

1. `spawn_agent` 创建子模型（如渲染修复员）→ `agent_task` 派活让它先读文件
2. `doc_pool{pool_name: "渲染组", name: "渲染修复员"}` 沉淀它读到的文件
3. 委派新员工：`agent_task{name: "新员工", task: "...", pool_name: "渲染组"}` ——
   新员工初始上下文自动带上池中文件片段

## 读阶段

从子模型第一条工具调用起，到第一个**写入工具**（add_patch / del_patch / replace_str /
create_file / replace_file / wrap_by 等）或 **TODO 工具**（create_todo 等）为止。
此间的读取工具（read_file / read_lines / scan_file 等）被记录；之后修改过的文件片段自动移除。
