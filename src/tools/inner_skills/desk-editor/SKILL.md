## 用途

光标驱动的桌面编辑模式。支持文件编辑会话管理、光标移动、行选择、粘贴/替换/删除、撤销、保存和取消操作。
进入编辑模式后，其他非编辑工具将被拦截，仅桌面编辑工具可用。

### 可用工具

| 工具 | 功能 |
|------|------|
| `desk_edit` | 进入一个文件的桌面编辑模式，分配一个 id。光标初始在文件末尾。 |
| `line_cursor` | 光标操作：`move` 移动到指定行前，`selectto` 选中行范围（1-based）。 |
| `line_paste` | 粘贴内容：有选中时替换选中行，无选中时在光标处插入。空数组 = 删除选中行。 |
| `ctrl_z` | 撤销上一步操作（line_cursor / line_paste）。 |
| `desk_save` | 保存修改并退出编辑模式。id 可选，不填则保存所有活跃会话。 |
| `desk_cancel` | 放弃修改并退出编辑模式。id 可选，不填则取消所有活跃会话。 |
| `desk_confirm_file` | 将会话的最新 ref（含光标标记）拉到消息末尾。id 不填则重置所有。 |

### 使用流程

```
1. desk_edit(id="myfile", filePath="path/to/file.ts")   → 进入编辑模式
2. line_cursor(id="myfile", action="move", target=0)     → 移动到文件开头
3. line_cursor(id="myfile", action="selectto", start=3, end=8) → 选中行 3-8
4. line_paste(id="myfile", lines=["新行1", "新行2"])      → 替换选中行
5. line_paste(id="myfile", lines=[])                       → 删除选中行
6. ctrl_z(id="myfile")                                     → 撤销
7. desk_save(id="myfile")                                  → 保存并退出
```

### 注意事项

- 一个 id 对应一个文件编辑会话，不可重复打开同一 id。
- `line_paste` 操作后光标会被清除，需再次 `line_cursor move` 继续编辑。
- `line_cursor move` 会清除已有的选中状态。
