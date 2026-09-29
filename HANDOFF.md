# 当前接手入口 · 0.3.9（2026-09-28）

## 压缩上下文补计 + 按项目看用量 + 时间线移到额度详情 · 已完成并交付免安装目录版（2026-09-28 23:03 本地，Claude）

- 用户本轮三项要求，均算 **0.3.9**。只打 dist 免安装目录版，不打安装包、不提交、不发 GitHub：①Agent 压缩上下文消耗的额度没被扫到，导致周额度估值偏低（BUG）；②用量明细加「按项目」视图：每个项目文件夹被多少个 Agent 对话改过、多少 Token / 额度、由哪些模型 × 思考等级组成；③「模型与思考等级 · 时间线」移到额度详情。全程未查看图片或截图。
- **① 压缩上下文补计**（`src/core/usage-scan.ts`）：`STATE_VERSION` 8 → **9**，三家会话整份重算，重读的流水扫完后按 id 整理去重。估算出的流水带 `compaction: true`；`request-log.ts` 把这类行的核验固定为「无法核验」，说明写「压缩上下文（估算）」。
  - 对真实日志核对的结论：Codex 0.155+ 的压缩调用有 token_usage_record，原本就已计入，不重复估。Codex 0.149–0.154 只写 token_count，远端压缩（`compacted`，message 为空）没有任何 usage，累计值也不涨。Claude Code 的 `system/compact_boundary` 只记了 preTokens。Grok `auto_compact_completed` 的那次调用不在轮内的 modelCalls 里：7 个 turn_completed 的 modelCalls 合计 214，正好等于 loop_started 的 214 次。
  - 估算方法：输入 = 压缩前的上下文。Claude 取 preTokens，全部按缓存读；Codex 取上一次调用的输入 + 输出，缓存按上一次的比例；Grok 取 tokens_before，缓存按上一轮的比例。输出 = 摘要长度。Claude / Grok 按摘要文字估，汉字 1 个算 1 Token、其余 4 字符算 1 Token；Grok 读 compaction_checkpoint 文件，路径不能越出会话目录。Codex 按密文长度 × 0.17 估，这个系数用 5 次 0.155+ 真实记录校准（0.164–0.173）；输入的估法与实测误差在 5% 以内。
  - 边界处理：Grok 的压缩要等本轮 turn_completed，型号用这一轮实际计费的型号。文件开头继承来的压缩（还没有 token_count）不算。增量读取正好切在分界线和摘要之间时，跨批次也能记上。
  - 本机真实数据只读扫描到临时目录（已删除）：补回 23 笔（Claude 8、Grok 11、Codex 4），约 1300 万输入 Token。
- **② 按项目**：
  - 后端 `src/core/request-log.ts`：`RequestQuery.projects` 返回 `ProjectAggregate[]`，跟随明细页的全部筛选。`projectKey` 把 Windows 路径的大小写、`/` 和 `\`、末尾斜杠归并成同一个项目，原有的项目筛选也改用同一套归并。`src/main/index.ts` 的 parseRequestQuery 接收 `projects`。
  - 周额度用 `projectQuota` 算：生产环境里 capacityHistory 被 0.3.9 的共享额度保护清空了，按容量折算的话永远是「无法折算」，所以改用官方周额度采样。在 quotaAttribution 判为 local_present 的区间里，把涨幅按同期 API 等价费用分给各项目（费用为 0 时按 Token），跨几周累加。分母是同一账号的全部官方请求，不受筛选影响。unmatched / uncertain 区间的涨幅不分给任何项目；同一时段如果也在聊天，结果会偏高，界面上有说明。
  - 前端：新文件 `renderer/usage-projects.js`、`renderer/usage-projects.css`。`index.html` 在「逐条请求 / 按日汇总」旁加第三个视图「按项目」和 `#project-count`；`app.js` 的 `showUsageView` 改成三个视图，`renderUsage` 调用 `PulseProjects.render()`。
  - 界面内容：顶部四格汇总（项目数、Agent 对话数、Tokens、折合周额度）；搜索框和排序（Tokens / 额度 / 对话数 / 最近）。每个项目一张卡：文件夹名和路径、各工具的对话数标签、Tokens、周额度 ≈ x% 和参考费用，下面一条模型 × 思考等级构成条（颜色区分模型，深浅区分等级），再下面是对话数、调用次数、占比、最近使用时间和「含压缩 N 次」。点开卡片看组合表、Agent 分布、Token 构成、时间范围、额度和压缩说明，也可以「查看这个项目的请求」直接跳到逐条请求并带上项目筛选。每页 12 个，可以「显示更多」。定时刷新时展开状态保留；支持夜间模式、900px 宽度和减弱动态效果。
- **③ 时间线**：`#quota-model-timeline` 移到 page-quota，放在「换一种模型，整窗能用多少」下面。`renderQuota` 调 `PulseModelStudy.timeline(current, account.accountId)`，时间线跟随额度页的账号标签，原来自带的账号选择器和对应 CSS 已删除。用量明细页不再有时间线。
- 同步修改：`renderer/i18n.js`（新增词条和模板，「最近」模板只匹配日期，避免抢走「最近 30 天…」）；README 新增 0.3.9 小节；`scripts/capture-ui.cjs` 的选择器已更新，但**没有运行**，因为它会生成截图。
- 测试：
  - 新增 `scripts/test-usage-scan.cjs` 的压缩用例（Codex 新旧格式、Claude 跨批次、Grok 型号 / 缓存比例 / 路径越界、v8→v9 不重复计），共 16/16。
  - `scripts/test-requests.cjs` 新增项目归并、对话数、组合、压缩、Grok 调用次数、项目筛选归并、周额度分摊、筛选后分母不变，共 57/57。
  - 新增 `scripts/test-usage-projects-ui.cjs`（已加入 test:ui）；`test-model-study-ui.cjs` 改成在额度页通过账号标签切换账号。
  - 最终结果：**`npm test` 退出 0，`npm run test:ui` 退出 0**，日志中的 Simulated / Synthetic 是既有的注入失败分支。日志在会话 scratchpad：npm-test.log、npm-test-ui.log。
- 产物：`npm run compile` 后执行 `npx --no-install electron-builder --dir --publish never`，退出 0。**`D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe`**，ProductVersion 0.3.9.0，构建时间 23:03。app.asar 里的 usage-projects.js/.css、index.html、app.js、model-study.js、i18n.js、build/core/usage-scan.js、request-log.js、build/main/index.js 与工作区逐字节一致；asar 里的 package.json 被 builder 改写过，版本仍是 0.3.9。未生成 Portable 或安装包，未安装，未提交，未发布。
- 收尾：测试和打包进程残留为 0。TokenPulse.exe、app.asar、build/core/usage-scan.js、request-log.js 独占打开检测通过，句柄已立即关闭。用户正在运行的已安装版 `AppData\Local\Programs\TokenPulse`（5 个进程）没有动。本轮没有 EBUSY / EPERM。git diff --check 只报了 CRLF 提示；这些文件在 HEAD 就是 CRLF，已确认没有混用换行。
- 注意与已知限制：
  - 新版第一次启动会因账本 v9 重扫全部会话，本机约 800MB，实测几秒钟。重扫后历史用量会增加压缩那部分。
  - 压缩的用量是估算：Claude 假定上下文全部命中缓存，如果压缩前缓存已经过期，实际花费会更高；Codex 系数来自 5 个样本。
  - 按项目的周额度是按同期涨幅分摊的，同一时段也在聊天或用其他设备时会偏高；没有同期额度采样的用量不折算，卡片上显示「额度无法折算」或「非官方账号」。
  - 项目按精确工作目录归并，子目录（例如 `EnglishLearningWeb\server`）算作单独的项目。
  - 视觉效果、英文界面的实际观感由用户验收；没有启动产物做人工检查。
- 下一步：用户从托盘退出已安装的旧版后，运行上面的目录版验收。如需调整界面，改 `renderer/usage-projects.*`，并同步 `scripts/test-usage-projects-ui.cjs`。

## 配置安全修复 · 已完成并交付免安装目录版（2026-09-28 22:26，本地 America/Los_Angeles；其产物已被上面 23:03 的目录版取代）

- 用户授权修复原审计风险后打 dist 供测试。版本保持 **0.3.9**，未安装、未提交、未发布；原有用户改动全部保留。全程未查看图片/截图，验证仅用源码、文本、DOM及合成临时配置。
- 已修原8项：同URL账号身份、外部修改归属保护、TOML多行/引号键/类型、失败后的状态一致性、退出不覆盖外部连接、Claude角色/鉴权导入、桌面profile恢复、Codex导入类型。兼容旧版已存字符串布尔/数字、CC auth API Key。
- 核心文件：src/core/agent-config.ts（同步事务、pending恢复、路径约束/互斥与首次备份）；agent-toml.ts（AST范围补丁与校验）；agent-switch.ts（本次接管快照、差异恢复、归属/导入/启动恢复）。package.json/package-lock.json锁定生产依赖 toml-eslint-parser@0.10.0。
- 退出与界面：src/main/index.ts 恢复失败取消退出并提示，成功后等待代理关闭；agent-proxy.ts 关闭本轮网络连接；renderer/agent-switch.js 明确显示外部配置未覆盖。Codex专用 tokenpulse_route 表保留用户 custom 表/扩展字段。
- 回归：原审计 scripts/audit-agent-config-safety.cjs **10/10**；scripts/test-agent-config.cjs **22/22**（多文件失败、发布/提交阶段子进程中断、外部修改、非法恢复路径、端口/互斥、退出重启、旧快照缺失、网络关闭等）。两者均已纳入 npm test。
- 最终命令与结果：**npm test 退出0；npm run test:ui 退出0；npx --no-install electron-builder --dir --publish never 退出0**。UI覆盖未覆盖提示、恢复失败取消退出与实际 app.quit。日志内 Synthetic/Simulated 错误是明确注入的测试分支，并非实际失败。
- 本轮全量UI第一次失败发现原数字动画首帧负进度：scripts/test-number-animation.cjs确定性复现 -4 后修复 renderer/app.js 一行 Math.max(0,...)，再全套UI通过；scripts/test-ui.cjs 和 test-model-study-ui.cjs补齐临时HOME隔离。没有通过删除/放宽断言绕过失败。
- 最终日志：C:\Users\7ipny\AppData\Local\Temp\tokenpulse-039-final-unit-f0425720a491427aba0181401aac4ef4.log；同目录 tokenpulse-039-final-ui-f0425720a491427aba0181401aac4ef4.log。
- **最新产物：D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe**，package 0.3.9 / ProductVersion 0.3.9.0，构建时间 2026-09-28 22:26。已包含配置安全修复，不是之前仅UI修复的目录版；未生成单文件Portable或安装包。
- 包校验：app.asar内8个关键核心/主进程/渲染文件逐字节匹配当前编译/源码；toml-eslint-parser 和 eslint-visitor-keys依赖已包含。未自动启动产物，等待用户测试；需保留整个win-unpacked目录。
- 收尾：构建与测试命令均退出；匹配相关测试/打包命令的进程残留0；build核心JS、新EXE、app.asar独占读取检测通过，检查句柄立即关闭。没有本轮真实EBUSY/EPERM，没有关闭用户正式软件。git diff --check通过（仅既有oauth.ts换行提示）。
- 已知边界：旧版接管没有本次快照时不能准确猜测原配置，会拒绝自动恢复并提示先备份/在原工具恢复直连；不凭空修补旧版已经损坏的配置。不是完全移植CC Switch或跨所有外部程序的文件系统原子比较交换，仍不建议两个管理器同时切同一工具。未做真实供应商API/CLI端到端或人工视觉验收。
- 文档：docs/provider-config-safety-0.3.9-fix.md；原审计报告保留为历史。下一步由用户测试新目录版；若遇缺快照/占用提示，记录工具、动作、错误文字后处理，不要删除真实配置或强行覆盖。

## 配置写入安全审计 · 历史检查点（2026-09-28 21:58 本地，后续已修复）

- 用户要求对照 D:\CodePorject\Exmaple\cc-switch-main（本地 3.20.4）检查写配置是否安全；TokenPulse 仍为 0.3.9。本轮不改产品逻辑和真实配置、不更新 dist、不查看图片、不提交/发布。
- 完整报告：docs/provider-config-safety-audit-0.3.9.md；可复现脚本：scripts/audit-agent-config-safety.cjs（独立于 npm test，当前有意保持安全断言红灯，不能当作已修复）。
- 已确认差距：CC Switch 采用结构化补丁、应用写锁、pending/hash 冲突检测与恢复；TokenPulse 只有简易行式 TOML、首次备份、单文件 rename，没有同等保证。
- 8 项已复现：同 URL 误判当前供应商；编辑过期当前记录覆盖外部连接；TOML 多行内容损坏；写入失败后内部指针未回滚；退出代理覆盖外部改动；导入 Claude 丢鉴权字段/角色；桌面恢复丢原 appliedId；CC 导入 Codex 布尔/数字写成字符串。
- 验证：npm run compile 通过；最终隔离审计连续两次均 2/10 通过、8 项失败，退出码 1。失败来自安全断言而非环境错误；合成临时 HOME/数据库/服务均清理。未重跑全量 npm test/test:ui，上一轮通过不代表这些新场景通过。没有远端 API 或真实 CLI 验证。
- 关键使用边界：当前 dist/win-unpacked/TokenPulse.exe 仍是 0.3.9 UI 修复版，核心/UI 三个文件与审计源码匹配，**也存在上述配置安全问题**。建议修复前由 CC Switch 管真实供应商，TokenPulse 仅统计/隔离体验；已开代理者退出会写配置，先备份并有序切回，勿盲目退出。
- 收尾：相关审计进程为 0；核心 build JS、dist EXE、app.asar 独占读取检测通过，句柄释放；未关闭用户进程。git diff --check 通过，仅原有 oauth.ts 换行提示。
- 下一步具体动作：用户确认修复后，优先完善事务恢复、外部配置归属保护、TOML 结构化补丁/类型保留，再修身份匹配和导入/恢复；把本审计用例转绿并补故障注入测试，最后按用户要求重新打包。不能把本次审计或下方历史 UI 修复当成配置安全已完成。

## 供应商排错与交互优化 · 已完成代码与自动化验证（2026-09-28，本地日期）

- 本轮用户授权检查 0.3.9 的供应商功能并优化交互。版本保持 **0.3.9**；后续已按用户要求生成 dist 免安装目录版（见下方产物记录），未提交、未安装、未发布；保留接手前所有未提交/未跟踪改动。下方是旧版本检查点，不代表本轮新增产物。
- 修复（src/core/agent-switch.ts）：正在直连的供应商编辑成跨协议/桌面模型映射时，在持久化前拒绝并提示先开启本地路由，避免把不兼容连接写入工具；禁止通过编辑改变供应商所属工具；本地路由自身地址保护补上 desktop 路径。
- 修复（renderer/agent-switch.js）：Grok 隐藏的必填模型不再阻止提交校验；保存时先跳到缺失字段所在步骤，再检查原生数值约束；输入去除首尾空白。Grok 获取模型结果可显示并填入模型；Codex 候选按槽位索引填入准确行，同角色不再覆盖第一行；已有模型不被候选静默覆盖。
- 交互：保留左侧二级设置菜单，增加上一步/下一步/保存按钮及边界状态；思考等级改成单击开关加独立默认等级下拉框；返回/取消/Escape 时有未保存修改则显示继续编辑/放弃修改。重复提交有保存锁；获取模型按钮有忙碌状态、错误处理及旧编辑器异步结果保护。
- 样式（renderer/agent-switch.css）：默认等级控件、编辑底部操作区跟随既有主题变量，操作区允许换行。
- 回归（scripts/test-agent-switch.cjs、scripts/test-agent-switch-ui.cjs）：实际先跑出直连不兼容保存、Grok 隐藏必填字段两处红灯，再修复；补本地 HTTP 模型候选、Grok 填入、Codex 第二行、默认等级、重复提交、未保存保护断言。测试隔离临时 HOME/数据目录，不操作真实账号凭证。
- 实际验证：npm run compile 通过；node scripts/test-agent-switch.cjs 通过；npx electron scripts/test-agent-switch-ui.cjs 通过；**npm test 全部通过；npm run test:ui 全部通过，退出码 0**；node --check renderer/agent-switch.js 通过；git diff --check 通过（仅原有 src/main/oauth.ts CRLF 转 LF 提示）。UI 日志中的 Simulated failure 为既有错误路径测试，相关断言通过。
- 全程未查看图片、未截图、未调用图片预览；验证使用文本、DOM、计算样式、900px 宽度与减弱动态效果断言。视觉体验由用户验收。未连接真实供应商做远端 API/CLI 端到端验证；已有完整流式转换等历史限制仍适用，本轮不是对全部协议的完整审计。
- 资源收尾：所有本轮命令退出；Win32_Process 匹配测试入口及项目 Electron 路径的残留为 0。build/core/agent-switch.js、build/main/index.js、dist/win-unpacked/TokenPulse.exe、resources/app.asar 以及 dist 根目录已有 exe/yml/blockmap 独占读取检测均通过，句柄 finally 立即关闭。没有关闭用户正式软件；检查是这些文件的当时共享占用检测，不是全目录/全系统解锁证明。
- 产物更新（2026-09-28 21:42，America/Los_Angeles）：用户要求生成 dist 免安装版本。npm run compile 与 npx --no-install electron-builder --dir --publish never 均成功退出，产物为 **D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe**（package 0.3.9，EXE ProductVersion 0.3.9.0），现已包含供应商修复。整个 win-unpacked 目录需保留，启动前先从托盘退出旧版。
- 本次打包验证：读取 app.asar 中 package.json 确认 0.3.9，renderer/agent-switch.js、renderer/agent-switch.css、build/core/agent-switch.js 与工作区逐字节一致。首次归档校验使用斜杠路径报 not found，改为 Windows 标准路径后通过，非漏包。未启动正式应用、未查看图片；本轮未重跑测试，上轮 npm test / npm run test:ui 全通过仍为最新测试记录。
- 本次打包收尾：匹配项目打包命令/路径的构建进程残留为 0；TokenPulse.exe、resources/app.asar、build/core/agent-switch.js 独占读取检测通过且句柄立即释放。没有 EBUSY/EPERM，没有关闭用户软件。未生成单文件 Portable 或安装包，未提交/安装/发布。下一步由用户运行该目录版验收。
- 环境：普通沙箱命令出现 helper_sandbox_lock_failed，随后命令经审批在沙箱外执行。当前无测试阻塞。

## 供应商专区 · 用户先停在这里（历史检查点，2026-09-28）

- 用户说目前感觉还行，先暂时这样，之后再继续优化。版本保持 **0.3.9**。不要自行提交、打安装包或发布。
- 当前可试的目录版：`dist\win-unpacked\TokenPulse.exe`。试之前从托盘退出已安装的 TokenPulse。
- 下一轮从用户新的优化要求开始。不要把这一版当成最终验收，也不要在没有新要求时重写供应商专区。

## 供应商专区 · 桌面端停住 + 编辑改成左侧菜单（2026-09-28，上一轮）

- 用户反馈：点 Claude 桌面端会跳回概览；编辑供应商不要再用右边浮层，改成二级设置菜单。版本保持 **0.3.9**。不提交、不发布。
- 原因：渲染时只认 `overview / claude / codex / grok / router / logs / import`，`desktop` 被改回概览。
- 已改：`desktop` 留在工具页。添加 / 编辑不再弹出右侧抽屉，左侧菜单换成「返回 / 基本信息 / 连接 / 模型 / 保存」，右边只显示当前这一项。
- 验证：`npx electron scripts/test-agent-switch-ui.cjs` 通过（点桌面端后选中项仍是 `desktop`；编辑页 `position` 是 `static`，左侧有 `edit-models`）。没有看图片。
- 产物：`dist\win-unpacked\TokenPulse.exe`，0.3.9。这次打包没有 EBUSY。未提交、未发布。

## 供应商专区 · 四家模型候选（2026-09-28，上一轮）

