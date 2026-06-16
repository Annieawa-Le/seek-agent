## 用途

以文件树形式将目录结构展示给 AI，支持获取当前文件夹的目录结构、进入子文件夹、返回上级目录。帮助 AI 理解和导航工作区文件系统。

### 基础导航工具

| 工具 | 功能 |
|------|------|
| `list_directory` | 获取指定路径下的目录结构，仅展示当前层级的文件和文件夹（不递归子目录）。返回文件和文件夹的列表，带类型标识。 |
| `enter_subfolder` | 进入指定路径下的某个子文件夹，返回该子文件夹的规范路径。 |
| `go_up` | 从当前路径返回上级目录路径。如果已在根目录则返回当前路径。 |

### explorer 前缀工具集

以 `explorer-` 为前缀的工具将 **virtual-explorer 的当前位置**视为根目录来执行操作。你可以先通过导航工具移动 explorer 的当前位置，再使用 `explorer-*` 工具在该位置执行文件操作。

| 工具 | 功能 |
|------|------|
| `explorer-list-directory` | 列出 explorer 当前所在目录的文件和文件夹（不递归子目录），无参数 |
| `explorer-enter-subfolder` | 从 explorer 当前目录进入某个子文件夹，更新 explorer 的当前位置 |
| `explorer-go-up` | 从 explorer 当前目录返回上级目录，更新 explorer 的当前位置 |
| `explorer-read-file` | 相对于 explorer 当前目录读取文件内容 |
| `explorer-read-lines` | 相对于 explorer 当前目录读取特定行范围 |
| `explorer-read-num-line` | 相对于 explorer 当前目录读取带行号的行范围 |
| `explorer-scan-file` | 相对于 explorer 当前目录扫描大文件 |
| `explorer-search-all-file` | 相对于 explorer 当前目录递归搜索文件 |
| `explorer-search-sub-file` | 相对于 explorer 当前目录仅当前层搜索文件 |
| `explorer-search-directory` | 相对于 explorer 当前目录递归搜索子文件夹 |
| `explorer-search-content` | 在 explorer 当前目录下的文件中搜索内容 |
| `explorer-create-file` | 相对于 explorer 当前目录创建新文件 |
| `explorer-replace-file` | 相对于 explorer 当前目录替换文件内容 |
| `explorer-add-patch` | 相对于 explorer 当前目录暂存插入操作 |
| `explorer-del-patch` | 相对于 explorer 当前目录暂存删除操作 |
| `explorer-modify-patch` | 相对于 explorer 当前目录暂存修改操作 |
| `explorer-execute-command` | 在 explorer 当前目录下执行一条系统命令 |

### 典型使用流程

导航并了解项目结构的标准方式：

```
1. list_directory(path=".")                   ← 查看当前工作区根目录
2. enter_subfolder(parentPath="...", ...)     ← 进入某个子文件夹
3. go_up(currentPath="...")                   ← 返回上级目录
```

使用 explorer 位置锚定：

```
1. explorer-list-directory                    ← 查看 explorer 当前位置的内容
2. explorer-enter-subfolder("src")            ← 进入 src 子文件夹（更新位置）
3. explorer-go-up                             ← 返回上级（更新位置）
4. explorer-read-file("index.ts")             ← 相对当前位置读取文件
5. explorer-execute-command("ls")             ← 在当前位置执行命令
```
