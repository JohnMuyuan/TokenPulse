/*
 * 界面语言。中文是原文，英文按「中文原文 → 英文」查表翻译。
 *
 * 做法：界面照常用中文渲染，这里用 MutationObserver 盯着 DOM，把文本节点和 title / placeholder / aria-label
 * 换成英文。这样 app.js 一千多行里的中文不用逐个改成 t() 调用，主进程、核验规则这些从别处送来的中文也一并能翻。
 * 带数字、型号名的句子（「3 次请求」「请求的是 X，上游返回的是 Y」）走 PATTERNS：先拆成模板和变量，变量再递归翻译。
 *
 * 切换语言会重新加载页面：已经翻成英文的节点不留中文原文，重新渲染一遍最干净。
 * 语言存在 localStorage（启动前就要知道），同时写进 prefs.json 给主进程的托盘菜单和通知用。
 */
(function (root) {
  const KEY = 'tokenpulse-lang';
  let mode = 'system';
  try { mode = localStorage.getItem(KEY) || 'system'; } catch { /* 隐私模式读不到就跟随系统 */ }
  // 主进程也 require 这份词典（托盘菜单、通知），那边没有 navigator，语言由调用方决定
  const systemLang = () => (typeof navigator !== 'undefined' && !String(navigator.language || '').toLowerCase().startsWith('zh') ? 'en' : 'zh');
  const resolved = mode === 'system' ? systemLang() : mode;
  // 含中文句号：说明文字里徽章后面单独剩下的「。」也要换掉
  const HAN = /[一-鿿。]/;

  /* ---------------- 整句 ---------------- */
  const EN = {
    // 页面与导航
    'TokenPulse · 用量与额度': 'TokenPulse · Usage & Quota', '工作空间': 'Workspace', '总览': 'Overview', '额度详情': 'Quota', '用量明细': 'Usage', '请求记录': 'Requests', '会话管理': 'Sessions', '设置': 'Settings',
    '主导航': 'Main navigation', 'TokenPulse 总览': 'TokenPulse overview', '本地数据 ·': 'Local data ·', '最小化': 'Minimize', '最大化': 'Maximize', '还原': 'Restore', '关闭': 'Close',
    '刷新数据': 'Refresh', '正在刷新…': 'Refreshing…', '正在读取本地数据': 'Reading local data', '正在读取本地用量…': 'Reading local usage…', '正在扫描本地会话…': 'Scanning local sessions…',
    '今天的用量与额度': "Today's usage and quota", '看看还剩多少额度，再安排接下来的工作。': 'See how much quota is left, then plan the rest of your work.',
    // 多账号额度、账号管理
    '重命名': 'Rename', '拖动调整顺序': 'Drag to reorder', '回车保存，Esc 取消；留空就显示邮箱。': 'Enter to save, Esc to cancel. Leave empty to show the email.',
    '给这个账号起个名字': 'Name this account', '账号名字（留空就显示邮箱）': 'Account name (leave empty to show the email)', '已改名': 'Renamed', '已去掉名字，显示邮箱': 'Name removed. Showing the email.',
    '改名失败，请重试': 'Rename failed. Please try again.', '顺序没保存上，请重试': "The order wasn't saved. Please try again.", '账号列表已经变了，请重新打开设置再排': 'The account list has changed. Reopen Settings and try again.', '名字无效': 'Invalid name',
    '每家可以登记多个账号，所有账号的额度都会查询，在首页和额度页各占一张卡片；按住左边的把手拖动可以调整顺序，点铅笔可以给账号起名字。点「添加账号」会用你的默认浏览器打开官方授权页，已登录的浏览器账号可以直接确认。': "Each provider can have several accounts. Every account's quota is queried and gets its own card on Overview and Quota. Drag the handle on the left to reorder, or click the pencil to name an account. \"Add account\" opens the official sign-in page in your default browser, where an already signed-in browser account can simply confirm.",
    '未命名账号': 'Unnamed account', '已隐藏': 'Hidden', '上移': 'Move up', '下移': 'Move down', '删除': 'Delete', '恢复': 'Restore',
    '隐藏（CLI 还登录着这个账号）': 'Hide (the CLI is still signed in to this account)', '重新查询并显示这个账号的额度': "Query and show this account's quota again",
    '确认隐藏': 'Confirm hide', '确认删除': 'Confirm delete', '正在保存…': 'Saving…',
    'CLI 还登录着这个账号，删不掉，只会隐藏：不查额度、不在首页和额度页显示，随时可以恢复。再点一次确认。': "The CLI is still signed in to this account, so it can't be deleted, only hidden: no quota queries, not shown on Overview or Quota, and you can restore it any time. Click again to confirm.",
    '删除后不再查询这个账号的额度，TokenPulse 保存的凭据也会一并删掉（已有的额度历史保留）。再点一次确认。': "This account's quota will no longer be queried, and the credentials TokenPulse saved for it are deleted too (existing quota history is kept). Click again to confirm.",
    '已调整顺序': 'Order updated', '已删除账号': 'Account deleted', '已隐藏账号，可以随时恢复': 'Account hidden. You can restore it any time.', '已恢复账号，正在查询额度': 'Account restored. Querying quota…',
    '按住拖动，查看更多账号': 'Drag to see more accounts',
    '作者': 'Author',
    '登录成功，已添加账号并刷新额度': 'Signed in. Account added and quota refreshed.',
    '每家可以登记多个账号，所有账号的额度都会查询，在首页和额度页各占一张卡片；用箭头调整显示顺序。点「添加账号」会用你的默认浏览器打开官方授权页，已登录的浏览器账号可以直接确认。': 'Each provider can have several accounts. Every account\'s quota is queried and gets its own card on Overview and Quota; use the arrows to change the order. "Add account" opens the official sign-in page in your default browser, where an already signed-in browser account can simply confirm.',
    '本机 CLI 用这个账号发出的请求，按 CLI 当时登录的账号归属。': 'Requests the local CLI sent with this account, attributed by the account the CLI was signed in to at the time.',
    // 会话管理
    '本机 Agent 的对话历史': 'Local Agent conversations', '查看、复制项目地址，或者直接接着回复。': 'Browse, copy the project path, or reply right here.',
    '重新读取会话': 'Reload sessions', '搜索标题、项目或内容…': 'Search title, project or content…', '搜索会话': 'Search sessions', '按 Agent 筛选': 'Filter by Agent', '按项目筛选': 'Filter by project', '会话列表': 'Sessions',
    '全部': 'All', '今天': 'Today', '昨天': 'Yesterday', '最近 7 天': 'Last 7 days', '最近 30 天': 'Last 30 days', '更早': 'Earlier', '回复中': 'Replying',
    '正在读取本机会话…': 'Reading local sessions…', '还没有找到本机 Agent 的会话。': 'No local Agent sessions found yet.', '没有符合条件的会话。': 'No matching sessions.',
    '选择一个会话': 'Select a session', '正在读取会话…': 'Loading sessions…', '正在读取对话…': 'Loading conversation…',
    '左边是本机 Claude Code、Codex CLI 和 Grok Build 的对话历史。选中后可以查看完整对话、复制项目地址，或者直接回复。': 'On the left: conversation history from Claude Code, Codex CLI and Grok Build on this computer. Pick one to read the full conversation, copy its project path, or reply directly.',
    '复制项目地址': 'Copy project path', '这个会话没有记录项目地址': 'This session has no recorded project path', '回复对话': 'Reply', '更多': 'More', '更多操作': 'More actions',
    '在终端里继续': 'Continue in terminal', '打开 PowerShell，用 CLI 的交互界面接着这段会话': "Open PowerShell and continue this session in the CLI's own interface", '复制继续命令': 'Copy resume command', '复制会话 ID': 'Copy session ID',
    '项目地址已复制': 'Project path copied', '继续命令已复制': 'Resume command copied', '会话 ID 已复制': 'Session ID copied', '复制': 'Copy', '已复制': 'Copied', '复制这条消息': 'Copy this message', '复制失败，请重试。': 'Copy failed. Please try again.',
    '已在终端里打开这段会话。': 'Opened this session in a terminal.', '打不开终端，请确认对应的 CLI 已安装。': 'Could not open a terminal. Check that the CLI is installed.',
    '会话读取失败，请重试。': 'Could not read sessions. Please try again.', '这个会话读取失败，请重试。': 'Could not read this session. Please try again.',
    '参数': 'Input', '结果': 'Result', '结果（出错）': 'Result (error)', '工具': 'Tool', '用户': 'User', '条': 'items',
    '上下文已压缩，从摘要继续': 'Context compacted, continuing from summary', '上下文已压缩': 'Context compacted', '已中断': 'Interrupted', '[图片]': '[image]',
    '回复内容': 'Reply', '发送': 'Send', '停止': 'Stop', '回复权限': 'Reply permissions', '只读': 'Read-only', '可改文件': 'Can edit files',
    '只让 Agent 看和回答，不改任何文件': 'The Agent can only read and answer; no files are changed',
    '允许 Agent 修改这个项目里的文件；运行命令等其他操作仍会自动拒绝': 'Let the Agent edit files in this project; running commands and other actions are still refused',
    '另一段会话正在回复，等它结束再发': 'Another session is replying; send after it finishes', '这个会话没有记录项目目录，没法在原目录里继续': 'This session has no recorded project folder, so it cannot continue there',
    '回复没发出去，请重试。': 'The reply was not sent. Please try again.', '已回复，新的对话已写回会话记录。': 'Replied. The new turn was saved to the session.', '已停止': 'Stopped', '未知原因': 'unknown reason', '回复失败': 'Reply failed',
    'Codex 返回了错误': 'Codex returned an error', '这段会话正在回复，等它结束或先停止': 'This session is already replying; wait or stop it first',
    '会话参数无效': 'Invalid session', '找不到这个会话': 'Session not found', '回复内容是空的': 'The reply is empty', '回复内容太长': 'The reply is too long', '内容无效': 'Invalid content',
    '这个会话的项目目录已经不在了，没法在原目录里继续': "This session's project folder no longer exists, so it cannot continue there",
    '把使用节奏，放在时间里看': 'Your usage pace, over time', '剩余额度、重置时间与达到上限的参考时间，集中在这里。': 'Remaining quota, reset times and when you may hit the limit — all in one place.',
    '每一笔用量，都有迹可循': 'Every token, accounted for', '按日期、工具与模型查看消耗，找到值得关注的变化。': 'Browse usage by date, tool and model to spot changes worth a look.',
    '每一次请求，都能核对': 'Every request, verifiable', '逐条查看本机的每一次 API 请求，核对上游返回的型号和你要的是不是同一个。': 'Inspect every API request on this computer and check whether the upstream returned the model you asked for.',
    '本地数据读取中': 'Loading local data', '费用仅供参考，不代表订阅账单。': 'Costs are estimates, not your subscription bill.', '统计口径': 'Methodology',
    '本地数据读取失败，请点击刷新重试。': 'Could not read local data. Click Refresh to try again.', '刷新失败，请重试并检查数据目录是否可写。': 'Refresh failed. Try again and check that the data folder is writable.',
    // 总览
    '官方额度': 'Official quota', '实时窗口': 'Live windows', '查看完整预测': 'Full forecast', '查看明细': 'View details', '用量趋势': 'Usage trend', '使用节奏': 'Rhythm', '所选范围': 'Selected range',
    '工具分布': 'By tool', '按 Tokens': 'By tokens', '模型用量排行': 'Top models', '按天汇总 · 本机时间': 'Daily · local time', '费用': 'Cost', '请求': 'Requests',
    '总 Tokens': 'Total tokens', '参考费用': 'Est. cost', '请求次数': 'Requests', '缓存读取占比': 'Cache read share', '输入 + 输出': 'in + out', '次': 'count', '输入口径': 'of input',
    '较上一时段': 'vs previous period', '上一时段无记录': 'No data in previous period', '暂无变化': 'No change', 'USD': 'USD',
    '节奏正常': 'On track', '用量偏高': 'Running high', '重置前压力较高': 'Tight before reset', '当前窗口紧张': 'Window nearly used up', '暂无数据': 'No data',
    '当前较低窗口剩余': 'Lower window remaining', '上次采样剩余': 'Remaining at last sample', '周额度剩余': 'Weekly remaining', '5 小时剩余': '5-hour remaining',
    '外环：5 小时额度　内环：周额度': 'Outer: 5-hour · Inner: weekly', '外环': 'outer', '内环': 'inner', '详情': 'Details',
    '近期没有新增用量，暂不估计': 'No recent usage, no estimate', '近期没有新增用量': 'No recent usage', '重置前不会达到上限': 'Won’t hit the limit before reset',
    '额度已用完，等待重置': 'Quota used up, waiting for reset', '额度已用完，请等待重置': 'Quota used up, please wait for the reset', '已用完': 'Used up',
    '等待新采样': 'Waiting for a new sample', '等待有效采样': 'Waiting for a valid sample', '等待确认': 'Awaiting confirmation', '等待重置': 'Waiting for reset', '等待重置确认': 'Waiting for reset confirmation', '等待采样确认': 'Waiting for sample confirmation',
    '窗口已重置，等待新采样确认': 'Window reset, waiting for a new sample', '旧窗口已结束': 'Previous window ended', '旧窗口已结束，正在等待新数据': 'Previous window ended, waiting for new data',
    '尚未取得官方额度': 'No official quota yet', '尚无额度采样': 'No quota samples yet', '尚未采样': 'Not sampled yet', '暂无采样': 'No samples', '暂无窗口数据': 'No window data',
    '接口未提供此窗口': 'Not provided by the API', '接口未提供重置时间': 'Reset time not provided', '接口未提供': 'not provided', '样本不足': 'not enough samples',
    '可能尚未登录、凭据过期或网络未连通。本机用量仍正常记录。': 'You may not be signed in, credentials may have expired, or the network is down. Local usage is still recorded.',
    '凭据过期或网络错误也可能导致采样失败；这不会影响本机用量统计。': 'Expired credentials or network errors can also cause failed samples; local usage stats are unaffected.',
    '采样已过期': 'Sample is stale', '采样已过期，刷新后再判断': 'Sample is stale, refresh to check again', '暂时还没有这个账号的额度数据': 'No quota data for this account yet',
    '所选范围暂无记录': 'No records in this range', '所选范围还没有工具用量': 'No tool usage in this range', '所选范围还没有模型用量': 'No model usage in this range',
    '活跃天数': 'Active days', '日均': 'Daily avg', '日均请求': 'Daily requests', '峰值用量': 'Peak day', '用量最高的一天': 'Busiest day', '单次平均用量': 'Avg per request', '工具 token 占比': 'Token share by tool',
    '平均值包含没有使用的日期。对比上一段等长时间，今天的记录仍在累积。': 'Averages include days without usage. Compared with the previous period of equal length; today is still in progress.',
    '每日用量柱状图': 'Daily usage bar chart', '最近24小时用量柱状图': 'Last 24 hours usage bar chart',
    // 时间选择
    '今天': 'Today', '7 天': '7 days', '14 天': '14 days', '30 天': '30 days', '90 天': '90 days', '全部': 'All', '自定义': 'Custom', '时间范围': 'Time range',
    '开始日期': 'Start date', '结束日期': 'End date', '结束日期跟随今天': 'End date follows today', '开始日期不能晚于结束日期': 'The start date can’t be after the end date',
    '取消': 'Cancel', '确定': 'Apply', '上个月': 'Previous month', '下个月': 'Next month', '日': 'S', '一': 'M', '二': 'T', '三': 'W', '四': 'T', '五': 'F', '六': 'S',
    '全部工具': 'All tools', '筛选工具': 'Filter by tool', '天': 'day', '周': 'Week', '月': 'Month', '年': 'Year',
    // 额度详情
    '官方窗口独立于用量筛选': 'Official windows ignore the usage filters', '5 小时': '5 hours', '5 小时窗口': '5-hour window', '周额度': 'Weekly', '周额度窗口': 'Weekly window', '5 小时额度': '5-hour quota',
    '官方额度窗口': 'Official window', '剩余额度': 'remaining', '已用额度': 'Used', 'Token 与费用': 'Tokens & cost', '本窗口已用（本机）': 'Used this window (local)', '剩余可用（估算）': 'Left (estimate)',
    '整窗容量折算': 'Window capacity', '已用不到 2%，暂无法折算': 'Under 2% used, can’t estimate yet', '样本不足，暂无法折算': 'Not enough samples to estimate',
    '可信度较低 · 已用不到 5%': 'Low confidence · under 5% used', '可信度中等': 'Medium confidence', '可信度较高': 'High confidence',
    '速度与时间': 'Pace & timing', '窗口平均速度': 'Window avg pace', '整个窗口，含休息时间': 'Whole window, incl. idle time', '最近 1 小时速度': 'Last-hour pace', '最近 24 小时速度': 'Last-24h pace',
    '窗口开始': 'Window start', '重置时间': 'Resets', '重置时间未知': 'Reset time unknown', '预计达到上限': 'Limit reached', '重置时预计使用': 'Projected at reset', '重置时预计用量': 'Projected usage at reset',
    '预测': 'Forecast', '预测主要依据': 'Based on', '按最近趋势': 'Recent trend', '会用满': 'Will run out', '不会': 'No', '暂无法估计': 'Can’t estimate yet', '暂无新增': 'No new usage',
    '采样跨度还不够，暂不估计达到上限的时间': 'Not enough sampling span to estimate when the limit is reached', '采样跨度不足 1 小时，继续记录后显示趋势': 'Less than an hour of samples — the trend appears as more are recorded',
    '近期没有新增用量，暂不估计达到上限的时间': 'No recent usage, so no limit estimate',
    'Token 和费用按「本机已用 ÷ 已用百分比」倒推，只统计这台电脑；在别的设备上也用这个账号时会偏低，也不是官方公布的上限。': 'Tokens and cost are back-calculated as local usage ÷ used percentage, counting this computer only. They run low if you use the account on other devices, and are not an official limit.',
    '额度容量趋势': 'Quota capacity trend', '每个历史窗口折算出的「整窗能用多少」，看官方给的总额度有没有变化': 'Estimated capacity of each past window — see whether the official allowance changes',
    '历史 5 小时额度容量折线': '5-hour capacity history', '历史周额度容量折线': 'Weekly capacity history',
    '还没有能折算的历史窗口：需要窗口已用 ≥ 2%，并且本机在这个窗口里有用量': 'No past window can be estimated yet: a window needs ≥ 2% used and local usage within it',
    '实心点可信，空心点已用不到 5%、偏差较大。按本机用量倒推，多设备使用时会偏低。': 'Solid dots are reliable; hollow dots had under 5% used and may be off. Back-calculated from local usage, so it runs low with multiple devices.',
    '最近 24 小时 · 官方会话用量': 'Last 24 hours · official sessions', '本周额度采样': 'Weekly quota samples', '当前周窗口的额度已用百分比': 'Used % of the current weekly window',
    '仅统计本机归属该官方账号的会话。横轴按本地时间，含当前未结束的小时。': 'Only sessions on this computer that belong to this official account. Local time, including the current hour.',
    '点 / 时': 'pts/h', '进行中': 'In progress', '当前较低窗口': 'Lower window', '额度剩余': 'Quota left', '额度窗口': 'Quota window', '年 · 本地时间': 'year · local time', '单位': 'Unit',
    'CLI 当前登录': 'Current CLI login', '凭据已过期': 'Credentials expired', '需重新登录': 'Sign in again', '等待自动续期': 'Waiting for auto-renewal', '自动续期': 'Auto-renewal',
    // 用量明细
    'Token 构成': 'Token breakdown', '输入含缓存读写，推理为输出子集': 'Input includes cache reads/writes; reasoning is part of output', '输入 Tokens': 'Input tokens', '输出 Tokens': 'Output tokens',
    '缓存读取': 'Cache read', '缓存写入': 'Cache write', '推理 Tokens': 'Reasoning tokens', '含缓存读取与写入': 'Incl. cache reads & writes', '含推理 Tokens': 'Incl. reasoning tokens', '输入的一部分': 'Part of input', '输出的一部分': 'Part of output',
    '按日期、工具、模型聚合；费用为参考估算': 'Grouped by date, tool and model; costs are estimates', '导出 CSV': 'Export CSV', '搜索': 'Search', '搜索模型或工具名称…': 'Search models or tools…', '排序': 'Sort',
    '日期：最近优先': 'Date: newest first', 'Tokens：从多到少': 'Tokens: most first', '费用：从高到低': 'Cost: highest first', '请求：从多到少': 'Requests: most first',
    '日期 / 工具': 'Date / Tool', '模型': 'Model', '输入': 'Input', '输出': 'Output', '上一页': 'Previous', '下一页': 'Next', '未定价': 'Unpriced', '部分未定价': 'Partly unpriced',
    '没有匹配的记录，试试其他时间、工具或关键词。': 'No matching records. Try another range, tool or keyword.', '导出失败，请检查保存位置是否可写。': 'Export failed. Check that the destination is writable.',
    // 请求记录
    '全部请求': 'All requests', '型号一致': 'Model matches', '型号不一致': 'Model mismatch', '响应存疑': 'Suspicious response', '无法核验': 'Unverifiable', '点击筛选': 'Filter', '没有发现': 'None found',
    '请求和返回的型号对不上': 'Requested and returned models differ', '型号名对得上，响应格式不对': 'Model name matches, response format doesn’t', '所选范围内没有可核验的请求': 'No verifiable requests in this range',
    '每一行是一次 API 请求，点开查看响应 ID 和核验依据': 'Each row is one API request — expand it to see response IDs and the evidence', '核验方法': 'How it works', '搜索请求': 'Search requests',
    '搜索型号、项目、会话或响应 ID…': 'Search model, project, session or response ID…', '核验': 'Check', '时间：最近优先': 'Time: newest first', '时间 / 工具': 'Time / Tool', '项目': 'Project', '型号': 'Model',
    '请求型号 vs 返回型号': 'Requested vs returned model', '响应特征': 'Response fingerprint', '局限': 'Limits',
    'Claude Code 和 Grok Build 的会话文件同时记下了「要的型号」和「上游回的型号」，两者对不上就标': 'Claude Code and Grok Build session files record both the model you asked for and the model the upstream returned. When they differ, the request is marked',
    'Anthropic 官方的响应 ID 是 msg_ 加 24 位、每次都带 req_ 开头的请求 ID。号称 Claude、ID 却是 OpenAI 或 UUID 等格式，说明请求被别家接口转换过，标': 'Official Anthropic response IDs are msg_ plus 24 characters, always with a req_ request ID. A "Claude" reply with an OpenAI- or UUID-style ID was converted from another API and is marked',
    'Codex 的会话文件不记录上游返回的型号；旧版 Claude Code 不记录请求的型号。这些只核对了响应格式。': 'Codex session files don’t record the returned model, and older Claude Code versions don’t record the requested one. For those only the response format is checked.',
    '只读本机记录，不额外发请求、不花额度。中转站可以把型号名和 ID 都伪造成官方的样子，「一致」只说明没露馅，「不一致」和「存疑」才是实打实的证据。': 'Only local records are read — no extra requests, no quota spent. A relay can fake both the model name and the ID format, so "matches" only means nothing gave it away; "mismatch" and "suspicious" are real evidence.',
    '正在读取请求记录…': 'Loading requests…', '所选时间和工具下没有请求记录。': 'No requests for this range and tool.', '这个核验结论下没有请求，换一个试试。': 'No requests with this result — try another.',
    '请求记录读取失败，请重试。': 'Could not load requests. Please try again.', '返回型号未记录': 'Returned model not recorded', '请求型号未记录': 'Requested model not recorded', '未记录': 'Not recorded',
    '时间': 'Time', '请求型号': 'Requested model', '返回型号': 'Returned model', '响应格式': 'Response format', '账号类型': 'Account type', '官方登录账号': 'Official login', 'API Key / 中转站': 'API key / relay', '未知': 'Unknown',
    '响应 ID': 'Response ID', '请求 ID': 'Request ID', '会话': 'Session', '工作目录': 'Working directory', '模型调用': 'Model calls', '核验说明': 'Check notes', '工具': 'Tool',
    'Anthropic 官方格式': 'Anthropic format', 'OpenAI Responses 格式': 'OpenAI Responses format', '类 OpenAI Responses 格式': 'OpenAI Responses-like format', 'OpenAI Chat 格式': 'OpenAI Chat format',
    '非标准 msg_ 格式': 'non-standard msg_ format', 'UUID（第三方接口）': 'UUID (third-party API)', '其他格式': 'other format', '（无）': '(none)', 'AWS Bedrock': 'AWS Bedrock', 'Google Vertex': 'Google Vertex',
    'xAI（Grok Build）': 'xAI (Grok Build)', 'CC Switch 代理': 'CC Switch proxy', 'CC Switch 导入': 'CC Switch import',
    '这段会话没记下请求的型号（旧版 Claude Code，或会话刚恢复还没写入），只核对了响应格式': 'This session didn’t record the requested model (older Claude Code, or a just-resumed session), so only the response format was checked',
    'Codex 会话文件不记录上游返回的型号，只能核对响应格式': 'Codex session files don’t record the returned model; only the response format can be checked',
    '这一轮没有返回按型号拆分的用量，无法核对返回型号': 'This turn has no per-model usage, so the returned model can’t be checked', '这一轮没记下请求的型号': 'This turn didn’t record the requested model',
    '走的是 API Key / 中转站：中转可以原样回显型号名，一致只代表没露馅': 'Goes through an API key / relay: a relay can echo the model name back, so a match only means nothing gave it away',
    '这个会话走官方账号，响应却没有 Anthropic 的 request-id': 'This session uses an official account, but the response has no Anthropic request-id',
    '来自 CC Switch 代理：型号是它从上游响应里读到的': 'From the CC Switch proxy: the model was read from the upstream response', '来自 CC Switch 的导入（TokenPulse 这天没有这个工具的记录）': 'Imported from CC Switch (TokenPulse has no record for this tool on this day)',
    '经 CC Switch 代理：返回型号是代理从上游响应里读到的': 'Through the CC Switch proxy: the returned model was read from the upstream response',
    // 设置
    '外观、官方账号、额度提醒和本地数据都在这里。': 'Appearance, official accounts, alerts and local data.', '设置分类': 'Settings sections', '通用': 'General', '官方账号': 'Accounts', '提醒': 'Alerts', '数据': 'Data', '关于': 'About',
    '修改后自动保存': 'Changes are saved automatically', '正在保存…': 'Saving…', '设置已保存': 'Settings saved', '已保存': 'Saved', '保存失败，请检查数据目录权限': 'Save failed — check the data folder permissions', '设置读取失败，请重试。': 'Could not read settings. Please try again.',
    '外观': 'Appearance', '深浅色。选「跟随系统」就跟着 Windows 的设置走。': 'Light or dark. "System" follows your Windows setting.', '日间': 'Light', '夜间': 'Dark', '跟随系统': 'System',
    '一直用浅色': 'Always light', '一直用深色': 'Always dark', '跟着 Windows 的深浅色走，系统一换这边立刻跟着变': 'Follows Windows light/dark mode and switches instantly',
    '语言': 'Language', '界面语言。切换后界面会重新加载。': 'Interface language. The window reloads after switching.', '简体中文': '简体中文', 'English': 'English', '跟着 Windows 的显示语言走': 'Follows the Windows display language',
    '关闭窗口时': 'When closing the window', '收进托盘后照常每分钟记录用量、每 5 分钟采样额度。真正退出请用托盘图标的右键菜单。': 'In the tray, usage is still recorded every minute and quota sampled every 5 minutes. To quit, use the tray icon’s menu.',
    '收进托盘继续运行': 'Keep running in the tray', '默认。后台记录不中断': 'Default. Recording continues in the background', '直接退出': 'Quit', '关掉窗口就结束进程，期间不记录用量': 'Closing the window ends the app; nothing is recorded meanwhile',
    '开机自启': 'Start at login', '登录电脑后自动在托盘里开始记录。只对安装版和免安装版生效，开发模式不会写入启动项。': 'Start recording in the tray when you sign in to Windows. Applies to installed and portable builds, not dev mode.',
    '开机自动启动': 'Start automatically', '默认。电脑开着就一直记': 'Default. Records whenever the computer is on', '不自动启动': 'Don’t start automatically', '需要时手动打开': 'Open it manually when needed',
    '启动时': 'On launch', '手动打开 TokenPulse 时是否弹出窗口。开机自启那一次总是直接进托盘。': 'Whether the window opens when you launch TokenPulse yourself. Starting at login always goes to the tray.',
    '显示窗口': 'Show the window', '默认': 'Default', '直接进入托盘': 'Go straight to the tray', '点托盘图标再打开窗口': 'Click the tray icon to open the window',
    '额度提醒': 'Quota alert', '任一官方额度窗口（5 小时或每周）的已用比例达到这个值时，发一条系统通知。同一个窗口只提醒一次，重置后重新计算。': 'Send a notification when any official window (5-hour or weekly) reaches this usage. Each window alerts once and resets with the window.',
    '不提醒': 'Off', '关闭额度通知': 'No quota notifications', '留出充足余量': 'Leaves plenty of headroom', '快用完才提醒': 'Only when nearly used up', '当前自定义值': 'Current custom value',
    '型号核验提醒': 'Model check alerts', '新请求的返回型号和请求的对不上、或者响应格式不像官方时，发一条系统通知，点开直接跳到请求记录。': 'Notify when a new request returns a different model than requested, or its response doesn’t look official. Clicking it opens Requests.',
    '发现就提醒': 'Notify me', '只在请求记录页和侧栏红点里显示': 'Only show it on the Requests page and the sidebar badge',
    '每家可以登记多个账号，额度按「当前使用」的那个查询。点「添加账号」会用你的默认浏览器打开官方授权页，已登录的浏览器账号可以直接确认。': 'Register several accounts per provider; quota is checked for the one in use. "Add account" opens the official sign-in page in your default browser.',
    'CLI 自己的登录只读取不复制，也不会被续期；在这里添加的账号，凭据（含续期用的 refresh token）保存在本机 official-accounts.json，仅用于查询额度，不会上传，并在过期前自动续期。': 'The CLI’s own login is read, never copied or renewed. Accounts added here keep their credentials (including the refresh token) in the local official-accounts.json, are used only to query quota, are never uploaded, and renew before they expire.',
    '添加账号': 'Add account', '当前使用': 'In use', '使用': 'Use', '在过期前自动续期，不用重新登录': 'Renewed before expiry — no need to sign in again', '还没有登录的账号': 'No signed-in accounts yet',
    '安装官方 CLI 后即可添加账号': 'Install the official CLI to add accounts', '未检测到官方 CLI': 'Official CLI not found', '正在读取账号状态…': 'Loading accounts…', '账号状态读取失败，请重新打开设置。': 'Could not load accounts. Please reopen Settings.',
    '已在浏览器打开授权页面，完成后会自动返回…': 'The sign-in page is open in your browser; this updates once you finish…', '正在切换活动账号…': 'Switching account…',
    '登录成功，已切换到新账号并刷新额度': 'Signed in, switched to the new account and refreshed quota', '已切换活动账号，额度已刷新': 'Switched account and refreshed quota', '账号操作失败，请重试': 'Account action failed, please try again',
    'OAuth 登录失败': 'OAuth sign-in failed', 'Claude 账号': 'Claude account', 'ChatGPT 账号': 'ChatGPT account', 'Grok 账号': 'Grok account', '找不到这个官方账号': 'Account not found',
    'OAuth 登录等待超时，请回到浏览器完成授权后再试一次。': 'Sign-in timed out. Finish authorizing in the browser and try again.', '没有检测到 OAuth 登录成功，请完成浏览器授权后再试一次。': 'Sign-in wasn’t detected. Finish authorizing in the browser and try again.',
    '数据位置': 'Data location', '用量账本、额度采样历史和设置都只保存在本机': 'The usage ledger, quota history and settings are stored only on this computer in',
    '，不会上传。删掉用量账本会从头重扫、不丢数据；额度采样历史官方不提供，删了就找不回来。': ', never uploaded. Deleting the usage ledger just triggers a rescan; quota history can’t be recovered once deleted.',
    '打开数据目录': 'Open data folder', '无法打开数据目录': 'Can’t open the data folder', '无法打开数据目录：': 'Can’t open the data folder: ',
    '从 CC Switch 导入': 'Import from CC Switch', '只读 CC Switch 的本地库，补上 TokenPulse 自己没有的那部分：CLI 已经清掉的老会话、OpenCode 这类不扫描的工具。同一天同一个工具两边都有时只算 TokenPulse 自己的，不会重复。走 CC Switch 代理的请求还会用它记下的上游返回型号来核验。': 'Reads CC Switch’s local database (read-only) to fill in what TokenPulse doesn’t have: old sessions the CLIs already deleted, and tools like OpenCode it doesn’t scan. When both have the same tool on the same day, only TokenPulse’s own data counts. Requests through the CC Switch proxy are also checked against the model it saw in the upstream response.',
    '自动导入': 'Import automatically', '默认。检测到 CC Switch 就补上缺的记录': 'Default. Fill in missing records when CC Switch is found', '不导入': 'Don’t import', '只统计 TokenPulse 自己扫描到的': 'Only count what TokenPulse scans itself',
    '已关闭导入': 'Import is off', '统计里只有 TokenPulse 自己扫描到的记录': 'Stats include only what TokenPulse scans itself', '没有找到 CC Switch': 'CC Switch not found', '读取 CC Switch 失败': 'Could not read CC Switch',
    '没有需要补的记录': 'Nothing to fill in', '立即同步': 'Sync now', '同步失败，请重试': 'Sync failed, please try again',
    '本机用量': 'Local usage', '输入、输出与缓存': 'Input, output and cache', '额度与预测': 'Quota and forecasts', '费用与导出': 'Cost and export',
    '读取 Claude Code、Codex CLI、Grok Build 的会话记录，并按天补上 CC Switch 里有、本机会话已经没有的记录。时间范围按本地自然日（含今天）计算，对比紧邻的上一段等长时间；今天尚未结束。': 'Reads Claude Code, Codex CLI and Grok Build session logs, and fills in by day what CC Switch still has but local sessions no longer do. Ranges are local calendar days (including today) compared with the preceding period of equal length; today is still in progress.',
    '总 Tokens = 输入 + 输出。缓存读取和缓存写入已包含在输入中，推理 Tokens 已包含在输出中，不能再次累加。缓存读取占比 = 缓存读取 / 全部输入。': 'Total tokens = input + output. Cache reads and writes are already included in input, and reasoning tokens in output — don’t add them again. Cache read share = cache read / total input.',
    '官方账号额度独立采样。达到上限的时间以最近采样趋势估计，并限制单次跳点的影响；近期没有新增用量时不会虚构耗尽时间。预测只是使用节奏的参考，超过 15 分钟的采样标为过期，重置后需等待新采样确认。': 'Official quota is sampled on its own. The time to limit follows the recent trend, damped against single jumps; with no recent usage no depletion time is invented. Forecasts are a guide only; samples older than 15 minutes are marked stale, and a reset waits for a new sample.',
    '优先使用日志自报费用，其余按项目内单价表估算。未知模型不会被当作免费。CSV 导出当前时间、工具和搜索筛选下的全部匹配明细，不受分页限制。': 'Self-reported costs from logs are used first; the rest are estimated from the price table. Unknown models are never treated as free. CSV export includes every match for the current range, tool and search, regardless of pages.',
    '软件更新': 'Software update', '开启自动更新后，TokenPulse 会在后台检查并下载新版本，等窗口收进托盘或最小化时静默安装并自动重启，全程不用你动手。': 'With auto-update on, TokenPulse checks and downloads new versions in the background, then installs silently and restarts when the window is in the tray or minimized — no action needed.',
    '自动更新': 'Auto-update', '自动更新（推荐）': 'Auto-update (recommended)', '后台下载，窗口收起时静默安装并重启': 'Download in the background, install silently when the window is hidden',
    '只提醒': 'Notify only', '发现新版本时在这里提示，由你决定何时安装': 'Show new versions here and let you decide when to install',
    '会在后台定期检查新版本': 'Checks for new versions in the background', '自动更新已关闭，可以手动检查': 'Auto-update is off; you can check manually', '正在检查更新…': 'Checking for updates…', '连接 GitHub 发布页': 'Contacting GitHub Releases',
    '自动更新已关闭，点「下载更新」获取': 'Auto-update is off — click "Download update"', '窗口收进托盘或最小化后会自动安装并重启，也可以现在就更新': 'Installs and restarts once the window is in the tray or minimized — or update now',
    '点「立即重启并更新」完成安装': 'Click "Restart and update" to finish', '检查更新失败': 'Update check failed', '稍后会自动重试': 'Will retry automatically',
    '前往 GitHub 下载': 'Download from GitHub', '立即重启并更新': 'Restart and update', '下载更新': 'Download update', '检查更新': 'Check for updates', '重试': 'Retry', '下载进度': 'Download progress',
    '开发模式不检查更新': 'Updates aren’t checked in dev mode', '便携版不支持自动更新，请到 GitHub 下载新版本': 'The portable build can’t auto-update; download new versions from GitHub',
    '免安装版不支持自动更新，请到 GitHub 下载新版本': 'The unpacked build can’t auto-update; download new versions from GitHub', '发布页上还没有可用的更新信息': 'No update information on the releases page yet',
    '网络不通，稍后会自动重试': 'Network unavailable, will retry automatically', 'GitHub 访问太频繁，稍后会自动重试': 'GitHub rate limit reached, will retry automatically', '检查更新失败，稍后会自动重试': 'Update check failed, will retry automatically',
    '模型知识库': 'Model knowledge base', '各个型号的单价和「哪些名字是同一个型号」的规则。新型号出来后，这里更新一下就能认出来、算出费用，不用等新版本。每天会自动检查一次。': 'Per-model prices and rules for which names refer to the same model. When new models appear, updating it here recognizes and prices them without waiting for a new release. Checked automatically once a day.',
    '已从 GitHub 更新': 'Updated from GitHub', '随安装包内置': 'Bundled with the app', '检查知识库失败，请重试': 'Knowledge base check failed, please try again',
    'GitHub 上还没有更新的知识库': 'No newer knowledge base on GitHub yet', 'GitHub 暂时不可用，稍后再试': 'GitHub is unavailable, try again later', '检查知识库失败，稍后再试': 'Knowledge base check failed, try again later',
    '知识库格式不对，已忽略': 'The knowledge base format is invalid and was ignored', '网络不通，稍后再试': 'Network unavailable, try again later', '连接 GitHub 超时，稍后再试': 'GitHub timed out, try again later', '知识库文件太大': 'Knowledge base file too large',
    '开源与反馈': 'Open source & feedback', 'Your AI usage, at a glance. 常驻托盘，记录本机 AI CLI 的用量，盯住官方订阅额度。': 'Your AI usage, at a glance. Lives in the tray, records local AI CLI usage and keeps an eye on official subscription quota.',
    '实心点可信，空心点已用不到 5%、偏差较大。': 'Solid dots are reliable; hollow dots had under 5% used and may be off.',
    '按本机用量倒推，多设备使用时会偏低。': 'Back-calculated from local usage, so it runs low with multiple devices.',
    '。': '.', '未知模型': 'Unknown model',
    // 一天 / 数字显示
    '一天': '24 hours', '过去 24 小时': 'Past 24 hours', '按小时 · 过去 24 小时': 'Hourly · past 24 hours', '每小时平均': 'Hourly avg', '活跃小时': 'Active hours',
    '每小时平均请求': 'Requests per hour', '用量最高的一小时': 'Busiest hour', '过去 24 小时，按小时统计，对比再往前的 24 小时。': 'Past 24 hours, by hour, compared with the 24 hours before.',
    '过去 24 小时的数据读取失败，请重试。': 'Could not load the past 24 hours. Please try again.',
    '数字显示': 'Numbers', '精确到个位': 'Exact', '默认。例如 3,031,245,120': 'Default. e.g. 3,031,245,120', '简写': 'Compact', '例如 3.03B、240.3M': 'e.g. 3.03B, 240.3M',
    'Token 和请求数怎么显示。中文界面会在数字后面再加一个小字，例如「≈30.3亿」，方便按中文习惯读。图表坐标轴始终用简写。': 'How token and request counts are shown. Chart axes always use the compact form.',
    // 用量明细（合并了请求记录）
    '每一笔用量，每一次请求': 'Every token, every request',
    '逐条看每一次请求用了多少 Token、占了多少额度、是哪个账号发的、型号对不对；也能按日汇总看整体。': 'See what each request cost in tokens and quota, which account sent it and whether the model checks out — or switch to daily totals.',
    '每一行是一次 API 请求：用了多少 Token、占了多少额度、谁发的、型号对不对。点开看详情': 'Each row is one API request: tokens, quota share, sending account and model check. Expand a row for details',
    '逐条请求': 'Per request', '按日汇总': 'Daily totals', '明细视图': 'Detail view', '按核验结论筛选': 'Filter by check result', '说明': 'Notes',
    '项目 / 账号': 'Project / Account', '额度占用': 'Quota share', '额度占用（估算）': 'Quota share (estimate)', '账号未知': 'Unknown account',
    '搜索型号、项目、账号、会话或响应 ID…': 'Search model, project, account, session or response ID…',
    '走中转 / 没对上账号，或者这个窗口还折算不出整窗容量': 'Via a relay / no matching account, or this window\u2019s capacity can\u2019t be estimated yet',
    '≈ 这次请求的 Token ÷ 窗口整窗容量（按本机用量倒推的估算）': '≈ this request\u2019s tokens ÷ the window\u2019s estimated capacity (back-calculated from local usage)',
    '窗口已用不到 5%，偏差较大': 'Under 5% of the window used, so this may be off',
    '这次请求的 Token ÷ 它所在额度窗口折算出的整窗容量，是估算；只算走官方账号、而且窗口能折算出容量的请求。': 'This request\u2019s tokens ÷ the estimated capacity of its quota window. An estimate, only for official-account requests in windows whose capacity can be estimated.',
    // 账号
    '账号': 'Account', '全部账号': 'All accounts', '账号依据': 'Account basis', '会话记录': 'Session record', '登录时间线': 'Login timeline', '推断': 'Inferred', '对不上': 'Unmatched',
    '会话文件里直接记下了这个账号': 'The session file records this account directly', '按请求时间，对上当时 CLI 登录的账号': 'Matched by time to the account the CLI was signed in to',
    'TokenPulse 开始记录登录之前的请求，按最早记下的账号推断': 'Made before TokenPulse started tracking logins; inferred from the earliest known account',
    '没对上账号（中转 / API Key 等）': 'No account (relay / API key, etc.)', '这个账号的请求': 'Requests from this account',
    '本机 CLI 用这个账号发出的请求。额度按 TokenPulse 里「当前使用」的账号查询，请求按 CLI 当时登录的账号归属。': 'Requests the local CLI sent with this account. Quota is checked for the account in use in TokenPulse; requests belong to whichever account the CLI was signed in to at the time.',
    '在请求记录里查看全部': 'See all in Requests', '正在读取这个账号的请求…': 'Loading this account\u2019s requests…', '当前 5 小时窗口': 'Current 5-hour window', '当前周窗口': 'Current weekly window',
    '型号核验': 'Model check', '次异常': 'issues', '本周窗口': 'This week\u2019s window', '当前周窗口里还没有从本机发出、归到这个账号的请求。': 'No requests from this computer belong to this account in the current weekly window yet.',
    '每一行是一次 API 请求，点开查看响应 ID、发出的账号和核验依据': 'Each row is one API request — expand it to see response IDs, the sending account and the evidence', '未选择': 'Not selected', '时间未知': 'Time unknown',
    // 主进程：托盘菜单、通知、对话框
    '打开 TokenPulse': 'Open TokenPulse', '立即刷新': 'Refresh now', '退出': 'Quit', '导出请求记录': 'Export requests', '导出用量明细': 'Export usage', '注意节奏': 'Pace yourself',
    '导出内容无效或过大': 'Export content is invalid or too large', '查询日期无效': 'Invalid query dates', '官方账号参数无效': 'Invalid account parameters', '官方账号类型无效': 'Invalid account type'
  };

  /* ---------------- 带变量的句子 ---------------- */
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const N = '([\\d,.]+[KMB]?)';
  const P = (source, render) => [new RegExp('^' + source + '$', 's'), render];
  // 变量里也可能有中文（「5 小时」「接口未提供」），递归翻一下
  const v = text => translate(text);
  const PATTERNS = [
    P('(\\d+) 分钟', m => `${m[1]} min`),
    P('(\\d+) 小时 (\\d+) 分', m => `${m[1]} h ${m[2]} min`),
    P('(\\d+) 天 (\\d+) 小时', m => `${m[1]} d ${m[2]} h`),
    P('(\\d{4}) 年 (\\d{1,2}) 月', m => `${MONTHS[Number(m[2]) - 1]} ${m[1]}`),
    P('(\\d{4}) 年 · 本地时间', m => `${m[1]} · local time`),
    P('(.+?) ?后重置', m => `Resets in ${v(m[1])}`),
    P('约 (.+?) ?后达到上限', m => `Limit in about ${v(m[1])}`),
    P('约 (.+?) ?后', m => `in about ${v(m[1])}`),
    P('(.+?)后', m => `in ${v(m[1])}`),
    P('按最近趋势，预计约 (.+?) 后达到上限', m => `At the recent pace, the limit is reached in about ${v(m[1])}`),
    P('按最近趋势，重置时预计使用 (.+)', m => `At the recent pace, about ${m[1]} will be used by the reset`),
    P('重置时预计使用 (.+)', m => `${m[1]} projected at reset`),
    P('按整窗容量折算：剩余约 (.+) Tokens', m => `By window capacity: about ${m[1]} tokens left`),
    P('· 剩约 (.+)', m => `· about ${m[1]} left`),
    P('剩约 (.+)', m => `about ${m[1]} left`),
    P('已用 (\\d+)% 时提醒', m => `Alert at ${m[1]}% used`),
    P('已用 (.+)', m => `Used ${m[1]}`),
    P('上次(.+)剩余', m => `${v(m[1])} remaining (last sample)`),
    P('(.+)剩余', m => `${v(m[1])} remaining`),
    P('(.+) 已更新', m => `Updated ${m[1]}`),
    P('(.+) 更新', m => `Updated ${m[1]}`),
    P('(.+) 同步', m => `Synced ${m[1]}`),
    P('(.+) 检查过，已更新到最新', m => `Checked ${m[1]}, now up to date`),
    P('(.+) 检查过，已是最新', m => `Checked ${m[1]}, already up to date`),
    P('上次检查 (.+)', m => `Last checked ${m[1]}`),
    P('(.+) · 本地时间', m => `${m[1]} · local time`),
    P(N + ' 个采样点', m => `${m[1]} samples`),
    P('(\\d+) / (\\d+) 天', m => `${m[1]} / ${m[2]} days`),
    P('(\\d+)% · 在后台进行，可以继续使用', m => `${m[1]}% · downloading in the background`),
    P('(.+) 额度详情', m => `${m[1]} quota details`),
    P('(.+) 本地凭据', m => `${m[1]} local credentials`),
    P('(\\d+) 个本机没有用量（可能用在别的设备上）', m => `${m[1]} with no local usage (maybe used on another device)`),
    P('(\\d+) 个已用不到 2%', m => `${m[1]} under 2% used`),
    P(N + ' 次请求未定价', m => `${m[1]} requests unpriced`),
    P(N + ' 条定价规则', m => `${m[1]} price rules`),
    P(N + ' 条型号等价规则', m => `${m[1]} model alias rules`),
    P(N + ' 条', m => `${m[1]} rows`),
    P(N + ' 次（Grok 按轮记录）', m => `${m[1]} (Grok records per turn)`),
    P(N + ' 个官方会话', m => `${m[1]} official sessions`),
    P(N + ' 个中转 / API Key 会话未计入额度', m => `${m[1]} relay / API key sessions not counted toward quota`),
    P(N + ' 个会话文件', m => `${m[1]} session files`),
    P(N + ' 次历史请求', m => `${m[1]} requests in total`),
    P('本机时区', () => 'local time zone'),
    P(N + ' 个「天 × 工具」来自 CC Switch，' + N + ' 个本机已有、跳过', m => `${m[1]} day × tool slots from CC Switch, ${m[2]} skipped because TokenPulse already has them`),
    P(N + ' 次代理请求用于型号核验', m => `${m[1]} proxied requests used for model checks`),
    P('已补入 ' + N + ' 次请求', m => `Filled in ${m[1]} requests`),
    P('已导出 ' + N + ' 条明细。', m => `Exported ${m[1]} rows.`),
    P('已导出 ' + N + ' 次请求。', m => `Exported ${m[1]} requests.`),
    P(N + ' 次请求', m => `${m[1]} requests`),
    P(N + ' 次', m => `${m[1]} times`),
    P('(.+) 缓存读取 / (.+) 输入', m => `${m[1]} cache read / ${m[2]} input`),
    P('按(.)汇总 · 本机时间', m => `By ${{ 天: 'day', 周: 'week', 月: 'month' }[m[1]] || m[1]} · local time`),
    P('已是最新版本 (.+)', m => `Up to date: ${m[1]}`),
    P('当前版本 (.+)', m => `Current version ${m[1]}`),
    P('发现新版本 (.+)', m => `New version ${m[1]} available`),
    P('新版本 (.+) 已下载', m => `Version ${m[1]} downloaded`),
    P('正在下载 (.+)', m => `Downloading ${m[1]}`),
    P('知识库 v(.+)', m => `Knowledge base v${m[1]}`),
    P('占可核验请求的 (.+)%', m => `${m[1]}% of verifiable requests`),
    P('手动重置次数：([^·]+)', m => `Manual resets: ${v(m[1])}`),
    P('活跃时间占比：([^·]+)', m => `Active time: ${v(m[1])}`),
    P('最后一次成功查询是 (.+)，已超过 15 分钟（可能是网络不通或凭据过期）。以下是历史记录，当前剩余额度需刷新确认。', m => `The last successful check was ${m[1]}, over 15 minutes ago (network down or credentials expired?). Below is history; refresh to confirm the current quota.`),
    P('最近 7 天有 (\\d+) 次请求型号不一致或响应存疑', m => `${m[1]} requests in the last 7 days had a model mismatch or suspicious response`),
    P('本机没有 (.+)，装了 CC Switch 之后会自动导入', m => `${m[1]} isn’t on this computer; it will be imported once CC Switch is installed`),
    P('确认 (.+) 已登录官方账号，然后点击「刷新数据」。', m => `Make sure ${m[1]} is signed in to an official account, then click "Refresh".`),
    P('第 (\\d+) / (\\d+) 页', m => `Page ${m[1]} of ${m[2]}`),
    P('共 ' + N + ' 次请求', m => `${m[1]} requests`),
    P('共 ' + N + ' 条匹配明细', m => `${m[1]} matching rows`),
    P('请求的是 (.+)，上游返回的是 (.+)', m => `Requested ${m[1]}, but the upstream returned ${m[2]}`),
    P('请求的是 (.+)', m => `Requested ${m[1]}`),
    P('请求 (.+)', m => `Requested ${m[1]}`),
    P('返回型号是 (.+)，但响应 ID 是 (.+)（(.+)），不是 Anthropic 的 msg_ \\+ 24 位', m => `The returned model is ${m[1]}, but the response ID is ${v(m[2])} (${v(m[3])}), not Anthropic’s msg_ + 24 characters`),
    P('响应 ID 是 (.+)（(.+)），不是 OpenAI 的 resp_ \\+ 十六进制', m => `The response ID is ${v(m[1])} (${v(m[2])}), not OpenAI’s resp_ + hex`),
    P('(.*)…，共 (\\d+) 位', m => `${m[1]}…, ${m[2]} characters`),
    P('会话文件记的返回型号是 (.+)，CC Switch 代理从上游响应里读到的是 (.+)', m => `The session file says ${m[1]} was returned, but the CC Switch proxy saw ${m[2]} in the upstream response`),
    P('经 (.+) 转发，属于官方云渠道', m => `Forwarded via ${m[1]}, an official cloud channel`),
    P('(.+) 是 (.+) 在 Grok Build 里的官方变体', m => `${m[1]} is the official Grok Build variant of ${m[2]}`),
    P('这次请求接的是第三方模型（响应是 (.+)），不是 Anthropic', m => `This request used a third-party model (response is ${v(m[1])}), not Anthropic`),
    P('(.+)（进行中）', m => `${m[1]} (in progress)`),
    P('最后一次采样已用 (.+)', m => `Used ${m[1]} at the last sample`),
    P('本机用量 (.+) Tokens', m => `Local usage ${m[1]} tokens`),
    P('折算整窗约 (.+) Tokens', m => `Window capacity about ${m[1]} tokens`),
    P('已结束且较可信的窗口中位数约 (.+)（虚线）。', m => `Median of finished, reliable windows: about ${m[1]} (dashed).`),
    P('(.+)（(' + N.slice(1, -1) + ') 次）', m => `${m[1]} (${m[2]} requests)`),
    P('(\\d+) 个型号还没有定价：(.+?)( 等)?。更新知识库后会自动重算。', m => `${m[1]} models have no price yet: ${m[2].split('、').map(v).join(', ')}${m[3] ? ', and more' : ''}. Costs are recalculated after the knowledge base updates.`),
    P('TokenPulse · 今日 (.+) tokens', m => `TokenPulse · today ${m[1]} tokens`),
    P('周 (\\d+)%', m => `Week ${m[1]}%`),
    P('还有 (\\d+) 个', m => `${m[1]} more`),
    P('(\\d+) 个额度窗口已过提醒线', m => `${m[1]} quota windows crossed the alert line`),
    P('这一家共 ' + N + ' 个官方会话，用量已按账号分开', m => `${m[1]} official sessions for this provider; usage is split by account`),
    P('(.+) (5 小时|周)额度已用 (\\d+)%', m => `${m[1]} ${m[2] === '周' ? 'weekly' : '5-hour'} quota at ${m[3]}%`),
    P('(.+) 重置', m => `Resets ${m[1]}`),
    P('(\\d+) 次请求的返回型号和请求的不一致', m => `${m[1]} requests returned a different model than requested`),
    P('(\\d+) 次请求的响应存疑', m => `${m[1]} requests had a suspicious response`),
    P('([A-Za-z][\\w .-]*)：(.+)', m => `${m[1]}: ${v(m[2])}`),
    P(N + ' 次无法核验', m => `${m[1]} unverifiable`),
    P(N + ' 次一致', m => `${m[1]} matched`),
    P('过去 24 小时 · (.+) 起', m => `Past 24 hours · since ${m[1]}`),
    P('(\\d+) / (\\d+) 小时', m => `${m[1]} / ${m[2]} hours`),
    P('≈ 5 小时 (.+)', m => `≈ 5h ${m[1]}`),
    P('≈ 周 (.+)', m => `≈ week ${m[1]}`),
    P('5 小时 ([<\\d.]+%)', m => `5h ${m[1]}`),
    P('周 ([<\\d.]+%)', m => `Week ${m[1]}`),
    P('其中 ' + N + ' 次是 TokenPulse 开始记录登录之前的请求，按最早记下的账号推断。', m => `${m[1]} of them were made before TokenPulse started tracking logins and are inferred from the earliest known account.`),
    P('本周 (.+) 各账号', m => `${m[1]} accounts this week`),
    P('(.+) 账号', m => `${m[1]} account`),
    P('未计入 (\\d+) 个窗口：([^。]+)。', m => `${m[1]} windows left out: ${v(m[2])}.`),
    // 账号名是用户的内容，不翻
    P('调整顺序：(.+)（按住拖动，或用上下方向键）', m => `Reorder ${m[1]} (drag, or use the Up / Down arrow keys)`),
    // 会话管理：项目名、工具名是用户的内容，不递归翻译
    P('昨天 (\\d{1,2}:\\d{2})', m => `Yesterday ${m[1]}`),
    P('全部项目（' + N + '）', m => `All projects (${m[1]})`),
    P('(.+) · ' + N + ' 个会话', m => `${v(m[1])} · ${m[2]} sessions`),
    P(N + ' 轮', m => `${m[1]} ${m[1] === '1' ? 'turn' : 'turns'}`),
    P(N + ' 轮对话', m => `${m[1]} ${m[1] === '1' ? 'turn' : 'turns'}`),
    P(N + ' 次工具调用', m => `${m[1]} tool ${m[1] === '1' ? 'call' : 'calls'}`),
    P('调用了 ' + N + ' 次工具', m => `${m[1]} tool ${m[1] === '1' ? 'call' : 'calls'}`),
    P('显示更早的 ' + N + ' 段', m => `Show ${m[1]} earlier`),
    P('会话太长，最早的 ' + N + ' 条没有载入', m => `Session too long; the earliest ${m[1]} messages were not loaded`),
    P('回复 (\\S+)…（Enter 发送，Shift \\+ Enter 换行）', m => `Reply to ${m[1]}… (Enter to send, Shift + Enter for a new line)`),
    P('在 (.+) 里继续这段会话', m => `Continue this session in ${m[1]}`),
    P('会用掉对应账号的订阅额度', () => "uses the account's subscription quota"),
    P('(\\S+) 正在回复…', m => `${m[1]} is replying…`),
    P('正在调用：(.+)', m => `Running: ${m[1]}`),
    P('（共 ' + N + ' 次）', m => `(${m[1]} total)`),
    P('回复失败：([\\s\\S]+)', m => `Reply failed: ${v(m[1])}`),
    P('没找到 (.+)，请先安装官方 CLI', m => `${m[1]} not found. Install the official CLI first`),
    P('启动 CLI 失败：([\\s\\S]+)', m => `Could not start the CLI: ${m[1]}`),
    P('CLI 退出码 (-?\\d+)', m => `CLI exited with code ${m[1]}`),
    P('命令 ([\\s\\S]+)', m => `Command ${m[1]}`),
    P('自定义', () => 'Custom'),
    // 「标题：值」（设置项的 aria-label 等），两边都翻；放最后，别抢了上面更具体的句子
    P('([^：。·\\n]{1,20})：([^。·\\n]+)', m => `${v(m[1])}: ${v(m[2])}`)
  ];

  /** 一段文字可能由几段拼起来（「… · …」「…；…」「A → B」、多行提示）：整句查不到时拆开逐段翻。 */
  const SEPARATORS = ['\n', ' · ', '；', ' → ', '，'];
  function translate(text) {
    if (!text || !HAN.test(text)) return text;
    const lead = text.match(/^\s*/)[0], tail = text.match(/\s*$/)[0];
    const core = text.trim();
    const done = value => lead + value + tail;
    if (Object.prototype.hasOwnProperty.call(EN, core)) return done(EN[core]);
    // 分号、换行是硬分隔，先拆：不然「(.+) 同步」这种宽模板会把整段吞掉
    for (const sep of ['\n', '；']) {
      if (core.includes(sep)) return done(core.split(sep).map(part => translate(part)).join(sep === '；' ? '; ' : sep));
    }
    for (const [re, render] of PATTERNS) {
      const m = core.match(re);
      if (m) return done(render(m));
    }
    // 几句话拼成的一段：按句号拆开逐句翻（句子本身常在词典里，带着句号）
    const sentences = core.match(/[^。]+。|[^。]+$/g);
    if (sentences && sentences.length > 1) return done(sentences.map(part => translate(part).trim()).join(' '));
    for (const sep of SEPARATORS) {
      if (!core.includes(sep)) continue;
      const joiner = sep === '；' ? '; ' : sep === '，' ? ', ' : sep;
      return done(core.split(sep).map(part => translate(part)).join(joiner));
    }
    return text;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label'];
  // 标了 translate="no" 的是用户自己的内容（会话标题、对话正文、工具输出、项目名）：原样显示。
  // 不跳过的话，「……做好后」会被「(.+?)后」吃成「in ……」，中文逗号也会被换成英文的。
  const KEEP = '[translate="no"]';
  const kept = node => Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest?.(KEEP));
  function translateElement(node) {
    if (kept(node)) return;
    for (const name of ATTRS) {
      const value = node.getAttribute?.(name);
      if (!value || !HAN.test(value)) continue;
      const next = translate(value);
      if (next !== value) node.setAttribute(name, next);
    }
  }
  /** 只在真的变了时才写回：原样写回也会触发 characterData，没翻完的句子会在观察器里无限循环。 */
  function translateText(node) {
    if (!HAN.test(node.nodeValue) || kept(node)) return;
    const next = translate(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  function translateTree(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) {
      translateText(rootNode);
      return;
    }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) {
      if (rootNode.tagName === 'SCRIPT' || rootNode.tagName === 'STYLE' || kept(rootNode)) return;
      translateElement(rootNode);
    }
    // 碰到 translate="no" 整棵子树跳过（长对话几千个文本节点，不必逐个判断）
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: node => (node.nodeType === 1 && node.getAttribute('translate') === 'no' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) translateText(node);
      else translateElement(node);
    }
  }

  function start() {
    if (resolved !== 'en') return;
    document.documentElement.lang = 'en';
    document.title = translate(document.title);
    translateTree(document.body);
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') translateTree(record.target);
        else if (record.type === 'attributes') translateElement(record.target);
        else for (const node of record.addedNodes) translateTree(node);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  const api = {
    lang: () => resolved,
    mode: () => mode,
    t: translate,
    /** 切语言：存起来、告诉主进程、重新加载。 */
    setMode(next) {
      try { localStorage.setItem(KEY, next); } catch { /* 存不下就只对这一次生效 */ }
      window.location.reload();
    }
  };
  root.PulseI18n = api;
  if (typeof module !== 'undefined') module.exports = { translate, EN, PATTERNS };
  else if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})(typeof window !== 'undefined' ? window : globalThis);