- 用户要求：对照 CC Switch，给 Claude Code、Claude 桌面端、Grok CLI、Codex 做各自的模型候选。有的能填多个模型，有的能同时勾选多个思考等级。版本保持 **0.3.9**。不提交、不打安装包、不发布。只编译免安装目录版。
- 对照：`D:\CodePorject\Exmaple\cc-switch-main` 的 `ClaudeFormFields.tsx`（角色行 + 1M）、`ClaudeDesktop` 手册（直连 / 模型映射）、`CodexFormFields.tsx` 的模型目录和 `ReasoningLevelsEditor`（none…ultra 多选 + 默认等级）、`GrokBuildProviderForm.tsx`（单模型 + 上下文窗口，Chat 格式另有思考开关）。
- 已完成：
  - 侧边栏「供应商」增加 **Claude 桌面端**。Gemini 仍然没有。
  - Claude Code：Sonnet / Opus / Fable / Haiku / 子代理各一行，显示名、实际模型、1M。留空的角色沿用 Sonnet。启用时写进 `~/.claude/settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 和 `[1M]` 后缀。
  - Claude 桌面端：直连或模型映射。映射时角色路由 `claude-sonnet-5` 等写进 `%LOCALAPPDATA%\Claude-3p\configLibrary\00000000-0000-4000-8000-000000176210.json`，本地路由把角色 ID 换成真实模型。测试时若设了 `AGENT_SWITCH_HOME`，写到该目录下的 `Claude-3p`，不碰真实桌面端配置。
  - Codex：模型目录可加多行。每行可多选思考等级，再点一次已选等级设为默认。启用时写 `model`、`model_reasoning_effort`，并生成 `~/.codex/tokenpulse-model-catalog.json`。本机有 `models_cache.json` 时用它当模板。
  - Grok CLI：一个上游模型、上下文窗口；可声明上游是否支持思考、是否支持思考等级。
  - 抽屉里可以「获取模型」（请求供应商的 `/v1/models`，密钥留在主进程）。
- 关键文件：`src/core/agent-models.ts`、`agent-switch.ts`、`agent-proxy.ts`、`agent-types.ts`，`renderer/agent-switch.js`、`agent-switch.css`，`src/main/index.ts` 的 `agent:models`。
- 验证：`npm test` 通过（含 Claude 角色、Codex 思考等级、桌面端映射）。`npx electron scripts/test-agent-switch-ui.cjs` 通过（菜单 8 项、四家工具卡、抽屉添加、启用、编辑留空保留密钥）。没有再跑整套 `npm run test:ui`。没有看图片。
- 产物：`npx electron-builder --dir --publish never` 成功，`dist\win-unpacked\TokenPulse.exe`，版本 0.3.9。这次没有 EBUSY。测试和打包进程已退出。已安装目录里的 TokenPulse 没有关。
- 未提交、未发布。体验前从托盘退出已安装的旧进程，再启动目录版。
- 还没做到 CC Switch 那一档的：完整流式协议转换、注释级配置补丁、预设供应商库、Codex 目录在没有 `models_cache.json` 时用的是一份骨架，Codex 若拒收目录，默认模型和思考等级仍会写进 `config.toml`。

## 供应商专区 · Claude 重做界面 + 删除 Gemini（2026-09-28，上一轮）

- 用户要求：Grok 4.7 做的「供应商」专区「很不人性化」，改成**有二级菜单**、不是全部堆在一个界面；删掉 Gemini（用户不用）。版本保持 0.3.9，不提交、不发布。
- 核对：用户真实的 `~/.gemini` 没被草稿改过（文件时间是 8 月 / 5 月），`~/.tokenpulse/backups/live-first-write/` 不存在（草稿从没写过 live 配置）；`~/.tokenpulse/agent-switch.json` 里有 14 个供应商、四家路由都关着。
- **已完成：后端删 Gemini。** `agent-types.ts`：AgentApp 只剩 claude / codex / grok，Upstream 去掉 gemini。`agent-switch.ts`：删 writeGemini / geminiDir / GEMINI_EXACT；读旧数据时丢掉 gemini 的 direct / route / exclusive 键和上游是 Gemini 的供应商；CC Switch 导入跳过 apiFormat=gemini。`agent-proxy.ts`：删 /gemini 路由、x-goog-api-key、v1beta 路径。`agent-convert.ts`：删 Gemini 请求 / 响应 / 流式转换。`tsc` 通过。`cc-switch.ts` 里的 Gemini 是用量导入的来源名，没动。
- **已完成：界面重写**（`renderer/agent-switch.js/.css` 整份重写，接口 / IPC 没变）：
  - 页面左边是二级菜单（`.pv-nav`，分组：概览 / 工具：Claude Code、Codex、Grok Build / 本地路由：路由服务、转发记录 / 管理：导入供应商），每项带一句当前状态（工具项显示当前供应商名，开了路由有「路由」徽章，路由服务显示运行中 · N 家）。右边一次只显示一块。上下方向键在菜单里移动。选中的分区记在 localStorage（`tokenpulse-providers-section`）。窗口 ≤1080px 时菜单变成顶部横排。
  - 概览：路由状态条（运行中脉冲点、转发数、成功率、端口）+ 三家工具大卡（品牌色顶条、当前供应商、直连 / 本地路由、供应商数、备用数），点卡片进入该工具。
  - 工具页：标题行有「直连 | 本地路由」分段控件和「添加供应商」；当前供应商大卡（地址、模型、接口格式、密钥末四位、路由地址、检测连通、编辑）；其他供应商列表：拖动把手排序（也可 Alt+↑/↓），行内图标按钮检测 / 编辑 / 备用 / 删除 + 「启用」。**删除要点两次**（第一次按钮变红提示，3 秒内再点才删，不弹系统对话框）。排序只在「当前以外」的列表里调，当前那家原地不动（修过一个 bug：按键会和看不见的当前那家交换）。
  - 新增 / 编辑在右侧抽屉（`.pv-drawer`）：名称、接口格式芯片（标「原生 / 需要本地路由」）、请求地址、API Key（编辑时留空 = 沿用原密钥，`keepKey`）、Claude 的密钥变量（AUTH_TOKEN / API_KEY，`ProviderView.apiKeyField` 新增字段带回来）、模型、备注。Esc / 点遮罩关闭，Tab 焦点留在抽屉里。
  - 路由服务：端口（运行时不能改）、三家开关（`.pv-switch`）和故障转移链（当前 → 备用 1 → 备用 2，带健康点）。转发记录：最近 30 条，失败行标红。导入：从当前配置收下（三家按钮）、从 CC Switch 导入。
  - 数据推送时只在内容变了才重画；抽屉开着或正在拖动时不重画。入场动画只在切换分区时播（`.chart-enter`），支持 reduced-motion。
  - i18n：新词条和带数字的模板加进 `renderer/i18n.js`；`app.js` 页面副标题去掉了 Gemini CLI。README 的 0.3.9 供应商段落改成二级菜单的说明、去掉 Gemini。
- 测试（2026-09-28）：`npm test` 通过（`test-agent-switch.cjs`：Gemini 用例改成「保存 Gemini 被拒、旧数据里的 Gemini 条目读入时丢掉、不碰 ~/.gemini」）。`npm run test:ui` 通过（日志 `.tmp-039-providers-ui.log`，20 个 PASS）。`test-agent-switch-ui.cjs` 按新结构重写：菜单 7 项、没有 Gemini、改端口、抽屉添加、启用写 Claude 配置且页面不出现密钥、菜单显示当前供应商、编辑留空保留密钥、Esc 关抽屉、Alt+↓ 排序、删除点两次、切本地路由 / 直连、夜间模式五个分区和抽屉都没有默认黑字、分区内容不伸出页面、抽屉完整在窗口里、900px 菜单变横排、reduced-motion。注意：测试窗口是隐藏的，Chromium 不推进隐藏窗口的 CSS 动画，量抽屉位置前要 `document.getAnimations().forEach(a => a.finish())`；`until()` 已改成先 await 再转布尔（以前 `!!promise` 恒为真，等 agentState 的断言其实没在等）。
- 没有看图片（遵守 AGENTS.md），版面只用 DOM / 计算样式验证，视觉由用户验收。
- 产物：`dist\win-unpacked` 又报 EBUSY（`npx electron-builder --dir --publish never` → `rmdir 'dist\win-unpacked'` EBUSY；没有任何进程从 dist 运行，自己的构建 / 测试进程都已退出）。按 AGENTS.md 没有删除 / 移动 / 强制解锁；改为构建到 `dist\v0.3.9\win-unpacked`（08:06），再用 `robocopy /E /IS /IT` 覆盖进 `dist\win-unpacked`（覆盖文件不受目录锁影响），两处 app.asar 逐字节一致，ASAR 里有新界面、没有 Gemini。**`dist\win-unpacked` 目录本身的占用没有解除**，占用者找不到。
- Git / 发布：和其他 0.3.9 改动一起都未提交、未发布。
- 没做（超出这次要求）：交接里「下一任要做出的使用效果」那一大段（按 CC Switch 的补丁方式保留注释、完整的流式协议转换矩阵、熔断健康、首次写入备份等）仍是后续大功能，这次只重做了界面和删了 Gemini，后端转发能力还是草稿那一档。

## 供应商与本地路由 · 用户不接受当前草稿，下一任重写

用户原话：这一版写得比较简单，不是想要的效果，交给另一个 AI 重写。版本保持 **0.3.9**。不要提交，不要打安装包，不要发 GitHub Release。用户说可以发布时再 `npm run dist` 并发布。

对照源码：`D:\CodePorject\Exmaple\cc-switch-main`（仓库内发布说明到 3.20.4）。用户要的是日常只挂 TokenPulse：各 Agent 一键换供应商，本地路由由 TokenPulse 在后台转发。先读下面「给下一位做新功能的 AI」和 `AGENTS.md`，再读 CC Switch 的 `src-tauri/src/services/provider/`、`src-tauri/src/live/project/`、`src-tauri/src/proxy/`，以及 `docs/user-manual/zh/2-providers/`、`docs/user-manual/zh/4-proxy/`。手册里的截图不要打开。

### 下一任要做出的使用效果

和 CC Switch 现在的主路径对齐，而不是再做一个「填四个输入框就能转发」的页面。

- **四家切换式工具**：Claude Code、Codex、Gemini CLI、Grok Build。同一时间一家只启用一个供应商。托盘按应用分子菜单，标题上能看到当前供应商，点名称即切换。Claude Code 热切换；Codex、Gemini CLI、Grok Build 在本地路由开启后，后续请求马上走新供应商，模型名变了仍可能要重启对应工具。
- **只改关键字段**。Claude 的 `~/.claude/settings.json` 只动 `env` 里的 `ANTHROPIC_*` / `AWS_*` / `VERTEX_REGION_*`、协议选择器和少数独有字段，外加顶层 `model` 等；`hooks`、`permissions`、`enabledPlugins` 不动。Codex 的 `~/.codex/config.toml` 只动 `model_provider`、`model`、推理档位和 `[model_providers.custom]`，第三方 Key 写 `experimental_bearer_token`，`requires_openai_auth` 按「盘上还有没有官方登录」决定，**不要删 `auth.json`**。Gemini 只改 `.env` 里的关键行和 `settings.json` 的 `security.auth.selectedType`、`model.name`。Grok 只改 `models.default` 和自己写入的那一张 `[model."<名称>"]`，用户的其他模型表不动。注释和排版按 CC Switch 的补丁方式保留（`live/patch`），不要整份 `JSON.stringify` / 重排 TOML。每个文件第一次改写前，把原文件备份到 `~/.tokenpulse/backups/live-first-write/`。
- **本地路由是主体，不是附加开关。** CC Switch 默认 `http://127.0.0.1:15721`。开启后，工具配置里的地址改成本地，密钥换成字面量 `PROXY_MANAGED`（旧版靠这个字面量识别接管，不能改词）。真实地址、密钥、模型留在 TokenPulse。按工具分别开关；全部关掉后服务停止。窗口收进托盘时服务继续跑。正常退出先把配置写回「直连」那一家，下次启动再接上。官方供应商不走路由（Codex 的 OpenAI Official 在 CC Switch 里是例外，因为它转发的是 Codex 自己的登录；TokenPulse 仍然不读、不刷新 CLI 的 token / refresh token）。
- **协议转换按 CC Switch 的矩阵做，并且要能流式用于真实 CLI。** Claude Code 发出 Anthropic Messages，可转到 OpenAI Chat、OpenAI Responses、Gemini `generateContent`。Codex / Grok Build 发出 OpenAI Responses，可转到 Chat Completions 和 Anthropic Messages。同协议原样流式转发，保留头的大小写语义如果 CLI 会校验。转换要覆盖工具调用、流式增量、思考/reasoning、图片；Codex 的 `previous_response_id` 不能在转到 Chat 时丢掉工具调用上下文。CC Switch 里这些在 `src-tauri/src/proxy/providers/` 的 transform 与 streaming 文件，体量很大，不能用「文本加一次 function call」代替。
- **故障转移**：每家一个有序队列、熔断、健康状态。响应头还没写回客户端时，429 / 5xx / 网络失败才换下一家。队列和当前供应商要在页面上看得见。
- **供应商从哪来**：预设填 Key 即用；自定义；从本机 CC Switch 库 `~/.cc-switch/cc-switch.db` 的 `providers` 只读导入（`settings_config`、`meta.apiFormat`、`category`、故障转移标记），不写它的库。第一次启动把各工具现有配置收成供应商，不弄丢用户现在的 Key。编辑某一家时，编辑器里看到的是「切到这家之后配置文件的样子」：关键字段归这家，其余改动写回 live、对所有供应商生效。
- **界面**：新专区，沿用 TokenPulse 现有卡片、品牌图标、分段控件、入场动画只挂在 `.chart-enter`、CSP 禁止 HTML `style`、文案进 `renderer/i18n.js`。用户讨厌「下拉框再点查询」。当前草稿被评价为太简单，重写时按额度详情、用量分析那几页的完成度来，不要表格加四个输入框。

共存式工具（OpenCode、OpenClaw、Hermes、Pi、MiniMax Code）、MCP / Skills / 提示词面板、WebDAV、Deep Link、Copilot OAuth，用户这次点名的是供应商切换和本地路由。先把上面四家和路由做完整。用量统计 TokenPulse 已经有，路由产生的请求日志要能对上现有用量，不要再做一套无关的账。

### 工作区里已经有一版草稿，用户不接受

草稿能切换四家、能在 `127.0.0.1:17621` 转发、同协议流式透传、文本和函数调用的粗转换、503 时换备用、从 CC Switch 库导入基本字段。用户看过效果后否决。下一任重写这一功能；草稿里的测试锁的是这套简表单，重写后要改测试，不要为了让旧测试通过而把行为留在这一档。

草稿文件：

| 路径 | 作用 |
| --- | --- |
| `src/core/agent-types.ts` | 四家工具、四种上游协议、`PROXY_MANAGED` |
| `src/core/agent-switch.ts` | `~/.tokenpulse/agent-switch.json`；写 live；导入 |
| `src/core/agent-proxy.ts` | 本地 HTTP 路由、备用、连通探测 |
| `src/core/agent-convert.ts` | 短转换器 |
| `renderer/agent-switch.js` / `.css` | 「供应商」页 |
| `scripts/test-agent-switch.cjs` | 已接入 `npm test` |
| `scripts/test-agent-switch-ui.cjs` | 已接入 `npm run test:ui` |

接入点：`renderer/index.html` 导航与页面、`renderer/app.js` 的 `navigate('providers')`、`renderer/i18n.js`、`src/main/index.ts` 的 IPC `agent:*` 和托盘子菜单、`src/main/preload.ts`、`package.json` 的 `test` / `test:ui`、`README.md` 里描述草稿的那一节。Grok 草稿写入的表名是 `tokenpulse_route`。日志在 `~/.tokenpulse/agent-switch-log.json`。

数据副作用：点过「启用」或打开过路由的话，`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.gemini/.env`、`~/.gemini/settings.json`、`~/.grok/config.toml` 可能已被改写。第一次改写前的副本在 `~/.tokenpulse/backups/live-first-write/`。下一任先看这些文件再改写入逻辑，不要假设它们还是用户原来的内容。密钥在 `agent-switch.json`，交接和日志里不要打印。

草稿的验证只说明「简版当时能跑」，不是用户验收：2026-09-28 `npm test`、`npm run test:ui` 通过。其后只改了卡片上「当前 / 直连」的标法并重新打了目录版，没有再跑整套 UI。产物 `dist\win-unpacked\TokenPulse.exe` 文件版本 0.3.9，ASAR 里有 `build/core/agent-switch.js` 和 `renderer/agent-switch.js`。打包时 `dist\win-unpacked` 没有 EBUSY。测试和打包进程已退出。正在运行的是已安装目录 `AppData\Local\Programs\TokenPulse` 里的 TokenPulse，没有关。

### 必须保住的 0.3.9 其他工作

共享额度池保护、Codex 旧 `token_count` 补计、账本 `STATE_VERSION` **8**、知识库 `2026.09.28.1` 都还在工作区，和这版草稿一起**未提交、未发布**。已发布的是 `v0.3.8`（`46cb39e`）。不要恢复「用本机日志倒推账号总容量」。不要动 CLI 凭据，测试用 `TOKENPULSE_DATA_DIR` 和 `AGENT_SWITCH_HOME`。禁止看图片。重写完成后：`npm test`、`npm run test:ui`、`npx electron-builder --dir --publish never`，确认没有遗留的 electron / app-builder，再更新本节。

未跟踪、和本功能无关、不要提交：`.tmp-*`、`dist-preview/`、`dist-egress-preview/`、`AGENTS.md` 若用户没要求提交就先留在工作区（`AGENTS.md` 是协作约定，提交前看用户是否要收进仓库）。`src/core/quota-attribution.ts`、`quota-calibration.ts`、`scripts/test-shared-quota.cjs` 属于额度保护，保留。

### 下一任的第一步

1. 读本节、下方风格约定、`AGENTS.md`，再读 CC Switch 的 live 投影和 `proxy/providers` 转换，确定重写范围后再改。
2. 用临时 HOME 看清草稿已经写过的配置；需要的话从 `live-first-write` 备份理解原文件，不要手改用户真实密钥文件。
3. 重写供应商专区和本地路由，版本保持 0.3.9。做完更新本节，写明测试命令、结果、目录版路径，以及还没有提交和发布。


本轮从已发布的 0.3.8 继续修复共享额度池的归因与换算，版本为 **0.3.9**，尚未提交或发布。下方 0.3.8 的说明按历史阅读，尤其不要恢复默认用本机日志倒推账号总容量的算法。用户要求禁止查看图片/截图，继续只用源码、日志和 DOM 验证。

## 给下一位做新功能的 AI：风格与做法（2026-09-28，Claude 整理）

用户接下来要做一轮较大的新功能，由另一个 AI 负责；Claude 之后主要负责修 Bug。下面是这个项目一路做下来、用户认可的风格和踩过的坑。**先读完这一节和 AGENTS.md 再动手。**

### 用户的偏好（最重要）

- **直接呈现，不要让用户「查询」。** 用户明确不喜欢「选下拉框 → 点查询 → 才出结果」（0.3.8 第一版就因此被推翻）。能一次算出来的就直接全部列出（例如 5 小时和周两个窗口同时显示）；切换用按钮 / 分段控件 / 芯片，不用下拉框。
- **要可视化、要动效、要图标。** 纯文字表格会被评价为「不直观、不美观」。优先用条形图、时间线、圆环、卡片；每家用官方品牌图标（`avatar(kind)`、`miniLogo(source)`、`brandSvg(brand)`）。
- **先给结论，再给明细。** 例如「一眼看结论」卡片（最耐用 / 调用最多 / 你最常用）放在长列表前面。
- **全部列出，不截断。** 总览可以只列前几名，专门的页面要完整。重复的行可以合并（同模型换算结果相同的等级合成一行），但不能丢。
- **数字要真实，口径要写清楚。** 估算要标「估算 / 换算 / 实测 / 参考」，悬停能看到依据；算不出来就说明原因，不编数字。
- **版本号用户说了算。** 用户说这一轮算哪个版本就是哪个版本，不要自己升（见记忆规则）；只在用户要求时编译安装包、发布 Release。默认只编译免安装目录版（`npx electron-builder --dir --publish never` → `dist\win-unpacked`）。
- **提交信息、Release 说明里绝对不要放对话链接**（`Claude-Session` 之类），用户明确反感。只提交相关文件，别把 `.tmp-*`、`dist-*` 预览目录提交上去。
- 用户说中文，界面默认中文；回复简洁、说清做了什么和没做什么。

### 视觉风格

- 颜色全部用 `renderer/app.css` 里的变量（`--accent`、`--ring-five` 绿 / `--ring-week` 蓝紫、`--claude` / `--openai` / `--grok` 品牌色、`--muted`、`--line`、`--surface-2`、`--tile-neutral`、`--warn`、`--danger` 等），深浅色自动跟着走。**不要写死颜色**；新写的 SVG 文字 / 图形要自己给 fill，否则夜间模式是黑字（0.3.8 踩过：时间线坐标 100% / 50% 在夜间看不见）。
- 5 小时窗口 = 绿（`--ring-five`），周窗口 = 蓝紫（`--ring-week`），全应用统一。
- 卡片：圆角 12px 左右、1px `--line` 边框、悬停轻微上浮（`translateY(-1~2px)` + `--shadow-sm`）。分段控件用现成的 `.seg compact` + `syncSeg()`（带滑块）；标签用 `.section-tag`；徽章参考 `.ms-badge` / `.ms-level`。
- 字体：大数字用 `var(--font-display)` + `font-variant-numeric: tabular-nums`。
- 参考已经做好的模块照着写：`renderer/usage-insights.js/.css`（用量分析）、`renderer/model-study.js/.css`（模型排行 + 时间线）、`renderer/egress.js/.css`（出口监控）。

### 动效约定

- `render()` 每 30 秒 / 每次快照都会重建 DOM：**入场动画只能挂在 `main.entering` 或 `.chart-enter` 下**（用 `playChart(host, animate)`），否则每分钟重播一次。定时刷新只在数据真的变了时重画，而且不播动画；切账号 / 切周期 / 换排序才播。
- 缓动用 `var(--ease)`，弹性用 `var(--spring)`；现成 keyframes：`fade-up`、`fade-in`、`grow-x`、`grow-y`、`pop-in`、`draw`、`shimmer`。换排序可以用 FLIP（见 model-study.js 的 `flip()`）。
- 必须支持 `prefers-reduced-motion`（关掉 transition / animation），UI 测试里有检查。
- 数据每分钟重画时，要保住用户的状态（展开的 details、选中的筛选、高亮），参考 model-study.js 的 `Q.methodOpen`、`T.focus`。

### 技术约束（违反会直接出 Bug）

- **CSP 禁止 inline style**：HTML 里的 `style="..."` 会被整个丢掉。动态宽度 / 颜色一律用 CSSOM：`node.style.x = ...` 或 `style.setProperty('--var', ...)`（见 usage-insights 的 `paint()`）。SVG 的 `fill` 属性不认 `var()`，要用 `node.style.fill`。
- app.css 的 `.brand-svg` 是 100% 宽高：把品牌图标嵌进 SVG 时必须另给尺寸。
- `.axis` 只在 `.chart` 里有颜色；不在 `.chart` 里的 SVG 要自己写 `.xxx .axis { fill: var(--muted) }`。
- 渲染进程的全局工具（app.js）：`el`、`svg`、`icon`、`avatar`、`brandSvg`、`miniLogo`、`sourceLogo`、`tokens`、`money`、`number`、`amount`、`qty`、`cnApprox`、`tipAt`、`syncSeg`、`playChart`、`empty`、`date`、`dateLocale`、`state`、`current`、`api`、`META`、`reducedMotion`、`$`。新模块写成独立的 IIFE 文件（`renderer/xxx.js/.css`），在 index.html 里引入，暴露 `window.PulseXxx`，由 app.js 在对应 render 函数里调用。
- 重计算（扫描、查询请求流水、分析）放在 worker 里（`src/core/report-worker.ts` + `src/main/snapshot.ts` 的 `runWorker`），主进程不能卡；IPC 参数在主进程校验（参考 `parseModelStudyQuery`）。
- 异步加载：同一对象的迟到结果不能覆盖新选择（用 seq 计数）；失败时不保留旧账号的数据，给重试按钮；同对象数据更新时先显示上一份，免得页面跳（见 model-study.js 的 `loader()`）。
- **i18n**：界面文字写中文，英文靠 `renderer/i18n.js` 的 MutationObserver 翻译。新文字要在 `EN` 里加词条，带数字的句子加 `P(...)` 模板；`translate()` 会先按 `\n`、`；`、` · `、`，` 拆开再匹配，所以尽量把固定文字和数字放在不同节点里。用户内容（型号名、账号名）加 `translate="no"`。含反斜杠的正则用编辑工具写，不要用 bash heredoc（会吃掉 `\d`、`\v`）。
- 模型家族过滤：Claude 额度只认 `claude*` 型号（经 CC Switch 把 Claude Code 指到 deepseek / gpt 的请求会被判成官方会话，但不占 Claude 额度）；新功能涉及额度时沿用 `model-study.ts` 的 `FAMILY`。
- 共享额度池：Claude / Grok 的聊天和 Code 共用额度，**不要用本机日志倒推账号总容量或单次请求占用**（见下方 0.3.9 修复原则）。

