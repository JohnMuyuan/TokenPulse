/*
 * 版本更新说明 + 新手引导（0.3.9 起）。
 *
 * - 全新安装：主进程在第一次写 prefs.json 时记下 onboarding = 'pending'，这里启动后自动走一遍引导。
 * - 升级：prefs.seenVersion 比当前版本旧、且 NOTES 里有这一版的说明，就弹一次「新版本有什么」；关掉后记下版本，以后不再弹。
 *   没写说明的版本静默记下，不弹空窗口。
 * - 设置 → 关于 里可以随时重新打开这两样。
 *
 * 引导只高亮已有的界面（导航、额度卡片、刷新、设置），不在引导里造假数据；每一步都能「跳过引导」，Esc 同样是跳过。
 */
(function () {
  const api = window.tokenpulse;
  const $ = id => document.getElementById(id);

  /* 每个版本的新内容：只写用户看得见、用得上的变化，一条一句话。以后发版在这里加一项。 */
  const NOTES = {
    '0.3.23': [
      ['check', '修复：只试过一两次的型号，「整窗能用多少」算得偏少', '「换一种模型，整窗能用多少」里，只用过一两次的型号会按那一两次的实际花费定价。新会话的头几句大多是缓存写入，单价偏高，结果便宜的型号反而显得能用的更少（比如 Sonnet 5.5 比 Fable 5.1 还少）。现在记录不够多的型号按价格表和你平时的用量结构来算，「能调用多少次」也一样。'],
    ],
    '0.3.22': [
      ['check', '修复：Prism 桥隔半天再启动就报 401', '登录约 12 小时后再启动服务，会报「list Prism projects HTTP 401 Request verification failed」，要重新登录才能用。现在登录一次，10 天内都能直接启动。'],
      ['info', '标出这是预览版', '1.0 之前都是预览版，功能在快速增加和调整，所以更新比较频繁。侧栏底部和「设置 → 关于」里现在有「预览版」标签。'],
    ],
    '0.3.21': [
      ['trend', '占用的内存少了约两成', '界面的绘制方式调整后，空闲时全部进程合计的内存从约 516 MB 降到约 405 MB（同一台电脑、同样的操作实测），动画照旧。窗口收进托盘或最小化时，后台不再重画界面，用量扫描从每分钟一次放慢到每 3 分钟一次；再打开窗口时马上补上最新的数据。'],
      ['info', 'Prism 桥页面多了「常见问题」', '用的是哪里的额度（不扣 Codex 的额度）、为什么在 TokenPulse 里看不到这部分用量、最大上下文、思考强度有哪几档，都写在 Prism 桥页面的「常见问题」里，点开就能看。'],
      ['check', '修复：Codex 对话删不掉', '会话管理里删除 Codex 对话时报「cannot confirm session deletion without an interactive terminal」。新版 Codex 删除前要在终端里再确认一次，TokenPulse 里没有终端；现在按它的要求带上参数，删除前仍然由 TokenPulse 弹窗问你。'],
      ['terminal', '修复：只装了 Codex 桌面端时找不到 CLI', '没有用 npm 装 codex、只装了 Codex 桌面端的电脑上，删除对话、新对话、在终端里继续会提示找不到 CLI。现在会用桌面端自带的那一份。'],
      ['alert', '修复：出错时叠着两张报错卡，其中一张关不掉', '出错时现在只在右上角出一张提示，可以点 × 关掉，过几秒也会自己消失。'],
    ],
    '0.3.20': [
      ['alert', 'Prism 桥：Codex 报 502 时直接告诉你原因', '系统里设了代理、又没有把本机地址排除在外时，Codex 发给 Prism 桥的请求会被代理截走：Codex 报 502 Bad Gateway，Prism 桥的日志里却什么都没有。现在服务启动后会实际检查一次，有这个问题就在页面顶部提醒，并给一个「一键修复」。'],
      ['folder', 'Prism 桥的日志会存成文件', '日志除了显示在页面上，现在也写进文件，点「打开日志文件」就能找到，方便发给别人帮忙排查。'],
      ['restore', '不想用了，可以一键删除', 'Prism 桥页面最下面的「全部删除」：停掉服务，删掉运行环境、下载的 Chromium、登录信息、设置和日志，并去掉 Codex 里的那家供应商（Codex 正在用的话先切回官方登录）。页面上会写现在占了多少空间。'],
    ],
    '0.3.19': [
      ['globe', 'Prism 桥：账号被降智时，换一条路用回完整的模型', '适合 ChatGPT 账号被「降智」的情况（官方登录下模型明显变笨，或被悄悄换成低一档的型号）；账号正常就没必要用。供应商 → 本地路由 → Prism 桥，按页面上的四步走（安装运行环境、登录、启动服务、接到 Codex），Codex 就经你自己的 Prism 账号发请求。这不是官方提供的用法，可能不符合 OpenAI 的服务条款，页面上写了风险和限制，请先看再决定。程序来自开源项目 Prism Bridge（作者 yyyllllming）。'],
    ],
    '0.3.18': [
      ['user', '添加账号：可以只用本机 CLI 已登录的那个', '设置 → 官方账号的「添加账号」现在有两种：「用本机 CLI 已登录的账号」不在 TokenPulse 里保存凭据，每次读取 CLI 自己的登录来查额度、统计用量；「登录一个新账号」和以前一样，由 TokenPulse 保存凭据并自动续期。'],
      ['check', '修复：官方登录时显示「没有识别到当前供应商」', '供应商页面里，工具用的是它自己的官方登录时，现在会正确显示当前供应商是「官方登录」。以前只有在 TokenPulse 里切换过、之后配置没再变过才认得出来。'],
    ],
    '0.3.17': [
      ['route', '修复：号池 / 本地路由转发全是 502', '需要代理才能访问官方接口的电脑上，本地路由转发以前不走代理，号池里每个账号都连接超时、记成 502。现在转发会走代理；连不上时转发记录里也会写明原因。'],
      ['globe', '所有联网请求统一走代理', '软件里往外发的请求现在用同一条规则：环境变量里有代理（HTTPS_PROXY 等）就用它，没有就用系统代理，都没有才直连。以前查额度不认系统代理、自动更新不认环境变量里的代理。'],
    ],
    '0.3.16': [
      ['cost', '单价变化说清楚：调价了，还是只是换了估算依据', '以前只要估算用的单价换过，型号旁就标「单价刚更新」，容易让人以为官方调价了。现在分开：官方真的调价才标「刚降价」或「刚涨价」，点开详情能看到每一项涨了或降了多少；只是从「按型号家族估算」换成这个型号自己的标价的，标「改用实际标价」，并写明官方价格没变。'],
      ['lock', '启动 CLI 前先核对出口', '出口监控开着、并给某一家设了白名单时，凡是 TokenPulse 启动的这一家的 CLI（新对话、在终端里继续、在软件里回复）都会先检测出口：设了 IP 白名单就看 IP，只设了地区白名单就看地区。监控关着，或者两个白名单都没设，就直接启动。终端里的检测就在那个终端窗口里做，测到的就是 CLI 真正用的出口。'],
      ['plus', '会话管理：新对话、新项目', '会话列表上方多了「新对话」和「新项目」：选一个项目文件夹（可以新建）和要用的工具，TokenPulse 在那个文件夹里打开终端启动它。'],
      ['clock', '出口监控的检测间隔可以自己定', '出口监控页上方的「检测间隔」可以填 5 到 60 秒，默认 10 秒。'],
      ['check', '修复：切换分类时页面往上跳', '用量明细切换分类、换筛选、翻周期时，如果新内容比原来短，页面不再突然跳到上面；全部页面统一处理。'],
      ['terminal', '修复：「在终端里继续」打不开', '项目文件夹名里带弯引号（比如 JMY‘s）时，「在终端里继续」会报错、打不开 CLI，现在可以了；带空格的文件夹一直是正常的。'],
    ],
    '0.3.15': [
      ['tokens', 'Tokens 里有多少是新内容', '「换一种模型，整窗能用多少」的 Tokens 里，绝大部分是每次调用重读整段对话的缓存。现在每一格下面多一行小字，写明其中新内容大约多少、多少是重读缓存；点开详情有解释。'],
      ['alert', '修复：切到第三方后 Codex 进不去', '新版 Codex（0.159 起）对模型目录多了几个必填字段，TokenPulse 写出的目录缺这几项，切到第三方后 Codex 桌面端显示「无法加载登录要求」。现在目录补齐了；切回官方后也不再留下会让 Codex 读取失败的空路由表。'],
      ['check', '切换前先让 Codex 试读一遍', '切到第三方或开启本地路由之前，TokenPulse 会让本机的 Codex 在临时目录里试读一遍要写的模型目录。Codex 以后再改格式、读不了时，就不写这份目录并提示你——Codex 照样能进，只是模型列表用它自带的。启动时也会检查一次。'],
      ['restore', '启动时自动修好已经写坏的配置', '更新后第一次启动，TokenPulse 会自动修复旧版本留下的问题（空的路由表、缺字段的模型目录），改动前的内容留在「配置保护」的备份里；只读保护开着时不会写，只提示。Grok 的配置里同样不再留下空表和成串的空行。'],
    ],
    '0.3.14': [
      ['cost', '单价写清楚，点一下看详情', '「换一种模型，整窗能用多少」的单价拆成输入 / 输出 / 缓存读 / 缓存写四项标价，写明来源（LiteLLM 的哪个型号、知识库版本），并列出综合单价是怎么按你的 Token 结构算出来的。悬停不再弹出一大段文字，点一行就在下面展开详情。'],
      ['trend', '时间线放大后曲线显示正常', '「模型与思考等级 · 时间线」放大后曲线下的绿色面积完整显示；放大到最细再左右拖动也不会抽动或看不到线。'],
    ],
    '0.3.13': [
      ['cost', '单价旁边写明为什么会变', '型号旁会标「优惠价」「标价不同」「单价刚更新」，悬停能看到前后单价和来源：两个价格表对不上时按 LiteLLM 算（优惠价更准）；官方优惠有结束日期的，到期自动换回原价。'],
      ['clock', '时间线：每个模型用了多久', '「模型与思考等级 · 时间线」的每条轨道和图例都写明这个周期里用了多久、占整个周期的多少。周期标题旁新增圆圈问号，写着每种颜色、竖条是什么意思。'],
      ['trace', '像剪视频一样整理「本机以外」', '左键拖动平移，按住右键拖选一段；点「本机以外」色块可以分割、删除（不算本机以外）、恢复或标注，软件不再替你切段。'],
    ],
    '0.3.12': [
      ['plus', '自己添加模型到换算表', '「换一种模型，整窗能用多少」右上角的「添加模型」：从模型知识库里挑（比如 Claude Sonnet 5.5、GPT-6.1 Sol），选要列出的思考等级；没用过也能估算整窗大约能用多少。'],
      ['trend', '按思考等级估算 token 消耗', '等级越高推理越多、能调用的次数越少。没用过的等级按你最常用那一档的实际用量推算：优先用你自己的实测，其次参考 Epoch AI 的编程 Agent 基准数据（DeepSWE / CursorBench），标「等级参考」；数据每天随知识库自动更新。'],
    ],
    '0.3.11': [
      ['cost', '模型单价自动更新', '模型知识库每天自动从公开价格表同步（LiteLLM，并用 OpenRouter 交叉核对），新型号、调价不用等新版本；这次一口气补上了 100 个型号的准确单价（如 Claude Opus 5.5、GPT-5.6 各型号、Grok 4.7）。思考等级规则也随知识库在线更新。'],
    ],
    '0.3.10': [
      ['alert', '工具配置被改走时提醒你', 'TokenPulse 切换过的 Claude Code、Claude 桌面端、Codex、Grok CLI，如果配置被别的工具或 CLI 自己改走了（例如 Grok 继续旧会话时换回旧模型），右上角会说明是谁、可能的原因，一键切回；窗口在托盘里时发系统通知。'],
      ['route', 'Grok 号池 / 本地路由更好用', 'Grok 的 /model 列表里，TokenPulse 的路由显示为「TokenPulse · 供应商名」；路由被改走后，点「启用」或「切回」就能重新接上，不用先关掉路由。'],
    ],
    '0.3.9': [
      ['trace', '识别「本机以外」的额度消耗', '额度涨了、同期本机没有 Code 请求的时段（网页聊天、其他设备）会自动识别出来，不计入容量折算。'],
      ['clock', '时间线可以放大、可以标注', '「模型与思考等级 · 时间线」支持拖选放大、Ctrl + 滚轮缩放；本机以外的时段可以补上用了什么模型和思考等级。'],
      ['user', '「只在本机用 Code」开关', '账号只在这台电脑上用 Code、不聊天？在 设置 → 官方账号 里打开，容量直接按本机用量折算。'],
      ['usage', '按项目看用量', '用量明细新增「按项目」视图；Agent 压缩上下文消耗的额度现在也会计入。'],
      ['lock', '改动前确认、自动备份、只读保护', '供应商切换前会先列出每个配置文件的逐行对比（密钥打码），确认后才写；每次改动自动备份、可一键还原，接管前的原件永久保留；还可以打开只读保护，完全不动工具配置。'],
      ['route', '供应商：头像、号池、配置预览、Codex 1M 上下文', '供应商可以选头像；同一家可以组成号池；保存前能预览写进 CLI 的配置；思考等级改成下拉多选；Codex 可以一键放开到 1M 上下文。'],
      ['overview', '新手引导', '第一次用的话可以跟着走一遍；之后在 设置 → 关于 里也能重新打开。'],
    ],
  };

  /*
   * 引导步骤。引导期间界面读的是演示账号（main/demo.ts，临时目录里的虚构数据），所以第一次用、还没登录账号也能看到每个功能长什么样。
   * page：先切到这一页；before：切页后要做的准备（切视图）；target：高亮的元素，异步加载的面板最多等 3 秒；
   * wait：高亮之前再等它里面的某样东西加载出来。等不到或看不见就把卡片放在中间、不高亮。
   */
  // 用量明细默认只看今天，演示看最近 7 天更有内容（回到总览时 app.js 会换回总览自己的范围）
  const usageView = view => {
    if (typeof state === 'undefined') return;
    const changed = state.usageView !== view;
    if (state.days !== 7) window.applyRange?.(7);
    window.showUsageView?.(view);
    if (changed && current) window.render?.(current);
  };
  const STEPS = [
    { title: '欢迎使用 TokenPulse', text: 'TokenPulse 常驻托盘，记录本机 AI CLI（Claude Code、Codex、Grok）的用量，并盯住官方订阅额度。接下来用一个演示账号带你走一遍：演示数据只在引导里出现，不会写进你的数据，结束后自动换回来。' },
    { page: 'overview', target: '#nav', title: '左侧切换页面', text: '总览、额度详情、用量明细、出口监控、会话管理、供应商，都在这里。' },
    { page: 'overview', target: '#quota-cards', title: '官方额度一眼看完', text: '每个官方账号的 5 小时窗口和周窗口：还剩多少、什么时候重置、照现在的节奏大约什么时候用完。' },
    { page: 'overview', target: '#overview-analysis .analysis-grid', title: '用量趋势与使用节奏', text: '按天看 Tokens、费用、请求数的走势，以及一天里哪些时段用得最多。上方可以切换时间范围和工具。' },
    { page: 'overview', target: '#refresh', title: '数据自动更新', text: '后台会定时扫描本机日志、查询官方额度。想马上看最新数字就点「刷新数据」。' },
    { page: 'quota', target: '#page-quota .quota-toolbar', title: '额度详情 · 按账号看', text: '每个官方账号一个标签；同一家登记了多个账号时分开统计，也能组成账号池。' },
    { page: 'quota', target: '#quota-detail .quota-window-grid', title: '5 小时与周窗口', text: '已用百分比、重置时间，以及按最近的使用节奏估算「大约什么时候用完」。' },
    { page: 'quota', target: '#quota-detail .capacity-panel', title: '额度容量趋势', text: '把每个历史窗口折算成「整窗大约能用多少」（Tokens 或 API 等价费用），连成折线。官方悄悄调了额度，这里能看出来。' },
    { page: 'quota', target: '#quota-model-study .ms-budgets', title: '换一种模型，整窗能用多少', text: '先按本机的真实用量折算出整窗预算，再换算到每个模型 × 思考等级：换成 Sonnet 能多用几倍、开 xhigh 要少用多少，一目了然。' },
    { page: 'quota', target: '#quota-model-study .ms-highlights', title: '一眼看结论，再看完整排行', text: '最耐用、调用最多、你最常用的组合放在最前面；下面是全部模型 × 思考等级的完整排行，可以换排序、按等级筛选。' },
    { page: 'quota', target: '#quota-model-timeline .ms-cycle.week .ms-tl', title: '模型与思考等级 · 时间线', text: '每个模型 × 思考等级一条轨道，写着这个周期里用了多久、占多少；上面叠着官方额度的已用曲线：哪段时间用了什么、额度涨得多快都能对上。左键拖动平移，按住右键拖选一段放大或标注，Ctrl + 滚轮缩放。' },
    { page: 'quota', target: '#quota-model-timeline .ms-cycle.week .ms-tl-help', title: '看不懂颜色？点问号', text: '周期标题旁的圆圈问号里，写着每种颜色和色块的意思：灰色竖条是「说不清来源」（前后 5 分钟内本机有请求、采样有缺口或刚发生），橙色竖条是「本机以外」，都不计入容量折算。' },
    { page: 'quota', target: '#quota-model-timeline .ms-cycle.week .ms-off-summary', title: '本机以外的消耗', text: '额度涨了、同期本机却没有 Code 请求的时段（网页聊天、其他设备）会自动识别，不计入容量折算。点色块可以像剪视频一样分割、删除，或者补上用了什么模型和等级。' },
    { page: 'usage', before: () => usageView('requests'), target: '#page-usage .breakdown-panel', title: 'Token 构成与用量分析', text: '输入、输出、缓存读写、推理各占多少；往下是分工具的趋势、模型排行和使用时段分布。' },
    { page: 'usage', before: () => usageView('requests'), target: '#page-usage .usage-records', title: '每一次请求', text: '逐条看每次请求用了多少 Token、占了多少额度、是哪个账号发的；型号对不上、响应可疑会直接标出来。也可以按日汇总、导出 CSV。' },
    { page: 'usage', before: () => usageView('projects'), target: '#page-usage .usage-records', wait: '#view-projects .pj-card', title: '按项目看用量', text: '每个项目文件夹被几个 Agent 对话改过、用了多少 Token 和额度，由哪些模型 × 思考等级组成。' },
    { page: 'egress', target: '[data-page="egress"]', title: '出口监控', text: '分别检测三家的出口 IP，偏离白名单或地区规则时提醒，还能在出口不对时暂停查询额度。' },
    { page: 'egress', target: '#page-egress .egress-toolbar', title: '检测间隔，和启动前核对出口', text: '「检测间隔」可以填 5 到 60 秒。开着监控、并给某一家设了白名单时，凡是 TokenPulse 启动的这一家的 CLI 都会先核对出口：设了 IP 白名单就看 IP，只设了地区白名单就看地区。监控关着，或者两个白名单都没设，就直接启动。' },
    { page: 'sessions', target: '[data-page="sessions"]', title: '会话管理', text: '查看本机 Agent 的对话历史，复制项目地址，或者直接接着回复。' },
    { page: 'sessions', target: '#page-sessions .sw-new-row', title: '新对话、新项目', text: '「新对话」在已有的项目里开一段新对话，「新项目」先选或新建一个文件夹；选好工具后，TokenPulse 在那个文件夹里打开终端启动它。会话的「更多」里还能在终端里接着聊。' },
    { page: 'providers', target: '[data-page="providers"]', title: '供应商', text: '为 Claude Code、Claude 桌面端、Codex 和 Grok CLI 一键切换模型供应商，模型候选和思考等级分开设置。每次改动工具配置前都会先给你看逐行对比、确认后才写，并自动备份；担心改坏可以在「配置保护」里打开只读保护。' },
    { page: 'overview', target: '#settings-open', title: '设置', text: '在这里登录官方账号、设置额度提醒、切换主题和语言。以后想再看这份引导，到 设置 → 关于 里重新打开。' },
  ];

  const el = (tag, attrs = {}, children = []) => window.el(tag, attrs, children);
  const icon = name => window.icon(name);
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let version = '';
  let tour = null;
  let notesOpen = null;

  /** 1.2.3 形式的版本比较，a 比 b 新返回正数。 */
  function compare(a, b) {
    const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  }
  const save = patch => api.writePrefs(patch).catch(() => { /* 写不进去下次再弹一次，不影响使用 */ });

  /** 背景不可操作：和设置窗口一样把工作区、侧栏设为 inert。 */
  function lockPage(on) {
    document.querySelector('.workspace').inert = document.querySelector('.sidebar').inert = on;
    document.body.classList.toggle('modal-open', on);
  }
  function trapTab(event, box) {
    if (event.key !== 'Tab') return;
    const controls = [...box.querySelectorAll('button:not(:disabled), a[href]')].filter(item => item.offsetParent);
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }

  /* ---------------- 新版本有什么 ---------------- */

  /** since：上次看过的版本。从 0.3.8 直接升到 0.3.10 时，0.3.10 和 0.3.9 的新内容都列出来（新的在前）；不给 since 就只列 v 这一版。 */
  function showNotes(v = version, { fromSettings = false, since } = {}) {
    const versions = Object.keys(NOTES).filter(x => compare(x, v) <= 0 && (since === undefined ? x === v : compare(x, since) > 0)).sort((a, b) => compare(b, a));
    if (!versions.length || notesOpen || tour) return false;
    const items = versions.flatMap((x, n) => [...(n ? [['', 'v' + x, '']] : []), ...NOTES[x]]);
    const last = document.activeElement;
    const close = el('button', { type: 'button', class: 'icon-circle', 'aria-label': '关闭' }, [icon('close')]);
    const ok = el('button', { type: 'button', class: 'btn btn-accent', text: '知道了' });
    const guide = el('button', { type: 'button', class: 'btn', text: '开始新手引导' });
    const card = el('section', { class: 'modal-card whatsnew-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'whatsnew-title' }, [
      el('header', { class: 'whatsnew-head' }, [
        el('div', {}, [
          el('span', { class: 'section-tag', text: '版本更新' }),
          el('h2', { id: 'whatsnew-title' }, ['TokenPulse ', el('span', { text: 'v' + v, translate: 'no' }), ' 有这些新东西']),
        ]),
        close,
      ]),
      el('ul', { class: 'whatsnew-list' }, items.map(([name, title, text], i) => {
        // 较早版本前面的分隔行
        if (!name) return el('li', { class: 'whatsnew-version', translate: 'no', text: title });
        const li = el('li', {}, [el('span', { class: 'whatsnew-icon' }, [icon(name)]), el('div', {}, [el('b', { text: title }), el('p', { text })])]);
        li.style.setProperty('--i', i);
        return li;
      })),
      el('footer', { class: 'whatsnew-foot' }, [guide, ok]),
    ]);
    const modal = el('div', { id: 'whatsnew', class: 'modal' }, [card]);
    const done = startTour => {
      if (!notesOpen) return;
      notesOpen = null;
      document.removeEventListener('keydown', onKey, true);
      modal.remove();
      lockPage(false);
      // 只有自动弹出的那次需要记版本；从设置里打开的本来就看过
      if (!fromSettings) save({ seenVersion: v });
      if (startTour) startGuide();
      else last?.focus?.();
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(false); }
      else trapTab(event, card);
    };
    close.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(false));
    guide.addEventListener('click', () => done(true));
    modal.addEventListener('click', event => { if (event.target === modal) done(false); });
    document.addEventListener('keydown', onKey, true);
    notesOpen = { modal, done };
    lockPage(true);
    document.body.append(modal);
    ok.focus({ preventScroll: true });
    return true;
  }

  /* ---------------- 新手引导 ---------------- */

  /** 等某个元素出现并且有尺寸（异步加载的面板），最多等 ms 毫秒。 */
  function waitFor(selector, ms = 3000) {
    return new Promise(resolve => {
      const end = Date.now() + ms;
      const check = () => {
        const node = document.querySelector(selector);
        if (node && node.getClientRects().length) resolve(node);
        else if (Date.now() > end) resolve(null);
        else setTimeout(check, 60);
      };
      check();
    });
  }
  /** 把目标滚到顶栏下面（工作区自己滚动，不是整页滚）。 */
  function reveal(target) {
    const scroller = target.closest('.workspace');
    if (!scroller) { target.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }); return; }
    const top = (document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0) + 16;
    const r = target.getBoundingClientRect();
    if (r.top < top || r.bottom > window.innerHeight - 16) scroller.scrollTo({ top: scroller.scrollTop + r.top - top, behavior: 'instant' });
  }

  async function startGuide() {
    if (tour) return;
    notesOpen?.done(false);
    if (!$('settings').hidden) window.closeModal?.('settings');
    const last = document.activeElement;
    const saved = typeof state !== 'undefined' ? { account: state.account, usageView: state.usageView } : null;
    const layer = el('div', { class: 'tour', role: 'presentation' });
    const spot = el('div', { class: 'tour-spot', 'aria-hidden': 'true' });
    const count = el('span', { class: 'tour-count' });
    const badge = el('span', { class: 'tour-demo', text: '演示数据', title: '引导里显示的是虚构的演示账号，不是你的数据', hidden: '' });
    const title = el('h3', { id: 'tour-title' });
    const text = el('p', { id: 'tour-text' });
    const bar = el('div', { class: 'tour-bar', 'aria-hidden': 'true' }, [el('i')]);
    const skip = el('button', { type: 'button', class: 'text-btn tour-skip', text: '跳过引导' });
    const prev = el('button', { type: 'button', class: 'btn', text: '上一步' });
    const next = el('button', { type: 'button', class: 'btn btn-accent' });
    const card = el('section', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' }, [
      el('div', { class: 'tour-top' }, [el('span', { class: 'tour-meta' }, [count, badge]), skip]),
      title, text,
      el('div', { class: 'tour-foot' }, [bar, el('div', { class: 'tour-actions' }, [prev, next])]),
    ]);
    layer.append(spot, card);
    const self = tour = { index: 0, layer, spot, card, target: null, frame: 0, last, token: 0, demo: false };

    const place = () => {
      if (tour !== self) return;
      const target = self.target;
      const rect = target && target.isConnected ? target.getBoundingClientRect() : null;
      const visible = rect && rect.width > 0 && rect.height > 0;
      const vw = window.innerWidth, vh = window.innerHeight;
      const top0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 0;
      layer.classList.toggle('no-target', !visible);
      const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, pad = 6, margin = 12;
      let x, y;
      if (visible) {
        // 高亮框：目标四周留 6px，限制在可视区内；目标太高时只框上面一截，给卡片留出位置
        const box = { left: Math.max(4, rect.left - pad), top: Math.max(top0 + 4, rect.top - pad), right: Math.min(vw - 4, rect.right + pad), bottom: Math.min(vh - 4, rect.bottom + pad) };
        const sideFits = box.right + gap + cw <= vw - margin && rect.width < vw * .45;
        if (!sideFits) box.bottom = Math.max(box.top + 40, Math.min(box.bottom, vh - ch - gap - margin * 2));
        Object.assign(spot.style, { left: box.left + 'px', top: box.top + 'px', width: Math.max(0, box.right - box.left) + 'px', height: Math.max(0, box.bottom - box.top) + 'px' });
        // 优先放在右边（侧栏的目标），其次下方、上方
        if (sideFits) { x = box.right + gap; y = box.top; }
        else if (box.bottom + gap + ch <= vh - margin) { x = box.left; y = box.bottom + gap; }
        else if (box.top - gap - ch >= top0 + margin) { x = box.left; y = box.top - gap - ch; }
        else { x = (vw - cw) / 2; y = vh - ch - margin * 2; }
      } else {
        x = (vw - cw) / 2; y = top0 + (vh - top0 - ch) / 2;
      }
      card.style.left = Math.round(Math.min(Math.max(margin, x), vw - cw - margin)) + 'px';
      card.style.top = Math.round(Math.min(Math.max(top0 + margin, y), vh - ch - margin)) + 'px';
    };
    const schedule = () => { cancelAnimationFrame(self.frame); if (tour === self) self.frame = requestAnimationFrame(place); };

    const show = async i => {
      const step = STEPS[i], token = ++self.token;
      self.index = i;
      count.textContent = `${i + 1} / ${STEPS.length}`;
      title.textContent = step.title;
      text.textContent = step.text;
      bar.firstChild.style.width = `${((i + 1) / STEPS.length) * 100}%`;
      prev.hidden = i === 0;
      next.textContent = i === 0 ? '开始' : i === STEPS.length - 1 ? '完成' : '下一步';
      card.classList.remove('step-in'); void card.offsetWidth; if (!reduced()) card.classList.add('step-in');
      if (step.page && document.body.dataset.page !== step.page) window.navigate?.(step.page);
      step.before?.();
      // 要等面板加载的步骤：高亮框先留在上一个位置（加 waiting 淡一点），免得闪到中间再跳回去
      layer.classList.toggle('waiting', Boolean(step.target));
      if (!step.target) { self.target = null; place(); }
      next.focus({ preventScroll: true });
      if (step.target) {
        const target = await waitFor(step.target);
        if (target && step.wait) await waitFor(step.wait, 2000);
        if (tour !== self || token !== self.token) return;
        if (target) reveal(target);
        self.target = target;
      }
      layer.classList.remove('waiting');
      place();
      // 切页后布局可能还在变（图表入场、字体）：下一帧、稍后各再对一次位置
      schedule();
      setTimeout(schedule, 400);
    };
    const finish = async () => {
      if (tour !== self) return;
      cancelAnimationFrame(self.frame);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('keydown', onKey, true);
      self.layer.remove();
      tour = null;
      // 换回真实数据：结束演示进程，账号和明细视图恢复成引导前的样子，再重读一次真实快照
      if (self.demo) {
        try { await api.demo(false); } catch { /* 进程已经退了也没关系 */ }
        if (saved) { state.account = saved.account; window.showUsageView?.(saved.usageView); }
        try { window.render?.(await api.snapshot()); } catch { /* 读不到就等下一次推送 */ }
      } else if (saved && state.usageView !== saved.usageView) { window.showUsageView?.(saved.usageView); if (current) window.render?.(current); }
      lockPage(false);
      save({ onboarding: 'done', seenVersion: version });
      window.navigate?.('overview');
      if (self.last?.isConnected) self.last.focus?.();
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); }
      else if (event.key === 'ArrowRight' && self.index < STEPS.length - 1) { event.preventDefault(); show(self.index + 1); }
      else if (event.key === 'ArrowLeft' && self.index > 0) { event.preventDefault(); show(self.index - 1); }
      else trapTab(event, card);
    };
    skip.addEventListener('click', finish);
    prev.addEventListener('click', () => show(Math.max(0, self.index - 1)));
    next.addEventListener('click', () => (self.index === STEPS.length - 1 ? finish() : show(self.index + 1)));
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('keydown', onKey, true);
    lockPage(true);
    document.body.append(layer);
    show(0);
    // 换上演示数据（看欢迎页的时候在后台准备好）；失败就用真实数据继续引导
    try {
      const snapshot = await api.demo?.(true);
      if (tour !== self) { api.demo(false).catch(() => {}); return; }
      if (snapshot) {
        self.demo = true;
        badge.hidden = false;
        if (typeof state !== 'undefined') state.account = 'claude:demo';
        window.render?.(snapshot);
        schedule();
      }
    } catch {
      api.demo?.(false)?.catch(() => {});
    }
  }

  /* ---------------- 启动 ---------------- */

  /** 等首页第一次画完（最多 4 秒）再弹，免得引导框住的是骨架屏。 */
  function whenReady() {
    return new Promise(resolve => {
      const started = Date.now();
      const check = () => ($('app-status')?.hidden || Date.now() - started > 4000 ? resolve() : setTimeout(check, 150));
      check();
    });
  }
  async function boot() {
    let prefs;
    try { [prefs, version] = await Promise.all([api.readPrefs(), api.version()]); } catch { return; }
    await whenReady();
    if (prefs.onboarding === 'pending') { startGuide(); return; }
    if (!prefs.seenVersion || compare(version, prefs.seenVersion) > 0) {
      if (!showNotes(version, { since: prefs.seenVersion || '' })) save({ seenVersion: version });
    }
  }

  $('intro-replay')?.addEventListener('click', () => startGuide());
  $('whatsnew-open')?.addEventListener('click', () => { window.closeModal?.('settings'); showNotes(version || undefined, { fromSettings: true }); });
  api.version?.().then(v => { version = version || v; const btn = $('whatsnew-open'); if (btn) btn.hidden = !NOTES[v]; }).catch(() => {});

  window.PulseIntro = { startGuide, active: () => Boolean(tour), demo: () => Boolean(tour?.demo), showNotes: v => showNotes(v || version, { fromSettings: true }), steps: STEPS.length, notes: NOTES };
  boot();
})();
