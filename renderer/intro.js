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
    '0.3.63': [
      ['quota', '额度被官方限流时自动放慢', '官方接口一段时间内被问得太多会回「限流」，以前每分钟照问，额度就一直刷不出来，只提示「这次没问到最新额度」。现在被限流的账号会先等几分钟再查，提示里写清是限流、大约几点再查；官方服务器出错、返回内容被代理拦截等情况也分开说明。'],
      ['settings', '统一的运行日志', '设置 →「数据」→「打开日志」：TokenPulse 发的每个请求、你的操作、登录过程和报错都记在这里，遇到问题可以发给帮你排查的人。不记 token、请求内容和会话正文，邮箱已打码。'],
    ],
    '0.3.62': [
      ['check', '只开了系统代理也能登录官方账号', '以前浏览器里授权成功了，Claude 的命令行换登录凭据时却不走系统代理，被官方拒绝，设置里只提示「没有检测到 OAuth 登录成功」。现在会把系统代理带给登录用的命令行；新登录的 Claude 账号也能正确显示邮箱了。'],
      ['settings', '登录日志', '登录不成功时，可以在设置 →「数据」→「打开登录日志」找到日志，发给帮你排查的人。里面没有 token 和授权码，邮箱已打码。'],
    ],
    '0.3.61': [
      ['pet', '桌宠', '侧栏新增「桌宠」页：打开后桌面上会有一只像素小动物（松鼠、仓鼠或章鱼），用样子表现剩余额度和本机的 Claude Code、Codex 有没有在干活；点一下冒出像素对话气泡，告诉你正在用的账号还剩多少额度，按住可以拖到任何地方，右键可以查看任务。默认关闭。'],
      ['settings', '自己定桌宠的样子', '「桌宠」页里可以换宠物、调大小和透明度、选额度跟哪个账号，也可以导入自己画的宠物：一个文件夹，放 pet.json 和各个状态的图片。'],
    ],
    '0.3.60': [
      ['check', '切换 Claude 账号后，用量记到新账号', '设置里一键切换 Claude CLI 登录时，账号资料以前可能写进 Claude Code 不读的文件，新会话仍报旧账号，用量被记到上一个号。现在按 Claude Code 实际使用的位置读写。'],
    ],
    '0.3.59': [
      ['quota', '「达到上限」提示不再那么敏感', '按趋势只是提前一点点用完的，进度条保持绿色，只用文字说明还差多少；只有重置前会断档较长时间才变黄。'],
      ['settings', '宽松程度自己定', '设置 → 提醒里可以分别给周额度和 5 小时额度选择严格、标准、宽松或不变色。'],
    ],
    '0.3.58': [
      ['sessions', '支持 pi 会话', '会话管理新增 pi：查看对话和工具记录、全文搜索，并在终端继续会话。'],
      ['route', '一键切换 pi 供应商', '供应商页新增 pi，支持三种接口直连和本地路由；保留其他配置，可切回原有默认供应商。'],
    ],
    '0.3.57': [
      ['sessions', '会话搜索更准确', '搜索只匹配对话文字和工具概要，修复角色名、消息编号造成的误命中；续接会话使用和详情相同的文件，避免点开找不到匹配内容。'],
      ['check', '搜索缓存异常时自动重建', '搜索缓存索引的结构损坏时会重新整理，不再让整个搜索失败。'],
    ],
    '0.3.56': [
      ['trend', '缓存命中分析', '用量明细新增「缓存」视图：查看缓存命中率、净节省、断档原因，以及按工具、模型和会话的分布。'],
      ['share', '每周小结和周报', '每周一收到上周用量、变化和常用模型的小结通知；点开即可查看并生成周报卡片。'],
      ['quota', '号池按重置时间预排', '号池按每周额度的重置时间安排官方账号，并预估每个号的用量时段和重置时作废；换号省不下额度时会继续使用当前账号。'],
    ],
    '0.3.55': [
      ['sessions', '会话能搜对话内容了', '会话管理的搜索框现在会一起搜所有会话里的对话内容（Claude Code、Codex、Grok、DeepSeek Harness），几个词用空格隔开就是都要出现。命中的会话列表里会显示匹配的那句话；点开直接跳到那一处，上面的小条可以切上一处、下一处。第一次搜要先把会话整理一遍，会慢几秒。'],
      ['health', '新的「体检」页', '侧栏多了「体检」：一键检查工具配置有没有被改走、本地路由通不通、哪个官方账号续期失败、能不能连上三家官方、出口和代理、数据目录能不能写。有问题的项会告诉你去哪一页处理。体检只看不改。'],
      ['terminal', '额度快用完时，自动切换 CLI 的登录账号','设置 → 官方账号里，登记了两个以上账号的那家多了一个开关。打开后，Claude Code、Codex 或 Grok CLI 现在登录的账号用到 90%、95% 或用满时，TokenPulse 会自动切到托管的、剩余最多的另一个账号，并发一条通知；没有能切的号也会告诉你。不走本地路由也能用。已经开着的会话要重新打开才会用新账号；工具用的是第三方供应商或号池时不会切。'],
    ],
    '0.3.54': [
      ['terminal', '切到 CLI 的账号不再隔一夜就「过期」', '账号切到 Claude Code 之后，凭据归 Claude Code 管，它只在发请求时才续期；超过 8 小时没用，TokenPulse 这边就显示登录失效、号池也跳过它。现在 Claude Code 没在运行时，TokenPulse 会替它续上并写回它的凭据文件；正在运行时不去抢，提示改成「等 Claude Code 下次请求时续上」，不再叫你重新登录。'],
      ['check', '续期偶尔被拒，不再直接要你重新登录', '以前官方回一次 401 或某些 400，账号就被判成「需要重新登录」，以后再也不试。现在只有官方明确说登录已失效才这样判；别的拒绝会继续重试，连续被拒超过一小时才提示重新登录。'],
      ['clock', '记下每一次续期', '每次续期的时间、结果、状态码和错误类型记在数据目录的 renew-log.jsonl 里（不记 token 和邮箱），以后再遇到过期，能查到是哪一种原因。设置里账号状态上悬停也能看到上次续期失败的原因。'],
    ],
    '0.3.53': [
      ['trend', '不开透明转发，也能看到大概的速度', 'Claude Code 和 Codex 的请求，现在会按会话日志里的时间戳估算每秒输出多少 Token。估算的数字前面都标「≈」：它包含首字之前的等待，比真实出字速度偏慢；用量明细的速度走势里单独成线，额度详情和请求列表也会显示。想要准确的，照旧打开透明转发或走本地路由。升级后第一次打开会重扫一遍会话。'],
      ['check', '里程碑卡片讲的是达成那天的事', '以前换一枚成就，只有奖章和标题会变，下面的数字一直是今天的。现在整张卡都按达成那天来：当时的累计、第几天达成、距上一枚隔了几天、同一组下一枚当时完成了多少（后来哪天达成）、截至当时收集了几枚。不同的成就下半部分也不一样：累计 Tokens / API 价值 / 请求画到那天为止的累计曲线，单日成就画那一天之前的 30 天，连续使用画那几天每天的用量。'],
    ],
    '0.3.52': [
      ['check', '切换 Claude 登录后，用量跟着账号走', '设置里切到另一个 CLI 账号时立即记录换号时间。恢复旧会话后，残留的旧邮箱和桥接账号会按后续登录变更判断归属，让请求记录和「模型与思考等级 · 时间线」对应起来。'],
      ['clock', '重新核对已有的账号用量', '升级后重新扫描本地仍保留的会话，结合已记录的登录时间线重算账号归属。没有记录的历史换号时间无法精确还原。'],
    ],
    '0.3.51': [
      ['calendar', '月报分享卡片', '顶栏「分享卡片」可以生成任意有用量月份的月报：每天用了多少、最常用的模型、夜间用量、最快模型和缓存节省。填订阅费可以看 API 参考价值的倍数，预览后保存 PNG 或复制图片；每月初提醒查看上个月月报。'],
      ['check', '里程碑与徽章收集册', '累计 Tokens、单日用量、连续使用、API 参考价值和请求次数达成里程碑时会提示。分享弹窗里可以挑一枚已解锁徽章生成卡片，也能查看整个收集册。首次运行只记下已有徽章。'],
      ['trend', '号池生存分析', '额度详情的号池页新增本周剩余额度曲线、每个账号的见底和重置、过去各周对比，以及按最近 7 天平均用量估算的未来 7 天。缺测或额度过期时不生成预测；只算官方账号的周额度，API Key 成员仍可接着用。'],
      ['check', '从供应商页看速度时读取新记录', '点击「去用量明细看模型速度」会重新读取转发记录，不再沿用启动时预读的空图。'],
    ],
    '0.3.50': [
      ['help', '新手引导介绍得更全了', '引导分成七章：开始、总览、额度详情、用量明细、供应商、会话与监控、个性化与设置，补上了号池、透明转发、本地路由、转发记录、配置保护、并发监控、模型速度、编辑布局和一键切换 CLI 登录。卡片右上角的「目录」可以直接跳到想看的那一章。设置 → 关于 里可以随时重新打开。'],
      ['trend', '号池的模型速度合成一条线', '「模型速度走势」以前把号池里每个账号各画一条线，同一个模型一下子冒出好几条。现在同一个号池的几个账号合成一条，按号池名显示；不同的第三方供应商、不同的思考等级仍然分开。供应商页透明转发里的速度汇总也一样。'],
    ],
    '0.3.49': [
      ['overview', '编辑布局重新做了', '点侧栏「编辑布局」后，每张卡片和侧栏的每一页上沿都有把手和 ×：拖动换位置，点 × 隐藏，能撤销。总览的官方额度按 Claude、ChatGPT、Grok、DeepSeek 分开，额度详情的账号标签也能单独藏。藏起来的东西在原处留一条虚线，点「显示」就回到原位；右边的布局面板按页面列出全部，每页都能恢复默认。'],
      ['terminal', '设置里一键切换 CLI 的登录账号', '设置 → 官方账号里，在 TokenPulse 里登录过的账号旁边多了「切到 CLI」。点一下，Claude Code、Codex 或 Grok 的登录就换成这个账号，不用再去终端里登出、登录。换下来的账号由 TokenPulse 接着保存，随时能切回去。已经开着的会话要重新打开才会用新账号。'],
      ['check', '多个账号不再自动组成「账号池」', '同一家登记了几个账号，只是各自显示额度。额度详情里不再出现自动生成的「账号池」卡片，设置里也不再写「当前顺位」「下一个」「排队」。真正的号池仍在供应商页里自己建。'],
      ['check', '供应商页换菜单不再白屏', '在「转发记录」这类很长的列表里往下翻，再点左边别的菜单，以前画面会停在很下面、一片空白。现在换菜单会回到顶部。'],
    ],
    '0.3.48': [
      ['route', 'Grok 不会再悄悄换回别的模型', 'Grok 继续旧会话或用 /model 时会改默认模型，以前 TokenPulse 会因此放弃接管，下次打开 Grok 用的是 Grok 4.7 或你自己的第三方 Key。现在只改了默认模型时照常接回你选的供应商；官方上新活动临时改默认模型，也会在切到第三方或号池时一并关掉。'],
      ['check', '换了 Claude 账号，用量记到新账号', '在同一个 Claude Code 会话里换了登录，以前用量一直记在第一个账号上。现在按会话里当前登录的账号算。升级后第一次打开会重新扫一遍会话，把以前记错的也改过来。'],
      ['check', '号池自动避开额度用完的号', 'Grok 账号额度用完时回的是 402，以前号池不换号，直接报错。现在遇到 402 自动换下一个；轮询和「用满再换」也会把额度用完、或刚回过 402 / 429 的号排到最后。不用手动剔除，额度恢复后自动回到轮换里。'],
    ],
    '0.3.47': [
      ['check', '换 Key 时会等验证结果', 'DeepSeek 和第三方余额账号正在查询时，更换 Key 会等旧查询结束，再验证新 Key。新 Key 无效时，原来的 Key、名字、提醒线和 Harness 归属一起保留。'],
      ['check', '添加失败后保留原账号归属', '添加 DeepSeek 账号时，即使勾选了本机 Harness 用量归属，Key 验证失败也不会清掉原账号的归属。接口返回空金额时，也不会把它当成零余额。'],
      ['calendar', '余额历史可以往前翻', 'DeepSeek 账号即使没有本机请求，只要记过余额，也能在时间线里翻到那些日期。'],
      ['clock', '零点的请求算在当天', 'DeepSeek 和号池时间线会把零点整的请求算到新的一天，和按天统计保持一致。'],
    ],
    '0.3.46': [
      ['alert', '刷新后会告诉你结果', '点「刷新数据」后，右上角会弹出结果：哪一家、哪个账号、哪一项额度变了多少；没变也会说已刷新。这次没问到是黄色提醒；登录失效才红色，并请你重新登录。'],
    ],
    '0.3.45': [
      ['check', 'Grok 选哪个型号，就按哪个发', 'Grok 里如果给 grok-4.6 配过一张自定义模型，选它时发出去的会是另一张表上的型号。TokenPulse 开着并接管 Grok 时，选 grok-4.6 就按 grok-4.6 转发；另选 4.5 或 4.7，也按你选的那个发。关掉 TokenPulse 后，原来的那张表会恢复。'],
      ['check', 'Grok 4.6 和 4.6-build 算同一个型号', 'Grok Build 计费时会在型号后面加上 -build。用量明细现在把 grok-4.6 和 grok-4.6-build 看成同一个型号，不再标成不一致。'],
      ['info', '用量明细的红点看过就消', '侧栏「用量明细」上的红点表示还有没看过的型号不一致。打开这一页之后就清掉，之后只有新出现的才会再标。'],
    ],
    '0.3.44': [
      ['route', '号池可以按额度轮换', '编辑号池时多了两种轮换：「快重置优先」先用每周额度快要重置、又还剩很多的号；「剩余最多」一直用剩得最多的号，别的号多出 5% 以上才换。按各账号最近一次查到的额度排。'],
      ['trend', '额度详情里每个号池有自己的一页', '额度详情顶上，每个号池多一个标签：总额度、号池用量、成员各用了多少、24 小时和 30 天的分摊、时间线、模型速度和最近的请求。标签可以拖动排序，记在这台电脑上。'],
      ['plus', 'DeepSeek Harness 可以切换供应商、查看会话', '供应商页现在有 DeepSeek Harness：可以切到 API Key 供应商或号池，也可以切回官方登录。号池只放 API Key 供应商。会话管理能列出本机的 Harness 会话，打开后可以查看和回复。'],
    ],
    '0.3.43': [
      ['overview', '侧栏和各页卡片可以收起用不到的部分', '点侧栏「工作空间」旁边的「编辑布局」，可以去掉用不到的页面和各页上的卡片，总览的四张统计小卡也能各自去掉，之后加回原来的位置。只影响这台电脑上的界面，监控和通知照常进行。'],
      ['trace', 'Grok 号池的消耗记到每次转发', '额度详情和时间线以前只在一整轮都交给同一个账号时才认这笔用量，一轮里换过账号就当成「本机以外」。现在每一次转发记在当时用的那个账号上，额度上涨能对上本机的请求。'],
      ['clock', '额度查询改成同一个间隔', 'Claude、ChatGPT、Grok 的订阅额度，以及 DeepSeek 和第三方 Key 的余额，现在用同一个间隔自动查。默认 1 分钟。在设置 → 通用里拖动滑块，保存后生效。最短 1 分钟，最长 10 分钟。'],
    ],
    '0.3.42': [
      ["plus","支持 DeepSeek Harness 的用量","用量明细里现在能看到 DeepSeek Harness（DeepSeek 官方的 dsh）的每一次请求：Token、缓存命中、型号、思考等级、项目和参考费用。型号按官方的叫法显示（deepseek-flash 显示成 DeepSeek-V4.1-Flash），参考费用按 DeepSeek 官方单价算，并区分高峰和闲时（闲时半价）。会话管理和供应商切换暂时不支持它。"],
      ["cost","新增：DeepSeek 余额监控","DeepSeek 按量付费，没有订阅额度，所以看的是余额。在 DeepSeek 开放平台创建一个 API Key 填进来，额度详情顶上就会多一个 DeepSeek 的标签，点进去是这个账号的余额（充值和赠送分开）；有几个账号可以填几个 Key，每个账号各有一页，总览里也会列出来。每 10 分钟自动查一次，也可以手动刷新；每个账号可以设一个数，余额低于它时提醒你。Key 只保存在这台电脑上，只用来查余额，查余额不花钱。入口：额度详情里的 DeepSeek 标签，或者 设置 → 数据。"],
      ["trend","DeepSeek 账号页补全：消耗、预测、时间线、速度、模型换算","DeepSeek 的账号页现在和官方账号的额度详情一样完整，只是把「额度」换成了「余额」：今天 / 7 天 / 30 天花了多少、按最近的速度还能用几天；消耗趋势（每天花多少）和余额走势；本机 DeepSeek Harness 最近 24 小时的用量；「模型与思考等级 · 时间线」（按天 / 按 7 天，上方曲线是余额）；模型速度（Harness 自己在日志里记了出字时间，不用开透明转发）；「换一种模型，余额能用多少」（每个型号高峰 / 闲时各一行，并用你自己的实际扣费校准）。消耗从填了 Key 之后开始记录。有多个账号时，在账号的「设置」里勾选本机 Harness 用的是哪一个。图标也换成了 DeepSeek 的。"],
      ["plus","新增：监控第三方中转站 Key 的余额","自己买的第三方中转站 Key 现在也能监控：填站点地址和 Key，额度详情里多一个标签，总览里多一张卡片。能看到余额、花了多少、还能用几天；如果站点给这个 Key 设了总额度、限速窗口（5 小时 / 1 天 / 7 天）或订阅的日 / 周 / 月限额，会画成进度条，并显示到期时间和这个 Key 今天、累计、每天的用量。支持用 sub2api 和 new-api / one-api 搭的站，添加时自动识别；认不出来的站会直接告诉你不支持，不会编数字。Key 只保存在这台电脑上，只发给你填的那个站点，查余额不花额度。入口：设置 → 数据 → 添加第三方 Key，或者 DeepSeek / 中转站页面右上角的「添加账号」。"],
      ["info","额度详情的账号标签可以随便排","额度详情顶上那一排账号，以前只能在同一家的账号之间调顺序。现在所有账号都可以互相拖动，比如把 DeepSeek 排到 ChatGPT 前面，或者把常用的几个账号放在一起。排列记在这台电脑上。"],
      ["user","号池的用量算到成员名下（Grok 也可以了）","用 Grok 号池时，成员账号下面以前一直没有用量：Grok 的记录按一整轮汇总，对不上单次请求。现在按这一轮的时间去查转发记录，号池把请求交给了谁、各占多少，就按这个比例分给他们；一轮全部交给同一个账号时，这条请求也会标上账号。Claude Code 和 Codex 号池成员的小时用量以前也没进账号的图表，一并补上。更新后第一次打开会把历史重算一遍，要多等几秒。"],
    ],
    '0.3.41': [
      ["trace","新增：Codex 降智检测（手动）","额度详情里，ChatGPT 账号多了一个「降智检测」：点一下，用这个账号发两个极小的请求，看官方会不会换「门票」，换了就很可能被降到了更低的模型。只在你点的时候测，每次会用掉一点点额度；这是经验判据，不是官方规则，结论仅供参考。"],
      ["check","修复：上游中途换了型号时仍显示「型号一致」","一次回复里上游会报两次型号：开头一次、结束一次。以前只看开头那次，而开头报的可能只是照着请求回显的；账号被降到更低的型号时，结束那次才是实际用的。现在以结束时报的为准，前后不一样会标成「型号不一致」，详情里写出两个名字。只对更新后、经 TokenPulse 转发（透明转发、号池、本地路由）的请求有效。"],
    ],
    '0.3.40': [
      ["trend","并发量实时监控","分别查看活跃 AI 请求、客户端连接和上游连接；直连显示未监控，未知账号和共享连接不会猜测归属。"],
      ["lock","请求并发上限","可以分别设置全局、供应商或账号上限，仅提醒或拒绝新的 HTTP / WebSocket AI 请求；号池跳过已满成员，不中断已有请求。"],
      ["clock","并发历史与提醒","本机保存每分钟峰值，可保留 7、30、90 天或永久；超限每轮提醒一次，恢复后重新计算。"],
      ["plus","侧栏展开与收起更流畅","展开和收起时侧栏边界、图标与内容区一起滑动，文字淡入淡出；快速反向切换不会跳回起点，并尊重减弱动态设置。"],
    ],
    '0.3.39': [
      ["trend","模型速度走势","用量明细里可以按工具、型号、思考等级、快速模式和经由谁转发查看速度与首字折线图，支持 24 小时、7 天、30 天和全部记录，图例可以逐条开关。Claude Code 的思考等级也能正确记录。"],
      ["plus","侧栏可以收起","左下方「设置」上方多了收起按钮：侧栏收成图标栏，导航和展开入口都保留，刷新后仍记住你的选择。窄窗口也可以手动展开。"],
      ["trace","转发记录可以直接跳页","转发记录显示当前页、总页数和总条数，可以点页码或输入页码跳转；较早的记录按需读取。"],
      ["lock","修复：断线后重复发送推理请求","上游可能已经收到 POST 请求，只是还没返回响应就断开。现在这种情况下不会自动换连接重发，也不会再交给号池下一个成员，避免同一个请求被重复执行；连接复用仍保留。"],
      ["check","修复：切换速度图范围时闪烁或显示旧数据","切换时保留原图并显示正在读取，新数据到齐后一次替换；较早请求的结果不会覆盖当前范围。读取失败时保留原图并提供重试。"],
      ["clock","修复：短回复的首字统计与大量记录读取","没有速度值的短回复也会进入首字统计，速度与首字分别计算样本次数。记录很多时不再因数组展开超限而读取失败。"],
      ["check","修复：取消环境检查后子进程仍在运行","取消 tokens.ci 环境检查或退出软件时，会结束正在运行的工具检查和版本查询，不再继续启动后续检查。"],
    ],
    '0.3.38': [
      ['up', 'tokens.ci 自动上传', '用量明细上方可以打开 tokens.ci 自动上传：第一次有向导（检查 Node.js → 选公开上榜或隐私模式、在浏览器里用 GitHub 授权 → 预览会传什么 → 设间隔）。之后由 TokenPulse 自己计时运行 tokens.ci 的官方工具上传，10 分钟到一天一次（默认 1 小时），可选每次打开软件时先传一次，不往系统里加计划任务。TokenPulse 不读它的登录凭据，也不把自己的账本交给它。'],
      ['calendar', '全年活跃度', '用量分析里多了一张一格一天的贡献图：最近一年或任选一年，颜色越深用得越多，写出最努力的一天和最长连续天数；点某一天，整页就只看那一天。'],
      ['route', 'Grok CLI 也能透明转发', '「供应商 → 透明转发」里多了 Grok CLI：官方登录的请求原样转给官方，量首字延迟和速度。Grok 用号池时这个开关是灰的。Claude Code 那一行加了提醒：开着透明转发时 Remote Control 用不了。'],
      ['clock', '每次请求的延迟', '经 TokenPulse 转发的请求，用量明细里多了「延迟」一列：首字、总耗时、每秒输出多少 Token；点开详情能看到思考等级、接口、是否流式和经由谁转发。'],
      ['check', '经代理转发更快，延迟更准', '经系统代理转发时会复用连接，不再每个请求都重新握手（实测每次省下约 0.6 秒），首字和总耗时也不再把这段时间算进去。复用的连接刚好被关掉时会自动换一条重发。'],
      ['trend', '打开软件更快', '启动时整理统计的时间从几秒降到约半秒；数据出来之前窗口里只显示图标和「正在扫描中…」，不再是一片空白。'],
      ['trace', '转发记录分页', '转发记录改成一页 20 条，用上一页 / 下一页翻，不用一直往下滑。'],
    ],
    '0.3.37': [
      ['check', '修复：上游回复中断后请求一直挂着', '经本地路由的回复中途断开时，现在会结束请求并记下失败；客户端取消请求时也会释放连接，不再一直显示正在转发。'],
      ['check', '修复：压缩回复和格式转换', '本地路由会保留压缩回复的编码信息，并正确读取用量；需要转换接口格式时先解压。上游返回错误时保留错误状态，不再把失败算成成功。'],
      ['lock', '错误日志不再保存上游回显的内容', '上游报错可能回显提示词或凭据。转发记录现在只记状态码等受控摘要，错误说明仍返回给发起请求的工具；已有历史日志不会被自动改写。'],
      ['user', '号池用量按响应 ID 精确归属', '不再把时间相近的直连、第三方或并发请求猜给号池成员，旧的猜测归属会重新计算。没有共同响应 ID 的用量保留在总量里，暂不归给号池账号；Grok 目前属于这种情况，转发记录和账号速度仍按实际成员统计。'],
      ['trace', '修复：转发记录翻页漏项', '同一毫秒发生的多次转发也能完整翻页，不再漏掉或合并不同请求；旧记录同样支持。'],
    ],
    '0.3.36': [
      ['trend', '号池和第三方供应商的速度也量了', '走本地路由的请求（号池、第三方供应商）本来就经过 TokenPulse，现在同样记下首字延迟和每秒输出多少 Token，不用开透明转发。号池里每个官方账号的速度画在额度详情的「模型速度」里（Grok 的号池也有）；「供应商 → 透明转发」的汇总里，同一个型号经不同的供应商分开算。'],
      ['check', '修复：从会话管理打开的终端占着 TokenPulse 的文件夹', '从「会话管理」继续或新建对话时打开的终端，会把 TokenPulse 自己所在的文件夹当成工作目录，终端开着的时候那个文件夹删不掉、改不了名。现在终端的工作目录是会话的项目文件夹。'],
    ],
    '0.3.35': [
      ['plus', '透明转发：量一量模型有多快', '想知道模型出字有多快？在「供应商 → 透明转发」里给 Claude Code 或 Codex 打开开关：官方登录的请求在本机过一道，原样转给官方，TokenPulse 只计时、读回复里的 Token 数。请求头、登录凭据、内容一个字节都不动，不保存凭据和内容，只在本机监听。默认关闭；关闭或退出时自动恢复直连，下次启动接着开。开关之后要重新打开工具的会话才生效。'],
      ['trend', '额度详情里看每个模型的速度走势', '打开透明转发后，额度详情里每个账号下面多一张「模型速度」：一个模型一行，中间是这个模型自己的速度走势，右边是中位速度和一条按同一刻度画的对比条，谁快谁慢一眼能比。可以看 24 小时、7 天、30 天或全部，记录永久保存。快速模式（Codex 的 Fast、Claude Code 的 /fast）的请求单独一行。'],
      ['check', 'Codex 也能核验型号了', 'Codex 自己不记上游实际用的是哪个型号，以前请求记录里只能显示「无法核验」。现在经过 TokenPulse 的请求（透明转发，或本地路由里的中转站、号池）会在转发时读出返回的型号，请求记录里就能给出「型号一致」或「型号不一致」，不一致时照常提醒。'],
      ['info', '时间线挪到更顺手的位置', '额度详情里的「模型与思考等级 · 时间线」现在紧跟在「最近 24 小时」和「本周额度采样」两张图下面，不用再滑到页面最底。'],
    ],
    '0.3.34': [
      ['info', '转发记录永久保存，记得更细', '本地路由的每一次转发都会记下来，按月一个文件保存在本机，不再只留最近几十条：时间、交给了哪家 / 号池里的哪个账号、型号、思考等级、状态、耗时、大小和 Token 数，失败后换下一个成员的那几次也都有。不记请求和回复的内容，也不记密钥。在「供应商 → 转发记录」里可以打开记录文件夹。'],
      ['check', '修复：经号池发出的请求没有记到账号名下', '用号池（多个官方账号轮流用）时，每个账号下面看不到请求记录，也没有 Token 用量：这些请求被当成了第三方中转站。现在本地路由会记下每个请求交给了哪个账号，用量明细、请求记录、按项目和额度折算都会归到对应的账号名下。只对更新之后新产生的请求有效，之前的补不回来。'],
    ],
    '0.3.33': [
      ['plus', '右键托盘图标，弹出额度小面板', '不用打开主窗口：在托盘图标上点右键，每个官方账号的 5 小时额度和周额度各一条进度条，写着已用多少、什么时候重置。进度条上的小竖线是「时间走到哪了」，一眼能看出是不是用得太快。面板里还能看到各个工具现在用的供应商并切换，右上角是刷新和退出。原来的右键菜单不再提供。'],
      ['info', 'Prism 桥下线', 'Prism 在 10 月初陆续撤掉了 6.1 Sol、5.6 Sol 和 5.6 Terra，现在只剩 6 Luna，已经解决不了账号被「降智」的问题。没有装过的人不再看到这个功能。以前装过的人那一页还在，可以用页面最下面的「全部删除」把运行环境和浏览器清掉。'],
    ],
    '0.3.32': [
      ['info', 'Grok 号池可以设上下文窗口', '直接用 Grok 官方登录时上下文可以到 500K，换成号池后只有 200K：号池在 Grok 里是自定义模型，没写上下文大小时按 200K 算。现在可以在「编辑号池 → 基本信息 → 上下文窗口」里填，旁边有 256K、500K 两个快捷按钮。已有的号池要自己改一下，保存后重新启用。'],
    ],
    '0.3.31': [
      ['check', '修复：换成中转站或官方登录后，打不开用 Prism 桥聊过的对话', 'Codex 桌面端提示「Model provider tokenpulse_route not found」。0.3.26 修过反方向的同一个问题，这次补上了没覆盖到的情况：退出 TokenPulse 或关掉本地路由后配置被还原、用别的工具切换到中转站。现在这些情况下都会把旧对话用到的配置补回来，内容照抄现在生效的那一家。补完后请重新打开 Codex 桌面端。'],
    ],
    '0.3.30': [
      ['check', '修复：Prism 桥一直报「400 Bad Request」', 'Prism 在 2026-10-05 把 6.1 Sol 和 6 Astra 从模型列表里拿掉了，请求它们一律被拒，而 TokenPulse 给 Codex 配的默认模型正好是 6.1 Sol。现在默认模型是 5.6 Sol。Codex 还在请求已下架的模型时，桥会改用 Prism 现在提供的模型来回答，并在 Prism 桥页面顶部提醒。'],
      ['info', 'Prism 桥的模型列表跟着 Prism 走', '服务启动时会从 Prism 自己的配置里读出现在提供的模型（目前是 5.6 Sol、5.6 Terra、6 Luna）。以后 Prism 再增减模型不用等新版。更新后请重启一次 Prism 桥服务，再在 Prism 桥页面点「更新供应商」，然后在 Codex 里重新选一下模型。'],
    ],
    '0.3.29': [
      ['info', 'Grok 号池 / 供应商可以选思考等级', '用 Grok 号池时在 Grok 里 /effort 会提示「current model does not support reasoning effort」，请求里也不带思考等级。现在可以在 TokenPulse 里选：号池在「编辑号池 → 基本信息 → 思考等级」，普通的 Grok 供应商在「模型」那一行的默认思考等级。本地路由转发时替你加上，请求自己带了的不会改。'],
      ['check', '修复：Prism 桥报「Unable to confirm the response started」后连续失败', '和 0.3.27 修的是同一类问题：Prism 那边的会话卡住了，重建一次就好。现在遇到这句话桥也会自动重建会话再发一次。更新后请把 Prism 桥的服务停止再启动一次。'],
    ],
    '0.3.28': [
      ['check', '修复：Prism 桥被限流后反复失败', 'Codex 报「Error while processing conversation (403 Forbidden)」是 Prism 的限流，短时间内连发多轮就会触发。0.3.25 之后桥遇到它会马上把错误交回 Codex，Codex 每两三秒重试一次，越试限流越久。现在桥会自己等 20、40、60 秒再发同一轮（最多 4 分钟）。长对话拆成多段发送时，每段之间也恢复成固定隔 8 秒。'],
    ],
    '0.3.27': [
      ['check', '修复：Prism 桥报「项目文件同步超时」后一直失败', 'Codex 报「Project file synchronization timed out while starting the response」之后，每一轮都等一分钟再报同样的错，要手动重启服务才恢复。这是 Prism 那边开始回答前同步文件超时，这一轮并没有开始。现在桥遇到它会自动重建会话再发一次（0.3.24 及以前就是这样，0.3.25 跟进上游时被去掉了）。'],
    ],
    '0.3.26': [
      ['check', "修复：用了 TokenPulse 的供应商后，Codex 打不开以前的对话", "用 Prism 桥或别的供应商时，打开以前用中转站、官方登录时的 Codex 对话，会报「Model provider 'custom' not found」，看不了也接不下去。原因是 Codex 的每个对话都记着当时那家供应商的名字，而配置里已经没有这个名字了。现在 TokenPulse 会自动把缺的名字补上（启动时和切换供应商时），旧对话可以正常打开；接着聊会走你现在选的这家。切回官方登录后，用 TokenPulse 的供应商聊过的对话也一样能打开。"],
    ],
    '0.3.25': [
      ['check', 'Prism 桥：很长的对话不再发不出去', '跟进了上游 Prism Bridge 的更新。对话历史太长、拆成 8 轮也装不下时，桥会自动摘掉一部分较早的历史再发，不再直接报错。这是直接删减，不是让模型总结，较早的细节可能丢失；当前的提问、工具调用和结果、图片不会被删。'],
      ['trend', 'Prism 桥：每一轮等得更短', '查询这一轮有没有结束，从「先等 1.5 秒再查」改成马上查、之后每 0.4 秒查一次；拆成多轮发送时，上一轮已经花掉的时间会从 8 秒的间隔里扣掉。'],
      ['alert', 'Prism 桥：出错时不再盲目重发', '遇到 401 / 403、超时、断流这类不确定请求有没有被执行的情况，桥不再自动把同一个请求重发一遍（可能让同一步被执行两次），而是把错误交回给 Codex。'],
    ],
    '0.3.24': [
      ['info', '整窗能用多少：搜索模型、只看估计 / 只看实测', '列表上方可以按名字搜索模型。右上角多了一个切换：都显示、只看估计、只看实测（只看实测时只列出有实测值的组合）。「添加模型」和排序在左边，这个切换在右边。'],
      ['trend', '整窗能用多少：估计值和实测值分开显示', '「换一种模型，整窗能用多少」里，每一行的主数字现在都是估计值，所有型号、所有等级按同一套算法算，可以互相比。有实测的组合另外多出一条绿色的「实测」行，和估计值的行一起排，能看出两个数差多远、中间隔着哪些模型；旁边的问号说明两个数为什么不一样。以前实测和估计混在同一列，会出现 low 比 high 能用的还少这种误会。'],
    ],
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
  /*
   * 引导的每一步（0.3.50 扩写成分章节）。chapter：卡片左上角写着第几章，「目录」里能直接跳到某一章。
   * 演示数据只覆盖额度、用量和会话；供应商、并发这些页面显示的是真实界面，所以那几步只高亮菜单项、用文字讲清楚能做什么。
   */
  const providers = section => () => window.PulseProviders?.open(section);
  const STEPS = [
    { chapter: '开始', title: '欢迎使用 TokenPulse', text: 'TokenPulse 常驻托盘，记录本机 AI 工具（Claude Code、Codex、Grok、DeepSeek Harness）的用量，盯住官方订阅额度，还能切换供应商、管理会话。接下来用一个演示账号带你走一遍，分成几章：右上角的「目录」可以直接跳到想看的那一章。演示数据只在引导里出现，不会写进你的数据，结束后自动换回来。' },
    { chapter: '开始', page: 'overview', target: '#nav', title: '左侧切换页面', text: '总览、额度详情、用量明细、出口监控、并发监控、会话管理、供应商，都在这里。侧栏可以收起成只有图标；不常用的页面可以在「编辑布局」里藏起来。' },
    { chapter: '开始', page: 'overview', target: '#refresh', title: '数据自动更新', text: '后台会定时扫描本机日志，并按设置里的间隔（默认 1 分钟）查询官方额度和余额。想马上看最新数字就点「刷新数据」，右上角会告诉你哪个账号的哪项额度变了多少。' },

    { chapter: '总览', page: 'overview', target: '#quota-cards', title: '官方额度一眼看完', text: '每家一张卡：5 小时窗口和周窗口还剩多少、什么时候重置、照现在的节奏大约什么时候用完。同一家登记了几个账号时，下面列出其他账号的剩余。DeepSeek 和第三方 Key 的余额也在这一排，显示还能用几天。' },
    { chapter: '总览', page: 'overview', target: '#tiles', title: '所选范围的四个数字', text: '总 Tokens、参考费用（按官方标价估算，订阅账号不会真的这样扣钱）、请求次数、缓存读取占比。上方可以切换时间范围和工具，下面的图表跟着变。' },
    { chapter: '总览', page: 'overview', target: '#overview-analysis .analysis-grid', title: '用量趋势与使用节奏', text: '按天看 Tokens、费用、请求数的走势，以及一天里哪些时段用得最多。' },
    { chapter: '总览', page: 'overview', target: '#overview-analysis .split-grid', title: '工具分布与模型排行', text: '哪个工具用得最多、哪些模型最费 Token。点「查看明细」直接跳到用量明细。' },

    { chapter: '额度详情', page: 'quota', target: '#page-quota .quota-toolbar', title: '额度详情 · 按账号看', text: '每个官方账号一个标签；在供应商页建的号池、DeepSeek 和第三方 Key 也各有一个标签。按住标签左右拖动可以调整顺序，「添加账号」可以登录更多账号。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-detail .quota-window-grid', title: '5 小时与周窗口', text: '已用百分比、重置时间，以及按最近的使用节奏估算「大约什么时候用完」。下面的小卡片是这个窗口里用了多少 Token、多少请求、每小时用多少。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-detail .capacity-panel', title: '额度容量趋势', text: '把每个历史窗口折算成「整窗大约能用多少」（Tokens 或 API 等价费用），连成折线。官方悄悄调了额度，这里能看出来。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-model-study .ms-budgets', title: '换一种模型，整窗能用多少', text: '先按本机的真实用量折算出整窗预算，再换算到每个模型 × 思考等级：换成 Sonnet 能多用几倍、开 xhigh 要少用多少，一目了然。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-model-study .ms-highlights', title: '一眼看结论，再看完整排行', text: '最耐用、调用最多、你最常用的组合放在最前面；下面是全部模型 × 思考等级的完整排行，可以换排序、按等级筛选。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-model-timeline .ms-cycle.week .ms-tl', title: '模型与思考等级 · 时间线', text: '每个模型 × 思考等级一条轨道，写着这个周期里用了多久、占多少；上面叠着官方额度的已用曲线：哪段时间用了什么、额度涨得多快都能对上。左键拖动平移，按住右键拖选一段放大或标注，Ctrl + 滚轮缩放。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-model-timeline .ms-cycle.week .ms-tl-help', title: '看不懂颜色？点问号', text: '周期标题旁的圆圈问号里，写着每种颜色和色块的意思：灰色竖条是「说不清来源」（前后 5 分钟内本机有请求、采样有缺口或刚发生），橙色竖条是「本机以外」，都不计入容量折算。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-model-timeline .ms-cycle.week .ms-off-summary', title: '本机以外的消耗', text: '额度涨了、同期本机却没有 Code 请求的时段（网页聊天、其他设备）会自动识别，不计入容量折算。点色块可以像剪视频一样分割、删除，或者补上用了什么模型和等级。' },
    { chapter: '额度详情', page: 'quota', target: '#quota-detail [data-layout="quota:account"]', title: '这个账号的请求', text: '只看这个账号发出的每一次请求：用了多少 Token、什么模型和思考等级、占了多少额度。请求经过 TokenPulse（透明转发或号池）时，上面还有「模型速度」：每个模型每秒输出多少 Token、首字等多久。' },
    { chapter: '额度详情', title: '号池、DeepSeek 和第三方 Key 也有自己的一页', text: '号池的那一页：总额度相当于几个号、按现在的速度还能用几天、每个成员各用了多少、24 小时和 30 天的分摊、时间线和最近的请求。DeepSeek 和第三方 Key 的那一页：余额走势、消耗趋势、本机用量和模型换算，余额低了会提醒。' },

    { chapter: '用量明细', page: 'usage', before: () => usageView('requests'), target: '#page-usage .breakdown-panel', title: 'Token 构成', text: '输入、输出、缓存读写、推理各占多少。上方的时间范围、工具、模型筛选对这一页的所有数字都生效。' },
    { chapter: '用量明细', page: 'usage', before: () => usageView('requests'), target: '#usage-insights', title: '用量分析', text: '全年活跃度、按工具的趋势、工具和模型排行、一天里的使用时段分布。' },
    { chapter: '用量明细', page: 'usage', before: () => usageView('requests'), target: '#page-usage [data-layout="usage:speed"]', title: '模型速度走势', text: '经过 TokenPulse 的请求（透明转发、号池、第三方供应商）量到的速度和首字延迟，画成折线。同一个型号不同思考等级、不同供应商分开一条线，同一个号池的几个账号合成一条；可以看 24 小时到全部记录，点图例开关每条线。' },
    { chapter: '用量明细', page: 'usage', before: () => usageView('requests'), target: '#page-usage .usage-records', title: '每一次请求', text: '逐条看每次请求用了多少 Token、占了多少额度、是哪个账号发的；请求的型号和实际回复的型号对不上、响应可疑会直接标出来，侧栏上也会亮红点。也可以按日汇总、导出 CSV。' },
    { chapter: '用量明细', page: 'usage', before: () => usageView('projects'), target: '#page-usage .usage-records', wait: '#view-projects .pj-card', title: '按项目看用量', text: '每个项目文件夹被几个 Agent 对话改过、用了多少 Token 和额度，由哪些模型 × 思考等级组成。' },

    { chapter: '供应商', page: 'providers', before: providers('overview'), target: '#page-providers .pv-nav [data-section="overview"]', title: '供应商 · 一键切换', text: '为 Claude Code、Claude 桌面端、Codex、Grok CLI、DeepSeek Harness 和 pi 切换模型供应商：官方登录、第三方 API Key，或者你建的号池。每家工具的模型候选和思考等级分开设置；改工具配置前都会先给你看逐行对比，确认后才写，并自动备份。' },
    { chapter: '供应商', page: 'providers', before: providers('overview'), target: '#page-providers .pv-nav [data-section="claude"]', title: '添加供应商和号池', text: '在某个工具下面点「添加供应商」：填地址、Key 和模型就行，接口格式不一样（比如让 Claude Code 用 OpenAI 格式的模型）也能用，本地路由会自动转换。号池能把几个官方账号或 API Key 放在一起轮流用，有四种轮换方式：轮询、用满再换、快重置优先、剩余最多；额度用完的号会自动避开。' },
    { chapter: '供应商', page: 'providers', before: providers('router'), target: '#page-providers .pv-nav [data-section="router"]', title: '本地路由', text: '第三方供应商、跨格式和号池都经过本机的本地路由转发：真实 Key 只留在 TokenPulse 里，工具配置里写的是占位。一家出错可以自动换备用的；退出 TokenPulse 时工具配置会还原成直连。' },
    { chapter: '供应商', page: 'providers', before: providers('pass'), target: '#page-providers .pv-nav [data-section="pass"]', title: '透明转发：量官方模型有多快', text: '用官方登录时，打开透明转发，请求原样经过本机一下：只计时、读回复里的 Token 数，凭据还是工具自己的。这样官方模型也能画出速度走势。' },
    { chapter: '供应商', page: 'providers', before: providers('logs'), target: '#page-providers .pv-nav [data-section="logs"]', title: '转发记录', text: '每一次经过本地路由或透明转发的请求都记下来，永久保存：交给了谁、状态、耗时、首字、速度。号池换了哪个账号、哪次失败换了下一个，都能在这里看到。' },
    { chapter: '供应商', page: 'providers', before: providers('safety'), target: '#page-providers .pv-nav [data-section="safety"]', title: '配置保护和导入', text: '「配置保护」里能看每次改动前后的备份、一键还原，担心改坏可以打开只读保护。「导入供应商」能把 CC Switch 里已有的供应商一次导进来。' },

    { chapter: '会话与监控', page: 'sessions', target: '#nav [data-page="sessions"]', title: '会话管理', text: '查看本机 Agent 的对话历史，复制项目地址，或者直接在 TokenPulse 里接着回复。' },
    { chapter: '会话与监控', page: 'sessions', target: '#page-sessions .sw-new-row', title: '新对话、新项目', text: '「新对话」在已有的项目里开一段新对话，「新项目」先选或新建一个文件夹；选好工具后，TokenPulse 在那个文件夹里打开终端启动它。会话的「更多」里还能在终端里接着聊。' },
    { chapter: '会话与监控', page: 'egress', target: '#nav [data-page="egress"]', title: '出口监控', text: '分别检测三家的出口 IP，偏离白名单或地区规则时提醒，还能在出口不对时暂停查询额度。' },
    { chapter: '会话与监控', page: 'egress', target: '#page-egress .egress-toolbar', title: '检测间隔，和启动前核对出口', text: '「检测间隔」可以填 5 到 60 秒。开着监控、并给某一家设了白名单时，凡是 TokenPulse 启动的这一家的 CLI 都会先核对出口：设了 IP 白名单就看 IP，只设了地区白名单就看地区。监控关着，或者两个白名单都没设，就直接启动。' },
    { chapter: '会话与监控', target: '#nav [data-page="concurrency"]', title: '并发监控', text: '看清经过本机的 AI 请求同时有多少个、各连到哪：活跃请求、客户端连接、上游连接，以及按供应商和账号分开的数字。可以给每家设上限，超了提醒或直接拒绝新请求，历史记录能回头看。点侧栏的「并发监控」打开。' },

    { chapter: '个性化与设置', page: 'overview', target: '#layout-edit', title: '编辑布局', text: '点这里进入编辑：每张卡片和侧栏的每一页上沿都有把手和 ×，拖动换位置、点 × 隐藏，能撤销。藏起来的东西在原处留一条虚线，点「显示」回到原位；右边的布局面板按页面列出全部，每页都能恢复默认。只记在这台电脑上。' },
    { chapter: '个性化与设置', page: 'overview', target: '#settings-open', title: '设置', text: '「官方账号」里可以登录多个账号，在 TokenPulse 里登录过的能一键「切到 CLI」，不用再去终端里登出登录；也能添加 DeepSeek 和第三方 Key 的余额账号。另外还有额度提醒、额度查询间隔、语言和主题、关窗口时收进托盘、开机启动。以后想再看这份引导，到 设置 → 关于 里重新打开。' },
  ];
  /** 章节：名字和第一步。 */
  const CHAPTERS = [...new Set(STEPS.map(step => step.chapter))];

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

  function tourSteps() {
    return STEPS.filter(step => {
      if (step.page && window.layoutHidesPage?.(step.page)) return false;
      if (step.target === '#quota-cards' && window.layoutHidesCard?.('quota')) return false;
      if (step.target === '#overview-analysis .analysis-grid' && window.layoutHidesCard?.('trend') && window.layoutHidesCard?.('rhythm')) return false;
      return true;
    });
  }
  async function startGuide() {
    if (tour) return;
    const steps = tourSteps();
    notesOpen?.done(false);
    if (!$('settings').hidden) window.closeModal?.('settings');
    const last = document.activeElement;
    const saved = typeof state !== 'undefined' ? { account: state.account, usageView: state.usageView } : null;
    const layer = el('div', { class: 'tour', role: 'presentation' });
    const spot = el('div', { class: 'tour-spot', 'aria-hidden': 'true' });
    const count = el('span', { class: 'tour-count' });
    const chapter = el('span', { class: 'tour-chapter' });
    const tocButton = el('button', { type: 'button', class: 'text-btn tour-toc-btn', 'aria-expanded': 'false', 'aria-controls': 'tour-toc', text: '目录' });
    const toc = el('div', { id: 'tour-toc', class: 'tour-toc', role: 'menu', hidden: '' });
    const badge = el('span', { class: 'tour-demo', text: '演示数据', title: '引导里显示的是虚构的演示账号，不是你的数据', hidden: '' });
    const title = el('h3', { id: 'tour-title' });
    const text = el('p', { id: 'tour-text' });
    const bar = el('div', { class: 'tour-bar', 'aria-hidden': 'true' }, [el('i')]);
    const skip = el('button', { type: 'button', class: 'text-btn tour-skip', text: '跳过引导' });
    const prev = el('button', { type: 'button', class: 'btn', text: '上一步' });
    const next = el('button', { type: 'button', class: 'btn btn-accent' });
    const card = el('section', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' }, [
      el('div', { class: 'tour-top' }, [el('span', { class: 'tour-meta' }, [chapter, count, badge]), el('span', { class: 'tour-top-actions' }, [tocButton, skip])]),
      toc,
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
    const closeToc = () => { toc.hidden = true; tocButton.setAttribute('aria-expanded', 'false'); };
    const openToc = () => {
      const here = steps[self.index]?.chapter;
      toc.replaceChildren(...CHAPTERS.map(name => ({ name, first: steps.findIndex(step => step.chapter === name), size: steps.filter(step => step.chapter === name).length })).filter(item => item.first >= 0).map(item => {
        const b = el('button', { type: 'button', role: 'menuitem', class: 'tour-toc-item' + (item.name === here ? ' on' : '') }, [el('b', { text: item.name }), el('small', { text: `${item.size} 步` })]);
        b.addEventListener('click', () => { closeToc(); show(item.first); });
        return b;
      }));
      toc.hidden = false; tocButton.setAttribute('aria-expanded', 'true');
      (toc.querySelector('.on') || toc.querySelector('button'))?.focus();
      schedule();
    };
    tocButton.addEventListener('click', () => (toc.hidden ? openToc() : (closeToc(), schedule())));
    const schedule = () => { cancelAnimationFrame(self.frame); if (tour === self) self.frame = requestAnimationFrame(place); };

    const show = async i => {
      const step = steps[i], token = ++self.token;
      self.index = i;
      count.textContent = `${i + 1} / ${steps.length}`;
      chapter.textContent = step.chapter || '';
      closeToc();
      title.textContent = step.title;
      text.textContent = step.text;
      bar.firstChild.style.width = `${((i + 1) / steps.length) * 100}%`;
      prev.hidden = i === 0;
      next.textContent = i === 0 ? '开始' : i === steps.length - 1 ? '完成' : '下一步';
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
      const home = window.layoutHidesPage?.('overview') ? window.layoutFirstPage?.() : 'overview';
      if (home) window.navigate?.(home);
      else window.showLayoutEmpty?.();
      if (self.last?.isConnected) self.last.focus?.();
    };
    const onKey = event => {
      if (event.key === 'Escape' && !toc.hidden) { event.preventDefault(); event.stopPropagation(); closeToc(); tocButton.focus(); schedule(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); }
      else if (!toc.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); const items = [...toc.querySelectorAll('button')], i = items.indexOf(document.activeElement); items[(i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
      else if (event.key === 'ArrowRight' && self.index < steps.length - 1) { event.preventDefault(); show(self.index + 1); }
      else if (event.key === 'ArrowLeft' && self.index > 0) { event.preventDefault(); show(self.index - 1); }
      else trapTab(event, card);
    };
    skip.addEventListener('click', finish);
    prev.addEventListener('click', () => show(Math.max(0, self.index - 1)));
    next.addEventListener('click', () => (self.index === steps.length - 1 ? finish() : show(self.index + 1)));
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

  /** 等启动页收起、首页第一次画完再弹，免得引导框住的是启动页（0.3.38）。第一次扫描可能要一阵，所以不设上限。 */
  function whenReady() {
    return new Promise(resolve => {
      const booted = () => { const node = $('boot'); return !node || node.classList.contains('done'); };
      const check = () => (booted() ? setTimeout(resolve, 450) : setTimeout(check, 150));
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

  window.PulseIntro = { startGuide, active: () => Boolean(tour), demo: () => Boolean(tour?.demo), showNotes: v => showNotes(v || version, { fromSettings: true }), steps: STEPS.length, titles: () => STEPS.map(step => step.title), chapters: CHAPTERS, notes: NOTES };
  boot();
})();