### 数据与安全

- 不读、不打印、不改 CLI 的凭据（token / refresh token）；测试一律用临时 HOME 和 `TOKENPULSE_DATA_DIR`，不碰用户真实的 `~/.tokenpulse`、`~/.codex`、`~/.claude`、`~/.grok`。需要真实数据核对时，复制到临时目录（账号库去掉 `credential`）、只打印计数。
- 公开的 README 截图必须遮账号名和邮箱（`scripts/capture-ui.cjs` 已经处理，并在截图前检查泄露）。
- 改账本结构要升 `usage-scan.ts` 的 `STATE_VERSION` 并写清迁移（只补元数据 / 某个来源整份重算），测试「旧账本升级后不重复计」。

### 测试与交付

- 每个功能都要有测试：纯计算放 `scripts/test-*.cjs`（node），界面放 Electron 端到端测试（参考 `scripts/test-model-study-ui.cjs`：真实 IPC + worker + DOM 断言，覆盖切换、失败、迟到结果、900px 窄窗口、reduced-motion、夜间模式文字颜色）。新测试加进 package.json 的 `test` / `test:ui`。
- 交付前：`npm test`、`npm run test:ui` 都通过；编译目录版；确认 ASAR 里有新代码；确认没有遗留的测试 / 构建进程；更新本文件顶部。
- 不能看图片：视觉效果交给用户验收，自己用 DOM、计算样式、尺寸断言验证。

## 数据口径核对（Claude，2026-09-28，已完成）

- 用户要求：在 0.3.9 基础上排查还有哪些地方会算错数据并修复，之后开始新一轮功能。版本保持 0.3.9。
- 基线：`npm test` 通过（含 test-shared-quota）。
- 已核对无误（真实日志只读统计，只打计数）：Claude 同一 requestId 的多行 usage 完全一致、没有不连续重复；Codex `input_tokens` 已含缓存读 + 缓存写、无重复 response_id；Grok turn 无重复；三家都没有跨文件重复的请求 ID。
- **已修 1：Codex 旧格式漏算。** 119 个 Codex 会话文件里 27 个（CLI 0.149–0.155，08-23 至 09-23）只有 `event_msg` / `token_count`，以前完全没算。`usage-scan.ts` 新增 `codexTokenCountRow`：
  - 只用 `info.last_token_usage`（本次）；`total_token_usage` 在压缩上下文后会骤降、续接会话第一条就带着旧累计（实测 2500 万 vs 本次 21.6 万），不可用；
  - 累计 + 本次都不变的原样重复跳过（`FileState.lastTokenCount`）；
  - 文件里出现第一条 `token_usage_record` 后不再算 token_count（`FileState.codexRecords`）：新版两种都写且粒度不同（1800 条 record 没有一条和 token_count 数字相同）；实测新版同一轮不会先写 token_count，唯一一条早于 record 的属于换版本前那一轮，应该算。
  - `STATE_VERSION` 7 → 8：Codex 文件整份重算，其他来源从 7 升上来不重读。
  - 真实数据（临时目录）：Codex 2.679 亿 → **3.676 亿** Token，请求 1800 → 2702；Claude / Grok 不变。旧版账本（v7）接着用新版扫：结果与从零扫一致，流水无重复 ID。
  - 回归：`test-usage-scan.cjs` 新增 3 项（旧格式按本次计、跳过重复、不受累计骤降影响；出现 record 后不算 token_count；v7→v8 不重复计），11/11 通过。
  - 补回的 Codex 用量都有型号（旧格式文件也有 turn_context）：gpt-5.6-sol 2.19 亿、gpt-6-astra 7400 万、gpt-6-sol 5300 万等，全部有单价，没有落到「未知模型」。
- **已修 2：带日期后缀的 Claude Opus 4 / 4.1 单价错。** `knowledge/models.json` 的 Opus 4 规则 `claude.*opus.*4[.-]?[01]?$` 不认日期后缀：`claude-opus-4-1-20250805` 落到 Opus 4.5 的 $5/$25（应为 $15/$75，费用只算了三分之一）；`claude-opus-4-20250514` 碰巧因为日期以 4 结尾才对。改为 `claude-3-opus|claude.*opus-4(?:[.-][01])?(?:-\d{8})?$`；另加 Claude Haiku 3.5（$0.8/$4，以前按 Haiku 4.5 的 $1/$5）。知识库 version → `2026.09.28.1`（推到 main 后已安装版可在「设置 → 关于 → 模型知识库」更新）。用户自己的型号（opus-5 / 5-5、sonnet-5、haiku-4-5）原本就对。回归：`test-features.cjs`「Claude 各代单价：带日期后缀的也认对」。
- **核对后确认没问题的**（不用改）：
  - 三家日志字段口径：Grok / Codex 的 total = input + output，input 已含缓存读，reasoning 是 output 的子集；Claude 在扫描时把缓存读写补进 input。
  - report.ts 合计：今天 / 7 天 / 30 天按本地日历日；每个「天 × 来源 × 型号」估价一次，各口径共用；最近 60 天补空日。
  - renderer/data.js 的日期筛选、上一周期对比、按天补空、CSV 转义。
  - CC Switch 只补 TokenPulse 没有的「天 × 工具」：补回的 Codex 旧日子现在由 TokenPulse 覆盖，不会和 CC Switch 重复。
  - Claude 额度小时账已排除非 claude 型号（和 model-study 的 FAMILY 一致）。
- **没有改动的范围**：Astra 0.3.9 的共享额度池保护 / 校准 / 归因逻辑（quota-monitor、quota-attribution、quota-calibration、model-study 的共享池部分）只阅读了交接说明，没有改动。
- **已知限制（没修，需要时再议）**：长上下文加价（Anthropic 1M 上下文 > 200K 输入、OpenAI > 272K 输入的倍率）没有建模，单次输入很大的请求参考费用会偏低；知识库里也没有这些规则，没有凭空添加。
- 验证（2026-09-28）：`npm test` 全部通过（usage-scan 11/11、features 通过、模型 14/14、出口 17/17、共享池 3 项）；`npm run test:ui` 通过（日志 `.tmp-039-audit-ui.log`，19 个 PASS、无 FAIL）。
- 产物：`dist\win-unpacked\TokenPulse.exe`，0.3.9.0，2026-09-28 06:32 构建（日志 `.tmp-039-audit-build.log`）；ASAR 核对含 `codexTokenCountRow` 和知识库 2026.09.28.1。这次直接构建进了 `dist\win-unpacked`，没有 EBUSY。
- 收尾检查：构建 / 测试结束后没有遗留的 node / electron / app-builder 进程；正在运行的只有用户已安装目录的 TokenPulse（未动）。终端在项目根目录。
- **Git / 发布**：本轮改动（usage-scan.ts、models.json、两个测试、HANDOFF）和 Astra 的 0.3.9 改动一起都还没提交、没发布。用户说接下来要开始新一轮功能。
- 升级提示：第一次运行 0.3.9 时 Codex 会话会整份重扫一次（账本 v8），Codex 历史用量会多出约 1 亿 Token。已安装的 0.3.8 和 0.3.9 目录版来回切换会让账本在 v7 / v8 之间反复重扫。

## 持续交接约定（2026-09-28）

- 用户明确要求每次完成工作后都更新交接文档，尤其担心中途额度耗尽。此约定已写入项目根目录 AGENTS.md，供后续 AI 接手时读取。
- 长任务应在重要阶段完成、方案变化或出现阻塞时同步保存检查点；收尾再写清最终结果。记录已完成/未完成、关键文件、测试与产物、下一步，不能等最后一刻。
- 本轮仅新增 AGENTS.md 并更新本节，未修改业务代码、未重新运行测试、未重新打包。0.3.9 的验证结果和产物仍为下文记录的上一轮结果。

## dist 占用检查与收尾约定（2026-09-28）

- 用户反馈 dist 曾被占用，影响下一位 AI 打包。本次检查除自身诊断进程外，未发现可识别的本项目测试 Electron / electron-builder / app-builder 残留；正在运行的 TokenPulse 来自用户已安装目录，不是工作区 dist。本轮未终止任何进程。
- 非破坏性 Windows 共享检查：对 dist、dist/win-unpacked、其 resources、TokenPulse.exe、resources/app.asar 申请 DELETE 访问且允许共享读/写/删除，均成功（Win32Error 0），句柄在 using 中立即关闭。没有执行删除、移动或重命名。
- 结论仅是这些关键路径**在检查时未检测到阻止该访问的共享占用**，不是所有后续构建必定成功的保证。本次无需强制解锁；历史 EBUSY 的占用者无法由当前状态追溯确定。
- 新增 AGENTS.md 收尾规则：等待自有测试/构建结束、释放句柄/watcher、避免终端停在产物目录、检查占用、只清理归属明确的自有残留；不批量结束用户程序或修改安全设置。
- 本轮只更新协作/交接文档，未修改业务代码，未重新编译或打包。0.3.9 产物与功能测试结论仍以之前记录为准。

## 修复原则

- 官方百分比、剩余比例、重置时间和速度预测属于整个账号池。Claude/Grok 的聊天与 Code 可共享额度，其他设备也可能消费。**不修改官方已用，不猜测扣除聊天消耗，不把聊天额度加回剩余。**
- 本机日志只覆盖可记录、可归属的 Code 请求。即使区间内有 Code 请求，也不能排除同期聊天；“剔除没有 Code 的时段”不足以解决混用归因。
- 默认保护所有账号/窗口的绝对容量换算。只显示官方总池百分比、本机真实 Token/费用，以及明确标成 API 价格参考的相对值。相对价格不是额度倍数。
- 原先的整窗历史容量倒推、每次请求额度占比等入口不再发表未经归因的数字。原始额度历史和本机用量数据保留。

## 可选的前向本机校准

- 额度详情保留 0.3.8 的图形、品牌图标、双窗口、排序、时间线和动效；增加折叠的共享额度保护/校准控件。
- 用户必须明确勾选：所选的 1/2/4 小时（默认 1 小时）只用所选账号的本机 Code，不用聊天或其他设备；前 10 分钟缓冲，按正常工作采样，不发额外模型请求。可提前结束或作废；到时自动结束。
- 起止时间由主进程生成，不能通过 IPC 传旧时间来批量确认混用历史。同账号只允许一个活动段，记录限 200 条。模型分析仍只用最近 30 天样本。
- 校准元数据在 ~/.tokenpulse/quota-calibrations.json（可被 TOKENPULSE_DATA_DIR 隔离）。完全删除账号时同时清理其校准记录。
- 发现明显未匹配本机日志的增长时，整段校准暂不采用，不挑其中好看的区间。后续在校准段之外发生的聊天，不污染之前确认段的参考；当前余量仍按最新官方剩余比例计算。
- **校准仍依赖用户确认，不是软件自动验证了所有消费来源。** 如果校准时同时聊天且 Code 也在用，现有数据无法必然识别，用户应作废该段。不要宣传为精确聊天识别或固定官方额度。

## 计算与展示

- 新模块 quota-attribution.ts 给出时间区间的同步观测：有本机请求、未匹配本机记录、无法归因。使用 5 分钟邻接/落账缓冲；长采样缺口保持无法归因。诊断按累计至少 1 个百分点的变化分段，小变化和窗口首个样本前的消耗不能据此完整分拆。
- 时间线保留官方额度阶梯曲线与 Code 轨道，新增淡黄色未匹配/不确定增长带及说明。未匹配不等于确定聊天，可能是其他设备、缺日志或统计延迟。
- Budget/pure-combo 的绝对学习只接受确认段内的区间，且排除被检测污染的确认段；历史未确认区间保持隔离。
- 预算最低需要 3 个有效区间和累计 5 个百分点；中等参考强度还需 6 个区间、15 个百分点、2 个周期，修复了旧分支用两段跨周期大增量绕过最低样本数的问题。
- 合格的同模型/等级样本优先于跨模型 API 价格模拟，避免不同模型的 API 价格差覆盖真实百分比样本。没有专属数据的按价模拟明确标为情景假设，不是官方扣额关系或保证。
- 取消“还剩约多少美元”的钱包式文案，显示真实官方剩余百分比；API 等价参考仍不是订阅余额。
- 旧 analyzeWindow/capacityHistory 辅助函数默认也禁止容量倒推；只有内部完整数据集显式 completeLocalOnly 时可计算。生产账号报告不作这个假设；现有历史数学夹具明确其合成数据完整性。

## 关键文件

- src/core/quota-attribution.ts：区间来源观测与汇总。
- src/core/quota-calibration.ts：用户确认的前向限时记录（最长 4 小时）、校验、结束、作废、到期、账号清理。
- src/core/model-study.ts：共享池保护、确认段选样、污染段隔离、样本门槛和直接证据优先。
- src/core/quota-monitor.ts：默认关闭未经归因的旧容量公式，保留官方百分比/趋势、本机实际用量。
- src/main/index.ts / preload.ts：models:calibration IPC；src/main/oauth.ts：purge 时清理。
- renderer/model-study.js/css：校准控件、来源提示、未匹配时间带和价格/容量语义；renderer/app.js：主额度区及旧容量/单次占比说明；i18n.js：中英词条。
- scripts/test-shared-quota.cjs：新增反例、同期使用不可识别、已确认参考不被后来聊天污染、污染段隔离、跨账号、官方余量不被虚增、样本优先/门槛、前向确认与清理测试。
- 原模型测试的数值夹具显式声明确认段；原 quota-monitor 的完整数据数学夹具显式 completeLocalOnly，真实账号输出测试确认保护。

## 验证状态

- 最新目录版：`D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe`，版本 **0.3.9.0**。最终 ASAR 确认包含共享池保护、1/2/4 小时校准及来源分析；打包代码的原 UI 与模型/校准 UI 回归均通过。
- 打包日志：.tmp-039-build.log、.tmp-039-packaged-ui.log。未安装、发布或关闭用户的 0.3.8；体验前应从托盘退出旧进程，再启动目录版。
- 周额度增长慢时可选择更长的确认时段；默认 1 小时，最长 4 小时，更改时长会撤销勾选并要求重新确认。已有有效参考可跨后续共享使用继续作为条件性参考，不能保证未来固定额度。

- npm test 通过，包括原有 17 项出口监控、14 项模型分析，以及新的共享池/校准回归。
- npm run test:ui 通过；新增 DOM 测试确认必须勾选、作废后撤下绝对推算、不能回填旧历史、时间线出现未匹配增长带、本机 4K Token 不变而官方已用变为 36%。
- 排查并修正了一处既有 UI 测试竞态：不能只等 50ms 的文本事件就断言 80ms 的工具事件已出现，改为等待真实工具 DOM；没有修改会话业务代码或放宽要求。
- 日志：.tmp-039-tests.log、.tmp-039-ui.log、.tmp-039-model-ui.log。故障注入产生的 Simulated 错误是预期测试。
- 未更改真实账号、代理配置或历史用量；未安装、发布、提交；没有查看图片。下一位 AI 应保留保护默认值，不为让数字出现而撤掉来源前提。

---

# 0.3.8 历史资料

# 当前接手入口 · 0.3.8（2026-09-28）

这是 TokenPulse 当前工作区的最新接手说明。当前版本为 **0.3.8**，已于 2026-09-28 提交（`46cb39e`）、打标签 `v0.3.8` 并发布 GitHub Release（Setup、Portable、blockmap、latest.yml）；0.3.7 及更早的安装版会自动更新到它。

## 1. 用户协作约定

- 项目目录：`D:\CodePorject\Tools\TokenPulse`；Windows / PowerShell；Electron + TypeScript + 原生 HTML/CSS/JS。
- **不得查看图片、截图或图片预览**。用户明确说明这会导致客户端报错。后续使用源码、日志、DOM、计算样式、尺寸和自动化测试验证，视觉体验由用户验收。
- 保持版本 **0.3.8**，不要擅自升级版本号。保留现有筛选、轻量动效、键盘交互、reduced-motion、出口监控及额度出口拦截。
- 当前工作区有未提交的 0.3.8 源码改动和新增文件；先运行 `git status --short`，不要使用 `reset`、`checkout`、`clean` 丢弃改动。
- 不输出真实 token、refresh token、账号凭证或完整私密日志；测试使用临时目录和假数据。不要改 CLI 登录文件或用户代理配置。
- 工作区中已有临时图片和预览目录：`.tmp-037-light.png`、`.tmp-037-dark.png`、`.tmp-grok-home-test/`、`dist-preview/`、`dist-egress-preview/`。本轮没有查看或清理它们，不要把图片查看作为验证步骤。

## 2. 0.3.8 新增功能

> 2026-09-28 第二轮：用户不满意 Astra 版（要手动选窗口/周期「查询」、大多数组合显示「待校准」、没有动效和图形），两个专区按下面重做。

### 2.1 额度详情：「换一种模型，整窗能用多少」

- 跟随额度页选中的官方账号，**不用任何查询**：一次 IPC 同时算出 5 小时和周两个窗口（`queryModelStudy` 返回 `{ five, week }`）。
- 顶部两块「整窗预算」卡（API 等价 $、本周期已用 / 还剩、样本区间数、可信度）。
- 排行：每行一个组合，两列条形图（5 小时 / 周）：浅色 = 整窗容量，深色 = 本周期还剩；数字是容量 Tokens 和「≈ 次调用」。排序（分段控件）：容量 / 请求次数 / 常用 / 名称；等级筛选芯片。换排序有 FLIP 位移动画，首次出现有条形生长和逐行淡入（只在 `.chart-enter` 下，定时重绘不重播）。
- 同一模型里没有自己数据、换算结果完全相同的几个等级**合成一行**，等级徽章并排（否则 ChatGPT 39 行大半重复）；有自己数据的等级单独一行。
- 悬停 / 键盘聚焦有完整说明（两窗口容量、实测区间、单价来源、目录来源）。
- 第三轮（用户：「不直观、只有文字不美观，加 AI 公司的 icon」）：标题左边大号品牌图标；预算卡下面三张「一眼看结论」卡（最耐用 / 调用次数最多 / 你最常用，带品牌图标、等级徽章、大号数字）；每行前面品牌图标方块（悬停微转）；时间线轨道和组合列表也加了品牌图标。注意 app.css 的 `.brand-svg` 是 100% 宽高，嵌进 SVG 必须另给尺寸（`.ms-lane-logo`）。
- 没有整窗预算（例如本机没有 Grok 账号的用量）时，按价格表显示相对容量「×N」，并说明原因。

### 2.2 用量明细：「模型与思考等级 · 时间线」

- 账号用按钮切换（不再是下拉 + 查询）；当前 5 小时周期和本周周期**两张时间线同时显示**，各自可用 ‹ › 翻到以前的周期。
- 上方叠加官方额度已用的阶梯曲线（可悬停看采样）；下面每个模型 × 等级一条轨道，相邻时间格连成一段（5 小时窗口间隔 ≤5 分钟、周窗口 ≤45 分钟算连续）；同一模型同一色相，等级越高越实；有「现在」竖线。
- 下方是组合用量条（占比、调用次数、费用）；点组合或轨道只高亮它，再点恢复。
- 没用过的周期不列（ChatGPT 5 小时窗口闲置时重置时间一直后挪，会凑出上百个空周期）；当前周期刚开始没有请求时提示点 ‹。
- 失败不保留旧账号数据，有重试；同账号数据更新时先显示上一份，切账号 / 周期的迟到结果不会覆盖。

### 2.3 思考等级采集

- Codex：从当前回合的结构化 `turn_context.effort` 读取；缺失就记录为未知，不沿用上一回合等级。
- Claude：从每条 assistant 响应根字段读取，`perTurnEffort` 优先于 `effort`；用户正文、`reasoning token` 数量不作为等级证据。
- Grok：只接受能明确绑定到当前回合/模型的结构化等级；无法稳定关联的聊天历史保持未知，不按出现顺序猜测。
- 请求流水 CSV 新增「思考等级」和「等级来源」列；关键词搜索也包含思考等级。

## 3. 估算口径与已知限制

- 校准范围：最近 30 天；按账号和窗口类型分别计算，复用现有 `windowSegments` 处理重置卡和周期切分。
- **整窗预算**（第二轮新增，主口径）：所有可用采样区间里本机官方请求的 API 等价费用 ÷ 官方已用百分点 × 100。费用可跨模型相加，所以混用模型 / 未知等级的区间也计入（纯区间只占少数）。可信度：≥15 个百分点且 ≥2 个周期为「较充分」，≥5 个百分点且 ≥3 个区间为「初步」，否则不给预算。
- **每个组合的容量** = 整窗预算 ÷ 组合每 Token 参考单价。单价：组合自己 ≥30 条带价请求时用它自己的实际费用（含它的缓存比例）；否则用同模型全部等级的；再没有用价格表 × 本账号用量结构（账号没用量时用典型 CLI 结构：输入 85% 为缓存读取）。
- 依据（用户真实数据，2026-09-28）：ChatGPT 5 小时窗口里，不同模型纯区间实测的整窗 Token 在 23M–35M 之间差很多，但整窗 API 等价费用都在 $19–24；汇总预算 $22.41。说明官方额度大体按 API 等价费用消耗。
- 纯区间实测（3 个区间 + 5 个百分点起算）仍然保留：可信度「较充分」（6 区间、15 百分点、2 周期）或没有换算值时，直接用实测值，界面标「实测」。
- **家族过滤** `FAMILY`：Claude 只认 `claude*`、ChatGPT 只认 `gpt* / codex* / o\d*`、Grok 只认 `grok*`。经 CC Switch 把 Claude Code 指到 deepseek / gpt 等的请求（真实数据里存在，而且被判成官方会话）不进排行、不进预算、不进时间线。
- 排除（纯区间实测）：模型/等级混用、未知等级、账号推断、超过 30 分钟的采样缺口、跨重置卡区间和已识别的套餐变化。预算只排除账号推断、缺口、套餐变化、无本机请求和含未定价请求的区间。
- Grok：价格表对 Grok 全系用一档家族价，相对容量都是 ×1.00；本机也没有归属到 Grok 账号的用量，暂时算不出预算。
- 采样缺口按**相邻两次采样**的间隔判断，不按累积起点算（2026-09-28 修复）。周额度涨 1 个点常要半小时以上，旧写法会把连续采样的慢速区间当缺口丢掉；百分比按整数上报时，被丢的 token 所涨的那个点会记到后面的 token 头上，导致周容量系统性偏低。回归：`test-model-study.cjs`「Slow weekly climbs…」。
- 官方采样超过 30 分钟时不显示剩余 Token 预测。参考 API 等价费用沿用日志自报费用或本地价格表，不是订阅余额、官方账单或退款金额。
- 观测的最小/最大消耗不是统计置信区间；上下文长度、缓存比例、其他设备和未记录的客户端用量都会影响结果。
- 目录来源：Codex 使用本机 `models_cache.json` 的可见模型和逐模型等级；Claude/Grok 使用官方文档参考与日志实际出现的组合。模型目录不代表目标账号一定拥有对应权限。
- 能力元数据：`knowledge/model-capabilities.json`，包含核实日期和来源文档。Claude Haiku 不提供 effort 等级；Grok multi-agent 的 effort 代表协作智能体数量。
- 当前页切换历史周期会改变时间轴和实际用量，但排行校准仍基于最近 30 天/当前可识别套餐，不是历史时点的精确容量还原。

