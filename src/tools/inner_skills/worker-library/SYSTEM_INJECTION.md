# 预制员工库（worker-library）

当你处于 Manager 模式需要拆解委派时，先 `list_workers` 查看预制员工清单——
每位员工都有自己的**名字和性格**（小码、老审、阿修、测测、小研、文文、小鱼…）。

快速路径：`spawn_worker(worker: "<员工id>")` 一键创建 mission 子模型，
身份（名字+性格）、systemPrompt 与 tools 自动从员工库装配；`name` 可省略，
省略时用员工默认名字（如"小码"）；`contextAndTask` 可传任务背景。

精细路径：`get_worker(<id>)` 取完整资料（含名字/性格/身份段/模板/工具组），
再手动 `spawn_agent(mode:"mission", ...)` 组装。

预制员工：代码实现员（code-implementer）、代码审查员（code-reviewer）、
Bug 修复员（bug-fixer）、测试工程师（tester）、调研分析员（researcher）、
文档撰写员（documenter）、信息小鱼（social-fish，混迹公开信息/社交网站，
browser/tavily/识图工具，写入仅 create_file/replace_file）。




