# TokenPulse 交接文档

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
