# Harness Conda 产品简报

## 一句话

把一套领域 Agent 工作流像 Conda 环境一样安装、锁定、切换和迁移，并同时分发到 Codex 与 Claude Code。

## 用户问题

高质量 Agent 能力正在以 Skill、MCP、hook、脚本和配置片段的形式散落在 GitHub、博客、社区和个人电脑中。团队实际复用时仍靠 README、自然语言或复制配置，缺少四件事：版本、依赖、跨 Agent 适配和可逆安装。

General-purpose coding agent 已经存在。机会不在重做 Codex 或 Claude Code，而在其上分发能完成闭环结果的 domain-specific harness，例如：

- 性能优化：benchmark -> profile -> hypothesis -> change -> regression -> report；
- 自动科研：read -> hypothesis -> experiment -> baseline -> evaluate -> report；
- 专利流程：材料提取 -> 检索 -> 草拟 -> 核验 -> 交付。

## 首批用户

第一批不是普通消费者，而是已经在多个项目、服务器或 Agent 之间搬运工作流的研究生、工程师和 AI-native 团队。他们已有可迁移资产，能判断复现是否真的成功，也更可能贡献第一个优质包。

## MVP 楔子

先解决“我自己的 golden harness 能否在另一台机器和另一种 Agent 上一条命令复现”，再做公共 Hub。

核心闭环：

1. `capture` 从现有项目生成 secret-safe 配方；
2. `install` 从本地或 Git 获取、校验、缓存并锁版本；
3. `activate` 合并到 Codex / Claude Code 标准配置；
4. `doctor` 检查命令、环境变量、缓存和配置漂移；
5. `deactivate` 只撤销本工具拥有且未被用户修改的内容。

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

北极星指标是“在新环境成功完成一次可验证闭环的激活次数”，辅助指标包括首次成功时间、doctor 通过率、30 天复用率、跨平台成功率和版本回滚率。

## 商业化

- 开源/个人：CLI、公开 Git 包、基础校验；
- 团队：私有 registry、签名、策略、评测、版本推广；
- 企业：SSO、审计、内部 failure-case eval、私有部署与成功率看板。

当前仓库交付 CLI MVP。公共 registry、签名和远程 eval 属于下一阶段，不能在没有优质包和真实复用数据前过度建设。
