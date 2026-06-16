## 用途

在项目涉及代码时，优先使用本技能进行代码分析，按照结构分块读取，可以有效地降低注意力发散的程度。
你也尽可能减少对全部详细代码属性的访问，而是在利用粗略读取，确定了需要工作的点位之后，利用工具精确读取代码段及其对应属性。

### 可用工具

| 工具 | 功能 | 典型输出 |
|------|------|----------|
| `scanning_function` | **扫描**文件中所有函数的**签名概览** | `funcName(Type1, Type2): ReturnType` |
| `read_function` | **读取**指定函数的**详细信息**（代码体、文档、装饰器等） | 名称+参数+位置+代码体 |
| `scanning_class` | **扫描**文件中所有类/结构体的**方法签名列表** | `ClassName.methodName(...)` |
| `read_class` | **读取**指定类的**详细信息**（所有方法的签名+代码体） | 类名+方法详情+代码体 |
| `read_package` | **读取**导入的包/库列表及位置 | 包名+行号 |
| `scanning_tag` | **扫描** HTML 文件中的所有标签结构（独有） | 标签名+属性+类/ID+行号 |
| `scanning_script` | **扫描** HTML 文件中的 `<script>` 块（独有） | 脚本块语言+行号+代码预览 |
| `jump_to_definition` | **跳转至**符号（函数/变量/类）的定义位置 | 定义行+上下文代码 |

### 使用流程建议

```
1. scanning_function → 获取所有函数的签名清单
2. read_function("funcName") → 深入查看感兴趣的函数的代码
   ── 或 ──
1. scanning_class → 获取所有类的结构概览
2. read_class("ClassName") → 深入查看类的详细信息
   ── HTML 分析 ──
1. scanning_tag → 获取 HTML 标签结构概览
2. scanning_script → 提取 <script> 脚本块
   ── 符号定位 ──
1. jump_to_definition → 查找任意符号的定义位置（支持跨文件搜索）
```

### 支持的文件类型

| 类型 | 扩展名 | 解析器 |
|------|--------|--------|
| TypeScript / JavaScript | ts, js, tsx, jsx | TsFunctionParser |
| Python | py | PyFunctionParser |
| C / C++ / Java | c, h, cpp, java | CFunctionParser |
| HTML | html, htm | HtmlParser（独有：标签扫描、脚本提取） |