## 4. 数据迁移安全

- `src/core/usage-scan.ts` 的账本版本从 6 升到 7。
- 旧日志会自动补采思考等级；仍存在的日志可以补采，已经删除的历史文件无法补采。
- `metadataOnlyUntil` 使 6→7 的升级只补请求元数据，不重算已存在的日/小时 Token 账；因此补采期间不会暂时减少或重复增加总 Token。
- `replayUntil` 处理超大日志的跨批次读取；即使文件大小和 mtime 没变，尚未读完的批次仍会继续处理。请求流水整理会避免重复行。

## 5. 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/core/model-effort.ts` | 结构化思考等级规范化；禁止从正文或 Token 数量猜等级 |
| `src/core/model-catalog.ts` | Codex 本机目录、文档目录和实际观察目录合并，并保留来源 |
| `knowledge/model-capabilities.json` | Claude/Grok 模型与等级能力参考、来源和核实日期 |
| `src/core/model-study.ts` | 周期切分、纯区间校准、排行数据和时间轴数据 |
| `src/core/usage-scan.ts` | CLI 日志增量扫描、等级补采和安全迁移 |
| `src/core/request-log.ts` | 请求流水查询、等级字段、CSV/关键词相关输出 |
| `src/core/report-worker.ts` | 在 worker 中执行模型周期分析 |
| `src/main/snapshot.ts` | 暴露模型分析 worker 查询 |
| `src/main/index.ts` / `src/main/preload.ts` | `models:study` IPC 及参数校验/隔离 |
| `renderer/model-study.js` / `renderer/model-study.css` | 额度排行、用量时间轴、筛选、异步状态和布局 |
| `scripts/test-model-study.cjs` | 容量估算、目录、账号隔离、周期和边界回归 |
| `scripts/test-model-scan.cjs` | 等级采集、未知等级、Claude 优先级、跨批补采和总账保持 |
| `scripts/test-model-study-ui.cjs` | 隔离 IPC/worker/DOM 端到端测试 |

## 6. 验证与产物

- `npm test` 已通过：原有回归、出口监控 **17/17**、模型分析 **14/14**（第二轮新增：混用区间算预算并换算全部等级、别家模型不计入、空周期隐藏、无预算时相对排行）、思考等级采集/迁移回归均通过。
- `npm run test:ui` 已通过。`test-ui.cjs` 里「Main process blocked」检查在机器负载高时偶发超 1 秒（第二轮整套跑时出现一次，单独重跑 3/3 通过），与模型专区无关（模型分析在 worker 里）。
- `test-model-study-ui.cjs` 已按新界面重写：两窗口直接列出、预算换算、相对容量回退、排序、等级筛选、时间线轨道与额度曲线、高亮、失败不留旧数据、迟到结果不覆盖、900px、reduced-motion。
- 预览脚本（不在仓库里）：基于 `scripts/capture-ui.cjs`，另外复制 `cli-logins.json` 和去掉 `credential` 的 `official-accounts.json` 才有账号归属；刷新要间隔着多跑几轮（大日志分批扫描，一轮扫不完；连续 10 次无间隔刷新曾把 Electron 进程内存撑爆）。
- 测试日志中的 `Simulated model study failure`、`Simulated request query failure`、`Simulated scan failure` 和无效 IP 错误是主动注入的预期故障；应以 PASS 和退出码判断结果。
- 最新目录版：`D:\CodePorject\Tools\TokenPulse\dist\v0.3.8\win-unpacked\TokenPulse.exe`，ProductVersion **0.3.8.0**，含两个专区的重做和品牌图标（2026-09-28 01:46 构建，模型分析 14/14、UI 测试通过）。`dist\win-unpacked` 目录本身一直被占用（EBUSY：删除 / 改名都不行，但没有进程加载其中文件，用户关了窗口也没解除）；electron-builder 删不掉它，所以先构建到 `dist\v0.3.8`，再用 `robocopy /E /IS /IT` 覆盖进 `dist\win-unpacked`（覆盖文件不受目录锁影响）。两处现在逐字节一致。
- 不要来回切换已安装的 0.3.7 和 0.3.8 测试版：账本版本 6↔7 每次切换都会让另一方整份重扫日志（不丢数据，但浪费时间）。
- ASAR 已核对包含模型专区、能力目录、思考等级采集和安全迁移逻辑；打包版模型 UI 回归通过。
- 已发布 v0.3.8 Release（安装包在 `dist\v0.3.8`）。体验目录版前请从托盘退出旧版；仅关闭窗口可能仍在后台运行。

## 7. 下一位 AI 的第一步

1. 先读本节和下方历史，再运行 `git status --short`。
2. 不要查看图片；优先运行 `npm test`、`npm run test:ui` 或新增针对性的 DOM/文本测试。
3. 如果用户反馈估算“不准”，先检查：账号是否明确归属、等级是否未知、区间是否混用、额度采样是否新鲜、是否跨重置卡；不要直接加固定倍率。
4. 如果用户反馈模型列表“不全”，先更新能力目录和来源，再区分“官方文档支持”“本机目录可见”“日志实际观察到”三种来源，不要把权限当成已确认。
5. 如果用户继续优化 UI，保持内部滚动、稳定刷新、键盘操作和 reduced-motion；视觉确认交给用户。

---

# 0.3.7 接手资料与历史



# 接手指南 · 当前工作区（2026-09-27）

> **先读本节，再按需看下方历史。** 当前版本统一为 **0.3.7**。下方按时间保留迭代记录，其中旧的产物位置、待办、截图要求只代表当时状态；当前协作约束和交付状态以本节为准。

## 1. 用户约定与工作区保护

- 项目目录：`D:\CodePorject\Tools\TokenPulse`。Windows / PowerShell，Electron + TypeScript + 原生 HTML/CSS/JS。
- **不得查看图片、截图或图片预览**：用户明确说明这会导致客户端报错。使用源码、日志、DOM、计算样式、尺寸断言和自动化测试验证；视觉验收交给用户。现有 UI 测试已移除截图生成。
- 保持 **0.3.7**，后续是否升级版本由用户决定。保留现有界面风格、轻量动效、键盘交互和减少动态效果支持。
- **当前改动尚未提交**，包括前一位 AI 中断留下的改动和本轮续作。先运行 `git status --short`；不要用 reset/checkout/clean 丢弃工作区。
- 出口监控的若干文件仍是 **untracked 源码**，并非可删除的临时文件。只看 `git diff` 不会包含它们，提交/复制时要覆盖下方文件表。
- `.tmp-037-light.png`、`.tmp-037-dark.png`、`.tmp-grok-home-test/` 是此前就存在的内容，本轮未查看/清理。不要把图片当作接手检查步骤。
- 不输出或复制真实 token、refresh token；不要改写 CLI 登录文件、用户代理配置，或擅自终止其正在运行的程序。测试使用隔离数据目录和假凭证。

## 2. 已完成的 0.3.7 功能

### 用量明细

- 统计型号精确多选、模型候选搜索、项目、渠道、账号、核验状态及关键词组合筛选。
- 逐条请求与按日汇总共享条件；筛选后的统计、分页和全部匹配记录导出保持一致。模型调用次数与请求行数分别处理。
- 加载/失败有独立状态和保留条件重试入口，避免失败显示成零用量。
- 模型菜单开合、更多筛选折叠、标签增删/位置衔接、结果更新已有动效；标签复用 DOM 以保留焦点，自动刷新不会反复重播，支持快速反向、键盘即时响应及 reduced-motion。

### 出口监控

- 新增侧边栏页面；三家并发，每 5 秒尝试一轮，网络超时 4 秒，不重叠。首次默认暂停；用户保存白名单后开启。托盘运行时继续，退出时停止并中止探测。
- 访问选定官方域名的 `/cdn-cgi/trace`，核对 HTTP 状态、trace 主机名和 IP 格式，读取出口 IP 与地区；候选主机为固定允许列表。
- 默认：ChatGPT → `chatgpt.com`，Claude → `api.anthropic.com`，Grok → `cli-chat-proxy.grok.com`。可切换该供应商的其他已验证候选域名。
- 允许多个 IPv4/IPv6，支持自定义地区代码列表。连续两次同一风险才告警、同一风险去重、连续两次恢复再通知。
- 保留最近 50 条变化/告警；失败与地区未知明确展示，并标注上次有效结果。未知地区不能误报为恢复正常。
- 后台更新不覆盖表单草稿；即使草稿里有无效 IP，也可以立即暂停。分流规则可查看/复制，不自动写入代理。

### 额度查询前检查出口 IP · 今天按小时 · 用量分析（0.3.7，本轮）

- **额度查询前的出口 IP 检查**：`quota.ts` 的 `fetchOfficialQuota(force, gate)` 先问 `gate(家)`，不放行的那家这一轮**不续期、不查额度**；gate 抛错也按不放行。`main/index.ts` 传的是 `exitMonitor.gateQuota`：
  - 这一家没设 IP 白名单 → 放行（没有规则可比）；设了 → 用 10 秒内的探测结果，没有就现探一次，出口 IP 在白名单里才放行；**探测失败也不放行**（确认不了出口就别拿账号问官方）。监控开没开都检查。
  - 被拦时记一条告警（出口监控的「变化与告警」）、按「系统通知」设置弹通知；同一种情况（原因 + IP）只弹一次；放行后记一条恢复。`snapshot().quotaBlocks` 给界面，首页额度卡片和额度页顶部显示「额度查询已暂停：出口 IP x 不在允许列表」，点一下去出口监控。app.js 只在拦截情况变了时重画（出口监控每 5 秒推一次状态）。
  - `renewStoredCredentials(now, refresh, kinds)` 多了按家过滤。设置页打开时的续期（oauth.ts）没有接 gate。
- **总览「今天」按小时**：`todayHourly()` 从逐条流水按小时汇总零点到现在（按天的账切不出小时），合计仍用按天的账。按快照时间缓存；新结果回来前用同一天上一份顶着，免得每分钟变回一根柱子。用量明细带筛选时，今天 / 一天也从筛选后的流水出小时。
- **用量明细 · 用量分析**（新文件 `renderer/usage-insights.js` / `usage-insights.css`，插在 Token 构成和明细表之间）：分工具的堆叠趋势（今天 / 一天按小时，两个月内按天，两年内按周，再长按月；Tokens / 费用 / 请求切换；悬停看每个工具的数量和占比）、完整的工具排行、**完整的模型排行（不截断，可按 Tokens / 费用 / 请求排序）**、使用时段分布（一天 24 个钟点 + 星期 × 时段热力图）。数据和上面的统计卡片同一份（`analysis.selected`）；时段分布只能从逐条流水按小时算，有筛选时用 `analysis.hours`，没有时按范围单独查一次，并说明逐条流水的起算日期。请求流水的按小时汇总（`HourAggregate`）多了每小时各工具的分量 `sources`。
  - 注意：页面 CSP 不允许 style 属性，颜色 / 宽度用 CSSOM 设（`paint()`）；SVG 的 fill 属性认不了 `var()`。`data-insight-sort` 在 dataset 里叫 `insightSort`（这个坑踩过）。
- 测试：`test-egress` 加了放行检查（没白名单放行、IP 不对拦截且只告警一次、探测失败拦截、恢复、复用 10 秒内的探测、`fetchOfficialQuota` 只问 gate 不抛错；这个测试用空的家目录，不会读到本机真实登录）；`test-ui` 加了今天按小时、用量分析完整排行 / 堆叠趋势 / 热力图 / 按费用排序。

### 出口监控 · 界面改版与 IP 数据库（0.3.7，本轮）

用户觉得原来的出口监控页「太丑」，而且缺 IP 在各数据库的评分、ASN、ISP / 机房类型和国旗。本轮：

- **IP 数据库查询**（`src/core/ip-intel.ts`）：出口 IP 变了时，查 proxycheck.io（风险分 0–100、VPN / 代理、连接类型）、ip-api.com（机房 / 代理 / 移动标记、ISP、ASN，免费版只有 http）、ipinfo.io（ASN、组织、反向域名、anycast）、ipapi.is（公司、ASN；带 Key 才有的机房 / 滥用评分字段出现了就用）。都不用 Key。**Scamalytics、AbuseIPDB 网页有 Cloudflare 人机验证，IPQualityScore 必须付费 Key，都没接**（2026-09-27 实测）。
  - 线路类型：proxycheck 的类型优先，其次 ipapi.is 的公司类型，最后 ip-api 的「是不是机房」。ip-api 只说「不是机房」就当家宽是很弱的判断 —— 别家标了 VPN / 代理 / 机房时写「类型未知」（实测一个 NetLab 出口：proxycheck 风险 66、VPN，ip-api 说不是机房）。
  - 缓存 `~/.tokenpulse/ip-intel.json`：查全（≥2 家成功）12 小时，查不全 15 分钟后重试，最多 40 条。proxycheck 不带 Key 每天约 100 次，**绝不能跟着每 5 秒的探测一起查**。
  - `ExitMonitor.lookupNew()`：每轮探测完，对新出现 / 过期的出口 IP 在后台查，不阻塞探测；三家同一个 IP 只查一次。`refreshIntel(ip)`（IPC `egress:intel`）是界面上的「重新查询」，同一 IP 一分钟一次，只接受当前检测到的出口 IP。
  - 设置里新开关 `ipIntel`（「查询 IP 数据库」，默认开；0.3.7 早先存的配置没有这一项，读成开）。关掉后不自动查，手动「重新查询」仍可查一次。**这些查询会把出口 IP 发给上面几家**，开关的悬停提示写明了。
- **界面**（`renderer/egress.js` / `egress.css` 重写）：顶部状态条（状态灯 + 监控中 / 已暂停 / N 家异常 + 上次检测时间，开关和按钮在右）；每家一张卡片：品牌图标 + 检测域名 · 延迟 + 状态；出口块（大国旗 + IP + 复制按钮 + 国家 · 省 · 城市）；标签行（ASN、线路类型、各库最高风险分、官方地区支持情况、数据库国家和 trace 不一致时提示）；归属（运营商 / 组织 / ASN 名称 / 反查域名）；「IP 数据库」逐家一行（风险条 + 分数 + 档位，或 VPN / 代理 / 机房 / 移动 / Anycast 标记，库名链到它自己的查询页）；白名单、检测域名、地区、官方说明、分流规则都收进底部折叠的「白名单与检测设置」。变化与告警改成带颜色圆点的时间线。原有元素 id（egress-toggle / check / notifications / host-* / ips-* / regions-* / save / message / events、data-action=allow-current）都保留。
- **国旗**：Windows 的表情字体不画国旗（只显示两个字母），随包带 `renderer/fonts/TwemojiCountryFlags.woff2`（country-flag-emoji-polyfill 0.1.10，代码 MIT，国旗图案 Twemoji CC-BY 4.0，许可原文在同目录 `LICENSE-TwemojiCountryFlags.md`）。`@font-face` 用 unicode-range 只管区域指示符。CSP 加了 `font-src 'self'`。
- 外链：`setWindowOpenHandler` 只放行 http(s)，别的协议不交给系统打开。
- 测试：`test-egress` 加了 5 项（数据库合并、弱判断不盖过 VPN 标记、一家失败 / 额度用完不影响其他、缓存有效期、监控只查一次 / 开关 / 手动限频），全部用假响应不联网；`test-ui` 的假监控也注入了假查询，断言同一 IP 只查一次、换 IP 才查、标签 / 国旗 / 风险条 / 外链都画出来、国旗字体生效。

## 3. 文件导航

| 文件 | 职责 |
| --- | --- |
| `src/core/egress.ts`（新增） | 配置与 IP 校验、固定检测主机、trace 解析、地区规则、告警状态机 |
| `src/main/egress-monitor.ts`（新增） | 每五秒调度、并发合并、取消与旧响应作废、持久化、通知/状态回调 |
| `knowledge/egress-domains.json`（新增） | 候选主机及用户给出的 OpenAI/Claude 分流参考；Grok 最小规则集合 |
| `knowledge/egress-regions.json`（新增） | 官方地区代码、来源、核实日期、适用产品与子地区限制 |
| `renderer/egress.js`、`renderer/egress.css`（新增） | 出口监控页、草稿、白名单、历史及样式 |
| `scripts/test-egress.cjs`（新增） | 隔离核心/调度回归，已纳入 npm test |
| `src/core/ip-intel.ts`（新增） | 出口 IP 的归属 / 类型 / 风险：四家公开 IP 数据库并发查询、合并、缓存 |
| `renderer/fonts/`（新增） | Twemoji 国旗字体与许可 |
| `renderer/usage-insights.js`、`usage-insights.css`（新增） | 用量明细的用量分析：分工具趋势、完整工具 / 模型排行、时段分布 |
| `src/main/index.ts`、`src/main/preload.ts` | 监控启动/退出、桌面通知及 IPC：egress:state/save/check/clear、egress-state 推送 |
| `renderer/index.html`、`renderer/app.js`、`renderer/app.css`、`renderer/i18n.js` | 导航、明细筛选/动效、中英词条；app.js 使用 PulseEgress.show 接入页面 |
| `src/core/request-log.ts` | 明细精确筛选与 filteredAggregate；保留旧额度/总览 aggregate 语义 |
| `scripts/test-ui.cjs`、`scripts/test-requests.cjs` | DOM/交互、动效、IPC 和查询回归；监控测试注入假出口与通知 |

## 4. 重要边界和已知限制

- **出口检测只证明所选域名经 TokenPulse 当前 curl/环境代理路径的出口**，不等于其他 CLI、浏览器或整份分流规则的出口，也不验证账号授权、额度或服务一定可用。
- OpenAI / Claude 分流参考包含共享域名，例如 sentry、stripe；不要擅自将整份参考自动绑定某个代理节点。Grok 的 `grok.com`、`x.ai` 后缀集合是最小集合，不是完整官方分流清单。
- 地区清单于 **2026-09-27** 核实：ChatGPT 208、OpenAI API 188、Claude 185 个代码；ChatGPT 与 API 规则分开。Claude API / Claude.ai 的官方名单已对比一致。
- **Grok 的完整官方支持地区清单尚未核实**，页面保留未核实提示，用户可设自定义允许地区；不要套用另一家的清单。
- 当前地区清单随包维护，**没有在线自动刷新机制**；超过 90 天按未核实处理。来源 URL 存在 JSON 中。含子地区限制的国家不能只凭两位国家代码就判支持。
- 真实 IP 与地区的识别取自目标站点 trace；trace 若受阻、非预期响应或网络失败，显示无法确认，不回退到通用公网 IP 网站。
- 用户后来确认此前额度查询故障由代理出口地区引起，已结束那次排查，账号凭证选择/续期逻辑未改。若未来专门排查账号页与额度页状态一致性，可核对 `accounts.ts: resolveAccountCredential` 与 `quota.ts: targetsOf`；这不是本次已完成修复项。
- 数值范围筛选、按项目/会话分组仍属于后续候选需求，未实现。当前应等待用户下一项具体要求，而不是自动扩大范围。

## 5. 数据、验证与重跑方法

运行时数据在 `~/.tokenpulse/`，测试可通过 `TOKENPULSE_DATA_DIR` 隔离：
- `egress-settings.json`：开关、通知偏好、三家主机与 IP/地区白名单。
- `egress-history.json`：最多 50 条出口变化/告警；稳定采样不每五秒写盘。
- `ip-intel.json`：出口 IP 的数据库查询结果缓存（最多 40 条，12 小时 / 查不全 15 分钟）。
- 账号与其他历史文件沿用现有实现，监控不读取账号凭证。

已完成验证（本次交接仅整理文档，没有重新运行整套测试）：
- `npm test` 通过，包含出口监控 **11/11** 检查。
- `npm run test:ui` 通过；仅 DOM / CSS / WAAPI / CDP 媒体查询验证，不查看图片。
- 打包 ASAR 的隔离 UI 回归通过，包括三家卡片、草稿、白名单、两次异常告警、去重、配置校验、安全暂停、历史清除。
- 正式 `probeExit` 对三家默认主机各实测一次成功。当时地区均为 US；这是那一次探测结果，不代表今后出口。日志未输出真实 IP。
- 日志：`.tmp-037-tests.log`、`.tmp-037-egress-ui.log`、`.tmp-037-egress-packaged-ui.log`、`.tmp-037-egress-build.log`。日志中的 Simulated request query failure / Simulated scan failure 和故意输入无效 IP 的错误属于预期故障测试，判断结论要看 PASS/退出码。

PowerShell 常用命令：

~~~powershell
Set-Location 'D:\CodePorject\Tools\TokenPulse'
npm run compile
node scripts/test-egress.cjs
npm test
npm run test:ui
git diff --check

# 目录版打包；先确认目标目录中的程序未运行。
& .\node_modules\.bin\electron-builder.cmd --win --dir --publish never

# 对打包的 ASAR 使用同一套隔离 UI 测试。
$old = $env:TOKENPULSE_TEST_APP
try {
  $env:TOKENPULSE_TEST_APP = Join-Path (Get-Location) 'dist\win-unpacked\resources\app.asar'
  & .\node_modules\.bin\electron.cmd scripts/test-ui.cjs
} finally {
  $env:TOKENPULSE_TEST_APP = $old
}
~~~

注意：Windows 上用 `@electron/asar.extractFile` 核对嵌套路径时，先用 `path.join` 或 `path.sep` 规范化路径；直接传多层正斜杠曾导致“文件缺失”的误判。包内实际文件齐全。

