## 用途

todo-manager 是 todo 系统的持久化层。提供磁盘与当前会话之间的数据桥接能力。

### 可用工具

| 工具 | 功能 |
|------|------|
| `todo_save` | 将当前会话中的 todo 持久化保存到磁盘（同名覆盖） |
| `todo_load` | 从磁盘加载已持久化的 todo 到当前会话（同名覆盖） |
| `todo_list_saved` | 列出磁盘上所有已持久化的 todo 概要 |
| `todo_delete_saved` | 从磁盘删除一个已持久化的 todo |

### 与 todo.ts 的关系

- `todo.ts`（核心工具）提供 `create_todo`、`finish_step` 等会话内操作，**纯内存，不碰磁盘**
- `todo_manager`（本 skill）提供持久化能力，数据存储在工作区 `.todo-data/todos.json`
- 两者通过 `todo-state.ts` 共享会话内存状态

### 使用流程

```
1. 在会话中创建/操作 todo（create_todo / finish_step / ...）
2. 需要保存时 → todo_save(name)
3. 下次会话恢复时 → todo_load(name)
4. 查看已持久化的列表 → todo_list_saved
5. 清理磁盘数据 → todo_delete_saved(name)
```
