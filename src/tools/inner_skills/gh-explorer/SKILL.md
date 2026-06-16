## 用途

GitHub 仓库探索 + 本地 git 操作 + 推送。无需 GitHub 令牌即可探索公开仓库，配置令牌后可让 AI 自主推送代码。

### 可用工具

**远程探索** — 在线查看 GitHub 仓库：

| 工具 | 功能 |
|------|------|
| `gh_search_repos` | 搜索 GitHub 上的公开仓库，返回结构化结果（含 stars、语言、描述） |
| `gh_repo_tree` | 获取仓库目录/文件树结构，输出类似 tree 命令的层次结构 |
| `gh_readme` | 提取仓库 README 内容 |
| `gh_file_content` | 读取仓库中特定文件的内容 |
| `gh_explore` | 一站式探索：目录树 + README，输出完整项目概览（**零消耗**） |

**本地 git 操作** — 管理已克隆的仓库：

| 工具 | 功能 |
|------|------|
| `gh_clone` | 将 GitHub 仓库克隆到本地 |
| `gh_log` | 查看提交历史（支持限制条数、单文件筛选、分支图） |
| `gh_status` | 查看工作区状态（修改/暂存/未跟踪） |
| `gh_branch` | 列出/创建/删除分支 |
| `gh_diff` | 查看差异（工作区、暂存区、提交间） |
| `gh_checkout` | 切换分支 / 创建并切换分支 / 恢复文件 |
| `gh_push` | **推送到远程仓库**（支持 token/SSH 认证） |

### gh_push 使用说明

`gh_push` 让 AI 可以直接将代码推送到 GitHub 公私仓库，无需手动输入密码。

**认证方式（按优先级）：**

| 环境变量 | 说明 | 获取地址 |
|----------|------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token（推荐） | https://github.com/settings/tokens |
| `GIT_PUSH_TOKEN` | 同上，别名 | — |
| `GITHUB_PASSWORD` | GitHub 密码（不推荐，建议用 token） | — |

Token 需要勾选 `repo` 权限范围（私有仓库）或 `public_repo`（仅公开仓库）。

**典型工作流：**

```
1. gh_clone(repo_url="https://github.com/user/repo")  # 克隆
2. 在本地修改文件（由其他工具完成）
3. gh_log(repo_path="./repos/repo")                   # 确认提交历史
4. gh_push(repo_path="./repos/repo")                  # 推送到远程
```

**首次推送新仓库：**

```
gh_push(
  repo_path="./repos/my-project",
  remote_url="https://github.com/user/my-project.git",
  branch="main",
  set_upstream=true
)
```

**参数说明：**

| 参数 | 说明 |
|------|------|
| `remote_url` | 远程仓库 URL（首次推送或改 remote 时用） |
| `force` | 强制推送（`--force`），覆盖远程历史，慎用 |
| `set_upstream` | 设置 upstream 跟踪（`-u`），首次推送推荐 |
| `all` | 推送所有分支 |
| `tags` | 同时推送标签 |

### 数据源策略（省点指南）

| 工具 | 优先使用 | 回退方案 | 消耗 credits? |
|------|----------|----------|:---:|
| `gh_search_repos` | GitHub REST API | Tavily search | 仅回退时 |
| `gh_repo_tree` | GitHub Git Trees API | Tavily crawl | 仅回退时 |
| `gh_readme` | `raw.githubusercontent.com` | Tavily extract | 仅回退时 |
| `gh_file_content` | `raw.githubusercontent.com` | Tavily extract | 仅回退时 |
| `gh_explore` | 组合免费 API | — | **永不** |
| `gh_clone` / `gh_log` / `gh_status` / `gh_branch` / `gh_diff` / `gh_checkout` / `gh_push` | 本地 `git` 命令 | — | **永不** |

### 环境变量

- **`GITHUB_TOKEN`**（可选，推荐）— GitHub Personal Access Token。
  用于：提升 API 速率限制（60 → 5000/h） + git push 认证。
  生成：GitHub Settings → Developer Settings → Personal Access Tokens → 勾选 `repo` 权限

- **`GIT_PUSH_TOKEN`**（可选）— `GITHUB_TOKEN` 的别名，两者任设其一即可。

- **`TAVILY_API_KEY`**（仅在 GitHub API 受限时作为回退）— 从 [Tavily Dashboard](https://app.tavily.ai) 获取。

### 系统依赖

- **Git** — 本地操作需要系统安装 Git。从 https://git-scm.com 下载。

### 快速开始

```
# 在线探索（零消耗）
gh_explore(repo_url="https://github.com/user/repo")

# 克隆 → 查看 → 修改 → 推送
gh_clone(repo_url="https://github.com/user/repo")
gh_log(repo_path="./repos/repo-name")
gh_status(repo_path="./repos/repo-name")
gh_push(repo_path="./repos/repo-name", branch="main")
```