## 6. 当前产物和用户验收

- **最新完整目录版**：`D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe`，Windows ProductVersion 已核对为 **0.3.7.0**，含筛选、动效、出口监控。
- `dist/0.3.7-motion/win-unpacked/` 是之前单独的动效阶段产物，**不含后来新增的出口监控**，不要把它当最新版。
- 本轮仅生成目录版，没有生成新的 Setup / Portable 单文件包，没有安装、发布或 Git 提交。dist 下已有的旧安装包不代表当前源码。
- 用户先从**托盘退出**旧程序，再运行最新目录版；仅关闭窗口可能仍在托盘运行，单实例锁会让新启动回到旧程序。
- 首次使用：出口监控 → 立即检测 → 为各家填允许的 IP 或加入当前 IP → 可选填地区白名单 → 保存并开启。Grok 尤其建议显式填写用户允许的地区。
- 用户曾认可筛选功能；出口监控的功能与视觉体验仍等其实际反馈。不要将自动化验证等同于用户已验收全部界面。

---

# 历史迭代记录

## 2026-09-27：0.3.7 · 出口监控

- 最新产物：dist/win-unpacked/TokenPulse.exe，版本仍为 0.3.7，包含此前筛选/动效与本轮出口监控。ASAR 模块、IPC、规则文件核验及打包代码的隔离 DOM 回归通过。未发布、未安装、未关闭用户的已安装版本；首次体验需先从托盘退出旧进程。

- 新增侧边栏「出口监控」。主进程每 5 秒尝试一轮（三家并发、每次 4 秒超时、不重叠）；关闭窗口收进托盘后继续，退出软件时停止并中止探测。首次默认暂停，用户保存 IP / 地区白名单后主动开启。
- 请求所选官方域名的 /cdn-cgi/trace，校验 HTTP 200、h 与目标域名一致、合法 IP，读取 ip / loc。默认 chatgpt.com、api.anthropic.com、cli-chat-proxy.grok.com；支持在每家固定的官方候选域名中切换。不用第三方 IP 站点冒充目标出口，不请求模型/额度，不携带账号凭证，不更改代理。
- 检测沿用 curl 与环境代理，只代表所选域名在 TokenPulse 进程内的路径，不保证其他程序、其他域名或全部分流规则同出口。用户提供的 OpenAI / Claude 规则完整保存在 knowledge/egress-domains.json；Grok 为 grok.com / x.ai 的最小后缀集合，页面明确不是完整列表。
- 每家允许多个 IPv4/IPv6，规范化去重；可额外设允许地区（US、JP 等）。连续两次风险才通知，同一风险不刷屏；两次恢复后通知解除。检测失败、地区未知/规则过期单独显示，不能伪装成正常或不支持。
- 官方地区数据：OpenAI ChatGPT 208 个代码、API 188 个代码，分别取 7947663 / 5347006 官方文章；Claude API 与 Claude.ai 清单核对一致，共 185 个代码。核实日期 2026-09-27、90 天后自动降为未核实；乌克兰等含子地区限制的条目不会按国家代码直接判正常。JSON 保留来源地址与适用范围。
- Grok 未核实到完整官方支持国家清单，保留未核实状态，支持用户自定义允许地区，不能套用 OpenAI/Claude 清单。此项是明确限制。
- 配置位于 ~/.tokenpulse/egress-settings.json；变化与告警位于 egress-history.json，仅保留 50 条，不写每轮采样。后台更新不覆盖表单草稿；无效草稿也不阻止暂停。
- 涉及 src/core/egress.ts、src/main/egress-monitor.ts、主进程/IPC、renderer/egress.js/css、导航及中英词条。scripts/test-egress.cjs 已加入 npm test，UI 回归注入假出口/通知，不访问实际网络。
- 验证：核心 11/11、npm test、源码纯 DOM UI 回归通过。正式 probeExit 对三家默认域名各探测一次成功（IP 未输出，地区均 US）。没有查看图片或生成截图。
- 上轮额度排查由用户取消并确认是出口地区问题，本轮撤回当时仅新增的失败回归测试，未修改账号凭证选择或续期逻辑。

## 2026-09-27：0.3.7 · 筛选交互动效

- 产物：dist/0.3.7-motion/win-unpacked/TokenPulse.exe，版本仍为 0.3.7。原 dist/win-unpacked 正在运行，本轮未覆盖或终止；体验动效需先从托盘退出旧进程，再运行此独立目录版。
- 验证：npm test、源码 UI 回归、动效目录版 ASAR 的隔离 UI 回归均通过。打包版第一次碰到主线程延迟 1096ms 的性能断言失败，保持原阈值重跑后通过，未放宽测试。

- 复用现有 --ease 曲线，不增加依赖。模型下拉 180ms 缩放淡入/淡出，更多筛选 200ms 高度展开/收起，箭头和按压反馈同步。
- 保留原生 details/summary 键盘语义；使用 ::details-content 与 content-visibility 离散过渡保证收起也有动画。
- 筛选标签按稳定 key 复用 DOM：新增轻量入场、移除 125ms 离场、剩余标签位置平滑衔接；离场中重新选择可中断，刷新保留节点与焦点。
- 筛选或切换明细视图后的结果仅做轻淡入；自动快照/定时刷新不触发结果动画。键盘操作即时响应，系统减少动态效果时关闭新增动效并结束进行中的动画。
- 纯 DOM/CSS/WAAPI 与 CDP 媒体查询测试已通过：实际开合过渡、收起隐藏、快速反向、标签复用与焦点、安静刷新、键盘与 reduced-motion。未生成或查看截图。

## 2026-09-27：0.3.7 · 用量明细筛选续接

- 本轮接手工作区内中断的 0.3.7 改动，保留现有实现，不升级版本。
- 用量明细共享筛选栏：统计型号精确多选、关键词、完整项目路径、官方订阅 / API Key 中转 / 归属未知、账号和型号核验；逐条与按日视图切换保留条件，支持标签移除和清空。
- 模型候选列表新增大小写不敏感搜索；只影响候选项显示，不改变查询或取消已选模型；无候选结果单独提示。
- 明细筛选统计通过 filteredAggregate 从流水汇总，与筛选明细及导出一致；总览/额度旧 aggregate 口径保留。请求条数与模型调用次数区分，Grok 一轮多次调用不混算。
- 汇总加载/失败不再显示成零用量，失败提供显式重试；重试保留筛选。查询进行中或失败时同条件重绘不重复启动明细 worker。
- UI 回归使用 DOM、计算样式、尺寸与交互断言；移除 test-ui.cjs 内截图生成。新增候选搜索保留选择、查询故障和恢复测试。
- **当前协作约束（优先于文末旧说明）**：用户明确要求不得查看图片、截图或图片预览，避免客户端报错。视觉效果由用户验收；后续继续使用源码、DOM 与文本测试验证。
- 验证：npm test、源码 npm run test:ui、针对 dist/win-unpacked/resources/app.asar 的隔离 DOM 回归全部通过；故障测试中的 Simulated request query failure / Simulated scan failure 是主动注入的预期错误。git diff --check 通过。
- 已生成本地目录版 dist/win-unpacked/TokenPulse.exe，ASAR 内版本核对为 0.3.7，并包含候选搜索和重试功能。未生成新的 Setup/Portable 单文件包，未发布或安装；用户正在运行的已安装版未关闭。
- 当前仍以统计型号筛选；请求型号/返回型号可通过关键词匹配。数值范围筛选和按项目/会话分组尚未实现，作为后续独立需求。

## 2026-09-26：0.3.6 · 重置卡（官方送的 / 用户自己用的重置）

- **问题**：额度容量趋势按「重置时间」把采样分成窗口，窗口固定。一个周期里用了一次重置卡：
  - **Claude / Grok**（重置日期不变）：同一窗口里百分比掉下来，`capacityHistory` 见到回落就**整窗不计入** —— 这一周期少一个点，当前窗口的容量也没了；当前窗口的起点还是原来的周期起点，本机用量把重置前的也算进来（百分比却只算重置后的），整窗容量被放大，平均速度被摊薄。
  - **Codex**（重置日期顺延，= 提前开新窗口）：旧窗口还带着原来的重置日期（在将来），被当成第二个「进行中」的窗口。本机实测：09-26 17:03 周额度 93%、09-29 重置 → 09-27 03:32 0%、10-04 重置；修之前 93% 那个窗口 `current: true`，修之后在 09-26 20:32 结束、标为「日期顺延」。
- **修法**：`quota-monitor.ts` 新增 `RESET_STYLE`（chatgpt: moves，claude / grok: keeps）和 `windowSegments()`，把采样切成「窗口段」：同一组里回落 → 在最后一次回落前的采样处切开（kept）；下一组起点早于这一组重置时间 → 这一组提前结束（moved，只有 Codex 标成「日期顺延」，别家出现同样的形状也照样切，只是不标）；任何一段都不从上一段最后一次采样之前开始。
  - `capacityHistory` 每段一个点，`CapacityPoint` 多了 `endAt`（实际结束时间）、`endedByReset` / `startedByReset`；只有最后一段、而且还没结束的才是 `current`。
  - `analyzeAccount` 的当前窗口用最后一段的起点（`currentSegment`）：本机已用、容量、平均速度、活跃占比都从重置那一刻算；`WindowReport.startedByReset` 给界面用。
  - 界面：额度页窗口面板在预测下面写「用过重置卡，重置日期已顺延 / 不变 · 从 X 起算」；容量折线的悬停提示写出这段是重置卡之后开始 / 被重置卡提前结束，结束时间用 `endAt`；逐条请求的额度占用按 `endAt` 找所在的段。
- `test-quota-monitor` 覆盖两种重置（前后各一个点、当前窗口起点 / 用量 / 容量 / 平均速度、Codex 旧窗口不再是进行中、风格只影响说明）。版本 0.3.6。

## 2026-09-25：0.3.5 · 设置页重新授权与完全删除账号

- 设置 → 官方账号的每个可见账号新增「重新授权」按钮。它复用隔离 OAuth 临时目录，不触碰用户真实 CLI 配置；重新授权时把目标账号 id 传入，OAuth 返回的账号身份必须与目标 id 一致，否则原账号不变并报错。
- 新增「完全删除 TokenPulse 记录」按钮，仍采用点两下确认：删除 TokenPulse 账号记录、保存的凭据、该账号的额度采样和 quota check；写入 `removed`，防止 CLI 轮询时把同一个账号自动登记回来。完全删除不修改 CLI 文件，也不删除本机整体用量账。
- 普通「删除」保留原语义：CLI 还登录着的账号只隐藏，非 CLI 账号删除记录但保留历史；需要彻底清理使用「完全删除」。
- 后端入口：`src/main/oauth.ts` 的 `loginOfficialOAuth(kind, replaceId?)`、`manageOfficialAccount(..., "purge", ...)`；IPC 在 `src/main/index.ts` / `src/main/preload.ts` 同步支持 `replaceId` 和 `purge`。
- 额度历史清理入口是 `src/core/quota-history.ts` 的 `forgetQuotaAccount()`；账号记录清理是 `src/core/accounts.ts` 的 `purgeOfficialAccount()`。
- 设置界面按钮和二次确认在 `renderer/app.js`；英文词条在 `renderer/i18n.js`。
- 回归：`npm run compile`、`node scripts/test-accounts.cjs`（58/58）、`node scripts/test-dashboard.cjs`、前端 JS 语法检查均通过。
- 本轮只编译源码，没有重新生成 `dist/win-unpacked`；若要给用户测试，按要求单独重新编译免安装目录。
## 2026-09-25：0.3.5 · 多账号额度池最终口径与首页圆环恢复

### 最终产品口径（以本节为准）

- TokenPulse 的账号额度展示只关心 **TokenPulse 账号库里的账号**，不把 CLI 当前 provider / CC Switch 当前模型切换当成 TokenPulse 账号的“当前状态”。
- TokenPulse 登录的账号使用 `official-accounts.json` 里该账号自己的 `credential` 查询官方额度；只有单纯从 CLI 发现、没有 TokenPulse stored credential 的账号，才使用对应 CLI 凭据。
- `src/core/quota.ts` 的 `targetsOf()` 按 TokenPulse 账号库和设置顺序查询，TokenPulse stored credential 优先；额度查询会续期 TokenPulse 自己保存的凭据，但不会写回 Claude / Codex / Grok CLI，也不会改 CC Switch 配置。
- `accounts.ts` 里的 `resolveActiveAccount()` 是旧版“活动账号”兼容函数，当前额度池不调用它；不要把它当作新的额度查询入口。
- `usage-scan.ts` 仍可读取 CLI 配置来判断本地会话属于官方还是中转，这是用量扫描的归属判断；它不再决定 TokenPulse 账号额度卡片是否显示或是否查询。

### 号池与首页

- `src/core/report.ts` 新增 `pools` 快照：同一产品账号按设置顺序聚合，记录每个账号的 5 小时 / 周额度、剩余百分比、耗尽状态、简单预测和顺位。
- 号池是展示和顺序提示，不会自动切换 CLI 账号，也不会改写 CLI / CC Switch。
- **首页卡片（0.3.5 改版，以这里为准）**：还是一家一张卡片，结构回到原来单账号时的样子 —— 号池里**当前顺位**的账号用完整的大双圆环（外环 5 小时、内环周额度，圆心是较低窗口的剩余）+ 下面 5 小时 / 周额度两条进度，页脚是它的预测。多账号时下面加一段**号池队列**（`poolQueue()`）：其余账号按顺序排，每行一个 28px 小圆环（不写数字）+ 名字 + 「下一个」标签 + 剩余百分比，只列接下来 2 个（`QUEUE_ROWS`），更多的给「还有 N 个账号」链接到额度页。队列标题右边是「5 / 6 个有余量」。
  - 为什么这样改：上一版每个账号一行同样大小的圆环，没有主次；「周额度合计剩余 564%」把 6 个账号的百分比加起来，不是一个能读的数；单账号的卡片被 6 个账号那张撑高，中间一大片空白；名字被截断。
  - 小圆环的尺寸 / 描边规则要写成 `.pool-queue .ring.pool-mini-ring …`：后面响应式里的 `.ring` 尺寸和双环描边规则比单个类名具体，会把小圆环撑回大号。
  - 队列行没有「下一个」标签时也要放一个空 span 占格子，不然右边的百分比对不齐。
  - 首页不再用 `poolCard()`（已删）；额度页的号池面板 `poolPanel()` / `poolRows()` 仍在用。
- 设置页里非 CLI 当前账号显示为“本软件已保存”，表示它属于 TokenPulse 管理，不代表 CLI 当前登录。

### 本轮涉及的主要文件

- `src/core/quota.ts`：额度凭据来源和查询目标修正。
- `src/core/accounts.ts`：补充旧活动账号函数的说明，避免误以为它仍控制额度查询。
- `src/core/report.ts`：号池快照与每账号额度摘要。
- `renderer/app.js`：号池卡片、账号状态和每账号圆环。
- `renderer/app.css`：号池账号行圆环样式。
- `renderer/i18n.js`：号池和本软件保存状态文案。

### 验证与产物

- 版本保持 `0.3.5`。
- 已通过：`npm run compile`、`node scripts/test-dashboard.cjs`、`node scripts/test-accounts.cjs`、`node --check renderer/app.js`、`node --check renderer/i18n.js`。
- 最新免安装目录已重新编译到：`dist/win-unpacked/`。
- 可执行文件：`dist/win-unpacked/TokenPulse.exe`。
- 使用的是 `electron-builder --win dir --publish never`，没有制作安装包，没有发布 GitHub。

> 旧的 0.3.3 多账号历史说明里如果写着“用 `resolveAccountCredential` 在 CLI 和 TokenPulse 两份凭据里挑新的”，那是历史实现记录；继续开发时以本节的“TokenPulse stored credential 优先”口径为准。
# TokenPulse 交接文档

## 2026-09-24：0.3.5 · 会话管理删除对话

- 会话详情的「更多操作」新增「删除对话」，主进程先弹不可撤销确认框；删除成功后刷新列表并选中相邻对话。正在回复的对话必须先停止。
- **Codex CLI 0.156.1**：真实命令是 `codex delete <SESSION>`，没有 `--force` 参数。
- **Grok Build 1.0.41**：真实命令是 `grok sessions delete <ID>`。
- **Claude Code**：`claude --help` 没有普通对话删除子命令（`claude rm` 只删后台 agent session），所以 TokenPulse 安全删除索引定位到的 `~/.claude/projects/**/<id>.jsonl` 和同目录的 `<id>/` 附属目录。
- 回归覆盖删除参数和 Claude transcript / sidecar / 索引清理。版本保持 0.3.5。
## 2026-09-24：0.3.4 · 检查修复

- **请求流水里的重复行不会自己消失**：扫描「先写流水、再写账本」，写完流水没写完账本就被杀（强制关程序、重新打包时关掉）的话，下次从旧偏移重读会把那一段再追加一遍。这不算「重读」，以前不触发整理，重复行一直留着（本机实测：当天 749 行里 234 行重复，整个流水 8,481 行里 613 行重复）。查询本身按 key 去重，界面数字没错，但文件越长越大，任何不去重的读取都会多算。现在追加前留 `requests-pending` 标记、账本写完再删；开扫时它还在就这一轮扫完整理。老账本没有 `requestsCompacted` 标记的先整体整理一次（本机 235 ms）。
- **缺按账号小时账的官方文件永远补不上**：`needsAccountHours` 只是把文件再交给 `scanFile`，偏移没变它直接返回，每轮都「需要补」却什么都没做。现在把 `state.v` 清掉，逼它从头重读。
- **额度页账号标签：在账号上按下、到这一行外面松手**，这一行收不到 pointerup，按下时记的手势一直留着，下一次按下被 `if (tabGesture) return` 挡掉，之后的拖动用的是残留的起点。现在新的按下作废旧的未拖动手势，窗口上的 pointerup 也会收尾，丢失指针捕获当作取消。`test-ui` 里加了这个场景。
- 英文界面：程序给的占位名「未命名账号」放在 `translate="no"` 的元素里没被翻译，现在英文模式下先翻好。

## 2026-09-24：0.3.4 · Codex 缓存写入被当成免费

- 现象：用户觉得费用「怎么那么便宜」。知识库没问题（本地和 GitHub 上都是 2026.09.24.1，单价一致）。
- 原因：`estimateCost` 里缓存写入按单价表的 `cacheWrite` 算，而 GPT / Grok / DeepSeek 等的 `cacheWrite` 写的是 0 —— 意思是「没有单独的写入价」，实际按输入价收。以前没事是因为 Codex 一直报 0 条缓存写入；**2026-09-24 起新版 Codex（gpt-5.6-sol-excel）开始报 `cache_write_input_tokens`**，这部分输入就被当成免费。实测一条 78,824 输入 / 56,692 缓存写入的请求只算了 $0.0115，应为约 $0.29。
- 修法：`cacheWrite` 为 0 时按输入价算（免费型号输入价也是 0，不受影响；Claude 的 1.25 倍写入价照旧）。费用都是读的时候现算的，不用重扫，历史数字立刻更正。`test-features` 里有回归。
- 顺带：当时请求记录比快照多出 234 条，是本版账本结构升级触发的全量重扫先追加、随后压缩去重之前的中间状态，压缩后两边一致（都是 140,842,303 tokens）。

## 2026-09-24：0.3.4 · 额度页点选与拖动排序

0.3.3 把额度页账号行做成「一按下就捕获指针，移动 5px 就当拖动并吃掉点击」。普通点击手会抖过这 5px，点账号切不过去。

- **点一下就是切换**。按下时不捕获指针、不进入拖动。水平移动不到 10px，或者主要是上下抖，松手后的 click 照常切换账号。
- **按住左右拖是排序**，只在同一家、至少两个真实账号之间。被拖的标签跟着指针，其余标签让位；松手才改 DOM 并调 `accounts:reorder`。隐藏的账号不在这一行里，保存时按可见账号的新顺序嵌回完整列表，隐藏的仍留在原位。拖到行的两端会跟着滚动，方便把账号放到目前看不见的位置。
- **这一行装不下时**，标签下面出现一条滚动条（`#account-tabs-bar`），拖它来看后面的账号。不要再在标签上左右拖来滚动，那会和排序抢手势。
- 版本号 0.3.4。

## 2026-09-24：0.3.3 · 多账号额度同时显示、账号管理

以前一家可以登记好几个账号，但只查「当前使用」那一个，要看另一个得去设置里切换。现在：

