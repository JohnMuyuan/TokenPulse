# 0.3.9 供应商配置写入安全审计（历史记录）

> 后续已修复下文八项反例：原审计10/10通过，另有22项事务回归。请阅读 provider-config-safety-0.3.9-fix.md 与 HANDOFF.md 当前入口；下文保留审计当时的状态，不代表当前源码。

审计时间：2026-09-28 21:58 America/Los_Angeles。审计对象：TokenPulse 0.3.9；对照用户提供的 D:\CodePorject\Exmaple\cc-switch-main（package.json 3.20.4）。

## 结论与范围

字段选择和“直连/本地代理”思路有相似实现，但不能据此声称完整移植了 CC Switch 的配置安全机制。无法由源码相似性证明过去开发过程是否充分参考；可以确认的是目前安全能力有明显差距。

本轮是审计，不是修复。产品逻辑、真实工具配置、CC Switch 源码和 dist 均未修改。只新增审计脚本及本报告、更新交接文档，并重新编译以对齐源码。交付目录版的供应商核心 JS、UI JS/CSS 与当前文件逐字节相同，因此下列问题同样适用于当前目录版。不读取真实凭证，不查看图片，不运行真实 CLI 远端请求。

## 实际修改逻辑

1. 保存未启用的第三方：通常仅写 TokenPulse 的 agent-switch.json，不改工具配置。
2. 保存被内部 direct/route 指针标记为当前的第三方：先保存供应商资料，再立即重写工具配置；不需要再次点击启用。是否当前并非可靠的配置归属检测。
3. 点击启用：更新内部 direct/route 指针，然后写工具配置；跨协议或桌面映射会开启本地代理。
4. 本地代理：将工具地址指到 127.0.0.1、密钥改成占位符，实际请求由主进程转发。
5. 关闭代理/退出：按记住的 direct 供应商重新生成配置，找不到则按官方卡处理；不是把本次接管前文件完整还原。
6. 首次写入已有文件会备份到 TokenPulse 数据目录 backups/live-first-write；写文件用临时文件加 rename。首次备份是人工恢复材料，不等于每次操作事务或自动回滚。

文件范围（路径可被工具环境变量覆盖）：Claude settings.json；Codex config.toml 与 tokenpulse-model-catalog.json；Grok config.toml；桌面端 Claude-3p/configLibrary 中 TokenPulse profile 与 _meta.json。普通 hooks/MCP 等字段有保留意图，但“所有其他字节都不动”并不成立。

## 隔离复现结果

命令：npm run compile；node scripts/audit-agent-config-safety.cjs。

编译通过；最终十项安全断言连续运行两次，结果均为 **2 项通过、8 项失败，脚本退出码 1**。失败是尚未满足的安全断言，不是修复完成。所有测试使用临时 HOME、数据目录、合成密钥和临时 CC 数据库；代理仅监听本地，未向外部请求。临时数据库及本地服务关闭，临时数据目录最终清理。

| 编号 | 风险/复现场景 | 源码证据 | 优先级 |
|---|---|---|---|
| F1 | 两个不同账号共用同一网关 URL，启用 B 后 UI 仍把 A 判作当前；实际写入 B 与当前标识不一致 | src/core/agent-switch.ts:577 matchLive 只比较 URL，currentId 优先采用匹配结果 | 高 |
| F2 | 激活 A 后在外部切到另一连接；在 TokenPulse 仅保存 A 的备注也会重新写回 A，覆盖外部选择 | :262 saveProvider 按历史 direct 指针写入，没有核对当前配置归属 | 高 |
| F3 | 合法 TOML 多行文本内出现 [model_providers.custom]，被当成真正的配置表删除，破坏无关内容/语法 | :957 parseToml 和 replaceTable 是逐行匹配，不理解字符串上下文 | 高 |
| F4 | 模拟配置文件 rename 抛 EPERM：启用失败，原配置仍是 A，内部 direct 指针却已变为 B | :385 activateProvider 先 save 再 applyDirect，没有事务恢复 | 高 |
| F5 | 开启代理后，外部工具改了连接；退出 TokenPulse 又把连接覆盖成之前记住的供应商 | :465 releaseAgentSwitch 无归属/hash 检测；关闭代理有相同设计问题 | 高 |
| F6 | 从现有 Claude 配置导入再启用，API_KEY 变为 AUTH_TOKEN，独立 Haiku 模型变成主模型 | :864 snapshotLive 固定鉴权字段、空 slots/extra；:903 仅读主模型 | 高 |
| F7 | 桌面端原先有外部 profile；开启再关闭代理后 _meta.json.appliedId 不再指向原 profile | :903 desktop 返回 null，无法捕获原选择；:763 官方回退清除 appliedId | 高 |
| F8 | 从临时 CC 数据库导入 Codex 后启用，disable_response_storage=true 与 model_context_window=128000 被写成带引号字符串，配置类型不符 | extractExtra 将值变字符串；:692 writeCodex 无差别 quote | 高 |

