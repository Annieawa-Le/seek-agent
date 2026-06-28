# kb-query — 代码知识库查询引擎

将整个项目源码向量化，支持语义搜索和混合检索，让 AI 能准确回答关于项目自身的问题。

## 可用工具

| 工具 | 功能 |
|------|------|
| `kb_build_index` | 扫描项目源码和文档，分块 → 嵌入 → 存入向量存储 |
| `kb_query` | 接收自然语言问题，检索最相关的代码片段 |
| `kb_status` | 查看知识库状态（存储后端、索引统计、嵌入模型） |

## 存储后端

通过 `KB_STORE` 环境变量选择，默认为 JSON 文件：

| 后端 | 环境变量 | 依赖 | 适用场景 |
|------|---------|------|---------|
| JSON File | `KB_STORE=json` | 无 | 小规模（<10k chunks），零配置 |
| SQLite | `KB_STORE=sqlite` | `better-sqlite3`, `sqlite-vec` | 中规模（<50k chunks），文件存储 |
| PostgreSQL | `KB_STORE=postgres` | `pg`, 服务端 pgvector+pg_trgm | 大规模生产部署 |

## 环境变量

```env
# 存储后端
KB_STORE=json|sqlite|postgres

# Embedding 模型（OpenAI 兼容格式）
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_API_KEY=ollama
EMBEDDING_MODEL=nomic-embed-text

# PostgreSQL 专用
PG_URL=postgresql://user:pass@localhost:5432/seek_kb
```

## 使用流程

1. 在 `.env` 中配置 embedding 模型（默认 Ollama 的 nomic-embed-text）
2. 运行一次 `kb_build_index` 构建索引
3. 之后直接问代码相关的问题即可
4. 项目代码变更后，再次运行 `kb_build_index` 重建