- **所有账号都查**（`quota.ts` 的 `targetsOf`）：按设置里的顺序取这一家没隐藏的账号，每个用自己的凭据（`accounts.ts` 的 `resolveAccountCredential`：CLI 正登录着它就在 CLI 文件和 TokenPulse 存的两份里挑新的，否则用存的）；凭据没有或过期的跳过。结果放在 `OfficialQuotaMap.all`，`value[家]` 仍是这一家排第一的那个（老代码、测试按家取）。「活动账号」（`store.active`）不再参与查询。
- **采样历史**还是按家一个数组、每条带 `account`；几个账号的采样交错排，所以去重改成和**同一个账号**的上一条比。查询成功时间多了 `quota-checked.json` 的 `accounts[id]`。
- **报表**（`report.ts` 的 `samplesByAccount`）：一个账号一份 `AccountReport`，带 `key`（账号 id，老采样没 id 时用家名）和 `siblings`（这一家显示几个）。没记账号的老采样归给最早出现的那个账号。藏起来的、删掉的跳过。
- **界面**：首页一个账号一张额度卡片（一个都没有的家留一张「尚未取得」）；额度页的标签由 `quotaSlots()` 动态生成。一家不止一个账号时写出账号名（邮箱只留 @ 前面，完整的在悬停提示里）。托盘提示、额度提醒也带上账号名，提醒的去重键改成账号。
- **设置 → 官方账号**：按住每行左边的把手**拖动排序**（pointer 事件自己做：被拖的行跟着鼠标，其余行用 transform 让位，松手才改 DOM 并调 `accounts:reorder`；键盘聚焦把手后上下方向键也能挪）。行高不统一（起了名字的行更高），落点按每行中线算，让位距离用被拖那一行自己的高度，不要用固定步长。`store.accounts` 的数组顺序就是显示顺序，`reorderOfficialAccounts` 只重排这一家占的那几个位置；列表对不上就报错让界面重读。**重命名**：点铅笔名字原地变输入框，回车 / 失焦保存、Esc 取消，存在 `alias`（最长 40 字，留空或等于邮箱就去掉）。别名只用于显示：`accountLabels()` 返回显示名，另带 `emails` 给按邮箱对账号用，别名不会让 Claude 请求对不上账号。起了名字的账号即使一家只有一个，首页 / 额度页 / 托盘也会写出名字。删除点两下确认（不弹系统对话框）。TokenPulse 登录的账号真删（凭据一起删，id 记进 `store.removed`，只读 CLI 时不会被登记回来，重新登录才撤销）；**CLI 还登录着的账号删不掉**（下次读 CLI 又回来），只 `hidden`：不查、不显示，列表里划掉，可以「恢复」。额度采样历史都不删。IPC 是 `accounts:manage`（remove / restore / rename）和 `accounts:reorder`，原来的 `accounts:activate` 去掉了。额度轮询也会登记 CLI 当前账号；邮箱和名字都没变就不要写 `official-accounts.json`（里面有 refresh token）。
- **短名字**：`report.ts` 的 `displayNames` 算好放进 `displayName`，卡片、额度页标签、托盘共用。有别名用别名，否则邮箱只留 @ 前面；短名字撞了（`ada@one.com` / `ada@two.com`，或两个别名一样）改用完整邮箱。额度页一家多个账号时，会话计数写明是这一家的合计、用量已按账号分开。
- **装得下**：首页额度卡片用 `auto-fill`，换行剩下的一张不会被拉成整行；第 4 张起的入场也错开。Windows 托盘提示最多 127 字，超了留下放得下的，末行写「还有 n 个」。同一次刷新里多个窗口过提醒线，合成一条通知，不再每个窗口各弹一条。
- **额度页账号行拖动**：标签收在工具栏剩余宽度里横向排（`#account-tabs` 的 `min-width: 0`），不要把后面的账号顶出窗口。按住这一行左右拖动来看后面的账号（`pointer` 事件，移动超过 5px 才算拖）；拖完松手不要当成点选。选中的账号自动滚进可见范围。两端淡出表示那边还有账号。滚动条藏着。
- **关于页作者**：设置 → 关于里写作者江木源 (JohnMuYuan)、邮箱 `Hi@muyno.com`、个人官网 `JohnMuYuan.com`，和 GitHub 放在一起。名字、邮箱、网址标 `translate="no"`。

## 2026-09-24：0.3.3 · 会话管理（重写）

第一版（别的 AI 做的 demo）的问题：列表冷启动 7.6 s、点开详情 4 s；标题大多是注入的内容（`<environment_context>`、`# AGENTS.md instructions`、AllAi 的系统提示）；Codex 每句话出现两遍（`response_item` 和 `event_msg` 各一份）；工具调用的 JSON 刷满对话；「回复对话」只是开个终端。整块重写：

- **解析 `src/core/sessions.ts`**：三家格式见文件头的表。只认 `response_item`（Codex）；剥掉 CLI / AllAi 注入的内容；Claude 的 `subagents/`、`isSidechain`、`isMeta` 和 Codex 的子会话（`parent_thread_id` / `source.subagent`）都不单独列；标题优先用 CLI 自己生成的（Claude `ai-title`、Codex `session_index.jsonl`、Grok `summary.json`）。工具调用和结果配成一条 `tool` 消息，斜杠命令、压缩、中断变成 `event`。
- **索引 `~/.tokenpulse/sessions-index.json`**：按文件大小 + mtime 缓存每个文件的摘要，只重读变了的。本机实测（91 个会话）：冷启动 3.5 s，之后 32 ms；详情只读那一个文件，34–585 ms。后台扫描发完快照后顺手 `listSessions()`，所以第一次打开会话页也是热的。`writeJson` 的临时文件名加了线程号：两个 worker 可能同时写索引。
- **在 TokenPulse 里直接回复 `src/main/session-reply.ts`**：用各家 CLI 的无界面模式接着这个会话跑一轮，流式把文字和工具调用推给界面，结束后重读会话文件（CLI 自己写回）。命令行对着 `--help` 核过，**提示词只走 stdin / 临时文件，不进命令行**。两档权限：只读（Claude / Grok `dontAsk`、Codex `read-only` 沙箱）和可改文件（`acceptEdits` / `workspace-write`），其余需要确认的操作一律自动拒绝，不会卡住。同一会话不能同时回复两次；可以停止（`taskkill /T`）；退出程序时全部结束。**会用掉对应账号的订阅额度**，界面上写明了。原来的「打开终端」挪进「更多」菜单。
- **界面 `renderer/sessions.js` + `sessions.css`**：会话页是固定高度的双栏（`body[data-page=sessions]` 收起大标题和页脚）。左：搜索、Agent 分段、项目下拉、按今天 / 昨天 / 7 天 / 30 天分组，方向键切换。右：标题、项目 / Agent / 时间 / 轮数 / 工具数 / 型号，「复制项目地址」「回复对话」「更多」；对话气泡（轻量 Markdown：代码块、表格、粗体、链接只显示文字）、连续工具调用折叠成一组、长会话先显示最后 160 段；底部输入框（Enter 发送）+ 权限切换。**不要用 `<header>` / `<footer>` 元素**：`app.css` 里有全局 `footer {…}` 样式。
- **英文界面**：`i18n.js` 支持 `translate="no"`，会话标题、正文、工具输出、项目名都标了 —— 不标的话「……做好后」会被「(.+?)后」翻成「in ……」、中文逗号会被换掉。
- 测试：`scripts/test-sessions.cjs` 重写（注入过滤、子会话、去重、工具配对、索引缓存、回复命令行、三家流式事件）；`test-ui` 里用假的 `sessions:reply` 走一遍发送 → 流式 → 停止按钮 → 结束，不真的调 CLI，也不点复制（不动用户剪贴板）。
- 其他：Windows 图标加了多尺寸 `packaging/icon.ico`，窗口优先用它。**256 以下必须存成传统位图**（`make-icon.cjs` 的 `encodeDib`）：别的 AI 最初全塞的 PNG，Electron / GDI+ 把它当位图解，任务栏上是一片彩色噪点（用户说「像星空」）。`test-features` 里有检查。
- **会话管理打开的 Claude 提示「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker」、终端没颜色**：TokenPulse 是从 Claude Code 的终端里启动的，继承了它的会话变量（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION` 等）和 `NO_COLOR`，起的 CLI 都当自己是子会话、不存记录（在 TokenPulse 里回复的那一轮也就写不回会话文件），颜色也关了。`session-reply.ts` 的 `cleanAgentEnv` 按名字删掉这几个（用户自己配的 `CLAUDE_CODE_GIT_BASH_PATH` 之类保留）；主进程启动时清一次，回复、终端、OAuth 登录起进程时再各清一次。
- **第二个 Grok 账号把第一个顶掉**：Grok 账号的身份以前取 `~/.grok/auth.json` 的键，可那个键是「https://auth.x.ai::<Grok CLI 的 client id>」，谁登录都一样，所有 Grok 账号共用一个 id。现在用 `user_id`（没有就用 token 的 `sub`，本机实测两者相同）。`grok-migrate.ts` 在启动时把旧数据搬一次：旧记录里的凭据属于最后一次在 TokenPulse 里登录的人 → 变回独立账号（邮箱不可信就留空，重新登录补上）；登录时间线和额度采样的旧 id 记作 CLI 当前账号。Claude（accountUuid）和 ChatGPT（用户 + 工作区）本来就是按人区分的，没这个问题。
- **任务栏图标变成 Electron 的原子图标**：任务栏按 AppUserModelID 取「开始」菜单里同 ID 快捷方式的图标。Electron 发通知时发现没有这种快捷方式会自己建一个指向当前 exe；开发 / 测试跑的 `node_modules/electron/dist/electron.exe` 用了同一个 `com.tokenpulse.app`，于是建出了 `Start Menu\Programs\Electron.lnk`。现在没打包时用 `com.tokenpulse.app.dev`。用户机器上那个 Electron.lnk 已删；以后测试还会建一个，但带的是 dev ID，不影响正式版。
- 「在终端里继续」最初是 `spawn("powershell.exe", …, { detached: true })`：从 Electron（GUI 程序）起的 PowerShell 拿不到控制台，立刻退出，什么都不出现。改成 `cmd /c start "" powershell -NoExit -EncodedCommand …`（`session-reply.ts` 的 `openTerminal` / `terminalScript`）；PATH 上没有 CLI 时用找到的 exe。

## 2026-09-24：0.3.3 · 官方额度预测按账号隔离

- **修复多账号额度串算**：以前百分比采样已经按当前账号筛选，但本机官方小时账仍按工具合并；切换账号后，另一个账号的 Token 会被折进整窗容量、容量历史、已用 Token、耗尽预测、24 小时小时表和型号汇总。
- `usage-scan.ts` 的账本结构版本从 5 升到 6。官方会话新增 `accountHours[账号][整点][型号]`，扫描时依据会话直接账号证据或 `cli-logins.json` 登录时间线归属；旧账本下次扫描会自动重扫迁移。无法归属的请求留在空账号桶，不会分配给某个账号。
- `report.ts` 优先使用按账号拆开的小时账；`quota-monitor.ts` 的 `HourRow` 增加 `account`，`analyzeAccount` 在存在账号维度时只使用当前额度账号的行，因此容量、容量历史、小时明细、型号汇总和预测速度都使用同一账号口径。旧格式小时账继续兼容，直到自动重扫完成。
- 回归覆盖：账号 A / B 同一小时的请求不会互相污染容量；扫描器会生成账号维度小时账。

## 2026-09-24：0.3.2 第六轮 · 标题栏与滚动（版本号不变）

- **整个窗口不滚了，只有工作区滚**（`html, body { overflow: hidden }`，`.workspace` 固定在标题栏下面、自己 `overflow-y: auto`）。
  以前是整页滚动，滚动条从窗口最顶上拉到底，贴在最小化 / 关闭按钮旁边。滚动条换成自己画的细圆条（`.workspace::-webkit-scrollbar`）。
  **JS 里滚动一律用 `scroller`（= `.workspace`）**，不要再用 `window.scrollY / scrollTo`：`keepScroll`、切页回顶、时间选择器往下露出都改了，测试也改了。
  顶栏 `sticky` 的 top 从标题栏高度改成 0（它现在在工作区里面）。
- **标题栏自己画**：高 44px，左边一段接侧栏底色和分隔线、右边接内容区底色（两段渐变，宽度跟 `--sidebar-w` 走，窄窗口一起收成 76px），
  不再有单独一条灰边；窗口按钮是圆角小按钮、图标重画（四角框的最大化、叠放的还原、圆头的关闭），关闭悬停是淡红底红字。
  窄窗口时标题栏只留图标，名字会压到侧栏分隔线上。

## 2026-09-24：0.3.2 第五轮 · 时间范围与数字显示（版本号不变）

- **用量明细每次打开都是「今天」**；总览仍默认 30 天、自己记着改过的范围（`navigate` 里按页面切换 `state.days`，额度详情不参与）。
- **新增「一天」= 过去 24 小时**（`state.days = '24h'`，`state.since`）。跨两个自然日，按天的账切不出来：
  worker 的请求查询多了 `aggregate`，顺便按「天 × 工具 × 型号」和按小时汇总逐条流水，形状和快照里的 `usage` 一样，
  界面 `windowAnalysis()` 直接喂给 `D.analyze`，统计卡片 / 工具分布 / 模型排行 / 按日汇总表都能复用；环比是再往前的 24 小时。
  用量趋势图换成最近 24 个整点小时，节奏面板按小时算。结果按「快照时间 + 工具」缓存，没回来前先画空的再重画。
- **数字精确到个位**（默认）：卡片、Token 构成、表格、指标卡片、模型排行里的 Token 和请求数用 `amount()`；
  设置 → 通用 →「数字显示」可换回简写（存在 localStorage `tokenpulse-number`）。图表坐标轴和句子里仍是简写（`tokens()`），不然挤不下。
- **中文小字「≈30.3亿 / ≈8,587万」**（`cnApprox` / `qty`）：≥ 1 万才加，三位有效数字；英文界面不加。
  **坑**：`font: … var(--font-body, inherit)` —— 变量没定义时 fallback 的 `inherit` 在简写里不合法，整条声明作废，小字变成继承来的粗大字号；要分开写属性。
  **坑**：`.breakdown-item span` 是说明小字的样式，数字包进 span 后被它缩成 12px，要单独还原。
- 回归：`test:ui` 新增一组（用量明细默认今天、总览范围不受影响、过去 24 小时按小时、精确数字 + 中文小字、切简写）。

## 2026-09-24：0.3.2 第四轮 · 请求记录并进用量明细（版本号不变）

用户：「用量明细里为什么没有每一次请求？把请求记录和用量明细结合成一个板块。」

- 侧栏只剩「用量明细」（红点挪到它上面）。页面从上到下：用量卡片 → Token 构成 → 明细面板。
  明细面板右上角切换 **逐条请求**（默认）/ **按日汇总**（原来的聚合表），说明和导出按钮跟着视图换（`showUsageView`）。
  以前跳「请求记录」的地方（型号不一致的通知、额度详情的「查看全部」）传 `requests` 进 `navigate`，会落到用量明细的逐条视图。
- 逐条表：项目和账号合成一格（`projectAccountCell`），新增 **额度占用** 列（`quotaShare`）：
  这次请求的 Token ÷ 它所在 5 小时 / 周窗口折算出的整窗容量（`capacityHistory` 的点，按本机用量倒推），标「≈」；
  只算和 TokenPulse 查额度的是同一个账号的请求，窗口折算不出容量（已用 < 2% 等）的显示「—」，已用不到 5% 的窗口数字变灰。
  详情和 CSV 里也有。本机实测一次 6 万 token 的 gpt-6-astra 请求约占 5 小时 0.32%、周 0.05%。
- 四张核验大卡片和上面的用量卡片重复，改成一排可点的小标签（`verifyChip`，多了「无法核验」），点了按结论筛选。
- 顺手修：窄窗口（≤1100px）下 `.panel` 的内边距盖掉了明细面板的 0，面板顶上多一截空白。
- 回归：`test:ui` 的请求记录那组改成走合并后的页面（默认逐条、切按日汇总、旧的 `requests` 入口、额度占用列）。

## 2026-09-24：0.3.2 第三轮 · 请求按账号归属（版本号不变）

用户要求：每次请求标出是哪个账号发的；额度详情里把这个账号的请求接在下面。

- **先想清楚「哪个账号发的」**：请求是 CLI 用**它自己的登录**发的；TokenPulse 里「当前使用」的账号只管查额度、不影响 CLI。
  会话文件基本不记账号（实测）：Claude 只有部分会话有 `bridge-session.ownerAccountUuid`（= 凭据里的 accountUuid）
  和 `session_context.context.userEmail`（**这个字段后面还跟着一句说明文字**，只能用正则取邮箱）；Codex 只有 `plan_type`；Grok 没有。
- **登录时间线**（`src/core/login-timeline.ts`，`~/.tokenpulse/cli-logins.json`）：每轮扫描前读一次各 CLI 当前登录的账号，
  变了就开一段新的；**只记账号 id 和邮箱，不记任何凭据**（测试里查过文件里没有 token 字样）。CLI 登出记一段空 id，之后的请求不算到上个账号。
- **归属顺序**（`resolveAccount`）：会话里直接记的 → 请求时间落在哪段登录里 → 时间线开始之前的按最早那个账号推断（界面标「推断」）。
  走中转 / API Key 的会话（归属判定 official=false）不算任何官方账号。账号名优先用「设置 → 官方账号」里登记的邮箱。
  扫描器把会话里的账号证据记进流水（`accountRef` / `accountEmail`），`STATE_VERSION` 升到 5 重扫一遍补上。
  本机实测：Claude Code 5830 次对到同一个账号（其中 1312 次推断），Codex 921 次全是推断（时间线今天才开始记），Grok 走中转、不归账号。
- **请求记录**：新「账号」列（推断的带小标）、账号筛选、详情里写明依据，CSV 多了账号和依据两列；查询多了 `account` / `since` / `until`，
  结果里带 `accounts`（各账号的请求数、token、费用，不受账号和核验筛选影响）。
- **额度详情**：每个账号下面加「这个账号的请求」（`accountRequestsPanel`）：当前 5 小时 / 周窗口的请求数、token、费用，核验结果，
  最近 8 次请求，这个工具有多个账号时列出各账号本周的量；「在请求记录里查看全部」跳过去并按账号筛好。
  流水在 worker 里按窗口查、结果按条件缓存 —— 定时刷新整页重建时先用缓存画，免得面板一空一满让页面跳（和请求记录那次是一个坑）。
  `AccountReport` 多了 `accountId` / `accountLabel`（额度是哪个账号的）。
- **没做**：额度预测里「本窗口已用（本机）」和整窗容量仍按这个工具的全部官方请求算，没按账号拆。
  同一个工具在一个窗口里切过账号时会偏大；要拆的话把账号带进 `HourRow`，`analyzeAccount` 只取和采样同一账号的行。
- 回归：`test-features.cjs` 增加到 34 项（时间线、归属顺序、登出、按账号筛选 / 汇总、按窗口时间筛选）；`test:ui` 加了账号列和筛选的检查。

## 2026-09-24：0.3.2 第二轮（版本号不变）

**修复**
- **请求记录展开 / 收起详情时页面往上跳**：只有真实鼠标点击才复现（`element.click()` 不会），实测往上跳 300~1000px。
  原因是整表 `replaceChildren` 时被点的那一行（刚拿到焦点）被删掉再插回，Chromium 的滚动锚点丢了。
  现在展开只在那一行后面插 / 删详情行（`toggleRequest`）；异步查询回来的整表重画也套上了 `keepScroll`（从 render 里抽出来的）。
- **托盘图标看不清**：以前是白色透明线稿，Windows 浅色任务栏上几乎看不见。Windows / Linux 改用彩色底块（`tray-color.png` 32px +
  `tray-color-16.png` 16px 单独画——圆环和三根柱子挤在 16px 里会糊成一块），macOS 仍用模板图。`npm run icons` 生成。

**sub2api 是怎么核验 ChatGPT 型号的**（源码 `backend/internal/service/upstream_response_model.go`）：它是中转站，站在请求中间，
读上游响应里自报的 `response.model`（Responses API 的 SSE 以 `response.completed` 这种终结事件为准），同一次响应里前后型号变了就记 conflict；
另外读 `service_tier` 看实际用的档位。它的 channel monitor 只是发算术题测通道活没活，不认型号。
**TokenPulse 不是中转，拿不到响应**：Codex 的会话文件和 `~/.codex/logs_2.sqlite` 里都只有请求型号（日志里的 `model=` 是 tracing 字段），没有返回型号。
能用上这个方法的只有 **CC Switch 的本地代理**：它的 `proxy_request_logs` 记了 `request_model` 和 `model`（上游回的）。见下面 CC Switch。

**新功能**
- **Electron 33 → 44.2（electron-builder 25 → 26.15.3，和 AllAi 一致）**：为了 `node:sqlite` 读 CC Switch 的库（Node 22.5+）。
  纯 JS 的 sql.js 读不了 WAL 里还没合并的数据，所以没用。全部测试在 44 上重跑通过，`npm audit` 0 个漏洞。
- **从 CC Switch 导入**（`src/core/cc-switch.ts`，只读）：
  - 它的账在 `usage_daily_rollups`（较早，本机 06-03~08-24）和 `proxy_request_logs`（最近，逐条）两处；`provider_id` 以 `_` 开头的是它扫 CLI 会话得来的，UUID 是走它代理的。
  - 口径：它的 `input_tokens` 不含缓存（Codex 汇总 1.39 亿输入对 24.5 亿缓存读），导入时补成 TokenPulse 的口径。
  - **去重按「天 × 工具」**：TokenPulse 自己那天那个工具有账就不用它的（`coveredDays`）。本机实测补进 127 个「天 × 工具」、跳过 69 个，
    统计从 05-15 起（以前从 08-25 起）：Codex 25491 次、Claude Code 11385 次、OpenCode 1963 次（新来源）。
  - 走它代理的请求：同工具、输出 token 相同、时间差 10 分钟内，配到 TokenPulse 自己的那一行上（`matchProxy`），用代理看到的上游型号核验——
    Codex 的返回型号只有这里能补上。本机目前没有走代理的请求（它库里的逐条记录全是 `_session` 来源）。
  - 同步：扫描后在 worker 里读，库（含 -wal）没变或 10 分钟内同步过就不重读；设置 → 数据里能「立即同步」、能关（`prefs.ccSwitch`）。
    副本在 `~/.tokenpulse/cc-switch.json`。工具筛选的选项跟着数据走（OpenCode 这类没有官方图标的用首字母）。
- **模型知识库**（`knowledge/models.json` + `src/core/knowledge.ts`）：单价表和型号等价规则（`[1m]`、`-build`、日期后缀…）从代码里搬出来。
  随包带一份，每天（启动 5 分钟后第一次）从 `raw.githubusercontent.com/JohnMuyuan/TokenPulse/main/knowledge/models.json` 拉，
  version 更新就存到 `~/.tokenpulse/knowledge.json`（`src/main/knowledge-update.ts`，用 `net.fetch` 走系统代理）。下载来的当不可信输入：
  只收认识的字段，正则超长 / 编不过的丢掉，数字必须是非负有限数。设置 → 关于显示版本、更新日期、规则数，列出数据里还没定价的型号。
  **要让已安装的用户拿到新知识库：改 `knowledge/models.json`、把 version 和 updatedAt 往后调、推到 main。** 这一版新加了 codex-auto-review 和免费模型（`-free`、big-pickle）的价格。
- **英文界面**（`renderer/i18n.js`）：中文是原文，按「中文 → 英文」查表。用 MutationObserver 翻 DOM 文本和 title / placeholder / aria-label，
  带变量的句子走 PATTERNS（先拆模板再递归翻变量），拼起来的段落按「；」换行 → 句号 → 「 · 」拆开逐段翻。
  **坑**：翻不动的文本原样写回也会触发 characterData，观察器会无限循环卡死页面 —— 只在真的变了时才写回（`translateText`）。
  **坑**：宽模板（`(.+) 同步`、`(.+)：(.+)`）会把整段吞掉，捕获组不要跨「。」「·」「；」。
  切换语言 = 存 localStorage + prefs 再重新加载。主进程（托盘菜单、托盘提示、通知、保存对话框）`src/main/i18n.ts` 直接 require 同一份词典。
  覆盖率检查：英文模式下走遍各页各状态收集还剩的中文，只剩用户自己的中文路径和「简体中文」这个选项名（刻意不翻）。
  **加新文案要同时在 i18n.js 里加英文**，不然英文界面会露中文。
- 关于页的版本号改从 package.json 读（开发时从别的入口启动，`app.getVersion()` 会拿到 Electron 自己的 44.2.0）。
- 回归：`node scripts/test-features.cjs`（25 项：知识库校验 / 更新、CC Switch 导入去重和代理核验、英文词典），已进 `npm test`；`npm run test:ui` 加了知识库、CC Switch、语言的检查。

## 2026-09-23：0.3.2 请求记录与型号核验

用户要求：把每一次请求都记下来、能逐条核对；参考 AllAi 的「溯源」对每次请求核验上游返回的型号，不一致要标出来。
**以后没说升级就不升版本号，改动都算当前版本（0.3.2）。**

- **请求流水**：`~/.tokenpulse/requests/<年-月>.jsonl`，扫描会话文件时每次请求追加一行（`src/core/request-log.ts`）。
  不放进 usage-rollups.json：那份每分钟整份重写，本机两个月 6974 次请求约 3.5 MB。只记元数据（时间、型号、token、ID、工作目录），不记正文。
  会话文件被重写 / 账本结构升级时那个文件从头重读，会重复追加 —— `scanFile` 记下 `rescanned`，扫完 `compactRequests()` 按 `kind + id` 去重。
  先写流水再写账本：反过来的话偏移已推进，被杀进程那一段请求就永远补不回来。`STATE_VERSION` 升到 4，老账本重扫一遍把历史请求补进来。
- **型号核验**（`src/core/request-verify.ts`，纯函数，查询时现算，改规则不用重扫）：只用会话文件里本来就有的字段，不额外发请求。
  AllAi 的溯源是**主动发整数挑战 + ModelTrace 指纹**，要花额度、还要拿用户的 Key 发请求，这一版没搬，先做被动核验。
  | CLI | 请求型号 | 返回型号 | 其他证据 |
  |-----|----------|----------|----------|
  | Claude Code | `attachment.identity.modelId`（`claude-opus-5[1m]`） | `message.model` | 官方 `msg_` + 24 位、`req_011…`（本机 11559 条全是） |
  | Grok Build | 用户消息 `_meta.modelId` | `modelUsage` 的键 | `grok-4.6` → `grok-4.6-build` 是官方变体（45 轮），算一致 |
  | Codex | `turn_context.model` | **不记** | `response_id` 是 `resp_` + 十六进制 |
  结论四种：型号一致 / 型号不一致（请求≠返回）/ 响应存疑（号称 Claude 但 ID 是 OpenAI / UUID 格式；官方直连却没有 request-id；Codex ID 不是 resp_）/ 无法核验。
  **坑**：Claude Code 恢复会话时不会立刻重写 identity —— 实测 691968f7 会话被 AllAi 接成 gpt-5.6-sol 后，前 3 次请求还挂着旧的 claude-opus-5，
  直接沿用会误报「不一致」。`session_context` 带 `changed`（reason = session_start）时清掉请求型号，宁可「无法核验」。
  **坑**：Claude Code 的官方 / 中转判定看的是全局 settings.json，AllAi 会给单个进程另配环境变量去接 gpt / grok —— 这些响应不是 Claude 格式不算问题，只写一句说明。
  本机实测（30 天）：4527 一致、0 不一致、0 存疑、1645 无法核验（旧版 Claude Code 没记请求型号 + Codex）。
- **额度归属修正**：同上原因，Claude 账号的小时账只算型号里带 claude 的（本机 grok-4.6 186 次、gpt-5.6-sol 75 次以前被算进 Claude 订阅额度，把整窗容量估大）。
- **界面**：侧栏新增「请求记录」（`page-requests`）：四张核验卡片（点了按结论筛选）、逐条表格（点开看响应 ID / 请求 ID / 会话 / 核验依据）、
  搜索、排序、导出 CSV、「核验方法」说明。查询走 worker（`loadRequests` → `report-worker` 的 query 模式），主进程 `parseRequestQuery` 只收认识的字段。
  侧栏红点 = 最近 7 天不一致 + 存疑次数（快照里的 `requestFlags`）。
- **通知**：新扫到、最近 15 分钟内不一致 / 存疑的请求合成一条系统通知，点开跳到请求记录并筛好；设置 → 提醒 →「型号核验提醒」可关（`prefs.notifyMismatch`）。
  第一次运行补历史时都是老请求，不会刷屏。
- 回归：`node scripts/test-requests.cjs`（34 项，已进 `npm test`），`npm run test:ui` 新增请求记录一组。
- 版本号 0.3.2。只生成免安装测试版，没提交、没推送、没发布。

## 2026-09-23：0.3.1 额度预测与双圆环

- 额度达到上限的时间改为最近趋势优先：在最近 24 小时（5 小时窗口为最近 1 小时）上用多个采样跨度计算加权中位数，整窗平均只在近期跨度不足时兜底；近期没有增长时不输出虚假的 ETA，异常近期速度最多放大到整窗平均的 2 倍。
- `runsOutBeforeReset` 改为直接比较 ETA 与当前窗口重置时间，避免仅凭 projectedAtReset 的四舍五入或缺少重置时间就误报。
- 总览额度卡片支持双圆环：外环为 5 小时额度，内环为周额度；只有两个窗口同时存在时显示双圆环，单窗口仍显示单环。中心显示当前剩余较少的窗口，图例明确标注内外环。
- 去掉「可能提前耗尽」文案，改为「重置前压力较高」「达到上限」「重置时预计使用」等明确口径；额度详情同步更新预测字段和说明。
- 版本号更新到 0.3.1。只生成免安装测试版，不提交、不推送、不发布 GitHub。

### 0.3.1 双圆环界面冲突修复（版本号不变）

- **图例压住下一行**：`.ring-legend` 塞在固定 116px 的 `.ring` 方框里，溢出后压在「5 小时」那行上，字号 10.5px。去掉单独的图例，改成下面两行标题前的同色圆点 +「外环 / 内环」小字（`.win-dot` / `.mini-label`）。
- **数字压在内环上**：内环半径 32 时内圈比「48.0%」还窄。双环时环放大到 124px、内环半径 34、中心数字 19px。
- **颜色含义打架**：预警色覆盖了身份色，ChatGPT 两个环都变橙，和「外环绿 / 内环蓝」对不上。双环时环和进度条只用身份色（`--ring-five` / `--ring-week`），预警改由状态标签和「已用 xx%」的 `.warn-text` 表达；≥90% 仍变红。单环卡片保持原来的预警色。
- **中等宽度挤坏**：窗口 1100–1360px 时三列卡片只有约 276px，状态标签压住账号名、文字一字一行。额度卡片改为 `minmax(320px, 1fr)` 自动换成两列；卡片加 `container-type`，偏窄时（≤380px）圆环和文字收紧；账号名 / 副标题超长省略号。实测 1380 / 1300 / 1180 / 1000 宽均无重叠、无横向滚动。
- 测试：`npm test` 39 + 3 + 6 + 28，`test:ui` 8 组全过。

### 0.3.1 Token / 费用预测与额度容量趋势（版本号不变）

- 用户问「有没有 5 小时 / 周额度的 Token 量和费用预测」：以前只有整窗容量的 Token 数（藏在额度详情里），后端算了 `capacity.costUsd` 但界面没显示，也没有「剩余多少 / 重置时会用多少」。
- **额度详情**明细表：「本窗口已用（本机）」「重置时预计用量」「剩余可用（估算）」「整窗容量折算」都给 Token + 费用（`app.js` 的 `byCapacity`：容量 × 百分比，超过 100% 按 100% 封顶）；可信度并进容量那一项的小字。**总览卡片**「已用 xx% · 剩约 xx」。
- **额度容量趋势**（`quota-monitor.ts` 的 `capacityHistory`，账号报告里 `capacityHistory.week / five`）：采样按重置时间归组（容忍 10 分钟抖动），每个窗口用最后一次采样折算整窗容量。**不计入**：已用 < 2%（只计数）、本机没用量（只计数）、窗口里百分比掉下来过（手动重置，前后说不清）；**0% 的直接忽略**（ChatGPT 5 小时窗口没用时每次把重置时间往后挪，会凑出几十个假窗口）。2–5% 标可信度低（空心点），进行中的窗口单独标。虚线 = 已结束且非低可信窗口的中位数，数值写在图下说明里（写在线尾会撞「进行中」）。
- `sumRows` 改为按重叠时长折算整点小时桶（以前整小时计入，5 小时窗口从 xx:44 开始误差可达两成）；当前小时只到 now，按全部计入。`report.ts` 传给额度模块的小时用量从「最近 8 天」改为全部历史；24 小时柱状图改用按小时索引。
- 已知局限：本机用量只统计这台电脑，多设备用同一账号时容量会偏低；本机官方会话不区分同一家的多个账号。
- 修了一个样式优先级问题：`.quota-mini-head span:first-child` 把「已用」的预警橙色盖掉了，改为 `>` 直接子元素。
- 测试：`npm test` 47 + 3 + 6 + 28，`test:ui` 8 组全过。

### 0.3.1 自动更新（版本号不变）

- `src/main/updater.ts` + `electron-updater`（dependencies）+ `package.json` 的 `build.publish`（GitHub：JohnMuyuan/TokenPulse）。打包命令都带 `--publish never`，发布仍手动用 gh 上传。
- **无感更新**：启动 3 分钟后检查、之后每 4 小时一次；发现新版本后台下载（`autoDownload`）；下载好后**窗口收进托盘或最小化**（`hide` / `minimize` 事件 → `onWindowAway`）20 秒后 `quitAndInstall(true, true)` 静默安装（NSIS /S）并自动重启；窗口一直开着就等到退出时装（`autoInstallOnAppQuit`）。安装前写 `update-relaunch.json`：原来在托盘里的，重启后也不弹窗口。
- **只有安装版支持**：`unsupportedReason()` 按「程序旁边有没有 `Uninstall *.exe`」区分安装版和免安装目录版；便携版看 `PORTABLE_EXECUTABLE_FILE`；开发模式不检查。不支持的在关于页说明原因并给 GitHub 链接，不显示开关。
- 设置 → 关于 →「软件更新」：状态卡片（检查中 / 下载进度 / 已下载 / 已是最新 / 出错）+ 检查更新 / 下载更新 / 立即重启并更新 + 「自动更新（推荐）/ 只提醒」（prefs.autoUpdate，默认开）。
- `npm run test:update`：本地起一个假的 v99.0.0 更新服务器，真实走「检查 → 下载 → sha512 校验」，验证窗口显示时不装、收起后静默安装（quitAndInstall 被替换成记录调用，不真的安装），并对真实 GitHub 发布页检查一次。13/13。
- **发布新版本的要求（重要）**：Release 里必须上传 `dist/latest.yml`、`TokenPulse-x.y.z-Setup.exe`、`TokenPulse-x.y.z-Setup.exe.blockmap`，否则已安装的版本查不到更新。v0.3.0 及以前的 Release 没有 latest.yml、程序里也没有更新模块，这些用户需要手动装一次带自动更新的版本，之后才会自动更新。
- 未验证：没有真实安装 → 发布新版 → 静默升级走过一遍（会在用户电脑上装软件）。`--dir` 构建不生成 `app-update.yml`（只有 NSIS 目标会生成），还没构建安装包确认过。

### 0.3.1 不用额度时误报「采样已过期」（版本号不变）

- 用户反馈：Claude / ChatGPT 不用的时候就显示采样过期。实测凭据都有效（Claude 还有 7.8 小时、Codex 109 小时），每 5 分钟都查询成功。
- 原因：采样历史在数值没变时 15 分钟才记一条（`FLAT_EVERY_MS`），而界面拿「最后一条采样」判断过期，阈值也是 15 分钟 —— 额度一不动，最后一条采样就落后 15–20 分钟（实测间隔 15.0 / 18.1 / 19.3 分钟），反复闪「已过期」。
- 修法：`quota-history.ts` 另记每家「最后一次查询成功」到 `~/.tokenpulse/quota-checked.json`（每次都写，小文件，不动历史去重）；`analyzeAccount` 的 `lastCheckedAt` 取它和最后一条采样中较新的（只认同一账号的查询）。界面的过期判断、`waitingReset`、「xx 更新」都改用 `checkedAt()`。去掉修复时新增的测试会失败。

### 0.3.1 指标小卡片与刷新跳顶（版本号不变）

- **刷新把页面拉回顶部**（用户反馈）：`render()` 每分钟推送 + 每 30 秒重绘都会把额度详情 / 明细表 / 图表清空重建，清空时页面变矮，浏览器把滚动位置夹到顶部，内容回来也不滚回去。`render()` 现在在重建期间锁住 `main` 的 min-height，重建后还原 `scrollY`（原逻辑挪到 `renderPage()`）。切页的 `navigate()` 仍然回到顶部。`test:ui` 有专门断言，去掉修复时会失败。
- **额度详情改成指标小卡片**（用户反馈「挤在一起看着眼睛不舒服」）：原来 10 项挤在一个两列表格里。现在按「Token 与费用 / 预测 / 速度与时间」三组，每项一张 `.metric` 卡片（小标签 + 大号数字 + 单位 + 补充说明 / chip）；剩余可用用绿色高亮，会用完的预测用橙色。卡片用容器查询：面板 ≤520px 时两列，单数的最后一张占满整行；≤340px 单列。旧的 `detailItem` / `.detail-grid` 已删。
## 2026-09-22：0.3.0 官方 OAuth 账号

- 偏好设置新增「官方账号」区，可对 Claude、ChatGPT 和 Grok 启动官方 OAuth 登录，并显示 CLI 安装状态、登录账号和活动账号。
- OAuth 流程参考 `D:\CodePorject\Web\AllAi`：Grok 使用 `grok login --oauth`，Claude 使用 `claude auth login`，Codex 使用 `codex login`。每次登录使用隔离的临时用户目录，完成后把账号凭据按账号保存到 `~/.tokenpulse/official-accounts.json`。
- `src/main/oauth.ts` 负责 CLI 探测、隔离 OAuth 登录、等待凭据文件变化和读取脱敏状态；`src/core/accounts.ts` 管理多账号凭据与活动账号，凭据不会通过 IPC 返回 renderer。
- Grok 额度查询会优先使用活动账号对应的 `~/.grok/auth.json` 条目，账号切换后立即触发额度刷新；没有活动记录时仍回退到第一个可用凭据。
- 新增 `scripts/test-accounts.cjs`，覆盖账号身份稳定性和活动账号切换；`npm test` 现在为 33 + 3 + 6 + OAuth 账号存储回归，`npm run test:ui` 增加设置页 OAuth 区域的实际加载路径。
- 本轮只准备免安装版测试构建，不提交、不推送、不发布 GitHub。

### 0.3.0 审查修复（版本号不变）

上面这版 OAuth 功能有几处实质问题，已修（`npm test` 34 + 3 + 6 + 13，`test:ui` 8 组全过）：

- **Codex 登录会覆盖用户真实登录**：隔离只改了 USERPROFILE / HOME，但 Codex（Rust）在 Windows 上用 SHGetKnownFolderPath 找家目录。实测只改 USERPROFILE 时 `codex login status` 仍报告已登录，`codex login` 会写进真实 `~/.codex/auth.json`，TokenPulse 盯着临时目录等满 3 分钟报超时。现在显式设置 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GROK_HOME`（`oauth.ts` 的 `isolatedEnv`，有测试）。Grok、Claude 实测会看 USERPROFILE，也一并显式设置。
- **Claude 多账号互相覆盖**：`.credentials.json` 没有邮箱，所有 Claude 账号都叫 `claude:default`。身份改为 `.claude.json` 的 `oauthAccount.accountUuid`；ChatGPT 改为 `chatgpt_user_id@account_id`（account_id 是工作区，Team 成员共用）。识别逻辑挪到 `src/core/credentials.ts`，额度和账号管理共用。
- **活动账号只对 Grok 生效**：Claude / ChatGPT 的额度查询仍直接读 CLI 文件。现在三家都走 `accounts.ts` 的 `resolveActiveAccount()`：活动账号在 CLI 里就用 CLI 的最新凭据；不在就用 TokenPulse 存的；没有或过期如实报告，**不回退到 CLI 当前账号**（否则额度悄悄变成另一个人的）。Grok 原来优先用存的旧 key，也一并改正。
- **采样历史混账号**：切换账号后 A 的 80% 和 B 的 10% 连成一条线会误报。采样带 `account`，`analyzeAccount` 只看当前账号（老采样无 account，视为同一个）。
- **凭据复制**：以前每次打开设置都把 CLI 的 access + refresh token 复制进账号库。现在 CLI 账号只记名字；只有 TokenPulse 自己登录的账号存 access token（不存 refresh token）。账号库版本 1 → 2，1 版直接丢弃（Claude 记录本来就是撞坏的）。
- **登录流程**：三段复制粘贴的成功分支合并；临时目录（明文 token）改在 finally 里删；Windows 用 `taskkill /T` 结束进程树（`proc.kill()` 只杀 cmd.exe，codex 登录服务会残留占端口）；同一家同时只允许一个登录；CLI 路径缓存。
- **设置页**：每个账号行都有一个「添加」按钮 → 每家一个；设置窗口不再等 CLI 探测完才打开；过期凭据标「凭据已过期 / 需重新登录」；字号回到 ≥12px。
- **OAuth 登录打开的是空白浏览器配置**（用户反馈）：隔离时改了 USERPROFILE / APPDATA / LOCALAPPDATA，CLI 打开的浏览器继承这些变量，Chrome / Edge 按 LOCALAPPDATA 找用户配置，开出一个全新的空白配置，平时浏览器里已登录的账号用不上。现在只设 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `GROK_HOME`，系统目录不动，浏览器就是用户平时那个。实测只设这三个变量三家都已隔离（codex 报 Not logged in、grok 报 not authenticated、claude 的 configDirectory 指向临时目录且真实 ~/.claude.json 未改动）。登录临时目录改放在数据目录下（Codex 拒绝在系统 Temp 下建辅助程序）。
- **设置改版**（参照 AllAi `components/SettingsDialog.tsx` / `GeneralSettings.tsx` / `OptionSelect.tsx`）：固定高度对话框 + 顶部标签页（通用 / 官方账号 / 提醒 / 数据 / 关于）+ 每项「标题 + 说明 + 选择器」。选择器是 `app.js` 的 `optionSelect()`，菜单挂在 body 上按按钮定位（放在滚动区里会被裁掉）。普通设置项写在 `PREF_ROWS` 配置里，以后加设置项往里加一行即可。
  - 外观从侧栏挪进「通用」，新增「跟随系统」（`localStorage` 的 `tokenpulse-theme` 存 light / dark / system，旧值照认；系统切换深浅时实时跟随）。
  - 页脚「统计口径」弹窗并进「数据」页；「关于」显示版本（读 package.json，不再手写在 index.html）、本机 CLI 检测结果和 GitHub 链接。
