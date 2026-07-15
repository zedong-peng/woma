# 目标用户旅程

这份文档不是功能列表，而是产品必须反复跑通的真实工作。任何新增功能都应缩短这些流程、提高结果质量，或者减少环境污染。

## 用户 A：同一项目从调研进入实验

用户正在判断一个研究或工程 idea 是否值得做。

1. 第一次运行 `onboard`，自动识别 Agent 与项目命令并进入 `research`；用户只审阅生成的项目配置。
2. Agent 读取项目现状、检索一手资料、整理证据冲突并输出可证伪假设。
3. 用户审阅结论，而不是检查 Skill 是否安装成功，并用 `outcome` 关联结果产物。
4. Agent 生成面向 `experiment` 的 handoff，包含证据、假设、输入、失败案例和验收标准；空模板不得通过阶段门。
5. 切换到 `experiment`。调研专属能力必须消失，通用 reproducibility base 必须保留。
6. 新 Agent session 读取 handoff 和本项目的 build/test/benchmark binding，执行实验并保留负结果。
7. 实验结束后记录 success / failure / inconclusive，再进入 debug、report 或下一轮 research，不继承错误的阶段约束。

成功标准：onboard 到可用小于一分钟；不会同时加载 research 与 experiment；下一阶段不需要用户重复解释上下文；输出能被另一个人复现；本地 stats 能回答每套 profile 实际成功了几次。

在把某个 workflow 称为 golden 之前，用户把真实任务和可验证产物写成 eval definition。`eval plan` 必须明确展示两臂、HEAD、Agent、verifier 和 session 数；只有显式 `--execute` 才能消耗 Agent 配额。baseline 与 profile 使用同一 commit、隔离 worktree 和同一 verifier，结果失败能区分 Agent、verifier 与 timeout。

## 用户 B：drip 的多项目、多服务器开发

用户在几台服务器推进不同项目。各项目的编译测试方式不同，但共享 GDB、性能分析、代码审查和实验方法。

1. 方法论以 Git Harness package 发布，不复制 README 或自然语言安装记录。
2. 每个项目只保存自己的 profile composition 和 build/test/benchmark bindings。
3. 新服务器 clone 项目后运行 `harness sync`，恢复 lock 中的精确版本。
4. `harness doctor` 在启动 Agent 前报告缺失命令、环境变量、缓存篡改和 profile 漂移。
5. 用户按当前任务 `enter debug`、`enter performance` 或 `enter experiment`，而不是手工增删 MCP 和 Skills。

成功标准：新服务器不依赖原机器的隐式状态；项目差异不需要 fork 通用 Harness；同一 failure case 不被不同 Agent session 反复踩中。

当 drip 修改共享方法论时，先在一个开发任务集上运行成对 eval，再在未参与调优的 held-out 项目上复测。profile 没有稳定胜过 baseline 时不得推广到其他服务器或全公司。

## 作者：发布 golden Harness

作者把已在真实任务中使用的闭环方法发布为 package，包括强触发描述、执行流程、脚本、质量门槛和失败案例。

作者需要知道的不是下载量，而是：首次成功率、在哪类项目失败、哪个 Agent/模型组合有效、升级是否回归。这些 eval 与 failure-case 能力是后续产品阶段，不应由默认上传用户私有数据来换取。

## 当前不优先

- 没有优质包之前建设空的公共 Hub；
- 用安装量代替结果质量；
- 为所有 Agent 私有选项做无边界兼容；
- 在没有 opt-in、审阅和脱敏机制时收集用户对话或失败日志；
- 把 Harness 做成越来越长的静态 prompt，而不验证任务结果。
