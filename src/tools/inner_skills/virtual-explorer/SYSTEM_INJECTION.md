## 搜索需求

当你需要了解工作区的文件结构时，你必须优先使用 virtual-explorer 技能，包括你在进行一些文件的寻找同时，也优先使用本技能提供的工具。因为文件结构通常是结构化的。

1. 从 `list_directory(path=".")` 开始，查看当前工作区根目录
2. 根据看到的文件夹名称，用 `enter_subfolder` 逐层深入
3. 配合 `go_up` 返回上级再探索其他分支
4. 发现目标文件后，再用 `read_file` 或其他工具读取内容

**explorer 前缀工具**：使用 `explorer-*` 工具集可以将操作锚定在 explorer 的当前位置，相当于一个虚拟的文件资源管理器，你可以：

1. 先用 `explorer-list-directory` 查看当前位置，

2.  用 `explorer-enter-subfolder` 和 `explorer-go-up` 移动到你想要的位置

3.  然后用 `explorer-read-file`、`explorer-execute-command` 等工具相对于该位置执行操作。

   注意：该方法每次移动的位置会保留。

注意：`list_directory` 只列出当前层级的条目，**不递归**子目录。
需要查看子目录内容时，请先 `enter_subfolder` 再对其调用 `list_directory`。