- **重新登录后仍显示「凭据已过期」**（用户反馈）：用户在 TokenPulse 里重新登录了 Grok，新凭据存下了（还有 6 小时），但 CLI 文件里同一个账号的凭据已过期 34 小时（CLI 只在自己被使用时续期）。`resolveActiveAccount` 当时对「CLI 正登录着的账号」一律用 CLI 那份，于是一直判过期、额度也不查。现在用 `fresherCredential()` 两份比新旧（没过期的优先，再比过期时间；比不出来用 CLI 的），设置页列表也用同一个函数。修复后在真实数据上 **Grok 额度首次查询成功**（周已用 2%），§6 第 1 条「Grok 链路未验证」可以划掉。
- **自动续期**（`src/core/token-refresh.ts` + `accounts.ts` 的 `renewStoredCredentials`）：TokenPulse 自己登录的账号现在会存 refresh token，离过期不到 30 分钟时续期（查额度前、打开账号列表前触发）。接口和 client id 从本机官方 CLI 二进制里核对（Claude：`platform.claude.com/v1/oauth/token` + claude.exe 生产配置的 client id，必须带 claude-cli UA，否则 429；ChatGPT：`auth.openai.com/oauth/token` + codex.exe 里的 `app_EMoamEEZ73f0CkXaXp7hrann`；Grok：auth.json 里的 `oidc_issuer` / `oidc_client_id`，token endpoint 走 OIDC 发现）。三家都用假 refresh token 实测过，均回 invalid_grant 类错误并正确判为永久失败。
  - **CLI 自己的登录绝不续期**：Claude / ChatGPT 的 refresh token 一次性，用掉 CLI 就被登出。只续账号库里带 credential 的（= TokenPulse 登录的）。
  - 轮换后的 refresh token 续一个存一个；同一时间只跑一轮；写之前重读账号库，续期期间用户重新登录过就丢弃续期结果；官方拒绝（400/401）标 `renewFailed` 不再重试，网络 / 429 / 5xx 下一轮再试。refresh token 走 curl 的 stdin，不进命令行。
  - 0.3.0 早先存下的凭据没有 refresh token（当时刻意不存），这类账号需要重新添加一次才能自动续期。
- **收尾细节**（用户要求，版本号不变）：
  - 去掉侧栏「本机持续记录」、总览「数据只保存在本机」、设置「关于」里的本机 CLI；侧栏「偏好设置」改叫「设置」。
  - **自绘标题栏**（参照 AllAi `components/TitleBar.tsx`）：窗口 `frame: false`，`#titlebar` 用主题变量上色，最小化 / 最大化 / 关闭走 `window:*` IPC；关闭走 `win.close()`，所以「关闭窗口时」的设置照常生效。整条 `-webkit-app-region: drag`，按钮区设回 no-drag。侧栏、顶栏、弹窗都让出 `--titlebar-h`。
  - **数据永久保存**：按小时的账不再只留 40 天（`STATE_VERSION` 2 → 3，重扫补回），额度采样不再只留 45 天、去掉 2 万条上限；`data.js` 的 `analyze` 不再封顶 366 天。
  - **时间选择器**（参照 AllAi `components/UsageStats.tsx`）：预设（今天 / 7 / 14 / 30 / 90 天 / 全部）+ 起止日期 + 「结束日期跟随今天」+ 月历点选。TokenPulse 的用量按天汇总，所以只选日期、没有 AllAi 的时分输入。「全部」从有记录的第一天算。超过 120 天图表按周合并、超过两年按月合并（`groupDaily`）。
- **已知限制（未解决）**：没有用真实的 TokenPulse 登录走过一次「成功续期」（需要用户在浏览器里授权）；成功路径的解析和写盘由单测覆盖。`claude auth login` / `grok login --oauth` 在无终端（stdio ignore）下能否完成浏览器授权，未实际走过一遍登录验证。