F6 实测 authField=false、haiku=false；F8 实测 boolean=false、number=false。F3 是精简合法 TOML 边界案例，不表示普通短配置必然损坏。F4 的 EPERM 是对临时配置定点注入，不是本次产物实际被占用。

通过项：C1 保存未激活供应商不改 live；C2 常规 Claude 切换保留 hooks、自定义环境项，并保留首次文件字节备份。这只能说明这些具体场景通过，不能覆盖八项反例。

## CC Switch 对照证据

所有路径以 D:\CodePorject\Exmaple\cc-switch-main 为根：

- src-tauri/src/services/provider/claude_direct.rs:1-5、26-44、73-88：所有 Claude 写入归到统一补丁/操作入口，区分切换与重新应用。
- src-tauri/src/services/provider/codex_direct.rs:1-15：配置、模型目录及登录相关文件作为同一操作规划与提交，而非逐个独立写完就算成功。
- src-tauri/src/services/provider/grok_direct.rs:1-6：Grok 也走应用写锁与 pending 操作。
- src-tauri/src/live/patch/toml.rs:110-143：先解析为 DocumentMut 再补丁；解析失败返回带位置的错误。
- src-tauri/src/live/engine.rs:184-223：应用级写锁，Drop 释放。该锁协调其内部写入者，不能单凭写锁阻止其他程序，所以仍需下述检测。
- src-tauri/src/mode/operation.rs:76-190：规划所有文件、准备临时文件、写 pending；发布前重读/hash 检查，变化时重算或拒绝；失败/中断可依据 pending 恢复。
- src-tauri/src/claude_desktop_config.rs:1157-1178：移除自己的 profile 后会从保留 entries 中选后继 appliedId；这也不是对“永远精确还原此前 profile”的保证，但比 TokenPulse 直接清空多一层处理。

CC Switch 也有首次备份机制；差别不是“是否每次备份”，而是配置补丁、归属检测和可恢复提交。此处仅做源码对照，没有编译或执行 CC Switch 全套测试，不能据此宣称它绝对无缺陷。

## 修复建议与临时使用边界

1. 优先修补事务/失败恢复、外部配置归属校验（尤其退出与关闭代理）、有效 TOML 的结构化修改和保留类型。
2. 再修同 URL 的身份识别、导入完整角色/鉴权方式、桌面 profile 快照与恢复；将本审计反例变成正常回归。
3. 接管前记录足够的原状态，恢复前核对仍属于 TokenPulse；外部变更时保留外部修改并明确提示，不静默抢回配置。
4. 修改后全量测试、故障注入与中断恢复验证，再更新免安装目录版。不能仅调换 save/apply 的顺序就称有事务保证。
5. 修复前建议继续用 CC Switch 管理真实供应商，TokenPulse 用于统计或隔离 UI 测试；避免二者交替管理同一工具。若已经启用 TokenPulse 代理，退出也可能触发恢复写入，应先备份当前配置再有序切回，不能把“退出软件”当成不写配置的操作。

## 收尾

审计相关进程残留 0；build/core/agent-switch.js、dist/win-unpacked/TokenPulse.exe、resources/app.asar 独占读取检查通过，句柄立即释放。未关闭用户软件。git diff --check 通过（原有 oauth.ts 换行提示）。本轮未重跑完整 npm test/test:ui；上轮全通过仅覆盖当时用例，不能抵消本次安全反例。未打包/安装/提交/发布，八项缺陷待修复。
