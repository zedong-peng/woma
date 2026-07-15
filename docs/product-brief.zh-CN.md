# Harness Conda 产品简报

## 一句话

告诉 Agent “我现在处于哪个工作阶段”，立即得到一套确定、可复现、能向下一阶段交接结果的工作环境。

## 用户问题

Codex 与 Claude Code 已有原生 Plugins 和 marketplace，可以分发 Skill、MCP、hook 与 connector。单纯做跨平台打包和 Hub 会被平台能力快速商品化，不能作为公司的核心。

仍未被解决的是任务层：用户现在处于调研、实验还是 debug；哪些通用能力应保留、哪些阶段能力必须撤下；本项目实际怎么 build/test/benchmark；上一阶段的证据如何交给下一阶段；这套 Harness 究竟提高了结果质量还是只增加配置。

General-purpose coding agent 已经存在。机会不在重做 Codex 或 Claude Code，而在其上分发能完成闭环结果的 domain-specific harness，例如：

- 性能优化：benchmark -> profile -> hypothesis -> change -> regression -> report；
- 自动科研：read -> hypothesis -> experiment -> baseline -> evaluate -> report；
- 专利流程：材料提取 -> 检索 -> 草拟 -> 核验 -> 交付。

## 首批用户

第一批不是普通消费者，而是已经在多个项目、服务器或 Agent 之间搬运工作流的研究生、工程师和 AI-native 团队。他们已有可迁移资产，能判断复现是否真的成功，也更可能贡献第一个优质包。

## MVP 楔子

先解决两个高频真问题，再做公共 Hub：同一项目能否在 research / experiment / debug 等阶段之间无污染切换；同一套 golden Harness 能否在另一台机器和另一种 Agent 上一条命令复现。

核心闭环：

1. `onboard` 识别仓库、Agent、包管理器和命令，一条命令进入 research；
2. `switch` 排他切换阶段，同时保留 base 并写入强路由信号；
3. `handoff` 把证据、假设、失败案例和验收标准交给下一阶段；
4. `enter` 启动全新的 Codex / Claude session，避免旧上下文污染；
5. `outcome` 由用户明确标注 success / failure / inconclusive，并关联产物；
6. `stats` 只读取 Git 排除的本地事件，验证 Harness 是否真的有用；
7. `sync` 与 `doctor` 恢复并核验跨服务器环境。

## 为什么现在做

Agent 的基础能力持续增强，会淘汰过细的提示约束，但不会消除任务、组织与领域差异。Harness 会从“教模型每一步”演化为“给出高信号流程、工具、质量门槛和反馈闭环”。跨平台配方能隔离底层 Agent 的变化。

## 护城河路径

代码格式本身不是护城河。可积累资产按顺序是：

1. 经真实项目验证的领域包与作者关系；
2. 匿名、经授权的 failure taxonomy 和 eval case；
3. 同一 Harness 在不同模型、Agent、仓库上的结果数据；
4. 基于结果自动推荐版本和平台适配；
5. 企业内部的私有 registry、策略、审计与成功率基线。

失败案例默认留在用户本地。任何遥测与共享必须 opt-in、可审阅、可脱敏；否则数据飞轮会直接破坏信任。

## 冷启动

不先做空 Hub。团队亲自维护 3 到 5 个能产生可验证结果的包，用案例报告分发：性能优化、代码审查、科研实验、文献证据、专利草拟。社区渠道用于招募作者和设计伙伴，不把安装量当成质量。

北极星指标是“完成一次有可验证产物的阶段转换”，例如 research handoff 被 experiment 成功消费。辅助指标包括首次成功时间、切换后环境污染率、handoff 复述减少量、doctor 通过率、30 天复用率、跨平台成功率和版本回滚率。

## 商业化

- 开源/个人：CLI、公开 Git 包、基础校验；
- 团队：私有 registry、签名、策略、评测、版本推广；
- 企业：SSO、审计、内部 failure-case eval、私有部署与成功率看板。

当前仓库交付 CLI v0.4：一键 onboarding、可组合 profile、排他切换、项目 binding、强路由、handoff、fresh session、跨服务器 sync、本地 outcome evidence，以及同一 Git commit 上裸 Agent 与 profile 的隔离成对评测。评测默认只展示计划，显式执行后也只保留本地元数据和失败阶段。

这仍不是 PMF 证据。下一阶段必须从用户和 drip 的真实未解决任务中建立 held-out task set，至少覆盖调研、实验和性能优化；同一 Harness 只有在多个任务和重复运行中稳定胜过 baseline，且 failure case 能解释和修复，才有资格被称为 golden。公共 registry 与安装量继续不作为近期成功标准。