## 2026-09-22：0.2.1 缺陷修复

- **额度提醒重复弹**：Claude 每次返回的 `resets_at` 带几百毫秒抖动（实测 `08:19:59.398` / `08:20:00.474` 交替），旧版拿重置时间原样当去重键，过线后每 5 分钟弹一次。改为按「账号:窗口」记住提醒过的重置时间，差 30 分钟以内视为同一窗口。
- **采样去重失效**：同一个抖动让 `quota-history.ts` 的 `same()` 永远不成立，Claude 每 5 分钟写一条（ChatGPT 是 15 分钟）。新增 `sameReset()`，1 分钟内视为相同；`npm test` 增加 2 项，共 33 项。
- **手动刷新可能不问额度**：正在跑 1 分钟本地扫描时，`refresh(true)` 会直接复用那一轮（不含额度）的结果。现在排一轮带额度的在后面。
- **「关闭窗口时收进托盘」关掉无效**：关窗后进程仍带托盘驻留。现在关掉该选项后关窗即退出。
- **CSV 默认文件名**用了 UTC 日期，东八区 8 点前导出会标成前一天。改为本地日期。
- **窗口底色**固定为深色 `#09090b`，浅色主题拉伸窗口时会露黑底。主题同步到主进程（`prefs.theme` + `theme` IPC），底色跟随主题。
- 测试：`npm test` 33/33 + 6/6，`npm run test:ui` 全部通过。只打了 `dist/win-unpacked`，未打安装包、未推送 GitHub。

### 0.2.1 Codex「未知模型」（版本号不变）

- 原因：扫描器只从 `thread_settings_applied` 取型号，但它只在设置变化时写，会话第一轮还排在第一条 `token_usage_record` **之后**（实测：turn_context → usage → thread_settings_applied），还有 7 个会话压根没有这一条。本机 82 个 Codex 会话里有 30 个出现过「未知模型」。
- 修法：同时认 `turn_context.payload.model`（每轮开头都写，一定在该轮 usage 之前）。`STATE_VERSION` 1 → 2，老账本自动重扫。重扫后 657 次 Codex 请求全部有型号。
- 顺带核对：Codex 的 `response_id` 没有重复（657 条各不相同），不需要像 Claude 那样去重。
- 新增 `scripts/test-usage-scan.cjs`（接进 `npm test`），用临时 HOME 造会话文件。撤掉修复时 3 项全挂，修复后 3/3。这是扫描器的第一份测试，后续动扫描器可以往里加。

### 0.2.1 界面改版（版本号不变）

- 用户反馈：字太小、图标廉价、动画少、层次不清。正文从 13px 提到 14px，辅助文字不小于 12px（旧版大量 9–10px）。`index.html` / `app.css` 从压缩单行改回可读格式。
- 官方品牌图标：`renderer/brand.js` 由 AllAi `public/brand/{claude,openai,grok}.svg` 提取路径生成（lobe-icons）。内联 SVG 而不是 `<img>`：OpenAI / Grok 的路径跟随 currentColor，深色主题下才看得清；Claude 保留自带的 `#D97757`。
- 界面线性图标放在 `index.html` 顶部的 `<symbol>` 里，`icon(name)` 用 `<use href="#i-name">` 引用。
- 额度卡片加了环形表（剩余最少的那个窗口）；工具分布、模型排行、明细表都带来源的品牌图标。
- **动效只挂在 `main.entering` / `.chart-enter` 下**（`enter()` 在切页、首次渲染、切账号时打开 1.7 秒）。`render()` 每 30 秒和每次快照推送都会重建 DOM，动画直接写在元素上会每分钟重播。数字滚动 `countTo()` 只在值变化时动。`prefers-reduced-motion` 全部关掉。
- 分段控件的滑块、侧栏指示条都靠 JS 读 `offsetLeft/offsetTop` 定位（CSP 下走 CSSOM）；窗口 ≤1100px 时侧栏收成 76px 图标栏。
- `scripts/capture-ui.cjs` 每张截图前等 1.8 秒，让入场动画播完。

## 2026-09-22：0.2.0 日常看板重构

- 用户偏好：浅色为主，可切换深色；最关心剩余额度、重置和耗尽预测。三页导航为总览、额度详情、用量明细。
- `renderer/app.js` 负责页面与交互；`renderer/data.js` 是浏览器 / Node 共用的数据筛选、等长时间对比与 CSV 模块。统计仍来自真实扫描和额度采样，不在产品中塞模拟数据。
- `Snapshot.usage` 新增按日期、工具、型号聚合的明细及定价可用标记，`fileCount` 给出会话文件数；不传会话正文或路径。筛选与导出都使用同一批聚合明细。
- 时间范围已改为本地自然日，包含今天，修正旧版 7 天窗口有时多算一天及夏令时日序列问题。
- 首页展示剩余最少的有效窗口。额度采样超过 15 分钟会标过期，跨重置而无新采样时不显示虚构的 100% 剩余。预测仍用原来的墙钟算法。
- CSV 通过主进程原生保存对话框写出，带 UTF-8 BOM 和公式转义，含当前筛选全部匹配行。浅深色偏好保存在 renderer localStorage；窗口和通知设置仍走原 prefs。
- `npm test` 包含原 31 项额度检查与 6 组数据测试。`npm run test:ui` 覆盖预测、缺失 / 过期 / 重置、搜索排序分页、CSV 实际保存、主题、日期、900px 布局、刷新失败恢复。`scripts/capture-ui.cjs` 保存真实数据截图到 `artifacts/ui/`。
- 未扩展 CLI 支持或修改账号登录方式；Claude/Grok 仍可能因凭据或网络拿不到在线额度，界面明确说明。

以下记录按日期从新到旧排列。

## 2026-09-21：界面卡顿修复

- 实测启动时同步扫描使 Electron 主进程阻塞约 2.5 秒；首份快照还等待所有额度请求，慢网络下统计区长期空白。
- `src/main/snapshot.ts` 通过 `src/core/report-worker.ts` 在 worker 中完成扫描和汇总。先发布缓存快照、本地扫描结果，再更新官方额度，窗口 IPC 不再被扫描占用。
- 后台刷新错误通过 IPC 显示；手动刷新失败恢复按钮；`--hidden` 只影响本次启动，不再写入 `startMinimized` 偏好。
- 新增 `npm run test:ui`：真实 Electron 界面 + 故意挂起的额度请求，检查统计渲染、设置、图表切换、刷新完成和失败恢复。临时数据隔离，不改用户账本。可传 `--hidden` 验证偏好不被修改。
- `$env:TOKENPULSE_TEST_APP` 指向 `dist/win-unpacked/resources/app.asar` 时，同一测试验证打包代码；测试使用开发版 Electron，不登记开机启动项。
- 31 项额度测试和界面测试均通过；修复后主进程最大事件循环间隔实测约 0.1 秒。真实扫描得到 10,493 次请求、约 33.5 亿 tokens；本轮仅 ChatGPT 额度成功返回，Claude / Grok 的在线额度可用性未确认。
- `dist/` 的旧构建与源码不一致，已重新生成安装版和免安装版，核对包内关键文件与当前源码编译产物一致。

以下为项目初次交接记录，状态以本节为准。

写给**接手这个项目的下一个 AI**。项目从空文件夹起步，目前是 v0.1.0，能跑、已打包、经过实机验证。

先读这份，再读 `README.md`（面向使用者），然后看代码。代码里的注释写的是**为什么这么做**，
不是复述代码在做什么 —— 改之前请先看注释，很多写法是踩过坑才那样的。

---

## 1. 这是什么

一个常驻托盘的 Windows 桌面工具（Electron），干两件事：

1. **记录本机所有 AI CLI 的 token 消耗** —— 增量读各家 CLI 自己的会话文件，不改用户配置、不挂代理。
2. **监控官方账号的 5 小时 / 周额度** —— 用各家 CLI 已存的登录凭据问官方接口，算消耗速度和"会不会提前用完"。

Slogan：`TokenPulse — Your AI usage, at a glance.`

**额度计算部分移植自 `D:\CodePorject\Web\AllAi`**（用户的另一个项目，Next.js + Electron）。
那边是成熟实现，口径经过长期打磨。这边做了独立化改造（去掉 Next.js 依赖、换数据目录、
类型收敛到单一来源）。**要改额度算法，先去看 AllAi 里对应文件的注释和 CHANGELOG**，
很多常数是有实测依据的。

---

## 2. 当前状态：能用，实机验证过

扫描器在这台机器上的真实结果（`npm start` 实测）：

- 258 个会话文件，**32.7 亿 token / 9978 次请求**，全量扫描 2.1 秒
- Claude Code 79.1%（2.59B / ~$1650）、Grok Build 19.5%（638.8M / ~$1230）、Codex CLI 1.5%（47.9M / ~$26）

额度接口：

| 账号 | 状态 |
|------|------|
| Claude | ✅ 实测通，拿到 5h + 周百分比、重置时间 |
| ChatGPT | ✅ 实测通，拿到 5h + 周、plan=plus、手动重置次数 |
| Grok | ⚠️ **代码路径从未在真实数据上验证过** —— 见下方 §6 |

额度折合倒推实测有效：Claude 整周约 410–435M tokens，ChatGPT 约 74M。

测试：`npm test` → **31/31 通过**（移植自 AllAi 的 `test-quota-monitor.cjs`）。

打包：`npm run dist` 三个产物全部实测启动过（见 §7）。

---

## 3. 代码地图

```
src/core/          纯逻辑，不依赖 Electron，可以直接 node -e require 出来测
  paths.ts         数据目录 + 原子写（临时文件 + rename）
  usage-scan.ts    ★ 增量扫会话文件 → 按天/按小时的账（最复杂，604 行）
  quota.ts         问三家官方额度接口（含 Grok 的 protobuf/grpc-web 手写解析）
  quota-history.ts 额度采样历史（官方只给"此刻"，不自己攒就永远只有一个点）
  quota-monitor.ts ★ 速度、预测、健康度。纯函数，测试直接打这里
  model-pricing.ts 型号单价表，给没自报花费的记录估价
  report.ts        把上面几份合并成界面要的一份快照

src/main/          Electron 主进程
  index.ts         托盘、两个定时器、IPC、通知、开机自启
  preload.ts       contextBridge，渲染进程唯一的对外口子
  prefs.ts         设置读写
  icon.ts          图标路径（开发 / 打包后位置不同）

renderer/          界面。没有框架、没有构建步骤，图表是手写内联 SVG
  index.html / app.css / app.js

scripts/
  make-icon.cjs          纯 Node 画图标（zlib 手写 PNG 编码），npm run icons
  test-quota-monitor.cjs 31 项回归测试
```

编译产物在 `build/`（tsc），打包产物在 `dist/`（electron-builder）。
**这两个目录名有历史**：最初 tsc 输出在 `dist/`，用户要求打包产物放 `dist/` 后才挪的。别再换回去。

---

## 4. 核心设计决策（改之前必读）

### 4.1 为什么读会话文件，而不是拦网络

各家 CLI 每次 API 请求都会在自己的会话文件里留一条 usage，这是本机唯一一份"全都算上"的账 ——
终端里跑的、IDE 插件跑的、别的壳子跑的都在内。
挂本地代理要改用户的 Base URL，风险和维护量都不值当。

| CLI | 文件 | 那一条 | 去重键 |
|-----|------|--------|--------|
| Claude Code | `~/.claude/projects/<项目>/<会话>.jsonl` | `type:"assistant"` 的 `message.usage` | `requestId` |
| Codex | `~/.codex/sessions/<日期>/rollout-*.jsonl` | `type:"token_usage_record"` | `payload.response_id` |
| Grok Build | `~/.grok/sessions/**/updates.jsonl` | `turn_completed` 的 `update.usage` | `prompt_id` |

### 4.2 三个会导致数字错得离谱的坑（已处理，别改回去）

1. **Claude Code 的重复行**：一次 API 响应的多个内容块被拆成多行写，**每行都带同一份 usage**。
   按行累加会虚高近 1.8 倍。这些重复行永远相邻，靠 `FileState.lastId` 去重，
   **跨批次也要记住**（一组重复行可能正好被增量读的边界切开）。

2. **input 的口径**：统一为"这一轮送进去的全部输入，缓存读/写是其中明细"。
   Anthropic 把三者分开报，只取 `input_tokens` 会让几十万缓存 token 凭空消失；
   Codex 和 Grok 的 input 本来就含缓存读，**不要再加一次**。
   `estimateCost` 里因此要先扣掉缓存部分再按全价算。

3. **Grok 的 usage 是一轮里所有模型调用的总和**。算用量要的正是这个总和；
   但如果将来要算"上下文占用"，不能用它（会虚高好几倍）。

### 4.3 增量扫描的结构

按**字节偏移**增量读（几百兆的会话文件不可能每次全读），
而且**每个文件的账单独记**（`files[路径].days`），全局合计 = 所有文件相加。
好处：某个文件被重写/截断时，把它自己那份清掉重读就行，不会重复计数。

`STATE_VERSION`（`usage-scan.ts`）= 账本结构版本。
**只要改了 bucket 结构或解析逻辑，必须 +1**，否则老账本会和新代码混着用，算出来的数没法解释。

### 4.4 预测为什么用"墙上时钟平均"

`quota-monitor.ts` 顶部的长注释是这个项目最该读的一段。要点：

- **速度 = 已用百分比 ÷ 窗口已经过去的时间**。额度按墙钟重置，用户睡觉、开会、关机的时间
  照样在走，**必须留在分母里**。
- AllAi 0.17.6 曾经改成"只挑涨了的区间取中位数"，等于假设用户 24 小时不停按爆发速度跑，
  把 9% 的真实用量外推成重置时 135%（真实约 53%）—— 这就是"提前两天用完"误报的由来。
  **不要再往这个方向改。**
- 最近 24h 的速度照样算，但只进 `fastPerH` / `projectedHigh`，用来说"最快可能什么时候用完"，
  不拿它当结论。
- 折算整窗额度要求已用 ≥ 2%（Claude 的 utilization 是整数，1% 时误差放大几十倍），
  并且把可信度标在界面上。

这些规则**每一条在 `npm test` 里都有对应用例**。改算法前先跑测试，改完确保仍然 31/31。

### 4.5 官方账号 vs 中转站

额度监控只算**走官方登录账号**的会话（API Key / 中转站不占订阅额度）。判定方式三家不同：

- Claude Code：看 `~/.claude/settings.json` 的 env 有没有配 `ANTHROPIC_BASE_URL` / `_AUTH_TOKEN` / `_API_KEY`
- Grok：看 `~/.grok/config.toml` 有没有生效的 `base_url`
- Codex：**每个会话自己记了 `model_provider`**，但**不能只看名字** —— 用户完全可以把官方登录的
  配置块叫 `custom`（这台机器上就是）。要解析 `config.toml` 看它 `requires_openai_auth` / `env_key` / `base_url` 怎么写。
  配置块被删掉的历史会话，靠 `rollups.codexProviders` 里记住的旧结论兜底。

归属判定**每次扫描都重来一遍**，而且在"文件没变就跳过"之前做 ——
用户改配置、重新登录都不会碰会话文件本身，只在文件变动时更新归属的话，历史会话会一直挂着旧结论。

---

## 5. 过程中发现并修掉的 bug（别踩回去）

| # | 问题 | 原因 | 修法 |
|---|------|------|------|
| 1 | 进度条、状态点全不显示 | 页面 CSP 是 `style-src 'self'`，**会把 `style` 属性整个丢掉**，而条的宽度和颜色全是算出来的 | 没放宽 CSP，改走 CSSOM `style.setProperty`（不受这条限制）。见 `app.js` 的 `style()` |
| 2 | 开发模式写坏开机启动项 | `npm start` 跑的是 `node_modules/electron.exe`，登记进去开机会启动一个空 Electron | `applyPrefs` 里加 `app.isPackaged` 守卫 |
| 3 | 免安装版启动项是死路径 | Portable 每次自解压到临时目录，`process.execPath` 指临时副本 | 优先用 `process.env.PORTABLE_EXECUTABLE_FILE` |
| 4 | 模型表出现两行同名 | 中转站会把 grok 挂到 Claude Code 上，同名不同来源 | 表里把来源标出来 |
| 5 | 趋势图是个空框加虚线 | 采样点全挤在"现在"那条竖线上 | `SPARK_MIN_SPAN_MS`，跨度不够一小时就不画 |

**第 1 条特别容易复发**：以后在 renderer 里想写 `setAttribute("style", ...)` 或 `innerHTML` 带 style 的，
都会静默失效。统一走 `el()` helper。

---

## 6. 已知缺口 / 没做的事

按重要性排：

1. **Grok 额度代码路径从未在真实数据上验证过。**
   这台机器 `~/.grok/auth.json` 里的 token 已过期，接口返回
   `Invalid or expired credentials (upstream=PermissionDenied)`。
   代码是从 AllAi 原样移植的（含 protobuf / grpc-web 手写解析，`quota.ts` 里那一大段），
   逻辑上应该对，但**我没见它成功返回过一次**。
   用户重新 `grok` 登录后要重点验证这条路径。失败时是静默降级（该账号不显示），不影响别家。

2. **`usage-scan.ts` 没有单元测试。** AllAi 里有 `scripts/test-usage-scan.cjs`，**我没有移植**。
   这是全项目最复杂的文件（604 行，含去重、增量偏移、归属判定），目前只靠实机跑通验证。
   **如果要动扫描器，强烈建议先把那个测试移植过来。**

3. **只支持三家 CLI。** Gemini CLI / Qwen / iFlow / Copilot 我查过了，
   它们**不往本地写 per-request usage**，没有数据源，不是没做而是做不了。
   等它们写了，在 `usage-scan.ts` 的 `roots()` 和解析函数那儿加一档即可（结构已经留好）。

4. **只在 Windows 上跑过。** macOS 的 tray template image 代码写了但没验证过；
   `quota.ts` 依赖 `curl`（Win10+ 自带，macOS 自带，Linux 不一定）。

5. **花费是估算不是账单。** Grok 自报花费直接用；Claude Code / Codex 的会话文件里只有 token，
   按 `model-pricing.ts` 的公开单价估。定价会变，中转站价格也不同。界面上已标注。

6. 没有自动更新、没有 i18n（只有中文）、日图表固定 60 天、按小时的账只留 40 天。

---

## 7. 构建与打包

```bash
npm install
npm run icons   # 生成 packaging/icon.png + tray.png（纯 Node 画的，改配色改 make-icon.cjs）
npm start       # 编译 + 启动（开发模式，不会设开机自启）
npm test        # 31 项额度计算回归测试
npm run dist    # 打包到 dist/
```

产物三个，都实测启动过：

| 文件 | 用途 |
|------|------|
| `dist/TokenPulse-0.1.0-Setup.exe` | 安装版（78MB） |
| `dist/TokenPulse-0.1.0-Portable.exe` | 免安装单文件（78MB），每次自解压到临时目录 |
| `dist/win-unpacked/TokenPulse.exe` | 免安装目录版（269MB），启动最快，适合反复测试 |

### ⚠️ 打包会卡在 winCodeSign（换机器/清缓存后必现）

报错长这样：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权
  ...\Cache\winCodeSign\<随机数>\darwin\10.12\lib\libcrypto.dylib
```

electron-builder 下的包里带了两个 macOS 符号链接，Windows 没开开发者模式建不了，
7-Zip 直接判致命错误、整包解压失败、重试三次全挂。我们根本不签名，只是要里面的 `rcedit`
（给 exe 塞图标和版本信息）。

**解法**（README 里也有，一次就够，之后一直命中缓存）：

```bash
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
# 先跑一次 npm run dist 让它把 .7z 下下来（解压会失败，没关系）
SRC=$(ls -S "$CACHE"/*.7z | head -1)
node_modules/7zip-bin/win/x64/7za.exe x -bd "$SRC" -o"$CACHE/winCodeSign-2.6.0" '-x!darwin*'
rm -f "$CACHE"/*.7z
```

**目录名必须正好是 `winCodeSign-2.6.0`** —— 我试错过 `Cache/winCodeSign-2.6.0`（根目录）和
`Cache/winCodeSign/2.6.0` 都不认。版本号查法：

```bash
node_modules/app-builder-bin/win/x64/app-builder.exe download-artifact --name winCodeSign
```

缓存命中时它会直接把路径打出来；没命中就会去下载并告诉你下的是哪个版本。

---

## 8. 数据与副作用

全部留在本机 `~/.tokenpulse/`，不往任何地方发：

| 文件 | 内容 | 删掉会怎样 |
|------|------|-----------|
| `usage-rollups.json` | 每个会话文件扫到哪个字节 + 它贡献的账（当前约 136KB） | 从头重扫，几秒钟，**不会丢数据**（账本本来就是从会话文件推出来的） |
| `quota-history.json` | 官方额度采样历史，留 45 天 | 速度和预测要重新攒（5 分钟一个点），**这个丢了是真丢了**，官方不给历史 |
| `prefs.json` | 开机自启、关窗口收托盘、提醒阈值 | 回到默认 |

**唯一的系统级副作用：开机启动项**
`HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `com.tokenpulse.app`。
默认开（用户明确要求"电脑开着就一直记"），设置里可关。
**开发模式不会写**（见 §5 第 2 条）。

> 调试时如果跑了打包版，记得检查这条注册表项。我在开发过程中产生的都已清理干净，
> 交接时该项为空 —— 用户自己跑一次打包版才会写入。

---

## 9. 建议的下一步

按性价比排，供参考，不是必须：

1. **移植 `test-usage-scan.cjs`**（见 §6 第 2 条）。动扫描器之前的保险。
2. **验证 Grok 额度链路**，等用户重新登录（见 §6 第 1 条）。
3. 托盘菜单里加"暂停记录"—— 目前只能退出。
4. 用量页加按项目/目录维度（会话文件路径里有项目名，`~/.claude/projects/<项目>/`，信息现在被丢掉了）。
5. 额度重置时弹个"新窗口开始"的通知，现在只有过线提醒。
6. 自动更新（electron-updater），但要先有个发布渠道。

---

## 10. 和用户协作的几点观察

- 用户看重**实机验证**：不要只说"应该能工作"，跑起来、截图、给真实数字。
- 用户的 AllAi 项目是重要参照，代码风格（中文注释讲"为什么"、注释里写实测数据和踩坑记录）
  是刻意的，**请保持**。
- 用户会明确指定产物位置（比如要求免安装版放 `dist/`），照做，不要自作主张换目录。
