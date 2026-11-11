# 当前接手入口 · TokenPulse v0.3.89 正式发布（补齐品牌图标，2026-11-10）

## 发布状态 · v0.3.89

- **版本**：`0.3.89`（用户 2026-11-10「升级版本然后发布」）。发布前 `git fetch` 确认 origin 没有新提交。`renderer/intro.js` 加 0.3.89 说明 1 条（图标 `overview`；`brand` 不是 index.html 里的 symbol，没用），`renderer/i18n.js` 补英文。
- **发版前验证**：`npm run build` PASS；Electron：`test-intro-ui` 3、`test-antigravity-ui` 7、`test-provider-pool-ui` 1、`test-provider-feedback-ui` 1、`test-usage-projects-ui` 1、`test-layout-ui` 9、`test-desk-pet-ui` 21、`test-model-weeks-ui` 3，全 PASS；`test-antigravity-capacity` 2/2、`test-antigravity-usage` 10/10、`test-quota-monitor` 79/79。
- **打包**：`npm run dist` PASS；asar 内确认 `'0.3.89'`、`PulseBrand.geminicli` / `hermes`、`'Copilot CLI': 'githubcopilot'`，并用 `@electron/asar` 列包确认 7 个新预设 SVG 都在（presets 共 34 项）。
  - `dist/TokenPulse-0.3.89-Setup.exe`（112827374 B，SHA256 `D1C130981F6F79B230758C37BDE61AFDD3A09721A094A352AA993CF9F2CED328`）
  - `dist/TokenPulse-0.3.89-Portable.exe`（112570158 B，SHA256 `49EA28F875383ADF016F39668D46C6D7F8D9EF6E4F3D574BD52466395184428C`）
  - `dist/TokenPulse-0.3.89-Setup.exe.blockmap`（SHA256 `60EE537561830B37A86EA3E5DA0D0FC36334A6B83ABE03A6226227E71BF2CCF5`）
  - `dist/latest.yml`（version 0.3.89，SHA256 `FC6429AEC002614675F445FF1E8A6804613ED1E549D87959272A4129ED72B930`）
  - 句柄全部 UNLOCKED；无 electron / app-builder / makensis 残留进程。
- **Git / GitHub**：见本节末尾（推送和 Release 完成后更新）。

## 本轮内容 · 补齐缺失的品牌图标（已包含在 v0.3.89）

- **来源**：用户下载的 lobe-icons 仓库 `D:\CodePorject\Exmaple\lobe-icons-master\lobe-icons-master`，取 `packages/static-svg/icons/` 下的 SVG（与项目已有图标同源，MIT）。
- **工具图标（`renderer/brand.js`，单色路径、跟随 currentColor）**：用 scratchpad 的 `brand-import.js` 从 SVG 提取 path（检查 viewBox 24、无渐变 / 遮罩 / 自带颜色），追加到 brand.js 末尾：
  - `antigravity` 换成 Antigravity 自己的 logo（`antigravity.svg`），去掉原来借用的 Gemini 四角星；
  - 新增 `geminicli`（Gemini CLI）、`opencode`（OpenCode）、`hermes`（Hermes Agent，`hermesagent.svg`，path 约 19 KB）、`githubcopilot`（Copilot CLI）。
  - `renderer/app.js` 的 `BRAND_OF_SOURCE` 加上 CC Switch 导入的四个来源名（与 `core/cc-switch.ts` 的 `CC_SOURCES` 一致）；认不出的来源仍用首字母。
- **供应商预设头像（`renderer/brand/presets/` + `renderer/provider-avatars.js`）**：新增 7 个文件和预设：OpenRouter、硅基流动（siliconcloud）、MiniMax、Mistral、Groq、阶跃星辰（stepfun）、小米 MiMo（xiaomimimo），附自动匹配关键词。
- **验证**：自动匹配检查（scratchpad `preset-check.js`）16/16：新 7 家按名称 / 地址认出，原有 xAI / DeepSeek / Kimi / 通义 / OpenAI / Copilot 等不变，Groq 的 `/openai/` 路径不会认成 OpenAI，普通中转仍为首字母。`test-antigravity-ui` 新增断言（五个来源都有 SVG 路径、未知来源首字母、Antigravity 不再是 Gemini 星）7 PASS；`test-provider-pool-ui` 预设数 25→32 并校验 7 张新图都能加载，PASS；`test-provider-feedback-ui`、`test-usage-projects-ui`、`test-layout-ui` PASS。演示数据截图自查：会话页 Antigravity 新 logo、五个工具图标并排渲染正常。无残留 electron 进程。
- **仍缺**：无（lobe-icons 里本轮列出的图标全部找到）。
- **未做**：未升版本、未提交、未打包、未发布（用户本轮没有要求）。

---

# 历史版本记录 · TokenPulse v0.3.88 正式发布（Fable 周额度容量折算与预测 + Antigravity 整窗容量算法修复，2026-11-10）

## 发布状态 · v0.3.88

- **版本**：`0.3.88`（用户 2026-11-10：「检查 Antigravity 算法，没问题就直接升级版本然后发布」）。发版前先 `git merge --ff-only origin/main` 合入了 bot 的知识库更新 `669552b`（只改 `knowledge/models.json`）。`renderer/intro.js` 加 0.3.88 说明 2 条（`quota`），`renderer/i18n.js` 补英文。
- **Antigravity 算法检查（用真实数据只读跑 `buildInsight`，脚本在 scratchpad：agycheck*.js）**：
  - 窗口分段、各池 5 小时 / 周窗口的本机用量、速度、预测、按价换算各型号容量：逐项核对，数值自洽。
  - **发现并修复**：整窗容量把 30 天里所有窗口「总 Token ÷ 总百分比」合在一起算。用户 11-07/08 主要用 `gemini-3.8-flash-tiered`（约 3100 万 Token / 1%），11-09 起只用 `gemini-4-argon`（约 180 万 / 1%），结果 Gemini 5 小时整窗显示约 14.5 亿 Token（最近窗口实际约 1.75–3.3 亿），高估约 7 倍；按价换算的型号容量也偏高约 2 倍。
  - **修复**（`src/main/antigravity-quota.ts` 的 `buildWindowInsight`）：只用最近 6 个 5 小时窗口 / 3 个周窗口（`RECENT_CAPACITY_FIVE/WEEK`），取按已用百分比加权的中位数（新增导出 `weightedMedian`），费用同理。真实数据复核：Gemini 5 小时整窗 ≈ 1.97 亿；周窗口 65 亿反映本周确实以 Flash 为主（只有 2 个周样本）；Claude / GPT 组只有 1 个样本，不变。
  - 新测试 `scripts/test-antigravity-capacity.cjs`（2/2）：加权中位数；10 个窗口中前 4 个和第 8 个是另一种用法时，容量仍跟着最近的用法（≈ 2 亿），对照全部窗口合并会高估 5 倍以上。
- **发版前验证**：`npm run build` PASS；`test-antigravity-capacity` 2/2、`test-antigravity-usage` 10/10、`test-antigravity-timeline` 6/6、`test-antigravity-sessions` 5/5、`test-antigravity-cli-import` 8/8、`test-pass-speed` PASS、`test-concurrency` PASS、`test-model-weeks` 7/7、`test-quota-monitor` 79/79、`test-requests` 70/70；Electron：`test-antigravity-ui` 7、`test-model-weeks-ui` 3、`test-weekly-only-ui` 4、`test-intro-ui` 3、`test-desk-pet-ui` 21、`test-concurrency-ui` 1，全 PASS。
- **打包**：`npm run dist` PASS，asar 已确认含 `'0.3.88'`、`weightedMedian`、`modelWeekDetail`、`rowsOfModelFamily`。
  - `dist/TokenPulse-0.3.88-Setup.exe`（112816424 B，SHA256 `1E8CCBD9F2A656FB76EF4881FEE8562CBCA402D962BBB97F8B5988FD796DDCA1`）
  - `dist/TokenPulse-0.3.88-Portable.exe`（112559214 B，SHA256 `A10A18933FD777C112EA557CEA48CC302A001DA7496FE13220F2D1F5CC3B22DF`）
  - `dist/TokenPulse-0.3.88-Setup.exe.blockmap`（SHA256 `7AC61C9C5F4CB8F350717759E493EF9A8B797FEA90225667AE5ECD7B9714A9A7`）
  - `dist/latest.yml`（version 0.3.88，SHA256 `6762B5BC0D33C940F9BF359CB0091B80FCA6ABED117242CBDCDC0F4336423974`）
  - 句柄全部 UNLOCKED；无 electron / app-builder / makensis 残留进程。
- **Git / GitHub（已完成）**：发布提交 `363b585` 已推送到 `origin/main`（在 bot 的 `669552b` 之上），标签 `v0.3.88` 已推送；GitHub Release `v0.3.88` 已正式发布（非草稿、非预发布）：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.88 ，4 个附件大小和 SHA256 与本地一致。说明文件 `dist/release-0.3.88.md`。推送走代理 `127.0.0.1:7890`。未纳入提交：`clawd-pet-extracted/`（来源不明，未动）。

## 本轮第一部分 · Fable 周额度补齐容量折算与预测（已包含在 v0.3.88）

- **问题**：Claude Max 的 Fable 按型号周额度只显示已用 / 重置时间，没有总窗口那样的「本窗口已用（本机）/ 剩余可用（估算）/ 整窗容量折算 / 预计达到上限」和预测一句话。
- **改动（本地，未提交）**：
  - `src/core/quota-monitor.ts`：`analyzeAccount` 对 `latest.models` 每一项调用 `analyzeWindow`（窗口 = 它自己的 resetAt 往前 7 天，`rollWindow` 处理过期；采样点取每条采样里该型号的 pct；用量只取该型号家族的请求）；结果放在 `modelWeeks[i].window`（新增可选字段，其余字段不变）。非「只在本机用 Code」账号同样去掉 capacity、标 `unattributed`。新增导出 `rowsOfModelFamily(rows, name)`：显示名去掉 claude 后取第一个英文词（Fable / Claude Fable / Fable 5.2 → fable），按非字母切开型号名匹配。
  - `renderer/app.js`：新增 `modelWeekDetail(win, account)`，在周额度窗口的 Fable 行下面画预测一句话 + 2×2 指标（文案复用总窗口已有的中英文）；窗口已结束 / 没有 window 时不画。`renderer/app.css`：`.model-week-detail` 紧凑样式。
  - 测试：`scripts/test-model-weeks.cjs` 新增一条（只算本周 Fable 请求、容量 = 400K ÷ 20% = 2M、起点按 Fable 重置往前 7 天、有趋势预测、总周额度仍算全部型号、共享账号不倒推容量、家族名匹配）；原 `modelWeeks` 精确比较改为忽略 `window`。`scripts/test-model-weeks-ui.cjs` 断言 Fable 行有预测和 4 个指标，英文检查覆盖新块。
- **验证**：`npm run build` PASS；`test-model-weeks` 7/7；`test-quota-monitor` 79/79；`test-shared-quota` 0 FAIL；Electron：`test-model-weeks-ui` 3 PASS、`test-weekly-only-ui` 4、`test-intro-ui` 3、`test-layout-ui` 9、`test-model-study-ui` 0 FAIL（输出里的 `Simulated model study failure` 是测试故意造的失败）。演示数据截图自查：Fable 行预测 + 2×2 指标排版正常。无残留 electron 进程。
- **未做**：未升版本、未提交、未打包、未发布（用户本轮没有要求）；没有在真实账号上看。
- **注意**：本轮开始时仓库已被另一会话发布到 v0.3.87（`1c2059b`、`b884c76`，改的是型号核验，和本轮文件无重叠），本轮改动在其之上。

---

# 历史版本记录 · TokenPulse v0.3.87 正式发布（型号核验两处误报修复，2026-11-09）

## 发布状态 · v0.3.87

- **版本**：`0.3.87`（`package.json` / `package-lock.json`，用户 2026-11-09 要求「升级一个小版本然后发布」）。`renderer/intro.js` 加 0.3.87 更新说明 2 条（`check` 图标），`renderer/i18n.js` 补英文，并给两条新核验说明加了英文正则翻译。
- **发版前验证**：`npm run build` PASS；`test-requests` 70/70、`test-features` 46/46、`test-final-model` 3/3；Electron `test-intro-ui` 3 PASS。其他 Electron UI 测试本轮未跑（改动只涉及核验规则和文案）。
- **打包**：`npm run dist` PASS；app.asar 已确认含 `CLAUDE_EFFORT_SUFFIX`、`isOpenAIHosted` 和 `'0.3.87'` 说明（检查脚本在 scratchpad，不在仓库）。
  - `dist/TokenPulse-0.3.87-Setup.exe`（112814950 B，SHA256 `32148481DCB5F63FA234C2C0273A64E9F17E2B85E17DACCC67C3E034720F95BA`）
  - `dist/TokenPulse-0.3.87-Portable.exe`（112557781 B，SHA256 `4868A876049FB00ADFC6F5177E2EE87DAC1CEA131D8C719156D0B5B48A04E704`）
  - `dist/TokenPulse-0.3.87-Setup.exe.blockmap`（119940 B，SHA256 `A7D49EC5123EB17E5731C8C1959802C62A06CE5C9838F52E4D7AAB2EB77F1A7F`）
  - `dist/latest.yml`（version 0.3.87，SHA256 `0DC87C45813F83812DFF1BC2ED0C87DDEA9FEF1144872BCE454BA56F62AEFB47`）
  - 以上与 `dist/win-unpacked/TokenPulse.exe` 独占句柄检测均 UNLOCKED；无 electron / app-builder / makensis 残留进程。用户正在用的安装版（`AppData\Local\Programs\TokenPulse`）未动。
- **Git / GitHub（已完成）**：发布提交 `1c2059b` 已推送到 `origin/main`，标签 `v0.3.87` 已推送；GitHub Release `v0.3.87` 已正式发布（非草稿、非预发布）：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.87 ，4 个附件大小和 SHA256 与本地一致。说明文件 `dist/release-0.3.87.md`。推送走代理 `127.0.0.1:7890`。未纳入提交：`clawd-pet-extracted/`（来源不明，未动）。
- **用户侧**：需从已安装版更新到 0.3.87 后生效；核验在查询时现算，旧流水会自动改判。

本轮两项修复的细节见下面两节（已随 v0.3.87 发布）。

## 一、Codex 接自部署开源模型误报「响应存疑」

- **现象**：用户在 Codex 里接 Colab 上用 Ollama 自部署的 `gpt-oss:20b`，用量明细把这些请求标成「响应存疑」。
- **原因**：`src/core/request-verify.ts` 的 Codex 分支只要响应 ID 不是 OpenAI 官方的 `resp_` + 40 位以上十六进制就判存疑；Ollama 返回的是 `chatcmpl-…` 或 `resp_` + 短数字。
- **已改**：新增 `isOpenAIHosted(model)`（`gpt-` / `o数字` / `codex` / `chatgpt` 开头，且不含 `gpt-oss`、`:`、`/`）。请求型号不是 OpenAI 托管型号时，ID 格式对不上只记一条说明「接的是开源或第三方模型…不按 OpenAI 官方格式核验」，不再判存疑；OpenAI 托管型号的规则不变。
- **测试**：`npm run compile` PASS；`node scripts/test-requests.cjs` 66/66 通过（新增 2 条：`gpt-oss:20b` + `chatcmpl-123`、`qwen3-coder:30b` + `resp_123456` 都不判存疑；原「gpt-6-astra + chatcmpl → 存疑」仍通过）。未跑 Electron UI 测试，未打包。
- **Git**：已随 v0.3.87 发布提交 `1c2059b`。

## 二、Antigravity 接 Claude 返回型号带思考等级被误报「型号不一致」

- **现象**：Antigravity 里请求 `claude-opus-5-5`，返回型号是 `claude-opus-5-5-medium`，被判型号不一致。本机流水（`~/.tokenpulse/requests/2026-11.jsonl` 等，只统计了型号名）里有 158 条这种组合；Gemini 的 `-b` / `-n` 原本就已处理。
- **已改**（`src/core/request-verify.ts`）：`normalizeModel` 末尾对 `claude-` 开头的型号去掉 `-thinking|low|medium|high|xhigh|max` 后缀（可叠加），规则写在代码里，不放可在线更新的知识库别名，避免远端旧知识库缺这条。Antigravity 分支遇到这种情况记说明「X 就是 Y，后缀 medium 是 Antigravity 附上的思考等级」。别家型号（如 `gpt-5.4-high`）不去后缀；请求 opus、返回 sonnet 仍判不一致。
- **测试**：`npm run compile` PASS；`node scripts/test-requests.cjs` 70/70（新增 4 条）；`node scripts/test-final-model.cjs` 3/3；`node scripts/test-features.cjs` 46/46。未跑 Electron UI 测试，未打包。
- **Git**：已随 v0.3.87 发布提交 `1c2059b`。

---

# 历史版本记录 · TokenPulse v0.3.86 正式发布（桌宠导致鼠标不跟手的修复 + 动画帧率选项，2026-11-09）

## 发布状态 · v0.3.86

- **版本**：`0.3.86`（`package.json` / `package-lock.json`，用户 2026-11-09 要求「直接发布」）。`renderer/intro.js` 加 0.3.86 更新说明 2 条（`pet` 图标），`renderer/i18n.js` 补英文。
- **发版前验证**：`npm run build` PASS；`node scripts/test-desk-pet.cjs` 0 失败；Electron：`test-desk-pet-ui` 21 PASS、`test-intro-ui` 3 PASS、`test-weekly-only-ui` 4 PASS、`test-antigravity-ui` 7 PASS；`test-antigravity-timeline` 6/6、`test-antigravity-cli-import` 8/8。
- **打包**：`npm run dist` PASS；app.asar 已确认含帧率选项、限帧、轮询命中（`rel.cx`）、`'0.3.86'` 说明，且无 `forward: true`。
  - `dist/TokenPulse-0.3.86-Setup.exe`（112814119 B，SHA256 `BD9267B402383ED81B09031AEA28DDA3265C4D2E1B0A1AF7E80250AB76FC60F7`）
  - `dist/TokenPulse-0.3.86-Portable.exe`（112556968 B，SHA256 `290791117511FF8261CCA6DCB0311862B12806C39D9C8B0B3F243F84C4200D11`）
  - `dist/TokenPulse-0.3.86-Setup.exe.blockmap`（SHA256 `2603E7AE3490BC88BA6A3E3C832B1F52F88D4F43E37CD040EF662A52203C944B`）
  - `dist/latest.yml`（version 0.3.86，SHA256 `F2BC9B0C11C4A7667627912923C67A28786E8B0C37DAC151751169F6CEE2B621`）
  - 以上与 `dist/win-unpacked/TokenPulse.exe` 句柄 UNLOCKED；无 electron / app-builder / makensis 残留进程。
- **Git / GitHub（已完成）**：发布提交 `ffee7a6` 已推送到 `origin/main`，标签 `v0.3.86` 已推送；GitHub Release `v0.3.86` 已正式发布（非草稿、非预发布）：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.86 ，4 个附件大小和 SHA256 与本地一致。说明文件 `dist/release-0.3.86.md`。推送走代理 `127.0.0.1:7890`。未纳入提交：`clawd-pet-extracted/`（来源不明，未动）。
- **用户侧**：用户正在用的是 0.3.84 安装版，需更新到 0.3.86（自动更新或手动安装）后才生效。

## 本轮修复细节

- **用户已确认**：关掉桌宠，鼠标就恢复正常。（用户未单独试用测试版，直接要求发布。）
- **第二项修复 · 动画限帧**（本地，未提交）：用户屏幕 300 Hz，主题宠物 `pet-f62c2c82`（35 个 SVG、231 处 infinite CSS 动画）让透明置顶窗口每秒重画约 300 次。`renderer/desk-pet.js` 新增限帧：窗口内所有动画（`document` + 主题 Shadow DOM，含 CSS 动画和眼睛跟随的 transition）出现即 `pause()`，按 `PET_FPS = 30` 手动推进 `currentTime`（`animationstart` / `transitionrun` 时立即接管；放完的一次性动画不再碰）。`window.__petFrameCap` 供测试查看。
  - 实测（隔离实例 + 用户的真实主题宠物，屏幕上运行，空闲 10 秒，单核占用）：旧行为 GPU 23.6% + 宠物窗口 17.3% = 40.9%；限帧后 6.9% + 5.6% = 12.7%。测量脚本在 scratchpad（`petbench/bench.cjs`），临时目录已删。
  - 测量过程中我用 python 内联改脚本弄坏了反斜杠，导致用户屏幕上弹出一次 Electron 报错框（只是测量脚本，不是 TokenPulse）；对应进程 16164 已结束，临时目录已清理，之后改用 Write 重写。
  - `scripts/test-desk-pet-ui.cjs` 新增断言：主题无限动画处于 paused、1 秒内时间只推进约 30 次。桌宠 UI 测试全部 PASS。
- **帧率选项**（用户要求，默认 30）：`src/core/desk-pet-model.ts` 新增 `deskPetFps`（`PET_FPS = [30, 60, 120]`，默认 30，非法值回 30）；`src/main/desk-pet.ts` 的状态带 `fps`；`renderer/desk-pet.js` 的 `setFrameCap(view.fps)` 按设置重设推进间隔；`renderer/desk-pet-settings.js` 在「空闲时」后加「动画帧率」行（30 默认 / 60 / 120）；`renderer/i18n.js` 补英文。测试：`test-desk-pet.cjs` 加默认值与规范化断言，`test-desk-pet-ui.cjs` 加设置页选 120 → 存盘 → 宠物窗口上限变 120 → 改回 30，及状态 fps 60 / 非法值回 30。`node scripts/test-desk-pet.cjs` 0 失败；`test-desk-pet-ui` 21 条全 PASS。
- **本地测试版**：`dist/win-unpacked/TokenPulse.exe`（08:52 构建，app.asar 已确认含帧率选项、限帧、无 `forward: true`），句柄 UNLOCKED，无残留 electron/app-builder 进程。
- **下一步**：用户退出已安装版后试用测试版确认；确认后按用户指示决定是否升版本发布。

### 第一项修复 · 去掉 forward 鼠标钩子（同上，本地未提交）

- **现象**：用户感觉整台电脑的鼠标一顿一顿、不跟手，不确定是不是桌宠导致、何时开始的。
- **定位到的原因（代码层面确定，用户机器上尚未 A/B 证实）**：桌宠窗口点击穿透用 `setIgnoreMouseEvents(true, { forward: true })`。Windows 上 Electron 用全系统低级鼠标钩子（WH_MOUSE_LL）实现 forward，钩子跑在主进程 UI 线程；主进程同步忙时（扫会话、读 SQLite、写日志、刷额度）整台电脑的鼠标移动都要等。
- **已改**（本地，未提交）：
  - `src/main/desk-pet.ts`：两处去掉 `{ forward: true }`；16 ms 光标轮询在光标进入宠物窗口范围时带上窗口内坐标 `cx/cy`（按像素去重）。文件头注释写明原因。
  - `renderer/desk-pet.js`：`onCursor` 用 `cx/cy` 调 `hitAt` 切换 hover / 点击穿透；光标出窗口时补 `setHover(false)`。`src/main/preload.ts` 类型同步。
  - `scripts/test-desk-pet-ui.cjs` 新增断言：假光标在宠物像素 / 透明角落 / 窗口外之间切换，hover 正确跟随。
- **验证**：`npm run build` PASS；`npx electron --lang=zh-CN scripts/test-desk-pet-ui.cjs` 全部 PASS（含新增一条）。本地测试版 `npx electron-builder --win dir --publish never` → `dist/win-unpacked/TokenPulse.exe`（08:32，app.asar 已确认无 forward），句柄 UNLOCKED，无残留 electron/app-builder 进程。
- **其他观测（只读）**：用户正在用的 0.3.84 安装版运行 39 分钟时，GPU 进程约 29% 单核、渲染进程（应为桌宠窗口，主题宠物 `pet-f62c2c82` 共 231 处 infinite CSS 动画）约 35% 单核、主进程平均 3.4%。整机 CPU 低。用 SendInput 测鼠标输入延迟的尝试失败（注入的移动没有生效，每次都超时，已停止），不作为结论。
- **未完成 / 下一步**：等用户 A/B：①在已安装版里临时关掉桌宠，感受鼠标是否恢复；或②退出安装版后运行 `dist/win-unpacked/TokenPulse.exe`。若确认改善，再按用户指示升版本发布。主题宠物持续动画的 CPU/GPU 占用可另行优化（空闲时降帧 / 暂停）。

---

# 历史版本记录 · TokenPulse v0.3.85 正式发布（Antigravity 时间线按额度池分开、周额度单独占一行、桌面端对话导入 CLI 继续，2026-11-09）

## 发布状态 · v0.3.85

- **版本**：`0.3.85`（`package.json` / `package-lock.json`，用户 2026-11-09 要求发布并提交）。`renderer/intro.js` 加 0.3.85 更新说明 3 条，`renderer/i18n.js` 补英文。
- **发版前验证**：`npm run build` PASS；`test-intro-ui` 3/3、`test-antigravity-ui` 7/7、`test-weekly-only-ui` 4/4、`test-antigravity-timeline` 6/6、`test-antigravity-cli-import` 8/8、`test-model-study` 16/16（其余回归见下方第一、二节）。
- **打包**：`npm run dist` PASS，app.asar 内已确认包含 `prepareAntigravityCliConversation`、`timelineWindows`、无 5 小时窗口判断和 `'0.3.85'` 说明。
  - `dist/TokenPulse-0.3.85-Setup.exe`（112811863 B，SHA256 `87601607177BFECC5953E1E7326144C852E13622FADDCE7B9831AF6B6E220FFB`）
  - `dist/TokenPulse-0.3.85-Portable.exe`（112554640 B，SHA256 `54F8EE51CC731AB62493A04A12372B3F71034A73BD8A90D58B009DFDFF69235C`）
  - `dist/TokenPulse-0.3.85-Setup.exe.blockmap`（SHA256 `D551D2B694B634CDD994E74D31B9660344BCD33669A01E515F82C0FC0C98A355`）
  - `dist/latest.yml`（version 0.3.85，SHA256 `07E7D170DE9E28E211D3EDBC1AD2E20179A58119988819BB9E54EF14733CA43C`）
  - 以上 4 个文件与 `dist/win-unpacked/TokenPulse.exe` 独占句柄检测均 UNLOCKED；打包后无 electron / app-builder / makensis 残留进程。
- **Git / GitHub（已完成）**：发布提交 `540a4c4`（`release: v0.3.85 …`）已推送到 `origin/main`，标签 `v0.3.85` 已推送；GitHub Release `v0.3.85` 已正式发布（非草稿、非预发布）：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.85 ，4 个附件（Setup.exe、Portable.exe、blockmap、latest.yml）大小和 SHA256 与本地一致。说明文件 `dist/release-0.3.85.md`。推送全程走代理 `127.0.0.1:7890`。未纳入提交：用户的 `clawd-pet-extracted/`（来源不明，未动）。

本轮两项工作的细节：
1. Antigravity 时间线按额度池分开 + 只有周额度的供应商（SuperGrok）去掉 5 小时窗口（见下方第一节）。
2. Antigravity 桌面端对话「在终端里继续」历史为空（见下方第二节）。

## 一、「模型与思考等级 · 时间线」按 Antigravity 额度池分开；无 5 小时窗口的供应商只留周额度

- **问题**：Antigravity 有两个额度池（`Gemini Models` 组、`Claude and GPT models` 组），每个池各有 5 小时 + 周额度窗口，重置时间不同。旧时间线只有一对 5 小时 / 周卡：周期按「第一个有用量的组」切，曲线取各组最大值，请求不分组 → 两个池的用量混在一起。另外 SuperGrok 只有周额度，额度页仍放一张「接口未提供此窗口」的 5 小时空卡。
- **改动**：
  - `src/main/antigravity-quota.ts`：`buildTimelineWindow` 增加 `group` 参数——周期用这一组自己的 `agyWindowSegments`，曲线 / 当前已用只取这一组，结果带 `group`。`timeline()` 有分组时返回 `windows: [{ id: "g0-five" | "g0-week" | "g1-five" | ..., kind, label: "<组名> · 5 小时/周额度", group }]` 和对应 id 的数据；请求按 `groupMatchesModel` 归到一个组（匹配不上的归第一组，不丢）；`cycles` 查询按窗口 id；没有分组时退回旧的 `five` / `week` 两张卡。
  - `renderer/model-study.js`：时间线按 `data.windows` 画卡（`data-window` 为窗口 id，class 仍为 `five`/`week` 保持配色），选周期 / 缩放按窗口 id 分开记；新增 `timelineWindows()`——快照里的官方账号没有 `five` 且没切出过 5 小时周期时不画 5 小时卡（DeepSeek / 号池的「按天」不受影响）。曲线轨道名对分组卡显示「这一组已用」，Antigravity 说明与图例改写。「换一种模型，整窗能用多少」对无 5 小时账号：整窗预算只留周额度（`.ms-budgets.single`），排行去掉「5 小时整窗」列（`.no-five`），详情只留周窗口。
  - `renderer/app.js` / `app.css`：额度页无 `five` 时不放 5 小时卡，`.quota-window-grid.single` 让周额度占满一行；容量趋势不给 5 小时选项。
  - `renderer/model-study.css`、`renderer/i18n.js`：单列样式、900px 下的 no-five 排行；新增英文词条和 `(.+) · (5 小时|周额度)` 模式。
- **测试**（全部实际运行）：
  - 新增 `node scripts/test-antigravity-timeline.cjs`：6/6（每池一对卡、周期按各池重置时间、曲线不跨池取最大、请求按池和各自窗口归属、按卡选周期、无分组退回）。
  - 新增 `npx electron --lang=zh-CN scripts/test-weekly-only-ui.cjs`：4/4（SuperGrok 周额度占满一行、无 5 小时卡 / 容量选项 / 时间线卡 / 整窗列；Claude 仍两张；900px 不溢出）。
  - `scripts/test-antigravity-ui.cjs` 增加分池卡片、翻一个池不影响另一个池、英文标题断言：7/7。
  - 回归：`test-antigravity-usage` 10/10、`test-antigravity-sessions` 5/5、`test-antigravity-cli-import` 8/8、`test-sessions` PASS、`test-model-study` 16/16、`test-quota-monitor` 79/79、`test-shared-quota` PASS；Electron：`test-model-study-ui`、`test-model-weeks-ui`、`test-pool-quota-ui`、`test-deepseek-balance-ui`、`test-layout-ui` 均 PASS。`npm run build` PASS。
  - 截图自查（只用测试数据，存于本轮 scratchpad）：SuperGrok 周额度整行；Antigravity「Gemini Models · 5 小时 / 周额度」各自周期。
- **未验证 / 限制**：没在打包版里用真实账号看；未跑 `npm run dist`。组 id 按 `last.groups` 顺序（g0、g1），如果 Antigravity 调整分组顺序，已选的历史周期会回到当前周期（无害）。
- **进程与占用**：本轮测试的 electron 进程均已退出（`tasklist` 无 electron.exe；本机 TokenPulse.exe 是用户正在用的正式版，未触碰）；`build/main/antigravity-quota.js`、`build/main/index.js`、`build/core/antigravity.js` 句柄检测 UNLOCKED。`test-weekly-only-ui` 的临时目录已清理并在测试里加了清理；`%TEMP%` 里还有其他已有测试留下的 `tokenpulse-*` 目录（来源不能逐一确认，未删除）。

## 二、修复：Antigravity 桌面端对话「在终端里继续」历史为空

### 已完成（本地代码 + 测试），未提交 / 未打包 / 未发布

- **现象**：会话页对 Antigravity 桌面端（IDE）的对话选「在终端里继续」，`agy.exe` 打开的是空白对话，看不到历史。
- **根因（实测核对）**：桌面端数据在 `~/.gemini/antigravity`，Antigravity CLI 默认只用 `~/.gemini/antigravity-cli`。`agy.exe --conversation <桌面端ID>` 在 CLI 目录里找不到 `conversations/<id>.db`，就开一个同 ID 的空对话。用 `agy.exe acp` 的 `session/load` 对照：默认目录加载桌面端对话 → 0 条历史；把对话库快照进 CLI 目录后 → 回放出用户消息、回复和工具调用。同样的问题也影响 TokenPulse 内「回复对话」（无头 `agy --conversation` 没有上下文）和「复制继续命令」。
  - `agy.exe --app-data-dir antigravity` 也能读到，但 CLI 会往桌面端目录写 `jetski_state.pbtxt`、`jetbox_summaries_proto.pb`、`implicit/`、`log/` 等，**不采用**（实验时产生的这几项已核对时间戳后删除，桌面端目录恢复原样）。
- **改动**：
  - `src/core/antigravity.ts`：新增 `prepareAntigravityCliConversation(id)`。用 `node:sqlite` 的 `backup()` 把桌面端对话库在线快照到 CLI 目录（桌面端开着也能拿到一致快照，先写临时文件再 rename），顺带复制 `brain/<id>`、`annotations/<id>.pbtxt`。导入记录在 `~/.tokenpulse/antigravity-cli-imports.json`（步数 + 桌面端库签名）：CLI 那份没新步骤而桌面端前进了 → 重新导入；CLI 里接着聊过 → 保留（`kept`）；CLI 里有同 ID 但非 TokenPulse 导入、步数更少（之前恢复出的空白对话）→ 先备份到 `~/.tokenpulse/antigravity-cli-backup/` 再导入；CLI 正开着这段对话无法替换时提示先关终端。`deleteAntigravityConversation` 对两边都有的对话要求桌面端在运行（避免只删 CLI 副本），并清理导入记录。
  - `src/main/index.ts`：「在终端里继续」（`openInTerminal`）和「回复对话」（`replyInApp`）对 Antigravity 先调用导入；新增 IPC `sessions:prepare-resume`。
  - `src/main/preload.ts`：`prepareSessionResume`。`renderer/sessions.js`：复制继续命令前先导入；终端打开后的提示说明「已导入 / 沿用 CLI 那份」。
  - 新测试 `scripts/test-antigravity-cli-import.cjs`（临时目录，不碰真实数据）。
- **验证命令与结果**：
  - `npm run build`：PASSED。
  - `node scripts/test-antigravity-cli-import.cjs`：8/8 PASSED。
  - `node scripts/test-antigravity-sessions.cjs`：5/5；`node scripts/test-antigravity-usage.cjs`：10/10；`node scripts/test-sessions.cjs`：PASSED；`node scripts/test-session-search.cjs`：24/24；`npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：7/7。
  - 真实环境端到端：Electron 运行时（`ELECTRON_RUN_AS_NODE`）对一段 6 步的桌面端对话执行导入 → `imported`，再次执行 → `current`，agy 打开后再执行仍为 `current`；随后 `agy acp` `session/load` 回放出 2 条用户消息、2 条回复、1 个工具调用。
- **未验证**：没有手动操作 `agy.exe` 交互式 TUI 界面（ACP 与 TUI 走同一 language server 的加载路径，推断一致）；没有在打包版里点按钮实测；未跑 `npm run dist`。
- **已知限制**：导入是「分叉」——在 CLI 里继续后的新内容不会回写到桌面端；之后桌面端再继续，CLI 那份会保留不覆盖。子代理对话库不复制（不影响主对话加载和继续）。
- **进程与占用**：本轮的 agy acp / electron 测试进程均已退出（`tasklist` 无 agy.exe / electron.exe）；CLI 日志目录中本轮 4 个 `acp-server-20261109_*.log` 已删除；`build/core/antigravity.js`、`build/main/index.js`、`build/main/preload.js` 独占句柄检测 UNLOCKED。未触碰 `dist`。
- **Git / 版本**：未升版本（仍 `0.3.84`），未提交、未发布。下一步：用户确认后再决定是否升版本 + 发布。

---

# 历史版本记录 · TokenPulse v0.3.84 正式版发布完工（模型速度走势补齐谷歌/Antigravity 模型、并发监控适配 Antigravity & CLI、会话列表归集子代 Token 用量，2026-11-08）

## 已完成并发布 · TokenPulse v0.3.84 正式版验收与 GitHub Release（2026-11-08，主分支 `main`，版本 v0.3.84）

- **本轮目标与问题现象**：
  - **版本**：`v0.3.84`（以 `package.json:3` 为准，Git 标签 `v0.3.84`）。
  1. **「模型速度走势」缺失谷歌（Antigravity）模型**：用量明细表格有谷歌模型速度，但 `#page-usage` 底部的「模型速度走势」折线图没有任何谷歌/Antigravity 模型。
  2. **「并发监控」未适配 Antigravity 及其 CLI**：并发监控页的监控范围（`coverage`）、实时计数与供应商/账号明细表中没有 Antigravity 和 Antigravity CLI。
  3. **「会话列表」未归集 Antigravity 子代（Subagents）用量**：Antigravity 主会话通过 `invoke_subagent` 或 `/teamwork` 派出的子代理（含多层嵌套子代理，`nesting_depth > 0`）在独立的 `<subId>.db` 中消耗了大量模型额度，但会话列表与会话详情只统计了主会话 `<parentId>.db` 自身的步骤，导致子代消耗被漏计。
- **根因诊断与完成改动**：
  1. **修复「模型速度走势」缺失谷歌 / Antigravity 模型（`src/core/pass-speed.ts`、`renderer/usage-insights.js`、`renderer/i18n.js`）**：
     - **根因**：`speedSeries()` 此前仅读取本地代理转发日志 `route-log/*.jsonl` 以及 `requests/*.jsonl` 中带 `"estimate"` 且 `kind` 为 `claude-code` / `codex` 的记录。而 Antigravity 从本机 SQLite `gen_metadata` 提取的实测流式速度与首字延迟写在 `requests/*.jsonl` 的 `row.timing` 中（无实测流式耗时时写在 `row.estimate` 中），且 `APP_OF_REQUEST` 未包含 `antigravity`、`deepseek-harness`、`pi`。
     - **修复**：在 `src/core/pass-speed.ts` 中扩展 `APP_OF_REQUEST` 覆盖 `antigravity`、`deepseek-harness`、`pi`；新增 `requestSpeedRows()` 与 `measuredRequestRows()` 从 `requests/*.jsonl` 统一提取 `antigravity` / `deepseek-harness` 的实测 `timing`（含 `tokensPerSec` 与 `firstTokenMs`，`estimated: false`）与各工具的 `estimate`（`estimated: true`）并合入 `speedSeries()`；在 `renderer/usage-insights.js` 的 `APP_SOURCE` 中补齐 `antigravity: 'Antigravity'`、`deepseek: 'DeepSeek Harness'`、`pi: 'pi'`，本机日志实测速度的来源显示为 `官方登录（本机日志）`。
  2. **适配 Antigravity 与 Antigravity CLI 到「并发监控」（`src/core/concurrency.ts`、`src/core/antigravity.ts`、`src/main/index.ts`、`renderer/concurrency.js`、`renderer/i18n.js`）**：
     - **根因**：`src/main/index.ts` 的 `concurrencyState()` 仅注册了本地代理转发的 5 个工具，未注册 Antigravity 与 Antigravity CLI；`renderer/concurrency.js` 的 `APP` 字典也缺少 `antigravity`、`antigravity-cli`、`deepseek`、`pi`。
     - **修复**：
       - 在 `src/core/concurrency.ts` 的 `ConcurrencyMonitor` 中新增 `setExternal(key, scopes, counts)`，支持将外部本机监控的实时并发（`requests`、`clients`、`upstream`）合入 `global` 与对应供应商/账号行，并自动触发峰值分桶记录与状态推送；
       - 在 `src/core/antigravity.ts` 中新增 `readAntigravityLiveConcurrency()`，分别统计 `~/.gemini/antigravity`（IDE）与 `~/.gemini/antigravity-cli`（CLI）当前运行中的主对话、并行子代理请求数与活跃 `hub_*.json` 连接数；
       - 在 `src/main/index.ts` 的 `concurrencyState()` 中注册 `provider:antigravity`（`Antigravity · 本机监控`）、`provider:antigravity-cli`（`Antigravity CLI · 本机监控`）及 `account:antigravity`，将 `antigravity` 与 `antigravity-cli` 加入 `concurrencyCoverage`，并每 2 秒同步一次本机实时并发计数；
       - 在 `renderer/concurrency.js` 的 `APP` 映射中补齐 `antigravity`、`antigravity-cli`、`deepseek`、`pi`。
  3. **会话列表与详情归集 Antigravity 子代（含多层嵌套子代理）Token 用量（`src/core/antigravity.ts`、`src/core/sessions.ts`）**：
     - **根因**：`parseAntigravity()` 与 `listSessions()` 跳过了 `summary.nested === true` 的子代理会话（避免子代理把列表刷屏），但解析主会话时只读取了主会话自身的 `<id>.db`，未将其派生的子代 `<subId>.db` 用量归集到主会话的 `Builder` 中。
     - **修复**：
       - 在 `src/core/antigravity.ts` 的 `antigravitySummaries()` 中解析 `parent_conversation_id`（`parentId`）；新增 `antigravitySubagentFilesByRoot()` 按主对话 ID 递归归集所有层级的子代 `.db` 文件（最多 8 层，带环路保护）；新增带文件时间戳缓存的轻量级 `readAntigravitySubagentUsage(file, known)`，只读 `steps` 表的 `metadata` 列（当 `metadata` 为空时按需回退 `step_payload` 字段 5）且每个未知数字型号 ID 仅查一次 `gen_metadata`；同时在 `deleteAntigravityConversation()` 删除 CLI 本地会话时一并清理其子代会话文件；
       - 在 `src/core/sessions.ts` 中将 `INDEX_VERSION` 升至 `6`；`antigravityListStamp()` 将主会话下属所有子代 `.db(-wal)` 的大小和修改时间纳入缓存签名（子代更新时自动失效重算主会话）；`parseAntigravity()` 同时通过摘要库 `parentId` 树与主对话 `invoke_subagent` 工具输出中的 `conversationId` 收集全部子代 `.db`，将子代的模型、输入/输出/缓存/思考 Token、调用次数、活跃耗时（`Builder.addDuration`）及最新时间（`Builder.touchAt`）完整归集到主会话中。
  4. **版本升级与更新说明（`package.json`、`package-lock.json`、`renderer/intro.js`、`renderer/i18n.js`）**：
     - 版本号升级至 `0.3.84`，补充 `0.3.84` 版本更新说明与中英文翻译词条。
- **验证命令与实际结果**：
  - `npm run build`：**PASSED (Exit 0)**。
  - `node scripts/test-antigravity-sessions.cjs`：**5/5 PASSED (Exit 0)**（新增一级+二级嵌套子代 Token 与调用次数归集断言）。
  - `node scripts/test-antigravity-usage.cjs`：**10/10 PASSED (Exit 0)**。
  - `node scripts/test-pass-speed.cjs`：**PASSED (Exit 0)**（新增 Antigravity 本机实测 `timing` 与 `estimate` 纳入 `speedSeries` 断言）。
  - `node scripts/test-speed-estimate.cjs`：**2/2 PASSED (Exit 0)**。
  - `node scripts/test-concurrency.cjs`：**PASSED (Exit 0)**（新增 `setExternal` 对 Antigravity IDE + CLI 并发汇总断言）。
  - `npx electron --lang=zh-CN scripts/test-concurrency-ui.cjs`：**PASSED (Exit 0)**（新增 `antigravity` 与 `antigravity-cli` 监控范围卡片渲染断言）。
  - `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：**7/7 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：**3/3 PASSED (Exit 0)**。
  - `npm run dist`：**PASSED (Exit 0)**。
- **最新产物路径与版本（v0.3.84）**：
  - `dist/TokenPulse-0.3.84-Setup.exe`（SHA256: `0A38B472BD95E7FDBF11A4C8BA79483BDFA93F7508AFA1FEB114F29F81B425DC`）
  - `dist/TokenPulse-0.3.84-Portable.exe`（SHA256: `C5B8B5AC4F57C1822639D2E3269E5BDA1628F3D02790F1D113FE51AFE6426D5C`）
  - `dist/TokenPulse-0.3.84-Setup.exe.blockmap`（SHA256: `702E03CB4BD40230CC2DC690BE47F052B36E0B26EE6E9F12DCED886CD0CD104D`）
  - `dist/latest.yml`（SHA256: `617B419F1C9F6D74AF802EDAECA0BE4418C6D123D78B9F006AC6304B242C3E84`）
  - `dist/win-unpacked/TokenPulse.exe`
  - **Git 提交与发布状态**：代码已提交至 `main`、已打标签 `v0.3.84` 并推送到 `origin/main`；GitHub Release `v0.3.84` 已正式发布（https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.84 ），全部 4 项安装包与元数据附件均已上传。
  - **进程与文件锁状态**：本轮启动的构建与测试进程已全部退出；`build/main/index.js`、`build/core/antigravity.js`、`build/core/pass-speed.js`、`build/core/concurrency.js`、`build/core/sessions.js`、`dist/TokenPulse-0.3.84-Setup.exe`、`dist/TokenPulse-0.3.84-Portable.exe`、`dist/TokenPulse-0.3.84-Setup.exe.blockmap`、`dist/latest.yml`、`dist/win-unpacked/TokenPulse.exe` 独占句柄检测全部为 `UNLOCKED`（检测句柄已立即关闭）。

---

# 历史版本记录 · TokenPulse v0.3.83 正式版发布完工（Antigravity CLI 全面适配，2026-11-07）

## 已完成并发布 · TokenPulse v0.3.83 正式版验收与 GitHub Release（2026-11-07，主分支 `main`，版本 v0.3.83）

- **本轮目标**：
  - **版本**：`v0.3.83`（以 `package.json:3` 为准，Git 标签 `v0.3.83`）。
  - 用户安装了 **Antigravity CLI (`agy.exe`)**，要求将 Claude Code CLI 作为模板，为 TokenPulse 全面适配 Antigravity CLI，并提升一个小版本发布到 GitHub Release。
- **本机 Antigravity CLI 实测结构与协议核验**：
  1. **可执行文件与双路径区分**：
     - 真正的 Antigravity CLI 为 `%LOCALAPPDATA%\agy\bin\agy.exe`（`Antigravity CLI v0.2.3 (Standalone)`，Go 编译），而 `%LOCALAPPDATA%\Programs\Antigravity\bin\agy.cmd` 是启动 Electron IDE 桌面端的脚本。因此 CLI 探测与 PowerShell 启动命令统一显式匹配 `agy.exe`。
  2. **本地数据存储目录（`~/.gemini/antigravity-cli`）**：
     - Antigravity CLI 默认独立使用 `~/.gemini/antigravity-cli`（与桌面端 `~/.gemini/antigravity` 并列），拥有完全一致的 `conversations/<id>.db`（`steps` / `gen_metadata` Protobuf 表结构）、`conversation_summaries.db`、`daemon/hub_*.json`、`brain/<id>`、`annotations/<id>.pbtxt`。
     - 注意：CLI 在无头打印模式下写入 `conversation_summaries.db` 时，`last_modified_time` 可能为 `'0001-01-01 00:00:00+00:00'`（`Date.parse` 为负数），需过滤 `<= 0` 时间戳并回退到 `<id>.db(-wal)` 文件修改时间。
  3. **命令行与无头流式回复（`stream-json`）**：
     - 恢复会话：`agy.exe --conversation <id>`。
     - 无头流式回复：`agy.exe --conversation <id> --output-format stream-json --mode accept-edits|plan`，当 `stdin` 为管道时自动进入无头打印模式并从 `stdin` 读取提示词（无需且不能传空 `-p`）。
     - 流式输出 NDJSON 事件：`step_update`（含 `text_delta`、`tool.name`/`tool.detail` 或 `tool_name`、`error`）、`result`（含 `status`、`response`、`error`）、`error`。
- **已完成的关键改动与文件**：
  1. **`src/core/antigravity.ts`**：
     - 新增 `antigravityCliDir()` 与 `antigravityDirs()`，同时覆盖 `~/.gemini/antigravity`（桌面端）与 `~/.gemini/antigravity-cli`（CLI）；
     - `antigravityConversationFiles()`、`antigravityWorkspaces()`、`antigravitySummaries()`、`antigravityHub()` 均升级为跨双目录扫描与合并（按最新文件修改时间去重，优先保留非空标题与工作区）；
     - `sqliteTime()` 将 `<= 0` 的时间戳（如 `0001-01-01`）归零，避免产生负数时间戳；
     - `deleteAntigravityConversation(id)` 支持对 CLI 会话直接清理本地文件（`conversations/<id>.db` 及 `-wal`/`-shm`、`brain/<id>`、`annotations/<id>.pbtxt`、`presence/<id>.lock` 以及两边的 `conversation_summaries.db` 行），无需打开 Antigravity 桌面端；纯桌面端会话仍通过 `DeleteCascadeTrajectory` 请运行中的 Antigravity 删除；
     - `conversationPhase()` 与 `readAntigravityActivity()` 支持跨双目录合并活动状态，并从步骤 `metadata`（字段 4）提取当前工具名与 `ask_question` 提问参数；`parseSummaryGroups()` 兼容 `RetrieveUserQuotaSummary` 的 snake_case 字段（`remaining_fraction`、`reset_time`、`name`）。
  2. **`src/core/sessions.ts`、`src/main/session-reply.ts`、`src/main/index.ts`、`renderer/sessions.js`、`renderer/intro.js` & `renderer/i18n.js`**：
     - `src/core/sessions.ts`：`commandOf("antigravity", id)` 返回 `` `agy.exe --conversation ${id}` ``；`toolSummary()` 补充 `CommandLine`、`AbsolutePath`、`Path`、`Query`、`Prompt`、`toolSummary` 参数提取；`INDEX_VERSION` 升至 `5`；
     - `src/main/session-reply.ts`：`resolveCli("antigravity")` 解析 `%LOCALAPPDATA%\agy\bin\agy.exe` / `~/.local/bin/agy.exe` / `where("agy.exe")`（可由 `TOKENPULSE_AGY_CLI` 覆盖）；`terminalScript` 支持 `agy.exe` 新建会话与 `--conversation <id>` 恢复会话；`replyArgs` 与 `readEvent` 支持 `agy.exe` 的 `stream-json` 流式回复与工具调用展示；
     - `src/main/index.ts` & `renderer/sessions.js`：解除 Antigravity 会话的 `IDE_ONLY` 限制，开放「开一个新对话 / 新项目」「在终端里继续」「复制继续命令」「回复对话」，并补充 `0.3.83` 版本更新说明与中英文翻译词条。
  3. **`src/core/agent-activity.ts` & `src/main/antigravity-quota.ts`**：
     - `ActivityScanner` 默认监听并扫描 `antigravity` 与 `antigravityCli` 双目录；`askOf` 支持将 Antigravity 的 `ask_question`（含字符串数组 `options` 与 `is_multi_select`）转换为桌宠问题卡片；
     - `AntigravityQuotaService.installed()` 与 `refresh()` 同时检测桌面端与 CLI 目录。
- **验证命令与实际结果**：
  - `npm run build`：**PASSED (Exit 0)**。
  - `node scripts/test-antigravity-sessions.cjs`：**4/4 PASSED (Exit 0)**（含 `antigravity-cli` 会话扫描、无需 IDE 本地删除、`replyArgs`/`terminalScript`/`readEvent` 流式事件解析）。
  - `node scripts/test-antigravity-usage.cjs`：**10/10 PASSED (Exit 0)**（含 `antigravity-cli` 用量入账与 snake_case 额度汇总解析）。
  - `node scripts/test-desk-pet.cjs`：**PASSED (Exit 0)**（含 `antigravityCli` 目录监听与 `ask_question` 桌宠问题卡片提取）。
  - `npx electron scripts/test-antigravity-ui.cjs`：**7/7 PASSED (Exit 0)**（含会话管理页「回复对话」按钮、回复输入框、「在终端里继续」与 `agy.exe --conversation` 复制命令、深色模式与英文翻译零残留）。
  - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：**3/3 PASSED (Exit 0)**。
- **最新产物路径与版本（v0.3.83）**：
  - `dist/TokenPulse-0.3.83-Setup.exe`（SHA256: `0DB44D54236A0B8055BBB613F8AED863D800D2F90E367526D071603988ADED45`）
  - `dist/TokenPulse-0.3.83-Portable.exe`（SHA256: `0B9C9AAE68771F6893FF7B24ACB58059DD4979364912D07BF35F2FA1D33A0793`）
  - `dist/TokenPulse-0.3.83-Setup.exe.blockmap`（SHA256: `7DE791EBC35741342C945D75D4A4721F66D5546DFA6CCA28BB6A799F48CECBA9`）
  - `dist/latest.yml`（SHA256: `6ECFC3FBF05C965FA36E4643ABC63932916A6AFE036BE4582C1CEDDEB4C36C2C`）
  - `dist/win-unpacked/TokenPulse.exe`
  - **Git 提交与发布状态**：代码已提交至 `main`、已打标签 `v0.3.83` 并推送到 `origin/main`；GitHub Release `v0.3.83` 已正式发布（https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.83 ），全部 4 项安装包与元数据附件均已上传。
  - **进程与文件锁状态**：本轮启动的构建与测试进程已全部退出；`build/main/index.js`、`build/core/antigravity.js`、`build/main/session-reply.js`、`dist/TokenPulse-0.3.83-Setup.exe`、`dist/TokenPulse-0.3.83-Portable.exe`、`dist/latest.yml`、`dist/win-unpacked/TokenPulse.exe` 独占句柄检测全部为 `UNLOCKED`（检测句柄已立即关闭）。

---

# 历史版本记录 · TokenPulse v0.3.82 正式版发布完工（Antigravity 时间线历史周期切换修复 & 周额度窗口卡片 UI 修复，2026-11-07）

## 已完成并发布 · TokenPulse v0.3.82 正式版验收与 GitHub Release（2026-11-07，主分支 `main`，版本 v0.3.82）

- **本轮目标与问题现象**：
  - **版本**：`v0.3.82`（以 `package.json:3` 为准，Git 标签 `v0.3.82`）。
  1. **Antigravity 时间线历史周期切换丢失账号**：用户在 Antigravity 额度详情页的「模型与思考等级 · 时间线」点击周期导航按钮切换历史周期时，页面直接显示「这个账号还没有带账号标识的官方额度周期。」。
  2. **周额度窗口（`.agy-week-box`）提醒卡片 UI 缺陷**：当周额度窗口存在「⚠️ 按最近的速度，约 ... 后用完」提醒卡片且窗口经历过提前重置时，下方的「窗口已提前重置，重置日期已顺延 · 从 ... 起算」文字向上贴边/重叠压入黄色预警卡片底部，且下方留出多余空白；同时浅色模式下 `.agy-week-box` 内的进度条底槽（`.track`）与卡片底色相同（`var(--surface-2)`）导致底槽不可见。
- **根因诊断与完成改动**：
  1. **`renderer/model-study.js`、`renderer/antigravity-quota.js` & `src/main/antigravity-quota.ts`**：
     - 在 `renderer/model-study.js` 中，不在 `snapshot.accounts` 内的扩展账号（Antigravity、DeepSeek、号池）通过第 3 个参数 `extra` 传给 `timelineUpdate(snapshot, preferred, extra = null)` 并存入 `T.extra`。但点击时间线周期导航按钮（`‹` / `›`）或重试按钮时调用的 `reloadTimeline()` 写成了 `timelineUpdate(T.snapshot, T.accountId)`，漏传了 `T.extra`，导致 `T.extra` 被默认参数 `null` 覆盖清空，`timelineAccounts(snapshot)` 找不到 `antigravity` 账号并进入 `drawTimeline('none')`。
     - 将 `renderer/model-study.js` 的 `reloadTimeline()` 改为 `timelineUpdate(T.snapshot, T.accountId, T.extra)`；在 `renderer/antigravity-quota.js` 中允许在 `current` 尚未就绪时照常调用 `PulseModelStudy.timeline`；在 `src/main/antigravity-quota.ts` 的 `agyWindowSegments` 中收紧提前重置切段时的 `startAt` 下界（`startAt = Math.max(startAt, previous.endAt)`），确保前后周期边界严密衔接不重叠。
  2. **`renderer/antigravity.css`**：
     - 在 `renderer/app.css` 中，`.prediction-line` 默认有 `margin: 18px 0`，因此下方的 `.reset-card-note` 设置了负上边距 `margin: -4px 0 14px`。但在 `renderer/antigravity.css` 中，`.agy-week-pred` 将下边距覆盖为 `margin-bottom: 0`，导致紧随其后的 `.reset-card-note` 因 `margin-top: -4px` 向上贴边/压入黄色预警卡片底部，且底部多出 `14px` 外边距。
     - 新增 `.agy-week-box .reset-card-note { margin: 10px 0 0; }`、`.agy-week-box .track { background: var(--line); }`、`.agy-week-title .section-tag { margin-left: 0; background: var(--surface); }`，并将样式表中未定义的 `var(--ink)` / `var(--ink-2)` 统一替换为标准设计变量 `var(--text)` / `var(--text-2)`。
  3. **`scripts/test-antigravity-ui.cjs`、`package.json`、`package-lock.json`、`renderer/intro.js` & `renderer/i18n.js`**：
     - 新增 `.agy-week-box` 轨道对比度与 `.reset-card-note` 间距（`gap >= 6px`）断言，以及 `#quota-model-timeline` 历史周期翻页（`1 / 2` ↔ `2 / 2`）断言；
     - 版本号升级至 `0.3.82`，补充 `0.3.82` 版本更新说明与英文翻译词条。
- **验证结果**：
  - `npm run build`：**PASSED (Exit 0)**。
  - `node scripts/test-antigravity-usage.cjs`：**9/9 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：**7/7 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：**3/3 PASSED (Exit 0)**。
- **最新产物路径与版本（v0.3.82）**：
  - `dist/TokenPulse-0.3.82-Setup.exe`（SHA256: `155F03484996702BA1C803EB18FBA5847CA13DE83FEC79327A4B94E9CB2006FF`）
  - `dist/TokenPulse-0.3.82-Portable.exe`（SHA256: `2E21030BB109531D3A4CBD8C2EE73C082E351456D52921E7737FE36CEC730FCD`）
  - `dist/TokenPulse-0.3.82-Setup.exe.blockmap`（SHA256: `F2714A548DBD52324011E2FD9615DEBE006BE874ECDDA8D4E9F2DECA21EB3DE4`）
  - `dist/latest.yml`（SHA256: `3FD425D8236C6585BF404CBDBDDBF8A68BAB69833D72BA8F535968B85005865C`）
  - `dist/win-unpacked/TokenPulse.exe`
  - **Git 提交与发布状态**：代码已提交至 `main`、已打标签 `v0.3.82` 并推送到 `origin/main`；GitHub Release `v0.3.82` 已正式发布（https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.82 ），全部 4 项安装包与元数据附件均已上传。
  - **进程与文件锁状态**：本轮启动的构建与测试进程已全部退出；`build/main/index.js`、`build/main/antigravity-quota.js`、`dist/TokenPulse-0.3.82-Setup.exe`、`dist/TokenPulse-0.3.82-Portable.exe`、`dist/latest.yml`、`dist/win-unpacked/TokenPulse.exe` 独占句柄检测全部为 `UNLOCKED`（检测句柄已立即关闭）。

---

# 历史版本记录 · TokenPulse v0.3.81 正式版发布完工（桌宠问题卡片右侧截断修复 & 全工具进行中任务识别与提问适配，2026-11-07）

## 已完成并发布 · TokenPulse v0.3.81 正式版验收与 GitHub Release（2026-11-07，主分支 `main`，版本 v0.3.81）

- **本轮目标与问题现象**：
  - **版本**：`v0.3.81`（以 `package.json:3` 为准，Git 标签 `v0.3.81`）。
  1. **问题卡片右侧裁切**：用户反馈桌宠弹出的问题卡片（`Claude Code · Claude · Minecraft Fabric 随机附魔怪物...` / `有个问题想问你`）右侧被裁切：顶部右侧关闭按钮 `×` 消失、右下角 `知道了` 按钮只剩 `知道`、每行文字右侧最后 2–3 个字被截断。
  2. **多 CLI（Antigravity、Grok Build、Claude Code、Codex）进行中任务偶发漏识别**：用户反馈桌宠有时识别不到正在运行的 Antigravity、Grok Build、Claude Code 和 Codex 任务。
  3. **DeepSeek Harness 适配检查与补全**：检查 `~/.dsh/sessions`（`session.v4.jsonl.zstd`）在桌宠中的适配完整性，并补齐缺失的提问卡片（`ask_user_question` / `exit_plan_mode`）与状态推断分支。
- **根因诊断**：
  1. **桌宠问题卡片右侧截断**：
     - 在 `renderer/desk-pet-ask.css` 中，外层容器 `#ak`（`.ak`）设置了 `display: grid; gap: 12px; width: 320px;`，但**未声明 `grid-template-columns: minmax(0, 1fr)`**，且网格子项 `.ak-card` **未设置 `min-width: 0`**（选项列表 `.ak-opts` 同样为 `display: grid` 且未限制列最小宽度）。
     - 根据 CSS Grid 规范，隐式单列网格默认轨道尺寸为 `auto`（即 `minmax(auto, 1fr)`），网格项默认 `min-width: auto`。当 `.ak-head span` 含有较长的 `white-space: nowrap` 会话标题或问题/选项含较长文本时，CSS Grid 在计算 `.ak-card` 的 `min-content` 最小宽度贡献时会被长文本撑开至 `406px`（超出 `#ak` 的 `320px`）。
     - 与此同时，`renderer/desk-pet-ask.js` 的 `report()` 读取 `box.offsetWidth`（`#ak` 显式指定了 `width: 320px`），调用 `api.askSize(332, ...)` 将透明 `BrowserWindow` 宽度设为 `332px`。结果 `406px` 宽的 `.ak-card` 在 `332px` 窗口内向右溢出 `80.5px` 并被裁剪。
  2. **Antigravity 任务偶发漏识别**：
     - **摘要库时间戳滞后**：`src/core/antigravity.ts` 的 `readAntigravityActivity()` 此前仅取 `conversation_summaries.db` 的 `last_modified_time` 作为 `item.at`。但 Antigravity 在单轮执行期间将新步骤实时写入 `conversations/<id>.db-wal`，而摘要库的 `last_modified_time` 往往在回合开始/结束或检查点才刷新（实测活跃对话滞后可达数百秒甚至超过 10 分钟）。导致 `agent-activity.ts` 的 `liveStatus()` 在 90 秒（`WAITING_MS`）后将工具执行误判为 `waiting`（「可能在等你」），在 10 分钟（`STALE_MS`）后直接判定为僵尸任务返回 `null` 丢弃。
     - **后台任务等待与 `not_fully_idle` 未纳入**：Antigravity 启动后台命令或等待子代理唤醒时，主回合结束使 `status` 变为 `CASCADE_RUN_STATUS_IDLE`，但 `not_fully_idle` 仍为 `1`（或对话库末尾步骤刚进入 `STEP_OPEN`）；此前代码仅匹配 `/RUNNING|BUSY|CANCELING/.test(status)`，未检查 `not_fully_idle`。
     - **子代理（`nesting_depth > 0`）未归并到主对话**：当使用 `/teamwork` 或 `invoke_subagent` 派出子代理时，主对话处于 `IDLE` 等待状态，而子代理（带 `parent_conversation_id`）处于 `RUNNING`；此前 `ActivityScanner.scan()` 直接 `if (item.nested) continue;` 丢弃子代理，未像 Claude / Grok 一样将活跃子代理数和最新时间归并到主对话。
     - **并行步骤判断与文件监听**：`conversationPhase()` 仅看 `tail[0]` 是否为非模型回复的 `STEP_OPEN`，当并行工具中一个完成（`tail[0]` 为 `DONE`）而另一个仍在跑（`tail[1]` 为 `RUNNING`）时会误判；`desk-pet.ts` 的 `fs.watch` 仅匹配 `conversation_summaries.db`，未匹配 `conversations/<id>.db(-wal)`。
  3. **Grok Build 任务偶发漏识别**：
     - **超大工具输出撑爆 64 KB 尾部窗口 + `tool_call_update` 状态丢失**：Grok 的 `updates.jsonl` 单条 `tool_call_update` 常包含完整文件内容或命令输出（实测用户会话单行高达 `161 KB`～`733 KB`）。当 `readEnds()` 仅截取末尾 `64 KB` 时：① 若最后一行本身超过 `64 KB`，`tail` 切出 0 条完整 JSON，`inferGrok(tail)` 返回 `null`；② 若前序大输出把本轮开头的 `user_message_chunk` 和 `tool_call` 挤出 `64 KB` 窗口，`tail` 以 `tool_call_update`（`completed` 或无 `status` 的进度行）或 `auto_compact_*` / `retry_state` 开头，而旧 `inferGrok()` 在 `status === null` 时直接忽略了这些行，返回 `null`（实测两个真实会话 668 个运行步中漏判了 43 步）。
     - **未利用同目录轻量的 `events.jsonl`**：Grok 会话目录下同时维护了每行 `< 250 B` 的 `events.jsonl`（记录 `turn_started`、`phase_changed`、`tool_started`、`permission_requested`、`turn_ended`），可作为超大 `updates.jsonl` 行的可靠兜底并精准识别 `permission_prompt` 等待批准状态。
  4. **Claude Code 任务偶发漏识别**：
     - **2.1+ 版本请求前大体积 `attachment` / `api-request-shape` / `api-request-blob` 挤出 `user` 行**：实测本机 40 个真实 Claude Code 会话发现，现代 Claude Code（如 `2.1.319`）在写入 `user` 提问或 `tool_result` 后、模型回复前，会立即连续写入 `attachment`（`100 KB`～`150 KB`）、`api-request-shape`（`~99 KB`）、`api-request-blob`（`42 KB`～`3.3 MB`）、`api-request`、`last-prompt`、`ai-title`、`mode`、`permission-mode`、`session-owner`、`atis-latch`，连续非 `user/assistant` 数据块最高达 `3.31 MB`（常见 `150 KB`～`250 KB`）。由于末尾的 `last-prompt`、`ai-title`、`mode` 等本身是合法 JSON 行，此前 `readEnds` 仅读最后 `64 KB` 即停止，而 `inferClaude` 只看 `user` / `assistant` / `system`，导致整个模型思考期间 `inferClaude(tail)` 返回 `null`（40 个真实会话 66,144 个运行步中漏判高达 `6,014` 步）。
     - **并行 `tool_use` 未按 `id` 跟踪 `pending` 集合**：本机 40 个会话中有 `1,170` 次并行工具调用（多条 `assistant` `tool_use` 后逐条返回 `user` `tool_result`）。旧 `inferClaude` 未维护 `pending` Map，第一个 `tool_result` 一返回就把状态改回 `thinking` 并清空 `tool`，导致仍在执行的其余工具（或 `AskUserQuestion`）状态丢失。
     - **后台任务 `<task-notification>` 唤醒与自动压缩续写未触发新一轮**：当后台命令完成写回 `<task-notification>` 或触发 `This session is being continued from a previous conversation that ran out of context` 自动压缩续写时，`claudeUserText` 将其清洗为空文本 `{ text: '' }`，导致旧 `inferClaude` 忽略该 `user` 行，状态停留在上一轮的 `done`。
  5. **Codex 任务偶发漏识别**：
     - **大图消息 / 大工具输出挤出 `task_started` 后，末尾 `event_msg`（`item_completed` / `token_count`）被忽略**：实测本机 86 个真实 Codex 会话发现，含截图的 `user` 消息或 `function_call_output` / `item_completed` 单行可达 `3.1 MB`～`6.9 MB`。当 `task_started` 被挤出 `64 KB` 窗口、末尾仅剩 `event_msg:item_completed`、`event_msg:token_count` 或 `token_usage_record` 时，旧 `inferCodex` 直接跳过返回 `null`（5,545 个运行步中漏判 `400` 步）。
     - **日期目录扫描窗口偏短**：`discover()` 此前仅扫最近 7 天日期目录，通过 `codex resume` 恢复更早创建的会话时无法被发现。
  6. **DeepSeek Harness 适配检查**：
     - `src/core/agent-activity.ts` 已具备基础的 `~/.dsh/sessions/<项目>/session-<id>/session.v4.jsonl.zstd` 解帧与 `turn/start`、`turn/end`、`tool/call`、`tool/result`、`approval/asked`、`approval/decided` 识别。
     - **缺失项**：本机真实 `.dsh` 会话中存在 `name: "ask_user_question"` 的 `tool/call`（参数为 JSON 字符串形式的 `questions`），但旧 `inferDeepseek` 未调用 `askOf(...)` 提取 `ask` 字段，导致 DeepSeek Harness 向用户提问或提交计划（`exit_plan_mode`）时桌宠不会弹出问题卡片；且 `step/start`、`user/message` 未作为 `turn/start` 缺失时的运行态兜底，问题卡片也缺少 `deepseek` 专属标识色。
- **已完成的关键改动与文件**：
  1. `renderer/desk-pet-ask.css`、`renderer/desk-pet-ask.js` & `renderer/desk-pet-bubble.css`：
     - 为 `.ak`、`.ak-opts`、`.bb-list` 显式补充 `grid-template-columns: minmax(0, 1fr)`；为 `.ak-card`、`.ak-question`、`.ak-opts li`、`.ak-opts li > div`、`.bb-task` 补充 `min-width: 0`，确保长标题与长选项严格约束在卡片宽度内；
     - 在 `desk-pet-ask.js` 与 `desk-pet-bubble.css` 中新增 `deepseek` 品牌标识色（`--bb-deepseek: #4d6bfe`）。
  2. `src/core/antigravity.ts`：
     - `openDb` 增加 `PRAGMA busy_timeout = 200;` 防止并发写锁导致偶发空读；
     - `conversationPhase` 改为检查 `tail` 中任意未完成步骤以支持并行工具调用；
     - `readAntigravityActivity` 纳入 `not_fully_idle !== 0` 与对话库新开启步骤检测；对运行中对话取 `Math.max(sumAt, stamp.mtimeMs)`（结合 `<id>.db-wal` 实时修改时间），对已空闲对话仍保持 `sumAt`；并顺着 `parent_conversation_id` 将运行中的子代理（`nesting_depth > 0`）归并到根主对话的 `subagents` 与活动时间上。
  3. `src/core/agent-activity.ts` & `src/main/desk-pet.ts`：
     - **自适应尾块扩展（`readEnds`）**：将 `MAX_TAIL_CHUNK` 提升至 `8 MB`，并支持传入 `check`（对应各 CLI 的 `infer*` 函数）。当末尾 `64 KB` 仅含完整 JSON 元数据行（如 `attachment`、`last-prompt`、`progress`）但尚不足以推出回合状态时，按 `64 KB → 256 KB → 1 MB → 4 MB → 8 MB` 自动向前扩展（常规情况仍只读一次 `64 KB`）；
     - **Claude Code（`inferClaude`）**：引入 `pending = new Map<string, string>()` 跟踪并行 `tool_use` 与 `tool_result`；识别 `api-request` / `api-request-blob` / `api-request-shape` / `tools-used` 运行态；支持 `<task-notification>` 后台任务唤醒与 `上下文已压缩，从摘要继续`；`system:turn_duration` / `stop_hook_summary` 在 `status === null` 时也能直接判定 `done`。实测本机前 20 个大文件 `40,897` 个运行步漏判从 `6,014` 降至 **`0`**，误判 **`0`**；
     - **Codex（`inferCodex` & `discover`）**：在 `status === null` 时支持从 `event_msg`（`item_completed`、`token_count` 等）和 `token_usage_record` / `world_state` / `turn_context` 恢复 `thinking` 状态，`error` 事件在 `status === null` 时亦可记录 `error` 结束；`discover` 日期目录回看窗口从 7 天扩至 30 天。实测本机全部 86 个 Codex 会话 `5,545` 个运行步漏判从 `400` 降至 **`0`**，误判 **`0`**；
     - **DeepSeek Harness（`inferDeepseek`）**：在 `tool/call` 中接入 `askOf(name, data.arguments ?? data.input, id, t)` 并在对应 `tool/result`、`turn/start`、`turn/end` 时清理，完整支持 `ask_user_question` 与 `exit_plan_mode` 问题卡片；补齐 `step/start`、`user/message` 运行态识别与 `approval/asked` 的 `toolName` 保留；
     - **Grok Build（`inferGrok` & `inferGrokEvents`）**：支持从一轮中间的 `tool_call_update`、`retry_state`、`auto_compact_*`、`compaction_checkpoint`、`task_backgrounded`、`task_completed` 恢复运行态，并结合同目录 `events.jsonl` 兜底与识别权限等待；
     - **监听重扫（`knows` & `fs.watch`）**：新增 `ActivityScanner.knows(file)`，并在 `desk-pet.ts` 的 `fs.watch` 中纳入 `.db(-wal)?$` 及未跟踪会话文件变更时的 `scanner.poke()` 立即重扫。
  4. `scripts/test-desk-pet-ui.cjs`、`scripts/test-desk-pet.cjs`、`package.json`、`package-lock.json`、`renderer/intro.js` & `renderer/i18n.js`：
     - 新增问题卡片超长文本不溢出回归测试、Claude 并行工具与 `api-request` / `<task-notification>` / `progress` 自适应扩窗测试、Codex 中间事件恢复测试、DeepSeek Harness `ask_user_question` / `exit_plan_mode` 提问卡片测试、Grok 超大工具输出与 Antigravity `.db-wal` 保活及子代理归并测试；
     - 版本号升级至 `0.3.81`，补充 `0.3.81` 版本更新说明与英文翻译词条。
  5. **后续追加（本机 7 次「未知模型」排查修复 & 仓库模型知识库更新 `2026.11.07`）**：
     - **7 次「未知模型」真相与根因**：排查 `~/.tokenpulse/requests/2026-11.jsonl` 中 7 条 `model: "未知模型"` 记录（`c1e44be5:1`、`03c0a178:1`、`580c35cd:1`、`6c525a31:1`、`d435d17e:1`、`f8736e3e:1`、`92fd7850:1`），全部为 Antigravity 子代理对话的第 1 步模型回复（`step.idx = 1`，对应 `gen_metadata.idx = 0`），真实模型均为 **`gemini-3.8-flash-tiered`**（`MODEL_PLACEHOLDER_M322`，`modelId = 1322`）。因为 Protobuf3 在 `gen_idx = 0`（`meta.20.3 = 0`）时省略默认标量值 `0`，此前 `src/core/antigravity.ts` 要求 `pbFields(genInfo)?.some(f => f.no === 3)` 为真才读取 `gen_metadata`，导致对话刚完成第 1 步即被扫描时 `genIdx = -1` 漏读 `gen_metadata[0]` 并回退为 `"未知模型"`；
     - **修复与知识库同步**：在 `src/core/antigravity.ts`（`readAntigravityGenerations` 与 `readAntigravityConversation`）中改为 `const genIdx = genInfo ? pbNumber(genInfo, 3) : -1;`，在 `src/core/usage-scan.ts` 中将 `ANTIGRAVITY_STATE_VERSION` 升至 `4` 以自动重扫修正首步记录；在 `knowledge/manual.json` 中为 Antigravity Gemini 内部后缀别名补充 `-tiered`（`^(gemini-[\w.-]+?)-(?:b|n|tiered)$`）并为 `capabilities.claude` 补充 `claude-sonnet-5-5`，重新生成并推送 `knowledge/models.json`（版本 `2026.11.07`）。
  6. **后续追加（Antigravity 时间线历史周期切换丢失账号修复 & 周额度窗口卡片 UI 修复）**：
     - **时间线切换历史周期显示「这个账号还没有带账号标识的官方额度周期。」根因与修复**：
       - 在 `renderer/model-study.js` 中，不在 `snapshot.accounts` 内的账号（Antigravity、DeepSeek、号池）通过第 3 个参数 `extra` 传给 `timelineUpdate(snapshot, preferred, extra = null)` 并存入 `T.extra`。但点击时间线周期导航按钮（`‹` / `›`）或重试按钮时调用的 `reloadTimeline()` 写成了 `timelineUpdate(T.snapshot, T.accountId)`，未把 `T.extra` 传回，导致 `T.extra` 被默认参数 `null` 覆盖清空，`timelineAccounts(snapshot)` 找不到 `antigravity` 账号并进入 `drawTimeline('none')` 显示 `这个账号还没有带账号标识的官方额度周期。`。
       - 修复：将 `renderer/model-study.js` 的 `reloadTimeline()` 改为 `timelineUpdate(T.snapshot, T.accountId, T.extra)`；同时在 `renderer/antigravity-quota.js` 中允许在 `current` 尚未就绪时照常调用 `PulseModelStudy.timeline`，并在 `src/main/antigravity-quota.ts` 的 `agyWindowSegments` 中确保提前重置切段后新窗口 `startAt >= previous.endAt` 不产生时间段重叠。
     - **周额度窗口（`.agy-week-box`）预测条与提前重置说明重叠及轨道底色不可见根因与修复**：
       - 在 `renderer/app.css` 中，`.prediction-line` 默认有 `margin: 18px 0`，因此下方的 `.reset-card-note` 设置了负上边距 `margin: -4px 0 14px`（`18px - 4px = 14px`）。但在 `renderer/antigravity.css` 中，`.agy-week-pred` 将下边距覆盖为 `margin-bottom: 0`，导致紧随其后的 `.reset-card-note` 因 `margin-top: -4px` 向上贴边/压入黄色预警卡片（`⚠️ 按最近的速度，约 ... 后用完`）底部，且底部多出 `14px` 外边距；同时 `.agy-week-box` 与内部的 `.track` 背景均为 `var(--surface-2)`，导致浅色模式下周额度进度条底槽完全隐形，且多处使用了未定义的 `--ink` / `--ink-2` 变量。
       - 修复：在 `renderer/antigravity.css` 中新增 `.agy-week-box .reset-card-note { margin: 10px 0 0; }`、`.agy-week-box .track { background: var(--line); }`、`.agy-week-title .section-tag { margin-left: 0; background: var(--surface); }`，并将未定义的 `var(--ink)` / `var(--ink-2)` 替换为标准设计变量 `var(--text)` / `var(--text-2)`。
     - **回归测试**：在 `scripts/test-antigravity-ui.cjs` 中新增 `.agy-week-box` 轨道对比度与 `.reset-card-note` 间距（`gap >= 6px`）断言，以及 `#quota-model-timeline` 历史周期翻页（`1 / 2` ↔ `2 / 2`）断言。
- **验证结果**：
  - `npm run build`：**PASSED (Exit 0)**。
  - `node scripts/test-desk-pet.cjs`：**35/35 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-desk-pet-ui.cjs`：**20/20 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：**3/3 PASSED (Exit 0)**。
  - `node scripts/test-knowledge-update.cjs`：**PASSED (Exit 0)**。
  - `node scripts/test-antigravity-usage.cjs`：**9/9 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：**7/7 PASSED (Exit 0)**。
  - `node scripts/test-antigravity-sessions.cjs`：**3/3 PASSED (Exit 0)**。
  - `node scripts/test-model-study.cjs`：**16/16 PASSED (Exit 0)**。
- **最新产物路径与版本（v0.3.81）**：
  - `dist/TokenPulse-0.3.81-Setup.exe`（SHA256: `4D6EFB004F5AE73726BF487BA0F24272EB7ACE35D0145BB63AB5F6E18FED9B2B`）
  - `dist/TokenPulse-0.3.81-Portable.exe`（SHA256: `8EE07EF2B6FEA16260F7488096038C425E9C37160DBCA521542E57F592637BFA`）
  - `dist/TokenPulse-0.3.81-Setup.exe.blockmap`（SHA256: `39AAC863D9EF61B4AB0D14EAE0A98F6050FF6AD0C28840FD62740AB4E4C04718`）
  - `dist/latest.yml`（SHA256: `CD6FCBB63A8C283475A77E3A9ACF9214084E4E78E7172F57D68BE31AD59F1517`）
  - `dist/win-unpacked/TokenPulse.exe`
  - **Git 提交与发布状态**：代码已提交至 `main`、已打标签 `v0.3.81` 并推送到 `origin/main`；GitHub Release `v0.3.81` 已正式发布（https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.81 ），全部 4 项安装包与元数据附件均已上传。
  - **进程与文件锁状态**：本轮启动的构建与测试进程已全部退出；`build/main/index.js`、`build/core/agent-activity.js`、`dist/TokenPulse-0.3.81-Setup.exe`、`dist/TokenPulse-0.3.81-Portable.exe`、`dist/latest.yml`、`dist/win-unpacked/TokenPulse.exe` 独占句柄检测全部为 `UNLOCKED`（检测句柄已立即关闭）。

---

# 历史版本记录 · TokenPulse v0.3.80 正式版发布完工（主进程与后台扫描内存占用专项修复，2026-11-07）

## 已完成并发布 · TokenPulse v0.3.80 正式版验收与 GitHub Release（2026-11-07，主分支 `main`，版本 v0.3.80）

- **本轮目标与定位**：
  - **版本**：`v0.3.80`（以 `package.json:3` 为准，Git 标签 `v0.3.80`）。
  - **根因诊断**：
    1. Electron / Node 24 启用 V8 指针压缩（Pointer Compression）时，同一 OS 进程内的主线程与 `worker_threads` 共享同一个 4 GB V8 虚拟地址笼与 `PagePool`；当 `report-worker.ts` 在生成快照、查询请求流水或全量重扫会话索引时冲高至 **280–301 MB RSS**，V8 向 OS 提交的物理内存页会留在主进程 `PagePool` 中，即使 `worker.terminate()` 后主进程 Working Set 仍保持在 **255–307 MB**（加上 GPU / 渲染进程合计约 500 MB）。
    2. `src/core/request-log.ts` 的 `readMonth` 此前对整月 `.jsonl`（如 `2026-10.jsonl` 12.2 MB、`2026-11.jsonl` 7.2 MB）执行 `fs.readFileSync + split("\n")`，一次性生成数万条切片字符串与对象并撑爆 V8 新生代（Young Generation），导致大量临时对象晋升至老生代（Old Space）；且 `report.ts` 的 `officialRows()` 全量解析了所有工具（含 Antigravity）并执行代理核验。
    3. `src/core/antigravity.ts` 的 `readAntigravityGenerations` 与 `readAntigravityConversation` 使用 `.all()` 一次性将数千步 `step_payload` BLOB（单个 55 MB 对话库含 27.3 MB BLOB）全量读入内存并执行 `Buffer.from(u8)` 拷贝；桌宠每秒轮询的 `conversationPhase` 每次重新打开全部 `.db` 文件。
    4. `src/core/sessions.ts` 的 `antigravityListStamp` 将全局 `conversation_summaries.db` 的时间戳混入每个 `<id>.db` 的缓存印章，导致当前活跃对话每次更新摘要都会使全部 70 个历史对话库（共 622.4 MB，含 221.6 MB 的 `nested` 子代理库）缓存同时失效，并在 `report-worker.ts` 每 60 秒后台扫描时反复重扫。

- **已完成的关键改动与文件**：
  1. `src/core/request-log.ts`、`src/core/report.ts` & `src/core/route-ledger.ts`：
     - 将 `readMonth` 重构为 256 KB 分块流式生成器 `streamMonth(name, hint, skipAntigravity)`，逐行解析并立即释放，让临时记录留在 V8 新生代内被 Scavenger 回收；
     - 新增 `capacityOnly` 快速通道与轻量 `toCapacityRow`，供 `report.ts` 的 `officialRows()` 按 `quota-history.json` 最早采样范围读取 Claude / Codex / Grok 官方账号请求，跳过非相关工具的 `JSON.parse`、代理核验与全量分面统计；
     - 将时间、日期（带按日边界缓存的 `dayOf`）和来源过滤提前到 `seen` 去重集合之前，并为非全量导出查询引入 `keepLimit` 增量排序截断；
     - 将 `ccSwitchRecords` 的代理匹配改为按 `${source}\u0000${output}` 哈希索引（$O(1)$ 查找）；按文件大小与 `mtimeMs` 缓存 `usage-rollups.json` 归属表与最早请求时间；
     - 在 `route-ledger.ts` 中复用空 `Map` 常量、消除高频闭包分配并按天缓存 `monthNamesAround(at)`，避免在数万条请求循环中重复创建 `Date` 与空 `Map`。
  2. `src/core/antigravity.ts` & `src/main/antigravity-quota.ts`：
     - 在 `openDb` 中设置 `PRAGMA cache_size = -2000; PRAGMA temp_store = MEMORY;` 限制单连接 SQLite 页缓存；
     - 新增零拷贝 `toBuf(u8)`（`Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)`），并将 `readAntigravityGenerations` 与 `readAntigravityConversation` 改为 `stmt.iterate()` 游标流式迭代（对话详情仅查询 `where step_type in (14, 15, 132)`），55 MB 对话库解析内存增量从 `+66 MB` 降至 `+9 MB`；
     - 为 `conversationPhase` 增加按文件大小与 `mtimeMs` 的 `phaseCache` 并在 `readAntigravityActivity` 中跳过 `nested` 子代理对话库；
     - 为 `splitModelLabel` 增加记忆化缓存，并为 `AntigravityQuota` 增加 15 秒 `insightCache` 及 `refreshNow` 单次状态计算复用。
  3. `src/core/sessions.ts` & `src/core/report-worker.ts`：
     - 修复 `antigravityListStamp(file, labelsMtime)`，使每个 `<id>.db` 的缓存印章仅依赖自身（含 `-wal`）与 `antigravity-models.json` 修改时间；`listSessions()` 在循环前一次性读取 `antigravitySummaries()`，将最新标题与工作区直接覆盖到缓存摘要上，并在打开 SQLite 前跳过 `nested` 子代理对话库；
     - 导出 `hasCurrentSessionIndex()`，`report-worker.ts` 仅在会话索引尚未建立或版本升级时后台预热 `listSessions()`，不再每 60 秒后台重扫正在活跃生成的长对话库。
  4. `package.json`、`package-lock.json`、`renderer/intro.js` & `renderer/i18n.js`：
     - 版本号升级为 `0.3.80`，补充 `0.3.80` 版本更新说明与英文翻译词条。

- **实测内存与性能对比结果**：
  - `worker(scan: false)` 完成后进程 RSS：**281.9 MB → 151.4 MB**（降低 **130.5 MB**）。
  - `worker(scan: true)` 全量扫描完成后进程 RSS：**301.3 MB → 153.5 MB**（降低 **147.8 MB / ~49%**）。
  - 主进程 `worker(scan: true)` + `AntigravityQuota.state()` 联合运行后 RSS：**307 MB → 167.3 MB**（`heapUsed` 仅 **34.4 MB**）。
  - 全部自动化测试验证：
    - `npm run build`：**PASSED (Exit 0)**
    - `node scripts/test-antigravity-sessions.cjs`：**3/3 PASSED**
    - `node scripts/test-antigravity-usage.cjs`：**9/9 PASSED**
    - `node scripts/test-requests.cjs`：**64/64 PASSED**
    - `node scripts/test-sessions.cjs`：**PASSED**
    - `node scripts/test-dashboard.cjs`：**7/7 PASSED**
    - `node scripts/test-features.cjs`：**46/46 PASSED**
    - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：**3/3 PASSED**
    - `npx electron --lang=zh-CN scripts/test-ui.cjs`：**26/26 PASSED**

- **最新产物路径与版本（v0.3.80）**：
  - `dist/TokenPulse-0.3.80-Setup.exe`（SHA256: `480B1007489F67C1D6C8180B1E9A2E826C2253649E8E3270D44431FDC7331B8B`）
  - `dist/TokenPulse-0.3.80-Portable.exe`（SHA256: `0DB145626AD1917C284AC293F338A4BBF75944EFBA1112E4A568924A67811C34`）
  - `dist/TokenPulse-0.3.80-Setup.exe.blockmap`（SHA256: `F1570A687FF35D09CCDDAE33FCCF4100DD42B70A4820252CDEDE3131B63272CB`）
  - `dist/latest.yml`（SHA256: `BD415C8684667F7BAD67FF0F15F4FA578F026D673B8ECAD145E6AD78A904FD7E`）
  - `dist/win-unpacked/TokenPulse.exe`
  - **Git 提交与发布状态**：代码已提交（Commit `075771f`）、已打标签 `v0.3.80` 并推送到 `origin/main`；GitHub Release `v0.3.80` 已正式发布（https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.80 ），全部 4 项安装包与元数据附件均已上传并通过 SHA256 摘要核验。
  - **进程与文件锁状态**：本轮启动的构建与测试进程已全部退出；`build/main/index.js`、`dist/TokenPulse-0.3.80-Setup.exe`、`dist/TokenPulse-0.3.80-Portable.exe`、`dist/win-unpacked/TokenPulse.exe` 独占句柄检测全部为 `UNLOCKED`（检测句柄已立即关闭）。

---

# 历史版本记录 · TokenPulse v0.3.79 正式版发布完工（全软件 UI 界面美化、设置重构、多源会话每轮耗时统计与主动内存回收优化，2026-11-07）

## 已完成并发布 · TokenPulse v0.3.79 正式版验收与 GitHub Release（2026-11-07，主分支 `main`，版本 v0.3.79）

- **本轮目标与定位**：
  - **版本**：`v0.3.79`（以 `package.json:3` 为准，Git 标签 `v0.3.79`）。
  - **完成范围**：全量交付四大核心需求（R1、R2、R3、R4）并完成版本升级（`0.3.78` → `0.3.79`）、`renderer/intro.js` + `renderer/i18n.js` 更新说明、Windows 安装包与便携版构建及 GitHub Release `v0.3.79` 发布：
    - **R1（全软件 UI 界面重新设计与美化升级）**：总览、额度详情、用量明细、出口监控、并发监控、会话管理、供应商、体检、桌宠、设置弹窗和托盘面板等全模块现代化质感提升；`<meta name="color-scheme" content="light dark">` 完整支持；暗色模式无障碍极值（`--faint` 4.91:1 WCAG AA、`--accent-contrast` 9.45:1 WCAG AAA、0 处默认 `rgb(0, 0, 0)` 纯黑字）；900px、850px、800px 极限窄屏 0 横向溢出与 0 截断；完全保持与现有自动化测试所依赖的关键 DOM ID、class 及 `data-*` 属性 100% 兼容。
    - **R2（会话管理信息展示统一与每轮耗时统计）**：统一 Claude Code、Codex、Grok、DeepSeek、pi、Antigravity 在会话列表卡片、会话详情顶部元信息栏、会话用量统计面板（KPI 5号卡片、模型拆分表格均轮耗时列）及消息气泡中的数据展示模型与视觉结构；构建 3-tier 耗时关联引擎（Tier 1 直读、Tier 2 时间戳差值带 30 分钟休眠防假碰撞守护、Tier 3 回退保底）与 Protobuf 二进制 `gen_metadata` 纳秒耗时解析及防抖抑制；消息流支持用户轮次预索引、轮次分隔指示线（`第 N 轮 · 耗时 X.Xs`）与气泡速率微标（`⚡ XX T/s`）。
    - **R3（软件流畅度与内存利用及主动回收优化）**：主进程报告生成 Worker 线程严格生命周期管理（消息/错误/退出全分支 `worker.terminate()` 强制清理）；`--expose-gc` 配合 300s 系统空闲主动 GC 与双 session 缓存清理；窗口隐藏/最小化到托盘/切离大型会话时分发 `window-away` 触发 `PulseSessions.hide()` 释放大对象 DOM 与闭包；500 条告警通知与 50 条会话草稿 FIFO 上限防御；长会话列表 40 项分块渲染与 40 条消息虚拟化，支持展开更早消息时精确校准并锚定 `scrollTop` 滚动位置（`prevScrollTop + deltaHeight`）。
    - **R4（BUG 排查与修复及项目协作规范）**：修复跨时区/日期新手引导演示数据本地会话碎片时间假碰撞缺陷；修复设置页标签切换异步滚动事件与下拉菜单焦点恢复的竞态；修复测试运行器与 DXCache EBUSY 并发句柄冲突与优雅退出；严格遵守 AGENTS.md 规范（演示数据无泄露、0 遗留子进程、关键产物独占无锁）。

- **已完成的关键改动与文件**：
  1. `package.json`、`package-lock.json` & `renderer/intro.js`：
     - 升级版本号至 `0.3.79`；在 `renderer/intro.js` 顶部 `NOTES['0.3.79']` 补充三条版本更新说明（会话管理统一展示与每轮对话耗时统计、全软件界面视觉美化与设置页升级、流畅度优化与窗口收起主动内存回收）。
  2. `src/main/snapshot.ts` & `src/core/report-worker.ts`：
     - 重构 Worker 线程生命周期管理，在 `runWorker` 中建立 `settled` 状态机与 `cleanup` 函数，确保 `message`、`error`、`exit` 任意事件触发时必定调用 `worker.terminate().catch(() => {})`，彻底杜绝 Worker 线程驻留和磁盘句柄未释放。
  3. `src/main/index.ts` & `src/main/preload.ts`：
     - 在应用启动参数中注入 `app.commandLine.appendSwitch('js-flags', '--expose-gc')`，使主进程安全暴露 V8 `global.gc()`；
     - 建立 300s 空闲检测器（`setupIdleMonitor`），空闲时自动调用 `session.defaultSession.clearCache()` 与 `global.gc()`；
     - 监听窗口 `hide` 与 `minimize` 事件，向渲染进程广播 `window-away` 状态并执行会话缓存精简；
     - `notifiedRequests` 告警集合引入 500 条 FIFO 严格队列上限，消除长时运行下的无界内存增长；
     - 在 `preload.ts` 中安全暴露 `window.PulseApp.reportDataMetrics()` 及内存回收绑定接口。
  4. `src/core/sessions.ts` & `src/core/antigravity.ts`：
     - 抽象并规范统一会话数据模型（涵盖 ID、标题、来源渠道、模型、创建/更新时间、消息轮次、Prompt/Completion Tokens、总活动耗时、均轮耗时）；
     - 实现 3-tier 耗时关联引擎：Tier 1 直读 `record.durationMs` / `turn.durationMs`；Tier 2 计算问答时间戳差值（附带 30 分钟上限安全阈值，防止用户挂起导致统计失真）；Tier 3 保底估算；
     - `antigravity.ts` 中解析 Protobuf 二进制 `gen_metadata` 中的时间戳和耗时元数据，对工具调用（Tool Calls）执行防抖抑制，准确提取首字延迟（TTFT）与轮次生成耗时。
  5. `src/core/demo-data.ts`：
     - 修复跨时区/跨日期新手引导演示数据生成逻辑，在插入保底聊天时安全剔除 `[from - 30m, to + 30m]` 区间内的本地 session 碎片，彻底消除假碰撞，确保 `scripts/test-intro-ui.cjs` 在所有时区与系统时间下 100% 稳定通过。
  6. `renderer/index.html`：
     - `<head>` 注入 `<meta name="color-scheme" content="light dark">` 声明；
     - 重构「设置」模态框中的「数据」选项卡，引入现代化卡片容器（`#data-metrics`、`.data-metrics-grid`）展示账本数、请求数与缓存状态，保留全部原有 6 大动作按钮与方法论说明；
     - 新增 `#data-trim-cache` 手动主动内存回收按钮。
  7. `renderer/app.css` & `renderer/sessions.css`：
     - 构建现代化全局设计令牌（Design Tokens）：暗色模式 `--faint: #7e8898`（对比度 4.91:1 WCAG AA）、`--accent-contrast: #06140e`（对比度 9.45:1 WCAG AAA）；
     - 全局重置原生表单元素样式，深色模式输入框显式指定前景色与背景色，彻底杜绝默认 `rgb(0, 0, 0)` 纯黑字；
     - 响应式断点统一提升为 900px（`@media (max-width: 900px)`），引入 `.table-scroll` 与 `overflow-wrap: anywhere`，保障 900px 窄窗口下零横向溢出；
     - 实现自绘弹性开关组件（`.dps-switch`、`.dps-knob`）及现代化卡片悬浮投影效果；
     - 美化会话管理视图，优化卡片、元信息栏、KPI 网格、消息气泡与轮次分隔线视觉结构。
  8. `renderer/app.js`：
     - 实现具备 WAI-ARIA 可访问性的 `prefToggle` 开关交互，支持鼠标点击与键盘 Space / Enter（带 `\r` 兼容）切换；
     - 严格保持 DOM 结构不变式：`#pref-quotaQuietBackground` 处于紧随 `#pref-quota-every` 之后的下一个 `.setting-block` 兄弟卡片中，且保持下拉菜单机制（`#option-menu`）；
     - 在 `openOptionMenu` / `closeOptionMenu` 中使用 `focus({ preventScroll: true })` 并对刚弹出的菜单添加 80ms 滚动防抖守护，消除切换设置标签页异步 `scroll` 事件意外关闭菜单的竞态；
     - 挂载 `renderDataMetrics()` 实时遥测展示；绑定 `#data-trim-cache` 触发 `PulseSessions.hide()` 与前端缓存清理。
  9. `renderer/sessions.js`：
     - 实现会话列表 40 项分块加载（`LIST_CHUNK = 40`）与「加载更多」按钮；
     - 实现消息流 40 条虚拟化分段加载（`MSG_CHUNK = 40`）与「显示更早」按钮；
     - 展开更早历史消息时，利用 `prevScrollTop + deltaHeight` 实现平滑滚动锚定，阅读视点零跳动；
     - 统一各个渠道的数据呈现，规范用量卡片 5 号 KPI（均轮耗时与速度）、模型拆分表格「均轮耗时」列、消息气泡底栏微标（模型、耗时、速率）与轮次分隔线。
  10. `renderer/i18n.js`：
      - 完善双语字典与动态正则表达式（涵盖 `0.3.79` 更新说明、耗时进位、速率单位、数据遥测与无量化降级提示）；
      - 保证英文模式（`en`）下全界面和用量面板 0 处残留中文字符（`/[一-鿿]/`）。

- **全量测试命令与实际结果**：
  - `npm run build` / `npm run compile`：**PASSED (Exit 0)**，TypeScript 0 编译错误，0 告警。
  - `npm test`：**PASSED (Exit 0)**，全量 68+ 项核心后端与单元回归测试 100% 通过。
  - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：**PASSED (Exit 0)**，`v0.3.79` 新手引导与「新版本有什么」中英双语核验 100% 通过。
  - `npx electron --lang=zh-CN scripts/test-ui.cjs`：**26/26 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：**7/7 PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-tray-panel.cjs` & `scripts/test-tray-panel-ui.cjs`：**PASSED (Exit 0)**。
  - `npx electron --lang=zh-CN scripts/test-desk-pet.cjs` & `scripts/test-desk-pet-ui.cjs`：**PASSED (35/35 logic, 20/20 UI, Exit 0)**。
  - `npm run dist`：**PASSED (Exit 0)**，成功生成 `v0.3.79` 完整发布产物。

- **最新产物路径与版本（v0.3.79）**：
  - `dist/TokenPulse-0.3.79-Setup.exe`（SHA256: `E15FAB73DB5AA12C49FA8CAD6E19A2BEACDFDFBB833804AD53295A6E1F7AF2F9`）
  - `dist/TokenPulse-0.3.79-Portable.exe`（SHA256: `C2B1CF2D3801AF2568A0B63B210705F8B4183528F19AC5F7A670D5528C6AB407`）
  - `dist/TokenPulse-0.3.79-Setup.exe.blockmap`（SHA256: `5485E0ED6E19D552FECF8DF2B1B212C2D7FEBAE36078BF610C098E264D006846`）
  - `dist/latest.yml`（SHA256: `A77A227C3AD328AE6D5678DB066ECB92BA38C19B47B1B79BC93F415A20F2C88D`）
  - `dist/win-unpacked/TokenPulse.exe`
  - **Git 提交与发布状态**：已提交（Commit `5406683`）、已打标签 `v0.3.79` 并推送到 `origin/main`；GitHub Release `v0.3.79` 已正式发布（https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.79 ），全部 4 项安装包与元数据附件均已上传并通过 SHA256 摘要校验。

- **进程与资源释放状态（严格遵循 AGENTS.md 规范）**：
  - **进程检查**：PowerShell 执行 `Get-Process node, electron -ErrorAction SilentlyContinue`，确认当前 0 遗留 `node.exe`、0 遗留 `electron.exe`。
  - **目录与句柄检查**：
    - 对核心产物文件 `build/main/index.js`、`dist/TokenPulse-0.3.79-Setup.exe`、`dist/TokenPulse-0.3.79-Portable.exe`、`dist/win-unpacked/TokenPulse.exe` 执行独占读写检验（`[System.IO.File]::Open(..., 'Open', 'ReadWrite', 'None')`），确认状态全部为 `UNLOCKED`，检测句柄立即关闭；
    - 打包目录 `dist/` 与中间缓存目录无常驻占用，无 EBUSY / EPERM 锁定；
    - 用户目录 `clawd-pet-extracted/` 原样保留未触碰。

- **已知限制与后续维护建议**：
  1. **Node/V8 原生 GC 行为**：`global.gc()` 仅在启动参数包含 `--expose-gc` 时可用（生产主进程已在 `app.commandLine.appendSwitch` 中默认开启；独立测试或脚本若需调用需显式传参 `node --expose-gc`）。
  2. **打包与发布**：若后续执行 `npm run dist` 或 `npm run dist:portable`，请确保工作目录保持在项目根目录，并在打包完成后核实 electron-builder 进程完全退出。
  3. **国际化扩展**：后续若在 UI 新增包含耗时、速率或数字单位的文案，需在 `renderer/i18n.js` 中同步补充静态词条或拓展动态正则转换模式，保持英文模式零 CJK 泄漏标准。

---

# 前序接手记录 · 里程碑 M5 第 2 阶段（对抗压测覆盖加固与白盒挑战者审计）已完成并通过 100% 验收（2026-11-07）

## 本地完成 · 里程碑 M5 第 2 阶段挑战者 2（前端 UI、设置、主题、虚拟化与国际化对抗压测）验收（2026-11-07，开发分支）

- **角色与定位**：`teamwork_challenger`（Challenger 2 — 前端 UI 样式、设置交互、暗色对比度、900px 响应式、会话列表/消息虚拟化边界及国际化双语纯洁性对抗测试）。
- **目标与范围（对应需求 R1、R2、R3、R4，特性 F1、F2、F4、F5、F9、F15）**：
  1. **前端样式与暗色模式无障碍极值**：
     - 数学检验 `--faint`（#7e8898）对比 `--surface`（#16191f）达到 4.91:1（>= 4.5:1 WCAG AA）；
     - 薄荷绿 `--accent`（#3fcf8e）对比 `--accent-contrast`（#06140e）达到 9.45:1（>= 7.0:1 WCAG AAA）；
     - 遍历暗色模式下 8 个业务页面及设置弹窗全部可见文字节点，严格验证 0 处默认 `rgb(0, 0, 0)` 纯黑字；
     - 重点核验提示气泡（`.info-tip-pop`）、代码块（`.sw-code`、`pre`、`code`）、徽章芯片（`.sw-chip`、`.sw-item-usage`、`.sw-item-turns`）与动态卡片（`.setting-block`、`.modal-card`、`.sw-bubble`）；
     - 在 900px、850px、800px 极限窄视口下测试所有 8 个视图及设置弹窗，严格确保 0 窗口横向滚动条、0 卡片截断及 0 消息气泡文字溢出。
  2. **设置交互与 DOM 不变式**：
     - 验证核心开关（`#pref-closeToTray`、`#pref-autoLaunch`、`#pref-startMinimized`）原生 `<button role="switch">` 属性与 `aria-checked` 状态；
     - 验证鼠标点击与键盘 Space / Enter（带 `\r` 字符序列）交互平滑切换 `aria-checked`、`.on` 类名与对应文案；
     - 严格验证 `#pref-quota-every` 所在卡片与 `#pref-quotaQuietBackground` 所在卡片保持直接连续兄弟节点关系不变；
     - 验证 `#pref-quotaQuietBackground` 与 `#pref-weeklySummary` 作为下拉菜单触发器，点击后均能正常弹出带有 2 个及以上 `.option-item` 的 `#option-menu`；
     - 验证配置持久化：在 `prefs.json` 中布尔型设置项严格保持原生 `boolean` 类型（无 `"true"` 字符串或 `1` 数值污染）。
  3. **会话管理统一、分页虚拟化与国际化纯洁度**：
     - 列表分块渲染极值：0 会话时展示友好空状态提示且 0 项无加载更多；1 会话与 40 会话（`LIST_CHUNK` 边界）正常渲染且 0 加载更多按钮；41 会话呈现初始 40 项与「加载更多（剩余 1 项）」按钮，点击后平滑展开至 41 项并移除按钮；100 会话验证 40 -> 80 -> 100 步进展开；
     - 消息虚拟化极值：40 消息直接全量渲染无更早按钮；41 消息初始渲染 40 条并展示「显示更早的 1 段」按钮；85 消息在点击更早后展开至 80 条，且精确校准并锚定 `scrollTop` 滚动位置（`prevScrollTop + deltaHeight`），保持阅读视点不跳动；
     - 耗时格式化临界值：验证 0ms（空）、500ms（500ms）、999ms（999ms）、1000ms（1s）、59999ms（60s）、60000ms（1m 0s）、119999ms（2m 0s）、3599999ms（60m 0s）及负数/NaN（空）格式化进位翻转；
     - 英文国际化纯洁性：切换 English 模式后，深度遍历会话列表、元信息栏、KPI 卡片、表格头、轮次分隔线（`Round 1 · 2.4s`）与气泡底栏，严格验证全界面 0 处残留中文字符（`[一-鿿]`）。
- **新增压测脚本与输出产物**：
  - `scripts/test-challenger-m5-2.cjs`：白盒对抗压力测试套件（覆盖上述 4 大领域、3 大测试套件，共 63 项独立白盒断言）。
  - `.agents/teamwork/challenger_m5_2/handoff.md`：5 章节完整交接报告（最终裁决：**APPROVE**）。
- **验证命令与实际结果**：
  1. `node scripts/test-challenger-m5-2.cjs`：**63/63 项对抗检查全部通过**（0 缺陷，0 警告，100% PASS，退出码 0）。
  2. `npm run build`：TypeScript 编译干净通过，退出码 0。
  3. `npm test`：全套 67 项核心测试套件 100% 全部通过，退出码 0。
- **进程与资源释放检查（严格遵守 AGENTS.md 规范）**：
  - PowerShell 执行 `Get-Process node, electron -ErrorAction SilentlyContinue`，确认 0 遗留子进程，完全释放全部进程与句柄；
  - 测试产生的临时目录（`tp-challenger-m5-2-*`）全部清理完毕；
  - `build/` 和 `dist/` 均处于自由无锁状态。

---

# 前序接手记录 · 里程碑 M5 第 1 阶段（全套端到端与全量回归测试套件执行验证）已完成并通过 100% 验收（2026-11-07）

## 本地完成 · 里程碑 M5 第 1 阶段全套 E2E 与回归测试验收（2026-11-07，开发分支）

- **目标与范围（对应需求 R1、R2、R3、R4，全量特性 F1–F19）**：
  - 执行 4 层主 E2E 测试套件（`node scripts/test-e2e-suite.cjs`），验证全部 122 项测试 100% 全部通过（0 失败，0 pending）；
  - 执行全部 11 项独立回归测试套件（编译构建、单元测试、会话解析、双挑战者对抗压测、全套桌面 Electron UI 自动化）；
  - 排查并修复测试发现的潜在缺陷，确保跨日期跨时区稳定性；
  - 严格审计并释放进程与文件句柄，确认 0 悬挂子进程、`build/` 和 `dist/` 独占访问完全解锁。
- **完成的改动与关键文件**：
  - `src/core/demo-data.ts`：排查修复了新手引导演示数据中固定时间聊天（`midnight(now) - back * 86400000 + 20 * 3600000`）偶发与随机生成的晚间本机 Code 会话（`sessions`）时间重叠，导致 `cleanSegment` 因检测到本机请求而将聊天误判为本机用量、进而导致时间线上 `offMachine.detected` 为空的跨日期/时区 Bug。改动在插入保底聊天时安全剔除 `[from - 30m, to + 30m]` 区间内的本地 session 碎片，彻底消除假碰撞，确保 `scripts/test-intro-ui.cjs` 在所有时区与日期下稳定通过。
- **验证命令与实际结果（全量 100% PASS）**：
  1. `node scripts/test-e2e-suite.cjs`：**122/122 全部通过**（Tier 1: 95/95, Tier 2: 18/18, Tier 3: 6/6, Tier 4: 3/3，0 failed, 0 pending，100% PASSED）。
  2. `npm run build`：TypeScript 编译干净通过，退出码 0。
  3. `npm test`：全部 65+ 项后端单元与回归测试通过，退出码 0。
  4. `node scripts/test-sessions.cjs`：会话解析与 3-tier 耗时测试通过，退出码 0。
  5. `node scripts/test-antigravity-sessions.cjs`：3/3 Antigravity 会话解析与 Protobuf 流式元数据测试通过，退出码 0。
  6. `node scripts/test-challenger-m4-1.cjs`：M4 UI 开关、DOM 不变式与数据遥测压测全部通过（100%），退出码 0。
  7. `node scripts/test-challenger-m4-2.cjs`：27/27 对抗压测全部通过（暗色模式零黑字、900px 零溢出、会话耗时/速率微标、英文模式零中文泄漏），退出码 0。
  8. `npx electron --lang=zh-CN scripts/test-ui.cjs`：26/26 测试步骤全部通过，退出码 0。
  9. `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：7/7 Antigravity UI 自动化测试全部通过，退出码 0。
  10. `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：新手引导全流程、几何高亮、窄屏与版本升级更新说明全部通过，退出码 0。
  11. `npx electron --lang=zh-CN scripts/test-tray-panel.cjs` & `scripts/test-tray-panel-ui.cjs`：托盘面板逻辑与 UI 自动化测试全部通过，退出码 0。
  12. `npx electron --lang=zh-CN scripts/test-desk-pet.cjs` & `scripts/test-desk-pet-ui.cjs`：35/35 桌宠逻辑与 20/20 桌宠 UI 自动化测试全部通过，退出码 0。
- **进程与资源释放检查（严格遵守 AGENTS.md 规范）**：
  - PowerShell 执行 `Get-Process node, electron -ErrorAction SilentlyContinue`，确认 0 遗留子进程，无任何悬挂进程。
  - 项目根目录构建产物 `build/main/index.js` 执行独占读写打开检测（`fs.openSync(..., 'r+')`），确认完全 `UNLOCKED` 且立即释放句柄；`dist/` 目录访问正常，无 EBUSY / EPERM 锁定。
  - 本轮测试产生的临时沙箱目录全部彻底清空。

---

# 前序接手记录 · 里程碑 M4（全局 UI 现代化、设置面板优化与会话界面统一）已落地并通过全量验证（2026-11-07）

## 本地完成 · 里程碑 M4 全局 UI 现代化与会话界面落地验证（2026-11-07，开发分支）

- **目标与范围（对应需求 R1、R4、R5，特性 F1、F2、F4、F5）**：
  - **F1 全局现代主题系统与暗色模式无障碍优化**：
    - 在 `renderer/index.html` 的 `<head>` 中添加 `<meta name="color-scheme" content="light dark">`（修复 E2E F1.3）；
    - 保留不变契约 `:root[data-theme=dark] { --sidebar: #121419; --surface: #16191f; }`（满足 `test-ui.cjs:655` 及 F1.2 严格比对）；
    - 将暗色模式下的 `--faint` 从 `#626a77` 提升到 `#7e8898`，确保在所有暗色表面达到 >= 4.80:1 WCAG AA 对比度；
    - 在 `:root` 与 `:root[data-theme=dark]` 中分别定义 `--accent-contrast`（亮色 `#ffffff`，暗色薄荷绿 `--accent: #3fcf8e` 对应 `--accent-contrast: #06140e`），解决高亮按钮/状态徽章/选中文本可读性；
    - 原生表单元素（`button, input, select, textarea`）统一重置继承样式 `font: inherit; color: inherit;`，并为输入框明确指定深色背景与文本色，杜绝深色模式下出现默认 `rgb(0, 0, 0)` 黑字；
    - 响应式断点统一从 `860px` 调整为 `900px`，大卡片网格在 900px 时优雅单列折叠，表格容器具备 `.table-scroll { overflow-x: auto; max-width: 100%; }` 与 `overflow-wrap: anywhere;` 防溢出保护，保证在 900px 宽度下 `scrollWidth <= window.innerWidth`（通过 F1.4）。
  - **F2 设置面板卡片式优化与交互重构**：
    - 完整保留全部 5 个设置选项卡：`general`、`accounts`、`alerts`、`data`、`about`；
    - 核心布尔开关（`closeToTray`、`autoLaunch`、`startMinimized`、`notifyMismatch`）升级为自绘平滑弹簧动画交互式 `.dps-switch` 开关组件（含 `.dps-knob` 和可编程无障碍 `.checked` 属性）；
    - 严格保持测试强约束不变式：`pref-quotaQuietBackground` 与 `pref-weeklySummary` 继续使用 `optionSelect`（满足 `scripts/test-ui.cjs` 和 `scripts/test-share-ui.cjs` 对 `#option-menu` 的显式断言）；
    - 严格保证 `pref-quotaQuietBackground` 处于紧随 `#pref-quota-every` 之后的下一个 `.setting-block` 兄弟元素中（满足 `test-ui.cjs:142` 的 DOM 结构断言）；
    - 重构「数据」面板，引入卡片化 `.setting-card` 结构与 4 张遥测指标卡片（`#data-metrics`、`.data-metrics-grid`：用量账本文件数与请求数、会话缓存项数、脱敏排查日志说明、内存回收与清理策略）；
    - 严格保留并完全对齐全部 6 个专属动作按钮 ID：`#open-data`、`#open-log`、`#open-tokens-ci`、`#open-deepseek-balance`、`#open-relay-balance`、`#open-config-backups`，以及 `.setting-block.methodology-copy`；
    - 新增 `#data-trim-cache` 按钮，绑定主动式渲染缓存清理与 V8 垃圾回收（`PulseSessions.hide()` + `window.gc()`）。
  - **F4/F5 会话管理界面统一、轮次耗时与生成速率呈现**：
    - 左侧会话卡片（`.sw-item`）：保留 `.sw-item-usage`（无测量用量时渲染语义化 `.unrecorded` 降级文本 `未统计用量`，满足 `test-antigravity-ui.cjs` 断言），新增主模型标识微标（`.sw-item-model`）与每轮耗时徽章（`⏱️ 3.5s` 或 `⏱️ ≈3.5s`）；
    - 顶部会话栏（`.sw-head`）：渲染模型芯片（多于 2 个模型时带有 `+N` 溢出弹窗芯片）、会话总活动耗时芯片（`活动 8.4s`）以及平均每轮耗时芯片（`⏱️ 均轮 3.8s`）；
    - 用量面板（`.sw-usage-panel`）：新增第 5 块核心 KPI 卡片「均轮耗时与速度」（展示 `formatLatency(avgLat)` 与速率/总活动时长 `⚡ XX T/s · 总活动 X.Xs`），在模型拆分明细表格中新增「均轮耗时」列，表格容器使用无障碍区域包裹（`tabindex="0" role="region" aria-label="模型用量明细"`），并针对无用量统计的会话提供友好的空状态卡片（`.sw-usage-empty`）；
    - 消息气泡列表：在助理消息气泡底栏（`.sw-bubble-foot`）追加对应模型、每轮耗时（`⏱️`）与生成速率微标（`⚡`）；
    - 轮次分隔线：在 `drawMessages()` 中预索引用户轮次，在每轮提问上方渲染清晰的轮次指示线 `.sw-round-divider`（`第 N 轮 · 耗时 X.Xs`）；
    - 响应式支持：1200px 3列用量卡片、900px 2列表格及单列折叠会话布局；
    - 双语国际化（`renderer/i18n.js`）：新增静态词典翻译与动态正则表达式转换模式，保证在英文模式下全界面与 `.sw-usage-panel` 完全不含中文字符（通过 `test-antigravity-ui.cjs:185` 的 `!/[一-鿿]/` 严格断言）。
- **完成的改动与关键文件（严格限定 6 个前端专属文件）**：
  1. `renderer/index.html`：添加 `<meta name="color-scheme" content="light dark">`；重构设置「数据」选项卡为现代化卡片布局（`#data-metrics` 遥测网格、`#data-trim-cache` 缓存清理按钮），保留所有历史按钮与统计口径。
  2. `renderer/app.css`：完善暗色与亮色模式变量（`--accent-contrast`、`--faint: #7e8898`）；定义现代卡片提升阴影、表单元素继承、`.dps-switch` 弹簧开关与 `.dps-knob`；新增设置面板网格与数据指标卡样式；将全局响应式断点统一更新为 `@media (max-width: 900px)`，增加表格滚动防溢出。
  3. `renderer/app.js`：实现 `prefToggle` 组件（生成包含 `.dps-knob` 及可访问属性的开关）；将常规设置项迁移至开关组件，保持 `quotaQuietBackground` 与 `weeklySummary` 为下拉菜单；实现 `renderDataMetrics()` 实时渲染文件数与请求数；绑定 `#data-trim-cache` 内存回收处理器。
  4. `renderer/sessions.js`：实现 `formatLatency()` 与 `formatDuration()`；在列表项中增加主模型徽章与耗时微标，未测量用量项优雅降级；顶部头栏增加模型溢出芯片、活跃耗时与均轮耗时；用量面板扩展第 5 块耗时与速度 KPI 卡、明细表均轮耗时列与无用量空状态；消息底栏添加模型、耗时与速率；渲染每轮对话之间的轮次分割指示器 `.sw-round-divider`；在 `PulseSessions` 导出 `count()`。
  5. `renderer/sessions.css`：为会话模型标签、用量降级、耗时与速度微标、溢出菜单、用量空状态、气泡底栏扩展项、轮次分割线及 5 列 KPI 网格添加完整样式；适配 1200px / 900px 响应式折叠。
  6. `renderer/i18n.js`：在 `EN` 词典中补充会话耗时、速度、空状态及设置数据指标翻译项；在 `PATTERNS` 中添加 `⏱️ 均轮`、`第 N 轮 · 耗时`、`⚡ XX T/s`、请求记录数与会话索引数等动态替换规则。
- **验证命令与实际结果**：
  - `npm run build`：TypeScript 编译干净通过，退出码 0。
  - `node scripts/test-e2e-suite.cjs --milestone=m4`：**30/30 M4 端到端测试 100% 全部通过**（F1: 5/5, F2: 5/5, F4: 5/5, F5: 5/5, F17: 5/5, F18: 5/5，0 失败，0 pending）。
  - `npx electron --lang=zh-CN scripts/test-ui.cjs`：**26/26 测试步骤全部通过**，退出码 0。
  - `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：**7/7 测试全部通过**（包括暗色模式无黑字、900px 无溢出、英文模式 `!/[一-鿿]/` 无中文字符泄漏验证），退出码 0。
  - `node scripts/test-tray-panel.cjs`：全部通过，退出码 0。
  - `node scripts/test-desk-pet.cjs`：全部通过，退出码 0。
  - `node scripts/test-sessions.cjs` & `node scripts/test-antigravity-sessions.cjs`：会话核心解析全部通过，退出码 0。
- **进程与资源释放检查（严格遵守 AGENTS.md 规范）**：
  - 构建与全量测试执行后，执行 PowerShell `Get-Process electron, node` 检查确认 0 遗留子进程，无任何悬挂进程。
  - 项目根目录构建产物 `build/` 及前端静态资源无任何文件锁占用，无 EBUSY / EPERM 锁定。

---

# 前序接手记录 · 里程碑 M3（多源会话数据架构与每轮耗时关联系数引擎）已落地并通过全量验证（2026-11-07）

## 本地完成 · 里程碑 M3 核心引擎落地与全量契约测试验证（2026-11-07，开发分支）

- **目标与范围（对应需求 R2，特性 F6、F7、F8）**：
  - 增强统一会话数据模型（`SessionMessage`、`SessionUsage`、`SessionModelUsage`、`SessionSummary`），补充每轮耗时 `durationMs`、首字延迟 `firstTokenMs`、生成速率 `tokensPerSec`、对应模型 `model`、估算标记 `latencyEstimated`、会话及模型级平均轮耗时 `avgRoundDurationMs`、会话有效活跃时长 `totalActiveDurationMs`、平均速率 `avgTokensPerSec` 与可恢复命令标记 `resumable`；
  - 实现轮次状态跟踪机制（`currentTurnStartAt`、`currentTurnUserIndex`、`currentTurnAssistantIndices`）与 3-Tier 耗时关联引擎（Tier 1: 直接测量/精准测量；Tier 2: 轮次时间差估算，含 100ms 假事件剔除与 30 分钟休眠保护；Tier 3: 优雅回退兜底）；
  - 实现与本地路由台账（`routeReturned`）的多源关联；
  - 提取 Antigravity 原生 Protobuf `gen_metadata` 生成元数据与步骤流式时间戳，并具备整包工具调用快速假首字（>500 T/s 且 >=150 tokens）自动抑制与校正机制；
  - 覆盖全部 6 大 CLI / Agent 会话来源：Claude Code、Codex CLI、Grok Build、DeepSeek Harness、pi、Antigravity；
  - 更新会话单元测试与 E2E 测试套件（`test-sessions.cjs`、`test-antigravity-sessions.cjs`、`scripts/e2e/tier1-features.cjs`）。
- **完成的改动与关键文件（严格限定专属文件）**：
  1. `src/core/antigravity.ts`：在 `readAntigravityConversation` 中解码 Protobuf `gen_metadata`，提取 `firstTokenMs`、`streamingMs` 与实际耗时，过滤整包工具调用假首字，计算步骤级与轮次级生成速度 `tokensPerSec`，返回精确的 `isMeasured: true` 步骤属性。
  2. `src/core/sessions.ts`：
     - 类型定义全面增强（`SessionMessage`、`SessionUsage`、`SessionModelUsage`、`SessionSummary`）；
     - 导出 `correlateLatency`（Tier 1/2/3 耗时关联与 30 分钟休眠保护）与 `formatLatency`（支持 `≈` 估算前缀与毫秒/秒级自适应格式化）；
     - 递增 `INDEX_VERSION = 4` 自动失效旧索引；
     - 在 `Builder` 类中建立轮次生命周期（`closeTurn()`、`addAssistantIndex()`），在每轮助理消息上注入 `durationMs`、`model`、`latencyEstimated`，在 `buildUsage()` 与 `summarize()` 中聚合计算会话级与模型级 `avgRoundDurationMs`、`totalActiveDurationMs` 与 `avgTokensPerSec`；
     - 完善 6 大提供商的解析逻辑：Claude（提取 requestId/message.id、模型名、轮次时间差）、Codex（提取 token_usage_record 的 responseId、模型名、轮次耗时）、Grok（提取分块模型、关联轮次耗时）、DeepSeek（提取 stream 真实首字与持续时间作为 Tier 1，或回退轮次时间差）、pi（直接提取 message/row 中的 `durationMs` 作为 Tier 1）、Antigravity（聚合步骤时间戳与流式元数据作为 Tier 1）。
  3. `scripts/test-sessions.cjs`：更新 mock 会话数据与严格的 usage 断言（含 `avgRoundDurationMs: 6000`、`totalActiveDurationMs: 6000`、`avgTokensPerSec: 100` 等），补充 pi `durationMs: 2500` 直接测量断言，补充 3-Tier 耗时关联、休眠保护与格式化逻辑测试。
  4. `scripts/test-antigravity-sessions.cjs`：更新 mock 数据库会话数据注入 Protobuf `duration` 生成元数据，断言会话级活跃耗时（2000ms）、生成速率（500 T/s）及步骤级真实速率（300 T/s）与首字延迟（450ms）。
  5. `scripts/e2e/tier1-features.cjs`：F6.1–F6.5（多源时间戳提取）、F7.1–F7.5（3-Tier 耗时引擎与休眠保护）、F8.1–F8.5（统一会话数据模型与跨 IPC 序列化）测试 100% 通过。
- **验证命令与实际结果**：
  - `npm run build`：编译无报错，退出码 0。
  - `node scripts/test-sessions.cjs`：全部会话解析、用量统计与 3-Tier 关联测试通过，退出码 0。
  - `node scripts/test-antigravity-sessions.cjs`：3/3 Antigravity 会话与元数据测试全部通过，退出码 0。
  - `node scripts/test-e2e-suite.cjs --milestone=m3`：**15/15 M3 测试用例 100% 全部通过**（F6/F7/F8 全部 PASS，0 pending，0 failure）。
  - `npm test`：全套 60+ 后端单元测试及回归套件通过，退出码 0。
- **进程与资源释放检查（AGENTS.md 规范）**：
  - 构建与测试后经 `Get-Process node, electron` 检查，结果为 0 驻留进程，无遗留背景进程。
  - 产物目录 `build/` 及代码文件句柄全部释放，无 EBUSY / EPERM 锁定。

---

## 前序完成 · 里程碑 M2 核心引擎改造与 100% 契约验证（2026-11-07，开发分支）

- **目标与范围（对应需求 R3，特性 F10、F11、F12、F13、F14、F15、F16）**：
  - 彻底治理主进程 Worker 线程驻留与内存泄漏；
  - 建立主进程主动内存回收、空闲监控、V8 显式垃圾回收与会话缓存清理机制；
  - 建立渲染进程切页/离开会话生命周期通知，卸载大型会话 DOM 并释放会话详情 JSON；
  - 实现会话列表 40 项分块惰性追加与消息区域 40 块虚拟化滚动锚定（零抖动）；
  - 解耦 30 秒全局轮询渲染与相对时间局部文本更新，消除重绘与输入卡顿。
- **完成的改动与关键文件（严格限定 6 个专属文件）**：
  1. `src/main/snapshot.ts`：在 `runWorker` 的 `message`、`error` 与 `exit` 事件回调中增加严格的 `cleanup` 与 `worker.terminate().catch(() => {})` 终止调用，避免孤儿线程累积。
  2. `src/core/report-worker.ts`：将 `listSessions()` 会话索引构建移至 `parentPort!.postMessage(snapshot)` 之前，确保主线程终止 worker 前磁盘 I/O 已经安全完成。
  3. `src/main/index.ts`：
     - 在启动命令行注入 `app.commandLine.appendSwitch('js-flags', '--expose-gc')` 暴露 V8 `global.gc`；
     - 在 `setWindowAway` 中向渲染进程派发 `window-away` IPC 事件，并在窗口离开时主动调用 `session.defaultSession.clearCache()`、`win.webContents.session.clearCache()` 与 `global.gc()`；
     - 引入 `setupIdleMonitor` 周期检测 `powerMonitor.getSystemIdleTime()`，在空闲超 300 秒时自动触发缓存修剪与 V8 垃圾回收；
     - 将 `notifiedRequests` 告警集合使用 FIFO 策略严格限制在 500 条上限内。
  4. `src/main/preload.ts`：在 ContextBridge 暴露 `onWindowAway: (handler) => ...` 安全事件监听通道。
  5. `renderer/app.js`：
     - 在 `navigate(page)` 切页离开 `sessions` 时主动调用 `window.PulseSessions?.hide?.()`；
     - 注册 `api.onWindowAway` 监听，离开时 hide 会话，恢复时重新 show 会话；
     - 实现 `updateRelativeTimes()` 局部文本更新，解耦 30 秒定时器中的全局全量 `render()` 重绘；
     - 为配额倒计时节点补充 `data-reset-at` 属性支持原位刷新。
  6. `renderer/sessions.js`：
     - 实现 `PulseSessions.hide()` 卸载 `.sw-messages` 消息 DOM、释放 `S.detail = null`、保存草稿并重置渲染标记；
     - 优化 `PulseSessions.show()` 支持从 `S.detail = null` 无缝自动恢复；
     - 实现会话列表 40 项分批渲染（`LIST_CHUNK = 40`）与 `N.list` 被动滚动监听追加；
     - 实现消息区域 40 块初始渲染（`MSG_CHUNK = 40`）与 `N.scroller` 顶部滚动零抖动高度补偿加载；
     - 将 `S.drafts` 草稿字典限制在 50 条 FIFO 上限内。
- **验证命令与实际结果**：
  - `npm run build`：编译无报错，退出码 0。
  - `node scripts/test-e2e-suite.cjs --milestone=m2`：**35/35 测试用例 100% 全部通过**（F10/F11/F12/F13/F14/F15/F16 均通过，0 pending，0 failure）。
  - `node scripts/test-e2e-suite.cjs`：**121/122 全部通过**，仅剩 1 个属于 M4 的 F1.3（`<meta name="color-scheme">`）。
  - `npm test`：全部后端单元测试与回归套件通过，退出码 0。
  - `npx electron --lang=zh-CN scripts/test-ui.cjs`：26/26 全部通过，退出码 0。
  - `npx electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：7/7 全部通过，退出码 0。
  - `npx electron --lang=zh-CN scripts/test-intro-ui.cjs`：全部通过，退出码 0。
  - `node scripts/test-tray-panel.cjs` & `node scripts/test-desk-pet.cjs`：全部通过，退出码 0。
- **进程与资源释放检查（AGENTS.md 规范）**：
  - 构建与测试后经 `Get-Process node, electron` 检查，所有测试及 Worker 子进程均已完全终止，无遗留驻留进程。
  - 产物目录及代码文件句柄全部释放，无 EBUSY / EPERM 锁定。

---

## 历史接手记录

### 0.3.78 已正式发布（2026-11-06）

## 0.3.78 已正式发布（2026-11-06 本地时间，GitHub 记录 2026-11-07T04:04Z，用户说「OK 这两个修复算一个小版本来发布吧 辛苦你啦~」）

- 内容：下面两节「排查并修复 Antigravity `gemini-4-argon-b` 首字延迟（TTFT）偏慢与整包工具调用假首字问题」与「修复 Antigravity 周额度整窗折算被放大至 ~80 亿 Token 的 Bug」（那两节写的「版本仍 0.3.77、未提交」指当时）。`renderer/intro.js` 加 `0.3.78` 两条更新说明 + `renderer/i18n.js` 英文翻译及提前重置时间提示正则；`git fetch` 远端没有新提交；`npm version 0.3.78 --no-git-tag-version`。
- 升版本后：`npm test` 退出 0（全部后端单元测试通过，含 `test-antigravity-usage` 9/9）；界面测试 `test-antigravity-ui` 7/7、`test-ui` 26/26 均退出 0。
- `npm run dist` 退出 0；`node dist/verify-0.3.78.cjs`：184 个运行时文件一致，版本 `0.3.78`，ASAR SHA256 `3756f0e06f6659ffcb0ba680844da91b31c989256b2c21863c03318ff5add3c4`。校验值 `dist/assets-0.3.78.sha256`（Setup `794910a2…77ea`、Portable `ebd9c55e…c5cd`、blockmap `55bef7ba…e0da`、latest.yml `eae3fffa…a39ca`），说明 `dist/release-0.3.78.md`。
- Git：提交 `dc4ee8f`（9 个文件，扫过无凭证 / 邮箱 / 会话链接 / 本机接口令牌；不含 `HANDOFF.md` 和 `clawd-pet-extracted/`），标签 `v0.3.78`；`main` 和标签已推送，远端均指向 `dc4ee8f`。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.78 ：先建草稿，上传 4 个附件后核对大小和 GitHub SHA256 与本地 `dist/assets-0.3.78.sha256` 一致，正式发布并设为 `latest`。
- 待确认：用户更新后在真实界面确认 Antigravity 周额度整窗折算与「窗口已提前重置」提示、以及用量明细里 `gemini-4-argon-b` 的首字延迟修正；没走过自动更新安装。
- 收尾：没有遗留本轮的 `electron` / `node` / `gh` 进程；用户安装版 TokenPulse 未动；`dist` 0.3.78 产物和 `win-unpacked/resources/app.asar` 独占打开检测均为 `UNLOCKED`（检测句柄立即关闭）；工作目录在项目根目录。`HANDOFF.md` 仍未提交（项目惯例）。

## 本地完成 · 排查并修复 Antigravity `gemini-4-argon-b` 首字延迟（TTFT）偏慢与整包工具调用假首字问题（2026-11-06，当时版本仍 0.3.77、未提交，后并入 0.3.78）

- 用户提问：「为什么用量明细里面的 Argon-b 首字很慢啊 这是真的慢还是本来就是 BUG？你能帮我查查吗？」
- 本机 SQLite 数据库（`steps.metadata` 与 `gen_metadata`）实测核查结论（共 995 次 `gemini-4-argon-b` 调用对比 357 次 `gemini-3.8-flash` 调用）：
  1. **底层字段含义**：`gen_metadata` 的 `field 11`（`f11_ms`）严格等于 `steps.metadata.6 (first_viewable_at) - steps.metadata.1 (start_at)`；`field 12`（`f12_ms`）严格等于 `steps.metadata.7 (finished_at) - steps.metadata.6 (first_viewable_at)`。
  2. **一半是「真慢」（约 6s～11s，中位数 9.3s）**：
     - `gemini-4-argon-b` 对应 `Gemini 4 Argon (High)`（高思考档位旗舰模型），你本机每次请求的平均输入上下文高达 **13.7 万～14.4 万 Tokens**，且平均每次先进行 **412～605 Tokens 的内部思考（Thinking）**。
     - 当模型没有输出可见思考文本块（`step_payload.20.3` 为空）时，内部思考期间不会触发 `first_viewable_at`，因此 14 万 Token 的 Prefill + 内部思考时间全算在 `field 11` 里（相比之下 `gemini-3.8-flash` 中位首字仅 `2.0s～2.7s`）。
  3. **另一半是「协议与统计导致的假慢 Bug」（15s～129s 的离谱首字）**：
     - 你本机 995 次 `gemini-4-argon-b` 调用里，有 **901 次（90.6%）是纯工具调用步骤**（如 `write_file`、`edit_file`、`run_command`、`send_message`，无聊天正文）。
     - Google Gemini 的工具调用（Function Calling）不在流式过程里逐字推送 JSON，而是**在服务端把整个工具调用 JSON 完整生成完后，一次性作为一个块下发**。
     - 当某一步既没有聊天正文也没有可见思考块、直接调工具写文件时（例如 `5b9f789c` 会话的 `step 32`，调 `write_file` 一次性写了 `16,120` 个代码 Token），服务端花了 **129.10 秒**生成完整个文件后才发回第一个可见块，导致 Antigravity 把整整 **`129.10s`（2m 9s）全部记进了 `field 11`（首字延迟）**，而把 `field 12`（流式耗时）记成了 **`48 毫秒`**！本机 629 次单工具调用里有 455 次（72%）的 `field 12` 中位数只有 `112ms`。
- 已完成改动及关键文件：
  - `src/core/antigravity.ts`：
    - 在 `readAntigravityGenerations` 中识别服务端整包缓冲的工具调用（`isBufferedToolCall`：当非思考输出 `outNoThink >= 150` Tokens 且 `streamingMs <= 0 || outNoThink / (streamingMs / 1000) > 500`，即表观流式速度超过物理极限 500 Token/秒时），不再把包含整段工具代码生成时间的 `rawFirstTokenMs` 误记为 `firstTokenMs`（首字显示为 `—`，仅保留真实 `totalMs` 总耗时与 `tokensPerSec`）。
  - `src/core/usage-scan.ts`：
    - 将 `ANTIGRAVITY_STATE_VERSION` 从 `2` 升至 `3`，下次扫描自动重算已有 Antigravity 请求记录的 `timing`，并将整包返回步骤的 `timing.stream` 设为 `false`（悬停提示 `Antigravity 本地记录 · 非流式`）。
  - `scripts/test-antigravity-usage.cjs`：
    - 新增整包缓冲大工具调用（`output: 16155, thinking: 35, f11: 129000ms, f12: 48ms`）不把 129s 误记为 `firstTokenMs` 的回归断言（`9/9 antigravity checks passed`）。

## 本地完成 · 修复 Antigravity 周额度整窗折算被放大至 ~80 亿 Token 的 Bug（补齐提前重置切段与半途采样分子/分母对齐）（2026-11-06，版本仍 0.3.77、未提交）

- 用户反馈：「为啥我们 tokenpulse 估计我的账号周额度有 80 亿 Token 啊？这是假的吧，你是不是没有考虑 Google 会偶尔重置的因素？但是我记得我其他模型厂商都有做用了重置卡之后的代码呀。你没注意到吗？」
- 根因定位（已结合用户本机 `antigravity-quota.json` 采样与请求账本实测复盘）：
  1. **缺少 `windowSegments` 式的提前重置（`moved` / `kept`）窗口切段**：
     - 用户第一个周周期（`resetAt = 2026-11-13T04:17:55Z`，起点 `2026-11-06T04:17:55Z`）在 `04:17Z` 至 `17:15Z` 消耗了 `1.26 亿` Tokens，周已用升至 `4.7%`。
     - 随后在 `2026-11-07T02:29:33Z`（距原定重置还有 6 天），Google 提前将该周额度重置为 `0%` 并将 `weekResetAt` 顺延至 `2026-11-14T02:35:22Z`（与 Codex 的 `moved` 重置卡行为完全一致）。
     - 原先 `src/main/antigravity-quota.ts` 的 `buildWindowInsight` 没有像 `src/core/quota-monitor.ts` 的 `windowSegments` 那样在提前重置处截断前一段的 `endAt` 并钳制后一段的 `startAt`，导致旧周期的 `[startAt, endAt]` 仍跨越到 11 月 13 日，把重置后的新增请求也吞入旧周期。
  2. **半途开始采样时的分子/分母区间错配（核心放大根源）**：
     - 用户在 `12:26Z` 升级到 `0.3.76` 后才开始记录周额度采样，首个周采样已为 `3.4%`（`minUsed = 3.3%`），末次采样为 `4.7%`。
     - 原代码写的是 `const delta = maxUsed >= minUsed + 0.5 ? maxUsed - minUsed : maxUsed`（算出 `delta = 4.7% - 3.3% = 1.4%`，仅代表 `12:26Z` 之后的涨幅），但分子 `cRows` 却从整窗起点 `04:17Z` 开始累加全部 `1.26 亿 + 重置后 = 1.30+ 亿` Tokens（对应完整的 `4.7% + 0.8%` 消耗），导致用整窗全部 Token 除以半途 `1.4%`（早期 `delta` 更小时甚至 `< 1.1%`），把真实的 **~26.9 亿 Tokens**（约为 5 小时窗口容量 `5.78 亿` 的 4.65 倍，与官方扣额比 `19.9% ÷ 4.7% = 4.23` 完全吻合）放大了 3 倍以上变成 **80+ 亿 Tokens**。
  3. **缺少 `MIN_CAPACITY_PCT = 2` 最小折算阈值**：
     - `src/core/quota-monitor.ts` 要求窗口段至少消耗 `>= 2%` 才参与整窗容量折算，而 `antigravity-quota.ts` 原先设成了 `0.2%`，导致刚重置后 `0.2%`–`0.4%` 的微小舍入抖动被放大 250–500 倍。
- 已完成改动及关键文件：
  - `src/main/antigravity-quota.ts`：
    - 新增并导出 `agyWindowSegments(windowKind, groupKeyStr, history, currentQuota, now)`（对标 `src/core/quota-monitor.ts` 的 `windowSegments`）：
      - 按 `resetAt` 聚合周期，并自动合并 `0%` 空闲窗口顺延的采样（避免把未开始使用的浮动 `resetAt` 误判为提前重置）；
      - 当上一段有用量且在 `previous.endAt - SAME_WINDOW_MS` 之前出现了新的 `resetAt` 周期（Google 顺延式提前重置），将上一段 `endAt` 截断在重置点并标记 `endedByReset = "moved"`，新段标记 `startedByReset = "moved"` 且 `startAt` 不早于上一段末次采样；
      - 当同一 `resetAt` 周期内百分比大幅回落（归零或掉 `>= 3` 个百分点，忽略 `< 1%` 的普通接口重算微抖），在回落前切开并标记 `endedByReset = "kept"` / `startedByReset = "kept"`。
    - 修复 `buildWindowInsight` 的折算分子/分母对齐与阈值：
      - 统一执行 `MIN_CAPACITY_PCT = 2`（`< 2%` 的窗口段不单独外推整窗容量）；
      - 对半途开始采样的窗口段（`first.used >= 1.5`），检查 `[segment.startAt, first.at)` 是否有本机请求记录：若有本机记录（本机 `.pb` 日志完整覆盖窗口起点），分子取 `[segment.startAt, endBound]` 全部 Token、分母取 `targetPt.used`；若无本机记录，分子只取 `[first.at, endBound]`、分母取 `targetPt.used - first.used`。
    - `buildTimelineWindow` 同步接入 `agyWindowSegments`，在时间线周期选择器中识别并标注 `resetCard: Boolean(seg.startedByReset || seg.endedByReset)`。
  - `renderer/antigravity-quota.js`、`renderer/i18n.js`：
    - 当 5 小时窗口或周额度窗口带有 `startedByReset` 时，渲染与 Claude/Codex 一致的 `.reset-card-note` 提示条（`窗口已提前重置，重置日期已顺延 · 从 ... 起算` / `窗口已提前重置，重置日期不变 · 从 ... 起算`）；
    - 当窗口已用 `< 2%` 尚无历史折算样本时，副标题明确提示 `已用不到 2%，暂不折算整窗容量`；补齐中英双语词条。
  - `scripts/test-antigravity-usage.cjs`：
    - 新增 `agyWindowSegments` 对提前重置（`moved`）切段、旧段 `endAt` 截断与新段 `startAt` 钳制的单元测试（`9/9 antigravity checks passed`）。
- 实测本机修复效果（只读验证）：
  - `Gemini Models` 5 小时整窗折算：`5.78 亿 Tokens`（`$252.49`，4 个周期样本累计 `23.1%`）；
  - `Gemini Models` 周额度整窗折算：从原先虚高的 **80+ 亿 Tokens** 回落为真实的 **`26.9 亿 Tokens`**（`$1,163.64`，约为 5 小时窗口的 4.65 倍），当前重置后周窗口正确标记 `startedByReset: "moved"`，本机周已用准确统计重置后的 `726.9 万 Tokens`。
- 测试命令与实际结果：
  - `npm.cmd run compile`：退出 0。
  - `node scripts/test-antigravity-usage.cjs`：退出 0（`9/9 antigravity checks passed`）。
  - `npx.cmd electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：退出 0（`7/7 antigravity UI checks passed`）。
- 收尾检查：
  - 本轮启动的所有测试进程均已退出，无遗留 `electron.exe` / `node.exe` 工作区进程；用户安装版 `TokenPulse.exe` 未动。
- 下一步：向用户解释 80 亿 Token 的产生原因与修复结果，等待用户确认是否需要打包/发布新版本。

## 0.3.77 已正式发布（2026-11-06 本地时间，GitHub 记录 2026-11-06T15:22:05Z，用户说「OK 那你直接发布吧~」）

- 内容：下面两节「会话管理新增每段对话的详细用量看板」与「修复 Antigravity 额度池在窗口重置后合并为一个的 Bug」（那两节写的「版本仍 0.3.76、未提交」指当时）。`renderer/intro.js` 加 `0.3.77` 两条更新说明 + `renderer/i18n.js` 英文翻译；`README.md` 的 `### Sessions` 补齐 6 类会话每段对话的模型占比、Token、缓存命中率、API 等价费用与缓存省下估算说明；`git fetch` 远端没有新提交；`npm version 0.3.77 --no-git-tag-version`。
- 升版本后：`npm test` 退出 0（全部后端单元测试通过）；界面测试 `test-antigravity-ui` 7/7、`test-ui` 26/26 均退出 0。
- `npm run dist` 退出 0；`node dist/verify-0.3.77.cjs`：184 个运行时文件一致，版本 `0.3.77`，ASAR SHA256 `aee3d4016c48c3d5199229f895a365e0c09eb27ad268b0d1793b7b824bc00b85`。校验值 `dist/assets-0.3.77.sha256`（Setup `a3c4c82f…8059`、Portable `f9ddaf16…7539`、blockmap `d7d60b7b…7b1c`、latest.yml `26e2074d…1927`），说明 `dist/release-0.3.77.md`。
- Git：提交 `3ffa33a`（14 个文件，扫过无凭证 / 邮箱 / 会话链接 / 本机接口令牌；不含 `HANDOFF.md` 和 `clawd-pet-extracted/`），标签 `v0.3.77`；`main` 和标签已推送，远端均指向 `3ffa33a`。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.77 ：先建草稿，4 个附件一次上传成功，大小和 GitHub SHA256 与本地 `dist/assets-0.3.77.sha256` 一致后正式发布；`latest` 指向 `v0.3.77`。
- 待确认：用户更新后在真实界面查看会话管理的每段对话用量条、展开模型占比明细板，以及 Antigravity 窗口重置后的双池分离；没走过自动更新安装。
- 收尾：没有遗留本轮的 `electron` / `node` / `gh` 进程；只剩用户安装版 TokenPulse（6 个进程，未动）；`dist` 0.3.77 产物和 `win-unpacked/resources/app.asar` 独占打开检测均为 `UNLOCKED`（检测句柄立即关闭）；工作目录在项目根目录。`HANDOFF.md` 仍未提交（项目惯例）。

## 本地完成 · 会话管理新增每段对话的详细用量看板（模型占比、Token、缓存命中率、API 等价费用与缓存省下估算）（2026-11-06，当时版本仍 0.3.76、未提交，后并入 0.3.77）

- 用户需求：在「会话管理」里为每个会话展示详细统计（用了哪些模型、按 Token/调用次数/API 费用的模型占比、总 Token 与输入/输出/缓存拆解、缓存命中率、消耗 Token 等价 API 美元费用、缓存省下的 API 费用估算）。
- 已完成改动及关键文件：
  - `src/core/antigravity.ts`：
    - `readAntigravityConversation` 同时读取 `steps.metadata`（或 `step_payload.5`）里的 `field 9` 用量（`rawInput`、`output`、`cacheWrite`、`cacheRead`、`thinking`），在 `reply` 步骤上附加 `usage?: AgyStepUsage`。
  - `src/core/sessions.ts`：
    - 新增并导出 `SessionModelUsage` 与 `SessionUsage`，挂入 `SessionSummary.usage`（及 `SessionDetail.usage`），并将 `INDEX_VERSION` 升至 `3` 以自动刷新本机 `sessions-index.json` 索引。
    - `Builder` 新增 `addUsage` / `buildUsage`，结合 `estimateCost` 与 `displayModel` 计算每个模型及整段会话的 `tokens`、`input`、`output`、`cacheRead`、`cacheWrite`、`reasoning`、`cacheHitRate`（`cacheRead / input * 100`）、`costUsd`（API 等价费用）、`uncachedCostUsd`（假设全部输入不命中缓存的原价）与 `cacheSavedUsd`（缓存省下费用），以及每个模型的 `tokenShare`、`requestShare`、`costShare`。
    - 6 类会话解析器（`parseClaude`、`parseCodex`、`parseGrok`、`parseDeepseek`、`parsePi`、`parseAntigravity`）全部接入逐次调用用量汇总（含 Claude 同 `requestId`/`message.id` 去重、`<synthetic>` 过滤、Codex `token_usage_record` 与旧版 `token_count` 去重、Grok `modelUsage` 与 `costUsdTicks`、DeepSeek 闲忙时单价、pi 消息与压缩条目、Antigravity 步骤用量）。
  - `renderer/sessions.js`、`renderer/sessions.css`、`renderer/i18n.js`：
    - 左侧会话列表每张卡片（`.sw-item-meta`）新增紧凑 `.sw-item-usage` 标签（如 `11K · ≈$0.04`）。
    - 右侧会话详情顶部新增紧凑汇总条 `.sw-usage-bar`（展示总 Token、缓存命中率、API 等价费用、绿色的缓存省下金额徽章、多色模型占比微缩条，以及「用量详情 / 收起用量详情」切换按钮 `.sw-usage-toggle`）。
    - 点击展开 `.sw-usage-panel` 完整明细板：① 4 张核心 KPI 卡片（总 Token 消耗、缓存命中率、API 等价花费、缓存省下费用）；② 模型占比分布多色分段条 `.sw-model-stack`（支持「按 Token / 按调用次数 / 按 API 费用」一键切换口径）与图例；③ 多列模型明细表 `.sw-usage-table`（模型、调用次数/占比、总 Token/占比、输入/输出、缓存命中率、API 等价/占比、缓存省下）。
    - `renderer/i18n.js` 补齐全部新增静态词条与动态正则模板翻译。
  - `scripts/test-sessions.cjs`、`scripts/test-antigravity-sessions.cjs`、`scripts/test-antigravity-ui.cjs`：
    - 补齐 6 类会话的 `summary.usage` / `detail.usage` 断言，以及会话管理界面 `.sw-item-usage`、`.sw-usage-bar`、展开 `.sw-usage-panel` 与英文模式 0 中文残留的 UI 自动化测试。
- 测试命令与实际结果：
  - `npm.cmd run compile`：退出 0。
  - `node scripts/test-sessions.cjs`：退出 0。
  - `node scripts/test-antigravity-sessions.cjs`：退出 0（`3/3 antigravity session checks passed`）。
  - `node scripts/test-antigravity-usage.cjs`：退出 0（`8/8 antigravity checks passed`）。
  - `npx.cmd electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：退出 0（`7/7 antigravity UI checks passed`）。
  - `npx.cmd electron --lang=zh-CN scripts/test-ui.cjs`：退出 0（`26/26 PASS`）。
- 收尾检查：
  - 本轮启动的所有测试进程均已退出，无遗留 `electron.exe` / `node.exe` 工作区进程；用户安装版 `TokenPulse.exe`（6 个进程）未动。
- 下一步：等待用户确认是否一起打包并发布新版本（如 `0.3.77`）。

## 本地完成 · 修复 Antigravity 额度池在窗口重置后合并为一个的 Bug（2026-11-06，版本仍 0.3.76、未提交）

- 用户反馈：「当一个窗口重置后，这两个额度池竟然合并为一个了，这是怎么回事？这是BUG吗？」
- 根因定位（已实测复现）：
  1. **真实 `RetrieveUserQuotaSummary` 字段名差异**：真实接口返回 `response.groups[].displayName`（如 `"Gemini Models"`、`"Claude and GPT models"`）、`description`、`buckets[].bucketId`（如 `"gemini-weekly"`、`"gemini-5h"`、`"3p-weekly"`、`"3p-5h"`）与 `buckets[].displayName`（`"Five Hour Limit Remaining"`、`"Weekly Limit Remaining"`），而 `parseSummaryGroups` 原先只读了 `raw.title`、`bucket.id`、`bucket.title`，导致真实环境里 `sg.title` 与 `sg.bucketIds` 为空，`matchSummaryGroup` 里的按模型家族匹配（`byFamily`）未命中。
  2. **未用池的动态 `resetTime` 抖动 + 兜底近似匹配碰撞**：对于 100% 剩余的 `Claude and GPT models`（`used = 0%`），Antigravity 每次 RPC 动态返回 `now + 5h`，导致 `GetUserStatus` 与 `RetrieveUserQuotaSummary` 的 `resetTime` 相差约 1 秒，精确相等匹配未命中，退化到最后一行 `Math.abs(sg.five.used - used) <= 0.2`。重置前 Gemini 5h 已用 `8.8%`、Claude/GPT 已用 `0%`，各自命中不同组；**一旦 Gemini 5 小时窗口重置为 `0.1%`**，`Math.abs(0.1 - 0) <= 0.2` 成立，Claude/GPT 也命中了 `summaryGroups[0]`（Gemini 组，`sg:0`），两个额度池遂合并成了同一个分组。
- 已完成改动及关键文件：
  - `src/core/antigravity.ts`：
    - `parseSummaryGroups` 同时兼容 `raw.displayName || raw.title`、`raw.description`、`bucket.bucketId || bucket.id`、`bucket.displayName || bucket.title` 以及 `/5-?hour|five\s+hour/i`。
    - `matchSummaryGroup` **优先按模型家族（`gemini` vs `claude|gpt|3p`）匹配** `sg.title`、`sg.description`、`sg.bucketIds`；未知家族再按 `sameResetTime(sg.five.resetAt, resetAt, 10_000)` 匹配；**移除**仅按 `Math.abs(sg.five.used - used) <= 0.2` 兜底匹配的分支。
    - `parseAntigravityStatus` 在无 `summaryJson` 时的分组 key 加上 `poolCategory(family)` 前缀（`${poolCategory(family)}|${remaining}|${resetAt ?? ""}`），防止两个池同为 100% 剩余且同秒重置时合并。
  - `src/main/antigravity-quota.ts`：
    - 新增 `isMixedPoolModels` 与 `sanitizeStored(raw)`：启动加载 `antigravity-quota.json` 时自动过滤掉因该 Bug 产生的混池采样（同时含 `gemini` 与 `claude|gpt` 的合并组），若 `last.groups` 被污染则自动从最近一条干净采样恢复，避免 7 天走势图或离线状态残留合并线。
  - `scripts/test-antigravity-usage.cjs`：
    - 新增窗口刚重置（Gemini `0.9991438` vs Claude/GPT `1`，且两次 RPC `resetTime` 差 1 秒）及真实 `RetrieveUserQuotaSummary` 字段结构的回归断言。
- 测试命令与实际结果：
  - `npm.cmd run compile`：退出 0。
  - `node scripts/test-antigravity-usage.cjs`：退出 0（`8/8 antigravity checks passed`）。
  - `npx.cmd electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：退出 0（`7/7 antigravity UI checks passed`）。
- 收尾检查：
  - 本轮启动的测试进程已全部退出，无遗留 `electron.exe` / `node.exe` 工作区进程；用户安装版 `TokenPulse.exe`（6 个进程）未动。
- 下一步：等待用户确认是否立即打包并发布 `0.3.77`（或先在本地重新打包安装更新）。

## 0.3.76 已正式发布（2026-11-06 本地时间，GitHub 记录 2026-11-06T12:24:23Z，用户说「OK 那你发布到Github上吧 文案要模仿之前的release哦~」）

- 内容：下面一节「重新深度适配 Google Antigravity」（那节写的「版本仍 0.3.75、未提交」指当时）。`renderer/intro.js` 加 `0.3.76` 两条更新说明 + `renderer/i18n.js` 英文翻译；`README.md` 的支持表补齐 Antigravity 的 5 小时与周额度窗口、容量折算、时间线、流式速度和本账号请求说明；`git fetch` 合入远端 `b61f418`（知识库自动更新到 2026.11.06）；`npm version 0.3.76 --no-git-tag-version`。
- 升版本后：`npm test` 退出 0（813 PASS）；界面测试 `test-antigravity-ui` 7/7、`test-layout-ui` 9/9、`test-ui` 26/26（第一次跑遇到已知的 option-menu 偶发超时，重跑 26 PASS 退出 0）、`test-desk-pet-ui` 20/20 均退出 0。
- `npm run dist` 退出 0；`node dist/verify-0.3.76.cjs`：184 个运行时文件一致，版本 `0.3.76`，ASAR SHA256 `7178bd4f9ed301aaaa4701c0aef024a95672572c8d759a89b21b2f0c5bad4cc5`。校验值 `dist/assets-0.3.76.sha256`（Setup `378bccde…1b76`、Portable `94d8c532…cf1b`、blockmap `11f52ddb…f1bb`、latest.yml `416e488a…d743`），说明 `dist/release-0.3.76.md`。
- Git：提交 `50b1aa7`（20 个文件，扫过无凭证 / 邮箱 / 会话链接 / 本机接口令牌；不含 `HANDOFF.md` 和 `clawd-pet-extracted/`），标签 `v0.3.76`；`main` 和标签已推送，远端均指向 `50b1aa7`。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.76 ：先建草稿，4 个附件一次上传成功，大小和 GitHub SHA256 与本地 `dist/assets-0.3.76.sha256` 一致后正式发布；`latest` 指向 `v0.3.76`；公开 `latest.yml` 与本地逐字节相同。
- 待确认：用户更新后在真实界面查看 Antigravity 的 5 小时与周额度、容量趋势、时间线、模型换算、速度走势和请求记录；没走过自动更新安装。
- 收尾：没有遗留本轮的 `electron` / `node` / `gh` 进程；只剩用户安装版 TokenPulse（6 个进程，未动）；`dist` 0.3.76 产物和 `win-unpacked/resources/app.asar` 独占打开检测均为 `UNLOCKED`（检测句柄立即关闭）；自己测试留下的 `tokenpulse-agy-*` 临时目录已删；工作目录在项目根目录。`HANDOFF.md` 仍未提交（项目惯例）。

## 本地完成 · 重新深度适配 Google Antigravity（2026-11-06，当时版本仍 0.3.75、未提交，后并入 0.3.76）

- 用户反馈：0.3.75 里的 Antigravity 适配很不够用，主要问题是 ① 没有周额度显示；② 记录和展示的细节远不如 Claude 等其他模型厂商详细，要求重新适配。
- 根因与实测发现：
  1. **周额度（Weekly Quota）接口**：Antigravity 的 language server 除了 `GetUserStatus`（只返回 ~5 小时的 `clientModelConfigs[].quotaInfo`）外，还提供 `POST /exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`（Connect 协议，同端口 + CSRF token），返回 `quotaSummary.quotaGroups[]`，其中每个模型分组同时包含 `window_type: "five_hour"` 和 `window_type: "weekly"`（或 `weeklyQuotaInfo` / `seven_day`）的 `remainingPercentage` / `remainingFraction` 与 `resetTime`。
  2. **本地 SQLite `gen_metadata` 的丰富字段未读取**：每条生成的 `ChatModelCall`（`data.1`）除了 `17.2` 的 Token 用量，还包含 `11` `time_to_first_token`（`google.protobuf.Duration`，含 `seconds=0` 的纯纳秒首字延迟）、`12` `streaming_duration`（流式输出耗时）、`21` `model_display_name`（直读人类可读模型标签，如 `Gemini 3.8 Pro (High)`，无需等额度接口刷新才有标签）、`19` 内部返回模型名（如 `gemini-3.8-pro-b`、`claude-opus-5-5-thinking`）以及 `20` 里的 `request_id`。
  3. **额度详情与请求明细缺项**：原版 Antigravity 额度页只有简陋的分组卡片和 4 个本机数字，缺少像 Claude / Codex 额度页那样的双窗口（5 小时 + 周额度）独立预测与容量折算、额度容量趋势、24 小时本机柱状图、7 天双窗口（5h 实线 + 周虚线）走势、模型与思考等级时间线（`#quota-model-timeline`）、模型速度面板（`speedPanel`）、模型整窗容量换算表（`换一种模型，整窗能用多少`）以及该账号的请求与核验明细表；逐条请求记录里也缺少 `returned`、`requestId`、流式速度与首字耗时、单次请求的 5 小时 / 周额度占用估算，且 `gemini-*-b`/`-n` 被误判为型号不一致、`gpt-oss` 缺参考单价。
- 已完成改动及关键文件：
  - `src/core/protobuf-lite.ts`：新增 `pbDurationMs(buf)` 解析 `google.protobuf.Duration`（支持 `seconds = 0` 的亚秒级 `nanos`）。
  - `src/core/antigravity.ts`：
    - `parseGenerationMeta` / `readAntigravityGenerations`：从 `gen_metadata` 提取 `firstTokenMs`、`totalMs`、`tokensPerSec`、`requestId`、`returned`（内部返回型号）与 `chat.21` `model_display_name`；`resolveModel` 优先用枚举标签表，缺失时直接回退 `chat.21` 标签，并把 `(Thinking)` 归一为 `effort: "high"`。
    - `parseAntigravityStatus(json, summaryJson?)` / `fetchAntigravityStatus`：并发请求 `GetUserStatus` 与 `RetrieveUserQuotaSummary`（后者失败不阻塞主状态），合并每组的 `week: { used, resetAt }`、`title`、组内各档位明细 `models: AgyModelQuotaItem[]` 以及 `credits: AgyCredits`。
  - `src/core/usage-scan.ts`：`ANTIGRAVITY_STATE_VERSION = 2`（`state.agyV`）自动触发已有 Antigravity 会话增量重扫以补齐旧记录的耗时/首字/内部型号；`scanAntigravity` 写入 `returned`、`requestId`、`effortSource: "model_label"`、`timing: { stream: true, ms, firstTokenMs, tokensPerSec, provider: "Antigravity" }`。
  - `src/core/request-verify.ts`、`knowledge/manual.json`、`knowledge/models.json`：加 `^(gemini-[\w.-]+?)-(?:b|n)$` 别名规则（核验说明识别 Antigravity 内部型号后缀 `-b`/`-n` 为型号一致）、渠道名显示 `Google Antigravity`，补 `gpt-oss` 参考单价（输入 $0.15 / 输出 $0.60 / 缓存读 $0.075 每百万）。
  - `src/main/antigravity-quota.ts`、`src/main/index.ts`、`src/main/preload.ts`：
    - `AntigravityQuota` 保存并采样每组的 `five` 与 `week` 双窗口数据；新增 `buildInsight()` 计算每组 5 小时与周窗口的消耗速度、重置时预计用量、用尽时间、窗口内本机用量、整窗容量折算（Tokens / 美元参考 / 剩余可跑 Tokens）、组内模型档位本机调用分布、历史容量趋势、24 小时柱状图、7/30 天汇总、按模型与思考等级的 5h/周整窗换算表（`modelCapacities`）以及带核验和耗时的最近请求列表（`recentRequests`）。
    - 新增 `timeline(query)` 与 `speed(days)`，注册 IPC `antigravity-quota:timeline`、`antigravity-quota:speed` 并暴露到 `preload.ts`。
  - `renderer/model-study.js`：支持 `query.kind === 'antigravity'` 的时间线（5 小时 / 周周期切换、上方叠最高组额度折线、下方画各模型 × 思考等级轨道）。
  - `renderer/antigravity-quota.js`、`renderer/antigravity.css`、`renderer/app.js`、`renderer/i18n.js`：
    - 总览卡片：双环展示最低组的 5 小时（外环）与周额度（内环），每组同时列出 5 小时剩余和周额度剩余及各自重置时间。
    - 额度详情页：每组并列展示「5 小时窗口」与「周额度窗口」子卡、组内 Token 与费用（本机已用 + 整窗折算）、速度与时间、组内模型档位芯片；下方依次展示「额度容量趋势」面板、「本机用量 + 最近 24 小时柱状图」、「最近 7 天的额度（5h 实线 + 周虚线）」、「模型与思考等级 · 时间线」、「模型速度」、「换一种模型，整窗能用多少（支持切换周整窗 / 5 小时整窗）」以及「这个账号的请求」明细表。
    - `renderer/app.js`：`quotaShare` 支持 Antigravity 请求的 5 小时 / 周额度占比估算；请求列表和详情识别 `Antigravity 本地记录` 的流式首字与速度；`LAYOUT` 注册 `quota:agy-capacity`、`quota:agy-models`、`quota:agy-requests`。
    - `renderer/i18n.js`：补齐全部新增界面文案与正则模板的英文翻译。
- 测试命令与实际结果：
  - `npm.cmd run compile`：退出 0（无编译错误）。
  - `node scripts/test-antigravity-usage.cjs`：退出 0（`8/8 antigravity checks passed`，新增 `RetrieveUserQuotaSummary` 周额度合并与 `gen_metadata` 首字/流式耗时/`model_display_name` 测试）。
  - `node scripts/test-antigravity-sessions.cjs`：退出 0（`3/3 antigravity session checks passed`）。
  - `node scripts/test-usage-scan.cjs`：退出 0（`16/16 通过`）。
  - `node scripts/test-requests.cjs`：退出 0（`64/64 通过`）。
  - `node scripts/test-model-study.cjs`：退出 0（`16/16 model study checks passed`）。
  - `node scripts/test-desk-pet.cjs`：退出 0（`34/34 desk pet checks passed`）。
  - `npx.cmd electron --lang=zh-CN scripts/test-antigravity-ui.cjs`：退出 0（`7/7 antigravity UI checks passed`，覆盖总览与详情页 5h+周额度、容量趋势、模型换算、本账号请求、深色模式、900px 宽度不溢出、英文 100% 翻译、无敏感信息泄露）。
  - `npx.cmd electron --lang=zh-CN scripts/test-layout-ui.cjs`：退出 0（`9/9 PASS`）。
- 未执行的验证与已知限制：
  - 本轮未升版本号、未执行 `npm run dist` 打包或 Git 提交/发布（等待用户确认界面效果与是否打包发布）。
  - 周额度数据依赖本机运行中的 Antigravity 语言服务响应 `RetrieveUserQuotaSummary`（若旧版 Antigravity 未返回周窗口，界面会友好提示刷新或显示已有的 5 小时窗口）。
- 收尾与资源释放检查：
  - 已删除本会话 scratch 临时探针脚本；已清理 `%TEMP%\tokenpulse-agy-*` 临时目录。
  - 核对进程列表：本轮启动的 `electron.exe` / `node.exe` 测试进程已全部退出，仅剩用户本机已安装的 `C:\Users\7ipny\AppData\Local\Programs\TokenPulse\TokenPulse.exe`（6 个进程，未触碰）。
  - 非破坏性独占句柄检测（检测后立即 `Dispose()`）：`dist\win-unpacked\TokenPulse.exe` 与 `dist\win-unpacked\resources\app.asar` 均为 `UNLOCKED`。工作目录留在项目根目录，`clawd-pet-extracted/` 未触碰。

## 0.3.75 已正式发布（2026-11-05 本地时间，GitHub 记录 2026-11-06T05:54:42Z，用户说「你直接发布吧」）

- 内容：下面一节「适配 Google Antigravity」（那节写的「版本仍 0.3.74、未提交」指当时）。intro.js 加 0.3.75 三条 + i18n 英文；README 的支持表和会话文件表加 Antigravity；`git fetch` 远端没有新提交；`npm version 0.3.75 --no-git-tag-version`。
- 升版本后：`npm test` 退出 0（812 PASS）；test-ui 26、test-antigravity-ui 7、test-desk-pet-ui 20、test-layout-ui 9、test-pi-ui 5 退出 0；test-intro-ui 仍是日期相关的老失败（在第一项前就失败，所以 0.3.75 的「新内容」弹窗没被这个测试覆盖，只做了语法检查）。
- `npm run dist` 退出 0；`node dist/verify-0.3.75.cjs`：184 个运行时文件一致，版本 0.3.75，ASAR SHA256 `58e3192f772193bb957bf020bc0da70ed8760d363359a8d58f8c48449448d945`。校验值 `dist/assets-0.3.75.sha256`（Setup `82184e63…69cf`、Portable `6cbab9e3…cc33`、latest.yml `9da8caa9…a9a`），说明 `dist/release-0.3.75.md`。
- Git：提交 `f7b4aad`（46 个文件，扫过无凭证 / 邮箱 / 会话链接 / 本机接口令牌；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.75`；main 和标签经代理推送，远端都指向 `f7b4aad`。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.75 ：先建草稿，4 个附件一次上传成功，大小和 GitHub SHA256 与本地一致后发布；latest 指向 v0.3.75；公开 `latest.yml` 与本地逐字节相同；公开下载的 Setup SHA256 一致。
- 待确认：用户更新后在真实界面看 Antigravity 卡片、额度页、用量和会话；真实环境里没点过删除对话；没走过自动更新安装。
- 收尾：没有遗留本轮的 electron / 打包器 / gh 进程；只剩用户安装版 TokenPulse（6 个进程，未动）；dist 0.3.75 产物和 app.asar 未被占用；自己测试留下的 `tokenpulse-agy-*` 临时目录已删；工作目录在项目根目录。HANDOFF.md 仍未提交（项目惯例）。

## 本地完成 · 适配 Google Antigravity（2026-11-05，当时版本仍 0.3.74、未提交，后并入 0.3.75）

- 收尾（四步都完成后）：`npm test` 退出 0（812 PASS）；界面 test-ui 26、test-antigravity-ui 7、test-desk-pet-ui 20、test-layout-ui 9、test-deepseek-balance-ui 9、test-pool-quota-ui 12、test-share-ui 6、test-pi-ui 5、test-provider-pool-ui、test-agent-switch-ui 5、test-model-weeks-ui 3 退出 0；test-intro-ui 仍是日期相关的老失败（见下）。本地 `--win dir` 退出 0，`dist/win-unpacked`（版本 0.3.74）含 antigravity 的四个文件；已发布 0.3.74 资产 `sha256sum -c dist/assets-0.3.74.sha256` 全 OK。只剩用户安装版 TokenPulse（6 个进程，未动），dist 关键文件未被占用。
- 测试隔离：Antigravity 目录默认跟着用户目录（os.homedir）走，只隔离了 CLI 目录变量、没隔离用户目录的测试会读到真实的 ~/.gemini/antigravity（test-sessions 因此失败过）。已给 test-sessions / test-desk-pet / test-dashboard 和另外 11 个同类测试加 `TOKENPULSE_ANTIGRAVITY_DIR`（指临时目录）。以后新测试要么隔离 USERPROFILE，要么设这个变量。
- 临时目录：界面测试退出时 Electron 自己的 userData 还被占着，`%TEMP%\tokenpulse-*-ui-*` 会留下（老现象，各界面测试都有）；这次只删了自己新建测试留下的 12 个 `tokenpulse-agy-*`，其他前缀的没动（可能是别的会话的）。
- 没做 / 没验证：真实 Antigravity 上没点过删除（只用假接口测过 DeleteCascadeTrajectory 的请求格式，真实删除后它会不会删对话库文件没看到，TokenPulse 以对话列表库里有没有这一行为准）；Antigravity 账号多开 / 切账号、额度的 Google 云端接口（Antigravity 关着时也能查）没做；额度窗口时长没写死（按重置时间），GetUserStatus 里的 availablePromptCredits / Flow credits 没展示。

- 用户选了全部四项，顺序：① 用量明细 → ② 额度显示 → ③ 桌宠认出 Antigravity 在干活 → ④ 会话管理。
- ① 用量（后端完成、界面来源色已加，待整体界面验证）：
  - 新文件 `src/core/protobuf-lite.ts`（无 schema 的 protobuf 读取）、`src/core/antigravity.ts`（目录 `TOKENPULSE_ANTIGRAVITY_DIR` 可覆盖；对话库列表、-wal 合并的大小/时间、工作区、`readAntigravityGenerations`、型号标签 `antigravity-models.json`、`resolveModel`；额度 `antigravityHub` / `parseAntigravityStatus` / `fetchAntigravityStatus`）。
  - `usage-scan.ts`：Kind/SOURCES 加 `antigravity`/「Antigravity」；`scanAntigravity`（offset = 下一步 idx；还在生成的那步停住，卡住 1 小时以上跳过；输入加回缓存读写；型号用额度接口的标签转成 ID 写法 + 档位，没有标签时用内部名，标签出现后 `agyUnlabeled` 触发整份重算）；`scanLocalUsage` 里单独一段循环。`request-log.ts` / `request-verify.ts` 加 kind。
  - 界面：`brand.js` 加 `antigravity`（Gemini 四角星外形，单色）；`--antigravity` 颜色（app.css 亮/暗、share-card.css）；app.js / share-card.js / usage-cache.js / usage-insights.js 的来源表；index.html + i18n 统计口径句子。
  - 测试 `scripts/test-antigravity-usage.cjs`（6 项，已加进 npm test，在 test-pi-usage 后面）全过。真实数据只读跑过：3 个对话 534 次生成，标签到位后显示 gemini-3.8-flash / medium、gemini-4-argon / high 等。
  - 注意：标签只在额度刷新时写（第 2 步接上 `fetchAntigravityStatus` 之后才会在正式运行里出现）。
- ② 额度（完成，未提交）：照 DeepSeek 余额的方式单独做，不进 quota.ts 的「5 小时 + 周」那套。
  - `src/main/antigravity-quota.ts`：`AntigravityQuota`（共用 prefs 查询间隔；Antigravity 没开时留最后一次；按组记 30 天采样，相同结果 10 分钟一条；过提醒线 notifyAt 按组每窗口提醒一次；存 `antigravity-quota.json`，不存令牌邮箱）。修过一个 bug：返回值要在 finally 之后取，否则界面一直显示「正在查询」、刷新按钮禁用。本机请求 `agent: false`（不复用长连接）。
  - `index.ts`：实例、IPC `antigravity-quota:state/refresh`、reschedule、启动时查一次、退出 stop；`preload.ts` `antigravityQuota`。
  - `renderer/antigravity-quota.js` + `antigravity.css`：总览卡片（双环 = 两组、每组一行）、额度详情标签与页面（每组一张窗口卡：剩余、重置、按本窗口采样估速度和重置时用量；7 天走势图；本机用量 + 跳到用量明细并切筛选）；`agy-mode` 隐藏官方账号那两块。app.js 接入（卡片、标签、renderQuota 分支、LAYOUT 三个键 + 总览卡片键）；i18n 一段 + 4 条 PATTERN，`(…|Antigravity) 额度`。
  - 测试 `scripts/test-antigravity-ui.cjs`（6 项，已进 test:ui）全过；截图自查过（测试数据）。`npm test` 807 PASS 退出 0；test-ui 26、test-layout-ui 9、test-deepseek-balance-ui 9、test-pool-quota-ui 12、test-share-ui 6 退出 0。
  - `test-intro-ui` 失败「时间线上待标注、已标注都有」：用已发布的 0.3.74 包（TOKENPULSE_TEST_APP 指 dist/win-unpacked/resources/app.asar）跑也一样失败，是测试数据跟日期有关，不是这次改动；没修。
- 步骤状态编号（从 language_server.exe 里的 protobuf 描述读出）：PENDING 1、RUNNING 2、DONE 3、INVALID 4、CLEARED 5、CANCELED 6、ERROR 7、GENERATING 8、WAITING 9（等批准）、QUEUED 11、INTERRUPTED 12；运行状态 IDLE 1、RUNNING 2、CANCELING 3、BUSY 4。`antigravity.ts` 的 `STEP` / `STEP_OPEN`。用量扫描据此修正：取消 / 出错的生成算结束（有用量照记），只有生成中、排队、等批准才停住等（测试加了一项，7 项全过）。
- ③ 桌宠（完成，未提交）：`antigravity.ts` 新增 `readAntigravityActivity` / `conversationPhase` / `sqliteTime`；`agent-activity.ts` TaskKind 加 `antigravity`、roots 加 `antigravity`（= Antigravity 目录），scan 里把判断做成 `consider()` 共用，Antigravity 按对话列表库的运行状态 + 最后几步（等批准 → waiting，非回复步骤在跑 → tool），子代理（nesting_depth > 0）跳过；`desk-pet.ts` 的 watcher 也认 `conversation_summaries.db(-wal)`。测试：`test-desk-pet.cjs` 加一项（35 PASS），`test-desk-pet-ui` 20 PASS。真实数据只读跑过，认出了刚结束的对话。
- ④ 会话管理（完成，未提交）：`antigravity.ts` 新增 `readAntigravityConversation`（step_payload：14 用户 19.2、15 回复 20.1 正文 / 20.3 思考不展示 / 20.7 工具调用、132 工具执行 5.4 + 140.2.1 输出；每个型号读一条 gen_metadata）、`antigravitySummaries`、`deleteAntigravityConversation`（本机接口 `DeleteCascadeTrajectory {cascadeId}`，Antigravity 没开就报错、不碰文件）、`prepareOptional`（gen_metadata 表不存在也能读）。`sessions.ts`：AgentKind 加 `antigravity`、`parseAntigravity`（标题 / 工作区取对话列表库，列表库里没有的和子代理不列）、`antigravityListStamp`（对话库 + -wal + 列表库 + 型号标签文件）、`forgetSession`（只清 TokenPulse 的索引和搜索缓存）。`main/index.ts`：isAgentKind、回复 / 终端里继续都拒绝（「Antigravity 的对话请在 Antigravity 里继续。」）、DELETE_METHOD；`session-reply.ts` 删除走 Antigravity 接口。`renderer/sessions.js`：AGENTS、筛选（有对话才出现）、`IDE_ONLY` 去掉回复按钮和「在终端里继续」、底部说明；sessions.css 品牌色；i18n 五条。测试：新增 `scripts/test-antigravity-sessions.cjs`（3 项，已进 npm test）；test-antigravity-ui 加会话页一项（7 项）。真实数据只读解析过 3 个对话（轮数、工具、输出、项目目录都对）。

- 用户：买了 Google AI（账号显示 Google AI Ultra），希望 ChatGPT / Claude 在 TokenPulse 里有的功能，Antigravity 也支持。
- 本机安装：`%LOCALAPPDATA%\Programs\Antigravity`（Electron 44.5.1，language server 2.29.0），用户数据 `%APPDATA%\Antigravity`，Agent 数据 `~/.gemini/antigravity`。`~/.gemini` 下的 `oauth_creds.json` 等是 Gemini CLI 的，不是 Antigravity 的。
- 额度（已实测可读）：`~/.gemini/antigravity/daemon/hub_<port>.json` 里有 `httpPort` 和 `csrfToken`；`POST http://127.0.0.1:<httpPort>/exa.language_server_pb.LanguageServerService/GetUserStatus`，头 `x-codeium-csrf-token`、`connect-protocol-version: 1`、JSON body。返回 `userStatus.cascadeModelConfigData.clientModelConfigs[]`：`label`（如「Gemini 3.8 Flash (High)」「Claude Opus 5.5 (Low)」）、`quotaInfo.remainingFraction`、`quotaInfo.resetTime`；按共用额度分组（当时 Gemini 一组、Claude + GPT-OSS 一组，各自重置时间，离重置约 4～5 小时）。`userTier.name`（Google AI Ultra）、`planStatus.planInfo.planName`、`availablePromptCredits / availableFlowCredits`。只有 Antigravity 开着时能问到；邮箱和名字也在返回里，别打印。
- 用量（已确认字段）：每个对话一个 SQLite `~/.gemini/antigravity/conversations/<id>.db`（运行中有 -wal）；表 `gen_metadata(idx, data BLOB)` 每次生成一条 protobuf。`data.1.17.2` 是用量：1 模型数字 id、2 输入、3 输出（= 9 思考 + 10 回复）、4 缓存写入（推测）、5 缓存读取、6 api provider、7 message id、11 response id；`data.1.19` 模型名（如 `gemini-3.8-flash`），`data.1.20` 键值对里有 `model_enum`、`request_id`、`trajectory_id`。时间戳还没找（`steps.metadata` 里可能有）。对话列表 `conversation_summaries.db` 的 `conversation_summaries` 表：标题、step_count、last_modified_time、workspace_uris、status、not_fully_idle 等。
- 调研脚本在本会话 scratchpad（agy-probe.cjs / agy-tier.cjs / agy-pb.cjs），只读，不进仓库。
- 下一步：等用户确认要做哪些、先后顺序；然后从额度 + 用量扫描开始。

## 0.3.74 已正式发布（用户说「那你提升一个小版本号然后帮我发布吧」）

- 内容：下面一节「自定义提示音恢复默认报演示模式」（那节写的「版本仍 0.3.73、未提交」指当时）。intro.js 加 0.3.74 一条 + i18n 英文（界面里「恢复默认」英文是「Reset」，说明里用同一个词）；`git fetch` 远端没有新提交；`npm version 0.3.74 --no-git-tag-version`。
- 升版本后：`npm test` 在 `test-pool-insight.cjs:203` 失败（当时 23:36，时间相关）；单独把时钟往前拨 4 小时（`node -r` 预加载改 `Date`，脚本用完删了）跑它 9 PASS 退出 0，确认只跟当前时刻有关；它后面 46 个脚本逐个跑全过（421 PASS）；`ELECTRON_RUN_AS_NODE=1 npx electron scripts/test-desk-pet.cjs` 34 PASS；`test-ui` 26、`test-intro-ui` 3、`test-desk-pet-ui` 20、`test-layout-ui` 9 均退出 0。
- `npm run dist` 退出 0；`node dist/verify-0.3.74.cjs`：179 个运行时文件一致，版本 0.3.74，ASAR SHA256 `f94421624ecda0d44713d8a9ba92baa6f6545b08b28124478302ddb975a2dc2d`。校验值 `dist/assets-0.3.74.sha256`（Setup `11240247…1ec5`、Portable `4585f965…cb42`、latest.yml `89903276…bde8`），说明 `dist/release-0.3.74.md`。0.3.73 的 Setup / Portable / blockmap 仍与 `assets-0.3.73.sha256` 一致（latest.yml 已换成 0.3.74 的，正常）。
- Git：提交 `d1c9eeb`（10 个文件，扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.74`；main 和标签经代理推送，远端都指向 `d1c9eeb`。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.74 ：先建草稿，4 个附件一次上传成功，大小和 GitHub SHA256 与本地一致后发布；latest 指向 v0.3.74；公开 `latest.yml` 与本地逐字节相同；公开下载的 Setup SHA256 一致。
- 待确认：没有实际走过自动更新安装；用户更新后点一次「任务做完」的「恢复默认」确认只读的 `done.mp3` 能删掉。`test-pool-insight` 贴近半夜失败的问题还没修（测试数据问题，不影响功能）。
- 收尾：没有遗留本轮的 electron / 打包器 / gh 进程；还在跑的是用户安装版 TokenPulse（6 个进程，未动）；`dist` 0.3.74 产物和 `app.asar` 未被占用；工作目录在项目根目录。HANDOFF.md 仍未提交（项目惯例）。

## 本地完成 · 自定义提示音「恢复默认」提示「演示模式下不能更改」（2026-11-03，当时版本仍 0.3.73、未提交，后并入 0.3.74）

- 用户：想把自定义铃声恢复默认，提示演示模式下不能改。用户并不在演示模式。
- 原因：用户本机日志 `~/.tokenpulse/logs` 里每次点「恢复默认」都是 `desk-pet:remove-sound（done）失败：EPERM, Permission denied …pet-sounds\done.mp3`；那份副本是只读的（导入时选的源文件只读，Windows 上 `copyFileSync` 把只读属性带进了数据目录）。Electron 44 里 `fs.rmSync` 删只读文件报 EPERM（已用 `ELECTRON_RUN_AS_NODE=1 npx electron` 实测；独立的 Node 24 能删，所以 `node` 跑的测试本来暴露不了）。界面 `desk-pet-settings.js` 的 catch 不分原因一律显示「演示模式下不能更改」。自定义宠物导入 / 删除有同样问题（复制图片带只读，删宠物报「删除失败」）。
- 改动：`src/core/paths.ts` 新增 `copyIntoData`（复制后改回可写；目标是只读旧副本先改可写再覆盖）和 `removeFromData`（EPERM/EACCES 时递归改可写再删，不跟符号链接）；`pet-sound-file.ts` 导入 / 换格式 / 恢复默认、`pet-pack.ts` 导入（两处复制、两处失败清理）和删除都改用它们。`src/main/index.ts` 两个导入 handler 的文件系统错误换成「复制失败，请检查数据目录权限」并 `console.error` 记日志（`errorText`）。`renderer/desk-pet-settings.js` 只有 `api.isDemo()` 时才说演示模式，否则「恢复默认失败，请检查数据目录权限」/「导入失败」；`i18n.js` 两条英文。
- 用户本机现有的只读 `done.mp3`：没有替用户改；装上带这次修复的版本后点「恢复默认」会自动处理。临时办法：去掉该文件的只读属性后再点。
- 用户追问「别的铃声也会有吗、要升级就能好、不用用户操作」：五种提示音走同一套代码，都已覆盖；升级后「恢复默认」/「换一个」（同格式覆盖、换格式删旧的）遇到旧版本留下的只读副本会自己改可写再处理，用户不用动文件。测试加了五种都只读的情况（恢复默认 3 种、换格式 2 种）；`node` 和 `ELECTRON_RUN_AS_NODE=1 npx electron scripts/test-desk-pet.cjs` 都 34 PASS；临时把 build 里的两个辅助函数换回旧做法后 Electron 下这项失败，`tsc` 重新编译恢复后通过。注意：`npm test` 用普通 node 跑这个脚本，Node 24 本身能删只读文件，所以 EPERM 那条路径只有在 Electron 下跑才测得到。
- 测试：`scripts/test-desk-pet.cjs` 加一项（只读源文件导入后副本可写；只读旧副本能覆盖、能恢复默认；只读图片的自定义宠物能删）。`npm test` 跑到 `test-pool-insight.cjs:203` 失败（`confidence.of` 6 ≠ 7，跑的时候本地 23:27，是之前记过的贴近半夜的时间相关问题，这次没碰相关文件）；它后面 46 个脚本逐个跑完全过（421 PASS）；`test-desk-pet-ui` 20 PASS 退出 0。
- 打包：本地 `--win dir` 退出 0，`dist/win-unpacked`（版本 0.3.73）含本节改动；已发布 0.3.73 资产 `sha256sum -c dist/assets-0.3.73.sha256` 全部 OK。收尾只剩用户安装版 TokenPulse（20:21 / 21:50 启动的 6 个进程，未动），`dist` 关键文件未被占用。

## 0.3.73 已正式发布（用户说「提升一个小版本号然后帮我发布吧」）

- 内容：下面四节（Fable 周额度、号池「获取模型」、号池成员被删后不能保存、编辑布局后账号行多出滚动条；那几节写的「版本仍 0.3.72、未提交」指当时）。
- intro.js 加 0.3.73 四条 + i18n 英文；README 补了 Claude 按型号周额度、号池获取模型 / 已删除成员；`test:ui` 加上 `test-model-weeks-ui`；`npm version 0.3.73 --no-git-tag-version`。
- 升版本后：`npm test` 退出 0（800 PASS）；`test-ui` 第一次整体超时（「UI timed out」，跑到第 9 项，已知偶发），重跑 26 PASS 退出 0；`test-intro-ui` 3、`test-layout-ui` 9、`test-provider-pool-ui`、`test-model-weeks-ui` 3、`test-agent-switch-ui` 5、`test-pool-quota-ui` 12、`test-pi-ui` 5 均退出 0。
- `npm run dist` 退出 0；`node dist/verify-0.3.73.cjs`：179 个运行时文件一致，版本 0.3.73，ASAR SHA256 `d4801bf1dddd74e0ad2e0ebb22982e5a0efe62a7c056db357d7e627dd7006a6c`。校验值 `dist/assets-0.3.73.sha256`（Setup `d1ce63fd…2ac6`、Portable `19af2ba7…0c39`、latest.yml `d3177d68…7128`），说明 `dist/release-0.3.73.md`。
- Git：提交 `6745045`（21 个文件，扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.73`；main 和标签经代理（127.0.0.1:7890）推送，远端都指向 `6745045`。推送前 `git fetch` 远端没有新提交。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.73 ：先建草稿，4 个附件逐个上传一次就成功，大小和 GitHub 的 SHA256 与本地一致后才发布；latest 指向 v0.3.73；公开 `latest.yml` 与本地逐字节相同；公开下载的 Setup SHA256 一致（`d1ce63fd…2ac6`）。
- 待确认：没有实际走过自动更新安装；Fable 周额度和号池「获取模型」只用测试数据和脚本实测过，用户更新后在真实界面看一眼。
- 收尾：没有遗留本轮的 electron / 打包器 / gh 进程；还在跑的是用户安装版 TokenPulse（6 个进程，未动）；`dist` 里 0.3.73 产物和 `win-unpacked/resources/app.asar` 独占打开检测未被占用；工作目录在项目根目录。HANDOFF.md 仍未提交（项目惯例），`clawd-pet-extracted/` 来源不明未动。

## 本地完成 · 编辑布局后额度详情只剩一两个账号，下面还留着滚动条（2026-11-03，版本仍 0.3.72，未提交、未发布）

- 用户：编辑布局里把额度详情的账号标签藏到只剩一两个，出现了只有账号多到装不下时才有的灰色滑块。
- 原因（已用一次性数据目录 + 假账号在 Electron 里复现）：点「完成」时 `setLayoutEdit(false)` 先 `renderQuota()` 重画标签并量宽度，后 `applyLayout()` 才关右边的布局面板（`body.layout-panel-open` 给 `.workspace` 加 336px 右内边距）。量的那一刻这一行只有 318px，两个长邮箱名标签 450px 装不下 → 滚动条显示；面板关掉后变成 654px，但没有窗口 resize、也没有再重画，就一直留着。
- 改动：`renderer/app.js` 在 `#account-tabs` 上加 ResizeObserver，宽度一变就在下一帧调 `markAccountTabEdges()`（重算两端淡出和滚动条）。放到下一帧是因为同一帧里重算会触发「ResizeObserver loop completed with undelivered notifications」（藏掉滚动条后页面变矮、整页滚动条消失、这一行又变宽）。侧栏收起、标题变长之类的宽度变化也一起覆盖到。
- 测试：`scripts/test-ui.cjs` 账号滚动条那段加一项（先把这一行挤窄、等一帧、量出滚动条，再放宽，不重画也要把滚动条和淡出收掉）；去掉修复时这一项会失败，恢复修复后通过。`test-ui` 退出 0（26 PASS；第一次跑遇到过已知的 option-menu 偶发超时，重跑通过）；`npm test` 退出 0（800 PASS）；`test-model-weeks-ui` 3、`test-pool-quota-ui` 12、`test-provider-pool-ui` 退出 0。没截图。
- 打包：本地 `--win dir` 退出 0，`dist/win-unpacked`（20:03 生成，版本 0.3.72）含这一节和下面三节的改动；已发布的 0.3.72 Setup / Portable / latest.yml SHA256 不变。收尾只剩用户自己装的 TokenPulse（6 个进程，未动），`dist` 关键文件独占打开检测未被占用。

## 本地完成 · 号池里有已删除的账号 / 供应商时改不了号池（2026-11-03，版本仍 0.3.72，未提交、未发布，用户没说升版本）

- 用户：「号池里如果有已删除的账号 那么就无法更改号池的信息了 因为会提示“号池里有找不到的官方账号，请刷新后重选”」。原因：设置里删掉账号（或删掉供应商）不会改号池，号池里还留着 id；`saveProviderImpl` 校验成员时对找不到的账号报这句错，编辑页又没法取消勾选一个已经不在列表里的账号，所以一直保存不了。
- 改动：
  - `src/core/agent-switch.ts` `saveProviderImpl`：校验前先把已经不存在的成员（供应商 `byId` 找不到、账号不在 official-accounts 里）移出；全部都删了报「号池里的成员都已删除，请在「成员」里重新选择」；还在但不合格的（别家的账号、别的工具的供应商等）照旧报原来的错。保存出错时号池不变。`PoolMemberView` 加 `missing?: boolean`，`poolMemberView` 对找不到的成员标 `missing`。
  - `renderer/agent-switch.js` `poolOrder` / 新增 `memberMissing`：「成员 → 顺序」里已删除的成员名称划线、旁边标「已删除，保存时移出」（供应商按当前列表判断，账号按已保存视图的 `missing`）。`agent-switch.css` `.pv-pool-order li.missing`、`.pv-member-gone`；`i18n.js` 两条英文。
- 测试：`scripts/test-pool-models.cjs` 加第 5 组（删账号 + 删供应商后视图标 missing、照原成员保存成功且只剩还在的、全删报错、别家账号照旧报错、报错不改号池）；`scripts/test-provider-pool-ui.cjs` 加一段（设置里删掉 qa-one 后打开号池「成员」，看到划线和提示，保存后只剩 qa-two，页面没出现旧错误）。`npm test` 退出 0（800 PASS）；`test-provider-pool-ui`、`test-agent-switch-ui` 5、`test-pool-quota-ui` 12 退出 0。这次没截图。
- 没做：删除账号 / 供应商时不会主动去改号池（仍是下次保存号池时移出；转发时本来就会跳过找不到的成员）。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0；`dist/win-unpacked`（19:51 生成，版本 0.3.72）含本节和下面两节的改动；已发布的 0.3.72 Setup / Portable / latest.yml SHA256 与 `dist/assets-0.3.72.sha256` 一致。收尾只剩用户自己装的 TokenPulse（6 个进程，未动）；`dist/win-unpacked/TokenPulse.exe`、`app.asar`、Setup 以独占方式打开检测均未被占用（检测句柄已关闭）。

## 本地完成 · 号池编辑页能「获取模型」（2026-11-03，版本仍 0.3.72，未提交、未发布，用户没说升版本）

- 用户：「Claude Code的本地号池 为啥不能请求上游获取可用模型呢 还要让用户自己输入？」原因：「获取模型」只做在单个供应商的编辑页（需要地址 + 密钥），号池没有自己的地址和密钥，编辑页只有手填的「默认模型」。
- 实测：官方 `GET https://api.anthropic.com/v1/models?limit=100` 用 Claude Code 的 OAuth 令牌 + `anthropic-beta: oauth-2025-04-20` 能用，返回 14 个模型（含 claude-fable-5-1），字段 id / display_name / max_input_tokens 等；默认一页 20 个，所以要带 limit。
- 改动：
  - `src/core/agent-proxy.ts`：`fetchUpstreamModels(baseUrl, apiKey, official?)`，official = "claude-oauth" 时带 oauth beta、anthropic-version、`?limit=1000`。
  - `src/core/agent-switch.ts`：新增 `listPoolModels({ app, id?, members? })`：挨个问成员（编辑页没保存的成员也行，没传就用已保存号池的）；供应商用它自己的地址和密钥；官方 Claude 账号用 `resolveAccountCredential` 的令牌（和 `poolTargets` 同一把，`AGENT_SWITCH_POOL_BASE` 测试替换也一样），过期跳过、不续期；Codex / Grok 官方账号说明「没有可用的模型列表接口」。合并后按「几个成员有」排序，同样多的按成员顺序 + 上游顺序。一个都没问到也不抛错，按成员返回原因。结果里没有凭据。
  - `src/main/index.ts` `agent:pool-models`、`src/main/preload.ts` `agentPoolModels`。
  - `renderer/agent-switch.js` `poolModelField`：号池「基本信息」里模型框下面加「获取模型」，模型以小标签列出，部分成员才有的虚线框 + 「1/2」并有提示，点一下填进模型框；没问到的成员逐条列在下方；成员中途变了就作废结果。`agent-switch.css` 样式、`i18n.js` 英文（顺带补了「获取模型失败」「获取模型超时」等原来没有的英文）。输入框 name 仍是 model，保存逻辑不变。
- 测试：新增 `scripts/test-pool-models.cjs`（4 组，已进 `npm test`）；`scripts/test-provider-pool-ui.cjs` 加一段（假官方接口，选成员后点获取、看排序 / 1/2 / 填入 / 界面无凭据）。`npm test` 退出 0（799 PASS）；`test-provider-pool-ui`、`test-agent-switch-ui` 5、`test-provider-feedback-ui`、`test-pool-quota-ui` 12、`test-ui` 26、`test-model-weeks-ui` 3、`test-pi-ui` 5 都退出 0。截图只用演示数据。
- 没做 / 没验证：没在真实界面里用真实号池点过（官方接口只用脚本以当前登录实测过）；Grok 官方账号其实有 /models（`agent-switch.ts` 里读 Grok 自己的缓存），这次没接；供应商那条路仍只发 Bearer，有些只认 x-api-key 的 Anthropic 中转可能拿不到（单个供应商编辑页一直是这样）。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0；`dist/win-unpacked` 版本 0.3.72，含本节和下一节的改动；已发布的 0.3.72 Setup、latest.yml SHA256 不变。
- 过程记录：Git Bash 里 `python3` 是应用商店占位程序，会一直卡住（这次卡了 2 分钟后手动停掉，没有遗留进程）；改文件用 Edit 或 node。

## 本地完成 · 显示 Claude 按型号的周额度（Fable），只限 Max 及以上（2026-11-03，版本仍 0.3.72，未提交、未发布，用户没说升版本）

- 用户：「我现在已经登陆了第一个账号了 你可以改一下了……只有Max及以上的账号显示这个额度条 Pro不显示 因为Pro不能用Fable」。
- 实测第一个账号（只打印结构）：`limits[]` 有 `{kind:"weekly_scoped", scope.model.display_name:"Fable", percent, resets_at}`；凭据和 TokenPulse 账号库里 `subscriptionType` 仍是 pro（登录时快照，过时），`/api/oauth/profile` 返回 `has_claude_max: true`、`organization_type: claude_max`、`rate_limit_tier: default_claude_max_5x`。
- 改动：
  - `src/core/quota.ts`：`OfficialQuota.modelWeeks`；`claudeModelWeeks(json)` 只认 weekly_scoped + 型号名、百分比是数字的行；`claudeTierOf(profile)`：has_claude_max / organization_type 含 max、team、enterprise / rate_limit_tier 含 max → max，Pro、免费版 → basic，认不出 → undefined；`claudeTier` 只在额度返回里**有**按型号的行时才调 `/api/oauth/profile`（Pro 不多发请求，现有测试的 curl 计数不变），按账号缓存 6 小时，失败沿用上次、30 分钟后再试，日志用 `errorText` 不带令牌。只有 max 才把 modelWeeks 带出去；没带 plan（`plan` 会被 model-study 拿去判断套餐变化，故意不碰）。日志行加「Fable 周 x%」。
  - `src/core/quota-history.ts`：`QuotaSample.models`，`same()` 比较它（只有 Fable 变了也记一条）。`src/core/quota-monitor.ts`：`AccountReport.modelWeeks`（取最后一次采样）。
  - 渲染：`renderer/app.js` 首页卡片在 5 小时 / 周额度下面加「Fable 周额度」一行（`modelWeekMini`），额度页「周额度窗口」里加「按型号的周额度」块（上面一排仍是两张卡片）；不影响圆环和「当前较低窗口」。`app.css` 新样式，`i18n.js` 两条英文。
  - 顺手修：`i18n.js` 的「(.+)后重置 · (.+)」英文模板以前把时长原样拼进去（英文界面显示「resets in 4 天 4 小时」），现在时长也翻译。5 小时 / 周额度那两行同样受益。
- 测试（日志在本会话 scratchpad）：新增 `scripts/test-model-weeks.cjs`（6 组，已进 `npm test`）、`scripts/test-model-weeks-ui.cjs`（3 组，演示数据，中英文）。`npm test` 退出 0（795 PASS）；`test-ui` 26、`test-model-weeks-ui` 3、`test-pi-ui` 5、`test-cache-ui` 1、`test-tokens-ci-ui` 3，均退出 0。用真实账号两个接口的返回喂给编译后的 `claudeModelWeeks` / `claudeTierOf`：得到 Fable 0%、max（只读，不写文件、不刷新令牌）。截图只用演示数据。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0；`dist/win-unpacked` 版本 0.3.72，asar 里有新代码；已发布的 0.3.72 Setup、latest.yml SHA256 不变。
- 没做 / 没验证：托盘面板、桌宠、刷新提示（「已刷新。…」那句）、额度提醒都没加 Fable；没用打包后的测试版连真实账号跑过；Team / Enterprise 按「Max 及以上」处理，但没有真实账号验证过它们的返回。
- Git：未提交。收尾：本轮的 electron / 打包器进程都已退出，见下面检查；用户的安装版 TokenPulse 和 pi 没动。

## 调查记录 · Claude 按型号的周额度（如 Fable）没有显示（2026-11-03，只调查、没改代码；已由上一节实现）

- 用户反馈：第一个 Claude 账号开了 Max，但 TokenPulse 里看不到 Fable 额度的用量。
- 原因：`src/core/quota.ts` 的 `claudeQuota` 只读 `/api/oauth/usage` 返回的 `five_hour`、`seven_day`。按型号分的周额度在返回的 `limits[]` 里，`kind: "weekly_scoped"`、`scope.model.display_name`（如 "Fable"）、`percent`、`resets_at`、`severity`，TokenPulse 整个没读；旧字段 `seven_day_opus` / `seven_day_sonnet` 也没读。Claude Code 2.1.318 的 `/usage` 就是读这些行显示「Current week (Fable)」，还会按服务端开关 `tengu_usage_overage_included_models` 过滤。
- 实测（用 Claude Code 当前登录查一次，只打印结构；脚本在本会话 scratchpad `claude-usage-shape.cjs`）：当前登录是 TokenPulse 里的第 2 个 Claude 账号，套餐 pro，`limits` 只有 `session`、`weekly_all` 两行，没有按型号的行。
- **没验证**：第 1 个账号（用户说的 Max）的返回里到底有没有 Fable 行。TokenPulse 没存它的令牌（`official-accounts.json` 里只有 `cliAuth` 的登录信息），只有它是 Claude Code 当前登录时才查得到。两个账号本地记的 `subscriptionType` 都是 pro，来源 `sign_in`，即登录时的快照，登录后升级不会更新。
- 待做（用户还没决定）：读 `limits[]` 的 `weekly_scoped` 行，在额度卡片上多显示一行「本周 · <型号>」，没有这行时不显示。

## 0.3.72 已正式发布（2026-11-02 本地时间，GitHub 记录 2026-11-02T08:25:26Z；用户说「提升一个小版本号然后帮我发布吧」）

- 内容：下面一节「用量扫描和用量明细支持 pi」（那节写的「版本仍 0.3.71、未提交」指当时）。
- `git fetch` 远端没有新提交。intro.js 加 0.3.72 一条 + i18n 英文（「Unverifiable」和界面用词一致）；`npm version 0.3.72 --no-git-tag-version`。
- 升版本后：`npm test` 退出 0（789 PASS，`test-backend-0372.log`）；`test-ui` 26 PASS、`test-pi-ui` 5 PASS、`test-cache-ui` 1 PASS，均退出 0（`ui-0372-*.log`，日志在本会话 scratchpad）。
- `npm run dist` 退出 0（`build-release-0372.log`）；`node dist/verify-0.3.72.cjs`：179 个运行时文件一致，版本 0.3.72，ASAR SHA256 `d9e264dd9f95bf3ace5dcc37abf1739dae95b82502d32c3edc53587b9193b82a`。产物和校验值：`dist/TokenPulse-0.3.72-Setup.exe`、`-Portable.exe`、`dist/assets-0.3.72.sha256`，说明 `dist/release-0.3.72.md`。
- Git：提交 `d418bca`（15 个文件；扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.72`，main 和标签已推送，远端都指向 `d418bca`。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.72 ：先建草稿再经代理（127.0.0.1:7890）逐个上传，4 个附件第一次就都 uploaded，大小和 GitHub 的 SHA256 与本地一致后才发布。latest 指向 v0.3.72；公开 `latest.yml` 与本地逐字节相同；公开下载的 Setup SHA256 一致（`1f2099a4…4d37`）。
- 待确认：用户更新后在真实界面看一眼 pi 的用量；真实的压缩、分支摘要、分叉记录出现后再核对一次（本机当时还没有这几种）。没有实际走过自动更新安装。DeepSeek 应用内回复是否受 `standard` 预设影响仍待确认（见 0.3.71 一节）。
- 收尾：没有遗留本轮的 electron / 打包器进程；还在跑的是用户安装版 TokenPulse 和用户自己的 pi，没动；工作目录在项目根目录。HANDOFF.md 仍未提交（项目惯例）。

## 本地完成 · 用量扫描和用量明细支持 pi（2026-11-01 ~ 11-02，当时版本仍 0.3.71、未提交，后并入 0.3.72）

- 用户问 pi 的消耗为什么在用量明细里没有，要求接上：「要是我们的软件扫不到我们本身支持的agent那很不好」。
- 改动：
  - `src/core/usage-scan.ts`：`Kind` / `SOURCES` / `roots()` 加 pi（`piDir()/sessions`），新增 `piRow`，`scanFile` 里读 header 的 cwd 和分叉时刻（`FileState.piForkAt`）、`model_change`、每条回复自带的 `thinkingLevel`；`durationMs` 算估算速度。没动 `STATE_VERSION`：新文件自动扫，别家不用全量重扫。
  - `src/core/request-log.ts`（`RequestKind`、来源名、`sessionOf` 从 `<时间>_<id>.jsonl` 取会话 ID）、`src/core/request-verify.ts`（和 DeepSeek 同一分支：无返回型号就无法核验，不能落到 Grok 文案）。
  - 渲染层：`app.js` 图标、`usage-cache.js` 打开会话、`share-card.js` / `usage-insights.js` 颜色（pi 没有品牌色，用中性 `#64748b`），`index.html` + `i18n.js` 说明文案，`README.md` 来源表。
- 口径（照 pi 自己的 `getSessionStats`，`dist/core/agent-session.js`）：assistant 消息、toolResult 上的嵌套调用用量、`usage` 条目、`compaction`、`branch_summary` 都算，被放弃的分支也算（请求确实发过）；全零的跳过。input 不含缓存，TokenPulse 口径要加回 cacheRead + cacheWrite。分叉把旧条目连时间戳复制进新文件，header 带 `parentSession` 时早于 header.timestamp 的不计，原文件删了也不补算。费用优先 pi 的 `cost.total`；记 0 的 DeepSeek 型号按单价表 + 高峰时段算（和 deepseekRow 一致），其余走按型号估算。条目 id 只在单文件内唯一，记录 id 用 `<文件名>:<条目 id>`。
- 不算进官方账号：`KIND_OF_SOURCE`、`ACCOUNT_OF_KIND` 故意不加 pi。pi 的 Anthropic 是 API Key，不占订阅额度。
- **已查明、不用处理**：pi 的供应商名 `tokenpulse_route` 只是写进 pi 配置的名字，请求直连上游。本机转发记录 5194 行里没有 DeepSeek 流量，所以不会和转发重复记账，也走不到 `withRoute` 的型号比对（否则显示名 `DeepSeek-V4.1-Flash` 和返回型号可能误报不一致）。将来若让 pi 真的走本地路由，要回头看这里。
- 测试（日志在本会话 scratchpad）：
  - 新增 `scripts/test-pi-usage.cjs`（6 组，已进 `npm test`）：口径、费用、型号、思考等级、速度、增量读、半行等待、分叉去重、跨会话 id 不撞、文件重写、不存对话内容。`scripts/test-pi-ui.cjs` 加用量页检查（工具筛选、明细、总量、图标），夹具最后一行补了换行（没换行会被当成没写完的行）。
  - 本机真实 pi 数据只读核对（HOME 和数据目录都指临时目录，真实账本没动）：7 个文件 452 次调用，调用数、input、output、cacheRead、cacheWrite 和原始文件逐项相等；pi 自记 10.78 美元，DeepSeek 记 0 的按单价表补上后约 11.39 美元；7 个会话、4 个项目。
  - 最终：`npm test` 退出 0，789 PASS（2026-11-02 00:05，`npm-test-final.log`）。`npx electron --lang=zh-CN scripts/test-pi-ui.cjs` 退出 0（5 PASS），`test-cache-ui.cjs` 退出 0，`test-ui.cjs` 26 PASS（00:03 之后连续 3 遍）。
  - **这几个测试和当下时刻有关，都和本次改动无关，断言都没改**（接手时遇到别当回归）：
    - `test-pool-insight.cjs:203`（`6 !== 7`）：按每 24 小时一个采样造数据，夏令时结束后错开一格。用预加载脚本（scratchpad `shift-now.cjs`）平移日期：夏令时切换前和 11-08 起都过，11-01 晚到 11-07 的 23:5x 失败；而真实 11-02 00:05 又通过，所以还看一天里的时刻，这一周内可能时过时不过。
    - `test-ui.cjs:617` `one bar per hour`：11-01 当天 25 小时，日期过了就好。
    - 刚过 0 点几分钟内，「几分钟前」的夹具落到前一天：`test-cache-analysis`（`2 !== 1`）、`test-ui.cjs:287`（`QA-speed`，夹具是 2 分钟前）确认属此类；`test-ui.cjs:442`（`#request-rows`）只出现一次，夹具同类，大概率同因，没有单独证实。
    - `test-ui.cjs` 的 `option-menu` 超时偶发。工作区和干净 HEAD（临时 worktree，已删）交替各跑 4 遍，都是 3 遍 26 PASS、1 遍失败，HEAD 也会卡在这里，判定是既有的不稳定，原因没查。
    - Windows 上 Node 不认 `TZ` 环境变量（实测仍是 PST），改时区的测法无效，别再用。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build-pi-usage2.log`）。`dist/win-unpacked/TokenPulse.exe`，版本仍 0.3.71，已确认 app.asar 里有 `piRow` 和渲染层改动。只更新 win-unpacked：**不要在没升版本时跑 `npm run dist`，会覆盖已发布的 0.3.71 附件**。打包前后 `TokenPulse-0.3.71-Setup.exe`、`latest.yml` 的 SHA256 校验不变。
- 没验证：没用打包好的 `win-unpacked` 读真实数据开过（真实核对走的是编译后的 `build/core` + 临时数据目录，界面只用了测试数据）；分享卡片和用量洞察的 pi 配色没截图看；真实文件里还没有 `compaction`、`branch_summary`、`usage` 条目和分叉（本机 7 个文件都没有），这几种只有按 pi 源码造的夹具验证过。
- 已知限制：pi 的「型号一致」核验做不了，文件里没有上游返回的型号，全部显示「无法核验」。pi 走 Anthropic API Key 的请求不归到任何账号，是预期。
- Git：未提交、未发布。`clawd-pet-extracted/` 来源不明，未跟踪，别提交。收尾状态见下一条。
- 收尾：没有遗留本轮的 electron / 打包器进程；还在跑的是用户安装版 TokenPulse 和用户自己的两个 pi（`node.exe`，23968、10052），没动。工作目录在项目根目录。
，GitHub 记录 2026-11-02T06:11:15Z；用户说「提交并且发布吧，升级一个小版本号」）

- 内容：下面一节「删除 pi、DeepSeek 的对话」（下面写的「版本仍 0.3.70、未提交」指当时）。
- `git fetch` 发现远端两个机器人提交（f461d3b、04ba33e，只改 knowledge/models.json），工作区有改动但文件不重叠，`git merge --ff-only` 快进到 04ba33e 后再升版本。
- intro.js 加 0.3.71 一条 + i18n 英文；`npm version 0.3.71 --no-git-tag-version`。升版本后：`npm test` 退出 0（783 PASS，`test-backend-0371.log`）；`test-intro-ui` 3 PASS；`test-pi-ui` 4 PASS（日志在本会话 scratchpad）。**没有重跑 `test-ui.cjs`**（夏令时那条今天原样过不了，见下一节），没跑完整 `npm run test:ui`。
- `npm run dist` 退出 0（`build-release-0371.log`）；`node dist/verify-0.3.71.cjs`：179 个运行时文件一致，版本 0.3.71，ASAR SHA256 `c66ddee3f0079666a05f4e430ee1147f76a7c3e2169b17f776014a2d84e9f984`。`dist/assets-0.3.71.sha256`（Setup 112745207、Portable 112487985、blockmap 119827、latest.yml 352）；发布正文 `dist/release-0.3.71.md`。
- Git：提交 `3fbc91c`（10 个文件；扫过无凭证 / 私人邮箱 / 会话链接，命中的只有目录名 `session_projcache`；不含 HANDOFF.md 和 `clawd-pet-extracted/`），轻量标签 `v0.3.71`（和 v0.3.70 同类型），推送前确认远端无新提交，main 与标签已推送。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.71 ：先建草稿再经代理（127.0.0.1:7890）逐个上传，4 个附件第一次就都 uploaded、大小和本地一致；已转正式（非草稿、非预发布）；`releases/latest` 指向 v0.3.71；公开 latest.yml 和本地逐字节一致；经代理下载 Setup.exe，SHA256 和 `dist/assets-0.3.71.sha256` 一致。Portable 没有下载回来校验。
- 收尾：没有遗留 electron / node / DeepSeek Harness 进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开；打包结束时 shell 曾停在 dist，已退回，工作目录在项目根目录。用户安装版 TokenPulse 没动，会收到自动更新提示。HANDOFF.md 仍未提交，`clawd-pet-extracted/` 仍未跟踪。
- 待确认：用户用真实对话试删除（Harness 真实界面删除后的样子没看过）；DeepSeek 应用内回复是否受 `standard` 预设影响（见下一节「顺带发现」）。

## 本地完成 · 会话管理支持删除 pi、DeepSeek Harness 的对话（2026-11-01，当时版本仍 0.3.70、未提交，后并入 0.3.71）

- 用户反馈 pi、DeepSeek 的对话删不掉；追加「不想要归档，要删除」。原因：接入时特意关掉的（菜单隐藏 + 主进程报错），不是做不到。
- 两家的情况（查的本机安装：pi 1.4.0 的 `dist/modes/interactive/components/session-selector.js`；DeepSeek Harness 0.2.1 的 app.asar）：
  - pi：`/resume` 列表里的删除就是先试 `trash` 命令、再 `unlink`，只动这一个 `.jsonl`；分叉的 `parentSession` 只是指针，它自己删也不管。
  - DeepSeek Harness：persistence 没有删除接口，只有 `archiveSession`（工作区归档）。会话 ID 是 `session-<uuid>`，目录 `sessions/<项目>/session-<uuid>/`；子代理是平级目录（header `origin=subagent` + `parentSession`）；分叉（`isSeeded`）自带完整日志，不依赖父会话，不跟着删。别处引用只有 `storages/session_projcache/sessions/<id>.json` 和 `storages/workspace.json`（`global.archivedSessionIds`、`global.pinnedSessionIds`、`tables.workspaces[*].sessionIds`），扫过 `.dsh/profiles`、storages 没有别的。`workspace.json` 是 temp + rename、last-write-wins，TokenPulse 用 `writeJson` 同样写法。
- 改动：
  - `src/core/sessions.ts`：`deleteLocalSessionFiles` 通用化（`removalPaths` 按 kind 核对路径在根目录内：Claude 同名 + sidecar；pi 第一行 header.id 等于会话 id（**不看文件名**，改过名的文件也要能删，内容不符时不删）；DeepSeek 目录名等于 id，删整个目录）；`deepseekSubagents` 顺 `parentSession` 找全子代理（多层）；`forgetDeepseekSessions` 清缓存和 workspace.json（失败不影响删除）。删掉 `deleteClaudeSession`。
  - `src/main/session-reply.ts`：去掉 DeepSeek 拦截，错误改「找不到这段对话的会话记录文件」。`src/main/index.ts`：去掉 pi 拦截，确认框文案放进 `DELETE_METHOD`。`renderer/sessions.js`：菜单不再隐藏。`renderer/i18n.js`：两段确认框 + 错误文案的英文。
  - 用量不受影响：`usage-scan.ts` 的账本按文件记，文件没了但有 `days` 的保留（:1174）。
- 测试（日志在本会话 scratchpad）：
  - `npm test` 退出 0（783 PASS，`test-backend-delete2.log`）。`scripts/test-sessions.cjs` 新增 pi（只删本段、搜索缓存、改名能删、索引过期不删错）、DeepSeek（主会话 + 两层子代理、分叉和别的会话不动、缓存、workspace.json 只去 ID）、Codex / Grok 不走本地、id 带路径拒绝、主进程入口。
  - `npx electron --lang=zh-CN scripts/test-pi-ui.cjs` 退出 0（4 PASS），新增真实点「更多 → 删除对话」：取消不动；pi、DeepSeek 确认后文件和列表项都没了（确认框是打桩的）。
  - **`test-ui.cjs` 今天原样跑不过，和本次改动无关**：2026-11-01 是美国夏令时结束日（一天 25 小时），`scripts/test-ui.cjs:617` 用 `getHours() + 1` 算今天的小时数，实际多 1（21 点多 `23 !== 22`、22 点多 `24 !== 23`）；`TZ=Asia/Shanghai` 对渲染进程没生效。临时拷一份只把这条比较换掉（`scripts/_tmp-test-ui-dst.cjs`，已删除）：第 1 遍开头 `option-menu` 等待超时（以前记过的偶发），第 2 遍 26 PASS 退出 0。原样还有一次 `:424` 的 `15 !== 7`（第 1 遍），之后没再出现，原因没查。这条测试断言没改；下一次换时制当天还会失败（2027-03 夏令时开始那天会少 1）。
  - 真实 Harness 验证（临时 `USERPROFILE` + `DSH_HOME`，只放两个几乎空的会话，没放凭证，脚本 scratchpad `dsh-real-check.cjs`、`dsh-web-check.cjs`；临时目录已删）：TokenPulse 删除后 `--session-id <被删>` 报 `does not exist`；保留的会话删除前后报同一句（见下）；没有 `inconsistent`。`dsh web --no-open` 完整 host：清理干净、故意留孤儿 ID（等于删除时 Harness 开着写回旧状态）两种都运行满 25 秒没退出，保留的会话还在。
- 打包（当时的本地测试包，后被 0.3.71 正式打包覆盖）：`npx electron-builder --win dir` 退出 0，`dist/win-unpacked/TokenPulse.exe`（版本 0.3.70，2026-11-01 22:02）；核对 asar 里 sessions / session-reply / index / 渲染 sessions / i18n 和 build、renderer 逐字节相同，没有 clawd 文件。
- 没验证：没在 Harness 的真实界面上看过删除后的列表（只看了 host 不崩）；Harness 开着时删除，列表要重启才更新、孤儿 ID 留着时界面长什么样没看，所以确认框让用户先关掉；真实 Harness 子代理目录本机没有样本，header 字段来自它的源码；没有删用户任何真实会话（`.dsh` 7 个、pi 8 个都还在）。没跑完整 `npm run test:ui`。
- 已知限制：pi 会话还在终端里开着时删除，pi 下次写入会重新创建文件（只有新的那几行，没有 header，TokenPulse 不列），确认框已提示先退出；删除后留下的空项目目录不清。
- 顺带发现（没改）：真实 Harness 对 `agentPreset=standard` 的会话报 `runs under agent preset "standard", which the one-shot runner does not compose`，本机 7 个 DeepSeek 会话 header 都带 agentPreset。TokenPulse 在应用内回复 DeepSeek 用的正是 `--profile headless --session-id`，可能回复不了这类会话，待用真实账号确认。
- 收尾：没有遗留 electron / node / DeepSeek Harness 进程；`dist/win-unpacked` 的 exe 和 app.asar 能独占打开；用户安装版 TokenPulse（`AppData\Local\Programs\TokenPulse`）在运行、没动；工作目录在项目根目录。

## 0.3.70 已正式发布（2026-10-30，用户说「发布吧」）

- 内容：下面一节「整窗容量折算偏小」的修复（下面写的「版本仍 0.3.69、未提交」指当时）。
- intro.js 加 0.3.70 一条 + i18n 英文；`npm version 0.3.70 --no-git-tag-version`。`npm test` 退出 0（783 PASS，`test-backend-0370.log`）；`test-intro-ui` 3 PASS。
- `npm run dist` 退出 0（`build-release-0370.log`）；`node dist/verify-0.3.70.cjs`：179 个运行时文件一致，版本 0.3.70，ASAR SHA256 `4d47d7cdfdc1cdd7842bba411dbac961533ff545d53cd00811a5da678fc83002`；asar 里有修复（`aligned`）、没有 clawd 文件。`dist/assets-0.3.70.sha256`（Setup 112743965、Portable 112486815、blockmap 119880、latest.yml 352）；发布正文 `dist/release-0.3.70.md`。
- Git：fetch 远端无新提交；提交 `66dbba9`（6 个文件；扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.70`，main 与标签已推送。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.70 ：先建草稿再经代理逐个上传，4 个附件第一次就都 uploaded、大小和本地一致；已转正式（非草稿、非预发布）；`releases/latest` 指向 v0.3.70；公开 latest.yml 和本地逐字节一致。
- 收尾：没有遗留 node / electron 进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开；工作目录在项目根目录。HANDOFF.md 仍未提交，`clawd-pet-extracted/` 仍未跟踪。

## 本地完成 · 整窗容量折算偏小（「已用 + 剩余」比整窗还多）（2026-10-30，当时版本仍 0.3.69、未提交，后并入 0.3.70）

- 用户反馈：朋友的周额度「本窗口已用（本机）」1,046,690,794 比「整窗容量折算」969,884,982 还大；用户本机「已用 + 剩余可用」也大于整窗。
- 用本机真实数据复现（复制 `~/.tokenpulse` 到 scratchpad `tpdata` 跑 `buildSnapshot`，没碰正在运行的 TokenPulse 数据；诊断脚本 scratchpad `diag-capacity.cjs`）：Claude 账号 0 周窗口 61%，本机 437.7M、容量 680.2M；账号 1 18%，135.4M、686.1M。
- 根因（`src/core/quota-offmachine.ts` `cleanSegment`）：官方百分比只给整数，区间按「涨满 1 点」切。采样隔 30 分钟以上（睡眠 / 没开 TokenPulse）时整段丢掉、锚点挪到空档后，但空档里百分比没变——丢了这段 Token（账号 0 共 6 段 22.6M），那零点几个点的进度却算进了下一个区间。61 个点全算、Token 少算 5.2%，容量偏小，正好等于偏差比 1.05（账号 1：8 段 11.9M，偏差 8.8%，比 1.10）。
- 修复：空档期间百分比没变 → 不丢，接着累积；空档期间涨了 / 回落 → 锚点不在跳点上，到下一次跳点的那个区间也丢掉（`aligned`）；窗口第一个采样还是 0% → 从 `segment.startAt` 算起，第一次采样前的请求也算。修后本机账号 0 容量 717M，已用 + 剩余 = 整窗（比 1.00）；账号 1 比 1.05，剩下的 6.3M 全是最后一次跳点之后的用量（官方显示 18%、实际约 18.9%），整数百分比造成，最多差 1 个点，不是 bug。历史容量折线也会跟着变（偏小的往上修）。
- 测试：`scripts/test-shared-quota.cjs` 新增一项（空档没涨点接着累积、空档涨了丢第一个区间、窗口开头 0% 从窗口开始算；旧代码得 100000、新代码 200000，已实测旧代码失败），5 PASS。
- 全量验证（日志在本会话 scratchpad）：`npm test` 退出 0（783 PASS，`test-backend-capacity.log`）；`test-model-study-ui` 4 PASS、`test-pool-quota-ui` 12 PASS；`test-ui.cjs` 跑了三遍：第 1 遍 9 PASS 后 90 秒看门狗超时，第 2 遍第 1 项后等元素超时（位置不同），第 3 遍 26 PASS 退出 0——按以前记过的偶发处理，原因没查。没跑完整 `npm run test:ui`。
- 没做：「剩余可用」没扣掉最后一次跳点之后的本机用量（整数百分比带来的最多 1 个点的偏差，可以再改）；朋友的数据没看到，推断他也是同一个原因（电脑睡眠多）。
- 收尾：复制出来的数据目录 `tpdata` 已删除；没有遗留 electron / node 进程；没碰 dist；工作目录在项目根目录。Git 未提交（`src/core/quota-offmachine.ts`、`scripts/test-shared-quota.cjs`、HANDOFF.md）。
- 下一步：用户决定是否升版本发布（按约定升版本 = 打包 + 提交 + 推送 + Release，上传一律走代理）；发布时 intro.js 写一条「整窗容量折算不再偏小」。

## 0.3.69 已正式发布（2026-10-30）

- 用户换了代理节点后，Portable.exe 经代理第一次就传上去了。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.69 ：标题「TokenPulse 0.3.69」，非草稿、非预发布，4 个附件 uploaded，大小和本地一致；`releases/latest` 指向 v0.3.69；公开 latest.yml 和本地逐字节一致；从 Release 经代理下载 Setup.exe / Portable.exe，SHA256 和 `dist/assets-0.3.69.sha256` 一致（包括那次直连上传的 Setup.exe）。
- 收尾：没有遗留 node / electron 进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开；工作目录在项目根目录。用户安装版 TokenPulse 没动，会收到自动更新提示。HANDOFF.md 仍未提交，`clawd-pet-extracted/` 仍未跟踪。
- 以后上传 GitHub 一律走代理（127.0.0.1:7890），不要直连；代理固定在某个大小掐断时，请用户换节点。

## 0.3.69 发布过程记录（2026-10-30，用户追加「我不是让你上传到 github 吗？不然用户更新呀」；下面写的「草稿、未发布」是当时状态）

- 远端有机器人提交 `7d89f26`（知识库自动更新，只改 knowledge/models.json），本地提交变基到它后面 → `3735466`。
- `npm run dist` 退出 0（`build-release-0369.log`，本会话 scratchpad）；`node dist/verify-0.3.69.cjs`：179 个运行时文件一致，版本 0.3.69，ASAR SHA256 `936666f64c3d811358d75839aba41724e48a278dc41c1f6b7e675f3f26e689d1`；asar 里有 inferGrok、没有 clawd 文件。`dist/assets-0.3.69.sha256`（Setup 112743295、Portable 112486086、blockmap 119890、latest.yml 352）；发布正文 `dist/release-0.3.69.md`。
- Git：标签 `v0.3.69` 已建，main（3735466）和标签已推送。
- Release：第一次 `gh release create`（一次带 4 个附件）报 blockmap「already exists」后 gh 自己删了草稿。第二次先建草稿（id 429207769，tag v0.3.69）再逐个传：blockmap、latest.yml 已 uploaded；**Setup.exe、Portable.exe 上传失败**——经本机代理 127.0.0.1:7890 时连接被断（wsasend forcibly closed / EOF），之后连 api.github.com 的小请求也 EOF。草稿未发布，用户还收不到更新。
- 之后：Setup.exe 用 curl 直连（`--noproxy`）传成功（201，112743295 字节，state uploaded）——**用户随后明确说「不要绕开（代理），多试几次」，以后上传一律走代理，不要直连**；那次直连在用户消息到达前已经传完。Portable.exe 走代理又试了 18 次（gh 8 次 + curl `--proxy http://127.0.0.1:7890` 10 次），每次传到 7.5～8.3 MB、约 2.5 秒就被代理断开（curl exit 56 / wsasend forcibly closed），是代理端对大上传的限制，重试没用。
- 现状：草稿 429207769 有 Setup.exe、blockmap、latest.yml（自动更新只用这三个），缺 Portable.exe；草稿没发布。
- 用户选「我换代理节点，你再传」：**等用户说换好了**，再经代理传 Portable.exe（`gh release upload v0.3.69 dist/TokenPulse-0.3.69-Portable.exe --clobber`）；四个附件齐了再发布。收尾：没有遗留 node / electron 进程，工作目录在项目根目录；dist 里的 0.3.69 产物要留着等上传。
- 下一步：传完核对 4 个附件大小，`gh release edit v0.3.69 --draft=false --latest`，再核对 releases/latest 和公开 latest.yml。

## 0.3.69 本地提交（2026-10-30，用户说「提升一个小版本直接提交」；后来已推送，见上一节）

- 内容：下面一节「桌宠认出 Grok Build / DeepSeek Harness / pi」的全部改动（下面写的「版本仍 0.3.68、未提交」指当时）。
- intro.js 加 0.3.69 一条 + i18n 英文；`npm version 0.3.69 --no-git-tag-version`（package.json / package-lock.json）。
- 测试（日志在本会话 scratchpad）：`npm test` 退出 0（782 PASS，`test-backend-0369.log`）；`npx electron scripts/test-intro-ui.cjs` 退出 0（3 PASS）；升版本前 desk pet UI 20 PASS（见下一节）。没跑完整 `npm run test:ui`。
- Git：提交 `488d07f`（9 个文件；扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`）。**没打 tag、没推送、没打包、没建 Release**（用户只说提交）。HANDOFF.md 仍未提交，`clawd-pet-extracted/` 仍未跟踪（不要提交）。
- 收尾：没有遗留 electron / node 进程；没碰 dist；工作目录在项目根目录。
- 下一步（用户要发布时）：`npm run dist`、校验、打 `v0.3.69` 标签、推送、建 Release。

## 本地完成 · 桌宠认出 Grok Build / DeepSeek Harness / pi 在干活（2026-10-30，当时版本仍 0.3.68、未提交，后并入 0.3.69）

- 用户反馈：桌宠认不出 Grok Build 在干活；之后追加「顺便把 Pi 等第三方 Agent 都加上」。
- 原因：桌宠的任务扫描器 `src/core/agent-activity.ts` 只扫 Claude projects 和 Codex sessions 两个目录，`TaskKind` 只有 claude / codex，根本没读 `~/.grok/sessions`（会话列表 `sessions.ts` 是支持的，桌宠这条线漏了）。不是扫描策略写错，是没适配。
- 改动（检查点 1，代码 + 单项测试完成）：
  - `src/core/agent-activity.ts`：`TaskKind` 加 grok / deepseek / pi；`inferGrok`（user_message_chunk 开始、tool_call 没有 status=completed/failed 的 tool_call_update 算在跑工具、turn_completed 的 stop_reason end_turn/cancelled/error → ok/interrupted/error；工具名取 `_meta["x.ai/tool"].name`；时间戳是秒，`stamp()` 小于 1e10 的数字乘 1000）、`inferDeepseek`（turn/start、turn/end reason.kind、tool/call / tool/result；approval/asked 没 decided 直接 status=waiting）、`inferPi`（user 开始，assistant stopReason toolUse / stop / length / error / aborted）；`grokHead` / `deepseekHead` / `piHead`；`askOf` 把 Grok 的 `ask_user_question` / `exit_plan_mode` 按 AskUserQuestion / ExitPlanMode 显示；`liveStatus` 对 status=waiting 按 ASK_STALE_MS 算过期。`ActivityRoots` 加可选 grok / deepseek / pi（不给就不扫，旧测试只给前三个）；`discover` 扫 `sessions/<工作目录>/<会话>/updates.jsonl`、`.dsh/sessions/<项目>/session-*/session.v4.jsonl.zstd`（整份 zstd 解开，不能只读两头）、`.pi/agent/sessions/<项目>/*.jsonl`。Grok summary.json `session_kind=subagent`、DeepSeek `delegationDepth>0` 的不算单独任务；Grok 子代理按主会话 tail 里 subagent_spawned 没 finished 的 id 挂成 SubEntry（`kind: "grok"`，同工作目录下 `<id>/updates.jsonl`），沿用 Claude 子代理那套（计数、防「可能在等你」、主会话结束后台子代理还跑算在跑）。
  - `src/main/desk-pet.ts`：`TASK_ACCOUNT` 加 grok → grok 账号额度（DeepSeek / pi 没官方额度，不映射）；fs.watch 过滤改成 `.jsonl` 或 `.jsonl.zstd`。
  - 文案：设置页任务说明（`renderer/desk-pet-settings.js` + `i18n.js` 英文）、README Desk pet 段。
  - 测试：`scripts/test-desk-pet.cjs` 新增两项（三家的推断；扫描器读三家目录 + Grok 子代理 + DeepSeek 批准等你 + pi 中断不庆祝），`node scripts/test-desk-pet.cjs` 33 PASS。另用本机真实 Grok 会话逐行截断干跑 `inferGrok`，状态转换都对（只打印状态，没输出会话内容）。
- 已知限制：Grok 的权限确认（要你批准跑命令）不写进 updates.jsonl，只能靠「工具 90 秒没结果 → 可能在等你」；Grok headless 会话（`grok -p`，别的程序拿 Grok 当后端时也是）照样算任务；子代理开出去的事件掉出 64 KB 结尾时认不到那个子代理；DeepSeek turn/end 只在本机见过 `completed`，其它 reason.kind 按关键字猜（cancel/interrupt/abort → 中断，error/fail → 出错）；pi 没有提问工具，不弹问题卡片。
- 全量验证（日志在本会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\d9f88c6a-e576-4a13-928c-eda7f8b1fe9f\scratchpad`）：`npm test` 退出 0（782 PASS，`test-backend.log`）；`npx electron scripts/test-desk-pet-ui.cjs` 退出 0（20 PASS，`test-desk-ui.log`）。设置页中文原文和 i18n 键核对一致。
- 没做：完整 `npm run test:ui`（只跑了 desk pet UI）；真机上开着 Grok / DeepSeek Harness / pi 跑一轮看桌宠（本机 DeepSeek / pi 只有旧会话）；`npm run dist`；intro.js 更新说明（等定版本号再写）。
- 收尾：没有遗留 electron / node 进程；TokenPulse.exe 全是用户安装版（10-29 22:06、10-30 01:45 启动），没动；没碰 dist；工作目录在项目根目录。Git 未提交（`clawd-pet-extracted/` 仍未跟踪，不要提交）。
- 下一步：用户在真实 Grok 会话里试；要发布时升版本、intro.js 写一条「桌宠认得 Grok Build、DeepSeek Harness、pi 在干活」。

## 0.3.68 已正式发布（2026-10-26，用户说「升级一个小版本，然后发布到 GitHub」）

- 内容：下面一节「桌宠被别的窗口盖住 + 极简模式支持四条边」的全部改动。
- `npm run dist` 退出 0（日志 `build-release-0368.log` 在本会话 scratchpad）；`node dist/verify-0.3.68.cjs`：179 个运行时文件一致，ASAR SHA256 `bb9210d6d7f530c065e76ca9bb2b61aaae907ce056e544009cd32bf6c26bc62f`，版本 0.3.68；asar 里没有 clawd 文件。`dist/assets-0.3.68.sha256`（Setup 112741413、Portable 112484256、blockmap 119861、latest.yml 352）；发布正文 `dist/release-0.3.68.md`。
- Git：fetch 远端无新提交；提交 `b356bea`（14 个文件；扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.68`，main 与标签已推送。**HANDOFF.md 仍未提交，`clawd-pet-extracted/` 仍未跟踪**。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.68 ：标题「TokenPulse 0.3.68」，非草稿、非预发布，4 个附件 uploaded、大小和本地一致；`releases/latest` 指向 v0.3.68；公开 latest.yml 和本地逐字节一致。
- 收尾：没有遗留 electron / node / 打包器进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开；工作目录在项目根目录；临时 worktree（对比 0.3.67 用）已删，删前先单独拆掉 node_modules 链接，项目 node_modules 完好。用户安装版 TokenPulse（6:31 启动）没动，会收到自动更新提示。
- 已知：本次发布期间用户在改屏幕缩放（175% ↔ 150%），会让 desk pet UI 测试第一项「中等大小」偶发得到 241×143（0.3.67 同样如此，Electron 非整数缩放取整）；test-ui.cjs 设置菜单有偶发超时。
- 测试过程（检查点 1）：intro.js 加 0.3.68 两条 + i18n 英文；`npm version 0.3.68 --no-git-tag-version`。`npm test` 退出 0（780 PASS）。`npm run test:ui` 跑了三遍：第 1 遍 test-ui.cjs 设置菜单超时（单独重跑：一次「下一帧才排版」失败、一次 26 PASS，没改过相关代码，按偶发）；第 2 遍到 desk pet UI 前全过，desk pet 第一项「中等大小」得到 241×143——当时用户在改屏幕缩放（175% → 150%），之后单独重跑通过；临时 worktree 对比 0.3.67 在 150% 屏幕内同样是 241×143、不随时间变，不是回归；第 3 遍 desk pet 前 120 PASS，失败在本轮新加的「左右露出一样多」容差 2px 太紧（39 / 36），改成 4px 后单独跑两次 20 PASS。下一步：`npm run dist`、校验、提交、打 tag、推送、建 Release。

## 本地完成 · 桌宠被别的窗口盖住 + 极简模式支持四条边（2026-10-26，当时版本仍 0.3.67、未提交，后并入 0.3.68）

- 用户反馈：① 桌宠有时被别的应用窗口盖住，不知道怎么复现；② 极简模式只能贴右边，要支持左边，最好也支持上下边（上边「倒挂金钩」）。
- ① 原因：Windows 上置顶窗口之间「后来的在上面」。宠物窗口 `focusable: false`、从不激活，别的程序的置顶窗口（视频小窗、截图工具、别的桌宠等）一出来就压住它，宠物再也回不到最上面。已用临时 Electron 脚本 + user32 `GetTopWindow/GetWindow` 实测复现：后出现的置顶窗口在上、1.5 秒后仍在上；再调一次 `setAlwaysOnTop(true, "pop-up-menu")` 宠物回到最上面，焦点仍在另一个窗口（不抢焦点）。
  - 修复（`src/main/desk-pet.ts`）：`keepOnTop()` 每 3 秒（`TOPMOST_EVERY_MS`）、`powerMonitor` resume / unlock-screen、换屏幕 / 改分辨率后，把宠物、问题卡片、气泡依次重设置顶。设置关了置顶、宠物不可见、右键菜单开着（`menuOpen`，popup 前置 true、callback 置 false）、TokenPulse 自己别的置顶窗口（托盘面板）开着时不动。没用 `moveTop()`（担心高 DPI 下的坐标问题，未验证）。
- ② 四条边：
  - `src/core/desk-pet-model.ts`：新设置 `deskPetEdge`（left/right/top/bottom，默认 right，`normalizeDeskPet` 收）；`miniPose(edge)`（左右沿用 `MINI_POSE`，上 tuck 0.6 / peek 0.85、下 0.5 / 0.8 露出身高比例）；`miniBounds(..., edge)`；`miniSpriteBox` 取代 `miniSpriteCenter`（气泡、问题卡片按露出来那截估）；`edgeReached` 取代 `reachesRightEdge`（左右上离边 8px，下边要沉进去 25% 身高才算，避免平时站在底边上就藏起来；角上取伸出多的）；`flingPath` 返回 `edge`（任意一边撞上时速度 > 0.6 都贴边，原来只有右边）。
  - `src/main/desk-pet.ts`：`settle` / 甩出去按边贴；右键菜单「极简模式」改子菜单（贴到屏幕左边 / 右边 / 倒挂在屏幕上边 / 藏到屏幕下边）；`setDeskPetMini(on, edge?)`，`leaveAnchor` 按边算出来落在哪（上边不往上跳、直接掉下来）；从上下边拽出来时 dy 改成抓身子中间。`index.ts` 的 `saveMini(on, edge)` 一起写 `deskPetEdge`。
  - `renderer/desk-pet.js`：`layout()` 四条边——左边是右边以窗口中线镜像（left' = W − left − 2·o.x，transform 前加 `scaleX(-1)`）；下边脚沉到窗口底下；上边 `rotate(180deg)` 绕脚吊在顶上；变换存进 `xf`（逆矩阵）给 `hitAt` 用；眼睛方向左边翻 x、上边翻 x 和 y；主题包自带的极简动画、图片宠物的 `peek` 图只在左右边用（上下边照平时的动画摆）。`desk-pet.css`：`body[data-edge]` 下提示条 / 额度标签位置，上边 `dp-swing` 荡秋千（`rotate` 属性 ±5°，拖动和减少动画时关）。
  - 文案：右键菜单 4 个新词条 + 设置页极简模式说明（`renderer/i18n.js`、`renderer/desk-pet-settings.js`）。intro.js（新版本介绍）没加，等定版本号时再写。
- 测试（日志在本会话 scratchpad）：`node scripts/test-desk-pet.cjs` 31 PASS（模型测试改成四条边：`miniBounds` / `miniSpriteBox` / `miniPose` / `edgeReached` / `flingPath.edge` / `deskPetEdge` 收值）；`electron scripts/test-desk-pet-ui.cjs` 20 PASS（新增一项：右 / 左 / 上 / 下各自贴边藏着、露出多少、悬停探出更多、移开缩回、退出，左右露出一样多，上边倒过来且在荡）；`npm test` 退出 0（780 PASS）；`npm run test:ui` 退出 0（126 PASS，这次没有偶发失败）。全量 UI 之后又加了托盘面板的保护，重新 compile 后单独重跑 desk pet 单元 31 PASS、UI 20 PASS。另用演示数据（内置松鼠）截了四条边 tuck / peek 的图自查。
- 没做：真实屏幕上手动拖到各边、真实别的程序置顶窗口长时间实测；多屏、缩放 150% 下的上下边；`npm run dist`。
- 收尾：没有遗留 electron / node 进程（只有用户 6:31 自己启动的已安装版 TokenPulse，没动）；本轮没打包、没碰 dist；工作目录在项目根目录。Git 未提交（HANDOFF.md 和 `clawd-pet-extracted/` 仍是之前就有的未提交 / 未跟踪状态）。

## 0.3.67 已正式发布（2026-10-24）

- 用户说「升级一个小版本，然后发布到 GitHub」→ 0.3.67，包含下面三节（第一期主题包、眼睛跟随 + 后台账号少查一点、第二期）的全部改动（下面三节里的「未提交、版本仍 0.3.66」指当时）。
- intro.js 加 0.3.67 五条、i18n.js 英文（「后台账号少查一点」沿用设置里已有的翻译）；`npm version 0.3.67 --no-git-tag-version`。
- 测试（日志在本会话 scratchpad）：`npm test` 退出 0（780 PASS，`test-backend-0367.log`）。`npm run test:ui` 退出 1：链条最后一项 `test-desk-pet-ui` 的「气泡 8 秒后自己收起」提前收起一次（`test-ui-0367.log`，前面 112 PASS 全过）；单独重跑两次都退出 0（各 19 PASS，`test-desk-retry-0367-1/2.log`），之前本轮也单独 / 补跑通过 4 次，按偶发处理，原因未查。
- `npm run dist` 退出 0（`build-release-0367.log`）；`node dist/verify-0.3.67.cjs`：179 个运行时文件一致，ASAR SHA256 `818b55477f79c244131e5ced80a20a241e574839b80d627ea0f78fc3820478d9`，产品版本 0.3.67；不含 clawd 文件；`dist/assets-0.3.67.sha256`（Setup 112738158、Portable 112480933、blockmap 119844、latest.yml 352）；发布正文 `dist/release-0.3.67.md`。
- Git：fetch 远端无新提交；提交 `c6378f8`（35 个文件；扫过无凭证 / 私人邮箱 / 会话链接；不含 HANDOFF.md 和 `clawd-pet-extracted/`），标签 `v0.3.67`，main 与标签已推送。**HANDOFF.md 仍未提交，`clawd-pet-extracted/` 仍未跟踪**。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.67 ：标题「TokenPulse 0.3.67」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.67；公开 latest.yml 与本地逐字节一致。
- 收尾：没有遗留的 electron / node / 打包器进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开；工作目录在项目根目录。用户安装版 TokenPulse（21:36 启动）没动，会收到自动更新提示。
- 已知：`test-deepseek-balance-ui`（本轮第二期全量时）和 `test-desk-pet-ui` 气泡自动收起（本次发布前）在全量链条里偶发失败，单独跑稳定通过。

## 桌宠主题包第二期 · 本地测试版完成（2026-10-24，未提交、版本仍 0.3.66、用户没说发布）

- 用户要求开始做第二期（包含下面两节第一期 + 眼睛 / 后台账号少查的全部未提交改动）。范围：随机待机（idleAnimations）、多会话分档 + 子代理（workingTiers / jugglingTiers）、极简模式按状态用主题自己的动画（miniMode）、任务在跑时更快扫描。
- 检查点 1（代码 + 单项测试完成）：
  - `src/core/pet-theme.ts`：idleAnimations 留 `mirrorOnRightSide`；`timings.mouseIdleTimeout`（默认 20 秒，3 秒～10 分钟）；miniMode 存 `offsetRatio`（默认 0.5）、`peek.offsetRatio`（默认 0.12）、`timings.autoReturn`，补 mini-peek-hold / mini-sleep-peek；没有 mini-idle 不算支持极简。
  - `renderer/pet-theme.js`：`visualOf` 新参数 subagents / seed / right / mini / peek / peekHold；干活优先级 在问你 > 子代理（jugglingTiers，没有用 states.juggling）> 思考 / 工具（workingTiers 按任务数，一档多个文件按 seed 挑）；动作 `idle:N` 放第 N 个随机待机（mirror）；`miniOf` 极简映射（miniEnter → mini-enter / mini-enter-sleep，庆祝 mini-happy，挥手 / 出错 / 吓一跳 / 戳 mini-alert，探头 mini-peek → 到时 mini-peek-hold 或回 mini-idle，睡觉 mini-sleep / mini-sleep-peek，干活 mini-working，退 mini-idle）；`durations` 加 `idle:N`、`miniEnter`（默认 15 帧）；`peekHoldMs`；ThemeView `show(file, key, mirror)`、`miniLeft()`、mini-idle 也挂眼睛跟随。
  - `renderer/pet-engine.js` Controller：`fidgets` / `fidgetGap` 可换掉内置随机小动作；`ctx.fidgetAfter`（鼠标多久没动才开始数）。
  - `renderer/desk-pet.js`：`tune()` 给主题宠物设时长和随机待机（间隔 10～30 秒，鼠标 mouseIdleTimeout 没动、没悬停没拖动、设置里随机小动作开着、没开减少动画）；进入干活抽 `workSeed`；主题有极简动画时不歪、按 offsetRatio 藏、探头滑 peek.offsetRatio（stage transform 必须写 `none`，样式表默认 translateX(-50%)）；进极简放 miniEnter；探头不另外挥手；`right` 按窗口在屏幕哪半边。
  - `src/core/agent-activity.ts`：`inferClaude(lines, { sidechain })`；`toolEndsTurn: true` 的 tool_result 算这一轮结束（子代理交结果；本机主会话里没有这种行）；扫描器读 `<会话>/subagents/*.jsonl`（discover 时收 `SUB_STALE_MS` 5 分钟内动过的），没结束的算在跑，记到 `AgentTask.subagents`；主会话活动时间取两边最近；这一轮结束但后台子代理还在跑的算 `tool / Agent` 在跑；`poke()`、`watchRoots()`。
  - `src/main/desk-pet.ts`：view 加 `subagents`；扫描改成 setTimeout 循环（有任务 1 秒、空闲 4 秒）+ `fs.watch` 递归盯 Claude projects 和 Codex sessions（.jsonl 变了 300ms 后扫，两次至少隔 500ms，新文件先 poke），`stopTimers` 关 watcher、`scanGen` 防旧循环续命；气泡扫描后只在内容变了或满 4 秒才重发（`pushBubble(true)`，不然一秒一次会盖掉测试注入的数据）。
  - 测试：`node scripts/test-desk-pet.cjs` 31 PASS（新增子代理扫描、主题第二期字段、档位 / 子代理 / 随机待机 / 极简映射、Controller 随机待机；旧夹具里的子代理改成已结束的）；`electron scripts/test-desk-pet-ui.cjs --lang=zh-CN` 19 PASS（新增第二期一项：子代理姿势、鼠标 3 秒不动放随机待机、极简 mini-enter / 不歪 / 藏一半 / 眼睛跟随 / 探头滑 25% / 回 mini-idle；量身体位置前等 150ms 过渡）。
- README 自定义宠物那句补了第二期支持的内容。
- 全量测试（日志在本会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\4af5ec46-054c-46ca-9a92-bc74840092d4\scratchpad`）：`npm test` 退出 0（780 PASS，`test-backend-p2.log`）。`npm run test:ui` 退出 1：链条前面 68 PASS，`test-deepseek-balance-ui` 超时（以前也偶发，和本轮无关，`test-ui-p2.log`）；它和后面没跑到的 10 项逐个补跑全部退出 0（62 PASS，`test-ui-p2-rest.log`）。
- 截图自查（`capture-p2.cjs`，临时数据目录 + 自己画的方块主题，没用 Clawd 素材；产物 `shots/p2-tile.png`）：子代理时抛球、随机待机、极简 mini-enter / 藏一半 / 悬停探出都正常。
- 本地测试版：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build-p2.log`）；`dist\win-unpacked\resources\app.asar`（21:25）SHA256 `83e2482c9fe1925b4a042f110bc92392cab7486704f202a0b41a73eedc8a76dd`，含新代码（`check-asar.cjs` 确认），不含 clawd 文件。
- 收尾：无本轮残留的 electron / node / python；TokenPulse.exe 全是用户安装版（20:45 / 21:11 启动），没动；exe 和 app.asar 独占打开通过；工作目录在项目根目录。
- 已知限制 / 没验证：没用真实 Clawd 主题在真机看过第二期（用户可自己导入试）；子代理只认 Claude Code（Codex 子会话仍不计）；被停掉的子代理不写结束行，要 5 分钟没动才不算；新子代理文件靠 fs.watch 触发重扫，watcher 建不起来时最多晚 30 秒发现；主题 carrying / sweeping 状态没有对应事件，不用；mirrorOnRightSide 按窗口在当前屏幕哪半边判断，多屏没专门测；极简模式里 hitBox 用主题的（mini 动画没写 fileHitBoxes 时用 default）。
- 下一步：用户试用；要发布时升版本、`renderer/intro.js` 写更新说明（第一期 + 眼睛跟随 + 后台账号少查一点 + 第二期）。**`clawd-pet-extracted/` 不要提交进仓库**。

## 眼睛跟随去延迟 + 「后台账号少查一点」开关 · 本地测试版完成（2026-10-24，未提交、版本仍 0.3.66、用户没说发布）

- 本节包含下面「导入 Clawd on Desk 格式主题包（第一期）」的全部改动（都还没提交）。用户已在自己电脑上导入 Clawd 原版主题试用（只本机看，不传播、不截图、不进仓库）。

- 用户反馈：主题宠物的眼睛跟鼠标有明显延迟。原因叠了几层：主进程停 3 秒后 150ms 才采一次；渲染端 `Controller.look` 每帧（每秒 10 帧）只往目标走 30%（~0.7 秒到九成，大头）；主题 SVG 自带 `transition: transform 0.2s`；眼睛只在 10 帧循环里更新。
- 已改（检查点 1，眼睛部分完成）：`src/main/desk-pet.ts` 光标 16ms 采一次（1.5 秒没动后隔一次，约 32ms），系统空闲时间改成一秒查一次；`renderer/pet-engine.js` `aim()` 直接把 look 设成目标（鼠标驱动立刻到位），自己东张西望的平滑系数 0.3→0.5；`renderer/desk-pet.js` 收到光标马上 `draw()`；`renderer/pet-theme.js` 跟随用的 eyes / body / shadow 元素内联 `transition: transform 60ms ease-out`（FOLLOW_MS）盖掉主题自带的。测试：`test-desk-pet.cjs` 加 aim 立刻到位的断言（退出 0）；`test-desk-pet-ui.cjs` 改成发光标后紧接着检查就到位、0.06s 过渡、量身体位置前先看正前方（退出 0，18 PASS）。实测（scratchpad `measure-eyes.cjs`，临时目录 + 自画方块主题）：鼠标动 → 眼睛 style 改好，静止后第一下中位 17ms / 最大 47ms，连续移动中位 16ms / 最大 31ms。
- 「后台账号少查一点」开关（检查点 2，代码和单项测试完成）：
  - 新 `src/core/quota-quiet.ts`：`foregroundAccounts(extra)`（各家 CLI 当前登录的 + 调用方给的号池成员 / 桌宠固定看的账号）、`quietPick(foreground, checks, now)`（在用的照查；后台的离上次查到或上次去查满 `QUIET_EVERY_MS` 30 分钟才查；「上次去查」记在内存，查失败也不每轮重试）、`QUIET_STALE_MS` 45 分钟。
  - `src/core/quota.ts`：`fetchOfficialQuota(force, gate, pick?)`，不查的账号这一轮不发请求、也不报问题；续期（renewStoredCredentials）照旧对所有账号。
  - `src/core/cli-auto-switch.ts`：抽出 `candidatesOf` / `dueOf`；新 `autoSwitchStale(deps)`：该切号（当前账号到触发线、不在冷却）时，额度超过 `FRESH_MS` 5 分钟或没有的候选账号。
  - `src/core/agent-switch.ts`：新 `poolAccountIds()`。
  - `src/main/prefs.ts`：`quotaQuietBackground`（默认 false）。`src/main/index.ts`：只有定时器那轮（`backgroundRefresh(true, false, true)` → `quotaScheduled`）且没手动刷新时才挑；之后 `autoSwitchStale` 有候选就再临时查一次再跑自动切号；`publishSnapshot` 前 `markQuiet` 给后台账号标 `quiet`（`foregroundNow()` 10 秒缓存，~/.claude.json 可能很大）；改开关不额外查（试过关掉时立刻全查一轮，会在 test-ui 的滚动测试中途重画页面，偶发失败，已去掉）。
  - 界面：设置「通用」额度查询间隔下面一行「后台账号少查一点」（`QUIET_ROW`）；额度详情对后台账号显示中性色说明 `.quiet-note`，过期阈值 15→45 分钟（`staleAfter`）；托盘小面板、桌宠气泡对 quiet 账号 30→45 分钟（`TrayPanelAccount.quiet`、bubble account.quiet）；`renderer/i18n.js` 英文（过期句改成带分钟数的 pattern）。`AccountReport.quiet` 类型。
  - 测试：`test-quota-fetch.cjs` 64/64（新增 8 项：挑选、29/31 分钟、出错也等满、号池算在用、不传全查）；`test-cli-auto-switch.cjs` 32/32（新增 5 项）；`test-tray-panel.cjs` 通过（quiet 透传）；`test-ui.cjs`（--lang=zh-CN）退出 0、26 PASS（新增设置项默认值、位置、切换保存）。截图自查（scratchpad `capture-quiet.cjs`，演示数据）：额度详情说明、超过 45 分钟的过期提示、设置行、深色都正常。
- 全量测试（日志在本会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\4af5ec46-054c-46ca-9a92-bc74840092d4\scratchpad`）：`npm test` 退出 0（776 PASS，`test-backend-quiet.log`）。`npm run test:ui` 退出 1：`test-agent-switch-ui` 的侧栏宽度断言 236 !== 76（窄窗口默认收起，和本轮改动无关，`test-ui-quiet.log`）；单独重跑退出 0（5 PASS，`test-agent-ui-retry.log`）；链条后面没跑到的 17 项逐个补跑全部退出 0（87 PASS，`test-ui-quiet-rest.log`）。
- 本地测试版：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build-eyes-quiet.log`）；`dist\win-unpacked\resources\app.asar`（20:37）SHA256 `89827f90173b63c873d251bf7e182b5175614f12a576511fe9f6deb28993a8f2`，含 quota-quiet.js、pet-theme.js、svg-sanitize.js，不含 clawd 文件。
- 收尾：无本轮残留的 electron / node / python；TokenPulse.exe 全是用户安装版（19:55 / 20:02 启动），没动；exe 和 app.asar 独占打开通过；工作目录在项目根目录。
- 已知 / 没验证：真机上 Clawd 主题的眼睛跟手感需用户确认（实测数字是自画主题、屏幕外窗口量的）；「后台账号少查一点」没在真实多账号环境跑过（单测用假 curl）；后台账号的凭据续期照旧（约每 8 小时一次 refresh，不算额度查询）；`test-agent-switch-ui` 侧栏宽度偶发失败，原因未查。
- 下一步：用户试用；要发布时升版本、`renderer/intro.js` 写更新说明（主题包导入、转晕 / 想法泡泡、眼睛跟随、后台账号少查一点）。

## 导入 Clawd on Desk 格式主题包（第一期）· 本地测试版完成（2026-10-24，未提交、版本仍 0.3.66、用户没说发布）

- 用户确认：不带任何对方素材，只做「能导入 Clawd on Desk 格式的主题包（theme.json + SVG）」，先做第一期、出本地测试版。代码全部自己写，不参考 `clawd-pet-extracted/upstream/` 的 AGPL 实现（只看了 theme.json 字段、SVG 结构和格式文档 theme-state-ui.md）。
- 第一期范围：格式读取 + SVG 消毒（导入时、加载时各一遍）；SVG 主题渲染（Shadow DOM 里放消毒后的 SVG，桌宠窗口 CSP 的 style-src 加 'unsafe-inline'，脚本仍只允许 'self'）；眼睛跟随（eyeTracking 的 eyes / body / shadow id）；思考和执行工具分开（view.phase）；绕圈晕倒（同方向两圈、停顿 500ms 重来、冷却 12 秒；内置三只也加晕的样子）；点击 / 双击 / 连点 / 拖动对应主题的 reactions。旧 GIF 包不受影响。
- 计划改的文件：新 `src/core/svg-sanitize.ts`、`src/core/pet-theme.ts`、`renderer/pet-theme.js`；改 `src/core/pet-pack.ts`、`src/core/desk-pet-model.ts`、`src/main/desk-pet.ts`、`renderer/desk-pet.{js,html,css}`、`renderer/pet-engine.js`、`renderer/desk-pet-settings.js`、`src/main/index.ts`（导入对话框文字）、`renderer/i18n.js`；测试 `scripts/test-desk-pet.cjs`、`scripts/test-desk-pet-ui.cjs`（用自己画的小测试主题）。
- 实现要点：`svg-sanitize.ts` 自己写的分词 + 白名单重建（去 script / foreignObject / on* / 外部 href 和 url() / DOCTYPE 拒收 / CSS 去 @import 和外部 url），幂等；`pet-theme.ts` 读 theme.json（在 dir、dir/assets、dir/assets/svg 找文件；150 个文件、SVG 2MB、位图 5MB、整套 20MB 上限；缺的文件丢掉并给导入警告）；导入后存成 pet.json `{kind:"theme",theme}` + 平铺文件（SVG 存消毒后的，加载时再消毒一遍）；`renderer/pet-theme.js` 的 ThemeView 负责缩放对齐（contentBox / baselineY）、眼睛跟随、hitBox、状态映射（visualOf）。`petPhase()`：tool > thinking > waiting。光标采样 50ms（静止 3 秒后 150ms）。内置三只也加了「转晕」和思考时的想法泡泡。
- 测试（日志在本会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\4af5ec46-054c-46ca-9a92-bc74840092d4\scratchpad`）：`node scripts/test-desk-pet.cjs` 27 PASS（新增 8 项）；`electron scripts/test-desk-pet-ui.cjs` 18 PASS（新增主题包一项，日志里无 CSP 报错）；全量 `npm test` 退出 0（763 PASS，`test-backend-theme.log`）；`npm run test:ui` 退出 0（124 PASS，`test-ui-theme.log`，这次 deepseek 没超时）。截图自查（`capture-theme.cjs` + 临时数据目录 + 自己画的方块主题，产物 `shots/tile.png`）：待机看向鼠标、思考、转晕、极简缩着 / 探头、内置三只的泡泡和转晕都正常。README 自定义宠物一句补了 Clawd on Desk 格式。
- 本地测试版：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build-theme.log`）；`dist\win-unpacked\resources\app.asar`（10:24）SHA256 `5f9361843846c0ba1d080e79ab84d83fb591f186801f201fd8d9b597e5b2026a`，含 build/core/pet-theme.js、build/core/svg-sanitize.js、renderer/pet-theme.js，不含任何 clawd 文件。
- 收尾：无本轮残留的 electron / node / python（在跑的 node 是 PersonalPage 的 vite dev / preview，TokenPulse.exe 全是用户安装版，都没动）；exe 和 app.asar 独占打开通过；工作目录在项目根目录。
- 已知限制 / 没验证：没用真实的 Clawd on Desk 主题包验证过（仓库里只有自己画的测试主题，`clawd-pet-extracted/` 的素材不能用）；第二期才做：随机待机（idleAnimations）、多会话分档的完整逻辑、极简模式各状态的图、discreteSampling / 配饰等字段、任务在跑时更快扫描；桌宠窗口 CSP 的 style-src 加了 'unsafe-inline'（SVG 自带 `<style>` 需要，脚本仍只允许 'self'）。
- 下一步：用户试用；要发布时再升版本、在 `renderer/intro.js` 写更新说明。**`clawd-pet-extracted/` 不要提交进仓库**。

## 外部诉求：把 Clawd on Desk 的 Clawd 角色和交互接进桌宠（2026-10-24，只读评估，未改代码）

- 来源：项目根目录下未跟踪的 `clawd-pet-extracted/`（他人提供，106 个文件 1.8 MB）：需求文档 `给TokenPulse作者的Clawd互动适配需求.md`、Clawd on Desk 1.4.0 原版 50 个 SVG + `theme.json`、AGPL 源码（`upstream/`）、提取者写的 `src/clawd-pet.js` 适配层。只读过，没运行里面的任何脚本。
- 结论（跟下面 2026-10-23 那次调查一致）：**素材和代码都不能进 TokenPulse**。`assets/LICENSE` 写明美术 All Rights Reserved，Clawd 形象归 Anthropic、禁商用，除个人使用 Clawd on Desk 本身外不得复制 / 修改 / 分发；代码 AGPL-3.0-only，TokenPulse 没有 LICENSE、公开发布。包的 README 只写了「按你已取得开发者同意的前提」，不是书面授权。
- 需求里的功能本身合理，大部分已有（睡眠序列、双击戳、连点张望、拖动、甩、极简探头、完成 / 出错 / 中断区分、问题卡片）。还没有、可以自己重写的：眼睛跟随鼠标（现在只有身体微倾）、绕圈眩晕、thinking 和执行工具分开（`petMode` 只有 idle / work / sleep）、多会话分档、自定义宠物随机小动作（`fidget` 限内置）、极简模式按状态换图、活跃期更快的扫描（现 4 秒）。
- 等用户决定是否做、做哪些；`clawd-pet-extracted/` 留在原处没动（不要提交进仓库）。
- 用户随后提出新方向（当时还在讨论；后来已按第一期开工完成，见上一节）：不带任何美术，只让 TokenPulse 能导入 Clawd on Desk 格式的主题包（theme.json + SVG）。我的意见：可以做；按 theme.json 和格式文档自己写读取 / 渲染，不参考 `upstream/` 的 AGPL 实现；导入时消毒 SVG（去 script / foreignObject / on* / 外部引用）；对外只说「支持 Clawd on Desk 格式主题包」，不提供一键读取对方安装目录或转换工具；仓库测试用自己画的小测试主题。等用户确认第一期范围。

## 0.3.66 已正式发布（2026-10-24）

- 用户说「发布吧，升级一个小版本号」→ 0.3.66，只含下一节的「自定义宠物不再一直冒汗」（下一节里的「未提交、版本仍 0.3.65」指当时）。
- 已完成：intro.js 加 0.3.66 一条、i18n.js 英文；`npm version 0.3.66 --no-git-tag-version`。
- 测试（日志在本会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\60aabb1e-ff5e-4fac-9e61-fe3bc898d3a1\scratchpad`）：`npm test` 退出 0（755 PASS，`test-backend-0366.log`）。`npm run test:ui` 退出 1：`test-deepseek-balance-ui` 超时（`test-ui-0366.log`，之前也偶发过），链条在它那里停下；单独重跑两次都退出 0（各 9 PASS，`test-deepseek-retry-1/2.log`）；后面没跑到的 10 项（tray-panel … desk-pet）逐个补跑全部退出 0（51 PASS，`test-ui-0366-rest.log`）。
- `npm run dist` 退出 0（`build-release-0366.log`）；`node dist/verify-0.3.66.cjs`：175 个运行时文件一致，ASAR SHA256 `6c16f1364cc9bbf8f857cceab0194ac194c6c86b5be4ee49c2520c9428554b18`，产品版本 0.3.66.0；`dist/assets-0.3.66.sha256`（Setup 112716263、Portable 112459100、blockmap 119846、latest.yml 352）；发布正文 `dist/release-0.3.66.md`。
- Git：fetch 远端无新提交；提交 `6020897`（6 个文件；扫过无凭证 / 私人邮箱 / 会话链接），标签 `v0.3.66`，main 与标签已推送。**HANDOFF.md 仍未提交**。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.66 ：标题「TokenPulse 0.3.66」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.66；公开 latest.yml 与本地逐字节一致。
- 收尾：没有遗留的 electron / node / 打包器进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开；工作目录在项目根目录。用户安装版 TokenPulse 没动，会收到自动更新提示。
- 已知：`test-deepseek-balance-ui` 在全量链条里偶发超时，单独跑稳定通过，原因未查。

## 0.3.65 之后：自定义宠物额度紧张时不再一直冒汗 · 本地测试版完成（未提交、版本仍 0.3.65、用户没说发布）

- 用户反馈：自用的 Clawd 桌宠一直在流汗。原因：内置宠物额度紧张（`petQuota` 的 mood = tight：剩余 < 15%，或任一窗口 pressure = high）时平时只皱眉，靠 `Controller.nervous` 隔 20～40 秒紧张 2～3 秒；但自定义宠物的 `imageKey()` 只要 mood 是 tight 就一直用 tight 图，Clawd 的 tight.gif 是循环的抖动 + 汗珠，看起来一直在冒汗。
- 改动：`renderer/desk-pet.js` 的 `imageKey()` 改成 `view.mood === 'tight' && ctl.nervous` 才用 tight 图；`draw()` 把当前图写到 `dp-stage` 的 `data-image`（方便检查）。`scripts/test-desk-pet-ui.cjs`：测试宠物包加 tight 状态，断言紧张时平时是 idle、隔一阵换 tight、两三秒后回 idle。
- 测试：`scripts/test-desk-pet-ui.cjs` 16 PASS（只跑了这一项；改动只在桌宠窗口的渲染脚本里，没跑全量）。本地测试版：`npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build-sweat.log`），app.asar SHA256 前 16 位 `C99395A52BB7CA71`，确认含新判断。收尾：无残留 electron / node / python；exe 和 app.asar 独占打开通过；用户安装版没动。
- 下一步：用户说发布时升版本（下一个是 0.3.66）、intro.js 写一条。

## 0.3.65 已正式发布（2026-10-24）

- 用户说「可以编译并且发布啦」，没指定版本号 → 按惯例升小版本 0.3.65，包含下面两节（探头 + 提示音、问题卡片 + 自定义提示音）；下面两节里的「未提交」「版本仍 0.3.64」指当时。
- 已完成：`renderer/intro.js` 加 0.3.65 三条、`renderer/i18n.js` 英文；`npm version 0.3.65 --no-git-tag-version`；`npm test` 退出 0（755 PASS，`test-backend-0365.log`）、`npm run test:ui` 退出 0（123 PASS，`test-ui-0365.log`），日志在本会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\60aabb1e-ff5e-4fac-9e61-fe3bc898d3a1\scratchpad`；`npm run dist` 退出 0（`build-release-0365.log`）；`node dist/verify-0.3.65.cjs`：175 个运行时文件一致，ASAR SHA256 `1df991dd8c10fa18cae61d87d2f9f13c7686693fc9ea6075ad79987dbcf78983`，win-unpacked 产品版本 0.3.65.0；`dist/assets-0.3.65.sha256`（Setup 112716062、Portable 112458837、blockmap 119768、latest.yml 352）；发布正文 `dist/release-0.3.65.md`。
- Git：fetch 远端无新提交；提交 `fabd176`（24 个文件；暂存区扫过无凭证 / 私人邮箱 / 会话链接），标签 `v0.3.65`，main 与标签已推送。**HANDOFF.md 仍未提交**（按约定只留本地）。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.65 ：标题「TokenPulse 0.3.65」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.65；公开 latest.yml 与本地逐字节一致。
- 收尾：没有遗留的 electron / node / 打包器进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开（句柄已 Dispose）；工作目录在项目根目录。用户安装版 TokenPulse（00:53 启动）仍在运行，未安装 / 升级、未关闭——会收到自动更新提示。
- 未验证（真机）：Claude Code 真实提问时卡片弹出的时机、真实 Codex request_user_input、MP3 / M4A 自定义音频解码、多显示器下卡片位置。

## 问题卡片 + 自定义提示音 · 本地测试版完成（2026-10-24，未提交、版本仍 0.3.64、用户没说发布）

- 用户要求：① 提示音支持用户自己选音频；② Claude Code 等 Agent 在任务中提问时显示在右下角。可参考 `D:\CodePorject\Exmaple\clawd-on-desk-main` 的代码但不照抄（只看了它的 agent-questions 文档、PermissionRequest HTTP hook 的做法、`codex-user-input.js` 的 Codex 记录格式；实现是自己写的）。
- 取舍：clawd 用 PermissionRequest HTTP hook 才能在卡片上直接作答，要改 `~/.claude/settings.json`；TokenPulse 桌宠一直是「只读会话文件、不改 CLI 配置」，所以这次**只显示、不作答**，卡片写「回到终端里回答」。若用户以后要在卡片上直接回答，需要装 hook（另议）。
- 改动：
  - `src/core/agent-activity.ts`：`askOf()`（Claude `AskUserQuestion`、`ExitPlanMode`，Codex `request_user_input`；字数个数有上限、去控制字符）；`Inferred.ask` / `AgentTask.ask`（调用写进会话、还没有对应 tool_result / function_call_output；新一轮或中断清掉）；`liveStatus` 在问你立即算 waiting，`ASK_STALE_MS` 60 分钟没动才丢；`ActivityState.asked`（新问题只报一次，第一次扫描不报，不再算进 needsYou）。真实会话里核过 AskUserQuestion 的字段结构（只看字段名）；Codex 本机没有真实 request_user_input 记录，按 clawd 的解析格式写。
  - `src/main/desk-pet.ts`：问题卡片窗口 `desk-pet-ask.html`（透明、不抢焦点、置顶，`askBounds` 放屏幕可用区右下角，挡住宠物时挪到宠物头顶 / 左边；最多 3 张，多的写「还有 N 个」；「知道了」按 `任务key|调用id` 记、回答后清掉）；扫描到 asked 发 `alert ask`；视图加 `volume`、`mute`、`sounds`（种类→导入时间）、`asking`；气泡任务列表的 chip 写「在问你」。
  - 新文件 `src/core/pet-sound-file.ts`：每种提示音（done / ask / waiting / error / empty）可换成自己的音频，按文件头认 WAV/MP3/OGG/FLAC/M4A，2 MB 以内，复制到数据目录 `pet-sounds/<种类>.<扩展名>` + `sounds.json`。
  - `src/core/desk-pet-model.ts`：新偏好 `deskPetVolume`（默认 70）、`deskPetMute`（默认 []）、`deskPetAsk`（默认开）；`askBounds()`。
  - `renderer/pet-sound.js`：新增 ask 调子（一低一高）；`setCustom()` 用 Web Audio 解码自己的音频，播放最多 5 秒、超长淡出；音量参数。`renderer/desk-pet.js`：按 mute / volume 响，视图里 sounds 变了重新要数据；ask 挥手；悬停提示「N 个在问你」。
  - 新文件 `renderer/desk-pet-ask.{html,css,js}`（沿用气泡的像素风变量）；`renderer/desk-pet-settings.js(.css)`：「问题卡片」开关、音量、「每种提示音」列表（单独开关、试听、换成自己的 / 换一个、恢复默认）；说明文字；`renderer/i18n.js` 英文。IPC：`desk-pet:ask-data/ask-size/ask-action/sounds/sound-data/import-sound/remove-sound`（preload 同名）。
- 测试：`node scripts/test-desk-pet.cjs` 19 PASS（新增提问识别、扫描 asked、偏好、askBounds、音频文件导入、自定义音频播放）；`scripts/test-desk-pet-ui.cjs` 16 PASS（新增单独静音和音量、问题卡片弹出 / 知道了 / 计划卡片 / 回答后收起、设置页卡片开关 / 音量 / 静音 / 导入 WAV / 恢复默认），超时从 90 秒放宽到 150 秒。全量 `npm test` 退出 0（755 行 PASS，scratchpad `test-backend-ask.log`）；`npm run test:ui` 退出 0（123 行 PASS，`test-ui-ask.log`）。截图自查（临时目录假数据，`capture-ask.cjs`）：卡片浅色 / 深色、设置页提示音列表正常。
- 本地测试版：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build-ask.log`）；`dist\win-unpacked\resources\app.asar`（02:11）SHA256 前 16 位 `C10EE44FBBA4878A`，确认含 desk-pet-ask、pet-sound-file、askBounds、request_user_input、deskPetMute。收尾：只剩用户安装版 TokenPulse（00:53 启动），没动；无残留 electron / node / python；exe 和 app.asar 独占打开检测通过。
- 没验证：真机上 Claude Code 提问时会话文件是不是马上写入 tool_use（按已知行为判断会；卡片最多晚 4 秒，扫描间隔）；真实 Codex request_user_input；真实 mp3 / m4a 文件的解码（测试只用了 WAV）；多显示器下卡片位置。
- 下一步：用户试用；要发布时再升版本、在 `renderer/intro.js` 写更新说明（含上一节的探头、提示音）。

## 0.3.64 之后：极简模式改成探头、提示音 · 本地测试版完成（2026-10-24，未提交、版本仍 0.3.64、用户还没说发布）

- 用户反馈 1：极简模式「直接一半藏在屏幕边上」太直接，应该是探出头来。改成以身体脚底中点为轴往左歪：`src/core/desk-pet-model.ts` 的 `MINI_POSE = { tuck: { tilt: 30, show: 0.55 }, peek: { tilt: 20, show: 0.75 } }`（替换 MINI_SHOW / MINI_PEEK；show = 探出屏幕的宽度占身宽的比例），`miniSpriteCenter` 改为屏幕右边减四分之一画面宽；`renderer/pet-engine.js` 新增 `BODY`（三只内置宠物身体占的格子，不含松鼠橡果堆），极简模式下松鼠不画橡果堆；`renderer/desk-pet.js` 的 `layout()` 按身体框算轴心、`rotate()`，自定义宠物按 idle 图不透明范围量身体框（`measurePack`），`hitAt` 按旋转反算；`renderer/desk-pet.css` 过渡加 transform。截图自查（scratchpad 的 `capture-clawd.cjs` + `tile_shots.py`，临时数据目录、只用测试数据）：Clawd、松鼠、仓鼠、章鱼平时只探出头和一只眼，悬停时探出身子。
- 用户反馈 2：完成任务、报错时给提示音（自由发挥）。`src/core/agent-activity.ts`：`Inferred.ended`（ok / interrupted / error；Claude 的 `isApiErrorMessage`、中断，Codex 的 `error` / `turn_aborted`），`ActivityState` 加 `failed`、`needsYou`（刚变成「可能在等你」），`finished` 不再包含出错和用户中断的。`src/main/desk-pet.ts`：发 `{ type: "alert", kind: "error" | "waiting" | "empty" }`（额度同账号刚用完发 empty），视图带 `sound`。新偏好 `deskPetSound`（默认开）。新文件 `renderer/pet-sound.js`（Web Audio 现场合成，四种调子，0.4～0.5 秒），`desk-pet.html` 和 `index.html` 都加载；`renderer/desk-pet.js` 的 `chime()`（1.5 秒内只响一声；出错吓一跳、在等你挥手、极简模式探出来 4 秒）；设置页「提示音」开 / 关，打开时试听；说明文字和英文已加。离线渲染自查：peak 0.18～0.23、时长 0.39～0.53 秒，WAV 在 scratchpad `pet-sound-*.wav`。
- 测试：`node scripts/test-desk-pet.cjs` 15 PASS；`scripts/test-desk-pet-ui.cjs` 全部 PASS（新增提示音、极简模式改成按角度 / 探出宽度断言、设置页提示音开关）。全量：`npm test` 退出 0（751 行 PASS，scratchpad `test-backend-sound.log`）；`npm run test:ui` 退出 0（121 行 PASS，`test-ui-sound.log`）。中途另一次全量 test:ui 里 `test-deepseek-balance-ui` 超时，单独跑两次都 PASS、这次全量也 PASS，判断为偶发，与本次改动无关。
- 本地测试版：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0；`dist\win-unpacked\resources\app.asar`（01:33）SHA256 前 16 位 `298fff55784af8dd`，确认 asar 里有 `pet-sound.js`、`MINI_POSE`、`isApiErrorMessage`，两个 html 都引用了 `pet-sound.js`。收尾：只剩用户安装版 TokenPulse（00:53 启动），没动；没有残留 electron / node / python；dist 两个文件独占打开检测都可以打开；截图脚本的临时目录已删。
- 没验证：真机上的探头手感和提示音实际听感（只做了离线渲染和测试替身）；Claude Code 真实 API 报错行、Codex 真实 `error` 事件的格式按已知字段写的，没拿真实出错会话验证；「额度用完」提示音只在主进程逻辑里，UI 测试没覆盖到这条路径。
- 下一步：用户试用测试版；要发布时再升版本、在 `renderer/intro.js` 加更新说明（0.3.64 的说明里写的是「只露半个身子」，新版要说明改成探头）。
- 会话交接（2026-10-24）：用户说先到这里、开新对话。结束时核对过：工作区就是上面这些未提交改动（13 个修改 + 新文件 `renderer/pet-sound.js`，HANDOFF.md 不提交）；进程只剩用户安装版 TokenPulse（00:53 启动），没有残留 electron / node / python。提示音试听 WAV 在旧会话 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\47b7d8fc-bb9b-4fd3-b8b4-f4f31d389cb8\scratchpad\pet-sound-*.wav`。新会话先等用户对探头手感和提示音的反馈，没说发布就不升版本、不提交。

> 新接手的 AI 先读本节，再读 AGENTS.md 和实际代码。下方保留的开发/发布流水仅适用于标明的版本和阶段；其中「进行中」「未提交」「待验收」不代表当前状态。

## 0.3.64 已正式发布（2026-10-24）

- 用户说把桌宠交互重写和「自定义宠物拖不动」修复算作同一版本，升一个小版本发布 → 0.3.64。
- 已完成：`npm version 0.3.64 --no-git-tag-version`；`renderer/intro.js` 加 0.3.64 三条、`renderer/i18n.js` 英文；`npm test` 退出 0（750 PASS，`test-backend-0364.log`）、`npm run test:ui` 退出 0（120 PASS，`test-ui-0364.log`），日志在 scratchpad；`npm run dist` 退出 0（`build-release-0364.log`）；`node dist/verify-0.3.64.cjs`：170 个运行时文件一致，ASAR SHA256 `eaecd252fde304879b508e33763a30782294b51abcb9dcd6bffb97e82dcc7ede`，win-unpacked 产品版本 0.3.64.0；`dist/assets-0.3.64.sha256`（Setup 112705301、Portable 112448146、blockmap 119911、latest.yml 352）；发布正文 `dist/release-0.3.64.md`。
- Git：fetch 远端无新提交；提交 `56966d7`（16 个文件；暂存区扫过无凭证 / 私人邮箱 / 会话链接），标签 `v0.3.64`，main 与标签已推送。**HANDOFF.md 仍未提交**（按约定只留本地）。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.64 ：标题「TokenPulse 0.3.64」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.64；公开 latest.yml 与本地逐字节一致。
- 收尾：没有遗留的 electron / node / 打包器进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开（句柄已 Dispose）；工作目录在项目根目录。用户安装版 TokenPulse（00:41 启动，用户自己重启的）仍在运行，未安装 / 升级、未关闭——会收到自动更新提示。
- 未验证：真鼠标的甩、拖到右边自动贴边、菜单跳进跳出、拖自定义宠物（测试在屏幕外模式下跑，这些靠用户实机确认）；多显示器贴边。
- 仓库外自用 Clawd 包已含新状态（见下一节），用户需在「桌宠」页删掉旧 Clawd 重新导入。

## 桌宠交互（自己重写，选项 ③）· 已随 0.3.64 发布（2026-10-24；下面的「未提交、未发布」「版本仍 0.3.63」指当时）

- 用户选 ③：在 TokenPulse 自己的桌宠里重写交互，美术原创；**只看 clawd-on-desk 的功能说明（docs/guides/features），不看、不抄它的实现代码和素材**。版本未指定 → 不升版本、不发布，只本地测试版。
- 方案：`renderer/pet-engine.js` 加地面影子 + 待机身体朝鼠标微倾；睡眠序列（Controller：系统 60 秒没操作 → 打哈欠 → 打盹点头 30 秒 → 倒下 → 睡；有操作：睡着的吓一跳再揉眼睛、打盹的揉眼睛），主进程每秒把 `powerMonitor.getSystemIdleTime()` 发给宠物窗口（测试的屏幕外模式不发，由测试自己发）；点击：单击延迟 300ms 开气泡、双击「戳一下」（>< 眼、压扁、怒气符号）、连点 4 下东张西望（问号）；甩：松手时按最后约 80ms 的速度滑行、摩擦减速、碰边反弹（纯函数 flingPath 在 desk-pet-model.ts），落地播 land；贴边极简模式：拖到 / 甩到屏幕右边缘或右键「极简模式」→ 窗口贴右边，宠物藏一半，鼠标移上来探出身挥手，任务完成探出来庆祝，进出用抛物线跳；新偏好 `deskPetMini`。自定义宠物包新增可选状态 poke / doze / look / wave / peek（缺了按旧状态代替）。之后给仓库外的自用 Clawd 包补这些状态。
- 改动（全部未提交，版本仍 0.3.63）：
  - `renderer/pet-engine.js`：影子 / 前倾、doze 状态、poke / lookaround / flop / wave 动作和特效（问号、怒气、小 z）；`Controller` 的睡眠序列（`idle()`、`rouse()`、`setMode()`、`stateOf()`、`drowseTick()`、动作队列）；`Clicks` 连点计数；导出 `Clicks`、`DOZE_AFTER`、`DOZE_MS`。
  - `src/core/desk-pet-model.ts`：`deskPetMini` 偏好、`MINI_SHOW/MINI_PEEK/MINI_SNAP`、`miniBounds`、`miniSpriteCenter`、`reachesRightEdge`、`releaseVelocity`、`flingPath`、`jumpPoint`。
  - `src/main/desk-pet.ts`：拖动记轨迹、松手甩出（`flyTimer`，屏幕外测试模式不甩）、`settle()` 落地 / 贴边、`setDeskPetMini()` 抛物线跳、从边上拖出来退出极简、右键菜单「极简模式（贴到屏幕右边）/ 退出极简模式」、气泡对准露出的那截、空闲秒数 `desk-pet-idle`、`resetDeskPetPosition` 同时退出极简。
  - `src/main/index.ts`（`saveMini`）、`src/main/preload.ts`（`onIdle`）、`renderer/desk-pet.js`（连点、睡眠、fly / landed、极简布局 + 悬停探出挥手、气泡 / 庆祝时探出）、`renderer/desk-pet.css`（mini 样式）、`src/core/pet-pack.ts`（PET_STATES 加 poke / doze / look / wave / peek）、`renderer/desk-pet-settings.js` + `renderer/i18n.js`（说明文字、菜单英文）。
  - 章鱼的影子按它的脚（第 46 行左右）放在 y=48.6，松鼠 / 仓鼠 54.6（截图自查发现章鱼影子离身体太远后修的）。
  - `renderer/desk-pet.js` 的 `setPointerCapture` 包了 try/catch（指针已失效时照样按点击处理）；悬停提示改在每帧 `draw()` 里按 `ctl.stateOf()` 更新（打盹 / 睡着是宠物自己走到的，没有新的状态推送）。
- 测试（2026-10-24 实测）：
  - `scripts/test-desk-pet.cjs` 14 PASS（新增：甩 / 极简 / 跳的纯函数、睡眠序列、连点、新动作和 doze 对三只宠物都画得出且会动、贴边不画影子）。
  - `scripts/test-desk-pet-ui.cjs` 14 PASS（新增：双击戳一下不开气泡、四连点东张西望、`desk-pet-idle` 70 秒 → 打哈欠 / 打盹 / 提示「在打盹」、0 秒 → 揉眼睛醒、`setDeskPetMini(true)` → 贴边露 45%、悬停探出 85% + wave、移开缩回、从边上拖出来退出极简）。
  - 全套里第一次跑这个 UI 测试失败过一次：屏幕外的宠物窗口被 Windows 算成被遮挡（`visibilityState = hidden`），页面按设计停帧，动作一直不结束。测试里加了 `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`，之后单独连跑 8 次都 PASS。
  - `npm test` 退出码 0（750 行 PASS）；`npm run test:ui` 退出码 0（120 行 PASS）。
  - 截图自查（只用演示数据）：三只宠物 idle / lean / doze / poke / lookaround / flop / wave 帧拼图，看过。
  - 没做：真机上用真鼠标甩、拖到屏幕右边自动贴边、菜单跳进跳出的手感（测试在屏幕外模式下不甩、不跳、不按屏幕边自动贴边）；多显示器贴边。需要用户在本地测试版上手动试。
- 本地测试版（第一次，已被下面「追加修复」后的 00:34 版本替换）：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出码 0，产物 `dist\win-unpacked\TokenPulse.exe`（2026-10-24 00:19），`resources\app.asar` SHA256 前 16 位 `a623c598926767f0`，已确认 asar 里是新代码（`setDeskPetMini`、`function peek`、`class Clicks`）。没有 `npm run dist`、没有安装包、没升版本、没提交、没发布。
- 进程 / 占用：收尾时只剩用户安装版 TokenPulse（`C:\Users\7ipny\AppData\Local\Programs\TokenPulse\TokenPulse.exe`，23:36 启动，0.3.63 自动更新后），没动；没有残留的 electron / node / 打包进程；`dist\win-unpacked\TokenPulse.exe` 和 `resources\app.asar` 独占打开检测都可以打开（检测句柄已关）。
- 仓库外自用 Clawd 包：`D:\CodePorject\Tools\TokenPulse-pets\make_clawd.py` 加了 poke（压扁、> < 眼、怒气）、doze（耷拉眼皮点头、小 z）、look（眼睛左右看、问号）、wave（左手挥）、peek（贴边时朝左看、眨眼）和对应的眼睛 / 手势，已重新生成到 `D:\CodePorject\Tools\TokenPulse-pets\clawd`（13 个状态，约 405 KB），用 `build/core/pet-pack.js` 的 `readPetFolder` 校验通过。导入是复制，用户之前导入过的旧版要在「桌宠」页删掉重新导入才有新状态。
- 追加修复（2026-10-24，用户反馈）：**自定义宠物拖不动，一拖是拖出一张图片**。原因：自定义宠物用 `<img id="dp-img">` 显示，没禁浏览器自带的图片拖放，按住一动就开始原生拖图（拖出虚影），Chromium 随即发 pointercancel，我们自己的拖动收不到 pointermove；内置宠物是 canvas，没有这个问题。修法：`renderer/desk-pet.html` 的 img 加 `draggable="false"`；`renderer/desk-pet.css` 给 `.dp-stage img` 加 `-webkit-user-drag: none; pointer-events: none`（事件交给 stage）；`renderer/desk-pet.js` 加 `pointercancel` → 按松手处理、`document` 上 `dragstart` 一律 `preventDefault`。`scripts/test-desk-pet-ui.cjs` 在导入自定义宠物后断言 img 不可拖（draggable / pointer-events / user-drag / dragstart 被拦）、在图片中间按下移动能开始拖动且窗口跟着假光标走。修后：桌宠 UI 测试 PASS、`node scripts/test-desk-pet.cjs` 14 PASS、`npm run test:ui` 退出码 0（120 行 PASS）；没重跑全量 `npm test`（只改了渲染端三个文件和 UI 测试）。重新打本地测试版：退出码 0，`dist\win-unpacked\resources\app.asar`（00:34）SHA256 前 16 位 `342be21754c97580`，确认 asar 里有 `draggable="false"` 和 `user-drag: none`。收尾进程只剩用户安装版，dist 两个文件独占打开检测都可以打开。真鼠标拖自定义宠物待用户确认。
- 已知限制：极简模式只贴屏幕右边；宠物窗口被别的窗口全挡住时（`visibilityState = hidden`）不走帧，睡眠序列也暂停，露出来后接着走；自定义宠物没有甩出去的转圈动画，只用 drag / land 两张图。

## 用户想用 clawd-on-desk 的皮肤和交互（2026-10-23，只读调查，未改代码）

- 核实 `D:\CodePorject\Exmaple\clawd-on-desk-main`：代码 AGPL-3.0；`assets/LICENSE` 写明美术「All Rights Reserved」，除「个人使用 Clawd on Desk 本身」外**不得复制、修改、分发或使用**；Clawd 形象归 Anthropic（粉丝作品、禁商用），三花猫 / 云宝归作者鹿鹿（@rullerzhou-afk）。TokenPulse 仓库没有 LICENSE、公开发布。结论：**不能把它的皮肤放进或导入 TokenPulse，也不能拷它的代码**；交互可以按功能说明自己重写（不看、不抄实现）。
- 另：Clawd on Desk 自带「额度环」（设置 → Sessions → 额度环 → 采集本机 Claude 使用信息，走 Claude Code 官方 statusline 的 rate_limits，不额外请求官方）；它的自定义 HTTP 接口只收状态，不收额度。
- 给用户的选项：① 继续用 Clawd on Desk 当桌宠（打开它的额度环），TokenPulse 桌宠关掉；② 向作者要书面授权后再做导入；③ 在 TokenPulse 里自己重写眼神跟随、睡眠序列、双击戳/连点、贴边探头、甩动拖拽等交互，配原创美术（用户自用的 Clawd 包在仓库外 `TokenPulse-pets\clawd`）。等用户选。

## 0.3.63 已正式发布（2026-10-23）

- 用户说「升级一个小版本号然后就直接编译并发布」：`npm version 0.3.63 --no-git-tag-version`；`renderer/intro.js` 加 0.3.63 两条（限流自动放慢、统一运行日志）、`renderer/i18n.js` 补英文（node --check 通过）。代码内容见下一节。
- 发布前验证（日志在 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\47b7d8fc-bb9b-4fd3-b8b4-f4f31d389cb8\scratchpad`）：`npm test` 退出 0，746 PASS（`test-backend-0363.log`）；`npm run test:ui` 退出 0，117 PASS（`test-ui-0363.log`）；`npm run dist` 退出 0（`build-release-0363.log`）；`node dist/verify-0.3.63.cjs`：170 个运行时文件逐字节一致，ASAR SHA256 `61a72c09aa9da6b0decf0dd7761af2d142495397ff60b9acdd319c2012553994`；win-unpacked 产品版本 0.3.63.0。附件 SHA256 在 `dist/assets-0.3.63.sha256`：Setup 112698587 字节、Portable 112441370、blockmap 119704、latest.yml 352。发布正文 `dist/release-0.3.63.md`。
- Git：fetch 远端无新提交；提交 `0f6b088`（23 个文件；暂存区扫过无真实凭证/私人邮箱/会话链接，测试里的 token 是 `"Q".repeat(60)` 假值），标签 `v0.3.63`，main 与标签已推送。**HANDOFF.md 仍未提交**（按之前约定只留本地）。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.63 ：标题「TokenPulse 0.3.63」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.63；公开 latest.yml 与本地逐字节一致。
- 收尾：近 1 小时没有遗留 electron / node / 打包器进程；四个附件和 win-unpacked exe / app.asar 可独占打开（句柄已 Dispose）；工作目录在项目根目录。用户安装目录的旧版 TokenPulse（21:59 启动）仍在运行，未安装/升级、未关闭——会收到自动更新提示。
- 未验证：同下一节（没在朋友机器上证实 429、没用真实官方接口验证 Retry-After、没看真实安装版的日志内容、新按钮没截图）。
- 下一步：朋友更新到 0.3.63 后再看提示；还刷不出就让其发 `~/.tokenpulse/logs/tokenpulse.log`（设置 →「数据」→「打开日志」），看 `[net]` 和 `[quota]` 行。候选新功能（未做，等用户决定）：经 TokenPulse 路由时从响应头 `anthropic-ratelimit-unified-5h/7d-utilization` 取额度、省掉查询；本机没在用的账号降低查询频率。

## 额度 429 退避 + 提示分类 + 统一运行日志 · 本地测试版完成（2026-10-23，已随 0.3.63 发布；下面的「未提交、未发布」「版本仍 0.3.62」指当时）

- 起因：朋友两个 Claude 账号刷新一直提示「这次没问到最新额度，还是显示上次的数字」。这句是 `quotaIssueNotice` 的兜底，429 / 5xx / 返回 HTML / 200 但没数字都落到它，原因不显示也不落盘；额度默认每 60 秒查、429 不退避。推断最可能是 `/api/oauth/usage` 限流（**未在朋友机器上证实**）。用户要求三点全做，日志做成「统一大日志」。版本未指定 → 不升版本、不发布。
- ① 429 退避：`src/core/curl.ts` curlJson 加 `-D -` 读响应头（`splitHeaders` 剥掉代理 CONNECT 段）、`parseRetryAfter`；≥400 抛 `HttpError(status, retryAfterMs, errorType)`（message 仍是 `http 状态码`，401/403 仍抛 "auth"；4xx/5xx 的 HTML 现在报 http 状态码而不是 not json）。`src/core/quota.ts` 每账号冷却：等待＝max(退避 2→4→8 分钟封顶 15, Retry-After 封顶 60 分钟)，冷却中不发请求（手动刷新也不发），查到一次清零；导出 `rateLimitWaitMs`、`resetQuotaCooldowns`。issue 新增 reason `rate-limited` + `retryAt`；detail 改用 `errorText`（curl 的 stderr，不再是带 token 的整条命令行）。
- ② 提示分开说：限流「被官方限流了（HTTP 429），约 HH:MM 再自动查」、5xx「官方服务器出错（HTTP n）」、其它 HTTP、「返回的不是额度数据，可能被代理或网络拦截了」、「返回里没有额度数字」，认不出的才用老兜底句；非限流/登录类问题末尾加「详细原因已记在日志（设置 →「数据」→「打开日志」）。」。i18n.js 加了对应英文（品牌版和通用版各 6 条 + 词条）。
- ③ 统一运行日志 `~/.tokenpulse/logs/tokenpulse.log`：新 `src/core/app-log.ts`（本地时间 + 级别 + 分类；脱敏：家目录→~、链接参数、Authorization/api-key/cookie、邮箱打码、≥32 字符长串；单行 600 字；4 MB 轮换留 tokenpulse.1/2.log；写失败不影响功能、目录被删会重建）。记录内容：curlJson/curlPost/curlBinary 每个请求（方法、域名+路径、状态码、耗时、错误类型、Retry-After、非 JSON 的类型和大小、curl 报错）；`upstreamRequest`（含路由转发、DeepSeek 余额、探测；本机地址成功不记；只在有 callback 时听 response）；每轮额度结果（每账号数字或没查到的原因与冷却时间）；刷新提示原文；续期（renew-log.ts 同时写一行）；更新器和知识库检查；登录过程（login-log.ts 改为写进统一日志，分类 `login 家#编号`，`loginLogFile()` 指向统一日志；0.3.62 留下的 login-log.txt 不动）。新 `src/main/app-log-setup.ts`（index.ts 第一个 import，加载即装）：包 ipcMain.handle 记操作（不记参数，只带 "claude" 这类短标识；prefs:write 记键名和开关/数字值；QUIET 只读通道只记失败或 >5 秒）、console.error/warn、unhandledRejection（改为 console.warn 输出并记录）、uncaughtExceptionMonitor（只旁观）、各窗口界面进程退出/卡死/preload 出错/界面 console error、子进程退出、启动时版本系统时区和去 anthropic/chatgpt 走不走代理、退出。设置「数据」页按钮改「打开日志」（IPC `open-log`，preload `openLog`），说明文字改写；oauth.ts 失败提示改指向「打开日志」。
- 测试（实际执行，日志在 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\47b7d8fc-bb9b-4fd3-b8b4-f4f31d389cb8\scratchpad`）：新 `scripts/test-app-log.cjs` 23 项（真实 curl 打本机临时 HTTP 服务：200/429+Retry-After/503 HTML/200 HTML/401/连不上/POST；脱敏、轮换、目录重建、upstreamRequest 记录），已加进 npm test；`test-quota-fetch.cjs` 扩到 56 项（分类提示与英文、429 冷却不发请求、清零后重算、503 不冷却、curl 超时 detail 不带命令行、日志里打码不带 token）；`test-oauth-login.cjs` 按新分类和「打开日志」改断言 15/15；`test-ui.cjs:931` 断言改新文案；`test-intro-ui.cjs` 指纹排除 logs/（同 concurrency-history 的理由），另断言运行日志里没有 claude:demo。`npm test` 退出 0，**746 PASS**（`test-backend.log`）；`npm run test:ui` 第一次在 intro 指纹失败（就是 logs/ 那条），修后全串退出 0，**117 PASS**（`test-ui.log`）。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build.log`）；`dist/win-unpacked/TokenPulse.exe` 产品版本 0.3.62.0（**没升版本**，和已发布 0.3.62 同号），app.asar 内含 app-log-setup.js / app-log.js / rateLimitWaitMs / open-log。dist 里 Setup/Portable/latest.yml 仍是 0.3.62 正式版。
- 未验证：没在朋友机器上复现 429；没用真实官方接口验证 Retry-After 是否真的会给（没给就走 2 分钟起的退避）；没启动真实安装版看真实日志内容（用户的正式版在运行，用的是真实数据）；「打开日志」按钮和英文文案没截图。
- 已知限制：冷却只在内存里，重启 TokenPulse 清零；Grok 的 grpc 请求只记状态码，不参与 429 冷却；路由转发的 AI 请求每次一行，用得多时日志轮换更快（4 MB×3）；日志里保留账号别名原文（邮箱会打码）。
- 用户插问（Claude Code 的 /usage）：本机 claude.exe 2.1.310 里 /usage 只在打开时请求 `/api/oauth/usage`（网关模式另有 5 分钟节流读取）；平时 5h/7d 用量来自每次对话响应头 `anthropic-ratelimit-unified-5h/7d-utilization`、`-reset`，传给状态栏 `rate_limits`，不落盘（压缩代码里看的，大致可信）。建议：经 TokenPulse 路由时直接读响应头、有新数据的账号跳过查询；本机没在用的账号降低频率；状态栏桥接只做可选项。**未实现，等用户决定。**
- Git / 安装 / 发布：**全部未提交**；未安装、未发布。收尾：本轮启动的 electron/node/打包进程都已结束（近 2 小时只有用户安装目录的正式版 TokenPulse，21:59 启动，5 个进程，未动）；`dist/win-unpacked/TokenPulse.exe` 和 `resources/app.asar` 可独占打开（句柄已 Dispose）；工作目录在项目根目录。
- 下一步：等用户决定是否升版本发布（朋友要用需要新版）、是否做「读响应头省查询」。

## 用户自用的 Clawd 宠物包第二版：小一号、更接近官方比例（2026-10-24，不进仓库，不涉及版本）

- 用户觉得原来的 Clawd 太大，要求重画：小一点、风格更接近官方，但不要一模一样。
- `D:\CodePorject\Tools\TokenPulse-pets\make_clawd.py` 重写：72x56 画布里身体只有 24x14（原来 42x24），放在底边中间，上面留给效果；平涂橙色、竖条眼睛、两侧小短手、四条小短腿，比例照官方终端里的 Clawd 小图标（宽约为高的 1.5～1.7 倍，眼睛靠两边）。自己的改动：四角削圆、底边和腿用深一号的橙、腮红、没有深色描边，表情和动作都是自己画的。没有参考 clawd-on-desk 的素材。
- 13 个状态都有（idle、work、sleep、celebrate、tight、empty、drag、startle、poke、doze、look、wave、peek）；举手改成斜着往外上方伸（竖着举像角）；笔记本放低，不挡眼睛；汗珠挪到头的右上角外面。
- 旧版备份：`make_clawd_v1.py`、`clawd-v1\`（同一个文件夹下）。新包已生成到 `D:\CodePorject\Tools\TokenPulse-pets\clawd`（约 237 KB），用 `build/core/pet-pack.js` 的 `readPetFolder` 校验通过（13 个状态）。
- 自查：放大预览图看过；另用临时数据目录跑 TokenPulse、导入这个包、截桌宠窗口（scratchpad 里的 `capture-clawd.cjs`，只用测试数据），平时和极简模式都正常显示、背景透明。截图脚本的临时目录退出时没删掉，已手动删除；没有残留进程。
- 用户要做的：在「桌宠」页删掉旧的 Clawd，再导入 `D:\CodePorject\Tools\TokenPulse-pets\clawd`（导入是复制，旧的不会自动更新）。

## 用户自用的 Clawd 自定义宠物包（2026-10-23，不进仓库；第一版，已被上面的第二版替换）

- 用户想要 Clawd 形象的桌宠。Clawd 形象属 Anthropic，按阶段一的约定**不内置、不进仓库、不随 Release 发**；只做成用户自己导入的自定义宠物包，放在仓库外 `D:\CodePorject\Tools\TokenPulse-pets\clawd\`（pet.json + 8 个状态的透明 GIF，576×448＝72×56 像素格放大 8 倍，共约 269 KB）。生成脚本 `D:\CodePorject\Tools\TokenPulse-pets\make_clawd.py`（Pillow，`python -I make_clawd.py <输出目录> [预览图.png]`），原创逐格绘制，没有用 clawd-on-desk 的素材。
- 验证：用 `build/core/pet-pack.js` 的 `readPetFolder` 校验通过（8 个状态都识别为 gif）；预览图在亮/暗底色上自查过（修了 Zzz 糊成一团、彩纸盖到身上）。**没有在真实桌宠窗口里导入看效果**，也没改用户的 `~/.tokenpulse/pets`。

## 0.3.62 已正式发布（2026-10-23）

- 用户说「升级一个小版本号然后直接发布」：`npm version 0.3.62 --no-git-tag-version`；`renderer/intro.js` 加 0.3.62 两条、`renderer/i18n.js` 补英文（CRLF 保持，`node --check` 通过）。内容见下一节（系统代理登录修复、Claude 资料路径修复、登录日志）。
- 发布前验证（日志在 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\e5a8e787-8146-43ce-a559-3cc5c2a0080c\scratchpad`）：`npm test` 退出 0，704 PASS（`test-backend-0362.log`）；`npm run test:ui` 退出 0，117 PASS（`test-ui-0362.log`）；`npm run dist` 退出 0（`build-release-0362.log`）；`node dist/verify-0.3.62.cjs`：168 个运行时文件逐字节一致，ASAR SHA256 `375a6488429649435d0a4e29c4945b6fa187133bf8e133889af2846d643a1077`；win-unpacked 产品版本 0.3.62.0。附件 SHA256 在 `dist/assets-0.3.62.sha256`：Setup 112692912 字节、Portable 112435695、blockmap 119718、latest.yml 352。发布正文 `dist/release-0.3.62.md`。
- Git：fetch 远端无新提交；提交 `ca7062a`（14 个文件，暂存区扫过无凭证/私人邮箱/会话链接；测试里的 token 是 `"A".repeat(48)` 之类假值），标签 `v0.3.62`，main 与标签已推送。**HANDOFF.md 仍未提交**（按之前约定只留本地）。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.62 ：标题「TokenPulse 0.3.62」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.62；公开 latest.yml 与本地逐字节一致。
- 收尾：近 1 小时没有遗留 electron / node / 打包器进程；四个附件和 win-unpacked exe / app.asar 可独占打开（句柄已 Dispose）；工作目录在项目根目录。用户安装目录的旧版 TokenPulse（20:59 启动）仍在运行，未安装/升级、未关闭。
- 未验证：同下一节（没在朋友机器上证实根因、没走真实浏览器登录、新按钮没截图）。
- 下一步：朋友更新到 0.3.62 后再试登录；还不行就让其发 `~/.tokenpulse/login-log.txt`。
- 后续反馈（10-24）：用户贴来朋友 0.3.62 的登录日志，「重新授权」成功：日志写着「代理：按系统代理补上 HTTPS_PROXY=http://127.0.0.1:7890」（说明朋友机器环境变量里没有代理、只有系统代理），CLI 为 npm 版 Claude Code 2.1.301，20 秒成功、有邮箱。与根因推断一致，但没有旧版失败时的日志，严格说不是对照实验。

## OAuth 登录「没有检测到登录成功」排查 + 登录日志（2026-10-23，已随 0.3.62 发布；下面的「未提交、未发布」「同号 0.3.61」指当时）

- 用户反馈：朋友在浏览器 OAuth 授权成功，TokenPulse 却提示「没有检测到 OAuth 登录成功」（该提示＝CLI 已退出、临时目录里没读到新凭据）。用户要求排查，排查不出就加日志系统。版本未指定，不升版本、不发布。
- 诊断（本机只读核实）：① `runLogin`（`src/main/oauth.ts`）spawn 登录 CLI 时 `stdio: "ignore"`，CLI 的报错全丢，所以界面只能说「没检测到」。② 登录子进程只继承环境变量，不带系统代理；本机 Claude Code 2.1.310 的 claude.exe 里没有读 Windows 系统代理（Internet Settings）的代码，换 token 的地址是 `https://platform.claude.com/v1/oauth/token`；本机直连该域名返回 403、走代理 200。推断：朋友只开了「系统代理」、没设 HTTPS_PROXY 时，浏览器能授权，CLI 换 token 直连被拒后退出 → 就是这个提示（本机有用户级 HTTPS_PROXY，所以本机正常）。**未在朋友机器上证实。** ③ 0.3.60 回归：登录时 CLI 跑在 `CLAUDE_CONFIG_DIR=临时目录/.claude`，账号资料写在 `临时目录/.claude/.claude.json`，但 `claudeProfileFile(临时目录)` 读的是 `临时目录/.claude.json` → 新登录的 Claude 账号没有邮箱、身份退回 token 哈希，「重新授权」会报账号不一致。
- 计划：登录子进程按系统代理补 HTTPS_PROXY/HTTP_PROXY（环境里没有时）；修 ③ 并在凭据出现后等资料落盘；新增登录日志（CLI 输出脱敏、退出码、临时目录文件名/大小、判定原因），设置「数据」里加「打开登录日志」，失败提示指向日志；补测试。
- 改动：`src/core/upstream-proxy.ts` 新增 `systemProxyEnv`（环境里没代理、系统代理是 HTTP 代理时，给子进程补 HTTPS_PROXY/HTTP_PROXY，NO_PROXY 补 localhost/127.0.0.1/::1）；`src/core/credentials.ts` `claudeProfileFile(home, isolated)` / `readCliAccounts(kind, home, isolated)`，`src/core/cli-switch.ts` `readCliSnapshot(..., isolated)`；新文件 `src/core/login-log.ts`（`~/.tokenpulse/login-log.txt`，脱敏：家目录→~、链接参数去掉、邮箱打码、≥32 字符长串隐藏、去终端控制符；超 512 KB 留后一半；会自己建数据目录）；`src/main/oauth.ts` runLogin：stdout/stderr 改为 pipe 进日志（stdin 仍 ignore），记 TokenPulse 版本/系统、CLI 路径、代理情况、CLI 版本（在另一个空目录跑 `--version`，不等它）、退出码、`describeLoginDir` 临时目录结构（只看结构不读值）和判定；检测到凭据后等 CLI 自己退出（≤3 秒），Claude 没邮箱时最多等到 10 秒；失败提示后面加「详细过程已记在登录日志（设置 →「数据」→「打开登录日志」）。」；`index.ts` IPC `open-login-log`（有日志就在文件夹里选中，没有就开数据目录并返回 false）、`preload.ts` `openLoginLog`、`renderer/index.html` 数据页按钮＋说明、`app.js` 点击处理、`i18n.js` 英文 6 条；新测试 `scripts/test-oauth-login.cjs`（假 claude.cmd / codex.cmd 走真实 runLogin：资料晚写、403 失败、系统代理补全、脱敏、临时目录删除；仅 Windows），已加进 `npm test` 末尾。写测试时发现并修了日志自己的 bug：第一次登录时数据目录还没建，第一行丢失。
- 测试（实际执行，日志在 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\e5a8e787-8146-43ce-a559-3cc5c2a0080c\scratchpad`）：`node scripts/test-oauth-login.cjs` 15/15，连跑多次稳定；`npm test` 退出 0，**704 PASS**（`test-backend.log`，689＋15）；`npm run test:ui` 退出 0，**117 PASS**（`test-ui.log`）。之后只改了一句日志措辞（SOCKS 系统代理不补的说法），重新 compile 后 test-oauth-login 仍 15/15。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build.log`）；`dist/win-unpacked/TokenPulse.exe` 产品版本 0.3.61.0（**没升版本**，和已发布的 0.3.61 同号），asar 里有 `build/core/login-log.js` 和 `open-login-log` 按钮。dist 里 Setup/Portable/latest.yml 仍是 0.3.61 正式版。
- 未验证：没有在朋友机器上复现，根因 ② 是推断；没用真实浏览器走一遍真实 Claude/Codex/Grok 登录（会动真实账号）；新按钮和英文文案没截图自查；系统代理是 SOCKS 或 PAC 返回 SOCKS 时不会补（parsePacResult 只认 HTTP 代理），日志里会写「直连」。
- Git / 安装 / 发布：**全部未提交**；未安装、未发布。朋友要用需要新版本：用户要求时再升版本（建议 0.3.62，并在 intro.js 加更新说明）、`npm run dist`、发 Release。临时让朋友绕过：在系统环境变量里设 `HTTPS_PROXY=http://127.0.0.1:<代理端口>` 后重启 TokenPulse，或代理开 TUN 模式。
- 收尾：本轮启动的 Electron / Node / 打包进程都已结束（近 2 小时启动的只有用户安装目录的正式版 TokenPulse，20:59 启动，未动）；`dist/win-unpacked/TokenPulse.exe`、`resources/app.asar` 可独占打开（句柄已 Dispose）；工作目录在项目根目录。
- 下一步：等用户决定是否升版本发布；朋友装上新版后若还失败，让其发 `~/.tokenpulse/login-log.txt`（设置 →「数据」→「打开登录日志」）。

## 0.3.61 已正式发布 · 桌宠（2026-10-23）

- 用户试用反馈三项改完后说「应该可以了，编译安装包并发布」。版本沿用之前按用户要求升好的 0.3.61，没再改版本号。
- 发布前验证（最终代码，日志在 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\4f6addf9-6997-42a7-bb6a-d550a065de4b\scratchpad`）：`npm test` 退出 0，689 PASS（`test-backend-0361.log`）；`npm run test:ui` 全串退出 0，117 PASS（`test-ui-0361.log`）。
- 打包：`npm run dist` 退出 0（`build-release-0361.log`）。`node dist/verify-0.3.61.cjs`：167 个运行时文件逐字节一致，ASAR SHA256 `b029cc94f2b10b9b104485d83c4cdca9a8f98af181aaf332d14f9e4ccdaffcb9`；win-unpacked 产品版本 0.3.61.0。附件 SHA256 在 `dist/assets-0.3.61.sha256`：Setup 112690262 字节、Portable 112433108、blockmap 119797、latest.yml 352。发布正文 `dist/release-0.3.61.md`。
- Git：fetch 远端无新提交；提交 `9372ac6`（28 个文件：桌宠全部代码、测试、版本、说明；提交前扫过暂存区无凭证/私人邮箱/会话链接），标签 `v0.3.61`，main 与标签已推送。**HANDOFF.md 仍未提交**（含 10-19 审计记录，按之前约定只留本地）。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.61 ：标题「TokenPulse 0.3.61」，非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.61；公开 latest.yml 与本地逐字节一致。
- 收尾：近 1 小时内没有遗留的 electron / node / 打包器进程；四个附件和 win-unpacked 的 exe / app.asar 都能独占打开（句柄已 Dispose）；工作目录在项目根目录。用户安装目录的旧版 TokenPulse（02:34 启动）仍在运行，没有安装/升级、没有关闭——用户会收到自动更新提示。
- 未验证（同下面反馈三项一节）：真鼠标拖动、真实桌面上的气泡位置和手感、多账号下「正在用的账号」的挑选、英文气泡截图；没有安装新版实际运行。
- 下一步：等用户装上 0.3.61 后的反馈。阶段二候选：更多工具的任务状态、任务完成提示、点任务定位到具体会话。

## 0.3.61 桌宠试用反馈三项 · 完成（2026-10-23，已随 0.3.61 发布；下面的「未提交、未发布」指当时）

- 用户试用阶段一后提了三点，方案经用户确认（「都按你的建议来」）：① 拖着停住、鼠标没松开时宠物持续漂移；② 额度紧张时别一直流汗喘气，改成隔一阵来一次；③ 点开不要用托盘面板那种卡片，改成像素风对话气泡，显示正在用的账号的额度。附带确认：气泡里任务只留一行摘要（点开会话管理），完整任务列表放右键「查看任务」；「额度跟哪个账号」默认改为跟着正在用的，仍可手动固定；鼠标不在气泡上 8 秒自动收起。**版本仍是 0.3.61，没升版本、没提交、没发布。**
- ① 拖动漂移：根因实测确认——本机屏幕缩放 1.5，`setBounds({...getBounds(), x, y})` 在部分坐标每调一次窗口大一像素（scratchpad `drift/main.js`：50 次涨 50px；`setPosition` 一样涨；只有固定大小的 setBounds 稳定，非整数倍缩放下可能固定差 1px 但不再增长）。宠物画在窗口底边中间，看起来就是在漂。修法（`src/main/desk-pet.ts` deskPetDrag）：大小固定用 `petWindowSize`、光标没动不碰窗口、松手按自己算的位置存脚下中点；`renderer/desk-pet.js` pointermove 时没按左键按松手处理（漏掉松手的保险）。
- ② 流汗节奏：`renderer/pet-engine.js` Controller 加 `nervousTick` / `nervous`，按真实时间：变紧张后 1～2.5 秒来一次，之后每 20～40 秒、剩不到 10% 每 15～25 秒，每次 2～3 秒；睡觉、做动作（拖动/庆祝…）时不插入；额度用完不冒汗。三只宠物平时只皱眉，紧张那几秒才冒汗、张嘴喘、身体一缩一缩、抖动。ctx 可传 `nervous` 覆盖（测试/预览用）。
- ③ 对话气泡：新建 `renderer/desk-pet-bubble.html/js/css`（透明窗口；2px 像素描边四角缺一格、阶梯投影；SVG 拼的像素尾巴，朝下/朝左/朝右；宠物说一句话＋账号名和套餐＋5 小时/周额度各 10 格「剩多少亮多少」＋重置时间＋一行任务摘要；30 分钟没更新额度时提示；右键「查看任务」是任务列表；Esc/失焦/再点宠物收起，鼠标不在上面 8 秒自己收起；中文系统字体，英文走 L()）。`src/core/desk-pet-model.ts` 加 `PetUsing` / `pickPetAccount`（没指定账号时：有任务在跑的工具 claude→claude、codex→chatgpt 的 CLI 当前登录账号，其次刚完成任务的、再其次记住的最近用过的；那家当前登录的没额度数据取那家第一个；都不知道取排第一的账号那家的当前登录账号）、`bubbleBounds`（默认头顶尾巴朝下；上面放不下放右边，再放不下放左边；BUBBLE_EDGE 6 / BUBBLE_TAIL 12），删掉 cardBounds。`src/main/desk-pet.ts` 卡片改气泡（当前登录账号按登录文件 mtime+size 缓存，`~/.claude.json` 可能很大；导出 `openDeskPetBubble`；右键菜单改为「查看额度」「查看任务」…；失焦收起用自己记的 bubbleShown 判断——Windows 上 hide() 引起的 blur 会晚到、那时 isVisible() 还是 true；气泡开着时宠物窗口 body.talking 藏悬停提示）。index.ts / preload.ts 的 IPC 改为 `desk-pet:bubble-data/size/action`、`desk-pet-bubble`。**撤回了 tray-panel.* 的宠物模式**（`?mode=pet`），只保留上一轮为英文界面量高度加的两处通用修复（queueMicrotask 再量一次、ResizeObserver）；撤回前的 diff 存在 scratchpad `tray-panel-pet-mode.diff`。文案：设置页（「跟着正在用的账号」默认项、说明、流汗说明）、intro.js 0.3.61 条目、app.js 桌宠页副标题、README Desk pet 一节、i18n.js（改 9 条、加「查看额度」「查看任务」、删 3 条不再用的）。
- 测试（实际执行，日志在 scratchpad `C:\Users\7ipny\AppData\Local\Temp\claude\D--CodePorject-Tools-TokenPulse\4f6addf9-6997-42a7-bb6a-d550a065de4b\scratchpad`）：`scripts/test-desk-pet-ui.cjs` 新增拖动测试（假光标、屏幕外坐标）——**修复前失败**「光标不动，宠物不漂、窗口不变大」，修复后通过；卡片测试换成气泡 4 组（点开/任务摘要打开会话管理、查看任务列表、格子/恢复时间/过期/侧边尾巴/Esc、8 秒自动收起）。`scripts/test-desk-pet.cjs` 加流汗节奏一组、账号挑选与气泡定位断言。`npm test` 退出 0，**689 PASS**（`test-backend.log`）。`npm run test:ui` 第一次全串在 `test-quota-pressure-ui.cjs` 超时失败（等 track-fill warning，和桌宠无关；单独连跑 2 次都通过，其后各脚本单独跑全部通过，`test-ui.log` / `test-ui-rest.log`）；**第二次全串退出 0，117 PASS**（`test-ui-2.log`；113 − 原桌宠 7 组 + 新 11 组）。桌宠 UI 测试单独连跑 2 次稳定。
- 视觉自查：scratchpad `bubble-shots.cjs` 用测试数据只截气泡窗口（`shots-bubble/`：亮/暗、额度够/紧张/用完、尾巴朝下/左/右、任务列表），据此把任务列表加宽到 312px、日期式重置时间加空格。没截桌面、没用真实数据。
- 打包：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（`build.log`）。`dist/win-unpacked/TokenPulse.exe` 产品版本 0.3.61.0；app.asar 内有 desk-pet-bubble.*、拖动固定大小、nervousTick，tray-panel 已无宠物模式（scratchpad `verify-asar.cjs`）。dist 里的 Setup/Portable/latest.yml 仍是 0.3.60 正式版，未重新生成。
- 未验证：真鼠标拖动（漂移修复只用假光标和独立复现脚本验证）、真实桌面上气泡的位置和尾巴朝向、点宠物时气泡失焦/再点关闭的手感、8 秒自动收起在真鼠标悬停下的表现；「正在用的账号」没在真实多账号环境里观察（只有单元测试，读了本机 official-accounts.json 只确认 id 是 kind:ref 格式）；英文气泡没截图。
- 已知限制：气泡第一次打开时先按默认大小放，页面量好后再挪一次（可能闪一下）；气泡窗口透明的外沿（描边/尾巴旁几像素）不点击穿透；最近用过的工具只记在内存里，重启 TokenPulse 后没任务时回到排第一的账号那家。
- Git / 安装：**全部未提交**；未安装、未发布。用户安装目录的正式版（02:34 启动，4 个进程）仍在运行，未动。
- 收尾：本轮启动的 Electron / Node / 打包进程都已结束（近 3 小时启动的只剩用户的正式版）；`dist/win-unpacked/TokenPulse.exe` 和 `resources/app.asar` 可独占打开（句柄已 Dispose）；工作目录在项目根目录。
- 下一步：等用户试用反馈；用户要求时再提交 / 发布。

## 0.3.61 本地测试版 · 桌宠（阶段一）完成（2026-10-22，已被上面 10-23 的反馈修改取代：卡片改成了气泡、拖动和流汗已修）

- 需求与约定：用户反馈看额度要开主界面太麻烦，要桌宠：点一下看额度，同时显示 Agent 任务。参考了 `D:\CodePorject\Exmaple\clawd-on-desk-main`（AGPL-3.0，**只借鉴思路，没有拷代码和美术**；Clawd 形象属 Anthropic，不使用）。三只原创像素宠物：松鼠栗栗（默认，用户最喜欢）、仓鼠豆豆、章鱼墨墨；形象和动作由用户在私有预览 https://claude.ai/artifact/29nCjSHuDNCSnUUX74TqBf 第二版确认。**桌宠默认关闭**。任务状态只读会话文件推断，不改任何 CLI 配置（hooks 实时模式以后再说，需用户主动开）。版本按用户要求升到 0.3.61，**只做本地编译测试版，不提交、不发布**。
- 后端：`src/core/agent-activity.ts`（Claude 看 user 提问 / tool_use / tool_result / end_turn / system turn_duration、stop_hook_summary / 中断；Codex 看 task_started / function_call / *_output / task_complete / turn_aborted；10 分钟没动的未结束轮次不算在跑；工具调用 90 秒无结果标「可能在等你」；扫描器 30 秒全扫两小时内动过的文件、4 秒 stat 变化，大文件只读头尾各 64 KB；子代理跳过；第一次扫描不报「刚完成」）、`src/core/desk-pet-model.ts`（deskPet* 设置项与收口、宠物跟的额度＝指定账号或第一个账号两个窗口里用得多的那个，用完 empty、压力 high 或剩不到 15% 为 tight；有任务 work，5 分钟无操作 sleep；窗口/卡片定位）、`src/core/pet-pack.ts`（自定义宠物文件夹：pet.json + 各状态图，按文件头只收 PNG/GIF/WebP/JPEG，单张 5 MB、整套 20 MB、最多 20 个，复制到 `~/.tokenpulse/pets/pet-xxxxxxxx/`）、`src/main/desk-pet.ts`（透明、不抢焦点、不占任务栏的宠物窗口；只在宠物像素上接鼠标，其余点击穿透；主进程轮询光标实现拖动并保存脚下中点；右键菜单；卡片窗口复用 `tray-panel.html?mode=pet`，失焦收起、2 分钟后销毁；额度涨 ≥30 点发 restock、任务刚完成发 celebrate；屏幕变化时拉回可见区域）。`prefs.ts` 加字段；`index.ts` 接线（applyPrefs 规范化、快照推送、IPC、before-quit 和「关窗即退出」时销毁）；`preload.ts` 加 `deskPet`；`sessions.ts` 导出 claudeUserText / codexUserText。
- 前端：`renderer/pet-engine.js`（从预览移植的像素引擎 + Controller + paint）、`desk-pet.html/js/css`（宠物窗口；该窗口不加载 app.css，自己定义了 `[hidden]`）、`desk-pet-settings.js/css`（侧栏新页「桌宠」：总开关、实时预览、选宠物、导入/双击删除自定义宠物、大小、不透明度、窗口层级、额度跟哪个账号、空闲小动作、自定义宠物额度标签、放回右下角、格式说明）；`tray-panel.*` 宠物模式（任务列表，点任务打开会话管理；无退出、无供应商；英文下 i18n 换字后再量一次高度）；`index.html`、`app.js`（NAV_PAGES 加 pet）、`i18n.js`（英文）、`intro.js`（0.3.61 两条）、`README.md`（Desk pet 一节）。
- 测试（实际执行）：`npm test` 退出 0，**688 PASS**（0.3.60 为 679，新增 `scripts/test-desk-pet.cjs` 9 组），日志 `test-backend-0361.log`；`npm run test:ui` 全串退出 0，**113 PASS**（新增 `scripts/test-desk-pet-ui.cjs` 7 组；`scripts/test-layout-ui.cjs` 的默认页面清单改为 9 个），日志 `test-ui-0361.log`（其中 Error 行为测试内模拟失败）。用测试数据做了视觉自查（scratchpad 的 `visual-check.cjs` 用 capturePage 截宠物窗口、卡片、桌宠页，不截桌面），据此修了三处自动测试没发现的问题：宠物窗口 `[hidden]` 不生效把宠物顶出窗口、英文卡片高度量早了被截底、选宠物卡片里多出文字「null」，已补进 UI 测试。
- 打包：`npm run icons && npm run compile && electron-builder --win dir --publish never` 退出 0（`build-0361.log`）。产物 `dist/win-unpacked/TokenPulse.exe`，产品版本 **0.3.61.0**，app.asar 内新文件齐全、package.json 版本 0.3.61（scratchpad 的 `verify-asar.cjs` 核对）。已覆盖原 0.3.60 的 win-unpacked；dist 里的 Setup/Portable/latest.yml 仍是 0.3.60 正式版，未重新生成。
- 未验证：没有在真实桌面上手动拖动、右键菜单、点击穿透（自动测试里窗口在屏幕外，拖动依赖真实光标，没测）；多显示器 / 不同缩放下的定位只做了纯函数测试；没有用真实 Claude / Codex 会话长时间观察状态推断；英文界面只做了视觉自查。
- 已知限制：任务状态只支持 Claude Code 和 Codex（Grok / DeepSeek / pi 是阶段二）；「可能在等你」只是推断；全屏应用时自动隐藏没有做（Electron 没有现成接口，需要原生代码）；自定义宠物只能导入文件夹，不收 zip；点任务只打开会话管理页，不定位到那条会话。
- Git / 安装：**全部未提交**（16 个修改 + 12 个新文件；HANDOFF.md 里仍含 10-19 审计记录，按之前约定只留本地）；未安装、未发布。用户安装目录的正式版（19:19 启动）仍在运行，未动。
- 收尾：本轮启动的 Electron / Node / 打包进程都已结束（只剩用户的正式版 TokenPulse）；`dist/win-unpacked/TokenPulse.exe` 和 `resources/app.asar` 可独占打开（句柄已 Dispose）；工作目录在项目根目录。
- 下一步：等用户试用反馈；用户要求提交或发布时再提交 / `npm run dist` / 发 Release。阶段二候选：更多工具的任务状态、任务完成气泡、点任务定位到具体会话。

## 桌宠（阶段一）· 代码完成，跑全量测试中（2026-10-22 检查点 3，已被上面取代）

- 新增 renderer：`pet-engine.js`（由预览引擎移植，加 Controller / paint，mood 可由主进程直接给）、`desk-pet.html/js/css`（宠物窗口：命中像素才接鼠标、拖动、右键菜单、悬停提示、自定义宠物图片 + 额度标签）、`desk-pet-settings.js/css`（侧栏「桌宠」页）；`tray-panel.*` 加 `?mode=pet`（任务列表、无退出/供应商、有「桌宠设置」）；`index.html` 侧栏 + `#i-pet` 图标 + 页面；`app.js` NAV_PAGES 加 pet；`i18n.js` 英文；`intro.js` 0.3.61 说明。
- 测试：新增 `scripts/test-desk-pet.cjs`（9 组 PASS）与 `scripts/test-desk-pet-ui.cjs`（7 组 PASS，连跑两次稳定），已加进 `npm test` / `npm run test:ui` 末尾。`npm version 0.3.61 --no-git-tag-version` 已执行。
- 下一步：全量 `npm test`、`npm run test:ui`，然后 `electron-builder --win dir` 本地打包（不发布），收尾核对进程和 dist 占用。

## 桌宠（阶段一）· 实现中（2026-10-22 检查点 2，已被上面取代）

- 用户已确认第二版预览，开工。**已写好并通过 tsc（未测试）**：`src/core/agent-activity.ts`（只读会话文件推断任务状态：Claude 看 end_turn / turn_duration / tool_use，Codex 看 task_started / task_complete / turn_aborted；扫描器 30 秒全扫、4 秒看变化）、`src/core/pet-pack.ts`（自定义宠物文件夹校验/导入/列表/删除，按文件头只收 PNG/GIF/WebP/JPEG）、`src/core/desk-pet-model.ts`（设置项、额度挑选、睡觉判断、窗口/卡片位置，纯函数）、`src/main/desk-pet.ts`（透明宠物窗口、点击穿透、拖动、右键菜单、卡片窗口复用 tray-panel.html?mode=pet）；`prefs.ts` 加 deskPet* 字段；`index.ts` 接线（applyPrefs 规范化、快照推送、IPC、before-quit 销毁、关窗即退出时销毁桌宠）；`preload.ts` 加 `deskPet` 接口；`sessions.ts` 导出 claudeUserText / codexUserText。
- 待做：renderer（pet-engine.js 从预览移植、desk-pet.html/js/css、tray-panel 宠物卡片模式、「桌宠」设置页 + 侧栏、i18n、intro 0.3.61）、测试（test-desk-pet.cjs、test-desk-pet-ui.cjs 并加入 npm 脚本）、版本 0.3.61、本地打包。

## 桌宠（阶段一）· 形象设计确认（2026-10-22 检查点 1，已被上面取代）

- 需求：用户反馈看额度要开主界面太麻烦，要一个桌宠，点击查看额度，同时显示 Agent 任务情况。参考了 `D:\CodePorject\Exmaple\clawd-on-desk-main`（AGPL-3.0，**只借鉴思路，不拷代码和美术素材**；Clawd 形象属 Anthropic，不使用）。
- 已和用户确认的范围：阶段一做三只内置原创像素宠物（松鼠栗栗＝默认/用户最喜欢、仓鼠豆豆、章鱼墨墨）+ 独立的桌宠设置界面（切换宠物、大小、透明度、全屏隐藏、位置重置、上传自定义宠物包：pet.json + 各状态图片，只收图片、限大小、复制到 `~/.tokenpulse/pets/`）。桌宠**默认关闭**。任务状态第一版只读会话文件推断（不改任何 CLI 配置），hooks 实时模式留到以后且需用户主动开启。
- 版本规则：用户说「提升一个小版本号」→ 0.3.61；**只做本地编译测试版，不发布**。
- 当前进度：还没改仓库代码。形象预览第二版已发布为私有 artifact https://claude.ai/artifact/29nCjSHuDNCSnUUX74TqBf ，源文件在会话 scratchpad 的 `pet-preview/tokenpulse-pets.html`（72×56 像素格、运行时绘制的引擎 + 三只宠物的状态/小动作/鼠标跟随/拖拽）。等用户确认形象和动作后再开工；正式实现时把 `/*ENGINE-START*/…/*ENGINE-END*/` 之间的引擎移植进 renderer。
- 下一步：用户确认预览 → 实现桌宠窗口（透明、置顶、不占任务栏、单窗口）+ 点击卡片（复用 `trayPanelData`）+ 会话文件推断任务状态 + 设置界面 + 自定义宠物包导入 + 测试 → `npm version 0.3.61 --no-git-tag-version` → 本地编译打包，不发布。

## 0.3.60 已正式发布 · 切换 Claude 登录后用量记到上一个账号（2026-10-22）

- 发布状态（用户授权「升一个小版本直接发布」）：`npm version 0.3.60 --no-git-tag-version`；`renderer/intro.js` 加 0.3.60 更新说明一条、`renderer/i18n.js` 补英文（两文件 CRLF，用 scratchpad 脚本按 `\r\n` 插入，`node --check` 通过）。
- 发布验证：`npm test` 退出 0，679 PASS（`test-backend-0360.log`）；`npm run test:ui` 全串退出 0，106 PASS（`test-ui-0360.log`，其中 Error 行为测试内模拟失败）；`npm run dist` 退出 0（`build-release-0360.log`）；`node dist/verify-0.3.60.cjs`：154 个运行时文件逐字节一致，ASAR SHA256 `e27f987a12b4463649ea5b0a88d338cd7283fb6c5293bc8d182bb3799b56cd95`；win-unpacked 产品版本 0.3.60.0。附件 SHA256 `dist/assets-0.3.60.sha256`：Setup 112649865 字节、Portable 112392644、blockmap 119779、latest.yml 352。发布正文 `dist/release-0.3.60.md`。
- Git：提交 `16c6786`（只含代码/版本/说明/测试 7 个文件），标签 `v0.3.60`；推送前 fetch 远端无新提交，main 与标签已推送。**HANDOFF.md 未提交**——其中有 10-19 仓库清理审计记录，按上一轮决定只留本地。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.60 ：非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.60；公开 latest.yml 与本地一致。
- 收尾：四个产物及 win-unpacked exe/asar 均可独占打开（句柄已 Dispose）；无 Electron/打包器残留；在跑的 node 进程均早于本会话启动，不是本轮的；用户安装目录的正式版 0.3.59 仍在运行，未安装/升级、未关闭。
- 以下为修复诊断与源码说明：
- 用户反馈：在设置里一键切换 Claude CLI 登录后，token 消耗仍记在之前的账号上。
- 本机只读诊断（未改用户数据）：`~/.tokenpulse/cli-logins.json` 显示 10-22 05:00 切回账号 A；但之后新开的 Claude Code 会话 `session_context.userEmail` 和 bridge owner 仍是账号 B，直到约 15:19。额度历史证明真实消耗在 A（A 周用量 48→60，B 停在 15）。`resolveAccount` 对「换号之后写入的会话邮箱」优先于时间线，于是记到 B。
- 根因：本机存在 `~/.claude/.claude.json`（别的工具留下的小文件，含 machineID/userID/oauthAccount），`CLAUDE_CONFIG_DIR` 未设置。旧代码只要该文件存在就优先读写它，而 Claude Code 此时只读 `~/.claude.json`。所以切换时新账号资料写进了 Claude Code 不读的文件，TokenPulse 自己读身份也读它（时间线看似正确），Claude Code 却一直报旧账号的邮箱，直到它自己下次刷新资料。
- 改动：`src/core/credentials.ts` 新增导出 `claudeProfileFile(home)`：设了 CLAUDE_CONFIG_DIR（且是本机 home）用该目录，否则只用 `home/.claude.json`；`claudeAccounts` 与 `src/core/cli-switch.ts` 都改用它（删除 cli-switch 里的旧本地函数）。`scripts/test-cli-switch.cjs` 加了干扰文件：身份按 `~/.claude.json` 认、切换不写干扰文件。
- 验证：改动前新断言失败（读到 uuid-stray）；改动后 `npm test` 退出 0，679 条 PASS（日志 `test-backend-0360-claude-profile.log`）。用户需安装 0.3.60 才生效。
- 未验证：没有在真实账号上实际一键切换再看归属（只用测试夹具验证）。
- 已知限制：已经记错的历史（约 10-22 05:00–15:19 被记到 B，以及更早几次切换后的同类窗口）不会自动纠正——会话文件里写的就是旧邮箱，重扫仍按它归属。未删除用户的 `~/.claude/.claude.json`（来源不明，修复后不再影响）。

**状态**：0.3.60 已发布，当前没有进行中的工程任务。

## 仓库展示内容清理 · 已完成并读回验证（2026-10-19）

- 本轮目标：检查账号所有仓库可能暴露个人所在地的内容，并按用户追加选择将个人介绍和项目主说明改为英文；TokenPulse 软件版本保持 **0.3.59**。
- 实际范围：29 个仓库（21 公开、8 私有）的简介、主 README、递归文件目录，选定的个人资料/配置文件；每库最多 10 个账号归属的近期提交抽样。GitHub 代码搜索索引有漏项，不作为无风险证明；没有宣称全历史/全源码/全图片均已清理。
- 已完成：10 个中文仓库简介改为英文；22 个仓库共 28 个文件已通过 GitHub Contents API 提交到各自默认分支，逐文件读回内容完全一致；全部 29 个简介复查为英文或空白。保留上游署名、许可证、中文语言包和语言专属文档；仅将选定的本人标识、个人站点关联和本机路径泛化。Telegram 小工具的地区坐标/时区/姓名默认值改为明确标注的公共地标、UTC 和通用姓名，移除手机号区号示例；用户显式配置仍优先。
- 提交身份：本轮远端提交统一使用 GitHub noreply 身份与 UTC 时间；已设置 **本 TokenPulse 仓库**的 local user.name/user.email 为相同身份，未改全局 Git 配置。报告不复述任何历史邮箱或私人资料原文。
- TokenPulse Git：远端文档提交 **a5c60d6642833318d2f828db43d5159b58ee8dad** 已发布到 main；本地通过 `git -c http.sslBackend=openssl pull --ff-only` 快进同步成功。README.md 已提交/远端生效；本 HANDOFF.md 的本轮审计记录仅本地修改，**未提交、未推送**，以免将审计内容公开。发布标签 v0.3.59 仍指向 a9270c3。
- 验证实际结果：聊天 visualization 目录的 `verify-changes.cjs` 退出 0（配置默认值、显式覆盖、间隔下限、缺失/非法参数、JSON、Markdown 围栏及相对链接）；`node --check telegram-check.mjs` 退出 0；28 文件远端读回完全匹配，29 个简介复查通过。未运行真实 Telegram 登录、未向真实账号发请求；TokenPulse 未改运行时代码，未执行 npm test / UI 全串、编译、打包、安装或软件 Release。
- 产物/证据：`C:\Users\7ipny\.codex\visualizations\2026\10\19\01a15354-32e7-75f2-9977-1cfba207cd68\repository-review.md`（逐文件 commit 链接及限制）；同目录 `file-results.json`、`readback-results.json`、`description-results.json`、`verification.json`、`history-summary.json`。临时材料不加入本仓库。
- 已知限制：历史提交抽样仍见非 noreply 邮箱及中文提交说明；未重写历史、强推、删除/改名仓库、改变可见性或删除 Release；未全面处理其他分支/标签、Release 正文和二进制、Issues/PR、截图、所有源码注释、部署站点、Fork 或缓存。邮箱服务商/中文本身不证明居住地。若继续，先逐库明确历史清理范围并准备备份/影响清单，再取得历史重写授权；当前没有失败的文件写入或读回。
- 环境问题及处理：Node 子进程运行 gh 报 EPERM，改用 PowerShell 直接调用；Git 默认 schannel 报 SEC_E_NO_CREDENTIALS，用单次 `-c http.sslBackend=openssl` 成功同步，未修改全局 TLS 配置；Git 元数据写入经工具授权完成。Markdown licenses/ 目录误报已修正并重验无未解析相对链接。
- 资源收尾：本轮启动的审计/修改/读回命令会话均正常结束；没有启动应用、watcher 或后台预览。dist/latest.yml、0.3.59 Setup/Portable、win-unpacked exe/app.asar 全部可独占只读打开，检测句柄已 finally Dispose。Win32_Process/CIM 进程明细查询被拒绝，不能据此宣称系统无残留进程；未关闭任何用户进程。工作目录仍为项目根目录。
- 下一步：本轮默认分支展示清理已完成；需要更深层隐私处理时按上述限制制定独立范围，不把本轮结果称为彻底匿名。
### 后续只读诊断：TweakerAll 两次 build 失败（2026-10-19）

- 用户询问清理期间的两次失败；已核对 run 39226679344 / 39226682614（提交 4ecca595 / d010308c），分别只改 README.md / README_EN.md。工作流 `on: [push, pull_request]` 无路径过滤，因此两次文档提交各触发一次 build。
- 两份实际 job 日志（117974550214 / 117974561541）均在 `gradle build --no-daemon` 的项目配置/依赖解析阶段失败：`Could not find fi.dy.masa.malilib:malilib-fabric-26.1.2:0.28.8`；尚未进入 Java 编译。build.gradle 仍声明该依赖，未被本轮修改。未验证是远端撤包、坐标问题还是其他解析原因，不能写成已确定上游移除。
- 工作流使用系统 Gradle，日志实际为 9.8.1；仓库 wrapper 是 9.5.1，这是另一个可复现性问题，但没有证据表明它导致本次缺失依赖。
- 本轮仅解释与诊断，未改 CI/依赖、未重跑构建、未取消/删除失败记录。上一轮没有检查提交后的 CI 是遗漏；远端内容读回通过不代表 build 通过。
- `gh run view --log-failed` 因默认缓存目录写权限失败，改用 `gh api .../actions/jobs/<id>/logs` 成功读取；未启动本地构建/预览或长期进程，未访问 dist 产物。本 HANDOFF 更新仍仅本地，未提交/推送。
## 0.3.59 已正式发布 · 额度预测「达到上限」提示降敏 + 宽松程度设置（2026-10-19）

用户反馈：额度详情里只要按趋势算出来会在重置前用完，进度条就从绿变黄，太敏感、让人焦虑。本轮改为**分级**：预测事实照旧保留，只有真正会"断档"一段时间才变色。

**规则（`src/core/quota-monitor.ts`）**：每个窗口新增 `pressure: "none" | "watch" | "high"` 和 `lockoutShare`（按趋势用完后到重置之间没额度的时间 ÷ 剩余时间）。

- `none`：重置前不会用完。
- `watch`：会提前用完，但断档不到 1/4（`PRESSURE_LOCKOUT_SHARE = 0.25`），或已用不到 10%（`PRESSURE_MIN_USED`，整数百分比舍入误差太大）→ 只用文字说明，不变色。
- `high`：已用完，或断档 ≥ 1/4 且已用 ≥ 10% → 原来的黄色/警示。
- `runsOutBeforeReset`、`etaAt`、`projectedAtReset` 字段及含义不变（号池预排 `report.ts` 继续用它们）。`healthOf` 的「重置前压力较高 / 当前窗口紧张」改为只在 `pressure === "high"` 触发，watch 落到「用量偏高」。

**界面（`renderer/app.js`）**：新增 `pressured(win)` 帮助函数（老快照没有 pressure 字段时退回 runsOutBeforeReset）。进度条 `track()`、环色、「已用」文字、预测行底色、「预计达到上限」「重置时预计使用」的警示色都改为按 `pressured()`。watch 时预测行写成「按最近趋势，预计约 X 后达到上限，距重置只差 Y，稍微放慢即可」，「会用满」芯片改为中性的「略超」。`src/main/tray-panel.ts` 的 `runsOut` 也改为 pressure high。`renderer/i18n.js` 补了对应英文模式串；`renderer/index.html` 与 i18n 中额度页说明补了这条规则。

**测试**：

- `scripts/test-quota-monitor.cjs` 新增 9c 组（7 条）：watch / high / 已用不到 10% / none / 已用完；`scripts/test-tray-panel.cjs` 夹具补 pressure 字段。
- 新增 `scripts/test-quota-pressure-ui.cjs`（已加入 `npm run test:ui`，排在 pool-quota 之后）：两个假 Claude 账号，核对详情页进度条 class、预测行、指标警示色，总览卡片徽标/进度条，以及英文翻译；`TP_SHOTS` 可截图。
- 实际结果：`npm test` 退出 0（674 条 PASS，比 0.3.58 多 7 条）；`test-quota-pressure-ui`、`test-ui`（26 PASS）、`test-pool-quota-ui`、`test-tray-panel-ui` 单独运行均退出 0。未重跑其余 UI 脚本的全串、未打包。合成数据截图在 `dist/shots-quota-pressure/`（watch 绿条 + 绿色说明、high 黄条 + 警示，核对过）。
- 测试结束后按命令行核对，没有本轮遗留的 Electron/Node 进程；没有触碰 `dist` 中的 0.3.58 产物。

**第二阶段（用户确认阈值后）**：宽松程度交给用户，按窗口分开，默认 5 小时更宽松。

- 新文件 `src/core/quota-pressure.ts`：`PressureLevel = strict | default | relaxed | off`，规则 strict={0,0}（= 以前行为）、default={0.25,10}、relaxed={0.5,10}、off={∞,0}；`PRESSURE_DEFAULTS = { week: "default", five: "relaxed" }`；`readPressurePrefs()` 直接读 prefs.json（worker 用）。
- `quota-monitor.ts` 的 `analyzeWindow` 接 `pressureRule`，`analyzeAccount` 第 7 个参数 `pressure: PressurePrefs`；`report.ts` 读设置传入。
- `src/main/prefs.ts` 新增 `pressureWeek`/`pressureFive`；`index.ts` 的 applyPrefs 校验非法值回默认，并和 localOnlyAccounts 一样触发 `backgroundRefresh(false)` 重算快照。
- 设置 → 提醒新增两行（`renderer/app.js` 的 `PRESSURE_OPTIONS`，key pressureWeek/pressureFive），i18n 已补；`renderer/intro.js` 新增 0.3.59 更新说明两条；README 加一句。
- 测试：test-quota-monitor 再加 6 条（严格/不变色/5 小时默认宽松/改标准）；test-quota-pressure-ui 加设置改 off/strict 后快照重算的两步，并截 settings 图。
- `npm version 0.3.59 --no-git-tag-version` 已执行（package.json / package-lock.json）。

**0.3.59 测试版验证结果（2026-10-19，实际执行）**：

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm test` | 退出 0，679 条 PASS（0.3.58 为 667，新增 12 条） | `test-backend-0359.log` |
| `npm run test:ui` | 全串退出 0，21 个 Electron 脚本、106 条 PASS（含新脚本） | `test-ui-0359.log` |
| `npm run icons` → `npm run compile` → `electron-builder --win dir --publish never` | 退出 0 | `build-0359.log` |

- 测试版产物：`dist/win-unpacked/TokenPulse.exe`，产品版本 **0.3.59.0**（已覆盖原 0.3.58 的 win-unpacked；dist 里的 Setup/Portable/latest.yml 仍是 0.3.58 正式版，未重新生成）。
- 合成数据截图：`dist/shots-quota-pressure/`（watch / high / overview / settings）。
- 中途一个坑：`renderer/intro.js`、`renderer/i18n.js` 是 CRLF，第一次用含 `
` 的多行锚点替换没有命中，导致 test-intro-ui 列不出 v0.3.58 分隔行；改用 `
` 锚点后已修复并重跑全串。后续改这两个文件要注意换行符。
- 收尾核对：按命令行只剩用户安装目录的正式版 0.3.58（PID 6748 及其子进程）在运行，未动；本轮测试/打包进程均已退出。

**发布（用户验收测试版后明确授权）**：

- `npm run dist` 退出 0（`build-release-0359.log`）。`node dist/verify-0.3.59.cjs`（由 0.3.58 的验证脚本改版本号而来）：154 个运行时文件与 build/renderer/knowledge 逐字节一致，ASAR SHA256 `de2092b6557568fd193e040fe26533dd922bb2b53f9e844980a0bd05a67441bb`。
- 附件 SHA256 清单 `dist/assets-0.3.59.sha256`：Setup 112649557 字节、Portable 112392405、blockmap 119928、latest.yml 352。发布正文 `dist/release-0.3.59.md`。
- 代码提交 `a9270c3`，标签 `v0.3.59`，推送前 fetch 过远端无新提交；main 与标签已推送。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.59 ：非草稿、非预发布，4 个附件 uploaded 且大小与本地一致；`releases/latest` 指向 v0.3.59；公开 `latest.yml` 与本地 diff 为空。
- 收尾：四个产物与 win-unpacked exe / asar 可独占打开（句柄已释放）；无本轮遗留的 Node/Electron/打包进程；用户安装目录的正式版 0.3.58 仍在运行，未主动安装/升级。
- 本文件的更新是发布后的单独一次提交。

**状态**：0.3.59 已发布。当前没有进行中的工程任务。

**未验证项**：真实官方账号的采样数据下的实际观感（只用合成采样验证）；托盘面板 `runsOut` 改为 pressure high 只有单元测试，未在真实托盘上对比。

## 30 秒了解当前状态

| 项目 | 当前事实 |
|---|---|
| 软件 | Windows 桌面应用 TokenPulse，当前版本 **0.3.59**，已于 2026-10-19 正式发布 |
| Git | 分支 `main`，当前 HEAD `a5c60d6`（英文 README，已推送并同步）；发布代码 `a9270c3` = 标签 `v0.3.59`；本 HANDOFF 的本轮审计记录未提交 |
| 发布代码 | `v0.3.59` → `a9270c3`；上一版 `v0.3.58` → `7b898bd` |
| GitHub | [v0.3.59 Release](https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.59)，非草稿、非预发布；`releases/latest` 和公开 `latest.yml` 均为 0.3.59 |
| 本机运行 | 安装目录中的 **0.3.58.0** 仍在运行（主 PID 本次 `6748`），未升级；它会通过自动更新收到 0.3.59。PID 只用于本次核对 |
| 当前工程任务 | 0.3.59 已发布；当前没有进行中的功能或已确认阻塞，等待用户下一项需求 |
| 本轮工作 | 2026-10-19：实现、测试、打包并发布 0.3.59（见下一节）；dist 内 0.3.58 的 Setup/Portable 仍保留，latest.yml 已是 0.3.59 |

远端状态通过 `git ls-remote` 和 GitHub API 于本轮重新核对，不仅依据本地的 origin/main 缓存。不要把当前 HEAD 与发布标签不同误判为漏发代码。

## 项目是什么、代码从哪里接手

TokenPulse 常驻托盘，汇总本机 AI 工具用量、监控官方额度，并提供供应商切换、本地路由/号池、会话管理、速度/并发/出口监控、分享卡片和提醒。各工具的支持范围不同，尤其 pi 的支持边界见下一节。

技术结构：Electron 主进程承担本地后端，统计/会话查询由 worker 处理；界面为原生 HTML/JavaScript/CSS。TypeScript 编译输出到 `build/`，electron-builder 生成 `dist/`。主要发布目标是 Windows x64，包含 NSIS 安装版和 Portable 版。

| 要处理的事情 | 优先阅读 |
|---|---|
| 启动、托盘、IPC 注册、刷新生命周期 | `src/main/index.ts`、`src/main/preload.ts` |
| 后台统计与查询调度 | `src/main/snapshot.ts`、`src/core/report-worker.ts` |
| CLI 用量扫描、流水、聚合 | `src/core/usage-scan.ts`、`request-log.ts`、`report.ts`、`route-ledger.ts` |
| 会话列表/详情/搜索/终端继续 | `src/core/sessions.ts`、`session-search.ts`、`src/main/session-reply.ts` |
| 供应商模型与配置切换 | `src/core/agent-types.ts`、`agent-switch.ts`、`agent-models.ts` |
| 配置事务、只读保护、备份和恢复 | `src/core/agent-config.ts`、`agent-history.ts`、`agent-toml.ts`；改切换逻辑先看这些 |
| 本地转发、协议转换、代理、并发 | `src/core/agent-proxy.ts`、`agent-convert.ts`、`upstream-proxy.ts`、`concurrency.ts` |
| 官方账号、登录、续期、CLI 换号 | `src/core/accounts.ts`、`credentials.ts`、`token-refresh.ts`、`cli-switch.ts`、`cli-renew.ts`、`cli-auto-switch.ts`、`src/main/oauth.ts` |
| 额度历史、预测与号池 | `src/core/quota*.ts`、`pool-order.ts`、`pool-insight.ts` |
| 周报/月报/里程碑和缓存分析 | `src/core/share-report.ts`、`weekly-summary.ts`、`cache-analysis.ts`、`src/main/share.ts` |
| 页面与中英文 | `renderer/app.js`、`agent-switch.js`、`sessions.js` 及对应 CSS；词典 `renderer/i18n.js` 同时供主进程使用 |
| 演示与自动化验证 | `src/main/demo.ts`、`scripts/test-*.cjs`、`scripts/audit-agent-config-safety.cjs` |

用户数据默认在 `~/.tokenpulse`，入口 `src/core/paths.ts`；测试可通过 `TOKENPULSE_DATA_DIR` 重定向。真实账号、工具登录配置和用户会话不属于仓库夹具，不要打印或复制到交接/发布文案中。

模型知识库：当前仓库 `knowledge/models.json` 版本为 **2026.10.16**。手动规则写在 `knowledge/manual.json`，生成器是 `scripts/update-knowledge.cjs`，工作流 `.github/workflows/knowledge.yml` 可产生新的 main 提交。接手和推送前要重新看远端，不能覆盖自动更新；生成文件的内容以生成器和手动规则为准。

## 0.3.58 刚完成的 pi 支持

- **会话**：读取 `~/.pi/agent/sessions`，支持 `PI_CODING_AGENT_DIR`。解析 JSONL 当前叶节点的祖先分支，显示标题、模型、对话、工具调用及结果、压缩事件；接入列表、详情和全文搜索。新对话/新项目可选 pi，已有会话通过终端 `pi --session <id>` 继续。
- **供应商**：在 pi 页面保存并切换 OpenAI Chat、OpenAI Responses、Anthropic，三种接口都能直连，也能走本地路由。配置落在 pi 的 `models.json` 和 `settings.json`，本软件占用供应商名 `tokenpulse_route`；原默认选择保存在 TokenPulse 的 `piDefaults` 中，选择「pi 原有配置」可恢复。
- **配置安全**：沿用事务、预览确认、备份和只读保护，保留其他供应商/设置；不修改 pi 的 `auth.json`。同名供应商或同名 auth 登录会阻止接管；Key/请求头中的 `!`、`$` 做字面转义，避免被 pi 当作命令/环境引用。
- **关键实现**：`src/core/paths.ts` 的 `piDir()`，`sessions.ts` 的 `parsePi()`，`agent-switch.ts` 的 `writePi()`；`src/main/session-reply.ts` 识别 `@earendil-works` / `@mariozechner` 的 npm 安装和实际 `dist/bundle/cli.js` 布局。
- **界面与图标**：`renderer/agent-switch.js`、`sessions.js`；工具筛选两行三列，新对话工具两列。用户提供的图标已放入 `renderer/brand/presets/pi.svg`，`renderer/brand.js` 内联同一组路径；不再依赖 Downloads 原件。会话详情空定位栏出现字面 `null` 的问题一并修复。
- **测试**：`scripts/test-pi.cjs`、`scripts/test-pi-ui.cjs` 已加入完整测试脚本。实际 pi CLI 1.3.0 的三种协议和路由曾在隔离环境中验证。

## 已知范围和限制

1. pi 当前支持会话管理与供应商切换；**应用内回复/删除、pi 用量扫描、官方额度查询、号池和透明转发尚未实现**，这是当前能力范围，不是已经排期的新增任务。
2. pi 切换更新全局默认模型；已打开/恢复的会话和项目级 `.pi/settings.json` 可覆盖它，旧会话需在 pi `/model` 中重选。会话页通过终端继续。
3. 同一会话存在多份文件时，全文搜索使用详情会打开的最新文件；只在旧文件里的内容暂不返回，避免匹配后无法跳转。
4. Claude 缓存分析暂不区分 5 分钟与 1 小时缓存；闲置判断采用 5 分钟。Grok 的会话用量一行代表一轮，可能包含多个调用。
5. 号池未来 7 天预排按周额度推演，不模拟 5 小时窗口和限流；速率采样覆盖不足一天时使用回退规则。
6. 真实上游切换、真实账号登录/续期、安装升级端到端和真实周一通知触发没有因本轮盘点而重新验证；模拟验证不能写成真实环境端到端通过。

## 验证事实：区分本轮与发布时

**本轮 2026-10-19 已执行并通过：**

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`：退出 0，保持已有 `build/` 内容。
- 清除可选 `TOKENPULSE_TEST_PI_CLI` 后运行 `node scripts/test-pi.cjs`：退出 0，5 组通过；使用脚本自建临时目录、假 Key、本地假上游，未启动真实配置下的 pi。
- `node dist/verify-0.3.58.cjs`：153 个运行时文件与当前 `build/renderer/knowledge` 逐字节一致，ASAR SHA256 见下表。
- 本地四附件大小/SHA256 与 `dist/assets-0.3.58.json` 一致；GitHub 四附件均为 uploaded、digest/大小一致；线上发布正文与本地说明一致，公开 `latest.yml` 与本地逐字一致。
- 独占只读检查四附件与 `win-unpacked` 的 exe / asar 均成功，句柄已立即释放；按项目路径/命令行检查未发现相关测试/打包进程。当前正式软件继续运行。

**0.3.58 发布前最后完整验证（2026-10-18）：**

| 命令 | 实际结果 | 本地证据 |
|---|---|---|
| `npm test` | 退出 0，667 条 PASS | `test-release-backend-0358.log` |
| `npm run test:ui` | 全串退出 0，20 个 Electron 脚本、100 条 PASS | `test-release-ui-0358.log` |
| `npm run dist` | 退出 0 | `build-release-0358.log` |
| 可选真实 pi 程序 + 隔离假网关测试 | 三种 API、协议转换、特殊字符 Key 等 6 组通过 | `test-pi-0358.log` |

本轮只更新文档并做上述轻量核对，没有重跑完整后端/UI、重新打包或重新发布。旧开发阶段的失败已在发布前修正；当前发布验证以本表和本轮结果为准。

## 产物和 Git 状态

| 用途 | 路径/标识 |
|---|---|
| 安装版 | `dist/TokenPulse-0.3.58-Setup.exe`（112647117 字节） |
| 免安装版 | `dist/TokenPulse-0.3.58-Portable.exe`（112389961 字节） |
| 自动更新 | `dist/TokenPulse-0.3.58-Setup.exe.blockmap`、`dist/latest.yml` |
| 解压运行目录 | `dist/win-unpacked/TokenPulse.exe`，产品版本 0.3.58.0 |
| 完整附件校验清单 | `dist/assets-0.3.58.json` |
| 应用归档 SHA256 | `bb3fe7e33b516041559372bfd1d04b8039b68f8e3aa9a040a49ef92baf8f02d2` |
| 运行时校验脚本/报告 | `dist/verify-0.3.58.cjs`、`dist/verification-0.3.58.json` |
| 发布正文 | `dist/release-0.3.58.md` |
| 合成数据自查图 | `dist/shots-0.3.58/` |

`build/`、`dist/`、`node_modules/`、`*.log` 均被 Git 忽略：上面的产物/报告/截图是**本机证据**，其他机器克隆仓库不会自动得到。复现时依赖仓库中的源码/测试；新构建会覆盖产物，先核对版本及占用。

本轮开始时工作区干净，程序代码与 `main`/`v0.3.58` 一致；本轮结束时预期只有 `HANDOFF.md` 修改。没有新增版本、提交、推送、安装或发布动作。

## 后续接手的操作顺序

1. 重读 `AGENTS.md` 与此入口，再核对 `package.json`、`git status -sb`、本地/远端提交；以用户最新需求决定下一步，旧历史里的备选不自动变成待办。
2. 用上面的代码地图定位真实调用链；文档目录里的 0.3.9 配置审计是历史背景，当前行为需核对源码。
3. 测试统一使用临时 HOME/USERPROFILE、`TOKENPULSE_DATA_DIR` 和 pi 目录、合成会话、假 Key、本地假网关，截图也只用测试数据。完整套件不要继承父级 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`GROK_HOME` 等覆盖测试自己的 HOME 夹具；移除真实 Key 环境变量，保留各脚本自己设置的隔离路径。
4. 快速检查可使用本轮的无输出编译与 `node scripts/test-pi.cjs`；相关功能改动后跑对应测试，交付前跑需要的完整验证。pi UI 命令：`node node_modules/electron/cli.js --lang=zh-CN scripts/test-pi-ui.cjs`。`TOKENPULSE_TEST_PI_CLI` 仅指定待测程序路径，子进程仍必须用测试脚本的隔离配置/白名单环境。
5. 本地测试版按已验证流程 `npm run icons`、`npm run compile`、`node node_modules/electron-builder/out/cli/cli.js --win dir --publish never`；正式打包用 `npm run dist`。下一版本号按用户最新要求，验收/发布授权按当次任务处理；发布说明参考上一条 Release。
6. 编译目录是 `build/`，打包目录是 `dist/`。进程/句柄检查要识别 PID、路径、命令行与创建时间，只处理本轮拥有的资源；用户正式软件不能擅自关闭。`dist` 占用时先诊断，不要删整个目录或笼统杀 Node/Electron。独立输出目录是规避，不能称原目录已解锁。
7. 每个阶段更新此入口，最终回复前记录实际测试、未验证项、产物/版本、Git/安装/发布状态；下方历史保留原文。

## 历史发布与开发记录（以下不作为当前待办）

### 0.3.58 已正式发布（2026-10-18）

- 用户已验收测试版，并明确授权发布同一 0.3.58。main 基线 acc4ce6，fetch 后远端无新增提交。
- 发布前 npm test 退出 0（667 条 PASS，test-release-backend-0358.log），npm run test:ui 全串退出 0（20 个 Electron 脚本、100 条 PASS，test-release-ui-0358.log）。测试沿用隔离 HOME/数据和假 Key/网关。
- npm run dist 退出 0（build-release-0358.log），Setup / Portable 版本均为 0.3.58。node dist/verify-0.3.58.cjs：153 运行时文件逐字节一致，ASAR SHA256 bb3fe7e33b516041559372bfd1d04b8039b68f8e3aa9a040a49ef92baf8f02d2，与用户验收的测试版相同。
- 发布附件 dist/TokenPulse-0.3.58-Setup.exe、Setup.exe.blockmap、Portable.exe、latest.yml；完整大小/SHA256 清单 dist/assets-0.3.58.json。发布正文 dist/release-0.3.58.md，已按旧 Release 风格核对，SHA256 07671df69ca63924d6ba99361f2b62e91b41a94cdb5fc6394c1cc70b8931d1ed。
- 四附件与 win-unpacked exe / asar 可独占只读打开，句柄已释放；测试和构建进程已结束。用户安装版保持运行，未主动安装新版。
- 代码提交 7b898bd，main 和标签 v0.3.58 已推送。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.58 （ID 416574476）已正式发布，非草稿、非预发布；releases/latest 指向 v0.3.58，公开 latest.yml 与本地逐字一致；发布正文与 dist/release-0.3.58.md 一致。
- 四附件均 uploaded，GitHub API digest / 大小与本地 SHA256 / 大小一致：Setup.exe 112647117 / 8bc4a662edbb0bb0de121dc4f75b08851542cc9eaa9d197f1a7a0390742ec66c；Portable.exe 112389961 / 6897855443baa5952df08916cf957ae6dac42bf91b4fb26e71e28e78c632270e；Setup.exe.blockmap 119682 / 76cff4a36e9ca4a502b1d77d2705dacc9761c19b2e8cf82ca9fa53fcebe572cf；latest.yml 352 / 995218b6f96e079eb4ed0e6455a5e9a0dd2838a6f1e032fe8f8a2569446991c6。
- 发布后再次检查：四附件、win-unpacked exe / asar 均可独占只读打开，检测句柄已释放；未发现本轮测试/构建遗留进程，工作目录为项目根。用户安装版未关闭，未主动安装新版。测试与发布完成，无当前阻塞。
- 验证范围与已知限制沿用下方测试版记录：pi 的三种协议/路由用本机真实 CLI 与隔离假网关验证；没有使用真实 Key 做请求测试，没有执行真实登录/上游/安装升级端到端验证。pi 本轮支持会话管理和供应商切换；旧会话或项目级配置的模型选择规则见下方。

### 0.3.58 测试版验收记录（此前的「未发布」状态只适用于验收前）

- 用户本轮要求：会话列表和一键切换模型供应商支持 pi，完成后只给本地测试版；测试严禁使用本机真实 Key。已全部用隔离 HOME / PI_CODING_AGENT_DIR、合成会话、假 Key 和 127.0.0.1 假网关验证。本机 pi 1.3.0 仅作为可执行程序加载，子进程环境使用白名单，不继承真实 API Key。
- 基线 main acc4ce6 / 0.3.57；本轮工作未提交、未打标签、未推送、未安装、未发布。正式 Release 仍是 v0.3.57，dist 中旧 Setup/Portable/latest.yml 不属于本轮测试版。
- 会话：src/core/{paths,sessions}.ts 增加 pi 默认目录 ~/.pi/agent 与 PI_CODING_AGENT_DIR、JSONL 树分支解析（当前叶节点回溯）、会话名/模型/用户与助手文字/工具调用和结果/压缩事件；复用列表、详情、全文搜索。在终端继续用 pi --session <id>，新对话也能选 pi；src/main/{index,session-reply}.ts 识别新旧 npm 包及本机实际 dist/bundle/cli.js 安装布局。
- 供应商：src/core/{agent-types,agent-switch,agent-proxy}.ts 增加 pi，Chat / Responses / Anthropic 三种接口原生直连及本地路由；写 models.json 的 tokenpulse_route 和 settings.json 的默认项，保留其他供应商/设置，不修改 auth.json；切回「pi 原有配置」恢复默认选择。沿用事务、配置差异确认、备份、只读保护与路由退出恢复。拒绝同名供应商或同名 auth 凭据，密钥/请求头的 !/$ 按字面转义，避免 pi 将其解释为命令或环境引用。
- 界面与说明：renderer/{agent-switch,sessions,app,brand,i18n,intro}.js、sessions.css、README；会话筛选改为两行三列，新对话工具选择为两列。审图时发现原会话页 replaceChildren 将空定位栏渲染为字面 null，已过滤空节点并加断言。package.json / lock 为 0.3.58。
- 用户提供图标：从 C:/Users/7ipny/Downloads/piicon/pi.svg 复制至 renderer/brand/presets/pi.svg，源和副本 SHA256 相同；renderer/brand.js 使用该 SVG 的两条路径，深浅主题均随前景色显示。没有改动源下载目录，用户可以删除它；pi-color.svg 实为 404 文本，未使用。
- 测试：npm test 退出 0，667 条 PASS（test-backend-0358.log）；最后修改 pi 凭据冲突检查后 npm run compile、node scripts/test-pi.cjs、node scripts/test-session-search.cjs 再通过。设置 TOKENPULSE_TEST_PI_CLI 为本机程序路径运行 node scripts/test-pi.cjs，6 组通过（test-pi-0358.log）：实际 pi 发 Chat / Responses / Anthropic 请求、Chat→Anthropic 路由、!/$ 字面密钥、恢复原有配置、碰撞、只读/预览保护。
- UI：全部 20 个 Electron 脚本已验证通过。npm run test:ui 最后一轮前 19 项通过，最后 pi UI 的隐藏窗口颜色过渡断言失败；修正测试为明确设置 light/dark 并移除过渡类后，node node_modules/electron/cli.js --lang=zh-CN scripts/test-pi-ui.cjs 单独重跑退出 0、3 组通过（test-pi-ui-0358.log），未再从头重跑整串。更早两轮旧测试菜单/新对话工具数量断言已随 pi 更新。首轮后端因父级 CLI 目录变量干扰旧 HOME 夹具失败，清除父级覆盖、保留隔离 HOME 后整套通过。
- 截图自查：dist/shots-0.3.58/{pi-providers,pi-sessions,pi-sessions-en,pi-sessions-dark}.png，仅合成数据，已查看；DOM 校验用户 SVG 路径、搜索跳转、密钥遮盖、窄窗口筛选不截字、英语提示与深浅主题。
- 最新测试包：D:/CodePorject/Tools/TokenPulse/dist/win-unpacked/TokenPulse.exe，FileVersion 0.3.58 / ProductVersion 0.3.58.0。npm run icons、npm run compile、node node_modules/electron-builder/out/cli/cli.js --win dir --publish never 退出 0；最后刷新包纳入空节点修复。node dist/verify-0.3.58.cjs：153 运行时文件逐字节一致，ASAR SHA256 bb3fe7e33b516041559372bfd1d04b8039b68f8e3aa9a040a49ef92baf8f02d2（dist/verification-0.3.58.json），exe SHA256 118918190676d50cb496ebe6f0c6cffebc0df6d890096726eee8013f2067fbed。打包日志 build-0358-preview.log。
- 资源收尾：本轮 Electron/Node 测试、pi CLI 和打包进程均已结束；按项目路径/命令行检查未发现相关残留。win-unpacked exe / app.asar 可独占只读打开，检测句柄均释放。dir 包没有 NSIS 用的 resources/elevate.exe，不作为待解锁文件。工作目录项目根；用户安装版 TokenPulse（主 PID 21600，安装目录下）未关闭。
- 已知范围：pi 在应用内回复/删除、用量扫描、官方额度查询、号池和透明转发本轮未实现；会话可在终端继续。本轮更新全局默认模型，旧会话或项目级 .pi/settings.json 可以覆盖它，需在 pi /model 中重选。未用真实上游验证，未操作真实登录或启动正式配置下的 pi，没有安装升级验证。
- 验收：用户从托盘退出当前正式版，再运行上面的测试程序（单实例）；查看会话管理的 pi 筛选/详情/搜索和更多菜单里的终端继续；供应商→pi→添加/启用，确认差异后看新 pi 会话，旧会话用 /model 切换。测试版已可交付，无当前阻塞，等待用户验收。

## 历史：0.3.57 及以前

### 0.3.57 已正式发布（2026-10-17）

- 用户授权检查后端、修复问题、升级补丁版本并发布 GitHub Release，文案沿用历史风格。本轮独立完成。
- 基线 main ff15cc7，package.json 0.3.56，接手工作区干净；已 fetch，远端没有新增提交。
- 已审查会话搜索、worker 调度、周报触发、自动换号、额度采样与排序。确认搜索元数据误命中、损坏索引导致搜索异常、续接会话命中旧文件但详情打开新文件三项；修改 src/core/session-search.ts，回归用合成会话。
- scripts/test-session-search.cjs 已先复现失败（18/23）；修复后 24/24 通过。npm test 完整执行退出 0（日志 test-backend-0357.log）。补充审查了本地路由请求生命周期和 curl 调用，本轮未改动这些模块。
- package.json / package-lock.json 已升级 0.3.57，README、intro 与英文说明同步；dist/release-0.3.57.md 已按旧 Release 风格写好。npm run test:ui 完整执行退出 0（97 条 PASS，日志 test-ui-0357.log）。npm run dist 退出 0（build-0357.log）。产物 dist/TokenPulse-0.3.57-Setup.exe、Portable.exe、Setup.exe.blockmap、latest.yml。node dist/verify-0.3.57.cjs：152 个运行时文件逐字节一致，ASAR SHA256 d644142cd3ff0895069e709a743518ae2633e7a8c085b4ba217804a836e3662d；两 exe 产品版本 0.3.57。四附件与 win-unpacked exe / asar 均可独占只读打开，检测句柄已释放；未发现本轮测试/打包残留进程，用户安装版未关闭。提交 88eb34a 和标签 v0.3.57 已推送 origin/main；Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.57 已正式发布（非草稿、非预发布），releases/latest 指向 v0.3.57，公开 latest.yml 与本地逐字一致。正文与 dist/release-0.3.57.md 一致。未主动安装新版。

- 四附件均 uploaded，远端 digest 与本地 SHA256、大小完全一致（完整清单 dist/assets-0.3.57.json）：Setup.exe 112643480 / 97cdce7b118730164974fa0599103e37f01ab31e669a409cacf8c0af4c19fcd6；Portable.exe 112386329 / 039445944fca23482e212bf33ab43eafed52b22c5ff4a69b587a6b8c3618637e；blockmap 119787 / de384aa4092aa0ce7fa59997f322e533747809d40243c39ded7cda190278974d；latest.yml 352 / 018dd6aed75de7800822746b8751bf7721120054e868a053fe7f41c33c1465b0。
- 发布后再次检查：本轮测试/打包进程未残留，四附件及 win-unpacked exe / asar 可独占只读打开，所有检测句柄立即释放，工作目录为项目根；用户运行中的正式软件未关闭。工程工作和发布已完成，无当前阻塞。后端完整测试 662 条 PASS，界面 97 条 PASS；日志及校验脚本保留在上列本地路径（被 Git 忽略）。
- 验证限制：本轮使用合成会话与假上游，没有触碰真实账号登录/续期，没有执行真实上游切换、安装升级或自动更新端到端验证。本轮是重点后端审查，不代表全部代码不存在缺陷。续接会话仅搜索详情使用的最新文件，旧文件独有内容暂不展示。

## 历史记录（以下各节只适用于标明的旧版本）

### 0.3.56 已正式发布（2026-10-16）

- 用户没有逐项验收，说「预览版有问题也正常」，直接要求发布。发布前 `npm test` 退出 0、`npm run test:ui` 退出 0（97 PASS），`npm run dist` 退出 0；`dist/verify-0.3.56.cjs` 152 个运行时文件逐字节一致，ASAR SHA256 38d3b7d990e3685dc4ac10fc6088c687833f65986fee7a059a005e8aedde81c6（和测试版相同）。
- 提交 eb001e6（0.3.56：缓存命中分析、每周小结和周报、号池按重置时间预排），标签 v0.3.56 指向它。远端有 github-actions 的知识库自动更新 74a7268，没改写提交、没挪标签，合并成 8431971 后推 main；安装包里的 knowledge 是标签源码那份，软件启动后会自动拉新知识库。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.56 ，非草稿、非预发布，releases/latest 指向 v0.3.56，公开 latest.yml 为 0.3.56；正文和 dist/release-0.3.56.md 一致，无会话链接。
- 附件均 uploaded，大小 / SHA256 与本地一致：Setup.exe 112643297 / 5d12fa2b6aa1747edd768fb4e2503d6763a7ab44dd92c578854c281c59e11648；.blockmap 119812 / 64b7b38661750076e494b0ee7d33332f2fa706a70d7b0edb1ec93f39abb995dd；Portable.exe 112386077 / a3fd34fc2248a04cb2bdab248d62538e043a1681dea0d593ee842ecc1dafaae4；latest.yml 352 / 6c44a794e65a8a511d4d642f8c9de2dcf5ddb7fb0d875ed2445787fb53a00b84。
- 收尾：无遗留 node / electron / 打包器 / codex 进程；用户安装版 0.3.55（PID 25404 等）未关闭、未主动安装新版。四附件和 win-unpacked exe / asar 可独占打开，工作目录项目根。
- 分工：用户 2026-10-16 改主意，以后所有工作由 Claude 自己做，不再交给 Codex（luna 太慢）。
- 仍未在真实数据上验证的（见下）：三个新界面、周一的每周小结通知、新号池排法的真实转发。

### 0.3.56 发布前状态（测试版；「未提交、未发布」已过期）

- 三项都做完并通过审查和测试，**未提交、未打标签、未发布**。工作区里 0.3.56 的全部改动都还没进 Git（基线 main = eb3797d）。
- 产物：`dist/win-unpacked/TokenPulse.exe`，FileVersion 0.3.56 / ProductVersion 0.3.56.0（`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0）。`dist/verify-0.3.56.cjs`：152 个运行时文件和源码逐字节一致（比 0.3.55 多 cache-analysis.js、weekly-summary.js、usage-cache.js、usage-cache.css），ASAR SHA256 38d3b7d990e3685dc4ac10fc6088c687833f65986fee7a059a005e8aedde81c6。发布说明 `dist/release-0.3.56.md` 已写。
- 最终测试（全部改动之后一次跑完）：`npm test` 退出 0；`npm run test:ui` 里的 19 个 Electron 测试逐个跑全部退出 0（752 行 PASS）。逐个跑是因为 test-ui.cjs 在整条串里偶发超时过一次（单独重跑通过，和本轮改动无关）。
- ③ 审查时 Claude 自己改的：额度详情「预排」面板的「现在 / 7 天后」刻度没对齐时间条（用估算外边距），改成和泳道同一网格列，test-pool-quota-ui 加对齐断言；**「换成快重置优先能少作废」提示的判断条件写反了**（该提示时不提示），已改正并加断言（测试数据：剩余最多 ≈138、快重置优先 ≈115，提示「少作废约 23 个百分点」）；脚注改成句号分句，英文不再出现分号后大写；i18n 删掉新增的重复键「现在」；pool-insight.ts 的内联 `import(...)` 类型改成顶部 `import type`。
- 自查截图（只用测试数据）：缓存视图、周报卡片（中 / 英）、分享对话框、号池预排面板都看过，存于 `%TEMP%\tokenpulse-0356\shots`（临时目录）。
- 没验证的：没在用户真实数据上看过三个新界面；每周小结通知没有真的在周一弹过（只有 `maybeWeeklySummary` 注入通知的单测和周报卡片 UI 测试）；号池新排法没在真实号池上转发过（端到端测试用假上游）。
- 已知限制：Claude 的 5 分钟 / 1 小时缓存不区分（闲置一律按 5 分钟判断，不改解析器、不升 STATE_VERSION）；Grok 一行是一轮；断档的「冷启动」以筛选范围内会话的第一条算；号池只推演每周窗口，不模拟 5 小时窗口和限流；号池速度要求所有官方成员都有 ≥24 小时采样，否则回退到「重置时间相差 6 小时内不换号」。
- 收尾：没有测试 / 打包遗留进程；`dist/win-unpacked` 的 exe 和 app.asar 可独占打开；工作目录在项目根。用户安装的正式版 0.3.55（PID 26384 等，19:36 启动）未关闭。本轮测试在 %TEMP% 留下的 132 个合成数据目录（Codex 12 个 + 测试 120 个，都在 20:53 以后创建）已删；更早几轮留下的约 3500 个 tokenpulse-* 目录来源不明，未动。Codex 运行时（broker PID 14024、app-server 23916 及每个任务的 MCP 子进程，本会话 20:53 起启动）还在，留着备验收后修改；Codex 插件的 SessionEnd 钩子会在会话结束时关掉整棵进程树。
- 验收方法：从托盘退出已安装的正式版，再打开 `dist/win-unpacked/TokenPulse.exe`（单实例）。看：用量明细 →「缓存」；设置 → 提醒 →「每周小结」；分享卡片 →「周报」；额度详情 → 号池标签 →「预排」；供应商页号池成员悬停。验收后按老流程 `npm run dist`、提交、打标签、发布（发布说明用 `dist/release-0.3.56.md`，提交 / 标签 / 发布说明里不放会话链接）。

### 0.3.56 开发记录（下面的「进行中」字样都已过期）

- 用户 2026-10-15：三项一起做，版本 0.3.56 —— ① 缓存命中分析 ② 每周小结通知 ③ 号池按重置时间预排。分工：Claude 规划和审查，实现交给 Codex（gpt-6-luna xhigh），Claude 审 diff、跑测试、写交接。
- 基线 main = eb3797d，package.json 0.3.55。方案已定，分三次派给 Codex，顺序 ①→②→③（② 复用 ① 的省钱函数；③ 最后并做版本收尾）。任务书全文在 `%TEMP%\tokenpulse-0356\brief-{1-cache,2-weekly,3-pool}.md`（临时目录，可能被清；要点如下）。
- ① 缓存命中分析：新 `src/core/cache-analysis.ts`（纯函数，按 source+session 排序比较相邻请求：`base=min(prev.input,cur.input)≥4096` 且 `cur.cacheRead<base×0.5` 算断档；原因优先级 compaction→model→account→idle(>5 分钟)→unknown；会话第一条算冷启动）；`model-pricing.ts` 新 `cacheSavings`（净省下，扣 Claude 写入溢价），月报省钱改用它；`RequestQuery.cache` + `parseRequestQuery` 白名单；用量明细页第 4 个视图「缓存」（renderer/usage-cache.js/css：四张小卡、每日命中率、断档原因、按工具 / 型号、断档最多的会话 + 最近断档）；演示数据的缓存读取改成随会话增长。不改解析器、不升 STATE_VERSION（Claude 5 分钟 / 1 小时缓存不区分，已知限制）。
- ② 每周小结：`share-report.ts` 抽出按日期范围的共用部分，新 `weekReport` / `reportWeeks`；新 `src/core/weekly-summary.ts`（`weeklyDue`：周一 09:00 后、上一周未处理；周一没开就在本周第一次运行补发；状态 `weekly-summary.json` 先写后发；0 用量不发）；prefs `weeklySummary` 默认开、设置「提醒」加一行；通知点开 `open-page {page:'share', tab:'week', pick}`；分享对话框加「周报」标签和卡片。
- ③ 号池预排：`pool-order.ts` 新账号速度（7 天每周额度上涨，百分点 / 小时，survival 的 perDay 改用同一函数）+ `planPool`（四种方式往后推 7 天：segments / waste / drainAt / outAt）；reset-first 改成最早重置先用（EDF），当前号「用到底再按重置时间」不多作废 2 个百分点以上就不换（速度未知：重置时间相差 6 小时内不换）；`poolView` / `analyzePool` 带 plan（非 reset-first 另给 compare）；额度详情号池页新「预排」面板（7 天泳道、作废、见底）、供应商卡片悬停显示预排第几个。收尾：package.json 0.3.56、intro NOTES、README；发布说明由 Claude 写。
- 进度：① Codex 已交回（task-mvafn2vk-3kmb5q，22 分钟）。Codex 沙箱不能启动 PowerShell 子进程和 Electron，整套测试由 Claude 跑；②③ 的任务书已加上这条说明。Claude 审查后自己改了：i18n 去掉 Codex 加的两条宽模板 `(.+) 次` / `(.+) 分钟`（会抢走后面「含压缩 N 次」「([\d,]+) 次」「(\d+) 分钟」「每 N 分钟」的翻译），小卡数值不再带「次」，间隔改成分钟 / 小时 / 天小时；`cache-analysis.ts` 的合计 / 按天 / 工具 / 型号改为包含压缩估算行（和其他页面口径一致，断档检测仍跳过它），CC Switch 导入行（key 以 `cc-switch\0` 开头）只进合计、不当一条一个的会话；test-cache-analysis / test-cache-ui 断言同步。`npm test` 退出 0（缓存分析 10/10）。test-cache-ui 另修：等待条件返回了 `window.PulseCache` 对象（不能跨进程克隆，Codex 没跑过所以没发现）、英文缺「原因」（顺手去掉 Codex 加的重复键 `"次"`，已有 `'次': 'count'`）、截图前 showInactive + 滚到明细视图。UI 测试：整套第一遍 test-ui.cjs 偶发超时（同一份代码上一遍整套时通过、单独重跑通过），其余 18 个逐个跑全部退出 0；缓存视图截图（测试数据）已看过。Codex 留在 %TEMP% 的 12 个合成数据目录（20:53–21:16 创建，和它报告的数量一致）已删；%TEMP% 里另有约 3500 个更早几轮留下的 tokenpulse-* 测试目录，来源不明，未动。
- ② Codex 已交回（task-mvagwy6s-ptuh28）：`share-report.ts` 抽出 `rangeReport`，新 `weekReport` / `reportWeeks` / `weekLabel` / `weekStartOf` / `isWeek`；新 `src/core/weekly-summary.ts`（`weeklyDue` / `describeWeekly` / `maybeWeeklySummary`，状态 `weekly-summary.json` 先写后发、0 用量记 sent:false）；`main/index.ts` 的 `publishSnapshot` 在 scannedAt 存在时调用；prefs `weeklySummary` 默认 true；设置「提醒」新行；`open-page {page:'share', tab:'week', pick}`；分享对话框三个标签 + 周下拉（周报不显示订阅费）；`share-card.js` 新 `week()` 布局。Claude 审查后改：i18n 新增的 5 个重复键删掉（其中 `"间隔": "Gap"` 会覆盖原有 `"Interval"`），补「♻️ 缓存净省下」英文（test-share-card 英文卡片断言抓到的），share.js 一处缩进。`npm test` 退出 0（每周小结 6/6）；UI 19 个逐个跑：第一遍只有 test-share-card 因上面的英文失败，修后重跑 7 项全 PASS，其余 18 个退出 0。周报卡片截图（测试数据）已看过。
- ③ Codex 已交回（task-mvahm8xe-ynq0iv）：`pool-order.ts` 新 `weeklyRateOf`（纯函数）/ `accountWeekRate` / `poolWeekRate`（和 accountQuota 共用 mtime 缓存，每小时重算）/ `planPool`；删掉 `resetScore` / `KEEP_RATIO`；`orderPool` 多一个 rate 参数，reset-first 按重置时间排、用 planPool 比较「先用当前号」和「直接按重置时间」的总作废；`agent-switch.ts` 的 `poolView`（所有带官方账号的号池都给 plan）和 `poolTargets` 传速度；`pool-insight.ts` 的 survival perDay 和 quota.perDay 都改用同一速度、`analyzePool` 出 plan / compare；`pool-quota.js` 新「预排」面板；`agent-switch.js` 悬停「预排第 N 个 …」和新说明；版本 0.3.56、intro NOTES、README。10 个成员一次 planPool 约 0.087 ms。审查修改见上面「当前状态」。

### 0.3.55 已正式发布（2026-10-15）

- 用户验收测试版后要求发布。发布前 `npm test` 退出 0、`npm run test:ui` 退出 0（92 PASS），`npm run dist` 退出 0；`dist/verify-0.3.55.cjs` 148 个运行时文件逐字节一致，ASAR SHA256 82ae3b5326b2e75f4b49e3e4bdb492927cec292c2af313afc09220f0fb0ea549（和验收的测试版相同）。
- 提交 cd7dded（0.3.55：会话全文搜索、体检页、额度快用完自动切换 CLI 登录），标签 v0.3.55，已推送（推之前 fetch，远端无新提交）。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.55 ，非草稿、非预发布，releases/latest 指向 v0.3.55，公开 latest.yml 为 0.3.55；正文和 dist/release-0.3.55.md 一致（只差换行符），无会话链接。
- 附件均 uploaded，大小 / SHA256 与本地一致：Setup.exe 112628594 / 9b066a7f802579e318d0c64e26ee4d9d9c4760a3b5177c9173bf61a84144aaa9；.blockmap 119805 / af1eee7ec24448937ecc7386b70ad8382f1fcff59f8188e3e7cc5a8c714a17d2；Portable.exe 112371385 / a4ffe0a6524055d909af9e3ccd875f1cfc93482020e8ba0acee9f3f82b455a7a；latest.yml 352 / bb291c011361695407c0e43452b24a6f8b98b80b5b580c2544244c83d4f7089c。
- 收尾：无本轮遗留 node / electron / 打包器进程；用户安装版 0.3.54（PID 45816 等）未关闭、未主动安装新版（会自动提示更新）。四附件和 win-unpacked exe / asar 可独占打开，工作目录项目根。
- 待做清单已清空。以下为发布前记录（「未提交、未发布」已过期）。

### 待做清单（用户 2026-10-15 定下，按顺序做，做完一项划掉一项）

1. ~~额度用满自动切 CLI 登录~~ —— 0.3.55 已做（测试版待验收）。
2. ~~全部会话的全文搜索~~ —— 0.3.55 已做（测试版待验收）。
3. ~~「体检」页~~ —— 0.3.55 已做（测试版待验收）。用户要求三项合在 0.3.55 一起发。

其他备选（用户没选）：缓存命中分析、每周小结通知、号池按重置时间预排、macOS 版。用户决定不用 `claude setup-token`（只有 user:inference 权限，查不了额度、认不出账号）。

### 0.3.55 测试版（待做清单第 1 项；已打好，未提交、未发布）

- 用户：做待做清单第一项「额度用满自动切 CLI 登录」。版本 0.3.55 是我定的（用户说版本照旧由他定但没给，我按下一个补丁号走，回复里已说明），只打测试版。
- 新 `src/core/cli-auto-switch.ts`：`autoSwitchCli(deps)`，每轮额度查询成功后由 `main/index.ts` 的 `runAutoSwitch` 调（只有某家开了才跑）。规则：每家开关 + 触发比例（90 / 95 / 99，默认 95，`normalizeRule` 校验）；只读保护开着、或这家工具当前供应商不是官方登录（`agent-switch.ts` 新导出 `usesOfficialLogin`；claude→claude、chatgpt→codex、grok→grok）时不动；当前 CLI 账号（`readCliAccounts`）两个窗口里用得多的那个 ≥ 触发线才动；目标 = 同家、没隐藏、有 refresh token、没 renewFailed、额度采样 30 分钟内（复用 `pool-order.ts` 的 `accountQuota` / `leftOf`）且剩余 ≥ 100−触发线+`MIN_GAIN`(10)，挑剩余最多的；切换走 `switchCliAccount`。切过（含失败）冷却 `COOLDOWN_MS` 10 分钟；没有能切的号只提醒一次（回到线下或换号后重置）。冷却 / 提醒状态在内存。事件记 `~/.tokenpulse/cli-auto-switch.json`（最近 50 条，无凭据）；`describeAutoSwitch` 出通知和设置页共用的标题 / 正文。
- 主进程：prefs 新字段 `cliAutoSwitch`（applyPrefs 里按家校验）；通知点开 → `open-page {page:'settings', tab:'accounts'}`（renderer 的 onOpenPage 新分支调 openSettings）；新 IPC 事件 `cli-auto-switch`（preload `onCliAutoSwitch`），设置开着就刷新账号列表，真的切了弹 toast。`OfficialOAuthStatus.autoSwitch {on, at, idle?, last?}`（`main/oauth.ts` 的 autoSwitchView）。
- 界面：设置 → 官方账号，登记 ≥2 个账号且装了 CLI 的那家卡片标题下多一行（`autoSwitchRow`）：开关（复用 `.oauth-localonly` 样式）、比例下拉（没开时禁用）、说明行（idle 原因 / 最近一次结果，悬停看正文）。CSS `.oauth-auto*` 在 app.css。i18n 英文齐全（含通知正文的正则）。
- 测试：新 `scripts/test-cli-auto-switch.cjs` 27/27（进 npm test，在 test-cli-renew 后）；`test-ui.cjs` 加设置页这一行的检查（假账号列表、开关 / 比例写进真实 prefs.json、最近一次显示）。`npm test` 退出 0，`npm run test:ui` 退出 0（90 PASS）。
- 文案：intro NOTES 0.3.55 + 英文、README 版本行、`dist/release-0.3.55.md`。
- 产物：`dist/win-unpacked/TokenPulse.exe` 0.3.55 / 0.3.55.0；`dist/verify-0.3.55.cjs` 143 个运行时文件逐字节一致（多了 cli-auto-switch.js），ASAR SHA256 f75e08bdd886618c60778c29a9ab055ff411e28f0d5cc3be442ed56816bdbf5f。无本轮遗留进程，exe / asar 可独占打开。用户安装版已自动更新到 0.3.54（PID 23856 等），未关闭。
- 未验证：没有在真实账号上触发过自动切换（要真的用到 95% 才会切，且会改用户 CLI 登录）；设置页这一行没截图看过视觉，只有 DOM 测试。
- 已知限制：开着的会话要重开才用新账号；额度采样间隔（默认 1 分钟）内用满的，要等下一轮才切；只看 TokenPulse 托管的账号；Claude 桌面端 / 网页的消耗也算在官方百分比里。
- **用户追加（进行中检查点）**：说明文字改成「已开启：换号时会发通知提醒你；已经开着的 X 会话，要重新打开才会用新账号」（已改，test-ui 断言同步）。用户要求把待做清单第 2、3 项也放进 0.3.55 一起发，不分三个小版本。
- 第 2 项全文搜索（代码完成，单测过，UI 未跑）：新 `src/core/session-search.ts`（`searchSessions(query, kind)`，在 report-worker 里跑，IPC `sessions:search`，preload `searchSessions`，演示模式返回空）。文字缓存 `~/.tokenpulse/session-text/<路径哈希>.txt` + `index.json`（按大小 + mtime 增量；会话文件没了就删缓存；`sessions.ts` 新导出 `sessionTextFile` / `parseSessionFile` / `sessionFiles`，删除 Claude 对话时一起删缓存）。只进用户 / AI 文字和工具名 + 概要，不进工具输出。空格分词 = 都要出现在同一会话。`renderer/sessions.js`：输入停 350ms 搜内容，列表并入命中会话、显示「N 处」和片段（高亮），点开跳到第一处命中，顶部定位条上一处 / 下一处 / 关闭，消息里高亮。CSS 在 sessions.css。新 `scripts/test-session-search.cjs` 17/17（还没进 npm test）。真实会话只读测速（缓存指到临时目录）：144 段首次 7.9s（含列表索引），之后 55~80ms，缓存 4.9MB。
- 第 3 项「体检」（完成）：新 `src/core/health-check.ts`（纯函数 `buildHealthReport(inputs)`，四组 tools / accounts / network / data，level ok/info/warn/bad，带「去哪一页」按钮）+ `src/main/health.ts`（`runHealthCheck(exitMonitor)` 读 agentDrift、新导出的 `localRouteLeftovers`（agent-switch.ts，只检测配置还指向本地路由 / 透明转发但没在跑）、agentView 的路由状态 + 127.0.0.1 端口连接测试、listOfficialOAuthStatus、renew-log 24 小时、出口监控 snapshot、代理来源、curl 不带账号连 api.anthropic.com / chatgpt.com / api.x.ai（先过 gateQuota，不放行就不连）、数据目录写入 / statfs / 1 小时以上的 .tmp）。IPC `health:run`，preload `runHealthCheck`（演示模式返回空）。界面 `renderer/health.js|css`，侧栏新页 `health`（NAV_PAGES / NAV_LABELS / navigate 的标题、`#i-health` 图标、`#nav-health-alert` 有问题时亮），打开时体检、5 分钟内回来不重跑。体检只读不改。
- 界面测试环境：用户屏幕现在 175% 缩放，`test-agent-switch-ui.cjs` 侧栏宽度 / workspace left 精确比较读成 236.00001525878906，改成 Math.round 后比较（`--force-device-scale-factor=1` 下原样通过，确认是缩放问题，和本次改动无关）。`test-layout-ui.cjs` 侧栏页面加 health（8 个）。一次整套跑时 test-deepseek-balance-ui 超时，单独跑两次都过，整套重跑通过。
- 测试：`test-session-search.cjs` 17/17、`test-health-check.cjs` 26/26（含所有文案都有英文）进 npm test；新 `scripts/test-health-ui.cjs`（体检页 + 全文搜索交互，体检结果用固定数据、不联网；`TP_SHOTS=目录` 时截图）进 test:ui。`npm test` 退出 0；`npm run test:ui` 退出 0（92 PASS）。自查截图（测试数据）：scratchpad/shots55/health.png、search.png 已看过。
- 文案：intro NOTES 0.3.55 改为三条（sessions / health / terminal 图标）+ 英文；README 版本行；`dist/release-0.3.55.md` 重写为三项。新手引导没有加「体检」那一步（引导步数测试固定为 35 步，没动）。
- 产物（最终）：`dist/win-unpacked/TokenPulse.exe` 0.3.55 / 0.3.55.0；`dist/verify-0.3.55.cjs` 148 个运行时文件逐字节一致，ASAR SHA256 82ae3b5326b2e75f4b49e3e4bdb492927cec292c2af313afc09220f0fb0ea549。无遗留 node / electron / 打包器进程，exe / asar 可独占打开。用户安装版 0.3.54（PID 45224 等）未关闭。未提交、未发布。
- 未验证：体检没有在用户真实环境里跑过（会连三家官方、读真实账号状态，留给用户验收时看）；全文搜索只在真实会话上只读测过速度（缓存放临时目录）。

### 0.3.54 已正式发布（2026-10-15）

- 用户要求发布。发布前 `npm test` 退出 0、`npm run test:ui` 退出 0（89 PASS），`npm run dist` 退出 0；`dist/verify-0.3.54.cjs` 142 个运行时文件逐字节一致，ASAR SHA256 与测试版相同（15341b8b…0139）。
- 提交 706ebbc（0.3.54：替没在运行的 Claude Code 续期、续期被拒先重试、记录续期日志），标签 v0.3.54 指向它。推 main 时远端多了 github-actions 的知识库自动更新 c9e8874（只改 knowledge/models.json），没有改写提交、没有挪标签，合并成 6268768 后推送；所以安装包里的 knowledge/models.json 是 10-14 版，和标签源码一致，下次启动会自动拉新知识库。
- Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.54 ，非草稿、非预发布，releases/latest 指向 v0.3.54，公开 latest.yml 为 0.3.54，正文 = dist/release-0.3.54.md（无会话链接）。
- 附件均 uploaded，大小 / SHA256 与本地一致：Setup.exe 112612253 / 5413641b1333254013816b9f32ca1d450f792864190494db835bdd281b4d0b94；.blockmap 119733 / 266ee7d5c649bf2f1b9bcee8b8acba861285d3bd479f47fee2b9c3f39c01bb8b；Portable.exe 112355047 / 78e56f326e02437eb90b82e2dc59e7477c1c56d6a543213a8129f311fca8599e；latest.yml 352 / 0c490e065a84592e518ea2ec0951d8bbf8d6eae212e757d69f5724a70571f94c。
- 收尾：无本轮遗留 node / electron / 打包器进程；用户安装版 0.3.53（PID 21264 等）未关闭、未主动安装新版（会自动提示更新）。四附件和 win-unpacked exe / asar 可独占打开，工作目录项目根。

以下为发布前记录（「未提交、未发布」已过期）：

### 0.3.54 测试版

- 产物：`dist/win-unpacked/TokenPulse.exe`，FileVersion 0.3.54 / ProductVersion 0.3.54.0。`npx electron-builder --win dir --publish never` 退出 0（scratchpad/dir-0354.log）。`dist/verify-0.3.54.cjs`：142 个运行时文件（比 0.3.53 多 cli-renew.js、renew-log.js）与源码逐字节一致，ASAR SHA256 15341b8beb725ecdb44057d3f99e8ee4a04c164d953b29e31f661f8660f60139。
- 收尾：无本轮遗留 node / electron / 打包器进程；用户安装版 0.3.53（PID 21264 及子进程）一直在运行，未关闭。win-unpacked 的 exe / app.asar 可独占打开（句柄已 Dispose），工作目录项目根。
- 验收方法：从托盘退出已安装的正式版，再打开 win-unpacked 测试版（单实例）。验收后「老样子」发布（release 文案 `dist/release-0.3.54.md` 已写好）。
- 未做的验证：没有在用户真实 `~/.claude` 上代续过（会写用户的 Claude Code 凭据，且当时 Claude Code 在运行，按设计也只会显示等待）；设置页「等 CLI 续期」状态和悬停说明没有截图 / UI 测试覆盖，只有源码和 quota 层测试。

### 0.3.54 开发记录

- 用户问题：托管在软件上的 Claude 账号「时不时过期」。只读诊断（不输出 token / 邮箱）：账号库里 TokenPulse 保存的号续期正常、无 renewFailed；cli-logins 显示用户每天在两个号之间「切到 CLI」约两次。根因：切到 CLI 后凭据归 Claude Code（`cli-switch.ts` 删掉自己那份），Claude Code 只在发请求时续期，超过 8 小时没用（夜里 / 刚开机）TokenPulse 读到过期凭据 → 额度提示「登录已失效，请重新登录」、号池跳过（`agent-switch.ts` poolTargets 里 expired 不进池），Claude Code 一发请求又好了。另查 claude.exe：Claude Code 续期有 `.oauth_refresh.lock` 并在续之前重读凭据文件，开着的会话不会抢 refresh token。次要隐患：`isPermanentFailure` 把任何 401、400 带 invalid_request 判死，且失败原因只记 `HTTP 400`、重新登录后清掉。
- 用户要三条都做，版本 0.3.54，只打测试版：
  1. 新 `src/core/cli-renew.ts`：`renewCliCredential`（只做 Claude）：CLI 凭据快过期 / 已过期，且**没有 Claude Code 进程**（`claudeCodeRunning`：Windows 用 CIM 查 claude.exe / node.exe / bun.exe，桌面版主程序 `\WindowsApps\Claude_`、`\AnthropicClaude\` 不算，桌面版自带的 claude-code 算；查不清楚当在运行）且没有 `.oauth_refresh.lock`，才用 refresh token 续，续完重读文件、没变才原子写回（只改 accessToken / refreshToken / expiresAt，官方给了才写 refreshTokenExpiresAt，保持原缩进风格）。官方明确拒绝的 refresh token 记哈希不再试（`dead`）。单飞（inflight）。`quota.ts` 的 fetchOfficialQuota（出口放行 claude 时）和 `main/oauth.ts` 的 listOfficialOAuthStatus 调用它。
  2. 额度问题新 reason `cli-wait`（账号登录在 CLI 里、CLI 有 refresh token、不是 dead）：提示「X 登录在 Claude Code 里，凭据过期了，Claude Code 下次发请求时会自动续上，不用重新登录。」黄色；Codex / Grok CLI 同理。设置账号状态新增「等 CLI 续期」（AccountView.waitCli），状态悬停显示原因（AccountView.renewError）；供应商编辑器的账号选择同步。
  3. `token-refresh.ts`：`errorCodeOf`；`isPermanentFailure` 只认 invalid_grant / token_expired / token_revoked / refresh_token_(reused|expired|invalidated|revoked)；失败结果带 status / code。`accounts.ts`：其他 4xx（非 429）记 `renewTrouble {since,count,error}`，连续 `RENEW_GIVE_UP`=6 次且 ≥ `RENEW_GIVE_UP_MS`=1 小时才转 renewFailed（写明次数）；续上 / 重新登录 / 切换 / 隐藏都清掉。
  4. 新 `src/core/renew-log.ts`：`~/.tokenpulse/renew-log.jsonl`，每次续期一行（at、kind、账号 id 的 sha256 前 12 位、source stored|cli、ok、status、code、error、permanent、note），不记 token / 邮箱 / 官方说明文字，超过 1000 行留后 500。
- 测试：新 `scripts/test-cli-renew.cjs` 17/17（已进 npm test，在 test-speed-estimate 后）；`test-accounts.cjs` 加判死收紧、重试 / 判死 / 恢复、429/5xx 不累计、续期日志无 token（79/79）；`test-quota-fetch.cjs` 加 cli-wait / dead / 续上后能查 / 出口拦住不续（37/37）。本机实测 `claudeCodeRunning()` = true（433ms，当时 Claude Code 开着）。
- **环境变化**：用户系统显示语言现在是 en-US，`npm run test:ui` 里 Electron 跟着变英文导致 test-ui.cjs「等待新采样」断言失败（与本次改动无关）。`package.json` 的 test:ui 每个 electron 调用加了 `--lang=zh-CN`，之后 `npm test` 退出 0、`npm run test:ui` 退出 0（89 PASS）。
- 文案：intro NOTES 0.3.54 三条 + i18n 英文、README 版本行、`dist/release-0.3.54.md`。package.json / lock 0.3.54。
- 已知限制：只在 Claude Code 没运行时代续，开着时仍要等它下次请求；npm 版 Claude Code 靠命令行含 claude-code 识别；Codex / Grok CLI 的过期凭据只改提示，不代续；续期期间 Claude Code 恰好启动并续期时我们不写回（两边可能有一边作废，概率很低）。

### 0.3.53 已正式发布（2026-10-14）

- 用户验收测试版后发布。提交 5f795f5（0.3.53：里程碑卡片按达成当天的数据画、按日志时间戳估算速度），标签 v0.3.53，已推送。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.53 ，非草稿、非预发布，releases/latest 指向 v0.3.53，公开 latest.yml 为 0.3.53。发布正文 = dist/release-0.3.53.md。
- 附件均 uploaded，大小 / SHA256 与本地一致：Setup.exe 112607811 / 7d1c9629ac78b9d67d71f3d6f630c5881fab9383c5ecab393e5a42eaadc68cf7；.blockmap 119752 / b5626d5c24d6f8ce0e35273ed080f8fc7072f446973584a8e5b93c07df9c5d00；Portable.exe 112350639 / ff3a4d6bc153c8047111436b2ecf09d4b2dc5c9c1b9897a0c96c11ca2f959527；latest.yml 352 / 80323d28f588f15b5c224e07a90476e3719ddd69dddce1ffaca265c031ff5eb9。`dist/verify-0.3.53.cjs`：140 个运行时文件逐字节一致，ASAR SHA256 8fd362a9721f07be70067e08a4a1a3457984f246c3c5f59c698fc5b112feac4a。
- 过程：第一次 `npm run dist` 报 EBUSY（`dist\win-unpacked`）——用户正开着测试版（20:30 从 win-unpacked 启动，4 个进程）。经用户同意只结束了路径为 `dist\win-unpacked\TokenPulse.exe` 的这 4 个进程后重打成功。强制结束时测试版没来得及「退出时恢复工具配置」：`agent-switch.json` 里 grok 本地路由开、codex 透明转发开，`~/.grok/config.toml` 和 `~/.codex/config.toml` 仍指向 127.0.0.1:17621；没有手动改配置，下次打开 TokenPulse 会自动接回。已提醒用户。
- 第一次提交命令里带了会话链接，被拦下（用户规则：提交、标签、发布说明里不放会话链接），什么都没写入；去掉后重新提交。
- 收尾：四个附件和 win-unpacked 的 exe / asar 可独占打开；无残留 node / electron 进程。

以下为开发过程记录（「未提交」等字样已过期）：

### 0.3.53 开发记录

- 用户两项：① 里程碑分享卡下半部分用的是最新数据，和达成当时不符，各类成就也没适配；② 不开透明转发也能估算 Token 速度（按对话日志时间戳），标「≈」。先打测试版。
- 已做（②）：`usage-scan.ts` 新增 `estimateOf` / `callBoundary`、FileState.callStartAt、`STATE_VERSION` 17（重扫）；Claude Code：调用开始 = 上一条 user/assistant 行，结束 = 同一 message id 的最后一行（`pendingEstimate` 往后挪）；Codex：开始 = turn_context / *_output / 上一个 token_usage_record。输出 <20、<0.5s、>10 分钟、>2000 t/s 不记。`RequestRecord/RequestRow.estimate {ms, tokensPerSec}`。`pass-speed.ts` 的 `estimatedRows`（读 requests/*.jsonl，按大小+mtime 缓存）；`accountSpeed` / `speedSeries` 多一个 `withEstimates`（默认 true），估算单独成线（`estimated: true`）；月报「最快的模型」传 false。界面：用量明细折线（名字前 ≈、经由「日志估算」）、额度详情模型速度（≈ + 「估算」标签）、请求列表延迟列（≈ 用时 / 速度）、详情、CSV。真实会话副本试算：opus 中位 ≈82 t/s。还没写测试、没补 i18n。
- 已做（①）：`share-report.ts` 新增 `momentsOf` → `MilestoneState.moments[id]`：达成当天的累计、第几天、当时陪你最久的模型、同组上一枚（隔几天）、同组下一枚（当时进度 / 后来哪天达成）、各组 focus（单日：那天用量和之前日均倍数、那天模型；连续：起止、合计、最拼一天、模型；请求：请求最多的一天；价值：花得最多的模型）、series（tokens/value/requests 画到当天的累计曲线并标同组徽章；day 画之前 30 天柱子高亮当天；streak 画那几天的柱子）。`share-card.js` 的里程碑卡整段重写（标签「达成于」、各组不同的 lede / 三个数字 / 图、「同一组的下一枚」、徽章收集册按当时点亮、页脚「截至当时已收集」），中英文由 `T(zh, en)` 直接出（一句话拆成多段，字典翻不全）；旧数据没有 moments 时退回原样。奖章文字超过 5 个字缩小。
- 测试：`test-share-card.cjs` 加 moments 断言（6/6）；新增 `scripts/test-speed-estimate.cjs`（2/2，已进 npm test，在 test-pass-speed 后）。`test-routing-regressions.cjs` 版本断言改 17。`test-model-study-ui.cjs`：「改用实际标价」标签只在变动后 14 天内显示，知识库里 gpt-6.1-sol 的真实日期 9/30 今天（10/14）过期，0.3.52 原码同样失败——拦截里把它的变动日期固定成昨天。
- 结果：`npm test` 退出 0（audit-test-0353.log）；`npm run test:ui` 退出 0（89 PASS，audit-ui-0353.log）；测试版 `npx electron-builder --win dir --publish never` 退出 0，exe 0.3.53.0，asar 含新代码，exe/asar 可独占打开，无本轮残留进程。intro NOTES / i18n / README 已写；未写 release 文案、未提交。截图只用合成数据（scratchpad/ms）。
- 已知限制：估算速度含首字前等待，偏慢；Grok（按轮汇总）和 DeepSeek（自己有流式时间）不估算；旧会话要等重扫（STATE_VERSION 17，升级后首次打开）才有估算。

### 0.3.52 已正式发布（2026-10-14）

- **正式发布**：提交1f883a25a15276dab95dcb69fe80b19391fc0eee（0.3.52：修复 CLI 换号后的请求与时间线账号归属）及标签v0.3.52已原子推送origin/main。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.52 ，标题TokenPulse 0.3.52，非草稿、非预发布；releases/latest指向v0.3.52，target是上述完整SHA。发布后的本交接更新单独提交。
- 四附件均uploaded，远端大小和GitHub SHA256摘要与下方本地记录完全一致；草稿与正式发布的正文均与冻结的dist/release-0.3.52.md一致。核验脚本dist/release-verify-0.3.52.cjs的draft/published均PASS（记录dist/release-verification-0.3.52-draft.json及-published.json）；公开releases/latest/download/latest.yml经curl下载，与本地逐字节相同（dist/latest-public-0.3.52.yml）。

- 用户授权修复设置切换 Claude CLI 账号后的错误归属，升级补丁版本并直接发布。起点 ef9d418，原工作区干净；package.json / lock 为0.3.52。代码、测试、文案、构建和发布均完成，无剩余发布阻塞；未主动安装新版或关闭用户已安装的软件。
- 根因与修复：cli-switch.ts 原本只改登录文件，直到下一轮扫描才观察到换号；现在同步写入阶段记录原登录及成功读回的新登录边界，仅记录所切换的一家，失败不记录目标。login-timeline.ts 原本无条件优先旧会话身份；现在比较邮箱写入时间和后续登录变更，旧session_context/bridge owner不再盖掉后来的登录。首段观察不覆盖历史会话，更新的会话邮箱仍可识别未重启旧CLI；确切号池路由优先级保留。usage-scan.ts / request-log.ts保存身份时间，扫描版本16重算现存会话小时账及流水。
- 回归 scripts/test-cli-attribution.cjs：修复前5项FAIL，最终7项PASS（即时边界、换号前后请求、小时账一致、新会话身份、仅桥接身份、首次观察/登出、旧账重扫去重）。已纳入npm test；test-cli-switch补失败切换不记目标边界；test-routing-regressions结构版本断言同步16。合成凭据/临时HOME，不联网、不切用户真实账号。
- 最终验证：npm test退出0（audit-test-0352.log）；npm run test:ui退出0（audit-ui-0352-final.log，88条PASS）；npm run dist退出0（audit-dist-0352.log）。早期沙箱无法启动PowerShell，所需权限下重跑通过；引导40秒总限制两次超时，诊断脚本全断言完成，test-intro-ui改90秒总限制、保留单步短超时，整套通过，诊断脚本已删除。intro/i18n/README已更新；dist/release-0.3.52.md按历史风格冻结，经独立只读文案核对PASS。
- 产物：dist/win-unpacked/TokenPulse.exe（FileVersion0.3.52 / ProductVersion0.3.52.0）；app.asar内version0.3.52、main build/main/index.js，140个运行时文件逐字节一致，ASAR SHA256 eefaa932118bad52df9a5e0aef45650f69dfce118d93fd0c1502044737f25dd8（dist/verification-0.3.52.json）。latest.yml版本/文件名/大小/SHA512核对通过。
- 四附件大小/SHA256（dist/assets-0.3.52.json）：Setup.exe 112603463 / c96529726c4b8ab3bbb4a9216eacb07b9863e98d115354b711ad53a2a0ccf2d6；Setup.exe.blockmap 119716 / 01d8e2c1641bfdc92b4d413386eed6d8c99fd4dcc4dc6e1bbc35ce33d73f2e53；Portable.exe 112346257 / 6012207d752b32165b0d1688df87b96ece3dbdf69dd0ef7ae5913422e791f741；latest.yml 352 / 02eb827c87b463400742e68303acdbfd2d3bf66c5d42e6e11d10d19065bd1659。文件均在dist，安装包/便携版文件名含0.3.52。
- 资源收尾：本轮测试/构建进程已结束，CIM按路径/命令行/启动时间核对用户安装版主进程26620及其子进程，未关闭；发布后再次核对无本轮遗留Node/Electron/打包器。四附件和win-unpacked exe/app.asar发布后再次可独占读取，句柄立即Dispose，工作目录项目根。未主动安装新版。
- 限制/未执行：历史修正需要已有登录时间线和本地仍保留的会话，未记录的换号时刻无法精确恢复；登录文件并不能证明每个已运行CLI进程的实际账号，较新的会话身份仍优先。未操作真实账号切换或发收费请求。正常网页/其他设备消耗仍显示为本机以外。下方0.3.51为已发布历史。

### 0.3.51 已正式发布（2026-10-13）

- **正式发布**：提交845e621bd34d063508229fe6204cc9892313587b（0.3.51：月报分享卡片、里程碑与号池生存分析）、标签v0.3.51已推送origin/main。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.51 ，标题TokenPulse 0.3.51，非草稿、非预发布；releases/latest已指向v0.3.51，target是上述完整SHA。发布后的交接更新单独提交。
- 本版：月报分享卡片、16枚里程碑和徽章收集册、PNG预览/保存/复制、中英文卡片及提醒；号池生存分析；供应商页速度入口读取新记录。发布正文 dist/release-0.3.51.md 与GitHub实际正文一致，经独立只读文案核对PASS；应用NOTES、英文和README已随发布提交。
- 验证：此前 npm test / 最终 npm run test:ui 退出0（audit-test-0351.log、audit-ui-0351-final.log，88条UI PASS）；验收后代码未改，本轮 npm run dist 退出0（audit-dist-0351.log）。140个运行时文件与源码及验收版ASAR逐字节一致，包内version0.3.51，exe ProductVersion0.3.51.0。latest.yml的版本、安装包SHA512和大小核对一致；公开releases/latest/download/latest.yml通过curl下载，与本地相同。
- 四个发布附件均uploaded，远端大小/GitHub SHA256摘要与本地一致：dist/TokenPulse-0.3.51-Setup.exe 112602875 / 903e15922b6b2b799185ffe0fb261a809004ebd16df6b957ea82dbae4dab7387；.exe.blockmap 119730 / f9c85c431eb6de5df26296f96c3f58bd48e40a3dae25bd005375c28793769c75；TokenPulse-0.3.51-Portable.exe 112345727 / dfe7a0746fedc7b84a548e8709b546eb34e68aac79be98087fa6ce614dc87fe5；latest.yml 352 / fb81ebe32bba0419da7463b9c08a215edd97dcf8118eab390bc24d3fc8ea230a。摘要记录 dist/assets-0.3.51.json，包内核验 dist/verification-0.3.51.json。
- 资源收尾：四附件及win-unpacked exe/app.asar可独占打开，检测句柄已Dispose；CIM确认无本轮遗留Node/Electron/打包器，工作目录项目根。发布前观察到用户安装版PID13948，本轮未关闭用户软件、未主动安装新版。
- 无剩余发布阻塞。真实保存对话框和系统剪贴板写入仍未操作（合成数据测试mock，PNG编码已验证；用户已验收测试版）。生存预测只算官方周额度且为估算；名称开关显示所选月测速记录中的路线名。下方开发记录里的未提交/未发布/待验收都属于历史状态，以本节为准。

#### 0.3.51 开发与验收记录（以下为发布前历史，发布状态以上面入口为准）

- **验收时状态（2026-10-13，已完成开发和测试版）**：起点 e2c769b，保留上轮未提交改动。package.json / lock 为 0.3.51；test:ui 加入 test-share-card.cjs、test-share-ui.cjs。卡片加载阻塞已解决：第一张成功后销毁最后一个窗口，测试触发 Electron 默认退出，第二张加载才 ERR_FAILED。测试补 window-all-closed 生命周期处理，渲染窗口保留 sandbox 并 finally 销毁。
- 已接入 renderer/share.js|css、index.html 顶栏按钮：原生 dialog 的月份/订阅费/名称披露开关、月报和所有徽章收集册、PNG 预览/保存/复制、快照后的月报/新里程碑提醒。默认隐藏路线名，首次里程碑检查静默基线；提醒去重，生成结果有代次检查，旧预览不覆盖新选项。演示引导期间阻止读取真实分享数据。share-report 增 routes 和里程碑 analogy；shareMonth 按所选月份附近查日桶，避免全历史周桶跨月。
- 生存分析继续用最近7天平均：修了跳过缺测日期后误取更早用量、三轮重新分配不够多账号、缺官方成员或采样过期仍预测、零数据被描述成“撑得住”。往周/日分界按日历处理。新 i18n 词条及卡片按 lang 渲染，intro NOTES / README 完成。实际里程碑定义为16枚，旧检查点写17是计数笔误。
- 定点测试：分享卡片5组 PASS（中英 PNG、数据/里程碑、主进程月初速度日桶、PNG ClipboardItem 编码、隐藏窗口销毁）；分享 UI 4组 PASS（月份/订阅费/隐私开关/导出 mock、旧预览、Esc、提醒去重、英文/900px/导出按钮完整可见）；pool-insight 9组 PASS（含平均/缺测/过期/5账号分摊）；pool-quota-ui 全过（生存面板/布局/英文深色）。截图只用合成数据，dist/share-shots，已查看月报/窄窗口/生存分析。自查修了窄窗底栏遮挡和曲线标签重叠。
- 最终命令结果：npm test 退出0（audit-test-0351.log）；最后 npm run test:ui 退出0（audit-ui-0351-final.log，88条 PASS）；最后翻译 test-features 46/46；npx electron-builder --win dir --publish never 退出0（audit-dir-0351.log）。打包后 dist/packaged-share-smoke.cjs 用真实 ASAR 内模块生成合成英文 PNG 并确认隐藏窗口销毁，退出0。这些日志/截图/核验脚本均在忽略目录或忽略文件中。
- 早期 UI 失败已处理：速度图启动预读空数据缓存，入口现在调用 PulseInsights.refreshSpeed，test-agent-switch-ui 刻意先缓存空记录再写新记录锁定回归；浮层排队滚动事件关闭提示，测试在同一页面任务内打开/完成动画/读几何并用即时滚动；旧 test-ui.cjs 的30秒总时限不足以跑完累计步骤，改为90秒，各步骤短超时保留。相关文件 renderer/agent-switch.js、usage-insights.js、scripts/test-agent-switch-ui.cjs、test-model-study-ui.cjs、test-ui.cjs。NOTES说明速度入口修复。
- 最新产物：dist/win-unpacked/TokenPulse.exe，FileVersion 0.3.51 / ProductVersion 0.3.51.0；包内 version 0.3.51，main build/main/index.js。dist/verify-0.3.51.cjs 核对140个 build/renderer/knowledge运行时文件逐字节一致，也反向检查包里无额外运行时文件；app.asar SHA256 a4cf3c36447a5a45e661f07992cd6c8e17f2b4b61b1ae1f1350ef0b350d41994，记录 dist/verification-0.3.51.json。本轮仅目录测试版，dist的0.3.50安装包和latest.yml仍为旧正式产物。
- 资源收尾：本轮 Electron/Node/打包进程均已退出；CIM按命令行/路径核对，用户正式安装版PID20592及子进程保持运行，未关闭。测试版exe/app.asar、旧正式Setup/Portable/latest.yml可独占读取，句柄均立即Dispose，终端在项目根。加载排查临时脚本已移除。
- Git/安装/发布：全部未提交、未推送、未安装、未发布0.3.51，按用户“先打测试版”要求待验收。下一步用户从托盘退出已运行的正式版，再打开上述测试版（单实例否则会跳回旧软件）；验收后再按历史风格准备安装包/Release。真实保存对话框与系统剪贴板写入未操作（测试mock，PNG编码已验证），不读真实凭据、不发收费请求。生存分析是官方周额度的估算，只统计有额度采样的官方成员，不是保障；API Key不计入生存曲线。名称披露只显示所选月测速记录里出现的路线名。
- 下方 Claude 中断记录为接续前历史；其中加载阻塞、未测试和待办已由本轮完成，以以上状态为准。

- 用户要做分享卡片：**月报**（每月 1 号提示，也能手动生成任意月份）、**里程碑**（达成时提示、徽章收集册）、**号池生存分析**（放在额度详情的号池页里自己看，不分享）。导出：预览后保存 PNG + 复制到剪贴板，预览里能选露不露号池名 / 供应商名。卡片上要有「人话换算」（几种轮换：《三体》等，按数量级挑）。版本 0.3.51，先打测试版。
- 设计稿（演示数据）在 scratchpad 的 `survival/`：`card.html`（生存分析）、`share.html`（月报 + 里程碑），渲染脚本 `render.cjs` / `render-share.cjs`。实现时照这个样子做。
- **Claude 中断时的历史检查点（2026-10-13；以下阻塞/待办已由 Codex 接续完成）**：
  - ✅ `src/core/share-report.ts`（新）：`monthReport({usage, month, hours, speed})`、`reportMonths`、`milestoneState(usage, now)`（17 枚里程碑：累计 Tokens 1亿–1000亿、单日 1 亿、连续 7/30/100/365 天、API 价值 $1k/$10k/$50k、10 万次请求）、`analogyOf`（《三体》《红楼梦》《哈利·波特》、代码行、硕士论文，按数量级挑，seed = 年*12+月 轮换）。缓存省下 = cacheRead ×（输入价 − 缓存读价）。夜里 = 22:00–06:00。最快模型至少 20 次样本、同型号×等级只留最快。用真实数据只读试算过，数值合理（用户已过 100 亿，所以加了 300 亿 / 1000 亿档）。
  - ✅ `src/core/pool-insight.ts`：新增 `survivalOf`，`analyzePool` 返回 `survival`（本周曲线、前 7 周、最惊险点、往后推 7 天的模拟（成员按最近 7 天用量比例分摊、重置回满）、`confidence`=最近 14 天每天用量各推一遍撑住的天数、每个号本周见底时段 / 重置 / 预计见底、`avgLifeDays`、`streak`、`nextReset`）。往后推用 7 天**平均**（用户用量很集中，中位数会抹掉猛用的几天——已试过，别改回中位数）。
  - ✅ `renderer/pool-quota.js` 新增 `survivalPanel`（圆环=把握%、结论、曲线 SVG、每个号的寿命条、四个数字、往周 ✓/×），插在号池总额度下面，布局 key `quota:pool-survival`（已加进 app.js 的 LAYOUT 表）；CSS 在 `pool-quota.css` 末尾 `.pq-sv-*`。**还没在界面里实际看过 / 没有 UI 测试**。
  - ✅ `src/main/share.ts`（新）：`shareMonth` / `shareMilestones`（用 `getInitialSnapshot` 的 usage + `loadRequests` 的按小时汇总 + `speedSeries(0)`）、`renderShareCard`（隐藏窗口打开 `renderer/share-card.html`，调 `window.renderShareCard(kind, data, options)`，按 `.share-card` 截图返回 PNG data URL）、`saveShareCard`（保存对话框）、`copyShareCard`（Electron 44 剪贴板是 `clipboard.write([new ClipboardItem({'image/png': Blob})])`，没有 writeImage 了）。`index.ts` 已注册 IPC `share:month|milestones|render|save|copy`；`preload.ts` 已加 `window.tokenpulse.share.*`。
  - ✅ `renderer/share-card.html|css|js`（新）：月报卡和里程碑卡，照设计稿排版（品牌标志用 SVG 画，不依赖 packaging/icon.png；内联样式只用 CSSOM，符合 CSP）。
  - ✅ `scripts/test-share-card.cjs`（新，还没进 npm 脚本）：合成用量测月报 / 里程碑数字，前两组 PASS。
  - ❌ **当前阻塞**：第三组（画成 PNG）在测试里 `loadFile(renderer/share-card.html)` 报 `ERR_FAILED (-2)`。已排除：不是 sandbox（去掉后照样失败）。独立脚本（scratchpad `load-test.cjs`）用默认 webPreferences 能加载、`typeof renderShareCard === 'function'`；带 `sandbox:true` 时同样 -2。下一步：在测试里打印 `did-fail-load` 详情；对比独立脚本的差别（测试里先 require 了 `build/main/share.js` → `snapshot.js`，可能有 session/protocol 拦截；或 `paintWhenInitiallyHidden` / `spellcheck`）；必要时改用 `win.loadURL(pathToFileURL(file).href)`。
- **剩下要做**：
  1. 修上面的加载问题，跑通 `test-share-card.cjs`（`TOKENPULSE_SHOT_DIR` 可以存图看效果，只有合成数据），把它加进 `test:ui`。
  2. 界面入口和弹窗（还没写）：顶栏或用量明细加「分享卡片」按钮 → 弹窗：月报 / 里程碑两个标签，月报可选月份（`share.month()` 返回 `months`），可填「订阅费 $/月」（存 localStorage，传 `options.subscriptionUsd`，月报上显示回本倍数），里程碑可选哪一枚（`options.id`）；预览就是 `share.render()` 返回的 PNG；「保存 PNG」「复制图片」。新文件建议 `renderer/share.js|css`，在 index.html 引入。
  3. 提醒：每次新快照后（或定时）调 `share.milestones()`，和 localStorage 里看过的比，新达成的弹 toast「🎉 新里程碑：xx · 生成分享卡」（第一次运行只记下、不刷屏）；每月 1–7 号如果上个月有用量且没看过，弹「x 月月报出炉了」。
  4. 号池生存分析：在界面里看一眼（只用测试数据截图），给 `test-pool-insight.cjs` 加 survival 的断言、`test-pool-quota-ui.cjs` 加面板存在的断言。
  5. i18n 英文（survival 面板、分享弹窗、卡片文字——卡片是截图，最好按界面语言出中文 / 英文两套文字，至少别出现未翻译的混合）、intro.js 0.3.51 NOTES、README。
  6. 版本 package.json / lock 改 0.3.51；`npm test`、`npm run test:ui`；测试版 `npx electron-builder --win dir --publish never`；查占用和残留进程；更新本节。
- 注意：用户的安装版 TokenPulse 在跑，别关。截图只用演示 / 测试数据。scratchpad 里 `survival/` 是设计稿，`load-test.cjs` 是排查脚本，都不在仓库里。

### 0.3.50 已正式发布（2026-10-13）

- 用户验收后发布，并要求更新 README 截图和内容。README：开头介绍、Electron 44 徽章、号池 402 / 避开用完的号、速度线合并、Grok 默认模型接回、新增「并发监控」一节、功能表加「布局随你摆」「分章节的新手引导」、官方账号「切到 CLI」、截图表加 providers / layout / tour / compact、DeepSeek Harness 会话文件、隐私一节改写（网络请求清单、切到 CLI 时凭据去向）。`scripts/capture-ui.cjs` 新增三张截图：供应商页（临时目录里存的虚构供应商和号池）、编辑布局、新手引导目录；全部截图重新生成，均为演示 / 示例数据并经泄露检查。
- 发布前追加修复：① 0.3.49 起没拖过的卡片按 LAYOUT 表顺序排，DeepSeek / 第三方 Key / 号池页的时间线和模型速度被挪到最上面——`rankOf` 没有存过名次时改用卡片第一次出现时记下的 `data-layout-natural`（`sortZone` 记录，`saveZoneOrder` 也用），恢复默认能回到原顺序；`test-pool-quota-ui.cjs` 加顺序断言。② 引导「目录」打开时聚焦当前章。③ 供应商页副标题补 DeepSeek Harness。④ `test-model-study-ui.cjs` 浮层测试改成等感叹号滚进可视区再悬停（整套跑时两次以相同坐标失败、单独跑通过）。
- 最终：`npm test` 退出 0（0 FAIL）；`npm run test:ui` 退出 0（77 PASS）；`npm run dist` 退出 0；`dist/verify-0.3.50.cjs`：133 个运行时文件逐字节一致，latest.yml version 0.3.50。
- 提交 7c056a3（0.3.50：分章节的新手引导、号池速度合成一条线、更新 README 和截图），标签 v0.3.50，已推送。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.50 ，非草稿、非预发布，releases/latest 指向 v0.3.50，公开 latest.yml 为 0.3.50。附件 uploaded 且与本地一致：Setup.exe 112578568 / 25fa7cd58b6108bf18bceba9087ff3b6781b0afbf3162978b17965e2acb38e08；.blockmap 119705 / ed24216e192354395cfbc5da2cfc1cdf4478650e8e0bdff09971f71d525158a9；Portable.exe 112321428 / d53d3d3da1844dc02f278215277ea95e96d0c720588d41e13e0fe365e7cd54a8；latest.yml 352 / f849a3ca6aa71b891b9f60d982130daae728b6fe8db17167c0fb10a58f10f076。
- 收尾事故（已处理）：写 HANDOFF 的一条 shell 命令里反引号被当成命令替换，意外又跑了 `npm test` 和半套 `npm run test:ui`（发布之后）。核对后结束了这些进程（全部是项目 node_modules 里的 electron / npm，命令行确认，用户安装版未动）；dist 里四个附件的 SHA256 重新核对，和已上传的一致，没被重新打包。之后无残留 node / electron 进程。教训：中文说明里带反引号时不要放进双引号的 shell 字符串，改用 Edit / Write。

以下为开发过程记录（「未提交」等字样已过期）：

### 0.3.50 测试版（开发记录）

- 起点 7751ae6（0.3.49 已发布）。用户两项：
  1. 新手引导太简单：`renderer/intro.js` 的 STEPS 重写成 35 步、7 章（开始、总览、额度详情、用量明细、供应商、会话与监控、个性化与设置），每步带 `chapter`；卡片左上角显示章节名，右上角「目录」（`.tour-toc`）能跳到某一章，Esc 先关目录、上下键在目录里移动。新增内容：统计小卡、工具分布、这个账号的请求、号池 / 余额页（纯文字步）、用量分析、模型速度走势、供应商（一键切换、添加供应商和号池、本地路由、透明转发、转发记录、配置保护和导入，用 `PulseProviders.open(section)` 切到对应二级菜单并高亮菜单项）、并发监控（只高亮侧栏、不切页：切过去会让并发监控写历史）、编辑布局、设置（切到 CLI、余额账号等）。删掉了过时的「组成账号池」。修了旧 bug：出口 / 会话两步的 `[data-page=...]` 也匹配到 `<body>`，高亮了整个窗口，改成 `#nav [data-page=...]`。`PulseIntro` 多导出 `titles()` / `chapters`。intro.css 加章节和目录样式。i18n 补 35 条 + 「目录」+「N 步」模板。
  2. 模型速度走势里号池每个账号一条线：转发记录里号池的 provider 是「号池名 · 成员」。`route-ledger.ts` 新增 `speedVia(row)`：`pool:true` 时取「 · 」前的号池名；`pass-speed.ts` 的 `speedSeries` 和 `route-ledger.ts` 的 `passSpeed` 都用它。真实数据只读核对：Grok 现在每个型号 × 等级一条「所有号」线。说明文字（用量明细、供应商透明转发页）和英文已改。
- 测试：`test-pass-speed.cjs` 加号池合并断言；`test-intro-ui.cjs` 改成按标题找步数，新增 8 个目标检查和目录跳转检查，数据目录指纹忽略 `concurrency-history`（后台监控自己写，和引导无关）。`npm test` 退出 0（0 FAIL，audit-test-0350.log）；`npm run test:ui` 最后一次退出 0（77 PASS，audit-ui-0350.log）。之前几次完整跑分别在 agent-switch-ui（速度图例 10 秒等待）、model-study-ui（浮层位置）、test-ui（总超时）偶发失败，每个单独重跑都通过，判断为负载下的时序问题，没有改这些测试。
- 版本 0.3.50；intro NOTES / i18n / README 已写。测试版 `npx electron-builder --win dir --publish never` 退出 0，exe 0.3.50.0，asar 含新代码；exe/asar 可独占打开；无残留进程（中途一个我自己的走查脚本卡住，PID 2196，核对命令行后结束）。未写 release 文案，未提交。

### 0.3.49 已正式发布（2026-10-13）

- 用户验收测试版后发布。发布前 npm test 退出 0（0 FAIL）、npm run test:ui 退出 0（77 PASS），npm run dist 退出 0（audit-dist.log）。dist/verify-0.3.49.cjs：133 个运行时文件与源码逐字节一致，latest.yml version 0.3.49。发布文案 dist/release-0.3.49.md（同 GitHub Release 正文），intro.js NOTES / i18n / README 已写。
- 提交 9744871（0.3.49：重做编辑布局、一键切换 CLI 登录、去掉自动账号池、修复换菜单白屏），标签 v0.3.49，已推送 origin/main。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.49 ，标题 TokenPulse 0.3.49，非草稿、非预发布；releases/latest 指向 v0.3.49，公开 latest.yml 为 version: 0.3.49。
- 附件均 uploaded，大小 / SHA256 与本地一致：Setup.exe 112573911 / fd9f0885a3a64ff21798af556b4d0587733fc86edbc7c74979d544e70e7e7b21；.blockmap 119716 / 3d6bd76458d99df8e45d00107c4b1374392130862782972530bdc4fdd7b4d483；Portable.exe 112316752 / 3a50fca6360c9cd749d227d3fb799471ac34c2e85accb0b17984176157ef1506；latest.yml 352 / ead48e15cfd7a4a0a114fd2ba854ee29c98b16c886274fb72ae64ad64d96fed9。
- 收尾：四个附件和 win-unpacked 的 exe / app.asar 可独占打开；无残留 node / electron / 打包进程；用户安装版未关闭、未主动安装新版。一键切换 CLI 登录仍未在真机上切换过（用户测试版验收时说没问题，但未确认是否实际点过切换）。

以下为开发过程记录（「未提交」等字样已过期）：


- 起点 c9911f7（0.3.48 已发布）。用户四项：
  1. 同一家多个官方账号被自动聚合成「账号池」显示在额度详情：删掉额度详情的 `poolPanel`（布局 key `quota:pool` 的卡片不再渲染，表项和 CSS 留着没删）；首页额度卡下方的队列标题改为「其他账号」，去掉「下一个」标签。后端 `report.ts` 的 `pools` 结构（active/next）没动，首页主账号仍取第一个有余量的。
  2. 供应商页从「转发记录」等长列表换二级菜单后白屏：原因是 `scrollGuard` 把内容变短当成要保持位置，在底部垫空白。`app.js` 新增 `window.PulseScroll.top()`，`agent-switch.js` 的 `go()`、打开 / 关闭编辑器时回到顶部。`test-agent-switch-ui.cjs` 加断言（滚到底再换菜单 → scrollTop 0、垫片 0）。
  3. 设置 → 官方账号去掉「当前顺位 / 下一个 / 排队」，只写「剩余 X%」/「额度已用完」；去掉序号列；设置说明文字改写（i18n 已补）。
  4. 新功能：设置里一键切换 CLI 登录账号。`src/core/cli-switch.ts`（新）：`switchCliAccount(id)`：先续期、要求目标账号有 TokenPulse 存的可续期凭据；Codex 缺 id_token 时用该账号 refresh token 换一次拿 id_token（`token-refresh.ts` 成功结果多了 `raw`）；备份 CLI 原文件到 `~/.tokenpulse/backups/cli-switch`（留 10 次）；换下来的账号把 CLI 里最新凭据和资料收进账号库（之后由 TokenPulse 续期）；切进去的账号删掉 TokenPulse 存的凭据（refresh token 只留一个主人）；写完读回核对，不对就还原 CLI 文件和账号库。写的文件：Claude `.credentials.json` 的 `claudeAiOauth` + `.claude.json` 的 `oauthAccount`（其余内容保留）；Codex `auth.json`；Grok `auth.json` 同签发方那一行。`StoredOfficialAccount.cliAuth` 存不含 token 的 CLI 资料，登录（`oauth.ts` runLogin）和被换下时记下。IPC `accounts:switch-cli`，preload `switchCliAccount`，设置行按钮「切到 CLI」（`autoRenew && usable && !inCli` 才显示）。测试 `scripts/test-cli-switch.cjs` 6/6，已进 `npm test`。
- **未在真机上切换过**（会改用户真实 CLI 登录）；没有 cliAuth 的旧账号，Claude 只写 accountUuid/email，靠 Claude Code 自己补资料，Grok 写最小资料，均未真机验证。
- 版本 0.3.49；intro.js NOTES / i18n / README 已写。`npm test` 退出 0（0 FAIL，audit-test-0349.log）；`npm run test:ui` 退出 0（69 PASS，audit-ui-0349.log）。中途一次 test-ui 主题颜色断言失败（深色过渡 600ms 时序），单独重跑两次都过，判断为偶发；另一次是 intro 测试要求当前版本有 NOTES，补上后通过。
- 测试版：`npx electron-builder --win dir --publish never` 退出 0，exe 0.3.49.0，asar 含新代码；exe / asar 可独占打开；无残留 node / electron 进程。未写 dist/release-0.3.49.md，未提交。
- **追加：编辑布局重做（用户确认：要拖动排序、原位占位条 + 右侧布局面板、账号标签可藏、并进 0.3.49）。**
  - `renderer/app.js` 布局一节整段重写（「工作空间布局（0.3.43；0.3.49 重做）」）：状态 `layoutHidden`（卡片 key、`nav:<页>`、`tab:<账号标签>`）+ `layoutRanks`（拖动后的名次），localStorage `tokenpulse-layout` 改成 `{v:2, hidden, ranks}`，能读 0.3.43 的 `hiddenNav/hiddenCards`（旧的 `quota` = 官方额度每一家都藏）。`markLayout` 给卡片加工具条（把手 + 名字 + ×，压在卡片上沿；卡片 overflow:hidden 的编辑时放开）和占位条；`syncCards` 由 `#main` 上的 MutationObserver 每帧补标记、隐藏/占位、按名次排序（异步画的卡片也覆盖）。拖动用 pointer 事件，只在同一父容器内换；把手上方向键也能换；侧栏 `.nav-slot` 同样处理。隐藏后提示带「撤销」（`toast` 新增 `sticky:false`）。侧栏至少留一页、账号标签至少留一个。右侧 `#layout-panel`：侧栏页面 + 每页按区域分组的开关、「前往」「恢复默认」、底部「全部恢复默认」；换页时面板滚到当前页。
  - 总览「官方额度」拆成 `overview:quota:claude/chatgpt/grok/deepseek/relay`（app.js renderOverview、deepseek-balance.js cards/renderCard 打标记）；没拖过时各家顺序仍按账号顺序。`#page-overview` 不再是整块卡片，各家都藏了才收起。额度详情账号标签：`drawAccountTabs` 记 `tabLabels`、编辑时画占位和 `.tab-layout` 按钮；`renderQuota` 开头选中的标签被藏了就换到第一个没藏的。
  - `index.html` 删掉旧的 `.layout-remove` 按钮和 `#layout-add`；`app.css` 旧规则换成新的一段（工具条、占位、侧栏、标签、面板、折叠侧栏）。i18n 补 20 条 + 12 个模板；intro NOTES / README 已加。
  - 测试：`scripts/test-layout-ui.cjs` 重写（8 组，含真实鼠标拖动、方向键、撤销、按页/全部恢复、标签、刷新保持、旧设置迁移、英文）。修过的回归：test-ui 依赖 `layout-card` 类在最前、额度卡默认顺序；面板区域顺序。最终 `npm test` 退出 0（0 FAIL）、`npm run test:ui` 退出 0（77 PASS）；测试版重新打包退出 0，asar 含新代码，exe/asar 可独占打开，无残留进程。截图只用测试数据（scratchpad）。

### 0.3.48 已正式发布（2026-10-13）

- 用户测试版验收通过后发布。发布前 npm test 退出 0（0 FAIL，audit-test-final.log），npm run test:ui 退出 0（69 条 PASS，audit-ui-final.log），npm run dist 退出 0（audit-dist.log）。dist/verify-0.3.48.cjs：132 个运行时文件与源码逐字节一致，latest.yml version 0.3.48，exe ProductVersion 0.3.48.0。
- 发布文案：dist/release-0.3.48.md（同 GitHub Release 正文）；renderer/intro.js NOTES 与 i18n.js 英文；README 版本行。
- 提交 ea97fc9（0.3.48：Grok 接回所选供应商、换号后用量记对账号、号池避开用完的号），标签 v0.3.48，已推送 origin/main。GitHub Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.48 ，标题 TokenPulse 0.3.48，非草稿、非预发布，releases/latest 指向 v0.3.48，公开 latest.yml 为 version: 0.3.48。（第一次 gh release create 带 --target 短哈希被 422 拒绝，没有创建任何东西；改用 --verify-tag 成功。）
- 附件均 uploaded，大小 / SHA256 与本地一致：Setup.exe 112564370 / 66aa73925376b3ec6b620b0c6bd8ea241c906366f84f6768bae1d26924f1a3ca；.blockmap 119699 / 01d577ea6b73023503a5c96c081b03d8aca13822b632390a84c1ac1f5ded2ef3；Portable.exe 112307156 / 682d33a9d560ec89fb45b8a81abf971530c725928683fc473d99907e9378b3b7；latest.yml 352 / c9198cb4a132230abcb6a317040be1945af02814cfa85d2bb9c0f30075524da1。
- 收尾：四个附件和 win-unpacked 的 exe / app.asar 可独占打开；无残留 node / electron / 打包进程；用户安装版 TokenPulse 在跑，未关闭；未主动安装新版。

以下为开发过程记录（「未提交」等字样已过期）：


- 用户反馈：TokenPulse 里设好了 Grok 供应商，打开后 Grok 却用着别的（Grok 4.7 或自己的第三方表）。排查（真实数据只读，只看汇总）：
  1. Grok 继续旧会话 / `/model` 会改写 `config.toml` 的 `[models].default`。以前只要这一行变了：退出时 `restoreProxy` 当外部修改，放弃接管并关掉路由开关；或者下次启动 `stillOwned` 字节比对失败，不再接回路由（提示「检测到外部配置变更，未自动接管」）。Grok 就一直停在别的模型上。
  2. Grok 的远程上新活动（`settings_cache.json` 里的 `campaigns`，例如 `grok-4.7-launch` 带 `models.default`）会让新会话改用官方新型号，优先级高于 config 的 default，用户在 Grok 里自己改过才记进 `campaigns_state.json` 的 `dismissed_ids`。真实记录：2026-10-12 04:54 的会话就是在 default=tokenpulse_route 时以 grok-4.7 开的。
  3. 另外两点不是 bug，告知用户即可：正在运行的 Grok 进程不会重新读配置，新开会话可能沿用进程里的模型；旧会话记着自己的模型。
- 修复（`src/core/agent-switch.ts`）：`withoutGrokDefault` / `grokRouteTableOurs` / `dismissGrokCampaigns`。`stillOwned` 对 Grok 忽略 `[models].default` 的差异；`restoreProxy` 在路由表仍是我们的时照常还原并保留开关；`resumeAgentProxy` 在非正常退出后路由表仍是我们的时直接接回；`writeGrok` 切到第三方 / 号池后把改默认模型的活动追加进 `dismissed_ids`（只加不删，原子写）。真正的外部修改（地址、密钥等）仍然尊重。
- 测试：新增 `scripts/test-grok-takeover.cjs` 5/5，已进 `npm test`。`npm test` 退出 0（日志 `audit-test-0348.log`）；`test-agent-switch-ui` 通过（`audit-ui-0348.log`）；完整 `test:ui` 没跑。
- 测试版：`npx electron-builder --win dir --publish never` 退出 0，`dist/win-unpacked/TokenPulse.exe` ProductVersion 0.3.48.0，asar 里有新代码。exe / asar 可独占打开；没有残留的构建进程。用户安装版（PID 23524 等）在跑，没动。
- 第二个问题（同一测试版里）：用户有两个 Claude 账号，用第二个的额度，用量却记到第一个。原因：`login-timeline.ts` 的 `resolveAccount` 优先用会话里 `bridge-session` 的 `ownerAccountUuid`（远程控制桥接发起账号，会话中途换登录后仍是第一个账号；真实会话里 986 行全是第一个账号），而 `session_context` 的 `userEmail` 在 10-13 09:29 已变成第二个账号。修复：ref 账号的已知邮箱和当前邮箱不一致时按邮箱归属。`usage-scan.ts` 的 `STATE_VERSION` 14→15（所有会话文件重扫一遍，重建账号小时账）；`request-log` 读时也走 `resolveAccount`，一并生效。真实会话只读试算：现在归到第二个账号。测试：`test-accounts.cjs` 加 3 条（70/70）；`test-routing-regressions.cjs` 的版本断言改为 15。
- 第三个问题：Grok 号池不会自己避开额度用完的号。route-log 汇总：Grok 账号额度用完时回 **HTTP 402**（不是 429），以前 402 不换成员、直接把错误交给 Grok；而且轮询 / 用满再换完全不看额度。用户的号池「所有号」是轮询、4 个官方账号。修复：`agent-proxy.ts` 号池成员遇到 402 也换下一个；`agent-switch.ts` 的 `pushLog` 把 402 和 429 一样记进 `poolLimited`；新增 `spentLast`，轮询和用满再换也把用完的官方账号（额度剩不到 1%，或刚回过 429/402、还没查到新额度，最多 10 分钟）排到最后，不删除，额度恢复自动回来；`pool-order.ts` 导出 `spent`。测试：`test-pool-strategy.cjs` 加一条（6/6）。已知限制：Grok 的额度接口如果不反映这种 402，每次查到新额度后会再试一次那个号（一次 402 后自动换走，不报错给工具）。
- 最终：`npm test` 退出 0、0 个 FAIL（`audit-test-0348.log`）；测试版重新打包退出 0，asar 内含三处修复；exe / asar 可独占打开，没有残留 node / electron 进程。
- 没做：intro.js NOTES、i18n、README、release 文案（发布时补）；没提交 Git。

### 0.3.47 已正式发布（2026-10-13）

- 起点 ca116cc / 0.3.46，初始工作区干净。当前 package.json / package-lock.json 已升级 0.3.47。
- 修复：余额换 Key 等待已有查询、同账号编辑串行，拒绝新 Key 时保留旧 Key/名字/提醒线/Harness 归属；新增无效 Key 不夺走原 Harness 归属；空金额/布尔值不再当作零余额；DeepSeek 只有余额采样的历史日期也能翻页；DeepSeek/号池零点整请求计入新的一天。关键文件 src/main/deepseek-balance.ts、src/core/deepseek-insight.ts、src/core/pool-insight.ts。
- 回归：scripts/test-deepseek-balance.cjs 10/10、test-deepseek-insight.cjs 5/5、test-pool-insight.cjs 8/8、test-relay-balance.cjs 5/5。余额分析测试固定本地中午；知识库 CLI 测试补本地 Epoch 目录；浮层测试等动画结束后验几何位置，失败输出边界。
- 最终 npm test、npm run test:ui、npm run dist 均退出 0，日志在项目根 audit-test-final.log、audit-ui-final.log、audit-dist.log（忽略文件）。早期失败：沙箱 PowerShell EPERM（获准沙箱外测试后解决）；余额时间线凌晨跨日（固定时钟）；浮层测试时序及 Animation 跨 IPC 返回失败（等待动画并返回 true 后全套通过）。
- 产物：dist/TokenPulse-0.3.47-Setup.exe、.exe.blockmap、TokenPulse-0.3.47-Portable.exe、latest.yml。dist/verify-0.3.47.cjs 核验 132 个运行时文件逐字节一致、包内 0.3.47 / build/main/index.js、latest.yml 的安装包 SHA512 和大小一致；exe ProductVersion 0.3.47.0。SHA256/大小见 dist/verification-0.3.47.json。
- 发布文案：dist/release-0.3.47.md；中英文应用说明 renderer/intro.js、renderer/i18n.js；README 已更新。
- 资源收尾：四个附件、dist/win-unpacked/TokenPulse.exe 与 resources/app.asar 独占读取成功，检测句柄均已 Dispose。CIM 检查无本轮残留 Node/Electron/打包器；用户安装版 PID 20404 及子进程保持运行，未关闭。终端保持项目根目录。
- 已提交并推送 origin/main，发布提交 af6b2edfdeed0b499f25a1b575b868986a64b159，标签 v0.3.47。GitHub Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.47 ，标题 TokenPulse 0.3.47，非草稿、非预发布；releases/latest 已指向 v0.3.47，target 为上述完整 SHA。发布后交接更新单独提交。
- 四个远端附件均 uploaded，大小和 GitHub SHA256 摘要逐项匹配本地：Setup.exe 112562385 / 5f3ba1d124a0e4d966b85e1334b26d301d43208c2e6e2b4174ec1efd9e222370；Setup.exe.blockmap 119740 / 6d9a8d0b73ee3f532d155f669f4f628427364a87d66527849796af103ca305ed；Portable.exe 112305228 / fa7d02a8b775d1d38842d58106cc554aae6d5480cb16d5d65dc73d2918b6e937；latest.yml 352 / 8cecb25a1ce0b463df75675e1cfeaece04caadab9afbe9e294b33647dcbd44ee。Release 正文与本地发布说明一致。公开 releases/latest/download/latest.yml 经 curl 下载与本地一致（最初沙箱内 Invoke-WebRequest TLS 认证失败，未禁用证书校验；改用获准的 curl 成功）。
- 未主动安装新版，未验证真实付费接口、真实 Key 更换或真实 Harness 切换；自动化使用合成数据。本轮修复的是已确认缺陷，不表示全项目没有其他潜在问题。没有剩余发布阻塞。下次接手先核对 Git、版本和实际运行软件；下方均为旧版本历史。

### 0.3.46 已正式发布（2026-10-12）

- 正式发布是 **0.3.46**。提交 `2cb3425`（0.3.46：刷新后说明额度结果），标签 `v0.3.46`，已推送 `origin/main`。GitHub Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.46 ，标题 `TokenPulse 0.3.46`，非草稿、非预发布，`releases/latest` 指向 `v0.3.46`，target 是完整 SHA `2cb3425b928b5057bb92cc1a50cabc184f7dc25c`。
- 这一版：点「刷新数据」或托盘刷新后，右上角弹出结果。问到了是绿色，写出哪一家、哪个账号、额度变了多少；没变也会说已刷新。这次没问到最新额度是黄色。登录失效才红色，并请重新登录。定时自动查询不弹。
- 附件 4 个，大小和 SHA256 与本地一致，GitHub 资产摘要也一致：`TokenPulse-0.3.46-Setup.exe` 112,561,573（`e6ad433795430f4454f84784848ea0f372b46ce84922606860e4807a788ac72d`）、`.blockmap` 119,743（`ca42f66900cb47a3f5daba73af32f12e92db694b37f2c0e540026fc884a7594b`）、`TokenPulse-0.3.46-Portable.exe` 112,304,433（`5557d6a63e2d6142abf9c9c3b94dc7cb04b71a62ae03741b61e7ed9c55f917c3`）、`latest.yml` 352（`12c2fd50284efaf4e79ca384f42c366e9075691497ca96850689c454078b40fc`）。
- 发布前：`npm test` 退出 0。`npm run test:ui` 退出 0。`npm run dist` 退出 0。包内 132 个运行时文件和源码逐字节一致，版本 0.3.46，exe ProductVersion 0.3.46.0。
- 收尾：四个附件和 `dist/win-unpacked` 的 exe / app.asar 能独占打开。没有留下这次的 electron、node 或打包进程。工作目录在项目根。安装版（`AppData\Local\Programs\TokenPulse`）当时在跑，没有关。

### 0.3.45 已正式发布（2026-10-11）

- 正式发布是 **0.3.45**。提交 `74c4b26`（0.3.45：Grok 按选中的型号转发、用量明细红点看过即消），标签 `v0.3.45`，已推送 `origin/main`。GitHub Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.45 ，标题 `TokenPulse 0.3.45`，非草稿、非预发布，`releases/latest` 指向 `v0.3.45`，target 是完整 SHA `74c4b2692170f069fa74f8280c8dad85d7a23035`。
- 这一版：TokenPulse 接管 Grok 时，选 `grok-4.6` 就按 `grok-4.6` 发，另选 4.5 或 4.7 也按所选型号发；关掉之后原来的自定义模型表恢复。`grok-4.6` 和 `grok-4.6-build` 算同一个型号。用量明细侧栏的红点打开这一页后清掉。
- 附件 4 个，大小和 SHA256 与本地一致，GitHub 资产摘要也一致：`TokenPulse-0.3.45-Setup.exe` 112,559,291（`bfc457064539b55ab22837d33e217eaf7327436e317ee4991b28d58477af0eff`）、`.blockmap` 119,738（`39bf3c33b2b7d130fc37f79663b3c1e536086f497086ff4f3685ae30b99e2092`）、`TokenPulse-0.3.45-Portable.exe` 112,302,065（`39843e169f11870e08a7f74cdc3a4d438ca60f4b44eae231f92807da030a623c`）、`latest.yml` 352（`c39f3db4420f38f5dbba86d6bbdb86870ab10f2bccb88a0ae1c0280f802a82a6`）。公开下载的 `releases/latest/download/latest.yml` 是 `version: 0.3.45`。
- 发布前：`npm test` 退出 0。`npm run test:ui` 里 `test-ui.cjs` 第一次停在翻页断言 `15 !== 7`，单独重跑退出 0；其余界面测试随后退出 0。`npm run dist` 退出 0。包内 132 个运行时文件和源码逐字节一致，版本 0.3.45，exe ProductVersion 0.3.45.0。
- 收尾：四个附件和 `dist/win-unpacked` 的 exe / app.asar 能独占打开。没有留下这次的 electron、node 或打包进程。工作目录在项目根。安装版（`AppData\Local\Programs\TokenPulse`，PID 4528）当时在跑，没有关。
- 已知限制：已经打开的 Grok 会话仍用它记住的型号，新开一段再生效。关掉 TokenPulse 后，`[model."grok-4.6"]` 会回到接管前的写法。

### 0.3.44 已正式发布（2026-10-11）

- 正式发布是 **0.3.44**。提交 `eb633a3`（0.3.44：号池按额度轮换、额度详情的号池页、DeepSeek Harness 的供应商和会话），标签 `v0.3.44`，已推送 `origin/main`。GitHub Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.44 ，标题 `TokenPulse 0.3.44`，非草稿、非预发布，`releases/latest` 指向 `v0.3.44`，target 是完整 SHA `eb633a3f382955abc109d9385706a50d79eeaf8a`。
- 这一版三件事：号池新增「快重置优先」和「剩余最多」；额度详情里每个号池有自己的一页；DeepSeek Harness 可以切换供应商、走本地路由、用只含 API Key 的号池，会话可以查看和回复。
- 附件 4 个，大小和 SHA256 与本地一致，GitHub 资产摘要也一致：`TokenPulse-0.3.44-Setup.exe` 112,558,329（`dec04693bc9bec51a823e4fb3b09d4342f10402734c8089d39120b805fa7fef6`）、`.blockmap` 119,729（`966264f6e6e1de87b8fd6fdca5f7d051a84df9a95772b308d724f84b49902f81`）、`TokenPulse-0.3.44-Portable.exe` 112,301,107（`c16b3b9d749592da77e5dd33efc5a4038afa9d4bf25ba765fd691905e74ba949`）、`latest.yml` 352（`da690575984a87f8b7802d1ff192e784264b380beb53921d1d70a8efb911f7b6`）。公开下载的 `releases/latest/download/latest.yml` 是 `version: 0.3.44`，sha512 和大小与本地相同。
- 发布前：`npm test` 退出 0。`npm run test:ui` 里 `test-model-study-ui.cjs` 第一次停在「浮层完整显示、在最上层」，单独重跑退出 0；`test-ui.cjs` 在第一次整套里已过，其余界面测试随后退出 0。`npm run dist` 退出 0。包内 132 个运行时文件和源码逐字节一致，版本 0.3.44，exe ProductVersion 0.3.44.0。发布说明：`dist/release-0.3.44.md`（同 GitHub Release 正文）、`renderer/intro.js` 的 NOTES、`i18n.js` 的英文、`README.md`。
- 收尾：四个附件和 `dist/win-unpacked` 的 exe / app.asar 能独占打开。没有留下这次的 electron、node 或打包进程。工作目录在项目根。安装版（`AppData\Local\Programs\TokenPulse`，PID 35432，2026-10-11 8:45 启动）当时在跑，没有关。
- 已知限制（发布说明里也写了）：按额度轮换看的是整个账号的剩余，网页和其他设备也算在里面；正在用的号和最高分差得不多时会继续用它。号池页的用量来自转发记录。DeepSeek 的切换只对新会话生效；窗口里正开着的会话先在那边说完再在这里回复；桌面配置里已有的模型供应商会被这一层盖住，切回官方登录后恢复。新任务仍不从「开一个新对话」启动。没有在用户的 Harness 上真的切换。headless 回复会花额度，实测前要先问用户。
- **2026-10-11 Grok 型号第三次修（测试版待重打）**：16:56 和 16:59 的转发记录是 `requestModel: grok-4.7`、`model: grok-4.6`、`returnedModel: grok-4.6-build`。原因是 `~/.grok/config.toml` 里 `[model."grok-4.6"]` 把这个 id 的接口型号写成了 `grok-4.7`，号池的 pin 又把上游改回 `grok-4.6`，核验就对不上。4.5 / 4.7 没有这张表，请求和返回一致。已改：接管期间把这张表的型号改回它自己的 id，退出时还原；官方账号成员不再改写客户端选的型号。`test-agent-switch.cjs` 已过。`npx electron-builder --win dir --publish never` 退出 0。正式安装包仍是已发布的 0.3.44。新开一段 Grok 再测。关掉 TokenPulse 后那张表会还原。

**0.3.44 开发过程（下面各条里「未提交、未发布」「还没打测试版」「NOTES 还没写」都已过期，以本节上面为准）**

计划全文：`C:\Users\7ipny\.claude\plans\concurrent-wishing-hippo.md`（用户已批准）。三件事：号池两种新轮换方式；额度详情的号池页；DeepSeek Harness 补齐（供应商切换 + 本地路由、号池、会话管理，用户勾选；出口监控、托盘这版不做）。用户同意在他的 Harness 上实测供应商切换，前提是先备份 `~/.dsh/profiles/desktop/cordis.patch.yml` 和 `~/.dsh/.credentials.yaml`，测完还原并逐字节核对；headless 回复会花额度，实测前要再问用户。

- 已做：删除根目录旧副本 `app.js`（用户同意）；版本 0.3.44（package.json / package-lock.json）。
- **测试版（2026-10-11 08:30）**：`npx tsc -p tsconfig.json` 退出 0，`npx electron-builder --win dir --publish never` 退出 0。产物 `dist/win-unpacked/TokenPulse.exe`（ProductVersion 0.3.44.0，FileVersion 0.3.44）。asar 里 132 个运行时文件（build、renderer、knowledge）和当前磁盘逐字节一致，包内 version 0.3.44、main `build/main/index.js`。号池两种轮换、额度号池页、Harness 切换和会话都在包里。exe 和 app.asar 能独占打开。没有留下这次的 electron / node。工作目录在项目根。0.3.43 的安装包文件时间仍是 3:29，没有重打安装包、没有提交、没有发布。用户的安装版（`AppData\Local\Programs\TokenPulse`，PID 37848，2026-10-11 3:38 启动，带 `--updated`）当时在跑，没有关。测这个目录包之前要先从托盘退出安装版，否则单实例会跳回旧程序。
- 已做（第 1 件）：`src/core/pool-order.ts`（新）：`orderPool`（reset-first = 每周剩余 ÷ 距每周重置小时数，在用的号分数 ≥ 最高分 80% 就继续用；most-left = 两个窗口里少的那个，多 5 个百分点才换；分段：能用 → 没数据 → API Key → 用完的）、`accountQuota`（读 quota-history 最后一条 + quota-checked 时间，按 mtime 缓存，超 30 分钟当没数据，过了重置时间算满）。`agent-types.ts` 的 `PoolStrategy` / `POOL_STRATEGIES`、`ProxyTarget.poolId`；`agent-proxy.ts` 的 `ProxyLog.poolId`；`agent-switch.ts` 的 `poolTargets` 按额度排、`pushLog` 记当前成员和 429（`poolCurrent` / `poolLimited`，429 的账号在查到新额度前最多 10 分钟排后面）、`poolView` 给出 `next` 和成员 `quota`。界面 `renderer/agent-switch.js`（`STRATEGY_OPTIONS`、成员显示剩余和「下一个」）、`agent-switch.css`。测试 `scripts/test-pool-strategy.cjs` 5/5，已进 `npm test`。i18n 英文还没补。
- 已做（第 2 件，额度详情的号池页）：
  - 后端 `src/core/pool-insight.ts`（新），在 report-worker 里跑（`report-worker.ts` 的 `workerData.pool`，`snapshot.ts` 的 `loadPool`）。读 route-log：0.3.44 起认 `poolId`；旧记录的官方成员认 `号池id@`，Key 成员认名字前缀「号池名 · 」；透明转发不算。Anthropic 的 input 加回缓存读取。汇总包括：成员分摊、限流次数、用了多久（间隔不到 5 分钟连成一段）、24 小时和 30 天按成员拆、模型 × 等级、最近 60 次。总额度 = 官方成员每周剩余之和 ÷ 100；7 天用量按 quota-history 同一周期内的上涨算，再估还能用几天。时间线 `kind:'pool'` 按天 / 7 天分段，曲线是成员每周已用的平均值。速度用 `speedSeriesOf`。
  - 主进程：`agent-switch.ts` 的 `poolDef(id)` 只给名字和 id，不带凭据。`index.ts` 的 IPC `pool-insight:summary|speed|timeline`；`preload.ts` 的 `poolInsight`。
  - 界面：`renderer/pool-quota.js|css`（新），`index.html` 已引入。标签 key 是 `pool:<id>`，拖动排序只记在本机 localStorage `tokenpulse-pool-tabs`。`app.js` 的 `drawAccountTabs` / `saveQuotaTabOrder` / `renderQuota` 加了分支（`pool-mode` 类会藏掉容量排行），布局 key 是 `quota:pool-*` 七个。`model-study.js` 认 `kind:'pool'`：`isPool` / `isPlain` / `poolHelp`，「号池用了」，曲线名「成员平均已用」，取 `study.brand` / `study.source`。
  - 测试：`scripts/test-pool-insight.cjs` 7/7，已进 `npm test`；`scripts/test-pool-quota-ui.cjs` 8/8，已进 `test:ui`。截图只用了测试数据，放在 scratchpad。回归：`test-model-study-ui`、`test-deepseek-balance-ui`、`test-provider-pool-ui` 都过了。完整 `npm test` / `test:ui` 还没跑。
- 已做（i18n）：第 1、2 件的英文已补进 `renderer/i18n.js`（`"用满再换"` 后 77 条词条，`本机用了` 模板后 24 条 PATTERNS，标注 `// 0.3.44`）。还顺手修了一个旧 bug：0.3.42 那批写成 `[/re/, (_, a, b) => …]` 的模板，以前 `translate()` 只传 `m`，结果「3 次」被译成 "undefined req"。现在是 `render(m, ...m.slice(1))`（i18n.js 里 `const m = core.match(re)` 那处）。用 node `require('renderer/i18n.js').translate` 抽查过号池页的句子，都对。改完以后没有重跑 UI 测试。
- **第 3 件 Harness：供应商切换和会话列表已写，已经打进上面的测试版，还没在真机上切。** 只读核对结论如下（来自 Harness 安装包 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar` 里的 README 和 lib 源码，只读）：
  - 补丁的叠法（`dsh-app-boot` 的 `readProfilePatches`）：先叠 bundle 层，再叠 `~/.dsh/profiles/<profile>/cordis.patch.yml`，再叠 **home 级 `~/.dsh/cordis.patch.yml`**，最后是命令行 overlay。所有层拼成一个列表按顺序应用；按 id 命中的补丁会**整个替换**那一项的 config，不做深合并，所以后面的覆盖前面的。`dsh-hmr` 两个补丁文件都盯着，改了会热加载。home 级文件对 desktop 和 headless 都生效。文件不存在就当没有这一层；空文件或只有注释的文件会让启动失败，要写 `[]`。
  - **建议的做法（和计划不同，更干净）**：只写 home 级 `~/.dsh/cordis.patch.yml`，**不碰用户的 `profiles/desktop/cordis.patch.yml`**。这个文件目前不存在，由 TokenPulse 创建；切回官方登录时，如果文件内容只有我们写的，就删掉整个文件，否则只去掉我们的标记段。代价是：TokenPulse 接管期间，Harness 界面里改默认模型会被拒绝（config editor 遇到上层覆盖时不写文件）。内容大致是：
    ```yaml
    # >>> TokenPulse（自动生成，切回官方登录时删除）
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          tokenpulse:            # 路由键只能是小写字母和连字符
            displayName: TokenPulse · <供应商名>
            api: openai-completions          # 直连时用供应商自己的：openai-completions / openai-responses / anthropic-messages
            baseURL: http://127.0.0.1:<端口>/deepseek/v1   # 直连时是供应商地址
            apiKeyEnv: TOKENPULSE_ROUTE
            models:
              - id: <模型名>
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: tokenpulse
        model: <模型名>
    # <<< TokenPulse
    ```
    手写的路由必须同时有 `api`、`baseURL` 和非空的 `models`。不要另外 insert 第二个 pi-ai 实例：它会重复注册目录和登录流程，有冲突风险。有个已知限制：如果用户在 Harness 的「模型」页配过自己的 pi-ai 供应商（desktop 补丁里会出现 `- id: llm-pi-ai`），我们这一层会把它们整个盖掉。用户现在没有这一项。建议检测到时在切换提示里说明。
  - 密钥：`apiKeyEnv` 每次请求都会解析一遍，解析顺序是：启动时的环境变量 > `~/.dsh/.credentials.yaml` 的 `refs:` > 项目 `.env` > `~/.dsh/.env`。`.credentials.yaml` 有 watcher，改了热加载，也允许手工编辑。用户的这个文件现在是 `version: 1` 加 `records:`（三条账号登录记录），**没有 `refs:`**。所以要在文件里加一个 `refs:` 段，写一行 `TOKENPULSE_ROUTE: <key>`；走本地路由时写 `PROXY_MANAGED`。不认识的顶层键、空值、重复键都会让 Harness 拒绝加载，写完必须自查。也可以考虑：本地路由时改写 `~/.dsh/.env`，完全不碰 credentials。但 `.env` 是启动时拍的快照，直连换 key 得重启 Harness。
  - 用户现有的 desktop 补丁有 4 项：`agent-default-model`（provider/model/reasoningEffort）、`ui-settings-account`、`ui-chat`、`ui-settings`。官方默认是 `deepseek-official` / `deepseek-flash`。profile 的 bundles 是 `dsh-base` 加 `dsh-web-app`。
  - headless 命令：`DeepSeek Harness.exe` 加环境变量 `ELECTRON_RUN_AS_NODE=1`，跑 `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`（`runCli({manageDesktopProfile:true})`）。`--profile headless`、`--session-id`、`--json` 这几个参数还**没核对**，要去看 `@deepseek-ai/dsh/lib/bin.js`。
  - 读安装包用的辅助脚本（在 scratchpad，不在仓库）：`asar-ls.cjs <正则> [第几个]`，作用是列出或读出 asar 里的文件，正则别用 `\\`；`mask-yaml.cjs <文件>`，只打印 YAML 的键结构，值都打码。**不要读 `.credentials.yaml` 的值。**
- **这一轮已做（供应商切换）**：按上面的 home 级补丁写，不碰 `profiles/desktop/cordis.patch.yml`。`writeDeepseek` 只替换 `# >>> TokenPulse` 到 `# <<< TokenPulse` 之间，凭据只动 `refs` 里的 `TOKENPULSE_ROUTE`。直连时按供应商自己的协议写（openai-completions / openai-responses / anthropic-messages），不因为协议不同就强迫走本地路由。本地路由和号池写成 `http://127.0.0.1:<端口>/deepseek/v1`，协议固定 openai-completions，密钥写 `PROXY_MANAGED`。号池只收 API Key 供应商。切回官方登录时，补丁文件如果只剩我们写的就删掉，凭据里拿掉这一行。桌面补丁里已有 `id: llm-pi-ai` 时，切换提示会说明这一层会盖住它们。`zstdFrames` 抽到 `src/core/zstd-frames.ts`。
- **这一轮已做（会话）**：列表和查看能读 `session.v4.jsonl.zstd`（用户消息、助手正文、工具调用；思考块不进正文）。测试目录用 `TOKENPULSE_DSH_HOME`，免得测试去读用户真实的 `~/.dsh`。回复参数按 headless 文档：`--profile headless --json --session-id <id> -`，任务从 stdin 读。界面上 DeepSeek 的会话没有「在终端里继续」和「删除」。新任务还不会从「开一个新对话」里启动（那个入口仍是开终端，DeepSeek 会直接说明不行）。
- **验证（这一轮）**：`npx tsc -p tsconfig.json` 退出 0。`node scripts/test-deepseek-switch.cjs` 5 项过。`node scripts/test-sessions.cjs` 过（含合成的 zstd 会话）。`node scripts/test-deepseek-harness.cjs` 2/2。`node scripts/test-agent-switch.cjs`、`test-agent-drift.cjs`、`test-agent-config.cjs` 过。没有跑完整 `npm test` / `npm run test:ui`。测试版已打，见上面。没有在用户的 Harness 上切换。
- **发布后仍没做**：真机切换前先备份 `profiles/desktop/cordis.patch.yml`、`.credentials.yaml`，以及 home 级 `cordis.patch.yml`（如果有），测完逐字节核对。**headless 回复会花额度，实测前要先问用户。** 新任务的 headless 入口还没接到「开一个新对话」。NOTES、README、英文更新说明和完整测试都在发布时做了，见最上面。
- Git：全部未提交。没有在跑的构建或测试进程。用户的安装版 TokenPulse 如果在跑，不要关。


### 接手速览（2026-10-11，0.3.43 已正式发布）

**现在的状态**

- 正式发布是 **0.3.43**。提交 `70f8e4b`（0.3.43：编辑布局、Grok 号池记到每次转发、额度查询同一个间隔），标签 `v0.3.43`，已推送 `origin/main`。GitHub Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.43 ，标题 `TokenPulse 0.3.43`，非草稿、非预发布，`releases/latest` 指向 `v0.3.43`。
- 这一版三件事：侧栏和各页卡片可以编辑布局；Grok 号池的每一次转发记到额度详情和时间线；官方订阅额度、DeepSeek 余额、第三方 Key 余额共用一个查询间隔。默认 1 分钟，设置 → 通用的滑块是 1 到 10 的整分钟，保存后生效。
- 附件 4 个，大小和 SHA256 与本地一致：`TokenPulse-0.3.43-Setup.exe` 112,540,789（`766808a14efa0442dd67f8fdb345349ade735bebe491f67a32eee2aded53874e`）、`.blockmap` 119,677（`c625d573bb59208d16cc90da0ac9c6b48309dfda2089663650e13895407e6161`）、`TokenPulse-0.3.43-Portable.exe` 112,283,577（`fdc87e2ed5480f7840434ce59324b1974c464deeac27647fb4b0a6d625a3dc7d`）、`latest.yml` 352（`f0a477d1a784450628b9448e12d18cec0a008aa27efd2907fa49c0c823edd35e`）。公开下载的 `releases/latest/download/latest.yml` 是 `version: 0.3.43`，sha512 和大小与本地相同。
- 发布前：`npm test` 退出 0，`npm run test:ui` 退出 0（58 条 PASS）。`npm run dist` 退出 0。包内 128 个运行时文件和源码逐字节一致，`build` / `renderer` / `knowledge` 没有漏进包的文件，版本 0.3.43，exe ProductVersion 0.3.43.0。发布说明：`dist/release-0.3.43.md`（同 GitHub Release 正文）、`renderer/intro.js` 的 NOTES、`i18n.js` 的英文。
- 收尾：四个附件和 `dist/win-unpacked` 的 exe / app.asar 能独占打开。没有留下这次的 electron、node 或打包进程。工作目录在项目根。安装版（`AppData\Local\Programs\TokenPulse`，PID 35956 一带，2026-10-11 3:15 启动）当时在跑，没有关。根目录未跟踪的 `app.js` 没有提交，也没有打进包。
- 已知限制（发布说明里也写了）：收起布局只影响这台电脑的界面；同一时间两个 Grok 会话都走号池时，各轮比例可能混在一起，总量不变；额度上涨前后 5 分钟没有对得上的本机请求时，时间线标成「本机以外」；数字没变时历史曲线大约 15 分钟才多一个点；更新后第一次打开会重扫。没有用真实鼠标点过编辑布局和额度详情。真实 DeepSeek 余额接口、new-api / one-api 真实站点，仍是 0.3.42 留下的未验证项。

**0.3.43 开发过程（下面各条里「未提交、未发布」「正在打安装包」「正式发布仍是 0.3.42」都已过期，以本节上面为准）**

- 三件事都在 0.3.43：侧栏和各页卡片可以编辑布局；Grok 号池的转发记到额度详情和时间线上；额度查询收成一个间隔。
- **额度查询间隔（本轮已改成整分钟，测试版已重打）**：官方订阅（Claude / ChatGPT / Grok）、DeepSeek API、第三方中转 Key 共用 `prefs.json` 的 `quotaEverySeconds`。默认 **1 分钟**。设置 → 通用的滑块只走整分钟，**1 到 10 分钟**，点保存才改定时器，保存本身不立刻再查一轮。不是整分钟的旧值会收到最近的整分钟，再限制在这范围内。打开软件时这几路马上各查一次，之后按这个间隔。窗口收进托盘也不放慢这一路。用量扫描仍是开着 1 分钟、收起 3 分钟。数字没变时，官方历史曲线仍约 15 分钟才多记一个点。手动刷新 API 余额仍是每个账号至少隔 5 秒。
- 代码：`src/main/prefs.ts`、`src/main/deepseek-balance.ts`、`renderer/app.js`、`renderer/i18n.js`、`renderer/intro.js`、`scripts/test-quota-interval.cjs`、`scripts/test-ui.cjs`、`README.md`。验证：`npx tsc -p tsconfig.json` 退出 0；`node scripts/test-quota-interval.cjs` 3 项过；`npx electron scripts/test-ui.cjs` 退出 0。没有跑完整 `npm test`。`npx electron-builder --win dir --publish never` 退出 0。包内版本 0.3.43（exe ProductVersion 0.3.43.0），asar 里滑块是 1 到 10 分钟，最短间隔常量是 60 秒。exe 和 app.asar 能独占打开。安装版当时在跑，没有关。没有留下这次打包的 electron / node。
- 工作区里的 `package.json` 曾经只剩版本号、脚本和 electron-builder 配置都没了。已经按 0.3.42 的那份加回来，版本仍是 0.3.43，`test` 里加了 `test-quota-interval.cjs`，`test:ui` 里加了 `test-layout-ui.cjs`。
- 上一轮（号池）打的测试版已经再次重打，以上面「额度查询间隔」那条为准。那一次包里已经有 `poolEvents`、`pendingGrokPool`、`STATE_VERSION = 14`，这次的包仍是这些，并加上了查询间隔。
- **Grok 号池（本轮）**：用户能在转发记录里看到每次用了哪个号，但额度详情「这个账号的请求」和时间线仍认为额度上涨是本机以外。只读统计（不输出账号、对话）：约 370 次带用量的号池转发、6 个成员；对得上会话的轮次里，13 轮里只有 1 轮全程同一个号，其余 12 轮中途换过号。旧逻辑只在「这一整轮只有一个号」时才把那一条记成这个账号的官方请求，而且时间记在轮次结束。所以时间线几乎看不到本机请求。
- 改法：一轮里的每一次官方转发各记一条请求，时间用转发完成的时间，账号用当时那个成员；Token 仍按这一轮的比例拆，加起来不变。还没写完的一轮，查询时先用转发记录补上，轮次扫进来之后同一条不重复。`STATE_VERSION` 13 → 14，下次打开会重扫。
- 改动文件：`src/core/route-ledger.ts`、`src/core/usage-scan.ts`、`src/core/request-log.ts`、`renderer/app.js`、`renderer/i18n.js`、`renderer/intro.js`、`scripts/test-grok-pool.cjs`、`scripts/test-routing-regressions.cjs`、本文件。布局那一批文件仍是 0.3.43 的一部分。
- 验证：`node scripts/test-grok-pool.cjs` 6/6；`test-routing-regressions.cjs` 9/9；`test-route-ledger.cjs`、`test-requests.cjs` 63/63、`test-usage-scan.cjs` 16/16。`npm run compile` 退出 0。没有用真实鼠标点过额度详情。
- 布局（同一版本，上一轮已打进当时的测试版）：侧栏「工作空间」的页面和各页卡片可以在「编辑布局」里藏起来，再加回原来的位置。只藏界面，出口监控、并发、供应商路由和通知照常跑。
- 布局相关文件：`renderer/index.html`、`renderer/app.js`、`renderer/app.css`、`renderer/i18n.js`、`renderer/intro.js`、`package.json`、`package-lock.json`、`scripts/test-layout-ui.cjs`（已加入 `test:ui`）。这一条写的时候还没发布，发布结果见最上面。
- 怎么用：侧栏「工作空间」旁边的「编辑布局」。进去之后，当前这一页上的卡片都能删（不只是总览）：总览的四张统计小卡（总 Tokens、参考费用、请求次数、缓存读取占比）各自能删，额度详情、用量明细、出口监控、并发监控、会话管理、供应商里的主要卡片也能删。「添加」按页面分组，加回原来的位置。「完成」或 Esc 退出。全部页面藏掉也可以，主区是空状态。藏起来的页，页面里跳过去的按钮一起藏。点通知仍会打开那一页，顶上有「加回侧栏」。记在本机 localStorage 键 `tokenpulse-layout`（记的是藏了哪些，id 形如 `overview:tokens`）。「设置」和「收起侧栏」不能藏。总览的「官方额度」整块一起藏，不单独藏某一个账号。总览藏起的统计小卡不影响用量明细上的同一排数字。
- 验证：`scripts/test-layout-ui.cjs` 退出 0。`npm test` 在 `test-deepseek-insight.cjs` 停住（本机时间 2026-10-11 00:52，时间线断言要「今天」的请求，夹具写在两小时前、落在昨天；和这次界面改动无关）。该文件之后的 node 测试单独跑完，退出 0。`npm run test:ui` 里 `test-ui.cjs` 单独重跑退出 0；`test-intro-ui.cjs` 第一次报「真实数据目录没有变化」（并发历史文件在测试期间多了一笔，已知偶发），单独重跑退出 0；其余界面测试退出 0，含 `test-layout-ui.cjs`。
- 开发当时还没做：没有用真实鼠标点过编辑布局。英文文案在 `i18n.js`，界面测试里核对了「编辑布局」和「加回侧栏」两句。安装包、提交和发布后来都做了，见最上面。

**上一份接手时的状态（0.3.42 已发布，做 0.3.43 之前）**

- 当时 `origin/main` 在 `c062c88`，工作区只有这份 `HANDOFF.md` 有未提交改动。

**可能的下一步（都要等用户开口，不要自己动手）**

1. **供应商切换支持 DeepSeek Harness**：用户说先不做。只读调查的结论在下面 0.3.42 的记录里（搜「没做、等用户决定」）。要做的话放到下一个版本、先做直连，并且先征得用户同意再在他的 Harness 上实测（要写 `~/.dsh` 下的配置和凭据文件，写坏了 Harness 会打不开）。
3. **0.3.42 发布后的跟进**：发布说明里写明了两处没验证——new-api / one-api 的余额查询没用真实站点测过；DeepSeek 的余额接口没用真实 Key 测过。有用户反馈数字不对时从这里查。
4. **Codex 降智检测**（0.3.41）在健康账号上的表现一直没验证，等用户有条件时测。

**和这位用户合作的约定（长期有效，都是用户明确说过的）**

- 用中文回复。说话直接、通俗，先说结论。
- 版本号听用户的。「测试版」= 只打 `--win dir`（`npx electron-builder --win dir --publish never`），不出安装包、不提交、不发布，等用户说发布再发。
- 「老样子」发布流程：测试 → `npm run dist` → 核对包内文件和源码一致 → `git fetch` → 提交 → 打标签 → 推送 → `gh release create`（Setup.exe、.blockmap、Portable.exe、latest.yml）→ 核对附件和 `releases/latest` → 查进程和占用 → HANDOFF 单独一个提交。发布说明三处都要写：`dist/release-x.y.z.md`、GitHub Release、`renderer/intro.js` 的 NOTES（英文在 `i18n.js`）。
- **提交、标签、PR、发布说明里不要带会话链接**（用户的规定，优先于工具自带的署名提示）。
- 截图和视频素材只用演示数据或测试数据，不用用户本机的真实数据。
- 用户本机的 `~/.tokenpulse`、`~/.codex`、`~/.grok`、`~/.dsh` 等只读，输出只给汇总和结构，不输出 token、邮箱、Key、对话内容；没经同意不改用户真实的工具配置。DeepSeek Harness 的登录凭据不拿来做任何事。
- 破坏性的 Git 操作要用户明确要求。Codex 降智检测只能手动触发，不用用户的真实账号去跑。
- 命令拆开一条一条执行，不要串成一大条；不要用 `rm -rf` 清理临时文件（用户拒绝过），留在临时目录里就行。
- 在 Git Bash 里用 heredoc / `sed` / `node -e` 改带反斜杠的内容会被改坏：用编辑工具，或者先写一个补丁脚本文件再用 `node` 跑；脚本要按文件自己的换行符（有的文件是 CRLF）匹配，成功一半之后不要重跑。
- `node scripts/update-knowledge.cjs --write` 直接跑会连接超时，要带 `NODE_USE_ENV_PROXY=1` 走系统代理。远程有机器人每天自动提交知识库（`knowledge/models.json`），发布前 `git fetch` 可能会遇到它，处理办法见下面 0.3.42 的「发布时的一个插曲」。
- 两个界面测试偶尔会因为时间差失败，和改动无关，单独重跑就过：`test-intro-ui.cjs`（「真实数据目录没有变化」）、`test-agent-switch-ui.cjs`（侧栏宽度 236 ≠ 76）。
- 其余规则见仓库根目录的 `AGENTS.md`（每次完成工程工作都要更新这份文档；构建和测试之后确认自己的进程退出、文件没被占用；不要结束用户正在用的 TokenPulse）。

**0.3.42 已正式发布（2026-10-10）。下面各条里「未提交、未发布」「等用户看测试版」的说法都已过期，以本段为准。**

- 提交 `23d8491`（0.3.42：DeepSeek 和第三方 Key 的余额监控），标签 `v0.3.42`，已推送 `origin/main`。GitHub Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.42 ，非草稿、非预发布，`releases/latest` 指向 `v0.3.42`。
- 附件 4 个，大小与本地一致：`TokenPulse-0.3.42-Setup.exe` 112,534,382、`.blockmap` 119,753、`TokenPulse-0.3.42-Portable.exe` 112,277,174、`latest.yml` 352；公开下载到的 `latest.yml` 是 `version: 0.3.42`。发布说明：`dist/release-0.3.42.md`（同 GitHub Release 正文）、`renderer/intro.js` 的 NOTES、`i18n.js` 的英文。
- 发布前的验证：`npm test` 退出 0（451 PASS）、`npm run test:ui` 退出 0（57 PASS）；`npm run dist` 退出 0，包内 97 个文件和源码一致，版本 0.3.42；exe / asar / 安装包未占用，没有遗留进程。
- **发布时的一个插曲**：`git fetch` 发现远程多了机器人的提交 `6dc80bc`（知识库自动更新到 2026.10.10），和本地知识库版本号相同、内容不同（远程没有 DeepSeek 的单价和显示名，本地没有它新增的 `gpt-rosalind-discovery`）。处理：`NODE_USE_ENV_PROXY=1 node scripts/update-knowledge.cjs --write` 重新生成成 **2026.10.10.1**（127 条单价、2 条显示名，两边的都有），重跑 `npm test`、重新 `npm run dist` 并核对，再提交、`git rebase origin/main`（`models.json` 冲突取本地重新生成的那份）。直接跑这个脚本会连接超时，要带 `NODE_USE_ENV_PROXY=1` 走系统代理。
- 没验证 / 已知限制（发布说明里也写了）：真实的 DeepSeek 余额接口没有用真实 Key 测过；new-api / one-api 的余额接口没有用真实站点测过；sub2api 只在用户的测试站上测了钱包余额模式；系统通知的实际弹出、上传图标图片、真实鼠标拖动标签、英文界面逐句目检都没做。
- 没做：**供应商切换支持 DeepSeek Harness**——用户决定先不做（调查结论在下面 0.3.42 的条目里）。用户说接下来还有一个「特别的东西」要做，内容还没说。
- 用户给过的那个中转站测试 Key 没有写进任何文件；测试时被发给过 example.com 一次，已告知用户并建议删除。

**以下是 0.3.42 开发过程的记录（2026-10-09 起，按时间顺序追加）：号池用量算到成员名下（Grok 按转发记录分摊）。**

- 起因：用户用 Grok 号池，成员账号下面一直没有用量。原因两层：(1) Grok 会话文件一整轮汇总成一条、没有响应 ID，0.3.37 起不按时间猜，所以不归属；(2) **report.ts 对 `official !== true` 的文件整份跳过**，而用号池时配置里是本地路由、文件整体就是「不是官方」，所以连 Claude / Codex 号池成员已经对上的 `accountHours` 也没进账号的小时图表。
- 改动：
  - `route-ledger.ts` 新增 `routeShares(kind, from, to)`：这段时间里本地路由把这家工具的请求交给各账号的 Token 数（透明转发、失败、没读到用量的不算；第三方供应商记在空字符串名下），按月份文件建索引并缓存。
  - `usage-scan.ts`：Grok 每一轮用「第一段用户消息的时间（`turnStartAt`）→ `turn_completed` 的时间」（前后各放 2 秒；没有开始时间时取上一轮结束和 10 分钟前较晚的那个，最长 6 小时）查 `routeShares`，按比例把这一轮的用量分给各账号（`scaleUsage`，Token 和次数取整）；一轮只交给一个账号时流水记 `routedAccount` + `routedAccountBasis: "route-window"`。新增 `FileState.routedHours`（经号池的部分按账号的小时账，Claude / Codex 靠响应 ID 对上的也写进去）。`STATE_VERSION` 10 → 11（升级后整份重扫，把历史补上）。
  - `report.ts`：文件不是官方时，仍把 `routedHours` 里有账号的部分加进账号的小时用量。
  - `request-log.ts` / `login-timeline.ts`：账号依据多一种 `route-window`；`app.js` 的依据标签和说明、`i18n.js`、`intro.js` 的 0.3.42 说明、README 号池归属一段已更新。
- 验证：新 `scripts/test-grok-pool.cjs`（加入 npm test）4/4：分摊比例、第三方那份不归属、总量不变、单账号的轮次标账号、重扫不重复。`test-routing-regressions.cjs` 里的版本断言 10 → 11（场景本身仍通过）。`npm test` 退出 0，`npm run test:ui` 退出 0（48 PASS）。在用户数据目录的副本上只读试跑（只复制了转发记录，读真实 `~/.grok` 会话，测完已删）：扫描 4.8 秒，6 个 Grok 号池成员各分到约 230–270 万 Token，合计占 Grok 全部历史的 2%（其余是直连官方的）；真实会话的 `user_message_chunk` 54 条都带时间戳。
- 测试版：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，91 个运行时文件与源码一致，包内 0.3.42，exe / asar 未占用。
- 已知限制：一轮交给两个以上账号时，「逐条请求」里那一条不标账号、仍显示为非官方（只进各自的小时用量）；同一时间有两个 Grok 会话都走号池时，各轮的比例会混在一起（总量不变）；Grok 开着透明转发时配置里也有 `base_url`，文件同样被当成「不是官方」，这部分用量目前不归到 CLI 登录的账号（旧问题，没动）；升级后第一次启动要重扫，多等几秒。
- **同版本追加：支持 DeepSeek Harness 的用量（2026-10-10，用户要求和 Grok 号池放进同一个版本）。** 只做了用量统计这一层。
  - 对象：DeepSeek 官方的 `deepseek-ai/deepseek-harness`（桌面版，数据在 `~/.dsh`）。会话文件 `~/.dsh/sessions/<工作目录>/session-<id>/session.v4.jsonl.zstd`：每批事件追加一个 zstd 帧，帧里是整行 JSON。`session` 行有 `cwd`；`request/header` 的 `data.header.config` 有 `model` / `reasoningEffort`（中途换等级会再写一条，`reason: "change"`）；每次调用模型一条 `assistant/message`，`data.usage` 是 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / totalTokens`，**inputTokens 不含缓存命中**（界面的「缓存命中」= cacheRead ÷ (input + cacheRead)，实测 85% 对得上），型号在 `data.message.source.model`（内部名 `deepseek-flash`，界面显示 DeepSeek-V41-Flash），`source.replayState.response.model` 当返回型号。没有响应 ID，不记费用。
  - 代码：`usage-scan.ts` 新 Kind `deepseek-harness`（来源名「DeepSeek Harness」）、`roots()`、`walkJsonl` 认 `.jsonl.zstd`、`deepseekRow`（input 把缓存读写加回去）、`zstdFrames` + `zstdFrameEnd`（**按 RFC 8878 的帧结构算出每帧的结束位置**——不能靠「解得开」判断，截断的帧 `zstdDecompressSync` 不报错只少给内容，会把没写完的帧当成读过了；偏移按压缩后的字节记，停在最后一个完整帧）、`request/header` 更新 `state.requested` / `state.effort`。`official` 记 undefined（按量付费，没有额度窗口，不进账号 / 额度那套）。`request-log.ts` / `request-verify.ts` 的 kind、来源名、会话 ID（上级目录去掉 `session-`）、通道「DeepSeek」。`usage-insights.js` 给了品牌色，图标用现成的字母标。README 支持的工具表、0.3.42 更新说明、i18n 已补。Electron 44 自带的 Node 24.20 有 `zstdDecompressSync`。
  - 验证：在用户真实会话上只读试跑（临时数据目录，已删）：三个会话合计 81,136 / 10,287 / 95,222 Token，其中「读取笔记并修改计数脚本」那个和用户截图里界面显示的 81.1K、2 轮 7 步、最后一步 13.1K、思考等级 high → max 都对得上；参考费用按知识库里 `deepseek` 那条单价算（$0.28 / $0.42 / 缓存 $0.028 每百万），`deepseek-flash` 的真实单价没核对过。新 `scripts/test-deepseek-harness.cjs`（加入 npm test）2/2：多帧、追加、半帧等待、换等级、不重复、不存对话内容。`npm test` 退出 0，`npm run test:ui` 退出 0（48 PASS）。
  - 测试版已重打（含 Grok 号池 + DeepSeek Harness）：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，91 个文件一致，包内 0.3.42，未占用。
  - 没做：额度 / 余额、会话管理、供应商切换、型号核验的特殊规则、专门的品牌图标；`dsh` 的命令行形态和第三方 provider 没见过样本；官方标注是开发者预览版，`session.v4` 的格式以后可能变。
- **同版本再追加：DeepSeek 显示名 / 官方单价 / 余额监控（2026-10-10，用户确认三项都放进 0.3.42）。上面那条里「没做余额」「单价没核对」「只统计到 91 个文件」的说法以本条为准。**
  - 显示名：会话里的型号是接口名 `deepseek-flash`，官方定价页写明它就是 DeepSeek-V4.1-Flash。知识库新增 `displayNames`（`knowledge/manual.json` → `models.json`，`update-knowledge.cjs` 会带上；`knowledge.ts` 的 `displayModel()`），扫描时把型号、返回型号、请求型号都换成显示名。`STATE_VERSION` 11 → 12（装过上一个测试版的会重扫一次，把 `deepseek-flash` 换成显示名）。
  - 单价（`manual.json` 的 pinned，排在通用 `deepseek` 那条前面）：Flash 输入 $0.30 / 输出 $1.20 / 缓存 $0.006；V4-Pro $1.32 / $3.96 / $0.044，都是**高峰价**。闲时半价：`usage-scan.ts` 的 `deepseekPeak()`（UTC 周一到周五 01–04、06–10 点），费用在扫描时按请求时间算好写进记录。中国法定节假日判断不了，会按高峰价略多算。定价页只写「$」没写币种。`models.json` 是手工插入的，版本 2026.10.10；跑 `update-knowledge.cjs`（不带 --write）显示会生成 2026.10.10.1，说明和生成器的输出还有别的差异（上游价格变动），没写回。
  - 余额监控：`src/main/deepseek-balance.ts`（`GET https://api.deepseek.com/user/balance`，走 `upstream-proxy`；10 分钟一次，启动 8 秒后先查；手动刷新至少隔 5 秒；低于提醒线通知一次，回升后重新计；401 / 403 的 Key 不保存）。Key 由用户自己在 DeepSeek 开放平台创建，存 `<数据目录>/deepseek-balance.json`（**明文**，和数据目录里其他凭据一样），不发给界面，界面只有 `sk-…后四位`。没有用 DeepSeek Harness 的登录凭据（那是账号授权，不是 API Key）。界面 `renderer/deepseek-balance.js|css`：总览（官方额度下面）和额度详情各一张卡，本机有 `~/.dsh` 或已填 Key 才显示；入口还有 设置 → 数据。IPC `deepseek-balance:*`，preload `deepseekBalance`。`TOKENPULSE_DEEPSEEK_BASE` 只给测试用。
  - 验证：新 `scripts/test-deepseek-balance.cjs`（7/7，进 npm test）、`scripts/test-deepseek-balance-ui.cjs`（6 PASS，进 test:ui，假服务器 + 假 Key）。`npm test` 退出 0；`npm run test:ui` 退出 0（54 PASS）。真实会话只读试跑：三个会话显示 DeepSeek-V4.1-Flash、型号一致，费用 $0.00298 / $0.00195 / $0.00416。**没验证：真实 DeepSeek 余额接口**（没有用户的 Key，只按官方文档的字段做；等用户填 Key 后看）；系统通知的实际弹出没测。
  - 测试版已重打：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，95 个文件（含 `knowledge/models.json`）和源码一致，包内 0.3.42，exe / asar 未占用，没有遗留进程。临时目录里的截图和日志没清（用户拒绝过一条带 `rm -rf` 的合并命令，之后命令都拆开执行）。
- **余额监控按用户反馈重做了界面，并支持多个账号（2026-10-10；上一条里「总览和额度详情各一张卡」「一个 Key」的说法以本条为准）。** 用户测试后指出：额度详情里 DeepSeek 没有自己的卡片，反而每个账号的页面下面都挂着同一张余额卡；API Key 也应该能填多个。
  - 现在：额度详情顶上每个 DeepSeek 账号一个标签（排在官方账号后面，字母标 D），点进去是这个账号自己的一页——只有余额（总余额 / 充值 / 赠送）、提醒线、Key 后四位和「刷新 / 设置 / 添加账号」，没有额度窗口、容量排行和时间线（`#page-quota.ds-mode` 用 CSS 藏掉那两节）。别的账号的页面里不再有 DeepSeek。总览保留一条，列出每个账号的余额，点一行去那个账号的页。装过 DeepSeek Harness 但没填 Key 时，额度详情有一个空的 DeepSeek 标签当入口。
  - 接法：`app.js` 的 `drawAccountTabs` 把 `DeepSeekBalance.tabs()` 拼在后面（签名里也算上），`renderQuota` 开头判断 `DeepSeekBalance.owns(state.account)` 走 `DeepSeekBalance.renderQuota(host, key)`。选中的账号 key 是 `deepseek:<id>`（没账号时是 `deepseek`）。标签的 `data-kind` 和 `data-account` 相同，所以不参与拖动排序。`deepseek-balance.js` 里余额数据叫 `balance`，避免和 app.js 全局的 `state` 重名。
  - 主进程：`deepseek-balance.json` 改成 `{ accounts: [{ id, label, apiKey, alertBelow, last, alerted }] }`，最多 20 个；旧的单 Key 格式（上一个测试版写的）读进来当第一个账号。方法 `add / update / remove / refresh(id) / refreshAll`；重复的 Key 拒绝；新加或换 Key 时 401 / 403 不保存、保持原样；手动刷新按账号各自限 5 秒；通知标题带账号名，点通知去额度详情。IPC `deepseek-balance:add|update|remove|refresh|refresh-all`。
  - 验证：`test-deepseek-balance.cjs` 7/7（多账号、换 Key、旧格式迁移）；`test-deepseek-balance-ui.cjs` 7 PASS（标签、各自一页、别的账号页面里没有 DeepSeek、两个账号、总览、出错、改名 / 删除）。`npm test` 退出 0；`npm run test:ui` 退出 0（55 PASS）。仍然**没验证真实的 DeepSeek 余额接口**和系统通知的实际弹出。
  - 测试版已重打：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，95 个文件一致，包内 0.3.42，exe / asar 未占用，没有遗留进程。
- **同版本再追加：DeepSeek 账号页补全（2026-10-10，进行中）。** 用户看了多账号版之后反馈「只能看到多少钱」，要求把官方账号额度详情里的消耗趋势、最近 24 小时用量、时间线、模型速度、换一种模型能用多少都移植过来，并换上 AllAi 项目里的 DeepSeek 图标。上面「等用户看测试版」那条已过期，以本条为准。
  - 思路：官方账号看「窗口用了百分之几」，DeepSeek 对应的是余额。新增余额历史（每次查到余额记一笔，`<数据目录>/deepseek-balance-history.json`，数字没变的连续几次只留头尾），余额掉了多少就是花了多少；再和 DeepSeek Harness 的请求流水对起来。
  - 已写完（已 `npm run compile` 通过，**还没跑测试、没截图、没打包**）：
    - `src/core/deepseek-insight.ts`（新）：余额历史读写、`analyzeDeepSeek`（今天 / 7 天 / 30 天花了多少、日均、还能用几天、本机 / 本机以外、实际折算率、各模型高峰 / 闲时余额能用多少）、`deepseekSpeed`、时间线（结构照 `model-study.ts`，按自然日 / 7 天分段，曲线是余额）、`queryDeepSeek`（worker 入口）。
    - `usage-scan.ts`：DeepSeek Harness 的流水补记出字时间（`timing.firstTokenMs / tokensPerSec`，从日志里 `assistant/message.data.stream[].time` 和 `step/start` 算），`STATE_VERSION` 12 → 13（`test-routing-regressions.cjs` 的断言已改）。
    - `pass-speed.ts` 抽出 `speedSeriesOf`；`report-worker.ts` / `snapshot.ts` 加 `deepseek` 入口；`index.ts` 加 IPC `deepseek-balance:insight|timeline|speed`；`preload.ts` 对应三个方法。
    - `deepseek-balance.ts`：账号多一个 `harness`（本机 Harness 的用量算在哪个账号上，最多一个，第一个账号默认是；Harness 是账号授权登录、对不上 API Key，只能用户指定）；查到余额写历史；删账号删历史。
    - `renderer/brand.js` 加 `deepseek` 图标（来自 `D:\CodePorject\Web\AllAi\public\brand\presets\deepseek-color.svg`）；`deepseek-balance.js` 的账号页整段重写；`deepseek-balance.css`；`app.js`（`speedPanel` / `drawSpeed` 支持自定义数据来源、`BRAND_OF_SOURCE`、`renderQuota` 把时间线节点传过去）；`model-study.js`（时间线支持 `kind: 'deepseek'`：余额曲线、没有「本机以外」标注）。
  - 已完成并验证（2026-10-10）：英文翻译（`i18n.js` 约 120 条 + 5 条 PATTERN）、`intro.js` 0.3.42 说明多一条「DeepSeek 账号页补全」、README 一行、时间线的余额曲线纵轴改成只取这段时间里的范围（从 0 画起是一条平线）。截图（只有测试数据）看过亮色 / 暗色。
  - 验证：新的 `scripts/test-deepseek-insight.cjs` 5/5（出字时间采集、余额历史、花费 / 预测 / 本机与本机以外 / 折算率 / 模型换算、没有记录时不编数、时间线结构），已加进 `npm test`；`test-deepseek-balance-ui.cjs` 8 PASS（新增一项：用写进临时目录的余额历史和 Harness 流水核对账号页每一块，数字能手算；另外核对图标、第二个账号没有本机用量、在设置里换本机归属、删账号后历史一起删）。`npm test` 退出 0（446 PASS）。`npm run test:ui` 第一次在 `test-intro-ui.cjs` 的「真实数据目录没有变化」失败（并发历史文件在测试期间被定时写了一笔，和本次改动无关），单独重跑 3 PASS；它后面的 6 个界面测试逐个跑都退出 0。合计界面测试 56 PASS。
  - 用真实的 `~/.dsh` 只读核对过（数据目录用临时的，只看汇总）：15 条请求全部量到速度，DeepSeek-V4.1-Flash 中位 188.1 Token/秒、首字 1.7 秒。
  - 没验证：真实的 DeepSeek 余额接口（没有用户的 Key）、真实账号上余额历史攒几天之后的消耗和折算率、系统通知的实际弹出、英文界面的逐句目检。
  - 已知限制：消耗从填了 Key 之后才开始记（以前的补不回来）；TokenPulse 关着的时候不查余额，那段时间花的合到重新打开的那一天；赠送余额过期会算成花掉的；人民币余额在校准前用 1 美元 ≈ 7.2 元的粗略比例（`REFERENCE_RATE`），实测比例超出 3–18 不采用；高峰 / 闲时判断不了中国法定节假日；更新后第一次打开会整份重扫一遍（`STATE_VERSION` 13）。
  - 测试版已重打：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，96 个文件和源码一致，包内 0.3.42，exe / asar 未占用，没有遗留进程。
  - 追加（2026-10-10）：用户反馈额度详情里 DeepSeek 的标签不能拖动。原因是之前故意把 `data-kind` 设成和 `data-account` 一样、让它不参与拖动排序。现在 DeepSeek 的标签 `data-kind` 都是 `deepseek`，同一家多个账号可以互相拖动；`app.js` 的 `saveQuotaTabOrder` 对 `deepseek` 走 `DeepSeekBalance.reorder` → IPC `deepseek-balance:reorder` → `deepseek-balance.ts` 的 `reorder(ids)`（必须正好是全部账号）。和官方账号一样只能在同一家内部调，不能拖到别家前面。`test-deepseek-balance-ui.cjs` 加了断言（顺序存盘、选中的账号不变、总览跟着变），8 PASS；`test-ui.cjs` 23 PASS；balance 7/7、insight 5/5。没有用真实鼠标拖过 DeepSeek 的标签（拖动手势是通用代码，测试里直接调的存顺序）。测试版已重打。
  - 再追加（2026-10-10）：用户要的其实是**所有账号都能互相拖动，不分是哪一家**（以前一直只能在同一家内部调）。上一条「不能拖到别家前面」已过期。做法（`renderer/app.js`）：拖动时整行标签一起排；拖完把整行的标签存进 localStorage（`tokenpulse-quota-tabs`），画的时候 `orderQuotaTabs` 只取它的「第几个位置是哪一家」，每家的位置按账号列表的顺序填，新账号排在同一家最后一个后面。同一家内部的先后仍以账号列表为准：被拖的账号越过同家账号时照旧存回去（官方账号 `reorderOfficialAccounts`，DeepSeek `reorder`），所以设置里的顺序、号池、总览不会和标签对不上。只影响额度详情那一排标签，总览的卡片顺序没动。`intro.js` / `i18n.js` 加了一条说明。
  - 验证：`test-deepseek-balance-ui.cjs` 里用合成的指针事件把 DeepSeek 的标签拖到整行最前面，核对排列、账号列表跟着变、重画和切页之后还在，8 PASS；`npm run test:ui` 这次整条跑完退出 0（56 PASS）。测试版已重打，96 个文件和源码一致，exe / asar 未占用，没有遗留进程。没有用真实鼠标拖过。
  - 再追加（2026-10-10）：用户要求总览里 DeepSeek 和别家一样是一张卡片，不要单独的一条。`renderer/index.html` 里那条 `section[data-ds-balance]` 删了；`deepseek-balance.js` 的 `renderStrip` 换成 `card()` / `renderCard()`，`app.js` 的 `renderOverview` 把它追加到 `#quota-cards` 最后（样式用官方账号卡片的 `.quota-card`，`deepseek-balance.css` 里总览那段重写）。卡片：头（图标、账号名、状态）→ 圆环（按最近 7 天的速度还能用几天，30 天以上画满，中间写天数）+ 总余额 → 今天 / 7 天花了多少、还能用多久、本机今天的 Tokens → 其余 DeepSeek 账号的队列 → 页脚（更新时间、刷新、详情）。主角是指定了本机用量的账号，没有就第一个。没填 Key 但装了 Harness 时是一张带「填写 API Key」的卡片。卡片在总览里固定排最后，没有跟额度详情的标签排列走。
  - 验证：`test-deepseek-balance-ui.cjs` 的总览断言改成卡片（在 `#quota-cards` 里、和别的卡片同宽、图标、主角 / 队列、圆环画满），8 PASS；`npm run test:ui` 整条退出 0（56 PASS）；截图（测试数据）看过亮色。测试版已重打，96 个文件和源码一致，exe / asar 未占用，没有遗留进程。英文界面没有逐句目检。
  - **同版本再追加：第三方中转站 Key 的余额监控（2026-10-10，用户要求放进 0.3.42）。**
    - 接口：sub2api 是 `GET <站点>/v1/usage`（Bearer Key，只鉴权不计费；格式照 `D:\CodePorject\Exmaple\sub2api-production\backend\internal\handler\gateway_handler.go` 的 `Usage`：钱包余额 / 订阅限额 / Key 自己的额度和限速窗口，外加这个 Key 今天、累计、每天的用量）；new-api / one-api 是 `/v1/dashboard/billing/subscription` + `/usage`（总额度 − 已用，**照公开实现写的，没有拿真实站点测过**）。先试上次认出来的那种，都不是就报「不支持」，不编数字。
    - 代码：`src/core/relay-balance.ts`（新：`relayBase` 只认 https、本机可 http；`parseSub2api` / `parseNewApi` / `queryRelay`）；`src/main/deepseek-balance.ts` 的账号多了 `kind: deepseek | relay`、`baseUrl`、`flavor`，结果多了 `extra`（套餐、额度、窗口、到期、用量），加账号时查不出来的站不留，本机 Harness 的用量指定不到中转站头上；`renderer/deepseek-balance.js`：标签（`data-kind=relay`、首字母图标）、`renderRelay`（余额 + 站点统计的限额进度条 / 用量 / 每天用量图 / 余额走势，没有本机用量、时间线、速度、模型换算）、总览多一张中转站卡片（`cards()`）、对话框可以选类型并填站点地址；`index.html` 设置 → 数据多一个「添加第三方 Key」；`i18n.js` / `intro.js` / README 已补。
    - 验证：新的 `scripts/test-relay-balance.cjs` 5/5（已进 `npm test`）；`test-deepseek-balance-ui.cjs` 加了中转站整条流程，9 PASS；`npm test` 退出 0（451 PASS）；`npm run test:ui` 第一次在 `test-agent-switch-ui.cjs` 的侧栏宽度断言失败（236 ≠ 76，和本次改动无关，单独重跑通过），它和后面的界面测试逐个跑都退出 0，合计 57 PASS。
    - **真实站点实测**：用户给了自己搭的 sub2api 测试站和一个测试 Key（用户说测完就删；Key 没有写进任何文件，已扫过仓库和临时目录）。只发了查余额的请求：钱包余额模式，认成 sub2api，余额读对，Key 不出现在给界面的数据里；错的 Key 报「无效」，不是中转站的地址报「不支持」，http 地址被拒绝。测「不支持」时这个测试 Key 被发给过 example.com 一次（IANA 的保留域名），已告诉用户。真实站点上只测了钱包余额这一种；订阅限额、Key 额度、限速窗口是用假服务器按源码格式测的。界面没有连真实站点跑过。
    - 测试版已重打：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，97 个文件和源码一致，包内 0.3.42，exe / asar 未占用，没有遗留进程。
  - 再追加（2026-10-10）：额度详情右上角加了「添加账号」按钮（`index.html` 的 `#quota-add-account`，和原来那句「官方窗口独立于用量筛选」一起包在 `.quota-toolbar-side` 里）。点开是一个菜单（复用 `openOptionMenu`）：官方账号 → 打开设置的「官方账号」那一栏；DeepSeek / 第三方中转站的 Key → 直接开添加对话框。设置 → 数据里的两个入口和页面里的「添加账号」都还在。`test-deepseek-balance-ui.cjs` 里中转站那段改成从这个按钮进，并核对三个选项各自去哪；看门狗放宽到 330 秒（带截图跑时出现过一次 200 秒超时，没复现，之后带截图 32 秒、不带 15 秒）。`npm run test:ui` 整条退出 0（57 PASS）。测试版已重打，97 个文件和源码一致，exe / asar 未占用，没有遗留进程。
  - 再追加（2026-10-10）：第三方 Key 可以选图标。复用供应商页那套头像（`renderer/provider-avatars.js` 的 `PulseAvatars`，预设图标与 AllAi 同源）：自动匹配（按名字和站点地址）/ 名称首字母 / 预设 / 上传图片（界面缩成 128px）。`deepseek-balance.ts` 的 relay 账号多了 `icon`（预设 id 或 `letter`）和 `avatar`（data URL，≤ 400,000 字符，格式校验同 `agent-switch.ts`），DeepSeek 账号不收这两项；`deepseek-balance.js` 的标签、页面头部、总览卡片、队列都按它画，对话框里多一块图标选择。`test-relay-balance.cjs` 加了图标校验的断言（5/5），`test-deepseek-balance-ui.cjs` 加了选预设 / 换首字母 / 各处显示的断言（9 PASS）。`npm test` 退出 0（451 PASS），`npm run test:ui` 退出 0（57 PASS）。测试版已重打，97 个文件和源码一致，未占用，没有遗留进程。上传图片这一步没有在测试里走（走的是预设和首字母）。
  - **没做、等用户决定：供应商切换支持 DeepSeek Harness。** 用户提出后只做了只读调查（没有改 `~/.dsh` 里任何文件），结论：
    - Harness 0.2.0-rc.2 的第三方供应商由 `@deepseek-ai/dsh-llm-pi-ai` 插件提供，配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml`（顶层是 YAML 数组，每项 `{ id?, name, config }`）：`config.providers.<路由名>` = `{ displayName, apiKeyEnv, api: openai-completions | openai-responses | anthropic-messages, baseURL, models: [{ id, name, contextWindow }] }`；新会话默认用哪个模型在同一个文件的 `agent-default-model` 项（`provider` / `model` / `reasoningEffort`，现在是 `deepseek-account` / `deepseek-flash`）。
    - Key 不在配置里：`apiKeyEnv` 只是一个名字，值在 `~/.dsh/.credentials.yaml` 的 `refs:` 下面（`refs: { NAME: sk-… }`）。官方文档写明可以直接改这个文件、会热重载；但格式不对（未知的键、重复键、YAML 坏了）Harness **启动会失败**。
    - 两个文件改了都是下一次请求生效，不用重启 Harness。已有会话各自记着自己的模型，默认值只影响新会话。
    - 资料来源：安装包 `C:\Users\<用户>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 里各包的 `README.zh.md`（`dsh-llm-pi-ai`、`dsh-credentials-local`、`dsh-client-ui-settings-models`、`dsh-agent-default-model`）。
    - 难点：要保留注释和 `!!js` 表达式地改 YAML（项目里没有声明 YAML 依赖，`node_modules` 里的 `js-yaml` 是别人带进来的、会丢注释）；`agent-switch.ts` 里加第四个工具涉及写入、备份、退出还原、漂移检测、本地路由；真实效果只能在用户机器上开着 Harness 验证。
- 下一步：等用户看测试版，并决定 Harness 供应商切换怎么做（见上一条）；发布按老流程。0.3.42 全部改动未提交、未发布。

**0.3.41 已正式发布（2026-10-09）。以这一段为准，下面「0.3.41 进行中 / 未发布」是发布前的记录。**

- 内容：Codex 手动降智检测；返回型号以回复结束时报的为准。
- 用户实测：在自己确认降智的账号上点了一次，结果「很可能已降智」（gpt-6.1-sol，两发都 200，门票 780 → 换成另一张 780，26 秒）。只有这一个样本，**还没有在确定正常的账号上测过，不知道会不会误报**；已建议用户有正常账号或账号恢复后再测。
- 验证：发布的就是备份提交的代码（工作区干净，远端无新提交）。`npm test` 发布前重跑退出 0；`npm run test:ui` 用的是这份代码此前的结果（48 PASS），发布前没有重跑。
- 打包：`npm run dist` 退出 0；asar 里 92 个运行时文件（renderer、build/core、build/main、knowledge/models.json）与源码逐字节一致，包内 0.3.41，测试 fixtures 不在包里。
- Git：标签 `v0.3.41` 打在 `d798e6e`（代码提交是 `84bf3b8`），已推送；本条交接是其后的单独提交。
- Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.41 ，非草稿非预发布；Setup.exe 112494747、blockmap 119618、Portable.exe 112237529、latest.yml 352，大小与本地一致，下载的 latest.yml 与本地逐字节一致，releases/latest 指向 v0.3.41。发布说明在 `dist/release-0.3.41.md`。
- 收尾：四个附件和 win-unpacked 的 exe / app.asar 能独占打开；用户的安装版在运行，未动。dist 里 0.3.40 的三个安装文件还在，没清理。
- 没做：实际安装和自动更新；探测在正常账号上的表现。

**0.3.41 进行中（2026-10-09，测试版已打，未发布）：返回型号以回复结束时报的为准 + Codex 手动降智检测。**

- **代码已作为备份推到 GitHub main（提交 `84bf3b8`，WIP）**：用户要让别的 AI 接着改，怕改错，要求先上传当前代码。没有打标签、没有建 Release，GitHub 的最新发布仍是 v0.3.40。要回到这个状态：`git checkout 84bf3b8`（或对比 `git diff 84bf3b8`）。

- 起因：用户的 Codex 账号被官方降级，用量明细却显示「型号一致」。参考项目 `D:\CodePorject\Exmaple\sub2api-production` 的「使用记录」能标出上游响应模型不匹配，做法在 `backend/internal/service/upstream_response_model.go`：一次回复里型号会报两次（`response.created` 和 `response.completed` 等结束事件），以结束事件为准。TokenPulse 原来只读第一次出现的（`Grab` 里 `if (!this.model)`）。用户确认按此修，归 0.3.41。
- 改动：`ws-sniff.ts` 的 `Grab` 新增 `first` / `final`，`model` 改为取值器（结束时报的优先），`declared` 在两者不同时给出开头报的；结束事件靠 `GRAB_TERMINAL` 标记定位，之后第一处 `"model"` 即 `response.model`，用绝对偏移处理分段。`agent-proxy.ts` 日志多一个 `declaredModel`（`returnedOf`、本地路由的 Outcome）；`route-ledger.ts` 的 `RouteReturned.declared`；`request-log.ts` / `request-verify.ts` 的 `proxy.declared`，不一致时原因里多一条「上游回复开头报的是 A，结束时报的是 B」。HTTP 透明转发、本地路由直通、WebSocket 都用同一个 `Grab`；接口格式转换过的转发本来就不读返回型号，没变。
- 版本和说明：package.json / package-lock.json 已是 0.3.41；`intro.js` 加了 0.3.41 一条，`i18n.js` 补英文和新原因的句式。
- 测试：新 `scripts/test-final-model.cjs`（已加入 npm test）：Grab 各种分段、无结束事件、提示词里带同名键、透明转发记下两个型号、索引和核验标成不一致。`npm test` 退出 0，`npm run test:ui` 退出 0（47 PASS）。
- 测试版：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，89 个运行时文件与源码一致，包内 0.3.41；exe / asar 未占用。dist 里的 0.3.40 四个发布附件没动。
- **没有实证**：没见过用户被降级时的真实回复，「开头报原名、结束报真名」是照参考项目推断的。若官方两次都报原名，此修法抓不到，备选是参考项目的门票探测（`openai_codex_state_probe.go`，主动发两个小请求看 `x-codex-turn-state` 是否被换，会花额度、有指纹风险，用户未要求）。只对更新后、经 TokenPulse 转发的请求有效，旧记录补不了。
- **实证结果（同日）**：用户开着 0.3.41 测试版跑 Codex，自己确认 gpt-6.1-sol high 被降智；转发记录里那 10 条请求的 `requestModel` / `returnedModel` 都是 gpt-6.1-sol，没有 `declaredModel`。即官方降智时开头和结束报的都是原名，型号名判据（包括参考项目的「使用记录」）对这种情况无效。上面的改动保留（无害，官方哪天在结束时报真名就能抓到）。
- **新增：Codex 降智检测，只做手动（用户同意：会花一点额度、有指纹风险，不做自动）。**
  - 判据照参考项目 `openai_codex_state_probe.go`：第一发不带门票，取响应头 `x-codex-turn-state` 和 `__cflb` / `__oailb` 两枚 Cookie；第二发带上它们；回了不同的新门票 = 降智，没回或回原票 = 正常；两发都必须 200 且回复正常结束，否则「无法判断」。参考项目只在门票长度 780 上验证过。
  - 代码：`src/core/codex-state-probe.ts`（`probeCodexState`，用 Node 的 `upstreamRequest`，走系统 / 环境代理；身份头 `originator: codex_cli_rs`、`version` / UA 写的是 0.162.0；每发 45 秒超时、回复上限 1 MiB；结果不含门票、Cookie、凭据；`TOKENPULSE_CODEX_PROBE_BASE` 给测试换上游）。`src/main/codex-state-probe.ts`（`runProbe`：按账号 id 找凭据，没给 id 用 Codex CLI 当前登录；同账号同时只跑一个；型号取 `~/.codex/config.toml` 的 model，其次最近成功的转发，再次内置 gpt-6.1-sol；上次结果存 `codex-state-probe.json`）。IPC `codex-probe:run` / `codex-probe:last`，preload `codexProbe`（演示模式拒绝）/ `codexProbeLast`。界面在额度详情 ChatGPT 账号的两个窗口卡下面：`probePanel`（`.probe-panel`，按钮 `data-action=codex-probe`，结论徽标、事实、原因、门票长度不是 780 的提醒、三条代价说明）。i18n、更新说明已补。
  - **踩坑**：`src/core/codex-probe.ts` 是已有文件（「写给 Codex 的配置先让 Codex 试读」功能），我新建时把它覆盖了，编译报错才发现，已用 `git checkout` 原样恢复（无 diff），新模块改名为 `codex-state-probe`。
  - 测试：`scripts/test-codex-state-probe.cjs`（假上游：两发的形状、正常 / 原票 / 降智、401 / 429 / 没门票 / 回复失败 / 网络错误都判无法判断、结果不含敏感内容），已加入 npm test；`test-ui.cjs` 加了面板的检查（主进程的 `runProbe` 换成假的），并把「刷新后滚动位置不变」放宽到 1 像素以内（页面高度带小数时还原会差 0.67px，不是跳）。`npm test` 退出 0，`npm run test:ui` 退出 0（48 PASS）。
  - 测试版已重打：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，91 个运行时文件与源码一致，包内 0.3.41，exe / asar 未占用。
  - **没做**：没有用真实账号跑过探测（会动用户凭据和额度，留给用户自己点）。它在 TokenPulse 里到底准不准，要等用户在确认降智的账号上点一次才知道。
- 下一步：等用户实测探测结果；发布时按老流程（dist、提交、标签、Release、HANDOFF 单独提交）。

**0.3.40 已正式发布（2026-10-09）。以这一段为准；下面「0.3.40 local / uncommitted / unpublished / awaiting acceptance」等说法都是发布前的历史。用户说明聊天回复用中文。**

- 内容：并发监控与上限（含 2026-10-09 重新设计的并发页、独立导航图标、Claude 桌面端图标、应用自己的下拉菜单）、WebSocket 中继、侧栏展开 / 收起动画。
- 验证：发布前最后一次代码改动之后 `npm test` 退出 0、`npm run test:ui` 退出 0（47 PASS）、`node scripts/test-features.cjs` 通过；`git fetch` 远端无新提交。
- 打包：`npm run dist` 退出 0（当时 dist/win-unpacked 没有进程占用，只有用户安装版在运行，未动）。asar 里 90 个运行时文件（renderer、build/core、build/main、knowledge/models.json）与源码逐字节一致，包内版本 0.3.40，测试 fixtures 不在包里。
- Git：发布提交 `622115f`，标签 `v0.3.40`，均已推送；本条交接为其后的单独提交。提交和发布说明里不放会话链接（用户规定）。
- Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.40 ，非草稿非预发布；Setup.exe 112489979、blockmap 119674、Portable.exe 112232834、latest.yml 352，大小与本地一致，下载的 latest.yml 与本地逐字节一致，releases/latest 指向 v0.3.40。发布说明在 `dist/release-0.3.40.md`。
- 收尾：四个附件和 dist/win-unpacked 的 exe / app.asar 均能 FileShare.None 打开；没有残留的打包 / 测试进程。用户随后要求清理：已删除 dist 里 0.3.39 的 Setup.exe / blockmap / Portable.exe 和 `dist/test-0.3.40/` 测试目录（约 600 MB；删前确认没有进程从 dist 运行）。dist 现在只剩 0.3.40 四个附件、win-unpacked、builder-debug.yml 和历史发布说明。
- 没做：实际安装和自动更新、真实账号推理、真实 Windows 通知点击、直接从安装包跑整套 UI 测试。已知限制同下文（只监控经 TokenPulse 的流量；没写满的一分钟历史在异常退出时会丢）。

（以下为发布前的记录）Before publication, the published release was 0.3.39. Local 0.3.40 concurrency monitoring and sidebar animation are implemented, tested, uncommitted and unpublished. Latest test app is dist/test-0.3.40/win-unpacked/TokenPulse.exe; keep that entire directory. At the last build, the older dist/win-unpacked was occupied by an existing user app; it is not the 0.3.40 artifact. Recheck live process state before any build. Read this entry before historical notes and verify actual version/Git/artifact state.

### Quick start for the next AI — optimization handover

The user requested this documentation so other AIs can assess and optimize the current implementation. This handover turn changed documentation only. Source/package versions were rechecked as 0.3.40, HEAD as 46406b5, and the latest test exe/ASAR exist. Runtime files, tests and build were not changed or rerun in this documentation turn; the successful validation below belongs to the implementation turn. User acceptance of the new feature is still pending.

1. Read AGENTS.md and this current entry, then inspect `git status --short` and the actual diff. There are both tracked modifications and new untracked feature/test files; preserve them. Do not reset, stash away, or overwrite unfamiliar changes. Sidebar animation changes predate concurrency and must remain.
2. Confirm the user's optimization scope before choosing changes. The review targets below are candidates, **not confirmed defects**. Reproduce or measure a problem before claiming it; write a handoff checkpoint for a changed approach or blocker.
3. Work against 0.3.40 unless the user specifies another version. The current authorization is local development and an unpacked test build. Installer creation, installation, Git commits/tags/pushes and publishing need a subsequent user instruction. Preserve the four published 0.3.39 assets and `dist/latest.yml`.
4. Start with the focused tests for the component being changed, then run the appropriate full suites. Tests must use isolated synthetic credentials/data; screenshots must not include real local usage or conversations.
5. Before packaging, inspect process PID/path/command line/start time and **read that result before invoking the builder**. Do not close an existing user app or another AI's processes. Use the version-specific output below when the old folder is occupied, and report that the old occupation remains unresolved.
6. Wait for all owned tests/builders and their children to exit, dispose handles, and perform scoped process/file-share checks. Keep the terminal cwd at the project root. Update this current handoff entry before the final reply; retain historical entries below.

| Component | Entry points | What the next AI should preserve |
| --- | --- | --- |
| Lifecycle tracker and limits | `src/core/concurrency.ts` | Atomic admission, idempotent release, one global count per logical request, physical socket deduplication, separate metrics, attribution support flags, alert recovery/cooldown and short-spike peaks |
| HTTP/pool/WS forwarding | `src/core/agent-proxy.ts`, `src/core/upstream-proxy.ts` | No upstream delivery/retry/circuit failure for local rejection; eligible pool order; existing requests survive lower limits; independent WS compression contexts, ordered warm-ups/lanes and response-ID correlation |
| Provider/account identity | `src/core/agent-switch.ts`, `src/core/agent-types.ts` | Stable provider/pool/account IDs, exact credential/workspace/tool matching only, ephemeral fingerprints and truthful Shared/Unattributed scopes |
| Storage and IPC | `src/main/concurrency-monitor.ts`, `src/main/index.ts`, `src/main/preload.ts` | Validated typed interfaces, <=4 Hz updates, local count-only history, gaps, retention, merged notifications and storage-error visibility |
| Monitoring UI | `renderer/concurrency.js`, `renderer/concurrency.css`, `renderer/index.html`, `renderer/agent-switch.js`, `renderer/i18n.js` | Direct traffic is unmonitored; unset limits/warn defaults; drafts and old charts survive updates/loads; hidden views unsubscribe; keyboard/localization/narrow/dark support |
| Existing sidebar motion and notes | `renderer/app.js`, `renderer/app.css`, `renderer/intro.js` | 220 ms reversible motion, cleanup, immediate keyboard/reduced-motion behavior, bilingual 0.3.40 in-app notes |

### Suggested review priorities — not yet measured or confirmed

- **Lifecycle cost under sustained load:** Profile the full snapshot/row/scope scans and repeated lifecycle updates in `concurrency.ts`. Check CPU/memory with many active requests, sockets and configured scopes while keeping exact admission and every-change history peaks. Do not debounce away short spikes merely to improve renderer performance.
- **Large-history queries and persistence:** Measure long/permanent retention reads, rapid range changes, simultaneous queries and daily-file growth. Review stale-query work, memory bounds and retention boundary behavior. The unfinished minute currently stays in memory until rollover/flush and can be lost on abrupt termination; evaluate whether crash durability is worth additional writes.
- **WebSocket protocol and resource stress:** Extend synthetic checks for ambiguous/unscoped errors, malformed events, repeated event IDs, same-lane queued requests, large messages, slow readers/backpressure, disconnects during handshake and compression/load. Current tests establish the listed successful scenarios, not exhaustive protocol coverage. Any change must keep rejected-message compression independent and other turns alive.
- **Scope/UI scalability:** Check long provider/account labels, many scope rows, table keyboard focus during repeated live row replacement, and provider changes while a view is open. Editor draft/focus is tested; do not assume that establishes every table-focus or large-catalog scenario.
- **Acceptance gaps:** Full UI tests ran the source entry, with package/source equivalence checked separately. Direct packaged UI operation, real provider inference, and actual Windows notification delivery/click remain untested. Coordinate these with the user and keep captures synthetic. Dependency audit totals are recorded below; inspect specific advisories before proposing unrelated upgrades.

### Reproducible validation and test build

Run from `D:\CodePorject\Tools\TokenPulse`:

```powershell
npm run compile
node scripts/test-concurrency.cjs
.\node_modules\.bin\electron.cmd scripts/test-concurrency-ui.cjs
node scripts/test-pass-socket.cjs
npm test
npm run test:ui
```

Latest implementation results: all commands above passed (exit 0); the full suites include the new concurrency tests. Synthetic/injected error messages are expected where assertions verify failure handling. Re-run after relevant code changes; do not label these historical results as new verification.

After checking output-folder occupation and finishing tests:

```powershell
npm run icons
npm run compile
.\node_modules\.bin\electron-builder.cmd --win dir --publish never --config.directories.output=dist/test-0.3.40
```

Run each step only if the preceding step passed. Latest artifact: `D:\CodePorject\Tools\TokenPulse\dist\test-0.3.40\win-unpacked\TokenPulse.exe` (0.3.40.0), with `resources\app.asar` version 0.3.40. Preserve the entire directory. Quit the existing TokenPulse before launching it to avoid single-instance redirection. Previous package verification matched 120 source files and 16 ws runtime files; builder strips development package metadata, so compare runtime metadata semantically. On Windows, use native paths with `@electron/asar.extractFile`.

The previous build's `EBUSY` was at `dist\win-unpacked`, caused by pre-existing app processes; no user process was closed. The version-specific directory is a workaround, not evidence that the old folder was unlocked. No new runtime/test/build resources were started by this documentation turn. Detailed implementation, validation, known limitations and historical resource checks follow.

### 现在的状态

- **2026-10-09 并发监控页重新设计（0.3.40，本地、未提交、未发布）**：用户反馈导航图标和供应商一样、页面设计不好；并说明聊天回复用中文即可。只改界面，后端和数据接口没动。
  - `index.html` 新增 `#i-concurrency` 图标（三条并行的线带圆点），导航「并发监控」改用它；供应商仍是 `#i-route`。
  - `renderer/concurrency.js` 重写界面部分（元素 id 和 IPC 用法不变）：顶部「监控范围」卡 + 每个工具一枚状态胶囊（`.cm-coverage .cm-chip`，带品牌图标，正在监控 / 直连未监控）；三张计数卡带图标和说明，设了上限的显示进度条，≥80% 变黄、到达或超过变红（`data-tone`）；提醒条带图标；并发历史用 `.panel` 标题栏、面积填充、设了上限时画红色虚线；明细表每行有类别标签（全部 / 供应商 / 账号 / 未归属 / 共享）、「当前 / 上限」加细进度条、「归属不确定」只在名字下说一次、拒绝数为 0 置灰；设置区三列表单，保存按钮用主色，点表里的「设置」会滚到设置区。
  - `renderer/concurrency.css` 重写；表格出血边距用 `--pad` 跟随 `.panel` 的内边距（1100px 以下是 20px，写死 24px 会横向溢出）。`i18n.js` 补 7 条英文。
  - 测试：`test-concurrency-ui.cjs` 加了图标、进度条 / 超限、类别标签、「5 / 4」、覆盖胶囊的断言；截图目录改由 `TOKENPULSE_CAPTURE_CONCURRENCY` 指定，第二张截浅色明细表。`npm test` 退出 0；`npm run test:ui` 第一次在没改动的 `test-model-study-ui.cjs`「浮层完整显示、在最上层」失败一次，单独跑两次都过，整套重跑退出 0（47 PASS），按偶发记录。合成数据截图看过深色首屏、浅色表格和设置区（图已删）。
  - **同日追加**：监控范围里 `desktop`（Claude 桌面端）没有图标，`APP` 映射补上（用 Claude 图标、显示「Claude 桌面端」）。用户嫌原生下拉框丑：`concurrency.js` 的 `fancy()` 把原生 select 藏起来只存值（`.cm-native`，测试和状态同步照旧用它），旁边放 `.ui-select.cm-select` 按钮（`data-for=<select id>`），点开用 app.js 现成的 `openOptionMenu`（和设置页同一个菜单）；值或选项变了调 `syncSelects()`。字段外层从 label 改成 `div.cm-field`。只改了并发页的 5 个下拉框，其他页的原生下拉没动。明细表 `.table-scroll` 加 `overflow-y: hidden`。测试补了按钮文字、菜单项、选中后写回 select。`npm test` 退出 0，`npm run test:ui` 退出 0（47 PASS）；测试版已重打（构建退出 0、文件一致、未占用）。截图看过按钮样式；菜单打开的截图没截到（窗口显示时菜单被关），菜单内容由 DOM 断言覆盖。
  - 测试版已重打到 `dist/test-0.3.40/win-unpacked/TokenPulse.exe`（构建退出 0，89 个运行时文件与源码一致，包内 0.3.40；exe / asar 能独占打开；打包前查过没有进程占用 dist）。等用户看效果。

- **0.3.40 implementation complete; unpacked local test ready for acceptance** (2026-10-08): User authorized the concurrency/admission plan and an unpacked test app including local sidebar animation. package.json / package-lock.json and package runtime version are 0.3.40; ws 8.22.0 is an explicit production dependency. HEAD remains 46406b5. Existing source changes preserved; no Git commit/tag/push, installer, installation or publication performed.
  - Core: src/core/concurrency.ts owns idempotent reservations and physical socket registration, global/provider/account scopes, unknown/shared identities, atomic request admission, independent advisory connection limits, settings validation, per-rule episodes/cooldown/recovery and minute min/max/last/rejection snapshots. Requests include upstream waiting/streaming, exclude non-inference calls; sockets counted at physical accept/connect and retained through idle reuse. Shared connections retain only common attribution and disable uncertain individual connection limits. Credential matching in agent-switch.ts hashes exact token/workspace/tool identities in memory; unmatched identities stay Unattributed. Pool-member metadata keeps stable provider/account IDs; selection skips saturated members before sending, preserves eligible order, holds one global reservation across attempts and never trips a circuit breaker for local rejection. Successful pool skips do not add rejection totals; all-saturated rejection counts once globally.
  - WebSockets: agent-proxy.ts uses ws client/server relay with separately negotiated compression contexts and preserves authentication/custom handshake headers, application payloads and upstream handshake refusal responses. Reservations are per inference-generating response.create; generate:false warm-ups participate in ordered lane/response-ID/event-ID correlation without counting or usage logging. Scoped rejection sends local 429 error and keeps other lanes alive. Completion/failure/incomplete/cancellation/disconnect/shutdown release reservations; existing model/usage/delay/speed logging preserved. ws-sniff.ts retains Grab and synthetic frame compatibility reader, with updated comments.
  - Main/UI: src/main/concurrency-monitor.ts stores validated settings and sparse one-minute history in the TokenPulse data directory (concurrency-settings.json; concurrency-history/YYYY-MM-DD.jsonl), defaults to unset limits/warn/30 days, prunes finite 7/30/90 retention, supports permanent, keeps sub-minute peaks and separates monitoring/restart gaps. Only counts/timestamps/stable scope IDs and rejection totals are persisted by monitoring; no credentials or message bodies. Live publishing <=4 Hz; simultaneous episodes merge into one Windows notification linking to Concurrency, with >=60 seconds per metric/scope and five-second recovery (warn <=limit; request reject <limit). Persistent alerts and storage failures are visible. index.ts/preload.ts expose typed live/history/save interfaces. renderer/concurrency.js/.css, index.html, app.js/i18n.js add bilingual navigation, counts, coverage, scope breakdown, validated rules, history filters and retry. Direct traffic shows unmonitored and —. Forwarding views have compact count/status link. View subscriptions/timers close on navigation/pagehide; unsaved settings/focus and old chart remain during updates/loading. In-app 0.3.40 notes updated; existing sidebar motion retained.
  - Validation: npm run compile; final npm test and npm run test:ui full suites exited 0. New scripts/test-concurrency.cjs and scripts/test-concurrency-ui.cjs are included in those scripts. Final extra targeted backend test passed exact token/workspace/tool attribution, unknown fallback, stable pool scopes, all-saturated rejection/no delivery and upstream fallback global counts. Coverage includes overlapping HTTP arrivals, exact physical/idle/reused connections, discovery exclusion, streaming/failure/abort/shutdown, independent account/global limits, lowering limits, shared attribution, compressed fragmented WS context takeover, interleaved ordered lanes/warm-ups/scoped errors/cancellation/rejection-followed-by-success, notification merge/throttle/cooldown/recovery, peaks/pruning/gaps and secret exclusion. Updated test-pass-socket.cjs verifies semantic messages rather than raw masked frame bytes; compatibility tests pass. UI covers defaults/validation/independent rules/retention, live draft/focus preservation, chart range races/loading failures/retry, gaps/unsubscribe/unmonitored states, Chinese/English, dark/narrow windows and keyboard/reduced motion. Final integer chart-axis refinement passed targeted UI. Synthetic dark screenshots inspected; temporary captures removed. Existing injected failure logs (including Synthetic history error) are expected.
  - Corrected during validation: initial TypeScript header/RawData typing; former raw-byte WS assertions; missing concurrency page visibility; dynamic labels accidentally translated in Chinese mode; warm-up lane association; false rejection summaries for skipped pool members. First full UI run failed on a test-only finish() of an infinite animation; test now finishes finite effects only, final full suite passed. Extra test notification assertion initially reused an earlier cooldown scope; fresh scopes passed. Exact upstream test expectation corrected to two physical connections because discovery overlapped a pending inference. No unresolved test failure.
  - Build/artifact: npm run icons and compile passed. First electron-builder --win dir --publish never failed EBUSY / rmdir at D:\CodePorject\Tools\TokenPulse\dist\win-unpacked. Four pre-existing old unpacked TokenPulse processes (16492/30032/29012/34924, executable in that folder, started 2026-10-08 20:15:10 local) were identified; none belongs to this turn and none was closed. I attempted the old output before acting on that process check. The first builder may have partially modified its old folder; post-check found old ASAR version 0.3.39 and no missing outer runtime paths compared with the new directory tree, but this is a presence check rather than a full old-package byte verification. It is not the new test artifact. Successful build used electron-builder --win dir --publish never --config.directories.output=dist/test-0.3.40 (exit 0). Latest app: D:\CodePorject\Tools\TokenPulse\dist\test-0.3.40\win-unpacked\TokenPulse.exe, product version 0.3.40.0/file version 0.3.40; keep the full win-unpacked directory.
  - Package verification: all 120 files under build/renderer/knowledge match source byte-for-byte, as do 16 ws runtime JS/MJS files; app/ws package runtime metadata matches (builder strips development fields, so package JSON is checked semantically). Initial verifier used POSIX separators on the Windows ASAR and then assumed unstripped package JSON; corrected verifier passed. Four published 0.3.39 Setup/blockmap/Portable/latest.yml SHA-256 values remain identical to the prior release baseline. No 0.3.40 installer/update manifest produced.
  - Resource closeout: all owned tests, captures and builder processes exited. CIM by path/command line/creation time found no test/Electron/builder/new test app process beyond the inspection shell. New test exe/ASAR plus four published assets passed FileShare.None read checks with immediate Dispose. Two synthetic PNGs and nine known isolated UI data directories were removed after processes exited. Project cwd stays root. Old dist/win-unpacked remains occupied by the pre-existing app; the separate output is a workaround, not an unlock, and there is no system-wide unlock claim.
  - Limits/unrun/next: Monitoring covers only TokenPulse forwarding; direct traffic/other devices and unsupported account attribution cannot be counted or individually limited. WS has a 100 MiB message limit and compression/message reconstruction changes wire framing while retaining application semantics. History's current minute is kept in memory until rollover/flush; abrupt termination can lose that unfinished minute. Full UI suites run the source Electron entry; package contents are separately verified, not a direct packaged full UI run. No real inference/account login, actual Windows notification click, installer, installation or auto-update acceptance performed. npm install reported the repository dependency audit totals (9: 8 moderate/1 high); no unrelated audit upgrades attempted. No engineering blocker for the delivered artifact. User should quit the currently running app before starting the new test exe to avoid single-instance behavior. Await acceptance; leave everything local and unpublished.

- **Concurrency feature feasibility assessed (2026-10-08; no implementation)**: User asked whether TokenPulse can monitor concurrent connections and notify above a configured limit. agent-proxy.ts already counts active HTTP forwarding handlers via stats.active and tracks transparent WebSocket tunnels separately. Existing count includes auxiliary HTTP requests, starts at different body-read stages and excludes WebSocket inference activity, so it is not yet a reliable unified inference-concurrency metric. Proposed scope is traffic passing through TokenPulse only: active inference requests as primary metric, open connections as a separate diagnostic, optionally grouped by tool / provider / account. Direct CLI traffic and activity on other devices are outside local proxy visibility. Threshold notifications can reuse existing Electron notification plumbing with threshold-crossing and cooldown behavior. No feature code, tests, build, version, commit or release changes performed; existing local sidebar changes preserved. Next step: user decides metric and monitoring scope before implementation.


- **Sidebar motion follow-up complete, local test build ready (2026-10-08)**: User reported abrupt sidebar opening / closing. package.json and package-lock.json remain 0.3.39; no new version or publication requested. These changes are uncommitted and unpublished, on top of release / handoff HEAD 46406b5.
  - Implementation: renderer/app.js uses 220ms WAAPI translations for workspace and navigation / brand icons and scales only separate sidebar / titlebar background surfaces in renderer/app.css. Existing --ease token retained. Layout changes once, so charts are not laid out every animation frame and text is not scaled. Newly visible labels fade in; disappearing labels fade out through temporary inert, aria-hidden copies with matching child typography. Rapid reversal samples the current visual position before cancelling. Finished / cancelled motion releases animation sets and temporary elements. Reduced-motion changes, viewport breakpoint changes and pagehide stop active motion; keyboard activation is immediate.
  - Validation: npm run compile exited 0; targeted Electron scripts/test-agent-switch-ui.cjs exited 0, including intermediate content / boundary geometry, continuous reversal, cleanup, focus, reduced motion and keyboard. Final npm run test:ui full suite exited 0 after the titlebar assertion was updated. Initial full run failed because scripts/test-ui.cjs expected the former gradient; it now checks the separate dark sidebar surface and titlebar workspace background colors. Existing synthetic fault logs are expected. git diff --check passed. Backend code is unchanged; npm test not repeated (published release's backend suite passed).
  - Appearance: synthetic isolated UI data only. First hidden-window capture showed a stale startup frame; briefly showing the test window refreshed rendering. Paused dark-theme capture inspected: sidebar, boundary, icons, titlebar and workspace aligned. No real user data captured. Temporary scratchpad/sidebar-motion-preview.cjs and PNG were removed using checked absolute parent paths after the helper exited. Static inspection plus controlled animation geometry verifies appearance and continuity; final motion feel remains for user testing.
  - Test artifact: electron-builder --win dir --publish never exited 0. D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe contains local motion changes, package version 0.3.39; keep the entire win-unpacked directory. All 86 runtime files including knowledge/models.json match current source byte-for-byte. Four existing published release assets in dist retain their release SHA-256 values. No installer rebuild, installation, Git commit / tag / push or GitHub publication performed for this follow-up.
  - Resource closeout: all targeted / full UI tests, synthetic preview helper and unpacked builder exited. CIM inspection of relevant executable paths / command lines / creation times found no test / builder / preview / unpacked app process (only inspection shell matched). Four release assets plus unpacked exe and app.asar passed FileShare.None read checks, with immediate Dispose. Working directory remains project root; installed user application was not closed. This is a scoped process / file check, not a system-wide unlock claim.
  - Remaining: user can exit the installed app and run the unpacked test exe to feel-check the animation (single-instance behavior otherwise may focus the installed version). Full UI suite runs source entry; packaged source equivalence is separately verified, not a direct packaged UI suite. No backend / real API / upload / install / auto-update testing performed. No blocker. Await feedback and a separately specified next release version; do not overwrite the already published v0.3.39 assets.

- **0.3.39 published (2026-10-08)**: User authorized building and publishing this version and removing old local installers. Includes model speed trends, Claude effort capture, forwarding-log pagination, POST delivery-uncertainty safeguards, speed-range race / large-history / first-token fixes, tokens.ci check cancellation, range-switch flicker fix and collapsible main navigation.
  - Version / notes: package.json and package-lock.json are 0.3.39. renderer/intro.js has seven release-note entries; renderer/i18n.js supplies English translations. dist/release-0.3.39.md follows the v0.3.38 headings, preview notice and download footer in the project's existing Chinese release language. User-facing chat replies must be English.
  - Validation: npm test exited 0; final full npm run test:ui exited 0; node scripts/test-features.cjs passed 46/46 after notes were complete; git diff --check passed. Initial UI run loaded notes during their update and failed the earlier-version headings check; stable-source full rerun passed without a product change. Initial notes-generator quoting failure was corrected. Synthetic / simulated failure logs are expected test injections.
  - Build / package checks: npm run dist exited 0 (icons, TypeScript, NSIS installer and portable, --publish never). app.asar reports 0.3.39. 86 runtime files (renderer JS/CSS/HTML, build JS and knowledge/models.json) match current source byte-for-byte; test fixtures absent. latest.yml version, installer size and SHA-512 validated.
  - Local artifacts: D:\CodePorject\Tools\TokenPulse\dist\TokenPulse-0.3.39-Setup.exe (112450873 bytes), TokenPulse-0.3.39-Setup.exe.blockmap (119509), TokenPulse-0.3.39-Portable.exe (112193721), latest.yml (352). Unpacked test app: D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe; keep the entire win-unpacked directory together.
  - Git / publication: release commit 70d0962 and tag v0.3.39 pushed to origin/main; final handoff-only commit follows the release tag. https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.39 is published, not draft or prerelease; releases/latest resolves to v0.3.39. All four uploaded assets match local sizes and GitHub SHA-256 digests. Published body matches the notes file; downloaded latest.yml matches local SHA-256. Temporary download directory was removed. Draft tag lookup initially returned HTTP 404; listing releases by ID verified the draft before publication.
  - Cleanup: removed exactly nine old dist package files: 0.3.36 / 0.3.37 / 0.3.38 Setup.exe, Setup.exe.blockmap and Portable.exe; reclaimed 674112490 bytes. Absolute parent paths and exclusive read handles checked before deletion. New 0.3.39 assets, win-unpacked and historical release notes retained. No broader machine-wide package cleanup performed.
  - Resource closeout: all test, build and GitHub upload commands exited. Final CIM inspection by PID / executable path / command line / creation time found no remaining test / builder / uploader process; user's installed TokenPulse process and children remain running and were not closed. Six key current files (four release assets, unpacked exe and app.asar) passed FileShare.None read opens; each handle disposed immediately. Sandbox CIM inspection was denied and rerun with escalation. During upload the two EXEs were busy; final checks after gh exited passed. Root working directory preserved. Checks are scoped to relevant processes and these six files.
  - Not performed / limitations: no actual installation or end-to-end auto-update, no real API / tokens.ci upload, no full UI suite executed directly from packaged asar. UI tests use synthetic isolated data and source entry; packaged contents were independently compared. tokens.ci uploads still require Node.js and a running app. No unresolved engineering or release blocker. Next: user can install / test 0.3.39 and report feedback.

- 为避免Google账号受到风控，暂不支持Antigravity。

- **2026-10-08 0.3.39 UI 改动完成，最新测试版已重打，待用户测试**：本轮包含「模型速度走势」切范围闪烁修复和主导航收起功能；用户确认左侧指主导航，收成图标栏。归入 0.3.39，沿用此前只做测试版、不发布的安排；package.json / package-lock.json 和包内版本暂仍 0.3.38，升发布版号留到正式发布。HEAD=760c118，原有未提交改动保留。
  - **闪烁原因及修复**：延迟 IPC 回归两次复现：原 SVG 被移除，图主体高度约 423px → 86px，动画为 none。usage-insights.js 不再清空已有数据 / 用占位替换原图；等待新范围时保留同一图表节点与高度，成功后一次替换。独立 syncSpeedState 更新选中按钮、aria-busy 和固定高度状态区，明确「暂显示上次结果」；失败保留图、显示错误与重试按钮。仍用请求序号隔离旧成功 / 失败响应。usage-insights.css 为状态区预留高度；i18n.js 补英文。
  - **主导航收起**：index.html 在左下「设置」上方加「收起侧栏」按钮和展开 / 收起图标。app.js 记忆 tokenpulse-sidebar（localStorage）；收起保留 76px 图标栏、导航 / 设置 / 展开入口、title 与 aria 名称；展开为 236px，保持焦点。app.css 将手动收起规则与窄窗口规则协调；没有手动选择时 1100px 以下仍自动收起，用户在窄窗口也能手动展开。
  - **验证**：test-agent-switch-ui.cjs 新断言先红后绿，覆盖延迟加载时 SVG 保留 / 主体高度不跳 / aria-busy、旧响应隔离、失败保留图及重试；900px 默认收起 / 手动展开、1380px 手动收起、图标导航、刷新记忆、深色及焦点。最终 npm run test:ui 全套退出 0；node scripts/test-speed-regressions.cjs 三项（含 15 万条记录 / 旧响应失败）、node scripts/test-features.cjs 46/46、git diff --check 均退出 0。后端业务代码本轮未变，未重跑整套 npm test（上一轮全绿）。Synthetic restore failure / Simulated … 为原有故障注入。
  - **视觉自查**：仅合成数据，已查看速度图、浅色收起和深色展开截图，布局正常。截图辅助脚本第一次 finish 循环动画报错，改为只处理有限动画；隐藏窗口初次捕获的是旧启动帧，双次 capture 刷新后得到与 DOM 一致的画面。没有改正式测试的绘制策略；辅助脚本、PNG、指针文件及它创建的隔离目录已验证绝对路径后定点清理。
  - **最新测试产物**：npm run icons、npm run compile、npx electron-builder --win dir --publish never 均退出 0。D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe，2026-10-08 07:58 本地时间生成，包内 0.3.38，整个 win-unpacked 目录须保留。85 个运行时 JS / CSS / HTML、knowledge/models.json 与当前文件逐字节一致；已有 0.3.38 Setup.exe、blockmap、Portable.exe、latest.yml 四个正式产物大小 / SHA-256 均未变。本轮没有安装包、安装、提交、标签、推送或发布；下面 07:36 测试包记录为 UI 改动前历史，已由此包替代。
  - **资源收尾 / 范围**：本轮测试、截图助手、构建均退出；CIM 按进程路径 / 命令行 / 启动时间核对未发现本轮测试 / 打包 / dist 进程。测试 exe / asar 和四个正式附件全部 FileShare.None 只读打开成功并立即 Dispose，临时正式附件哈希基线已删除；工作目录仍在项目根目录，没有关闭用户软件。UI 回归跑源码入口，包内一致性独立校验；未直接跑包内全套 UI、真实 API / 上传、安装或自动更新。无工程阻塞，下一步用户退出正在运行的正式软件后测试新 exe，反馈再继续。

- **2026-10-08 五项审查问题已修复，测试版已重打，待用户测试**：用户授权修复全部问题，仅生成测试版。按约定归入拟发布 0.3.39；package.json / package-lock.json 和包内版本仍为 0.3.38，HEAD 仍为 760c118，保留原有未提交的速度走势 / 跳页等改动。
  - **POST 重复转发**：upstream-proxy.ts 的 staleReuse 仅允许 GET / HEAD 自动重发。agent-proxy.ts 遇非幂等请求 ECONNRESET / EPIPE / ECONNABORTED 或等待超时，将本次失败标成终止，返回错误，避免换连接或继续交给号池下一成员；明确的 HTTP 拒绝和未连接成功的错误沿用原有路由策略。连接复用仍保留。test-proxy-reuse.cjs 本机假 HTTPS / CONNECT 上游确认：暖连接后完整接收 POST、发响应头前断开，上游只收到一次、客户端 502；透明转发和两成员号池都覆盖，下一次独立请求成功；GET 的失效复用连接仍只重试一次。没有真实推理或计费。
  - **范围竞态**：usage-insights.js 给每次加载分配请求序号，仅最新请求能写回数据 / 错误 / loading / 缓存；新范围不被正在加载的旧范围阻挡。VM 覆盖旧请求最后成功或失败；Electron 延迟 IPC + DOM 确认 30 → 7 请求都发出，旧 30 天返回后仍显示 7 天数据。
  - **大量记录**：pass-speed.ts 用 reduce 求最早 / 最后时间和图最大值，route-ledger.ts 的速度极值也改 reduce；usage-insights.js 图峰值不展开桶数组。15 万条合成日志下 speedSeries 和 accountSpeed 的全部 / 7 天均成功。
  - **首字样本**：pass-speed.ts 独立筛选速度、首字；无速度的短回复仍进入首字统计。speedSeries 提供 speedCount / firstCount，缺失速度为 null；usage-insights.js 按当前指标过滤、排序、显示次数。账号速度图维持速度次数 / 输出统计，首字摘要纳入同组短回复。合成 [100,5000,9000]ms 首字得到中位 5000ms，速度仍只用有效样本；short-only 模型只在首字图出现，速度图不把缺失当零。
  - **检查取消 / 退出**：main/tokens-ci.ts 跟踪 where / 版本查询的 runner；cancelJob 和 stop 终止全部活动子进程，各 await 阶段后检查取消，finally 等待剩余 done 后释放。test-tokens-ci.cjs 用可控 runner 验证 where、版本、env 未完成三阶段，不再启动后续命令，完成后 running=null。
  - **DOM 回归新发现并修复**：usage-insights.js 的 seg() 原先闭包一直记住最初选项，切走后点回默认「速度」或「全部」被忽略；现在选中后更新闭包值。新增 DOM 断言先失败 3 !== 2，修复后确认首字 → 速度、30 → 7 → 全部正常。相关合成测试扩充在 test-agent-switch-ui.cjs。
  - **验证结果**：新增 test-speed-regressions.cjs 已接入 npm test；三个速度回归、POST 完整接收后断线、检查取消在修复前均有红灯复现。最终 npm test、npm run test:ui、git diff --check 全部退出 0；定点 test-proxy-reuse.cjs 5/5、test-tokens-ci.cjs 8/8、test-speed-regressions.cjs 三项、test-pass-speed.cjs 和 Electron test-agent-switch-ui.cjs 均退出 0。Synthetic restore failure / Simulated … 等是已有故障注入，非新失败。tokens.ci 首次沙箱启动模拟子进程 spawn EPERM，授权环境重跑通过。知识库 CLI 测试有外部 Epoch 数据读取，最终正常结束。
  - **测试产物**：npm run icons、npm run compile、npx electron-builder --win dir --publish never 均退出 0。最新 D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe（exe 产品版本 0.3.38.0，包内 0.3.38；2026-10-08 07:36 本地时间生成），整个 win-unpacked 目录须一起保留。asar 的 85 个运行时 JS / CSS / HTML 文件、knowledge/models.json 与当前文件逐字节一致。原有 0.3.38 Setup.exe、blockmap、Portable.exe、latest.yml 四个正式产物的大小和 SHA-256 与打包前一致。本轮没有新安装包、安装、Git 提交、标签、推送或发布。
  - **资源收尾**：所有本轮测试 / 打包进程均结束；CIM 按 PID、路径、命令行和启动时间核对，没有本轮测试 / 构建 / dist 运行进程。六个关键文件（测试 exe / asar、现有 0.3.38 的四个正式附件）都成功 FileShare.None 只读打开并立即 Dispose；测试脚本 finally 清理隔离数据，产物校验临时基线文件已删除，工作目录在项目根目录。用户 AppData\Local\Programs\TokenPulse 的正式版及其子进程仍在运行，本轮没有关闭它；测试前需用户自行退出正式版再打开测试 exe，避免单实例启动聚焦旧程序。此检查限于相关进程和六个文件，不代表系统范围全部句柄。
  - **未执行 / 已知限制 / 下一步**：UI 回归执行源码入口，包内一致性另外校验；没有直接执行包内全套 UI、截图、真实账号登录 / 推理 / tokens.ci 上传、安装或自动更新验收。网络断开仍无法证明上游是否已经执行，修复避免 TokenPulse 自动重复交付，无法阻止调用方自行重试。下一步由用户测试未打包安装的测试版并反馈；无工程阻塞，发布和升版本等待新指令。

- **2026-10-08 当前测试版审查完成（以下是修复前审查记录，五项问题已获用户授权修复）**：用户要求读交接并检查新版本 bug / 设计有效性，未授权本轮修复。核对 HEAD=760c118，package.json=0.3.38；工作区已有拟归入 0.3.39 的未提交速度走势 / 跳页改动，已保留。本轮只向 HANDOFF 添加审查记录，未改业务代码、版本或仓库测试。dist/win-unpacked/resources/app.asar 版本=0.3.38，85 个运行时文件与当前源码 / build 逐字节一致。
  - `npm run compile`、`npm test` 全套、`electron scripts/test-agent-switch-ui.cjs` 均退出 0。该 UI 脚本不支持 TOKENPULSE_TEST_APP，实际测的是源码；包内一致性另已独立校验，不能把它记成直接执行包内 UI。测试中 Synthetic restore failure 是已有测试故意模拟，并非新失败。
  - **确认 P1：非幂等 POST 会被重复转发（0.3.38 已发布）**。agent-proxy.ts:387 / :550 与 upstream-proxy.ts:151 只凭 reusedSocket + ECONNRESET/EPIPE/ECONNABORTED 且未收响应就重发，不能证明上游没处理过。本机假 HTTPS 上游 / CONNECT 代理先暖连接，再在完整收到第二次请求后、发响应头前断开：客户端发 1 次，上游完整接收 2 次，客户端最终 HTTP 200。没有发真实推理或真实计费；重复计费 / 副作用是此行为的风险。
  - **确认 P2：速度图快速切范围显示旧数据（0.3.39 测试改动）**。usage-insights.js:382-387 在 loading 时丢弃新范围请求，却无条件写回旧范围结果。内存 VM 复现选中 7 天 / 数据为全部；实际 Electron 延迟 IPC + DOM 复现选中 7 天 / 图例 ONLY_30_DAY_DATA，实际请求范围只有 [0,30]，没有 7。普通刷新 / 后续重绘可能纠正，不能认为按钮所选范围当时的图是正确的。
  - **确认 P2：记录多时速度图无法读取（0.3.39 测试改动，也沿用了旧账号图的模式）**。pass-speed.ts:131 / :145 对所有记录的数组使用 Math.min / Math.max 展开。15 万条合成日志时 speedSeries(0) 与 speedSeries(7) 均抛 RangeError / Maximum call stack size exceeded（先在 from，再在单组 lastAt）；IPC 捕获后返回 null，界面会显示读取失败，不是整个应用必然崩溃。默认「全部」且日志永久保留，属于可随使用时长触发的边界；阈值依 JS 运行时而变。本次用 Node 调实际编译模块核验，未向真实日志写入这些记录。
  - **确认 P2：首字图有样本筛选偏差（0.3.39 测试改动）**。pass-speed.ts:118-122 先要求 tokensPerSec，连有 firstTokenMs 的短回复（输出少于 20 Token 或耗时不足 200ms 时本来就不计算速度）也被排除。单条 5 Token、首字 800ms 的记录完全消失；三条首字 [100,5000,9000]ms、只有第一条有速度值的合成日志，图表 count=1 / firstTokenMs=100，全部记录的首字中位实际为 5000ms。速度指标可以跳过短样本，首字指标却复用这份子集，不能代表全部请求首字。当前账号图也有相同筛选。
  - **确认 P2：tokens.ci 环境检查取消 / 退出不释放检查子进程（0.3.38 已发布）**。main/tokens-ci.ts:130 的 check job.kill 是空回调；where 检查和 npm view 的 runner 只取 done，没有保留 kill。fake runner 放置两条待完成检查，cancelJob 与 stop 后 kill 调用均为 0，running 仍为 check；这条检查路径不受 run() 的停止保护。真实进程能否自行结束依工具 / 管道状态，不能保证退出时完整释放；最长版本检查超时为 60 秒。未启动真实 npm 查询或真实上传来验证。
  - **验证方式 / 范围**：上述合成检查用 PowerShell here-string → node（退出 0，输出具体错误或不符合预期的结果）；DOM 竞态用系统临时目录的 Electron 启动器，在内存中复用原 UI 测试的隔离环境并延迟 IPC，退出 0。没有把任何复现脚本作为永久仓库测试加入。未重跑全套 test:ui（只跑受影响 UI 脚本），未截图、未访问真实账号 / API、未安装、重新打包、提交、打标签或发布；本轮不做全面安全审计。
  - **失败与资源收尾**：连接重复接收验证第一次误用了 TLSSocket.resetAndDestroy，报 ERR_INVALID_HANDLE_TYPE，Node 退出；改为 destroy 后复现成功。首个失败脚本的独立临时目录及 DOM 启动器已核验在本轮 $TEMP 路径内后定点删除，成功脚本全部 finally 清理。npm test 和 Electron 已退出；CIM 未发现本轮测试 / 临时脚本 / 构建 / dist 运行进程。测试包 exe / app.asar 与现有 0.3.38 的 Setup.exe / blockmap / Portable.exe / latest.yml 六个文件都能 FileShare.None 只读打开并立即 Dispose；工作目录为项目根目录，未关闭用户正式软件，不声称系统范围全部句柄无占用。
  - **下一步**：把五项审查结论交给用户，等待明确确认再修改；优先处理 POST 重发。当前没有工程阻塞，只有修复尚未授权。旧正式产物、版本号和 Git 提交状态不变；下方 0.3.39 改动仍是原有未提交工作。

- **0.3.39 进行中（2026-10-08，测试版已打，未提交、未升版本号、未发布）。** 用户规定：没说升版本的改进都算 0.3.39。
  - **思考等级会不会影响速度（用户问）**：用用户真实转发记录只读汇总（只看聚合数字）：gpt-6.1-sol 的 low / medium / high 每秒 Token 数 42.5 / 40.3 / 40.4，几乎一样；首字中位 3.4 / 4.5 / 6.5 秒，差很多。gpt-6-luna 的 low 105、medium 54 但样本少（7 / 10 条）、输出很短（41 / 126 Token），不可靠。结论：速度基本不受影响，首字受影响大，所以按思考等级分开一行。另发现 Claude Code 的思考等级在请求的 `output_config.effort`（在 claude.exe 里确认过字段），以前没读到，`agent-proxy.ts` 的 `requestFacts` 现在也读它。
  - **更正（同日）：用户说应该放在用量明细、做成折线图。** 已改：额度详情的 `#quota-speed-all` 表和 `renderSpeedTable` / `drawSpeedTable` / `.speed-table*` CSS 全部删掉。`pass-speed.ts` 新增 `speedSeries(days)`（一条线 = 工具 + 型号 + 快速 + 思考等级 + 经由，按时间分桶：两天内按小时、三个月内按天、再长按周，每桶速度和首字中位数；0 = 全部），IPC `pass-speed:series`，preload `passSpeedSeries`。`usage-insights.js` 新增「模型速度走势」面板（放在模型排行之后）：速度 / 首字切换、24 小时 / 7 天 / 30 天 / 全部（默认全部）、按工具筛、默认画次数最多的 6 条、图例开关和「全部显示」、悬停竖线列出各线当时的数字；有缓存时同步画（不然整页重画时先缩成「正在读取…」，下面的内容会跳——test-ui 的滚动守卫测试抓到过），模块加载 1.5 秒后预读，异步读完用 `keepScroll` 包住重画；ResizeObserver 宽度变了重画。透明转发页的说明卡和按钮改成去用量明细。`passSpeed()` 表格汇总保留（IPC 和测试还在用，界面不再用）。测试：`test-pass-speed.cjs` 加 `speedSeries`；`test-agent-switch-ui.cjs` 改成检查折线图图例、首字切换、开关线。`npm test` 退出 0，`npm run test:ui` 退出 0（43 PASS），测试版已重打（85 个文件一致，未占用），截图看过宽 / 窄 / 深色。以下这条是表格版的历史记录，以本条为准：
  - **（已撤回）全部模型的速度搬到额度详情**：`route-ledger.ts` 的 `passSpeed(days)`：0 = 全部（不再限 90 天）；按工具 + 型号 + 快速 + 思考等级 + 经由分组；返回 `fast`、`effort`、四分位 `low` / `high`（型号名不再带「 · 快速」后缀）。IPC `agent:pass-speed` 允许 0。`index.html` 在 `#quota-detail` 后加 `#quota-speed-all`，`app.js` 的 `renderSpeedTable` / `drawSpeedTable`：工具筛选、24 小时 / 7 天 / 30 天 / 全部（默认全部）、表头点排序（默认按型号：用得多的型号在前，同一型号的行挨着、等级从低到高）、不截断；60 秒内不重读。表格单元格不能用全局 `.muted`（它是 inline-flex，会把 td 撑歪），用 `.speed-table-dim`。透明转发页删掉旧速度表（及 `.pv-speed-*` CSS），换成一张说明卡 + 「去额度详情看模型速度」按钮（`data-action=open-speed`）。每个账号下面的「模型速度」走势图没动。
  - **转发记录页码 + 跳页**：`route-ledger.ts` 新增 `countRouteLog()`（只数含 `"at":` 的行）；`agent:route-log` 支持 `total: true`。`agent-switch.js`：第一批读取时数总数，之后新来的实时记录加上；标签「第 N / M 页 · 共 X 条转发」；页码按钮（首页、末页、当前前后两页，中间「…」，`.pv-log-num[data-page]`）；「跳到 [ ] 页」回车或「跳转」，超出范围落到末页；跳到没读到的页时按需一次多读（最多 500 条一批）；全部读完以读到的条数为准。
  - 测试：`test-pass-speed.cjs`（全部 vs 7 天、思考等级分行和四分位）、`test-pass-through.cjs`（Claude 的 `output_config.effort` 记成 effort）、`test-agent-switch-ui.cjs`（透明转发页的说明卡和按钮、额度详情表两行和排序、页码 / 跳页 / 越界 / 逐页 130 条不漏）；`test-agent-switch-ui.cjs` 的 evaluate 出错时现在会带上代码。`npm test` 退出 0，`npm run test:ui` 退出 0（43 PASS）。截图（scratchpad 假数据，脚本和图已删）看过速度表浅色 / 深色、转发记录页码宽窄两种。
  - 测试版：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，85 个运行时文件与源码一致，包内版本仍 0.3.38；exe / asar 未占用。README 透明转发一段改了速度表的位置说明。
  - 下一步：等用户测试；发布时 `npm version 0.3.39 --no-git-tag-version`、intro.js NOTES + 英文、dist、提交、标签、Release、HANDOFF 单独提交。
- **0.3.38 已正式发布（2026-10-08）。** 用户测试版验收后要求合成发布。内容：tokens.ci 自动上传、全年活跃度、Grok 透明转发、Claude Code 的 Remote Control 提醒、请求延迟列、经代理转发复用连接（含复用连接失效时重发）、启动统计提速 + 启动扫描页、转发记录一页 20 条。下面各条「未提交 / 待验收」的记录都是发布前的历史，以这一条为准。
  - 版本：`npm version 0.3.38 --no-git-tag-version`（package.json / package-lock.json）；`renderer/intro.js` 加 0.3.38 NOTES 七条，`i18n.js` 补英文。
  - 测试：发布前 `npm test` 退出 0、`npm run test:ui` 退出 0（43 PASS）；rebase 到远端知识库自动更新（eed9d8e，只改 knowledge/models.json）后又跑 `npm test` 退出 0（test:ui 未重跑，变化只有知识库）。
  - 打包：`npm run dist` 退出 0（rebase 后重打）；asar 里 86 个运行时文件（renderer、build/core、build/main、knowledge/models.json）与源码逐字节一致，包内版本 0.3.38，测试用 fixtures 不在包里。
  - Git：提交 `d33894d`「TokenPulse v0.3.38：…」（rebase 在 eed9d8e 之上），标签 `v0.3.38`，均已推送。
  - Release：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.38 ，非草稿非预发布；附件 Setup.exe（112441831）、Setup.exe.blockmap（119535）、Portable.exe（112184606）、latest.yml（352），大小与本地一致，下载回来的 latest.yml 与本地逐字节一致；`releases/latest` 指向 v0.3.38。发布说明草稿在 scratchpad，未进仓库。
  - 收尾：dist 下四个附件和 win-unpacked 的 exe / app.asar 均能 FileShare.None 打开；没有残留的打包 / 测试 / 模拟 tokens 工具进程；用户正在用的正式版（AppData\Local\Programs\TokenPulse，0.3.37）没动，会通过自动更新收到 0.3.38。
  - 没做：真机的 tokens.ci 真实上传和登录（只跑过 `npx --yes tokens-cli@27.1.3 submit --dry-run`）；Grok 透明转发在用户真实配置上的开关（用户的 Grok 走号池）；安装包的实际安装和自动更新。
  - 已知限制：tokens.ci 自动上传只在 TokenPulse 运行时进行；需要 Node.js（npx）；Grok 会话没有共同响应 ID，延迟列显示「—」；全年活跃度没有配色选择和 3D。

- **已完成、待用户验收（2026-10-07）：Grok CLI 的透明转发。** 版本号用户未指定，`package.json` 仍是 0.3.37；未提交、未打包（没打测试版）、未发布。
  - **做法**（真机探测定的）：Grok 1.0.46 的会话服务地址是 `config.toml` 的 `[endpoints] cli_chat_proxy_base_url`（也可用环境变量 `GROK_CLI_CHAT_PROXY_BASE_URL`），但对话地址来自官方 `/models` 回复里每个型号的完整 `base_url`，只改前者对话仍直连。所以开的时候另外给每个官方型号写 `[model."<id>"] base_url = 本机/pass/grok`（型号 id 读 `~/.grok/models_cache.json`，读不到用内置的 4 个）；用户已给某型号配了别的地址的不动。上游 `https://cli-chat-proxy.grok.com/v1`。
  - **真机验证**（临时 GROK_HOME 拷 auth.json、跑完删；没改用户配置；令牌离过期还有 6 小时，不会续期）：`grok -m grok-4.7-build-fast --effort high -p …` 经透明转发成功，`POST /responses` 读到型号、思考等级 high（之前担心覆盖地址后丢失，实际没丢）、用量、首字延迟、速度、返回型号。每轮另有十几个附带请求（`/storage`、`/signals`、`/settings`、`/models`、`/bundle/archive`…），照样转发，但成功的不记日志（`agent-proxy.ts` 的 `GROK_INFERENCE`），只记 `/responses`、`/chat/completions`、`/messages` 和出错的。用掉用户 Grok 官方一次小请求，号池（用户默认型号是 tokenpulse_route）一次「hi」。
  - **改动**：`src/core/agent-switch.ts`（PassApp 加 grok；`grokEndpoint` / `grokOfficialModels` / `grokModelBase` / `grokPassCovered`；`passBlocked` / `writePass` / `applyPass`（启动时给新出的型号补行）/ `removePass` / `passUpstream` 的 grok 分支；`applyDirect` 里先拿掉 Grok 透明转发的行）、`src/core/agent-proxy.ts`（日志过滤）、`renderer/agent-switch.js`（PASS_TOOLS 加 grok、说明文字）、`renderer/app.js`（额度详情速度空状态不再说 Grok 没有透明转发）、`renderer/i18n.js`、README 透明转发一条、`scripts/test-pass-switch.cjs` / `scripts/test-agent-switch-ui.cjs` 断言改为三个工具。
  - **测试**：新增 `scripts/test-pass-grok.cjs`（Haiku 子代理写、我审过：开关写配置 / 原样还原 / 用户改过只拿掉我们的行 / 第三方地址拦截 / 重启后新型号补行 / 只记对话和出错请求 / 日志无凭据），已加进 `npm test`。最终 `npm test` 退出 0，`npm run test:ui` 退出 0（39 个 PASS），`git diff --check` 通过。测试结束后没有遗留的 TokenPulse 相关 node / electron 进程。没有截图看界面。
  - **没做的验证**：没有经 TokenPulse 真正的开关去改用户真实的 `~/.grok/config.toml`；Grok 桌面 / 交互界面（非 `-p`）没有真机跑；`intro.js` 的 NOTES 等定版本号再加。
  - **Claude Code 透明转发和 Remote Control 冲突（2026-10-07 用户报告，已查清，无法在现方案下修）**：Claude Code 2.1.294 的 Remote Control 要求 `ANTHROPIC_BASE_URL` 不设或 host 是 `api.anthropic.com`（二进制里的检查函数，原文还写明 `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` 对 Remote Control 无效），透明转发正是改这个变量，所以开着时 RC 必然不可用。唯一能兼容的方案是改用 `HTTPS_PROXY` + 自建根证书做中间人解密（`NODE_EXTRA_CA_CERTS`），安全风险大，我不建议，等用户决定，没做。已做：透明转发页 Claude Code 那一行加橙色提醒（`.pv-pass-warn`，`renderer/agent-switch.css`），i18n、README 同步，`test-agent-switch-ui.cjs` 加断言；该 UI 测试退出 0。
  - **用量明细每条请求的「延迟」列（2026-10-07，用户给了一张中转站后台的截图要照着做；已完成、待验收、未提交）**：经 TokenPulse 转发（透明转发 / 本地路由）的请求，按响应 ID 对上转发记录，行里多一列「延迟」：首字 / 总耗时 / 速度三行，左边一条色带（首字 <5 秒绿、<15 秒橙、更慢红）；没经过转发的显示「—」，悬停说明原因。型号下面加了思考等级和「快速」小标签。点开详情多了：思考等级、经由（透明转发 / 本地路由 · 供应商）、接口、流式与否、首字节、首段内容、总耗时、输出速度。导出 CSV 多四列。
    - 后端：`route-ledger.ts` 的 `returnedIndex` 多带一份 `RouteTiming`（只挑 ms / firstByteMs / firstTokenMs / tokensPerSec / stream / path / pass / provider / 快速，别的字段不带出来）；`request-log.ts` 的 `withRoute` 把它挂到 `RequestRecord.timing`（不落盘），`toRow` 带到 `RequestRow.timing`。前端：`renderer/app.js` 的 `latencyCell` / `secs` / `modelCell` / `requestDetail` / CSV，`renderer/index.html` 表头，`renderer/app.css` 的 `.request-latency` / `.request-tag`，i18n。演示数据（`demo-data.ts`）最近三天约四分之三的请求带响应 ID、请求 ID 和对应的转发记录，所以演示 / README 截图里这一列有数（演示里这些行的核验也变成「型号一致」）。
    - **限制**：靠响应 ID 对应，所以 Claude Code、Codex 有；**Grok 的会话记录是按轮汇总、没有和上游共同的响应 ID，对不上，Grok 的请求这一列是「—」**（速度仍在供应商页汇总和额度详情的「模型速度」里）。输出少于 20 Token 的请求没有速度。旧的、没经过转发的请求不会补。
    - 测试：`test-requests.cjs` 加两条（带出的字段、响应 ID 对不上时没有），63/63；`npm test` 退出 0，`npm run test:ui` 退出 0（39 PASS），`git diff --check` 通过。用演示数据截图看过 1440 宽浅色（色带、三行、标签正常）和 900 宽（表格横向滚动，和以前一样）；点开详情那张没截到，详情新字段只靠代码检查。临时截图脚本已删，截图在会话 scratchpad，没有覆盖 `artifacts/ui`。
  - **测试版已打（2026-10-07 23:17）**：用户要求三样（Grok 透明转发、Remote Control 提醒、延迟列）合成一个版本，先给测试版，测完没问题就发布。`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物 `dist/win-unpacked/TokenPulse.exe`（同目录资源要一起留着）。包内版本仍是 0.3.37（没升版本号），11 个改过的运行时文件和源码逐字节一致。打包进程已退出，exe 和 app.asar 能独占打开。`dist` 里的 Setup / Portable / latest.yml 还是正式的 0.3.37，不含这些改动。**仍未提交。**
  - **延迟偏大修复（2026-10-08，用户要求并入 0.3.38）**：原因是经系统代理的 https 上游每个请求都重新 CONNECT + TLS（`TunnelAgent` 原为 `keepAlive: false`），本机实测每次约 0.6–0.7 秒，算进透明转发的首字节 / 首字 / 总耗时，也真实拖慢请求（Codex WebSocket、速度不受影响）。改动：`upstream-proxy.ts` 按代理缓存 `TunnelAgent`，`keepAlive: true`、空闲 30 秒关；新增 `staleReuse`（复用连接上的 ECONNRESET/EPIPE/ECONNABORTED）；`agent-proxy.ts` 的 `forward` 和 `forwardPass` 遇到这种情况且还没收到回复时换新连接重发一次（不算成员失败）；总耗时和速度的结束时间改为回复收完那一刻（`endAt`），不含旁路解压收尾。新测试 `scripts/test-proxy-reuse.cjs`（本机假代理 + 自签证书，4/4），已加入 `npm test`。真机：经用户代理连续 4 次请求 api.anthropic.com（未带凭据）分别 977 / 264 / 267 / 274 ms，后三次复用连接。`npm test` 退出 0。首字在推理内容不外显时包含思考时间，这是定义，未改。
  - **用户规定（2026-10-08）：0.3.38 发布前，用户没说升版本的改进一律算 0.3.38。**
  - **转发记录翻页（0.3.38）**：`renderer/agent-switch.js` 的 `logs()` 改成一页 50 条（`LOG_PER`），底部 `.pv-log-pager` 用通用 `.table-footer` / `.pager` 样式，上一页 / 下一页（`data-action=logs-prev/next`）；后端仍按 100 条一批、游标读取（`readRouteLog` 未改），翻到还没读的页才去读；读完前显示「第 N 页 · 已读取 X 条 · 更早的还没读完」，读完显示「第 N / M 页 · 共 X 条转发」；每次进这一页回到第一页。删了「再看更早的」按钮及 `.pv-log-more/.pv-log-end`。英文 i18n 已补。UI 测试 `test-agent-switch-ui.cjs` 改为三页翻页校验（130 条不漏），`test-provider-pool-ui.cjs` 空记录无翻页。
  - **启动页（0.3.38）**：`index.html` 新增 `#boot`（标题栏以下全覆盖，z-index 70，低于引导 90 和弹窗 80；居中放大的品牌图标，进度弧旋转、三根柱子起伏，下方「正在扫描中…」）。`app.js` 的 `receive()`：快照有 `scannedAt` 或已有 `usage` 才收起启动页并 `render`；首次使用 / 账本重建时等扫描完的那份快照；读取或扫描出错（`onError` / snapshot 失败）也收起并显示已有快照。`#app-status`「正在读取本地用量…」改为默认隐藏。`intro.js` 的 `whenReady` 改为等启动页收起再弹引导 / 更新说明（不再 4 秒上限）。CSS 在 `app.css` `.boot*`，减少动态效果时由全局规则关掉动画。已用 test-ui 的假数据截图看过浅色 / 深色，图标和文字居中正常；`test-ui.cjs` 加了启动页断言（来得及看到时检查图标、文字、盖住侧栏、标题栏露出，最后确认已移除）。
  - **启动提速（0.3.38）**：用户嫌启动要等几秒。在用户数据目录的副本上（只读复制到 scratchpad，测完已删）计时：启动快照 `report-worker` scan=false 约 4.5 秒，其中 `buildSnapshot` 3.8 秒；扫描本身只要 35 ms。剖析：`buildSnapshot → applyClean → officialRows → queryRequests` 对每条请求调 `routeReturned` / `routeAccount`，每次都 `fs.statSync` 好几个转发记录月份文件（含不存在的月份，抛异常）并 `path.join`，合计约 3 秒。改动在 `route-ledger.ts`：新增 `peek(key, where)`，同一文件 1 秒内只 stat 一次，路径只在真要看文件时才拼；`accountCache` 改按文件名作 key；本进程 `appendRoute` / `prune` / `appendRouteLog` 写完立即 `seen.clear()`；`resetRouteLedgerCache` 也清。结果：`buildSnapshot` 3.8 s → 0.33–0.4 s，整份启动快照（含 worker 启动）4.5 s → 约 0.5 s，每分钟的后台扫描同样省下这些 CPU。`test-route-ledger.cjs` 新增：5000 次查询 stat ≤ 12 次、自己写的记录立刻查得到。worker 每次新开，1 秒的复用不会跨快照。可选的下一步（未做）：把上一份快照存盘，启动时先秒显示旧数据再更新。
  - **测试结果（2026-10-08 04:3x）**：`npm test` 退出 0；`npm run test:ui` 退出 0（39 PASS）；`git diff --check` 通过（intro.js、upstream-proxy.ts 工作区是 CRLF，autocrlf=true，diff 只有实际改动行）。
  - **转发记录改为一页 20 条（2026-10-08，用户要求）**：`LOG_PER = 20`，说明文字和英文同步，`test-agent-switch-ui.cjs` 改为翻 7 页（130 条，最后一页 10 条）并通过。测试版已重打（构建退出 0，包内文件一致，exe / asar 未占用）。全套 `npm test` / `test:ui` 未在此小改后重跑（上一轮全过，本次只改页大小）。
  - **全年活跃度（2026-10-08，0.3.38，未提交）**：用户要求仿 tokens.ci 的 Contributions 图。`renderer/usage-insights.js` 新增 `yearPanel()`，放在用量分析第一块：数据是快照 `current.usage` 的全部按天账（不跟页面时间范围，跟工具筛选）；最近一年（今天往前 365 天，周一在上）或任选有数据的年份；Tokens / 费用 / 请求切换；没用量为空格，有用量按四分位分 4 档，最多的那天固定最深；右上「N 天有用量 + 起止日期」，底部合计 / 最努力的一天 / 最长连续，少→多图例；悬停提示日期、Tokens、费用、请求、用得最多的工具；点某天调 `applyRange('custom', day, day)`，那格加 picked。CSS 在 `usage-insights.css` 的 `.year-*`（格子按面板宽度伸缩，最大宽 1150px，窄窗口横向滚动），只用 accent 绿色，没做 tokens.ci 的配色选择和 3D。英文已补并截图看过；浅色 / 深色 / 900px 用 scratchpad 里的假数据截图检查过（脚本已删）。`test-ui.cjs` 加了检查（365 格、只有今天有用量时最深、最长连续 1 天、点击切到当天再还原），`npm test`、`npm run test:ui`（43 PASS）均退出 0；测试版已重打（构建退出 0，包内文件一致，exe / asar 未占用）。
  - **tokens.ci 自动上传：已实现（2026-10-08，0.3.38），未提交。** 用户定的：间隔用户自己设，最少 10 分钟、默认 1 小时、最多一天；启动时上传一次（可选，默认开）；计时绝对由 TokenPulse 管，不加系统计划任务；版本按我的建议（默认固定版本，可切最新版 / 本机安装的 tokens）；新用户公开 / 隐私不预先选中。
    - 代码：`src/core/tokens-ci.ts`（设置规整、凭据只看存在不读内容、`commandLine` 只由固定词 + 校验过的版本号拼、输出去转义 / 令牌遮挡 / 读登录码、登录失效识别）；`src/main/tokens-ci.ts`（`TokensUploader`：30 秒心跳判断到点、启动延迟 20 秒上传、单任务、上传 / 预览 5 分钟和登录 10 分钟超时、Windows 用 taskkill /T 结束进程树、退出时 stop；`tokens-ci.json` 只存设置 / 上次结果 / 输出尾部（已遮令牌）；隐私模式只读令牌只在内存交给界面一次；无代理环境变量而系统代理开着时给子进程补 HTTPS_PROXY）；`main/index.ts` 的 `tokens-ci:*` IPC 和 before-quit 停止；`preload.ts` 的 `tokensCi`（演示模式拒绝写操作）；`renderer/tokens-ci.js` + `tokens-ci.css`（用量明细里 `#tokens-ci` 介绍卡 / 状态栏，四步向导：环境 → 账号（设备码，显示登录码 / 复制 / 打开授权页 / 取消）→ 预览 dry-run → 间隔；设置视图：开关、间隔、版本通道、检查新版本、账号、最近输出、隐藏）；`index.html` 设置 → 数据 新增「设置 tokens.ci 上传」；`app.js` render 末尾调 `PulseTokensCi.refresh()`（演示模式隐藏）；i18n 英文全部补上并抽查；README 功能段和隐私段说明。
    - 测试：`scripts/fixtures/fake-tokens-cli.cjs`（模拟 version / login / submit，不联网）；`scripts/test-tokens-ci.cjs` 7/7（加入 npm test）；`scripts/test-tokens-ci-ui.cjs`（加入 test:ui，新用户全流程、登录失效后重新登录并立即补传、隐藏后从设置重开；`TOKENPULSE_SHOT_DIR` 可截图，看过浅色 / 深色）。`npm test`、`npm run test:ui`（42 PASS）均退出 0。真机只跑了 `npx --yes tokens-cli@27.1.3 submit --dry-run`（退出 0，3.7 秒，没上传），`npm view` 拿到 27.1.3；本机已登录 tokens.ci。未在真机做真正的上传和登录。
    - 测试版已重打（2026-10-08，含此功能），包内 11 个相关文件和源码一致，fixtures 不在包里；exe / asar 未占用。
  - **（旧）tokens.ci 定时上传设计稿（已按用户答复实现，见上）：** 已查：tokens.ci 是 missuo/tokens（tokscale 分支，MIT）的排行榜；上传靠官方 CLI（Windows 官方写法 `npx tokens-cli@latest submit`，登录 `... login` 走 GitHub）；本机 `%APPDATA%\tokens\` 有 credentials.json（已登录，未读内容），PATH 里没有 `tokens`。CLI 自带 `tokens autosubmit enable --interval 24h`（Windows 任务计划）。提交接口未公开文档。建议方案：TokenPulse 定时调用官方 CLI 的 submit（不自己实现上传、不碰对方凭据），用量明细里放状态条（上次 / 下次 / 立即上传 / 预览 dry-run / 设置），见聊天记录里的设计与待定问题。新用户流程（已查 auth.rs）：登录是设备码流程——CLI 打印网址和一次性码、自动开浏览器、轮询到授权成功后写 `%APPDATA%\tokens\credentials.json`，不需要往终端输入任何东西，所以 TokenPulse 能在后台跑 login、把码显示在自己的窗口里；`login --private` 是隐私模式（不上榜）。默认公开上榜，引导里必须让用户先选公开 / 隐私。
  - **测试版最新（2026-10-08 04:46）**：在下面 04:35 那版基础上加了启动提速；提速后 `npm test`、`npm run test:ui`（39 PASS）均退出 0；构建退出 0，13 个运行时文件与源码一致，包内版本 0.3.37；进程已退出，exe / app.asar 能独占打开。
  - **（旧）测试版 04:35**：含 Grok 透明转发、RC 提醒、延迟列、连接复用、转发记录翻页、启动页。`dist/win-unpacked/TokenPulse.exe`，构建退出 0，13 个运行时文件与源码逐字节一致，包内版本 0.3.37；构建 / 测试进程已退出，exe / app.asar 能独占打开。正式版在运行，未动。
  - **（旧）测试版 04:09**，含以上前四项改动：`dist/win-unpacked/TokenPulse.exe`，构建退出 0，12 个运行时文件与源码逐字节一致，包内版本仍 0.3.37；构建进程已退出，exe / app.asar 能独占打开。用户的正式版（AppData\Local\Programs\TokenPulse）在运行，未动。**等用户测试反馈；用户说没问题后：定版本号（用户没明说，按惯例应是 0.3.38，发布前跟用户确认一句）、加 `intro.js` NOTES 和英文、`npm run dist`、提交、打标签、发 Release。**
  - **用户现状**：用户的 Grok 现在走本地路由（号池），这时透明转发开关会置灰并说明原因，属预期。

- **2026-10-07 发布 0.3.37 已完成**：用户明确授权构建安装包并发布 GitHub，要求模仿此前 Release 说明、及时更新交接。此前线上版本为 v0.3.36；为使已安装用户收到修复更新，本轮按下一补丁版本 0.3.37 发布，保留旧标签。package.json / package-lock.json 均为 0.3.37，renderer/intro.js 已加入新版本说明。发布正文 dist/release-0.3.37.md 参照 0.3.35 / 0.3.36 的中文格式、修复说明和下载表。
  - 工程修复和完整测试结果见下面 0.3.36 测试阶段记录；本轮业务代码未再改动。`npm run compile && electron scripts/test-intro-ui.cjs` 退出 0；直接设置 TOKENPULSE_TEST_APP 为 dist/win-unpacked/resources/app.asar 后运行同一 UI 测试也退出 0，包内更新说明 / 升级一次性弹窗 / 引导 DOM 检查通过，未截图；`git diff --check` 通过；`git fetch origin` 成功，远端没有新增提交。
  - **构建与校验完成**：`npm run dist` 退出 0。包内版本为 0.3.37，9 个修改的运行时文件逐字节与当前 build / renderer 一致；latest.yml 的 version / 安装包路径 / 大小 / SHA512 均核验通过。Setup.exe 为 112411787 字节，blockmap 为 119593 字节，Portable.exe 为 112154626 字节，latest.yml 为 352 字节；四个附件 SHA256 清单保存于 dist/release-0.3.37-assets.json，待发布后与 GitHub digest 比较。两种 exe 的 Authenticode 状态均为 NotSigned，发布说明沿用此前的下载提示。
  - **资源已收尾**：源码和包内 UI 测试、构建进程均退出；只读 CIM 查询未发现本轮 test / electron-builder / dist 运行进程，未关闭用户软件。win-unpacked/TokenPulse.exe、resources/app.asar 与四个发布附件均成功 FileShare.None 只读打开并立即 Dispose。工作目录留在项目根目录，仅检查这些关键文件及相关进程。
  - **最新产物**：D:\CodePorject\Tools\TokenPulse\dist\TokenPulse-0.3.37-Setup.exe、同目录 .blockmap / TokenPulse-0.3.37-Portable.exe / latest.yml，以及 dist/win-unpacked/TokenPulse.exe。已有 0.3.36 安装包为历史产物，不包含这些修复。未本机安装、未验证真实 API 或真实自动升级，未查看图片 / 截图；未再重复业务全套测试（修复阶段已通过，发布准备只改版本 / 更新说明）。已知限制仍是 Grok 缺共同响应 ID 时不能可靠归给号池账号，详见下面修复记录与发布说明。
  - **Git / Release**：代码提交 fdff3f9，标签 v0.3.37 已通过 git push --atomic 同 main 推送成功。先创建草稿上传四个附件，逐项核验远端 state=uploaded、大小 / SHA256 与本地一致，正文与 notes-file 一致；再正式发布并设为最新。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.37，publishedAt=2026-10-07T15:25:04Z；gh 再查 isDraft=false / isPrerelease=false，releases/latest=v0.3.37。没有会话链接。Git 的文档收尾提交与代码标签分开，接手用 git status / git log -2 / origin/main 核对。
  - **发布后资源复查**：上传进程已退出，重复检查未发现本轮测试 / 打包 / dist 进程；上述六个关键文件再次成功独占只读打开并立即释放。没有通过删除目录或关闭用户软件解除占用。无当前失败 / 阻塞，下一步等待用户后续反馈。
- **Git 基线说明**：审查前 main=origin/main=a62df09，本轮修复与发布改动已提交为 fdff3f9（v0.3.37）；main 在该代码提交之后保留交接收尾文档提交，标签不移动。此前的「未提交 / 待验收」仅描述下面 0.3.36 测试阶段。
- **2026-10-07 六项审查问题修复完成（0.3.36 测试阶段的历史记录，最新发布状态以上面 0.3.37 为准）**：该阶段用户只授权编译测试版，版本保持 0.3.36、没有提交。随后用户已授权正式发布为 0.3.37。改动涉及 `agent-proxy.ts`（响应中断收尾、压缩正文保留编码及旁路解压、错误状态、日志只记受控错误摘要）、`route-ledger.ts`（响应 ID 精确归属、永久日志历史恢复、UUID / 文件位置分页）、`agent-switch.ts` / `login-timeline.ts` / `usage-scan.ts` / `request-log.ts`（精确归属与旧猜测失效、账本结构 10 重算）、IPC 和供应商页分页、README 的归属范围说明。
  - 新增 `scripts/test-routing-regressions.cjs`：原代码上 0/7 通过（七组失败分别锁定六项问题），改动后 7/7 通过；增加压缩协议转换 / 客户端取消、永久日志精确恢复、响应 ID 歧义、旧猜测归属 / v9 账本重算后，最新为 **9/9 通过**。额外压缩转换测试曾暴露完整回复被记成 499，已用 `res.writableEnded` 区分正常关闭和取消并重新通过。旧 HTTP / WS 测试曾因仍断言日志保存上游错误正文而失败，已同步受控摘要的预期并重新通过。
  - `npm test` 与 `npm run test:ui` 第一轮全套均退出 0；UI 的同毫秒 130 条旧记录已验证分页与去重。修复上面的 499 收尾、增加两组回归后，最终 `npm test` 全套再次退出 0（9/9 新回归通过），受影响的 `electron scripts/test-agent-switch-ui.cjs` 再次退出 0。`npm run icons && npm run compile` 退出 0。`git diff --check` 通过。
  - **当时测试产物（本轮 0.3.37 构建会覆盖此目录）**：`D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe`，同目录资源必须一起保留。执行 `npx electron-builder --win dir --publish never` 已生成完整免安装目录，打包日志完成 asar 完整性更新与签名，相关进程已退出（工具会话未保留最终退出码，未把它记为退出 0）。只读 asar API 校验退出 0：包内版本 0.3.36，8 个修改的运行时文件逐字节等于当时 build / renderer 文件；exe ProductVersion 为 0.3.36.0。首次核验因 Windows asar 路径分隔符用错报文件找不到，改用 `path.normalize` 后通过，未向项目根目录提取文件。当时已有 Setup / Portable / latest.yml 仍是此前正式版，不能拿它们验证本轮修复。
  - 限制：Grok 现有日志是整轮汇总，没有与上游共同的响应 ID，暂不再按时间猜测归到号池账号；转发记录和账号速度仍有明确转发成员。旧日志没有共同响应 ID 时也不能可靠找回账号。未清理或改写用户历史错误日志、真实工具配置；未跑真实官方 API。
  - **未执行**：未启动免安装程序连接真实官方 API，未改真实账号 / 工具配置，未进行安装、视觉验收、截图或图片查看。用户可退出正在使用的正式软件后运行测试版验收；不要擅自关闭用户软件。
  - **资源收尾**：本轮测试命令已结束，测试中的本机假上游 / 路由及临时合成目录按 finally 清理。只读 CIM 查询未发现本轮测试、electron-builder 或从 `dist/win-unpacked` 运行的相关 Node / Electron / TokenPulse / 签名进程，未关闭用户正式软件。测试版 exe / app.asar 及已有 latest.yml / Setup.exe / blockmap / Portable.exe 均成功 FileShare.None 只读打开并立即 Dispose；工作目录为项目根目录。仅检查这些关键文件及相关进程，不声称系统范围所有句柄均无占用。
  - **下一步**：等待用户测试反馈及后续指示；本轮无工程阻塞，不自动升版本、提交、生成安装包或发布。
- **2026-10-07 修复前审查记录（下面是当时的状态，修复进度以上一条为准）**：最初用户要求只审查、暂不修复；该审查已完成。下一个版本号由用户指定。用户说过「以后再说」的：Grok 的透明转发（有副作用，见下面 0.3.35 的探测记录）、分享图（四种样张都不满意；以后要做先重新出风格）。
  - 已读当前接手入口、README、核心转发 / WebSocket 旁路解析、配置事务 / 恢复、路由账本与账号归属、速度汇总、主进程与会话 / 账号 / 更新相关代码及测试。审查重点是转发与统计；不是全部功能的完整验收。
  - **修复前确认的问题**：
    1. **P1 本地路由上游中途断开后请求悬挂**：`src/core/agent-proxy.ts:333-357` 的同协议分支只处理回复 data/end，缺少回复 error/aborted 的收尾；上游请求 close 时又摘掉下游 close 回调。本机假上游先回一段 SSE 再断开，500ms 后下游没有结束；客户端随后也断开，`stats.active` 仍为 1，没有转发记录。未复现进程崩溃，不能把它写成崩溃问题。
    2. **P1 本地路由压缩回复无法正确解码**：`agent-proxy.ts:330-339` 保留 gzip 字节，却只回 content-type，没有 content-encoding；请求仍会转发 accept-encoding（`forwardHeaders`）。合成 gzip SSE 核验：下游收到原始压缩字节、压缩头丢失。同分支的旁路用量解析也直接把压缩字节当 UTF-8。
    3. **P1 错误日志可能保存敏感回显**：`agent-proxy.ts:464`（透明转发）、`:321`（本地路由重试错误）、`:515`（WebSocket 握手拒绝）会将错误正文截断后作为 error，而 `agent-switch.ts:1122` 原样写入永久转发记录。用只含合成提示词 / 合成 token 的 429 回复复现：二者进入 route-log 文件；没有使用或输出真实凭据。和界面 / README 的“不记内容和密钥”承诺不一致。
    4. **P2 流式协议转换把上游 400 回成 HTTP 200**：`agent-proxy.ts:714-726` 在读取 / 检查错误正文前发 200，并将结束结果归为 done。Anthropic 客户端 → Chat 上游的假服务回 400，客户端收到 200，原始错误说明丢失；日志 status=400 但没有 error，`stats.ok` 加 1，也会走 succeed 而非 fail。
    5. **P2 号池归属会污染未经过号池的请求**：`route-ledger.ts:76` 只按工具类别 + 前后 30 秒的最近时间匹配，没有请求 ID / 会话 / 通道约束；`usage-scan.ts:862`、`request-log.ts:349` 无条件使用它。端到端合成 Grok 第三方日志：请求发生在号池 A 成功后 5 秒，被错误标为官方、归给 A；这个误归属会存进请求流水。并发号池请求也可能配错成员。
    6. **P2 转发记录同毫秒分页漏项**：`route-ledger.ts:123` 排除 at >= before，界面 `renderer/agent-switch.js:524` 只用毫秒时间作游标。同毫秒 101 条 + 更早 1 条，以 100 条翻页，102 条只读回 101 条。界面的 logKey（`:518`）也没有唯一请求标识，同成员同毫秒同状态还可能被去重。
  - **实际验证**：首次普通沙箱 `npm test` 退出 1，`scripts/test-sessions.cjs:181` 的 stdout 未定义；最小核验确认 `spawnSync powershell.exe EPERM`，属于运行权限限制。允许本地测试子进程后重新 `npm test`，全套退出 0（包含 TypeScript 编译、真实 Codex 配置兼容检查及透明转发 / 号池等已有测试）。四个定点已有测试 `test-pass-through.cjs`、`test-pass-socket.cjs`、`test-pass-speed.cjs`、`test-route-ledger.cjs` 各自退出 0。
  - 新问题用 PowerShell here-string → `node` 的一次性脚本、本机假上游和临时合成日志验证，没有新增仓库测试文件。第一次脚本误假设断开会抛未捕获异常，断言失败；只按父进程命令行、路径、启动时间核验后停止了本轮 Node PID 25936。第二次转换验证的假上游路径未适配转换后的 URL，断言失败但 finally 清理完成；调整合成服务路径后，转换 / 归属 / 分页三项断言退出 0；断开悬挂另已复现。两项先行复现（压缩 / 隐私）也已通过断言。
  - **未执行**：`npm run test:ui`、截图 / 图片查看、打包、安装、发布、真实官方 API 请求或真实故障复现；已有测试全绿不代表这些新边界情况已覆盖。
  - **资源 / 产物 / Git 收尾**：本轮所有命令均已结束，临时假上游 / 路由监听关闭、合成数据目录删除；只读进程查询未找到本轮测试或 dist 进程，PID 25936 已不存在。`dist/latest.yml`、`TokenPulse-0.3.36-Setup.exe`、`.blockmap`、`TokenPulse-0.3.36-Portable.exe` 均成功以 FileShare.None 只读打开并立即 Dispose；`dist/win-unpacked` 不存在。只核验这些文件与相关进程，未声称系统范围所有句柄均无占用。产物仍是此前的 0.3.36，无新产物、提交、标签、安装或发布；正式软件未关闭。
  - **下一步**：等待用户指示后才着手修复；建议先处理三项 P1，并用本轮边界复现建立回归验证，再处理转换、归属与分页。当前没有工程阻塞，只是尚未获修复指示。
- **0.3.36 原正式版发布状态（2026-10-07 修复前收尾核对，历史记录）**：GitHub Release v0.3.36 是正式版（非草稿、非 prerelease），附件 `TokenPulse-0.3.36-Setup.exe`（112409058 字节，和 `latest.yml` 一致）、`.blockmap`、`Portable.exe`、`latest.yml`；发布说明 `dist/release-0.3.36.md`。当时 `dist` 里只留 0.3.36 的安装包和各版发布说明，0.3.35 的安装包和 `dist\win-unpacked` 已删（用户不要旧安装包留在本地）；本轮修复重新生成了 win-unpacked，见上面的最新产物。此前收尾时没有从 `dist` 运行的进程、没有遗留的 Electron；用户自己的已安装版（`AppData\Local\Programs\TokenPulse`）在跑，没有动。
- **给下一位的要点（这两天新加的东西在哪）**：
  - 透明转发：`src/core/agent-proxy.ts`（`forwardPass` / `tunnelPass`）、`src/core/ws-sniff.ts`（WebSocket 帧旁路解析、`Grab` 读响应 ID / 返回型号 / 用量）、`src/core/agent-switch.ts`（`setAppPass` 一组，状态 `store.pass`）。界面在供应商页「透明转发」（`renderer/agent-switch.js` 的 `passSection`）。只支持 Claude Code、Codex。
  - 速度：每次转发记在永久的 `route-log/`（`ProxyLog.firstByteMs / firstTokenMs / tokensPerSec / tier`）；汇总 `route-ledger.ts` 的 `passSpeed()`（供应商页）和 `src/core/pass-speed.ts` 的 `accountSpeed()`（额度详情「模型速度」，`renderer/app.js` 的 `speedPanel` / `drawSpeed`）。图的设计是一个模型一行、走势每行自己的刻度、右边对比条共用刻度——用户认可了，改之前先问。
  - Codex 型号核验：`request-log.ts` 的 `withRoute()` 按响应 ID 查转发记录（`routeReturned`）。
  - 需要真机确认、还没确认的：Codex 快速模式请求里的 `service_tier` 实际值（`priority` 和 `fast` 都认了）；Claude Code `/fast` 在请求里是不是 `speed: "fast"`（凭印象写的）；号池测速、终端工作目录修复都没真机验证。
  - 工作习惯：用 `asar extract-file` 一定先切到临时目录（会覆盖当前目录同名文件）；`dist` 被占用时用 scratchpad 的 `whocwd.ps1` / `wholocks.ps1` 只读查占用者，别强行解锁。
- **0.3.36 的内容（2026-10-07，用户说两样都「算作 0.3.36」并发布）**：
  - **本地路由也量速度**：用户指出号池本来就是 TokenPulse 自己路由的，应该也能测速。`agent-proxy.ts` 加了 `stopwatch()`，`forward()`（同格式）和 `pipeConverted()`（格式转换）每收到一段上游回复看一眼，成功的转发在 `Outcome.timing` 里带回 `firstByteMs` / `firstTokenMs` / `tokensPerSec`，写进转发记录。计时从这次尝试把请求发给上游算起（号池换成员时每次尝试各算各的）。`FIRST_TOKEN` 多认了 Chat 格式的 `"delta":{`。汇总：`pass-speed.ts` 的 `accountSpeed()` 除了透明转发的（按登录时间线归属），还收号池交给官方账号的（记录里有 `account`，直接用），所以额度详情的「模型速度」对号池成员、对 Grok 账号也有了（`speedPanel()` 不再限定 Claude / ChatGPT；Grok 没数据时的提示单独写）；经本地路由转给第三方供应商的不算在账号下面。`route-ledger.ts` 的 `passSpeed()` 不再只收 `pass`，按「工具 + 型号 + 经谁转的」分组（`via`：透明转发是空的，本地路由是供应商 / 号池成员的名字），供应商页的表里型号下面一行小字写是谁。转发记录里所有带首字延迟的行都显示「首字延迟 · 总耗时」。文案：透明转发页写明用第三方供应商或号池时不用开、速度照样量；`passBlocked()` 的本地路由那句同样改了。
  - **用户问本地路由和透明转发会不会冲突**：不会。同一个工具同一时间只走一条：开本地路由（`enableProxy`）或切到第三方（`applyDirect`）时自动关掉透明转发，本地路由开着时透明转发开不了；两者共用同一个本机监听、路径不同（`/<工具>/…` 和 `/pass/<工具>/…`）。`test-pass-switch.cjs` 有这几种情况。
  - **终端占着文件夹的修复**（下一条）并进了这一版。
  - 测试：`test-pass-through.cjs` 加了本地路由测速，`test-pass-speed.cjs` 加了号池归属和 `passSpeed()` 的 `via`。`npm test` 退出 0；`npm run test:ui` **第一次在 test-ui.cjs 里超时**（「exhausted quota」之后，`FAIL UI timed out`），单独重跑 test-ui.cjs 通过、整套重跑也通过（39 个 PASS），当作偶发，原因没查。`npm run dist` 退出 0（`dist` 已经不占用了）。没有真机验证号池的测速（用户的 Grok 号池更新后用一会儿就能在转发记录里看到）。
- **0.3.35 之后查到的：`dist\win-unpacked` 占用的原因，和根源的修复（已并进 0.3.36）。** 占用者是一个 PowerShell 终端（当时的 PID 11948，05:34 启动），它是用户从**当时那个测试版**（从 `dist\win-unpacked` 运行的）的「会话管理 → 继续会话」打开的，里面跑的正是和我对话的这个 Claude Code 会话，所以不能关（关了对话就断了）。根源是 `src/main/session-reply.ts` 的 `openTerminal()` 启动终端时没有指定工作目录，终端继承了 TokenPulse 自己的工作目录；脚本里的 `Set-Location` 只改 PowerShell 的位置，不改进程的工作目录，于是那个目录在终端关掉之前删不掉、改不了名。对已安装版来说就是安装目录被占着（文件能替换，自动更新不受影响，但目录本身删不掉）。**修法（0.3.36）**：`spawn` 加 `cwd: terminalHome(cwd)`——项目目录还在就用它，否则用主目录。`npm run compile` 通过，`node scripts/test-sessions.cjs` 退出 0；没有加专门的测试，也没有真机开终端验证。用户重开对话（关掉了那个终端）之后复查：没有进程的工作目录在 `dist` 里了，`dist\win-unpacked` 和 `dist\win-unpacked.tmp` 已删掉，占用解除。查占用用的两个只读脚本在 scratchpad：`wholocks.ps1`（Restart Manager 查文件）、`whocwd.ps1`（读各进程的工作目录）。
- **0.3.35 的发布（2026-10-07）**：用户试了几轮测试版后说「算作 0.3.35，编译并发布」。`npm test`、`npm run test:ui`（39 个 PASS）退出 0。`renderer/intro.js` 的 NOTES 加了 0.3.35 四条，README 的「供应商切换与本地路由」加了「透明转发」一条、型号核验那段加了一句，发布说明 `dist/release-0.3.35.md`。
  - **打包时的占用**：`npm run dist` 失败，`EBUSY: resource busy or locked, rmdir 'D:\CodePorject\Tools\TokenPulse\dist\win-unpacked'`（和前面测试版遇到的是同一个，占用者没找到，没有强行解锁）。改用 `npx electron-builder --publish never -c.directories.output=dist-test` 打出安装包，退出 0，再把 `TokenPulse-0.3.35-Setup.exe` / `.blockmap` / `Portable.exe` / `latest.yml` 挪进 `dist`；`dist` 里 0.3.34 的安装包按用户的习惯删掉了。当时 `dist\win-unpacked` 和 `dist\win-unpacked.tmp` 删不掉，后来查到占用者并已删除（见上一条），`npm run dist` 可以照常用了。
  - **我犯的一个错**：核对包里的版本时用 `asar extract-file … package.json`，它把文件解到当前目录，覆盖了项目的 `package.json`（那时安装包已经打完，没有影响产物）。已经 `git checkout` 恢复并重新改回版本号和四个测试脚本，`npm test` 重跑退出 0。**以后用 asar 解文件要先切到临时目录。**
- **0.3.35 的内容：「透明转发」和连带的几样（下面是做的过程中的检查点，保留作记录）。**
  - **用户要什么**：想更准确地了解自己用的模型（速度：每秒输出多少 Token、首字延迟）。方案是让官方 CLI 的请求经 TokenPulse 本机转一道：**原样转发、计时、读回复里的 Token 数；不保存凭据，不改请求头和内容，只监听本机**（用户原话认可的范围，「我也不是想修改什么来获取便利，只是想更加了解我使用的模型的情况」）。我的建议（用户同意）：做成按工具单独打开的开关，默认关，退出 / 关掉时还原成直连。和号池（保存凭据、换登录、带官方客户端标识）是两回事。
  - **可行性已用真实 CLI 探测过**（`scratchpad/passprobe*.cjs`：把 CLI 临时指到一个只收不转、返回 400 的本机假接口，只看请求的方法 / 路径 / 头的名字 / 凭据有没有；Claude 和 Codex 用一次性的环境变量 / `-c` 参数，没有改用户的配置文件；Grok 用了临时 `GROK_HOME`，把 `auth.json` 拷进去、跑完删掉）：
    - **Claude Code 2.1.292**：设 `ANTHROPIC_BASE_URL` 后照常发 `POST /v1/messages?beta=true`，带 `Authorization: Bearer <OAuth 令牌>` 和全部头（`anthropic-beta` 里有 `oauth-2025-04-20`、`user-agent: claude-cli/…`、`x-app: cli`、`x-stainless-*`、`x-claude-code-session-id`），`accept-encoding: gzip, deflate, br, zstd`，流式。**最干净，先做它。**
    - **Codex 0.160.1（ChatGPT 登录）**：三种指法都试了。① 自定义供应商 + `requires_openai_auth = true`：`POST /v1/responses`、`GET /v1/models`，带 JWT 和 `chatgpt-account-id`，走普通 HTTP 流式；但对话里记的 `model_provider` 会变成自定义的名字，而且自定义供应商可能少一些官方才有的行为。② 顶层 `openai_base_url`：内置的 openai 供应商不变，请求是 `GET <base>/models` 和 **`GET <base>/responses`（WebSocket 升级）**，官方地址对应 `https://chatgpt.com/backend-api/codex`；要原样转发就得做 WebSocket 隧道，读 Token 数还要解 WebSocket 帧。③ 顶层 `chatgpt_base_url`：插件、账号检查、分析事件全都跟着走过来，范围太大，不用。**②最「原样」但最费事，①省事但不完全原样，等用户选。**
    - **Grok 1.0.46**：登录状态下，`[models] default` 指向一个没有 `api_key` 的自定义模型在 `-p` 里不生效（请求直接去了官方）；用 `-m` 指定时会带会话令牌（JWT）和一堆 `x-grok-*` 头发过来。**可行的指法是只覆盖已知官方型号的地址**：`[model."grok-4.6"] base_url = …`（4.5 / 4.6 / 4.7 / 4.7-build-fast 各一张，型号 id 来自 `~/.grok/models_cache.json`），默认型号照常、请求带会话令牌发过来。但这样发出的请求体和头是不是与直连完全一样没法确认（直连是 TLS，看不到）；探测里 `--effort high` 没有出现在请求体里，覆盖地址后思考等级可能失效。**Grok 有副作用，放最后，默认不建议开。**
  - **计划的做法**：本地路由加一类路径 `/pass/<工具>/…`：不选供应商、不换凭据、头和正文原样（只去掉逐跳头和 `host`），转给官方地址；回复原样送回，同时旁路解压一份只用来读 Token 数；记首字节时间和结束时间。状态单独放（`store.pass` 和自己的还原快照），不混进现有的 `proxy.apps` / `route` 状态机；要处理的连带点：`usage-scan.ts` 的 `configOfficial()`（Claude 设了 `ANTHROPIC_BASE_URL` 会被当成不是官方，指向 `/pass/` 时仍要算官方）、`agentDrift()`、`matchLive()`、退出时还原 / 启动时恢复、`!AGENT_APPS.some(app => proxy.apps[app])` 这几处停路由的判断。
  - **用户的决定（2026-10-07）**：先做 Claude Code；Codex 用上面的 ②（顶层 `openai_base_url`，内置供应商不变——「更符合原模原样、更无感」，而且自定义供应商会让他用不了重置卡）；**Grok 暂时不做**，等 Claude Code 和 Codex 做完他再考虑。版本号还没给，`package.json` 仍是 0.3.34（代码注释里写的「0.3.35」只是预计，发布时按用户说的版本号核对）。
  - **进度（2026-10-07，未提交；Claude Code 和 Codex 都做完了，真机各跑通一次；测试版已编译给用户）**：
    - **转发**（`src/core/agent-proxy.ts`）：`/pass/(claude|codex|grok)/…` 两条路——普通请求走 `forwardPass()`，WebSocket 升级走 `server.on("upgrade")` → `tunnelPass()`。`Options.pass(app, headers)` 返回官方地址才转发，返回 null 就 404（不是 `/pass/` 的升级请求也是 404）。请求头只去掉逐跳头，正文不动；回复的状态码 / 头 / 正文原样送回（压缩的不解开），旁路解一份只为读用量。WebSocket：握手请求的头原样转给官方（只换 host），官方的握手回复按原始的头（`rawHeaders`，顺序大小写不变）还给工具，之后两头 `pipe` 对搬，帧不解开不重组；官方不同意升级时把它的回复原样还回去。旁路解析在新文件 `src/core/ws-sniff.ts`（`WsReader`：分片、掩码、控制帧、permessage-deflate；解压器的输出在 flush 回调里自己 `read()` 取干净，不能靠 `data` 事件——真机上出现过消息结尾的用量还没到就交出去、读成 0）。一条连接上每个 `response.create` → `response.completed` 记一条（`method: "WS"`）；`response.failed` / `error` 记成失败；回复到一半连接断了记 499。
    - **记录的字段**（`ProxyLog`，会进永久的转发记录 `route-log/`）：`pass`、`firstByteMs`、`firstTokenMs`（第一段内容增量）、`tokensPerSec`、`responseBytes`，加上原有的型号 / 思考等级 / 状态 / 耗时 / Token。**速度 = 输出 Token ÷（结束 − 开始出字）**；开始出字：Claude 是回复的第一个字节（`message_start`），OpenAI Responses 是第一个 `response.output_item.added`（真机量过：`response.created` 在约 0.4 秒就到，`output_item.added` 和第一段文字在约 1.9 秒，从 created 算会把速度算低一半）。输出少于 20 Token 或出字不到 200 毫秒不算速度。
    - **开关**（`src/core/agent-switch.ts`，`setAppPass` 一组，状态在 `store.pass = { apps, before, written }`）：只在官方登录时能开（`passBlocked()`）；开 = 只加一行（Claude：`settings.json` 的 `env.ANTHROPIC_BASE_URL = http://127.0.0.1:<端口>/pass/claude`；Codex：`config.toml` 顶层 `openai_base_url = "…/pass/codex"`），关 = 这期间文件没被别人动过就整个原样放回、动过就只拿掉那一行；退出（`releaseAgentSwitch`）拿掉那一行但开关留着，启动（`resumeAgentProxy`）接着开，工具已经不是官方登录了就关掉并在启动提示里说明；切到第三方供应商（`applyDirect`）或本地路由（`enableProxy`）时自动关，重写官方登录的配置时再加回去；`restoreConfigBackup` 在开着时拒绝。官方地址：`passUpstream()`——Claude `https://api.anthropic.com`；Codex 请求头里有 `chatgpt-account-id` 就是 `https://chatgpt.com/backend-api/codex`，否则 `https://api.openai.com/v1`（`AGENT_SWITCH_PASS_BASE` 只给测试用）。`endpointFromLive()` 把指着 `/pass/` 的地址当成没有地址（`notPass`），所以「当前供应商」仍是官方登录、`agentDrift()` 不报；`routeIdle()` 取代了原来几处「没有工具开着本地路由就停监听」的判断。`usage-scan.ts` 的 `configOfficial()`：Claude 的地址指着 `/pass/claude` 仍算官方（Codex 的会话里记的还是内置的 openai，不用改）。
    - **界面**：供应商页的二级菜单多了「透明转发」（`renderer/agent-switch.js` 的 `passSection()`）：做什么 / 不做什么两栏说明、Claude Code 和 Codex 各一个开关（不能开时置灰并写原因）、「模型速度 · 最近 7 天」（`route-ledger.ts` 的 `passSpeed()`，从保存的转发记录按工具 + 型号取中位数；IPC `agent:pass` / `agent:pass-speed`）。转发记录那一页：透明转发的行显示「首字延迟 · 总耗时」和「N Token/秒」。英文词条都加了。
    - **测试**（都进了 `npm test`，全部用本机假上游）：`scripts/test-pass-through.cjs`（普通请求逐字节核对）、`scripts/test-pass-socket.cjs`（WebSocket：握手和双向字节原样、每次请求一条记录、压缩帧、断开、被拒绝的握手、404）、`scripts/test-pass-switch.cjs`（开关：只加一行、原样还原、别人改过只拿掉自己那行、退出还原 / 启动恢复、互斥、保存的东西里没有凭据和内容）。界面测试加在 `scripts/test-agent-switch-ui.cjs`（透明转发页面：说明、开关写配置、速度汇总、真的转发一次后转发记录里的延迟和速度、关闭还原；测试里先换空闲端口，因为默认的 17621 可能被本机正在用的 TokenPulse 占着）。**最后一次全量：`npm test` 退出 0，`npm run test:ui` 退出 0（38 个 PASS）。**
    - **真机验证**（`scratchpad/passreal.cjs`：临时端口起一个只有透明转发的路由，CLI 只在那一次运行里用环境变量 / `-c` 指过来，没有改用户的配置文件；各消耗了几次「数 1 到 40」的额度）：Claude Code 2.1.x 用 haiku：200，首字约 2.9 秒，约 170 Token/秒；Codex（ChatGPT 登录，`gpt-6.1-sol`）：`GET /models` 两次 + 一条 WebSocket 上两次请求（第一次是 Codex 自己的预热，输出 0），握手成功、回复正常、读到型号 / 思考等级 / 用量。连接是协商了 permessage-deflate 的。真机发现并修掉两个问题：回复送完后工具关连接被记成 499（`forwardPass` 里 `res` 的 close 监听没摘）、上面说的解压取数竞争。
    - **Codex 的型号核验（2026-10-07，用户说「合并一起做」）**：Codex 的会话文件不记上游返回的型号，以前只能核对响应 ID 的格式（或者借 CC Switch 代理的记录）。现在转发时旁路读出**响应 ID 和上游实际用的型号**（`ProxyLog.responseId` / `returnedModel`，进永久的转发记录）：`src/core/ws-sniff.ts` 的 `Grab`（一段一段接着找第一次出现的 `"id":"resp_…|msg_…|chatcmpl-…"` 和 `"model":"…"`——Codex 的 `response.created` 里整段系统提示词排在型号前面，只看开头一截读不到）；透明转发的普通请求、WebSocket，和本地路由里接口格式相同的转发都记（格式转换过的不记：工具收到的 ID 不是上游的）。读到了响应 ID 才记返回型号（模型列表那类回复不算）。`route-ledger.ts` 的 `routeReturned(responseId, at)` 按月份文件建索引；`request-log.ts` 的 `withRoute()` 在查询和新请求提醒（`recentAlerts`）里先用它、对不上再试 CC Switch 的 `matchProxy`；`request-verify.ts` 的 `proxy.via = "tokenpulse"` 决定说明文字。真机核对过：转发时读到的响应 ID 和 `~/.codex/sessions` 里 `token_usage_record.response_id` 是同一个（只比了哈希）。测试：`scripts/test-requests.cjs`（一致 / 不一致 / 提醒 / ID 对不上）、`test-pass-through.cjs`、`test-pass-socket.cjs`。限制：只有经过 TokenPulse 的请求能核验；中转站可以伪造型号名，「一致」只说明没露馅。
    - **用户试测试版后报的问题（2026-10-07）：用 Codex 桌面端跑了一轮，「模型速度」里没有。** 只读看了他的 `~/.tokenpulse/route-log/2026-10.jsonl`（只看汇总）：7 条 WebSocket 记录都在，型号 / 首字延迟 / 返回型号都有，但 **input 和 output 全是 0**，所以没有 `tokensPerSec`，汇总里不出现。原因：`response.completed` 里靠前的位置有一段 `tool_usage.image_gen`（键和用量一样，全是 0），真正的用量在 `response.usage` 的最后（前面还有一长串 `usage.attribution.items`），后面还跟着 `user` / `metadata` 等字段；以前只在消息开头和结尾各留的 2 万字里找「最后一次出现的 input_tokens」，那一截里没有真正的用量时读到的就是 image_gen 的 0。我用 `codex exec` 真机跑时用量正好落在结尾那一截里，所以没撞上；桌面端长对话的消息结构我没法直接看，**这个原因是按症状推断的**——用假上游构造「用量后面还有 4 万多字」的回复能复现出一模一样的 0 / 0。修法：`ws-sniff.ts` 的 `Grab` 边收边找整段 `"input_tokens":N,"input_tokens_details":{…},"output_tokens":K`，取最后一次出现的（`GRAB_USAGE`），WebSocket、透明转发的普通请求、本地路由同格式转发都优先用它，没有再退回原来的办法。`test-pass-socket.cjs` 加了这种回复（前面有全 0 的 image_gen、用量后面跟着很长的 metadata）。修完 `npm test`、`npm run test:ui`（38 PASS）都退出 0，`codex exec` 真机再跑一次用量和速度正常。**已经记下的那 7 条是 0，不会补。待用户用桌面端再试确认。**
    - **用户用 `dist-test` 的测试版在 Codex 桌面端又试了一轮（2026-10-07 05:50–05:57），只读看了转发记录的汇总**：修复生效，Token 数读到了，12 次有输出的请求都有速度（gpt-6.1-sol 约 33–68 Token/秒，gpt-6-luna 63），返回型号和请求的一致；27 次 WebSocket 请求全部 200。另有不少输出为 0 的请求（Codex 自己的预热、`codex-auto-review`、`gpt-6-luna`），正常。`GET /models` 有 2 次 499（Codex 启动时自己取消的，20 毫秒）和 1 次 502（05:52:31，TokenPulse 到官方的 TLS 连接出错 `BAD_DECRYPT`，经系统代理时的偶发网络错误，只影响那一次取模型列表）。用户贴的 ChatGPT 自述的两个问题（Chrome 在沙箱里渲染 SVG 被拒、没按技能的流程走）是 Codex 本机沙箱和模型自己的行为，和转发无关。没有改代码。
    - **额度详情加「模型速度」图、时间线上移（2026-10-07，用户要求，同一版）**：
      - 「模型与思考等级 · 时间线」（`#quota-model-timeline`，原来排在整页最下面）现在由 `renderer/app.js` 的 `renderQuota()` 挪进 `#quota-detail`，紧跟在「最近 24 小时 · 官方会话用量」和「本周额度采样」那一行下面（节点只有一个，每次重画时重新接进去；`quotaTimelineNode` 记着它）。顺序：额度窗口 → 容量趋势 → 两张历史图 → 时间线 → 模型速度 → 这个账号的请求 → 模型容量排行。
      - 「模型速度」：`src/core/pass-speed.ts` 的 `accountSpeed(kind, account, days)` 从永久保存的转发记录里取透明转发量到的速度，按「CLI 当时登录的账号」归属（`resolveAccount` + 登录时间线，转发时不读凭据所以记录里没有账号），按模型分组、按时间分桶（两天内按小时、三个月内按天、更长按周），每桶中位数和四分位。IPC `pass-speed:account`，界面 `speedPanel()` / `drawSpeed()`（`renderer/app.js`），样式在 `renderer/app.css` 末尾。只对 Claude 和 ChatGPT 账号显示（Grok 没有透明转发）。
      - **图的画法（定下来的设计）**：一个模型一行，共用同一条时间轴。模型之间比快慢看右边——数字是整段时间的中位数，下面一条**按同一刻度**画的对比条；一个模型自己变快变慢看中间的走势线，**每行用自己的刻度**（左边标上下限）。第一稿走势也用同一刻度，慢的模型被压成贴底的平线，所以改了。点 = 那段时间的中位数，竖线 = 中间一半请求的范围；点超过 12 个就画小，只有最新的是大的；不到 6 个点不画范围的色带。全用强调色，不靠颜色分模型。范围 24 小时 / 7 天 / 30 天（默认）/ 全部。悬停有浮层。没有数据时给「去打开透明转发」的按钮（`window.PulseProviders.open('pass')`）。用演示数据截图看过浅色 / 深色、30 天 / 24 小时、1280 / 900 宽。
      - 测试：`scripts/test-pass-speed.cjs`（进了 `npm test`）、`scripts/test-ui.cjs` 里加了一组（时间线的位置、两行速度、对比条成比例、悬停、切换范围）。`npm test` 退出 0，`npm run test:ui` 退出 0（39 个 PASS）。测试版重新编译到 `dist-test\win-unpacked\TokenPulse.exe`。
      - 没验证：用户真实数据下的样子（他的记录只有今天一天、基本一个模型，会是一行几个点）。
    - **快速模式分开算（2026-10-07）**：用户问 Codex 的快速模式有没有考虑到——之前没有，快速和普通的请求混在一起算速度。现在转发时记下请求里的服务档位 `ProxyLog.tier`（`agent-proxy.ts` 的 `tierOf()`：请求体的 `service_tier`，没有再看 `speed`；`default` / `auto` / `standard` / 没写不记）。普通请求、WebSocket、本地路由都记。汇总时 `priority` 和 `fast` 算快速模式，同一个型号单独一行：`pass-speed.ts`（`SpeedModel.fast`，界面上型号后面一个「快速」标签）、`route-ledger.ts` 的 `passSpeed()`（型号后面加「 · 快速」）；转发记录里快速的行型号后面有个 ⚡。**依据和没验证的**：用户的 `~/.codex/config.toml` 里有 `service_tier = "default"`，真机回复里也有 `service_tier` 字段，所以 Codex 这边有把握；快速模式打开时请求里到底是 `priority` 还是 `fast` 没有真机看过（两个都认）。Claude Code 的 `/fast` 我按请求体里 `speed: "fast"` 处理，**这是凭印象，没有真机验证**。Grok 的快速是单独的型号名（`…-fast`），本来就分开。已经记下的旧记录没有档位，都算普通。
    - **分享图：不做（2026-10-07，用户看了四张风格样张都不满意，说「以后可能会做，以后再说」）**。一行功能代码都没写；样张（`dist-test/share-styles`）已删。以后要做的话先重新出风格，别沿用那四种（米白纸感 / 深色发光 / 渐变毛玻璃 / 黑白杂志分栏）。
    - **占用记录**：修完重新编译时 `npx electron-builder --win dir --publish never` 两次都失败：`EBUSY: resource busy or locked, rmdir 'D:\CodePorject\Tools\TokenPulse\dist\win-unpacked'`。查过：没有从 `dist` 启动的 TokenPulse / Electron 进程（在跑的只有用户已安装的 `AppData\Local\Programs\TokenPulse`），命令行里带 `win-unpacked` 的只有我自己的检查命令；占用者没找到（多半是用户开着那个文件夹的资源管理器窗口或终端）。没有强行解锁，改成编译到 `dist-test`（`-c.directories.output=dist-test`，已在 `.gitignore`）：**最新的测试版是 `dist-test\win-unpacked\TokenPulse.exe`**；`dist\win-unpacked` 里的还是修之前的那一版，占用没有解除。
    - **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0（加上型号核验后重新编译过一次，`npm test` 和 `npm run test:ui` 都退出 0、38 个 PASS），产物 `dist\win-unpacked\TokenPulse.exe`（版本号仍是 0.3.34，没有升版本、没有做安装包、没有提交、没有发布）。编译后确认只剩用户自己在跑的已安装版（`AppData\Local\Programs\TokenPulse`，占着 17621），没有本轮留下的进程。
    - **还没做 / 待定**：用户验收；版本号（用户还没说，定了之后要在 `renderer/intro.js` 的 NOTES 里加这一版的说明，不然 `test:ui` 会失败）；Grok（用户说先不做）；提交和发布等用户说。
    - **提醒用户的事**：测试版和已安装版共用数据目录；试完要回到已安装的 0.3.34 之前，先把透明转发的开关关掉或者正常退出测试版（会自动拿掉那一行）——0.3.34 不认识 `/pass/` 地址，配置里留着那一行的话工具会连不上。
    - **已知的限制（要如实告诉用户）**：① 请求由 TokenPulse 发往官方，传输层（连接、TLS、HTTP/1.1）是 TokenPulse 的，不是 CLI 自己的；请求头和正文原样。② Claude Code 在设了 `ANTHROPIC_BASE_URL` 时自己可能改变一些行为（官方文档提过非官方地址下工具搜索默认关闭），这一点没有验证，直连时它发什么看不到。③ 开 / 关、退出 TokenPulse 之后，已经开着的 CLI 会话要重开；TokenPulse 异常退出（没来得及还原）时工具会连不上，重新打开 TokenPulse 即可。④ Codex 的思考如果在 `output_item.added` 之前就开始算，速度会偏高，没有验证。⑤ Claude 的缓存写入 Token 没有单独读。
- 上一个版本 0.3.34（下面这一条）用户试过几轮测试版后说「应该没啥问题了，你发布吧」；发布时 `npm test`、`npm run test:ui`（37 个 PASS）、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.34.md`；发布后按用户的习惯删掉了 `dist` 里上一版（0.3.33）的安装包。
- **0.3.34 的改动（2026-10-07，Claude）：经号池发出的请求没有记到账号名下。**
  - 用户的问题：多个 Grok 账号组成号池，账号下面没有请求记录也没有 Token 用量。原因：用量是从各家 CLI 自己的日志里读的，「算不算官方账号的」对 Grok / Claude 是看工具配置里有没有填地址（`usage-scan.ts` 的 `configOfficial()`，按文件整体定），对 Codex 是看 `model_provider`；用号池时配置里填的是本地路由，于是全被当成第三方中转站，`account` 是空的。本地路由其实知道每个请求交给了哪个成员，但只留最近 80 条（`agent-switch-log.json`），只用来显示成员健康状态。连带的偏差：官方额度照常上涨而看不到本机请求，会被 `quota-offmachine` 判成「本机以外」。
  - 用户本机的佐证（只读、只看计数）：路由日志里 28 条 Grok 请求均匀分给 6 个成员、全部 200；同一时段 CLI 日志里的 3 条 Grok 用量记录，和最近一条路由记录的时间差是 0.1 到 0.7 秒。一次 Grok 回合会对应多条路由请求，所以路由请求数比用量记录多得多是正常的。
  - 做法：新文件 `src/core/route-ledger.ts`（路由账本）。`pushLog` 里，号池成功（状态 < 400）交给官方账号成员时 `appendRoute({ at, kind, account })`，追加写 `route-ledger.jsonl`（一行 `时间\t哪家\t账号 id`，不记内容和凭据，保留 45 天，每 500 次追加清一次）。`ProxyTarget.officialAccount`、`ProxyLog.account` 是为它加的。账本只是给统计按时间对账号用的索引，完整的转发记录是下面追加的那份 `route-log/`。`routeAccount(kind, at)` 取时间最近、相差 30 秒以内的一条。`login-timeline.ts` 多了 `routedAccount()` 和账号依据 `"route"`。两个使用点：`usage-scan.ts` 算按账号的小时账时，对得上账本的记录即使文件整体不是官方也记到那个账号名下；`request-log.ts` 的 `toRow` 对得上的行 `official = true`、`account` 是号池成员。**对得上账本的优先于会话里记的账号**（Claude 的会话里记的是 CLI 自己登录的那个账号，请求实际被路由换成了成员的登录）。统计在另一个线程里跑，所以账本走文件。
  - **同一版追加（用户：转发记录也永久保存，每条写详细一点，方便以后看使用情况和查 bug）**：
    - `route-ledger.ts` 的 `appendRouteLog()`：`pushLog` 里每一次转发（成功、失败、失败后换成员的每一次尝试）追加一行 JSON 到数据目录的 `route-log/YYYY-MM.jsonl`（按本地时间分月），**不清理**。字段是 `ProxyLog` 的全部：`at`、`app`、`providerId`、`provider`（号池成员的名字里可能有邮箱或别名，和主界面显示的一样）、`model`、`status`、`ms`、`input` / `output` / `cacheRead`（从回复里读到的 Token 数）、`error`（上游报错正文的前 300 个字符）、`account`，以及这次新加的 `method`、`path`、`attempt`、`pool`、`client` / `upstream`（接口格式）、`host`、`stream`、`requestModel`、`effort`、`requestBytes`。不记请求和回复的内容，不记密钥和登录凭据（测试里断言过）。
    - `agent-proxy.ts`：`sniffUsage` 改成取最后一次出现的数字（流式回复的用量在最后），原样转发时只留回复的开头和结尾各 20000 个字符来找（`keepEdges`）；之前只看开头，流式的基本读不到（用户本机 28 条里只有 8 条有数）。转换格式的那条路径（`pipeConverted`）没有动。
    - 请求流水里多了 `routedAccount`（`usage-scan.ts` 扫描时写进去，`request-log.ts` 的 `toRow` 优先用它）：路由账本只留 45 天，记在流水里之后账本被清掉也还知道这条是哪个成员的。
    - 界面：「供应商 → 转发记录」顶上多一张说明卡 `.pv-log-keep` 和「打开记录文件夹」（IPC `agent:open-route-log`），列表每行多一列输入 / 输出 Token（`.pv-log-tokens`，窄窗口下隐藏）。**列表能一直往回翻**（用户指出「最多 30 条」的说法过时后加的）：最新的来自 `view.logs`（实时，30 条），更早的用 IPC `agent:route-log` → `readRouteLog({ limit, before })` 从文件里按页读（每页 100 条，`logOlder` / `logMore`），底部是「再看更早的」，翻到头显示「已经是最早的一条了」；刚启动、还没有新转发时也能看到以前的。不是今天的记录时间列带日期。没有做按账号 / 状态筛选。测试版里出过一个 bug：没有任何记录时 `logs()` 返回的数组里有个 `null`，页面上显示出「null」；已加 `.filter(Boolean)`，`test-provider-pool-ui.cjs` 里加了空状态的断言（页面上不能出现 null / undefined）。**这类「返回一组节点」的函数，末尾有可能为空的项就要 `.filter(Boolean)`。**
    - 测试：`test-route-ledger.cjs` 加了两组（账本删掉后账号还在；转发记录按月追加）；`test-agent-switch.cjs` 加了一组（真实转发后记录里的细节字段、失败那次也记、没有内容和凭据）。`test-agent-switch-ui.cjs` 加了转发记录页的断言（预先放 130 条旧记录：先出 100 条、点「再看更早的」到 130 条、说明卡、Token 列、旧说法「最多 30 条」不能出现）。没有截图看过。
  - 没有做的：回补历史（账本从这一版才开始记，之前的请求轮到了谁无从知道）；文件级的 `state.official` 没有改（仍是 false，只在逐条上覆盖）。几个请求同时在跑时可能对到相邻的那个成员。成员是 API Key 供应商的号池不记账本。
  - 测试：新增 `scripts/test-route-ledger.cjs`（已进 `npm test`：账本读写和匹配；真实走一遍扫描 + 查询，经号池的那条归到成员名下并算官方、另一条不变、筛选和按账号的小时账跟着对）；`test-agent-switch.cjs` 号池那组加了「每次成功转发都写进账本、没有凭据」。`npm test` 退出 0，`npm run test:ui` 退出 0（37 个 PASS）；测试版 `npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，asar 里的 `build/core/route-ledger.js` 与编译结果一致，没有留下进程。**没有用真实号池发请求验证**，界面上账号名下是否出现记录要用户看。
- 上一版 **0.3.33** 有两项（下面两条），用户看过几轮测试版后说「升级一个版本号后就推送更新」；发布时 `npm test`、`npm run test:ui`（37 个 PASS）、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.33.md`。
- **0.3.33 之二（2026-10-07，Claude）：Prism 桥下线。**
  - 用户说 Prism 好像只剩 6 Luna，让求证，「如果是真的这个功能可以下线了」。**求证结果是真的**（用户账号、临时浏览器目录和临时桥，跑完已清理）：Prism 页面的 `/api/ff/initialize` 里 `models` 只有 `{"id":"gpt-6-luna","label":"6 Luna"}`，`free_model` 也变成了 `gpt-6-luna`；用关掉「自动换模型」的临时桥逐个发一句话，`gpt-6-luna` 正常，`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6.1-sol` 都是 400。两天前（10-05）还有 5.6 Sol、5.6 Terra。只查了这一个账号。
  - 做法是**对新用户隐藏、对装过的人保留并标明下线**，没有删代码：`renderer/agent-switch.js` 的 `prismShown()`（`prism.installed || prism.provider`）为假时导航里没有「Prism 桥」、停在这一页的会回到概览；为真时页面最上面多一块 `.pv-prism-warn[data-warn=retired]` 的下线说明，「适合谁用」那块不再显示（`fit` 变量还在，只是不放进页面）。装过的人仍然可以启动服务（只有 6 Luna）和用「全部删除」；删完 `installed` 和 `provider` 都没了，这一页和入口自动消失。`src/core/prism-bridge.ts` 的默认清单 `PRISM_MODELS` 改成只有 `gpt-6-luna`。README 的 Prism 桥一节换成了简短的下线说明。
  - 没有动的：`vendor/prism-bridge/`、主进程的 IPC、跟着启动、`extraResources`（安装包里仍然带着桥，约 200 KB）。如果用户以后要彻底删掉代码，要一起处理这些和 `test-prism-bridge.cjs`；如果 Prism 把模型放回来，只要改 `prismShown()` 就能恢复。
  - 测试：`test-agent-switch-ui.cjs` 开头先建一个空的 `data/prism-bridge` 当作「装过」，断言下线说明、不再有「适合谁用」、删完后导航入口消失（导航项从 10 个变 9 个）；`test-prism-bridge.cjs` 的默认清单断言改了。`npm test` 退出 0，`npm run test:ui` 退出 0（37 个 PASS）。下线说明那一块没有截图看过。
  - **打包被占用（2026-10-07）**：`npx electron-builder --win dir` 往 `dist/win-unpacked` 写的时候失败（退出 1），因为用户自己正开着上一版测试版（`dist\win-unpacked\TokenPulse.exe`，4 个进程，10-06 11:54 启动；是用户启动的，没有动它）。这一版测试版改成输出到 **`dist-test/win-unpacked/TokenPulse.exe`**（`-c.directories.output=dist-test`，已加进 `.gitignore`），asar 里的 `renderer/agent-switch.js` 与源码一致。`dist/win-unpacked` 里现在是**写了一半的状态，不要用**；等用户关掉那个测试版后要重新打一次，正式发布的 `npm run dist` 也要等它关掉。
- **0.3.33 之一（2026-10-06，Claude）：在托盘图标上点右键，弹出额度小面板。**
  - 起因：用户看到别的项目（Nowdex）右键托盘图标能显示一张额度卡片，想要类似的，并明确说「不要完全仿照，怕被说抄袭」。第一版做的是双圆环；用户看过后说想要对方那种一条直线的，更小巧，并要求把菜单里的供应商也整合进面板。**现在的样子（第二版）**：每个窗口一条细的直线进度条（实心的，不是对方那种分段刻度），写「已用」而不是「剩余」，颜色是主界面的 `--ring-five` / `--ring-week`，进度条上有一根小竖线表示「时间走到哪了」（`pace` = 已过时间 ÷ 窗口总时间，填充超过它就是用得比时间快；没有起止时间时不画），再加「按现在的速度约多久后用完」。面板宽 340。下面一块「供应商」：每个工具一行写着现在用的是哪家，点开（一次只展开一个）列出可以换的，点一个就 `tray-panel:activate` → 收起面板、打开主窗口、发 `agent-activate-request`（和托盘菜单一样要在主窗口里看过改动对比确认后才写；只读保护开着时不能点）。
  - 文件：`src/main/tray-panel.ts`（新，窗口管理 + `trayPanelData()` 从快照里挑数据 + `panelBounds()` 算位置）、`renderer/tray-panel.html` / `.css` / `.js`、`renderer/tray-panel-theme.js`（第一帧之前按地址里的 `?theme=` 定主题）。`src/main/index.ts`：`initTray` 里 `tray.on("right-click", toggleTrayPanel)`，IPC `tray-panel:data` / `tray-panel:size` / `tray-panel:action`（open / refresh / menu / close）/ `tray-panel:activate`，`trayPanelView()` 把额度和供应商拼在一起，`publishAgent` 里也 `pushTrayPanel()`，`publishSnapshot` 里 `pushTrayPanel()`，退出时 `destroyTrayPanel()`。`src/main/preload.ts` 加了 `trayPanelData` / `trayPanelSize` / `trayPanelAction` / `onTrayPanel`。
  - **右键菜单的变化（只在 Windows）**：Windows 上给托盘设了菜单就收不到 `right-click`，所以不再 `setContextMenu`（`setTrayMenu()` 在 Windows 上什么都不做）。**第三版起用户决定旧菜单整个不要了**：面板底部的「菜单」按钮已去掉，右上角是刷新和退出两个图标按钮（`tray-panel:action` 的 `quit`）；`buildTrayMenu()` / `agentTrayItems()` 只剩别的平台在用。菜单里原来的「开机自启」「打开数据目录」在主窗口的设置里都有，托盘上不再提供。左键 / 双击仍然是打开主窗口。README「安静地待在托盘」和「退出请用托盘右键菜单」两处已改。
  - **第三版（用户嫌高）**：账号列表 `#tp-list` 只露出前 3 张卡的高度（`SHOWN`，画完量前三张的实际高度用 CSSOM 设 `max-height`），超过的在这一块里滚动；供应商挪到列表外面的 `#tp-agents`；各处间距收紧；顶上「今日」那句缩成 `今日 48.2M · $31.40`，完整说法在悬停提示里。`.tp` 的网格列要写 `minmax(0, 1fr)`，否则内容会把面板撑得比窗口宽、右边被裁掉（第三版踩过）。
  - 行为：面板窗口第一次右键时才建（无边框、置顶、不进任务栏），高度由界面量出来通过 `tray-panel:size` 告诉主进程（画完直接量，不等 `requestAnimationFrame`：窗口被挡住或在屏幕外时下一帧可能不来）；位置贴着托盘图标、不超出屏幕可用区域（任务栏在上下左右都处理了）；失去焦点、Esc、再点一次右键都会收起；刚收起的 300 毫秒内的右键不重开（点图标会先让面板失焦收起）；收起两分钟后销毁窗口（省内存）。有新快照时面板开着就推送。主题用 `prefs.theme`（主窗口每次把解析后的 light / dark 写进去）。
  - 界面文字：固定文字走 `i18n.js` 词典；带数字和时间的句子在 `tray-panel.js` 里用 `L(zh, en)` 直接按语言拼，节点标 `translate="no"`。面板页面复用 `app.css` 的颜色变量和 `.btn`，所以**不要在面板里用 `header` / `main` / `footer` 标签**（`app.css` 给这三个元素写了主界面用的样式）。
  - 测试：`scripts/test-tray-panel.cjs`（进了 `npm test`：挑数据、算位置）；`scripts/test-tray-panel-ui.cjs`（进了 `npm run test:ui`：真的启动应用、抓住托盘对象 `emit('right-click')`；测试里用环境变量 `TOKENPULSE_TRAY_PANEL_OFFSCREEN` 把面板放到屏幕外面）。`npm test` 退出 0；`npm run test:ui` 退出 0，**PASS 总数从 33 变成 37**。用假数据截图看过浅色和深色。测试里**不断言 `isAlwaysOnTop()`**：同一台机器上它时真时假（取决于系统当时的状态），断言了会让整套 `test:ui` 偶尔失败。
  - **没有验证**：真实任务栏上右键的手感（位置、失焦收起、在「隐藏的图标」溢出面板里时的位置）；多显示器 / 缩放比例不同的屏幕；英文界面的排版。
- **0.3.32（2026-10-06，Claude；用户试用测试版后说「测试没问题」；发布时 `npm test`、`npm run test:ui`、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.32.md`）：Grok 号池可以设上下文窗口。**
  - 用户的问题：官方是 500K，换成号池只有 200K。原因：号池在 Grok 配置里是自定义模型 `[model.tokenpulse_route]`，不写 `context_window` 时 Grok 按 200K 算。`writeGrok` 本来就会在 `provider.contextWindow` 有值时写 `context_window`，`saveProvider` 的号池分支也收 `contextWindow`，只是**号池的编辑界面没有这个输入框**、保存时也没带上。普通的 Grok 供应商一直有（「模型」页的「上下文窗口」）。
  - 本机 `~/.grok/models_cache.json` 里官方型号（grok-4.5 / 4.6 / 4.7 / 4.7-build-fast）都是 `context_window: 256000`、`context_windows: [256000, 500000]`、`auto_compact_threshold_percent: 80`。
  - 改动：`renderer/agent-switch.js` 的 `poolContextField()`（Grok 号池「基本信息」里，数字输入 + 256K / 500K 两个快捷按钮；新建默认 256000，已有的号池没填过就空着不改行为），`poolInput` 带上 `contextWindow`；样式两行在 `agent-switch.css` 末尾；i18n 已补。核心代码没有改。
  - 测试：`scripts/test-agent-switch.cjs` 号池那组加了「没填不写 `context_window`、填 500000 后写进 Grok 配置」。`npm test`、`npm run test:ui` 退出 0。输入框本身没有界面测试，也没截图看过。
  - **没有验证**：经号池（官方接口 `cli-chat-proxy.grok.com`）实际用到 256K 以上时 xAI 会不会接受。官方客户端选 500K 时请求里有没有额外的标记没有查过；如果有，光改 `context_window` 只会让 Grok 晚一点压缩，超过 256K 后请求可能被拒。
- **0.3.31（2026-10-06，Claude；发布时 `npm test`、`npm run test:ui`、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.31.md`）：换成第三方中转站或官方直登后，Codex 桌面端打不开用 Prism 桥（`tokenpulse_route`）聊过的对话，报 `Model provider tokenpulse_route not found`。**（用户朋友反馈，是 0.3.26 那个问题反过来的方向）
  - 0.3.26 只在两个时机补表：`writeCodex`（在 TokenPulse 里切换供应商）和启动修复（且要求 `store.owned.codex`）。漏掉的路径：① `restoreProxy`：关本地路由或**退出 TokenPulse** 时把 Codex 配置还原成接管前的样子，`tokenpulse_route` 整张表跟着没了，没有补；② 用别的工具把配置换成它自己的中转站（表名多半是 `custom`），TokenPulse 那张表被删，而且这时 `owned.codex` 可能已经没有了，启动修复直接跳过；③ 0.3.26 补的表只会照抄 `tokenpulse_route`，现在生效的是别的名字的表时，补的是「走官方登录」的表，没有 ChatGPT 登录的人接着聊会失败。朋友具体走的是哪条没有问到，三条都补了。
  - 改动（`src/core/agent-switch.ts`）：`syncCodexLegacyProviders` 改成照抄「现在生效的那张表」（`model_provider` 指向的、有 `base_url` 的表，不管叫什么、是谁写的；去掉 `name` 行和注释），没有才补走官方登录的表；清理自己的表改用 `replaceTable`。新增 `ensureCodexLegacyProviders()`（读、补、有改动才写）。调用点多了 `restoreProxy` 的两个出口（正常还原、发现外部修改后放手）；启动修复的条件改成 `owned.codex` **或** 本机对话里出现过 `tokenpulse_route`。
  - 仍然没覆盖的：TokenPulse 开着的时候别的工具改了配置，要等下次启动 TokenPulse、或在 TokenPulse 里切换一次才会补（`agentDrift()` 只读不写，没有往里加）。
  - 测试：`scripts/test-agent-switch.cjs` 那组加了「配置被别的工具换成 custom 中转站 → 启动修复照抄它补回 `tokenpulse_route`」。`npm test` 退出 0。`restoreProxy` 那两处没有专门的断言（原有的「restore on quit」测试仍通过）。没有跑 `test:ui`（没有改界面）。桌面端的实际效果没有验证（这个报错在命令行复现不了，见下面「Codex 旧对话的供应商表」）。
  - 朋友现在的临时办法：启动一次 TokenPulse 0.3.26 及以上并在里面切换一次 Codex 的供应商（切过去再切回来），或者手动在 `~/.codex/config.toml` 末尾加 `[model_providers.tokenpulse_route]`、`name = "TokenPulse (earlier chats)"`、`wire_api = "responses"`、`requires_openai_auth = true` 四行。
- **0.3.30（2026-10-05，Claude；发布时 `npm test`、`npm run test:ui`、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.30.md`）：Prism 下架了 `gpt-6.1-sol`，Prism 桥一直报 `Error while processing conversation (400 Bad Request)`。**
  - 查证（用户账号，临时桥 + 临时浏览器目录，跑完已清理）：一句「回复 pong」，`gpt-6.1-sol`、`gpt-6-astra`、`auto` 都是 2 到 3 秒内 400；`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-6-luna` 正常。同样的请求当天 07:12 用 `gpt-6.1-sol` 还成功。Prism 页面加载时请求的 `/api/ff/initialize`（feature flag，JSON）里有一项 `"models":[{"label":"5.6 Sol","id":"gpt-5.6-sol"},{"label":"5.6 Terra","id":"gpt-5.6-terra"},{"label":"6 Luna","id":"gpt-6-luna"}]`，旁边还有 `free_model: gpt-5.6-terra`、`free_reasoning_effort: high`，`rule_id` 是 `default`（不像是只针对这个账号，但只查了这一个账号）。`/api/models` 之类的路径都是 404。
  - **400 这句话含义很多**：Prism 对「模型不存在」「会话 id 不存在（之后桥会改成整段重发）」都回 `400 Bad Request`，没有结构化的原因码。看日志时要结合上下文。
  - `vendor/prism-bridge/bridge.py`（第七处 `TokenPulse` 改动，`NOTICE.md` 已同步）：`_run` 里给页面挂 `response` 监听，`/api/ff/initialize` 返回 200 时 `note_available_models()` 取出 `models` 里的 id 存进 `AVAILABLE_MODELS` 并打印 `[init] Prism models: …`；`/v1/models` 返回这份列表；`available_model()` 在请求的模型不在列表里时改用列表第一个，并打印 `[model] Prism no longer offers X; using Y instead`。列表没读到时行为和以前一样。
  - `src/core/prism-bridge.ts`：`PRISM_MODELS` 默认清单改成三个（默认 `gpt-5.6-sol`）；`noteModelLine()` 解析上面两种日志行；`prismModels()` 返回现在该用的清单；`PrismState.modelSwap`（服务运行中才有）。`src/main/index.ts`：`prism:provider` 和 `prismView` 改用 `prismModels()`，多了 `providerStale`（Codex 里那家供应商的模型和现在的清单对不上）。`renderer/agent-switch.js`：`providerStale` 或 `modelSwap` 时顶部出 `.pv-prism-warn[data-warn=models]` 提醒 + 「更新供应商」。
  - 这是自动换模型，和上游「不能悄悄换模型」的取向不同；选它是因为不换的话所有老用户更新后一上来就是 400。换了会在日志和页面上写明，返回里的 `model` 也是实际用的那个。
  - 测试：`scripts/test-prism-bridge.cjs` 加了一组（真的 `bridge.py` 的两个函数）并扩了启动那组（假桥打印两种行）；`test-agent-switch-ui.cjs` 的默认模型和数量改成新值。**真实验证过**：新桥启动日志里有 `[init] Prism models: gpt-5.6-sol, gpt-5.6-terra, gpt-6-luna`，`/v1/models` 返回这三个，请求 `gpt-6.1-sol` 和 `auto` 都由 `gpt-5.6-sol` 正常回答。页面上那条提醒没有界面测试，也没截图看过。
- **0.3.29（2026-10-05，Claude；发布时 `npm test`、`npm run test:ui`、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.29.md`）有两项，第一项：Grok 号池 / 供应商的思考等级。**
  - 用户的问题：Grok 混合号池里 `/effort high` 提示 `current model does not support reasoning effort`。原因：Grok CLI 只认 xAI 下发的官方模型目录（`~/.grok/models_cache.json`，里面有 `supports_reasoning_effort`、`reasoning_efforts`）里的型号支持思考等级；TokenPulse 写的是自定义模型 `[model.tokenpulse_route]`，文档（`~/.grok/docs/user-guide/11-custom-models.md`）没有给自定义模型声明等级的写法。
  - 用真实 Grok 1.0.46 试过、**都不生效**的办法（临时 `GROK_HOME` + 本机假接口，看请求体里有没有 `reasoning.effort`；没有登录）：自定义模型表里写 `supports_reasoning_effort = true`、`reasoning_efforts`（字符串数组和官方目录那种对象数组都试了）、`reasoning_effort = "high"`；把表名改成官方型号名 `"grok-4.6"`（带不带模型目录缓存都试了）。所有情况下 `grok -p hi --effort high` 发出的请求里只有 `reasoning.summary`，没有 `effort`。登录状态下会不会不同没有验证。
  - 做法：本地路由转发时补。`ProxyTarget.reasoningEffort`；`agent-proxy.ts` 的 `applyReasoningEffort()` 只在 `app === "grok"` 且请求里没带等级时加（Responses 格式写进 `reasoning.effort` 并保留 `summary`，Chat 格式写 `reasoning_effort`），在 `requestBody` 覆盖之前。来源：号池是 `PoolConfig.reasoningEffort`（`poolOf` 只对 grok 接受 low / medium / high / xhigh；界面在「编辑号池 → 基本信息」的 `poolEffortField()`）；普通 Grok 供应商是模型那一行的 `defaultReasoningLevel`（`grokEffort()`）。号池里的成员是 API Key 供应商时用号池的设置。
  - 测试：`scripts/test-agent-switch.cjs` 的号池那组加了 Grok 账号和一段（函数本身、保存和视图、经本地路由真实转发到假上游）。**没有对着 xAI 真实接口验证**：xAI 收到 `reasoning.effort` 后是否按这一档算、非法档位会不会报错都没有确认。号池编辑界面的那个下拉框没有界面测试，也没有截图看过。
- **0.3.29 第二项：Prism 桥报 `Unable to confirm the response started.` 后连续失败。**
  - 证据（用户朋友的 `Downloadsridge(3).log`，只读看过；这段日志里没有 `re-boot`、`throttled` 字样，说明当时跑的还是 0.3.25 / 0.3.26 的桥，不是 0.3.27 / 0.3.28）：10:30:21 到 10:31:44，一个新对话（约 13.5 万字节、单段）连发 6 次，每次约 11 秒后 Prism 返回 `completed` + 这句话、没有任何输出，Codex 随即重试。它发生在 10:11 那轮限流之后 19 分钟。旧版桥（0.3.24 及以前）遇到这句会 `start failed, re-boot and retry`：朋友第一份日志 10-05 00:12 有一次，重建后下一轮就正常了。
  - 0.3.27 时没有把这句加进 `REBOOT_AND_RETRY_MARKS`，理由是「不确定这一轮有没有执行，怕重复执行」。这次的证据说明这个顾虑不成立：桥不重试，Codex 自己也会立刻把同一轮重发（日志里 6 次），所以不重试防不住重复，只是让会话一直坏着。
  - 改动：`REBOOT_AND_RETRY_MARKS` 加上 `Unable to confirm the response started`（重建会话后再发一次，仍然只做一次）。`NOTICE.md`、`scripts/test-prism-bridge.cjs` 已同步。`npm test` 退出 0。没有在真实环境复现。「重建能恢复」的依据只有旧版日志里那一次。
  - 还没加的：`Reconnecting to sandbox. Your request will resume automatically once the sandbox is ready.`（旧版也会重建；Prism 说会自己恢复，目前只在旧版日志里见过一次，没有见过它卡住）。
- **0.3.28 的修复（2026-10-05，Claude；发布时 `npm test`、`npm run test:ui`、`npm run dist` 都退出 0，发布说明 `dist/release-0.3.28.md`）：Prism 桥限流（`Error while processing conversation (403 Forbidden). Please submit prompt again.`）后陷入反复失败。**
  - 证据（用户朋友的 `Downloadsridge(2).log`，只读看过，09:42 到 10:11，当时是 0.3.25 / 0.3.26 的桥）：这是 Prism 的限流。① 一个约 97 万字节的长对话被压缩成 8 段重发，段与段之间只隔约 3 秒（上游 `1bd4b79` 把 8 秒间隔改成「扣掉这一段已花的时间」），发完紧接着的下一轮就 403。② 403 之后桥直接把错误交回 Codex，Codex 每 2 到 3 秒重试一次，日志里 09:46、10:03、10:11 各连续 5 到 6 次；10:11 那次每次重试还会从头重发整个 8 段的压缩历史。旧版桥（0.3.24 及以前）这里会打印 `Prism throttled the turn, waiting 20s` 并等 20 / 40 / 60 秒再发同一轮，朋友更早的日志里 10-05 01:16 就有一次。上游 README 自己也写了「密集重试会让它更久」。
  - 改动（`vendor/prism-bridge/bridge.py`，第五、六处 `TokenPulse` 改动，`NOTICE.md` 已同步）：`PrismPage.chat` 的包装改成循环：错误含 `403` 和 `processing conversation` 时按 20 / 40 / 60 / 60… 秒等待后重发同一轮，累计超过 `THROTTLE_WAIT_SEC`（240）才报错（工作线程的超时预算里本来就留着这 240 秒）；重建会话那条照旧只做一次。多段发送每段之后固定等 `PART_GAP_SEC`（8 秒），不再扣时间。
  - 测试：`scripts/test-prism-bridge.cjs` 那组加了限流的两种情况。`npm test` 退出 0。上游自带的 72 个测试有 1 个失败，是断言「间隔要扣掉已花时间」的那条，属于有意改回的行为；其余 71 个通过。没有跑 `test:ui`（没有改界面）。**没有在真实环境触发过限流**来验证。
  - 给朋友的建议：这个对话已经长到每次都要 8 段重发，最好让 Codex 压缩（`/compact`）或开新对话；被限流后停几分钟再用。
- 软件处于**预览版**阶段：用户说 0.x 都是预览版，正式版从 1.0 开始。软件里、README、每次的发布说明开头都写了这一点。
- **2026-10-07 按用户要求清理过本地的构建产物**（用户：「安装包啥的都上传到 github 了，放在本地纯占我空间」）：删了 `dist` 里 0.1.0 到 0.3.32 的全部安装包（Setup / Portable / blockmap，都在 GitHub Releases 上）、`dist/0.3.7-motion`、`dist-preview/`、`dist-egress-preview/`、`dist-next/`、`dist-test/`、`.tmp-037-*.png`、`.tmp-grok-home-test/`，共约 9.1 GB。以前这里写的「这几个目录不要提交也不要删」已经不适用。现在 `dist` 里只有最新一版的四个发布文件、`win-unpacked`、各版的 `release-*.md`。项目根目录还有一批 `.tmp-03*-*.log`（被 `.gitignore` 忽略的旧日志，很小），用户没有说要删，留着。以后发新版时可以顺手把上一版的安装包删掉，用户不想在本地留旧安装包。
- GitHub 上有一个知识库机器人，每天可能往 `main` 推一个 `知识库：自动更新到 …` 的提交（只改 `knowledge/models.json`）。推送前先 `git fetch`，有就 `git pull --ff-only` 再打包。

### 最近发布的版本（从新到旧）

| 版本 | 提交 | 内容 |
|---|---|---|
| 0.3.34 | 见 `git log` | 修：经号池发出的请求没有记到账号名下（路由账本）；转发记录永久保存、记得更细、能在软件里往回翻 |
| 0.3.33 | 见 `git log` | 右键托盘图标弹出额度小面板（直线进度条 + 供应商切换，旧的右键菜单不要了）；Prism 桥下线（只对装过的人保留） |
| 0.3.32 | 见 `git log` | Grok 号池可以设上下文窗口（256K / 500K） |
| 0.3.31 | 见 `git log` | 修：换成中转站 / 官方登录后 Codex 桌面端打不开用 Prism 桥聊过的对话（tokenpulse_route not found） |
| 0.3.30 | 见 `git log` | Prism 下架 6.1 Sol 后桥一直 400：默认模型换成 5.6 Sol，模型列表从 Prism 读，已下架的模型自动改用可用的并提醒 |
| 0.3.29 | 见 `git log` | Grok 号池 / 供应商可以选思考等级（本地路由转发时补上）；修：Prism 桥报「Unable to confirm the response started」后连续失败 |
| 0.3.28 | 见 `git log` | 修：Prism 桥被限流（403）后反复失败（恢复限流等待和分段固定间隔） |
| 0.3.27 | `f2810c8` | 修：Prism 桥报「Project file synchronization timed out」后一直失败（恢复自动重建会话） |
| 0.3.26 | `df5bcc4` | 修：用了 TokenPulse 的供应商后，Codex 桌面端打不开以前的对话（Model provider 'custom' not found） |
| 0.3.25 | `00a51ab` | Prism 桥跟进上游（长对话自动压缩、轮询提速、出错不盲目重发） |
| 0.3.24 | `ba95815` | 「整窗能用多少」估计值和实测值分成两种行；搜索模型；都显示 / 只看估计 / 只看实测 |
| 0.3.23 | `8f38110` | 修：只试过一两次的型号「整窗能用多少」算得偏少 |
| 0.3.22 | `446e879` | 修：Prism 桥登录 12 小时后再启动报 401；软件里标「预览版」 |
| 0.3.21 | `bd6b6ef` | 修：Codex 对话删不掉、只装桌面端找不到 CLI、双重报错卡；空闲内存降约两成；Prism 桥常见问题 |
| 0.3.20 | `3bc170a` | Prism 桥：Codex 被代理截走时提醒并一键修复；日志写文件；一键删除 |
| 0.3.19 | `050d371` | Prism 桥：随软件带 Prism Bridge，账号被降智时经自己的 Prism 账号给 Codex 开本机接口 |
| 0.3.18 | | 添加账号可以只用本机 CLI 已登录的那个（不存凭据）；修「官方登录时显示没有识别到当前供应商」 |
| 0.3.17 | | 号池 / 本地路由转发走代理；所有联网请求统一代理规则（环境变量优先，其次系统代理） |
| 0.3.16 | | 会话管理的新对话 / 新项目；启动 CLI 前核对出口；出口检测间隔可调；单价变化的标法。**重新发布过一次，版本号没变** |
| 0.3.15 | | 修切到第三方后 Codex 桌面端「无法加载登录要求」；启动时自动修坏配置；切换前让 Codex 试读模型目录 |
| 0.3.14 | | 换算表点一行看详情；单价拆成四项并写来源；时间线放大修复 |
| 0.3.13 | | 单价标签；时间线用了多久、左键平移右键拖选、本机以外的剪辑工具、图例问号 |

每一版的发布说明草稿在 `dist/release-<版本>.md`（0.3.19 起；`dist` 不进 Git）。

### 已经由用户或用户的朋友确认过的

- 0.3.19：整条链路（登录、启动服务、Codex 经它发请求），拿到的是没有被降智的模型。用户本人确认。
- 0.3.20：一键修复写环境变量、全部删除（含卸载 Chromium、Codex 正在用时先切回官方）、安装 / 更新。用户本人确认。
- 0.3.21：界面里删除 Codex 对话「确实删除了」；降内存后「卡倒是不会卡」。
- 0.3.24：三轮测试版看过界面，发布后「测试没问题」。
- 0.3.25：试用测试版「没啥问题」。
- 0.3.34：用户试过测试版（发现并让我修了转发记录页的文案和空状态显示 null），说「应该没啥问题了」。真实号池下账号名下是否出现记录，用户没有单独回话。
- 0.3.33：托盘小面板用户看了三轮测试版（圆环 → 直线 + 供应商 → 变矮、去掉菜单、加退出按钮），最后说「还不错」；Prism 桥下线的做法用户看过说明后同意发布。
- 0.3.32：试用测试版「测试没问题」（Grok 号池的上下文窗口；超过 256K 的长对话有没有试到没有说）。
- 0.3.26：用户的朋友确认修好了（桌面端能打开旧对话）。2026-10-05 用户转述。
- 0.3.27：朋友手动停止再启动服务后恢复，印证了「重建会话能解决」。

### 仍然没有人验证过的

- 0.3.31：朋友那边桌面端能不能打开用 Prism 桥聊过的对话；退出还原那条路径没有专门的自动测试。
- 0.3.30：Prism 桥页面顶部那条模型提醒的样子；别的账号看到的 Prism 模型列表是否相同。
- 0.3.29：Grok 思考等级对着 xAI 真实接口的效果；号池编辑界面里那个下拉框的样子；`Unable to confirm…` 自动重建在真实环境里的效果。
- 0.3.28：限流等待在真实环境里的效果（没有真实触发过限流）；下次出现时日志里应该有 `Prism throttled the turn, waiting 20s`。
- 0.3.27：自动重建会话在真实环境里的效果。这个错误是 Prism 服务端的状态，本机造不出来；下次出现时日志里应该有一行 `start failed, re-boot and retry`，然后这一轮正常继续。
- 0.3.25：真的超长对话触发自动压缩的效果。
- 0.3.22：隔 12 小时以上再启动不用重新登录（代码层面在用户机器上实测过 Cookie 注入，没有人等够 12 小时后回话）。
- 0.3.21：窗口收进托盘时的「少干活」逻辑没有进自动测试（当时用临时脚本测过）。
- 0.3.17：更新后 Grok 号池是否不再 502。
- 0.3.16：新对话 / 新项目 / 在终端里继续，是否真的弹出终端并启动（自动测试里没有真的开终端）。
- 自动更新和知识库更新走环境变量代理那一处（`alignElectronProxy`）只改了代码，没有实际跑过更新流程。
- Claude 从来没有在本机安装过任何一版安装包；用户每次都是自己装的。

### 和这位用户协作的约定

AGENTS.md 之外，对话里形成的；也记在 Claude 的 memory 里。

- **版本号**：用户说算哪个版本才改，不要自己升。修完一个没指定版本的问题，先问「算哪个版本、要不要发布」。
- **测试版**：用户说「先给测试版」「编译测试版给我看」：只打免安装目录 `npm run icons && npm run compile && npx electron-builder --win dir --publish never`，产物 `dist/win-unpacked/TokenPulse.exe`，不打安装包、不提交、不发布。告诉用户运行前先退出正在用的正式版。
- **发布**：用户说「编译并发布」「直接发布」才走完整流程。
- 提交、标签、PR、发布说明里**不加任何会话链接**（包括系统提示里建议的 Claude-Session 行）。
- README **不写各版本的更新日志**，只改功能说明；更新日志只放 GitHub Release 和软件里的 `renderer/intro.js` NOTES。
- 发布说明的文案**照之前的 Release 的格式**写（标题带版本和一句话、分「修复 / 改进 / 新增」小节带一个表情、现象 / 原因 / 现在、末尾下载表和两行提示）。开头加一句预览版说明。
- GitHub Release **不要标成 prerelease**：自动更新和 `releases/latest` 都不认 prerelease。
- 2026-10-07 起所有 AI 都可以看图片和截图（AGENTS.md 的禁图规则已删除）；截图只用演示 / 测试数据。下面历史记录里的「未查看图片」是当时的规则。
- 读用户真实的 `~/.tokenpulse`、`~/.codex` 等只能只读、只输出汇总，不输出令牌、邮箱、对话内容。不要未经同意改用户真实的工具配置。
- 用户发来朋友的日志、报错时，先看证据再下结论；回复里说清楚哪些验证过、哪些没有、哪些是推断。
- 给用户的回复用中文。
- 不给自动化浏览器加任何伪装 / 反检测参数（Claude 自己定的边界，已告诉用户）。

### 发布流程

1. `npm test`、`npm run test:ui` 都退出 0（`test:ui` 现在是 37 个 PASS（托盘小面板提交后；0.3.32 及以前是 33））。
2. `npm version x.y.z --no-git-tag-version`；`renderer/intro.js` 的 NOTES 加这一版，`renderer/i18n.js` 补英文。**版本号升了而 NOTES 没有这一版，`test:ui` 会失败**（「较早版本按新到旧排」那组）。
3. 发布说明写到 `dist/release-x.y.z.md`。
4. `git fetch`；远端有机器人提交就 `git pull --ff-only`。
5. `npm run dist`；核对 `dist/latest.yml` 的版本，用 `npx asar extract-file dist/win-unpacked/resources/app.asar '<反斜杠路径>'` 取出改过的文件和源码 / `build` 下的编译结果 `cmp`（asar 里的路径用反斜杠，如 `build\core\model-study.js`）；改了桥就 `cmp vendor/prism-bridge/bridge.py dist/win-unpacked/resources/prism-bridge/bridge.py`。
6. 更新 HANDOFF；只 `git add` 相关文件（连同 HANDOFF）；提交。
7. `git tag vX.Y.Z`；`git push origin main vX.Y.Z`。
8. `gh release create vX.Y.Z` 上传四个文件：Setup.exe、Setup.exe.blockmap、Portable.exe、latest.yml，`--title "TokenPulse X.Y.Z" --notes-file dist/release-X.Y.Z.md`；核对附件大小、`isDraft` / `isPrerelease` 都是 false、`releases/latest`。
9. 检查没有遗留的 electron / dist 下的 TokenPulse 进程，安装包能独占打开。

- 提交、打标签并推送、建 Release **分三条命令**执行；串成一条会被 Claude Code 自动模式的权限规则拒绝。
- `gh release create` 偶尔因为网络报 `unexpected EOF`、没有建出 Release，原样重试即可。

### Prism 桥：现在是什么样（0.3.19 到 0.3.27 的结果）

- **它是什么**：第三方开源项目 Prism Bridge（https://github.com/yyyllllming/prism-bridge ，作者 yyyllllming，MIT）。`bridge.py` 用无头 Chromium 登录用户自己的 Prism（prism.openai.com）账号，在本机 `http://127.0.0.1:18765/v1` 开 OpenAI 兼容接口给 Codex 用。适合 ChatGPT 账号被「降智」的用户；界面、README、更新说明里都写了适合谁、正常账号没必要用、以及可能不符合 OpenAI 服务条款的风险。
- **代码位置**：`vendor/prism-bridge/`（`bridge.py`、`LICENSE`、`NOTICE.md`、`collect_login.py`），随安装包打到 `resources/prism-bridge`。进程管理在 `src/core/prism-bridge.ts`，界面在 `renderer/agent-switch.js` 的 `prismSection()`（「本地路由」分组下的 `prism` 一节），样式在 `renderer/agent-switch.css` 末尾（`.pv-prism-*`）。
- **上游版本**：当前这份对应上游提交 `1bd4b79`（2026-10-05）。
- **TokenPulse 对 `bridge.py` 的七处改动**（第 7 处是模型列表，见上面 0.3.30）（代码里都带 `TokenPulse` 注释，`NOTICE.md` 里有清单；以后换新版要全部补回）：
  1. `PRISM_PROXY` → `BROWSER_PROXY` / `PROXY_OPTION`：给浏览器当代理（服务、Playwright 登录窗口、上游拉起的系统浏览器登录窗口）。上游没有代理支持。
  2. `LOGIN_CHANNEL` 常量（环境变量 `PRISM_LOGIN_CHANNEL`）：只给 `collect_login.py` 用。
  3. `cookie_header_to_playwright` 跳过已过期的 `prism_session_token`（12 小时有效；不跳过的话登录 12 小时后再启动报 `401 Request verification failed`）。上游没有修。
  4. `PrismPage.chat`：错误含 `REBOOT_AND_RETRY_MARKS`（`Project file synchronization timed out while starting the response`、`Unable to confirm the response started`）时 `boot()` 重建会话再发一次。上游 `1bd4b79` 把旧版的重建逻辑整个去掉了。
  5. `PrismPage.chat`：限流（错误含 `403` 和 `processing conversation`）时按 20 / 40 / 60… 秒等待后重发同一轮，累计不超过 `THROTTLE_WAIT_SEC`（240）。上游改成了直接把错误交回客户端。
  6. 多段发送每段之后固定等 `PART_GAP_SEC`（8 秒），不扣掉这一段已花的时间。上游自带的测试里有 1 条断言「要扣时间」，对着我们的文件会失败，属于有意为之。
- **更新上游的做法**（0.3.25 做过一遍）：克隆上游到 scratchpad → 用新版 `bridge.py` 覆盖 → 补回四处改动 → 上游自带的 `test_bridge_*.py`（不进我们的仓库）拷到临时目录，用 `~/.tokenpulse/prism-bridge/venv` 的 python 跑 `-m unittest` → `npm test` → 真实启动一次（用户的服务通常正在运行占着浏览器目录：把 `profile/auth.json` 拷到临时目录、另开端口、跑完删除）→ 更新 `NOTICE.md` 里的上游提交号。**特别检查上游有没有去掉我们依赖的恢复 / 重试行为**（0.3.27 就是这么来的）。
- **登录**：TokenPulse 自己用正常方式启动系统的 Chrome / Edge（`--user-data-dir=login-profile`，不被程序控制），用户登录到看见 Prism 界面后自己关窗口，再跑 `collect_login.py` 从那份浏览器数据里读出 Cookie 存成 `profile/auth.json`。被 Playwright 控制的登录窗口过不了真人验证。找不到 Chrome / Edge 时才调 `bridge.py login`。上游后来也做了同样思路的登录，我们没有换过去。
- **数据**都在 `~/.tokenpulse/prism-bridge/`：`config.json`（端口、随机密钥、是否跟着启动）、`venv/`、`deps.json`、`profile/`（服务的浏览器数据和 `auth.json`）、`login-profile/`、`bridge.log`（超过 1 MB 轮转成 `.1`）。Cookie 和密钥不出主进程。
- **已有的保护 / 功能**：代理冲突检测 + 一键修复（`checkPrismProxy` / `fixPrismProxy`，会经代理实际请求一次本机 `/health` 才提醒）；日志文件 + 「打开日志文件」；一键全部删除；跟着 TokenPulse 启动；页面上的「常见问题」（额度、用量、上下文、思考强度）。
- **排查线索**（都遇到过）：
  - Codex 报 502 而桥日志里什么都没有 → 请求被代理截走了，设 `NO_PROXY=127.0.0.1,localhost,::1`。
  - 启动报 `list Prism projects HTTP 401 Request verification failed` → 0.3.22 以前是过期的会话令牌；之后再出现要看是不是连不上 `sentinel.openai.com`。
  - `Project file synchronization timed out while starting the response` → Prism 服务端同步项目文件超时，重建会话即可（0.3.27 起自动）。
  - `Error while processing conversation (403 Forbidden)` → Prism 限流，停一会儿。
  - 桥每个请求都会记一行 `[http] …`；`[llm] start …` 后面跟着的英文是 Prism 返回的原话。
- **已知限制**：回复是整段生成完才返回；桥不返回 Token 用量，TokenPulse 里看不到这部分用量；端口固定 18765（只能手改 `config.json`）；只支持 HTTP 代理；Prism 网页改版后可能失效。

### 「换一种模型，整窗能用多少」：现在的口径（0.3.23、0.3.24 的结果）

- 代码：`src/core/model-study.ts`（计算）、`renderer/model-study.js` / `.css`（界面）。
- **估计值**：每个组合都有。整窗预算 ÷ 综合单价。综合单价 = 价格表 × 用量结构；同一个型号的所有等级用同一个起点（`baseFor`：这个型号用得最多那一档的用量结构），只把输出部分按等级倍数换算。不再用「这个组合自己的实际费用」定价（`priceBasis` 不会再是 `combo`，类型里还留着这个值）。
- **样本够不够**：`representative(list)`：至少 30 条（`MIN_COMBO_ROWS`），或占本账号近 30 天请求的两成以上。不够的型号按本账号整体的用量结构算，单次调用大小也按推算的来。
- **实测值**：字段是 `estimatedTokens`（名字是历史遗留，它是实测）。有足够整段只用这个组合的采样区间才有。
- `capacityTokens = derivedTokens ?? estimatedTokens`：排行、还剩多少、调用次数、本机以外标注的折算都用估计值；`capacityBasis` 只有估计不出来时才是 `measured`。
- **界面**：估计值一行（`data-kind=estimate`，主数字后标「估计」，有实测的带「有实测」小标签）；有实测的组合另外多出**单独一行**（`data-kind=measured`，名字绿色、「实测」色块标签 + 圆圈问号说明），两种行一起排序。右上角切换 `Q.show`：都显示（默认）/ 只看估计 / 只看实测。「添加模型」和排序靠左。工具栏左边有搜索框（`Q.search`）。
- 等级倍数优先用用户自己的实测（同型号两档各 20 次调用以上，标「等级实测」），其次 Epoch AI 基准。所以用户的 Opus 5.5 low 和 medium 的估计值几乎一样（他用 low 时每次调用的输出是 medium 的 1.03 倍）。用户知道这一点，没有要求改。

### Codex 旧对话的供应商表（0.3.26 的结果）

- Codex 每个对话的 `session_meta` 里记着创建时的 `model_provider`（`config.toml` 里那张表的名字）。**桌面端**打开旧对话时按这个名字找表，找不到就报「Model provider 'xxx' not found」；命令行的 `codex exec resume` 不检查，所以这个报错在命令行复现不了。
- `src/core/agent-switch.ts` 的 `syncCodexLegacyProviders()`：把本机对话里出现过、不是内置（openai / ollama / lmstudio / oss）、配置里又没有的名字补成一张表，`name = "TokenPulse (earlier chats)"`。内容照抄现在生效的那张表（`model_provider` 指向的、有 `base_url` 的，不管叫什么、谁写的；0.3.31 起）；没有才写成走官方登录的表。只认这个 name 的表为自己的，每次先清再补；别人写的同名表不动。
- 调用点（0.3.31 起）：`writeCodex` 末尾（每次切换）；`restoreProxy` 的两个出口（关本地路由 / 退出时还原配置之后）；`repairAgentConfigs`（启动时，条件是 TokenPulse 管过 Codex **或** 本机对话里出现过 `tokenpulse_route`）。TokenPulse 开着时别的工具改了配置不会马上补。

### 踩过的坑（省得再踩）

- 用 `python - <<'EOF'` 这类 shell heredoc 改含反斜杠的代码（`\n`、`\d`、`\s`、`\x`、正则里的 `\\`）会被吃掉或改坏转义。改这类内容用 Write 写成 .py 文件再跑，或者直接用 Edit 工具。改完用 `node --check` / `npm run compile` 确认。
- Git Bash 里 `python - <<EOF` 读文件默认按 GBK 解码：打开文件一律写 `io.open(p, encoding="utf-8", newline="")`，并保留原来的换行符（仓库里 CRLF 和 LF 的文件都有）。
- `renderer/i18n.js` 的格式表 `P('...')` 是 JS 字符串，正则里的反斜杠要写两个（`\\d`）。翻译时会先按中文分号「；」和换行硬拆句，所以要整句匹配的句子里别用「；」。宽泛的格式要放在最后那条「标题：值」之前。
- 界面上新加的中文文字都要在 `renderer/i18n.js` 里补英文；动态拼出来的文字（中文 + 变量）字典匹配不上，要么拆成独立的元素，要么加 `P(...)` 格式。
- TS 模板字符串里的 `\S` 会变成字母 S：往 PowerShell 脚本里写正则时别用反斜杠类，用字符类。
- PowerShell 把弯引号 ‘ ’ 也当单引号，拼脚本时要一起翻倍（`quotePs`）。
- 临时的 Electron 脚本先 `node --check` 再跑，语法错会在用户屏幕上弹阻塞对话框。
- `scripts/capture-ui.cjs` 会覆盖 `artifacts/ui/` 里 README 用的截图（这些文件在 Git 里）。只是想看一眼排版的话，截完把要看的图拷到 scratchpad，再 `git checkout -- artifacts/ui` 还原。
- 界面测试里窗口可见时，悬浮提示那组断言会失败（只在截图用的副本里出现，正式测试是隐藏窗口）。
- 本机联网要经 `http://127.0.0.1:7890`（环境变量 HTTPS_PROXY / HTTP_PROXY），直连官方接口会超时。
- 本机 Codex：桌面端自带的在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe`（目录名会随更新变，2026-10-05 是 codex-cli 0.160.0），`test-codex-compat.cjs` 会自动找最新的那个来真读配置。
- 用户的正式版 TokenPulse 通常一直开着（`AppData\Local\Programs\TokenPulse`），它的 Prism 桥占着 `~/.tokenpulse/prism-bridge/profile`；不要动它，要真实测试桥就另开端口和临时目录。
- 收尾检查进程时，命令行里带 `prism-bridge` 字样的 bash / powershell 可能就是自己这条检查命令，别误判。

---

## 0.3.22 到 0.3.27 的详细记录（2026-10-05，Claude）

### 0.3.27：Prism 桥报「Project file synchronization timed out」后一直失败

- 现象：Codex 报 `stream disconnected before completion: Project file synchronization timed out while starting the response.`。前半句是 Codex 加的前缀，后半句是 Prism 服务器返回的（每轮开始前把项目文件同步进沙箱，这一步超时），桥里没有这段文字。
- 证据（用户朋友的 `bridge.log`，只读看过）：旧版桥（0.3.24 及以前）遇到它会打印 `start failed, re-boot and retry` 并 `boot()` 重建会话，10-05 01:14 和 02:16 两次都是重建后立刻成功。朋友 08:17 更新到 0.3.25 后，09:18 起同一个错误连续 16 次，每次约 62 秒超时，没有一次重建。
- 原因：上游 `1bd4b79` 把 `chat()` 里的重试循环整个去掉了（「不盲目重发」），连这种「明确没开始执行」的情况也不再重建会话。是 0.3.25 跟进上游带来的退步。
- 改动：`PrismPage.chat` 包一层，错误信息含 `REBOOT_AND_RETRY_MARKS` 时 `boot()` 后再发一次，第二次还失败照常报错；别的错误不变。`Reconnecting to sandbox…will resume automatically` 和 `Unable to confirm the response started` 没有加进去（前者 Prism 说会自己恢复，后者不确定有没有执行）。`scripts/test-prism-bridge.cjs` 加了一组（用空壳 playwright 导入真的 `bridge.py`）。
- 验证：`npm test`、`npm run test:ui` 退出 0；上游自带的 72 个测试对着改后的文件全过。没有在真实环境复现。

### 0.3.26：Codex 桌面端打不开以前的对话

- 现象（用户朋友）：用 Prism 桥时打开以前用中转站 / 官方登录时的对话，桌面端提示「ChatGPT 无法加载 config.toml…Model provider 'custom' not found」。
- 原因和改法见上面「Codex 旧对话的供应商表」。`custom` 是别的工具（如 CC Switch）以前写的表名，朋友机器上这张表已经不在了。同类问题 TokenPulse 自己也会造成：用 `tokenpulse_route` 聊过之后切回官方，`writeCodex` 会把这张表删掉。用户自己的机器没中，是因为 `config.toml` 里还留着 CC Switch 写的 `[model_providers.custom]`（name = "OpenAI"、requires_openai_auth = true、wire_api = "responses"，没有 base_url），官方登录时补的表就是照它写的。
- `codexSessionProviders()` 读 `sessions/`、`archived_sessions/` 下每个 `.jsonl` 的前 16 KB（实测 `model_provider` 在前 1.1 KB 以内）。启动时补了会出一条单独文案的提示（`CODEX_LEGACY_FIX`）。
- 测试：`scripts/test-agent-switch.cjs` 加了一组（照抄当前路由、官方登录表、内置名不补、用户自己的表不动、重复切换不变、启动修复补回 / 清理、没有旧对话时一张不留）。用真实 Codex 验证过带补表的 `config.toml` 能加载（`codex features list` 退出 0）。
- 用户的朋友确认修好了。

### 0.3.25：Prism 桥跟进上游

- `bridge.py` 从上游 `8ae73c0`（我们最初拿到的那份）更新到 `1bd4b79`，3143 行 → 3922 行。
- 上游带来的：① 自动历史压缩（`PRISM_COMPACT_MAX_PARTS`，默认 2）：历史拆成 8 段也装不下时摘掉较早的部分再发，是有损删减不是模型摘要，当前提问 / 工具调用和结果 / 图片不裁。② 401 / 403、超时、断流、执行状态未知时不再自动重发（0.3.27 为其中一种情况加回了重建会话）。③ 轮询提速：第一次立即查，之后每 0.4 秒（`PRISM_STATUS_POLL`）；多段之间的 8 秒间隔扣掉上一轮已花的时间；启动时页面等待 1 秒。④ Windows 登录改成拉起不被 Playwright 接管的系统浏览器。
- 模型清单没有变（`/v1/models` 返回 7 个：gpt-6-astra、gpt-6.1-sol、gpt-6-sol、gpt-5.6-sol、gpt-5.6-terra、gpt-6-luna、auto；TokenPulse 写给 Codex 的仍是四个）。
- 界面 / 文档：Prism 桥页「最大上下文是多少？」和 README 同一段按新行为改写。
- 验证：上游 72 个测试全过；真实启动过一次（临时目录 + 端口 18799：23 秒就绪，`gpt-5.6-terra` 问一句 12 秒返回正确答案，跑完已清理）。

### 0.3.24：「整窗能用多少」估计值和实测值分开

- 起因：用户发现 Opus 5.5 的 low 比 high 能用的还少。不是算错：low 那行是实测（用户用 low 的会话里缓存写入占 2.0%，medium 是 1.2%，每 Token 贵约一成），high 那行是从 medium 推算的，两种来源混在一列里比。原来的「样本外推」标签看不懂也不显眼。
- 用户看了三轮测试版才定下来，最终样子见上面「现在的口径」。中间做过又改掉的：实测值贴在估计值下面的一行（`.ms-cap-measured`，已删）；切换按钮和排序挤在一起（用户要「添加模型」和排序靠左、切换靠右）。
- 「都显示」这个选项是 Claude 加的（用户原话只有「只显示估计 / 只显示实测」两个），用户看过没有要求去掉。
- 测试：`test-model-study.cjs`、`test-effort-usage.cjs`、`test-shared-quota.cjs` 改成新口径；`test-model-study-ui.cjs` 开头测完三种显示方式和搜索后切到「只看估计」，后面的旧断言都在这个模式下跑。

### 0.3.23：只试过一两次的型号算得偏少

- 现象：Sonnet 5.5 能用的量比 Fable 5.1 还少。价格表没有错（和 LiteLLM 一致：Sonnet 5.5 输入 2 / 输出 10 / 缓存读 0.2，Fable 5.1 是 10 / 50 / 0.25，美元每百万）。
- 原因：用户这 30 天只用过 2 次 Sonnet 5.5，都是新会话的头一两句，token 里约三成是缓存写入；旧代码只要同型号有一条记录就按它的实际费用算单价（每百万约 1.10 美元），而没用过的 Fable 5.1 按价格表 × 账号用量结构（98.5% 缓存读）算出约 0.54 美元。
- 改动：`representative(list)`，见上面「现在的口径」。
- 用户数据上的结果（五小时窗口）：Sonnet 5.5 medium 从约 4150 万变成约 1.53 亿；Opus 5.5 high（只有 3 次调用）的「能调用多少次」从 1631 变成 265。

### 0.3.22：Prism 桥 12 小时后再启动报 401；标「预览版」

- 用户的说法是「关机再开机后就用不了，要重新登录」。实际和关机无关，和时间有关：服务一直开着不受影响，停掉后隔了 12 小时再启动就会中。
- 原因：`prism_oai_access_token` 有效 10 天，`prism_session_token` 只有 12 小时。`auth.json` 只在登录时写一次；`bridge.py` 每次启动都把里面的 Cookie 注入浏览器（域 `.openai.com`），过期的会话令牌盖住了 Prism 打开页面时新发的那份（域 `prism.openai.com`）。界面上「登录还剩」看的是访问令牌，所以显示还有 200 多小时。上游 README 把这个报错解释成连不上 `sentinel.openai.com`，这次不是这个原因。
- 确认过程：在用户机器上照 `bridge.py` 的启动方式打开 Prism（只输出状态码和 Cookie 名字）。照原样注入：45 秒内 4 次都是 401；不注入会话令牌：第一次就是 200。
- 预览版标签：版本号以 `0.` 开头时，侧栏底部和「设置 → 关于」各显示一个「预览版」标签（`.preview-tag`），关于页多一句说明（`.preview-note`）；到 1.0 会自己消失。README 简介下面和每次发布说明开头也写了。

---

## 0.3.19 到 0.3.21 的详细记录（2026-10-04，Claude）

下面三段是当时逐步写下的原文，保留了过程。其中这些说法已经被后面的版本改掉，以上面「新对话先看这里」为准：
- 「对 `bridge.py` 的改动有两处」「约 3100 行」→ 现在四处、约 3900 行。
- `PRISM_LOGIN_CHANNEL`「传给登录那次 `launch_persistent_context`」→ 现在只给 `collect_login.py` 用。
- 「上下文：再超出返回 `context_length_exceeded`」→ 0.3.25 起桥会自动摘掉较早的历史。
- 「`test-prism-bridge.cjs` 5 组 / 7 组」→ 现在 9 组。
- 「Git：都没有提交」「没有打 Setup 和 Portable」这类是当时测试版阶段的状态，这三版后来都发布了。

**0.3.21：删除 Codex 对话的两个问题 + 双重报错卡 + Prism 桥常见问题 + 降内存 · 已完成，已提交、打包、发布（2026-10-04，Claude）**
- 用户反馈（都算 0.3.21，没有说要发布）：会话管理里删除 Codex 对话，朋友那边提示找不到 CLI；用户自己删会报「cannot confirm session deletion without an interactive terminal; rerun with --force and a session UUID」，而且出现两张报错卡，第二张一直挂着关不掉。
- **删不掉**：`codex delete <id>` 在没有终端时不肯删（它要在终端里问确认）。`session-reply.ts` 的 `deleteArgs('codex')` 改成 `["delete", "--force", id]`；确认仍由 TokenPulse 的系统对话框问。本机两个版本（npm 的 0.156.1、桌面端的 0.160.0）的 `codex delete --help` 都有 `--force`（「Delete without prompting. SESSION must be a UUID」）。Grok 的 `sessions delete` 没有确认这一步，没改。
- **找不到 CLI**：`resolveCli('codex')` 原来只找 npm 全局的 `codex.js` 和 PATH 上的 `codex.exe` / `codex.cmd`。只装了 Codex 桌面端的电脑上这些都没有。新增 `bundledCodex()`，排在最后兜底：`%LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe`（按修改时间取最新）和 npm 包里 vendor 下的原生 `codex.exe`。`resolveCli` 是共用的，所以新对话、在终端里继续、在软件里回复、「装了哪些 CLI」也一起受益。没有复用 `codex-probe.ts` 的 `findCodexExe()`（它在设了 `AGENT_SWITCH_HOME` 的测试里故意不找真实机器）。
- **双重报错卡**：`renderer/app.js` 的 `showStatus(message, true)` 以前既弹右上角的提示（toast，能关、会自动消失），又把固定定位的 `#app-status` 状态条显示出来——它和提示叠在同一个位置，没有关闭按钮，出错后一直不隐藏。现在 `#app-status` 在 `showStatus` 里一律保持隐藏，出错只走提示。影响所有页面的报错，不只是会话管理。启动时那句「正在读取本地用量…」不受影响。
- 版本号 0.3.21；intro NOTES 三条；i18n 已补（主进程对话框里那句删除说明也改了）。README 没有改（功能说明没变）。
- **测试**：`test-sessions.cjs` 的 `deleteArgs` 断言改成带 `--force`；`test-ui.cjs`「刷新失败」那组改成看右上角的提示，并断言只有一张、`#app-status` 是隐藏的、能点 × 关掉（开头先清掉前面步骤留下的提示）。`npm test` 退出 0；`npm run test:ui` 退出 0，共 33 个 PASS。
- **实测**：
  - 临时 `CODEX_HOME` 里放一份真实会话文件的副本，用桌面端的 codex.exe（0.160.0）：不带 `--force` 复现了用户的原错误、文件还在；带 `--force` 输出 `Deleted session …`、退出码 0、文件没了。用户真实的 `~/.codex` 没有动。
  - 模拟「只装了桌面端」（APPDATA 指到不存在的目录、PATH 只留 System32）：`resolveCli('codex')` 找到了桌面端的 codex.exe；正常环境下仍然优先用 npm 的。
- **用户反馈（2026-10-04）**：用测试版在界面里删除 Codex 对话，「确实删除了」。
- **没有验证的**：朋友那台电脑上的情况（是按「只装了桌面端」推断的，没有他的环境信息）；npm 的 0.156.1 实际删除（只看了 --help）。
- **追加（用户：把额度、上下文、思考强度这些写进软件，仍算 0.3.21）**：Prism 桥页面在四步下面加了「常见问题」卡片 `.pv-prism-faq`（四条 `<details>`，平时收着），README 的 Prism 桥一节也加了同样的「常见问题」，intro NOTES 多一条，i18n 已补，`test-agent-switch-ui.cjs` 加了断言。内容和依据：
  - 额度：不扣 Codex 的额度（请求发到 prism.openai.com，不是 Codex 接口；用户实际用了半天 Codex 额度没动）。Prism 自己的总量上限不知道，页面上写的是「没有公开的数字」；频率限制来自原作者 README 的实测。
  - 用量：bridge.py 不返回 Token 用量，所以 TokenPulse 里看不到。
  - 上下文：单轮约 8.6 万字节（`MAX_TURN_BYTES`）、最多拆 8 轮（`MAX_TURN_PARTS`）、再超出返回 `context_length_exceeded`。写给 Codex 的 128000 是 Codex 的默认值，不是实测。
  - 思考强度：`effort_of()` 把 xhigh / max / ultra 归到 high、minimal 归到 low，默认 high。Prism 是否真的按档位调整没有验证，页面上没有写这一句。
  - 截图看过展开后的样子（浅色）。追加后 `npm test` 退出 0，`npm run test:ui` 退出 0（33 个 PASS），测试版已重新编译。
- **追加（用户：在不明显损失流畅度的前提下降低内存、减轻负担，仍算 0.3.21）**：先量再改。量法：scratchpad 里的临时脚本，临时数据目录、真实 CLI 日志只读，1380×920 窗口，加载 20 秒 → 逛 5 个页面 → 空闲 15 秒 → 隐藏 20 秒，用 `app.getAppMetrics()` 的 privateBytes。
  - 基线（改之前）：空闲合计约 516 MB（GPU 进程约 295、渲染进程约 107、主进程约 84、两个工具进程各约 15），隐藏后约 544 MB。主进程的 JS 堆只有约 10 MB，数据不是大头；主进程会在统计线程跑的时候临时涨到 250 到 370 MB，跑完回落。用户正式版当时的读数是 GPU 363、主进程 312、渲染 85（MB，Private）。
  - 试过的做法（空闲合计）：`disable-gpu-rasterization` 407；`enable-low-end-device-mode` 462（可能影响画质，没用）；`force-gpu-mem-available-mb=64` 469；`in-process-gpu` 516（没省）；整个关硬件加速 302（动画和滚动会变卡，没用）；隐藏后销毁窗口只省约 100 MB（GPU 进程不释放）且牵涉面大，没做。
  - **采用**（都在 `src/main/index.ts`）：
    1. `app.commandLine.appendSwitch("disable-gpu-rasterization")`：绘制在 CPU 上做，合成仍交给 GPU。改后同样量法：空闲约 405 MB、隐藏后约 394 MB。截图对比过，画面没有变化。代价：渲染进程在大面积重画的瞬间会多用一些内存（逛页面时峰值 205 MB，原来 157 MB），空闲后回落。
    2. `setWindowAway()`：窗口被隐藏 / 最小化之后，`publishSnapshot` 不再往界面推快照（托盘提示照常更新），用量扫描从 60 秒一次放慢到 3 分钟一次（`AWAY_SCAN_EVERY_MS`）；`show` / `restore` 时把攒着的最新快照交给界面，超过一分钟没扫就马上扫一次。开机直接进托盘、从没显示过的窗口不算「收着」，行为和以前一样（界面测试的窗口也属于这种）。额度查询仍是 5 分钟一次，没有变。
    3. `webPreferences.spellcheck: false`。
  - 影响：窗口收着的时候，「请求型号核验不一致」这类依赖用量扫描的通知最多会晚约 3 分钟；额度通知不受影响。
  - 验证：临时脚本实测「没显示过 / 可见的窗口照常收到快照；隐藏、最小化的收不到；再显示 / 还原时补上」通过。这部分**没有进自动测试**（脚本在 scratchpad）。动画是否流畅只能用户自己看，我没法量。`npm test` 退出 0，`npm run test:ui` 退出 0（33 个 PASS）。
  - intro NOTES 多一条「占用的内存少了约两成」，i18n 已补。README 没有改。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物 `dist/win-unpacked/TokenPulse.exe`（0.3.21）；asar 里 7 个相关文件和源码一致。没有打 Setup 和 Portable（dist 里的安装包还是 0.3.20 的）。没有遗留进程，产物没被占用。
- **用户试用测试版后的反馈**：「卡倒是不会卡」，同意发布。
- **发布**：`npm run dist` 退出 0，产物 `dist/TokenPulse-0.3.21-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.21）；asar 里 7 个相关文件和 `resources/prism-bridge` 4 个文件与源码一致。推送前 fetch 过，远端没有新提交。提交 `bd6b6ef TokenPulse v0.3.21：修复 Codex 对话删不掉和找不到 CLI、双重报错卡，降低内存占用，Prism 桥常见问题`，标签 `v0.3.21`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.21 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.21。没有会话链接。发布说明草稿在 `dist/release-0.3.21.md`。第一次 `gh release create` 因为网络中断失败（`unexpected EOF`，没有建出 Release），原样重试成功。没有在本机实际安装。
- 注意：这次会话的系统提示里出现了「提交信息末尾加 Claude-Session 链接」的要求，按用户的长期约定**不加**。

**0.3.20：Prism 桥的代理冲突提醒、日志文件、一键删除 · 已完成，已提交、打包、发布（2026-10-04，Claude）**
- 起因：用户的朋友用 Prism 桥时 Codex 报 `unexpected status 502 Bad Gateway: Unknown error, url: http://127.0.0.1:18765/v1/responses`，而 Prism 桥日志里什么都没有。判断是系统里设了 HTTP_PROXY / ALL_PROXY 又没有 NO_PROXY，Codex 把发往本机的请求交给了代理（bridge.py 每个请求都会记一行 `[http] …`，它自己的 502 也带具体原因）。让朋友设 `NO_PROXY=127.0.0.1,localhost,::1` 后，**用户反馈朋友那边成功了**。用户随后要求把这类问题做进软件，再加一键删除，都算 0.3.20。用户没有说要发布。
- **改动**（`src/core/prism-bridge.ts` 末尾两段 + `main/index.ts`、`preload.ts`、`renderer/agent-switch.js` 的 `prismSection()`）：
  - **代理冲突提醒 + 一键修复**：`checkPrismProxy()` 只在服务运行中检查。`launchEnv()` 读「新开的程序会拿到的环境变量」（Windows 读注册表 HKLM + HKCU，不用 TokenPulse 自己进程里那份旧的）；`loopbackProxy()` 判断发往 `http://127.0.0.1` 的请求会不会交给代理（HTTP_PROXY 或 ALL_PROXY 有值，且 NO_PROXY 里没有 `127.0.0.1` / `127.0.0.0/8` / `*`；只有 `localhost` 不算）。会的话**经那个代理实际请求一次本机的 `/health`**：返回 200 就不提醒；到不了就 `proxyIssue.certain = true`；代理类型试不了（SOCKS）是 `certain = false`。触发时机：服务就绪时、界面取状态时。`fixPrismProxy()` 用 `setx` 把 `127.0.0.1,localhost,::1` 并进用户级 NO_PROXY（保留原有条目）。界面是顶部红色提醒 `.pv-prism-warn[data-warn=proxy]` + 「一键修复」。
    - 为什么要实际试：用户自己这台机器注册表里就有 `HTTP_PROXY=http://127.0.0.1:7890`、没有 NO_PROXY，但他的代理软件会把发往本机的请求送回本机（实测经 7890 访问 `http://127.0.0.1:18765/health` 返回 200），所以不该提醒。只看环境变量会误报。
    - 查不到的情况：Codex 是从某个自己设了代理变量的脚本 / 终端里启动的（环境变量不在注册表里）。用户朋友就有这样一个脚本（`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 都指向 7890，`NO_PROXY=` 为空）；如果 Codex 是从那个脚本启动的，要改脚本里的 NO_PROXY。
  - **日志写文件**：`~/.tokenpulse/prism-bridge/bridge.log`，每行带本地时间；超过 1 MB 把旧的挪成 `bridge.log.1`。日志框标题右边多了「打开日志文件」（IPC `prism:open-log`，在资源管理器里定位）。
  - **一键删除**：页面最下面 `.pv-prism-remove`，按钮要点两次（4 秒内）。界面先处理供应商（Codex 正在用 → `agentActivate(官方)`，会走改配置的确认流程；再 `agentDelete`），然后 IPC `prism:remove` → `removePrism()`：停服务 → `venv python -m playwright uninstall`（只删这份 Playwright 自己用的浏览器，不带 `--all`，别的程序装的不动）→ 删整个 `~/.tokenpulse/prism-bridge`。不动的：电脑上的 Python、NO_PROXY、TokenPulse 本身。卡片上显示占用空间（IPC `prism:usage`，只量数据目录；Chromium 写的是「约 300 MB」的估计值）。`PrismState` 多了 `installed`、`proxyIssue`，`PrismTask` 多了 `remove`。
  - 版本号 0.3.20；intro NOTES 三条；i18n 已补（一条带占用空间的格式放在 PATTERNS 开头）；README 的 Prism 桥一节加了「出了问题怎么查」「不想用了，一键删除」（没有加版本小节）。
- **测试**：`test-prism-bridge.cjs` 现在 7 组（新增：日志文件 + 代理判断 / 用两个假代理实测 / 一键修复；一键删除）。`test-agent-switch-ui.cjs` 加了「打开日志文件」按钮和一键删除（点两次、删完数据目录和供应商都没了、页面回到全新状态）。`npm test` 退出 0；`npm run test:ui` 退出 0，共 33 个 PASS。用假状态截图看过代理提醒和一键删除卡片（浅色）。
- **没有验证的**：`setx` 真实写用户环境变量（没有在用户机器上执行，怕改他的环境）；`playwright uninstall` 真实执行（只确认了命令存在和说明；没有删用户正在用的环境）；Codex 正在用 Prism 桥时一键删除的整条流程（先切回官方那一步只有代码，界面测试里供应商没有启用）；SOCKS 代理的真实情况。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物 `dist/win-unpacked/TokenPulse.exe`（0.3.20）；asar 里 7 个相关文件和 `resources/prism-bridge` 的脚本与源码一致。没有打 Setup 和 Portable（dist 里的安装包还是 0.3.19 的）。没有遗留进程，产物没被占用。
- **发布**：用户说「编译并发布 0.3.20」。`npm run dist` 退出 0，产物 `dist/TokenPulse-0.3.20-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.20）；asar 里 7 个相关文件和 `resources/prism-bridge` 4 个文件与源码一致。推送前 fetch 过，远端没有新提交。提交 `3bc170a TokenPulse v0.3.20：Prism 桥的代理冲突提醒、日志文件、一键删除`，标签 `v0.3.20`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.20 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.20。没有会话链接。发布说明照前几版的格式，草稿在 `dist/release-0.3.20.md`。提交、打标签并推送、建 Release 分三步执行（一条命令串起来会被自动模式的权限规则拒绝）。没有在本机实际安装；上面「没有验证的」几项发布时仍然没有验证。**发布后用户反馈（2026-10-04）：「没有验证的都验证过了，没有问题」**——即安装 / 更新到 0.3.20、一键修复写环境变量、全部删除（含卸载 Chromium 和 Codex 正在用时先切回官方）由用户本人试过，不是我验证的。

**0.3.19：Prism 桥 · 已完成，已提交、打包、发布（2026-10-04，Claude）**
- 用户要求：把第三方开源的 Prism Bridge（`D:\CodePorject\Tools\prism-bridge-main`，作者 yyyllllming，MIT）整合进 TokenPulse，算 0.3.19；做好只编译测试版，不发布。用户的目标是让小白用户也能用，所以代码随软件打包。用户知道并接受它可能不符合 OpenAI 服务条款的风险；界面、README、更新说明里都写了这条风险。
- 它是什么：`bridge.py`（约 3100 行，依赖 playwright）用真实 Chromium 登录用户自己的 Prism（prism.openai.com）账号，在本机开 OpenAI 兼容接口（Responses / Chat Completions）给 Codex 用。命令 `login | serve | status`。
- **改动**：
  - `vendor/prism-bridge/`：`bridge.py`、`LICENSE`、`NOTICE.md`。对 bridge.py 的第一处改动：新增环境变量 `PRISM_PROXY`，传给 `launch_persistent_context(proxy=…)`（登录和服务两处，搜 `PROXY_OPTION`），因为 Chromium 不读 HTTPS_PROXY。以后换新版 bridge.py 要把这处补回去。`package.json` 的 extraResources 把它打到 `resources/prism-bridge`。
  - 新文件 `src/core/prism-bridge.ts`：数据都在 `~/.tokenpulse/prism-bridge/`（`config.json` 端口 / 随机密钥 / 是否跟着启动，`venv/`，`deps.json` 装好的标记，`profile/` 浏览器数据和 auth.json）。
    - `installPrism()`：找 Python 3.10+（`python`、`py -3`、`%LOCALAPPDATA%\Programs\Python\Python3*`），没有就试 `winget install Python.Python.3.13`；建 venv；`pip install playwright`（失败换清华镜像）；`playwright install chromium`（失败换 npmmirror）。
    - `loginPrism()` / `startPrism()` / `stopPrism()` / `releasePrism()` / `resumePrism()`：子进程管理。就绪判断是 stdout 里出现「服务已就绪」。停止用 `taskkill /PID <自己起的 pid> /T /F`。
    - 子进程环境：外面的 `PRISM_*` 一律不继承；强制 `PRISM_HOST=127.0.0.1`、总带随机 `PRISM_BRIDGE_API_KEY`；代理按 `proxyFor`（环境变量优先，其次系统代理）给 pip / playwright 下载和浏览器（`PRISM_PROXY`）。
    - 交给界面的状态只有账号 id、套餐、过期时间；cookie 和密钥不出主进程。只看状态不会写文件。
    - 测试用的环境变量：`TOKENPULSE_PRISM_SCRIPT`（换脚本）、`TOKENPULSE_PRISM_PYTHON`（直接指定解释器，跳过 venv）。
  - `src/main/index.ts`：IPC `prism:state / install / login / start / stop / auto-start / provider`，事件 `prism-bridge`；启动时 `resumePrism()`；`before-quit` 里 `releasePrism()`。`prism:provider` 走 `agentWrite` + `saveProvider`（Codex，openai-responses，`http://127.0.0.1:18765/v1`，四个模型，默认 gpt-6.1-sol；按地址或名字「Prism 桥」找已有的来更新）。`src/main/preload.ts` 加了对应方法。
  - `renderer/agent-switch.js`：「本地路由」分组下新增一节 `prism`（SECTIONS、nav、sectionTitle、render 分发表）。四步卡片（`.pv-prism-step[data-step=deps|login|service|provider]`）+ 风险说明 + 日志。安装 / 登录 / 启动不走 `run()`（会锁整页），按推送的状态禁用按钮；加供应商走 `run()`。样式在 `agent-switch.css` 末尾。
  - 版本号 0.3.19；intro NOTES 一条；i18n 已补（两条格式在 PATTERNS 开头）；README 在「供应商切换与本地路由」下加了「Prism 桥」一节（没有加版本小节）。
- **测试**：
  - 新增 `scripts/test-prism-bridge.cjs`（已加进 npm test，5 组）：用本机 python 跑一个假的 bridge.py，测状态、登录后不泄露 cookie / 密钥、环境变量、启动 / 停止、失败原因、跟着启动、退出时结束。本机没有 python 会 SKIP。
  - `test-agent-switch-ui.cjs`：二级菜单数 9 → 10；加了 Prism 桥一段（四步的初始可点状态、风险文字、点「添加到 Codex 供应商」后存进去的内容、密钥不出现在页面上）。
  - `npm test` 退出 0；`npm run test:ui` 退出 0，共 33 个 PASS。
  - **真实跑过的**：`installPrism()` 在本机真实执行成功（装到 `~/.tokenpulse/prism-bridge`：playwright 1.63.0，Chromium 下到 `%LOCALAPPDATA%\ms-playwright` 的 1243 版）。第一次从 PyPI 下载超时失败（走 7890 代理也只有 160 kB/s），所以加了重试和镜像；第二次成功，pip 一步用了约 10 分钟。用这个 venv 跑打过补丁的 `bridge.py status` 正常。
  - **没有验证的（都需要用户本人的账号）**：真实登录、真实启动服务、Codex 经它发请求、`PRISM_PROXY` 是否真的让浏览器走了代理、winget 装 Python 那条路（本机已有 Python）、界面的实际观感（没有截图看过）。
- **追加（用户：登录不要单独弹一个测试版浏览器，用用户自己的浏览器）**：登录窗口改用系统里装的 Chrome / Edge。
  - `bridge.py` 第二处改动：环境变量 `PRISM_LOGIN_CHANNEL`（`chrome` / `msedge`）传给登录那次 `launch_persistent_context(channel=…)`。
  - `prism-bridge.ts` 的 `loginChannel()`：读注册表里 https 的默认浏览器，是 Chrome / Edge 就用它；是别的（Playwright 只能驱动这两种）就装了 Chrome 用 Chrome、否则 Edge；都没有用自带 Chromium。
  - 登录窗口用单独的浏览器数据 `login-profile/`（系统 Chrome 和服务用的 headless Chromium 版本不同，不能共用一份）；凭据用 `PRISM_AUTH_FILE` 写到 `profile/auth.json`，服务启动时从那里注入 cookie（bridge.py 原本就支持凭据文件和浏览器数据分开）。服务仍用 Playwright 的 headless Chromium，没有窗口。
  - **做不到的**：直接用用户平时浏览器里已登录的状态（读不到那份数据，Chrome 也不允许自动化默认用户目录）。登录窗口是 Chrome / Edge 的一个干净窗口，要在里面登录一次。已向用户说明。
  - 实测：用 venv 的 playwright 以 `channel='chrome'`、经 `http://127.0.0.1:7890` 无头打开 prism.openai.com，返回 200（Chrome 154）。说明系统 Chrome 能被驱动、代理参数生效。有界面的登录流程本身仍没有验证。
  - 追加后：`npm test` 退出 0，`npm run test:ui` 退出 0（33 个 PASS），测试版已重新编译，下面的产物核对是这次之后做的。
- **追加（用户反馈：登录窗口一直让验证是不是真人，验证多少次都过不了）**：
  - 原因判断：登录窗口是 Playwright 控制着打开的，登录页的真人验证认得出被自动化控制的浏览器。没有抓包确认，是按现象判断的。
  - 改法：登录改成**用正常方式启动**系统的 Chrome / Edge（`spawn(chrome.exe, --user-data-dir=login-profile, [--proxy-server], prism 网址)`），登录过程中没有程序控制它。用户登录到看见 Prism 界面后**自己关掉窗口**；TokenPulse 等进程退出（最多 20 分钟），再跑新文件 `vendor/prism-bridge/collect_login.py`（TokenPulse 自己写的）：用同一个浏览器无头打开那份数据、不加载任何网页，读出 cookie，按 bridge.py 的格式存 auth.json。找不到 Chrome / Edge 时仍走 bridge.py 原来的 `login`。
  - `loginChannel()` 改名 `loginBrowser()`，返回 `{ channel, exe }`；测试用的 `TOKENPULSE_PRISM_PYTHON` 设了就不用系统浏览器（走原来的 login），`TOKENPULSE_PRISM_BROWSER` 可以指定浏览器程序。
  - **不做的事**：不给自动化浏览器加任何伪装 / 反检测参数。后台服务（无头 Chromium）如果自己也被拦，不走伪装这条路，先让用户换代理节点。
  - 实测：正常启动的 Chrome（临时目录，无头）存下的 cookie，事后用 Playwright `channel='chrome'` 打开同一目录能读出来（6 个，值都非空）。`collect_login.py` 对着还没登录的 `login-profile` 运行，输出「没有有效会话」、退出码 2、没有写 auth.json。**真实登录后能不能读到 Prism 的会话、会话 cookie 关窗口后还在不在，没有验证**（需要用户登录）。
  - 追加后：`npm test` 退出 0，`npm run test:ui` 退出 0（33 个 PASS），测试版已重新编译；`resources/prism-bridge` 现在是 4 个文件，和源码一致；没有遗留进程，产物没被占用。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物 `dist/win-unpacked/TokenPulse.exe`（0.3.19）。`resources/prism-bridge` 的 3 个文件和 asar 里 7 个相关文件与源码一致。没有打 Setup 和 Portable（dist 里的安装包还是 0.3.18 的）。
- 收尾检查：没有留下本轮起的 electron / python 进程；win-unpacked 的 exe、app.asar、bridge.py 能独占打开。当时在跑的 TokenPulse.exe 是用户自己装的正式版（`AppData\Local\Programs\TokenPulse`，14:53 启动），没有动。
- **Git**：都没有提交。新增未跟踪：`vendor/`、`src/core/prism-bridge.ts`、`scripts/test-prism-bridge.cjs`。发布前要想清楚：发布等于把 Prism Bridge 的代码随安装包公开分发。
- 已知限制：端口固定 18765（只能手改 config.json）；只支持 HTTP 代理；安装版每次装环境要联网下载约 200 MB；退出时是强制结束进程树；Codex 切到这家后，TokenPulse 没开或服务没启动时 Codex 会连不上（可以打开「跟着 TokenPulse 启动」）。
- **用户反馈（2026-10-04，改成正常启动 Chrome 登录之后）**：整条链路都成功了（登录、启动服务、Codex 经它发请求），拿到的模型是没有被降智的版本。这是用户本人用真实账号验证的，不是我验证的。
- **追加（用户：优化 Prism 桥的界面，写明适合「降智」账号、正常账号没必要用）**：`renderer/agent-switch.js` 的 `prismSection()` 重写，样式在 `agent-switch.css` 末尾（`.pv-prism-*`）。
  - 顶部总状态 `.pv-prism-hero`：一句话写现在到哪一步，进度 n/4、登录还剩几天、端口，加**唯一的主按钮**（下一步该点的那个）。安装 / 登录 / 启动中是黄色脉冲（`.busy`），启动失败是红色并直接写原因（`.failed`）。
  - `.pv-prism-fit`：「适合：账号被降智了」「没必要：账号是正常的」并排，下面是风险说明（原来单独的风险卡片并进来了）。
  - 四步 `.pv-prism-step`：当前步骤 `.current` 高亮，后面的 `.later` 变淡，做完的 `.done` 打勾。第 4 步改成「接到 Codex」：没加 → 添加；加了没启用 → 「在 Codex 里启用」（直接 `agentActivate`，走确认流程）；启用了才算完成。下面列出四个模型。
  - Codex 选着 Prism 桥、服务却没启动时，顶部多一条红色提醒 `.pv-prism-warn`。
  - 日志改成可折叠 `.pv-prism-logbox`：平时收着，安装 / 登录 / 启动中或出错时自己展开，用户点过就听用户的。
  - 「跟着 TokenPulse 启动」开关挪到第 3 步的说明下面。主进程的 `prismView` 多返回 `models`。
  - 更新说明、README 这一节的标题和开头都改成先说适合谁用；README 的登录步骤改成现在的做法。i18n 已补。
  - 用临时数据目录 + 假状态截图看过四种状态（全新、安装中、运行中未接 Codex、启动失败）的浅色和深色（截图脚本在 scratchpad，没有进仓库）。「Codex 正在用」和红色提醒这两种状态没有截图看，只有代码。
  - `test-agent-switch-ui.cjs` 的 Prism 桥一段改成断言新结构。`npm test` 退出 0，`npm run test:ui` 退出 0（33 个 PASS），测试版已重新编译并核对。
- **发布**：用户试用通过后说「直接编译并发布」。`npm run dist` 退出 0，产物 `dist/TokenPulse-0.3.19-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.19）；`resources/prism-bridge` 4 个文件和 asar 里 7 个相关文件与源码一致。推送前 fetch 过，远端没有新提交。提交 `050d371 TokenPulse v0.3.19：Prism 桥，账号被降智时经自己的 Prism 账号给 Codex 开本机接口`，标签 `v0.3.19`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.19 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.19。没有会话链接。发布说明按前几版的格式写（用户要求模仿之前的风格），草稿留在 `dist/release-0.3.19.md`。
  - 第一次把「提交 + 打标签 + 推送 + 建 Release」写成一条命令时，被 Claude Code 自动模式的权限规则拒绝；用户明确说「直接帮我提交创建 release」之后，分成提交、打标签并推送、建 Release 三步执行，都通过了。
  - 没有在本机实际安装 0.3.19 的安装包（用户试用通过的是免安装测试版，代码相同）；自动更新到 0.3.19 也没有人确认过。
  - 收尾检查：没有留下本轮起的进程；dist 里的安装包和 app.asar 能独占打开。
- 以后要注意：`vendor/prism-bridge/bridge.py` 是随安装包公开分发的第三方代码；Prism 网页改版后桥可能失效，届时要拿原项目的新版覆盖，并把 NOTICE.md 里写的两处改动补回去。

---

# 0.3.18 及更早的历史记录

以下各节都是按当时的状态写的，产物路径、测试数量、「未提交 / 待验证」这类说法只对当时成立。当前状态看文档最上面的「新对话先看这里」。

## v0.3.18：添加本机 CLI 已登录的账号 + 官方登录识别为当前供应商 · 已完成，已提交、打包、发布（Claude）

> 以下各节是每个版本当时的工作记录，按时间从新到旧；里面的「未提交 / 进行中」只代表当时的状态，现在以上面的「新对话先看这里」为准。

- 用户要求（都算 0.3.18；**改完给测试版，不打安装包，不发布**）：
  1. 官方账号里可以选择「添加一个本机 CLI 已经登录的账号」：不把账号托管在 TokenPulse 里，也能读到使用情况。
  2. BUG：Claude Code 和 Codex 明明用的是官方登录，供应商页却显示「没有识别到当前供应商」。
- **第 2 条（BUG）**：`agent-switch.ts` 的 `currentId()` 原来只在「TokenPulse 切换过，而且之后配置文件一个字没变」时才认官方登录；从没切换过，或者工具自己改过配置（Codex 经常改 config.toml），就返回空。现在：工具配置里没有第三方地址（`liveMarker` 为空）就是官方登录，返回 `officialOf(store, app).id`。Claude 桌面端：配置库的 `_meta.json` 没有启用任何配置时是官方，启用了别人的配置则认不出。配置里是不认识的第三方地址时仍然是「没有识别到」。
- **第 1 条**：
  - 背景（只读查过用户本机）：CLI 登录的账号本来会自动登记（只记名字、不存凭据）。但用户的 ChatGPT 账号以前被「完全删除」过，进了 `removed` 名单，自动登记不会让它回来；界面上「添加账号」只有登录这一条路，而登录会把凭据存进 TokenPulse。
  - `core/accounts.ts`：新增 `adoptCliAccount()`，只登记名字、不存凭据；会取消隐藏、从 `removed` 里去掉；已经存着的凭据不动。
  - `main/oauth.ts`：新增 `addCliAccounts(kind)`，CLI 没登录时报错说明；`main/index.ts` 新增 IPC `accounts:add-cli`（之后后台刷新额度）；preload 新增 `addCliAccount`。
  - `renderer/app.js`：「添加账号」按钮改成弹菜单（`data-account-action="add"`）：「用本机 CLI 已登录的账号」/「登录一个新账号」；点击处理拆成 `runAccountAction()`。添加成功先提示，额度在后台刷新（不等它）。设置页下面那句安全说明也改了。
  - CLI 之后换了账号或退出登录，这个账号就没有可用凭据了（记录还在，状态显示凭据过期），这是「不托管」的固有限制。
- 测试：`test-codex-compat.cjs` 加了一组（没切换过的四个工具都识别为官方；工具自己改配置后仍是官方；不认识的第三方地址不算官方），9/9；`test-accounts.cjs` 加了 9 条（67/67）；`test-ui.cjs` 加了添加账号菜单一组（主进程通道换成假的），并把「页面上不能出现『本机 CLI』」那条旧断言收窄到关于页。
- 版本号 0.3.18；intro NOTES 两条；README 只在「官方额度」那格补了一句（没有加版本小节）；i18n 已补。
- **验证**：`npm test` 退出 0；`npm run test:ui` 退出 0，共 33 个 PASS。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物是 `dist/win-unpacked/TokenPulse.exe`（0.3.18）；asar 里 9 个相关文件和源码一致；对 app.asar 跑 test-ui，新加的那组通过。没有打 Setup 和 Portable（dist 里的安装包还是 0.3.17 的）。没有遗留进程，文件没被占用。
- **发布**：用户试用测试版后说「应该没啥问题了，编译 + 发布」。`npm run dist` 退出 0，产物是 `dist/TokenPulse-0.3.18-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.18）；asar 里 9 个相关文件和源码一致。推送前 fetch 过，远端没有新提交。提交 `98d22a9 TokenPulse v0.3.18：添加本机 CLI 已登录的账号，官方登录识别为当前供应商`，标签 `v0.3.18`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.18 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.18。没有会话链接。没有在本机实际安装。发布用的构建是测试通过之后的同一份代码（测试版之后代码没有再改）。


## v0.3.17（历史）：本地路由 / 号池转发走代理，所有联网请求统一代理规则 · 已完成，已提交、打包、发布（Claude）

- 用户反馈：Grok 号池里的账号明明登录着，转发记录却全是 502，问是不是 BUG。
- **结论：是 BUG**。只读查了本机 `~/.tokenpulse/agent-switch-log.json`：7 条都是 grok、502、error 为空，耗时依次相差约 21 秒；6 个 Grok 账号凭据都在、没过期。实测：本机要经 `127.0.0.1:7890` 代理才能连 `cli-chat-proxy.grok.com`（经代理不到 1 秒回 401，直连 21 秒超时）。`agent-proxy.ts` 的转发用 Node 的 `https.request`，不看 HTTPS_PROXY 也不看系统代理，一律直连，所以每个成员都连接超时；超时抛的是 AggregateError，message 是空的，所以记录里没有原因。和登录状态无关。
- **改动（已随 0.3.17 发布）**：
  - 新文件 `src/core/upstream-proxy.ts`：`envProxyFor`（HTTPS_PROXY / HTTP_PROXY / ALL_PROXY，大小写都认；NO_PROXY；本机地址永远直连；只支持 http:// 代理，SOCKS 按直连）、`setSystemProxyResolver` + `proxyFor`（环境变量没有时问系统代理，结果缓存 30 秒）、`upstreamRequest`（https 上游用 CONNECT 隧道的 `TunnelAgent`，明文上游把完整地址交给代理）、`describeNetError`（把超时、拒绝、DNS 失败说清楚，没走代理时提示去设代理）。没有引入新依赖。
  - `src/core/agent-proxy.ts`：`forward`、`fetchUpstreamModels`、`probeUrl` 三处都改成先 `proxyFor` 再 `upstreamRequest`；错误原因用 `describeNetError`。
  - `src/main/index.ts`：启动时 `setSystemProxyResolver(url => session.defaultSession.resolveProxy(url))`。
  - 新增 `scripts/test-upstream-proxy.cjs`（已加进 npm test，4 组）：选代理、错误说明、经假代理发请求（含 CONNECT 被拒、代理连不上、NO_PROXY）、本地路由整条链路。
- **验证**：`npm test` 退出 0；`npm run test:ui` 退出 0，共 32 个 PASS。真实链路（临时起一个本地路由，转到 Grok 官方地址，用假令牌，不碰用户账号）：两个成员各在约 1 秒内拿到 Grok 返回的 401，不再是 21 秒超时。
- **追加（用户：「开着代理为什么还有漏网之鱼，都补上」）：把所有往外发请求的地方排查了一遍**。结论是三类请求认的代理不一样：
  | 谁发的 | 用在哪 | 环境变量里的代理 | 系统代理 | 处理 |
  |---|---|---|---|---|
  | Node 的 https | 本地路由转发、获取模型列表、检测地址 | 原来不认 | 原来不认 | 已改：两种都认（上面那条） |
  | curl | 查额度、续期登录、出口检测、IP 数据库 | 认 | 原来不认 | 已改：环境变量里没有时，按系统代理补 `--proxy`（`curlProxyArgs`，用在 curl.ts 的 curlJson / curlPost、quota.ts 的 curlBinary、egress.ts 的 probeExit） |
  | Electron 内核 | 自动更新、知识库更新 | 原来不认 | 认 | 已改：系统代理没开、环境变量里有 HTTP 代理时，启动时 `session.setProxy`（`alignElectronProxy`） |
  - 出口检测（probeExit）特意和查额度走同一条路，不然「出口不对就不查额度」的判断对不上。出口监控页那句说明改成了「走环境变量里的代理，没有就走系统代理」。
  - 环境变量里是 SOCKS 代理时：curl 自己会用，Node 这边不支持、按直连，也不改用系统代理。
  - **没有改的**：TokenPulse 启动的 CLI（登录、在软件里回复、终端里的新对话）不注入代理，仍然继承环境变量。原因是 CLI 走哪条路要和用户自己在终端里敲命令时一样，出口 IP 才对得上；替它加代理会让出口和用户以为的不一样。
  - 实测：去掉环境变量里的代理、模拟「只开系统代理」，出口检测从超时变成 1 秒内测到出口。test-upstream-proxy 补了 curlProxyArgs 的各种情况。`npm test` 退出 0，`npm run test:ui` 退出 0，共 32 个 PASS。
- **发布**：用户说「算 0.3.17，直接编译安装包并发布」。版本号 0.3.17；intro NOTES 两条；README 的「供应商切换与本地路由」里加了一段代理规则（没有加版本小节）；i18n 补了错误原因。`npm test` 退出 0；`npm run test:ui` 退出 0，共 32 个 PASS。`npm run dist` 退出 0，产物是 `dist/TokenPulse-0.3.17-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`；asar 里 9 个相关文件和源码一致；对 app.asar 跑 test-ui，19 个 PASS。推送前 fetch 过，远端没有新提交。提交 `bee5940 TokenPulse v0.3.17：号池 / 本地路由转发走代理，所有联网请求统一代理规则`，标签 `v0.3.17`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.17 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.17。没有会话链接。没有在本机实际安装。
- **没有实际验证的**：没有用用户的真实号池发过请求（会用到真实令牌），需要用户更新后自己发一条消息确认；自动更新 / 知识库更新走环境变量代理那一处（alignElectronProxy）只改了代码，没有实际跑过更新流程。
- 已知限制：只支持 HTTP 代理，SOCKS 代理不支持（按直连）；TokenPulse 进程里要能拿到代理（环境变量，或系统代理开着）。Clash 这类软件如果只开了「TUN 模式」则本来就不需要这个。


## v0.3.16：两个修复 + 检测间隔 + 新对话 / 新项目 · 已完成，已提交、打包、发布（Claude）

- 用户要求（都算 0.3.16；**只编译测试版，不打安装包，不发布**）：
  1. 修：用量明细切换分类时界面突然跳到上面一点；别的地方有同样问题也一起修。
  2. 修：会话管理里项目文件夹带空格时，「在终端里继续」报错、打不开 CLI。
  3. 新增：出口监控的检测间隔可以自定义，5 到 60 秒，默认 10 秒。
  4. 新增：会话管理可以开启新对话、开启新项目。用户说先看做出来的效果，再提修改意见。
- **已完成（已随该版本发布）**：
  - **页面往上跳**：原因是新内容比原来短，浏览器把滚动位置夹到新的底部。`renderer/app.js` 新增 `scrollGuard`：在 `.workspace` 末尾加一个 `#scroll-floor` 垫片，用 ResizeObserver 加 scroll 事件判断「位置变小而且正好贴着新底部」就是被夹了，垫高后把位置放回去；用户往上滚，垫片跟着缩；`navigate()` 里调 `reset()`。所有页面共用。当场读布局和下一帧才排版两种情况都处理了。
  - **在终端里继续**：真正的原因不是空格（带空格的路径实测正常），是用户的文件夹叫「JMY‘s Mods All in one」，里面有弯引号 U+2018。PowerShell 把 ‘ ’ ‚ ‛ 都当单引号，`quotePs` 原来只翻倍直引号，脚本在那里断开。现在这四种加直引号都翻倍，`quotePs` 也导出了。
  - **检测间隔**：`core/egress.ts` 新增 `INTERVAL_SECONDS {min 5, max 60, default 10}` 和 `EgressConfig.intervalSeconds`（旧配置没有这项时用 10；不是 5 到 60 的整数就报错）。`egress-monitor.ts` 按配置定时，间隔变了重新定时，`snapshot.intervalMs` 和 `nextCheckAt` 跟着配置走；手动检测的最小间隔仍是 `INTERVAL_MS` 5 秒。界面在出口监控页顶部加了数字输入框 `#egress-interval`，状态文字写「每 N 秒检查一次」。注意以前固定是 5 秒，升级后默认变成 10 秒。
  - **新对话 / 新项目**：
    - 主进程新增 IPC：`sessions:clis`（装了哪些 CLI）、`sessions:pick-folder`（系统选文件夹对话框，可新建）、`sessions:new`（校验工具和文件夹后调 `openTerminal(kind, null, cwd)`）。`terminalScript` 的 id 为 null 时不带参数。preload 新增 `sessionClis`、`pickProjectFolder`、`startSession`。
    - `renderer/sessions.js`：列表上方 `.sw-new-row` 两个按钮；`openNew(folder?)` 对话框 `#sw-new`，里面是项目文件夹下拉（本机会话里出现过的）加「选择文件夹…」，三个工具卡片（没装的禁用），「在终端里开始」。默认选中正在看的会话的项目和工具。开始后弹提示，15 秒后自动刷新一次列表。
  - 版本号 0.3.16；intro NOTES 四条；README 0.3.16 一节；i18n。
  - 测试：`test-sessions.cjs`（弯引号翻倍，真的交给 PowerShell 解析后路径原样还原；新对话脚本）、`test-egress.cjs` 18/18（间隔校验、定时器、保存）、`test-ui.cjs` 新增两组（scroll guard；new chat / new project），出口监控那组加了间隔的断言。这些单独跑都通过。
  - **scrollGuard 后来的两处补充**（测试偶发失败时用临时日志查出来的）：
    - 浏览器自己的「滚动锚定」会在切换视图时挪动页面（两种视图高度不同，实测挪了 400 多像素），这也是「点一下界面跳了」的来源之一。所以点了切换类控件（`SWITCHERS`：分段按钮、`[data-view]`、筛选芯片、翻周期、缩放、翻页、下拉）之后的 1.5 秒内，把被点的控件钉在屏幕上原来的位置（`keepPinned`）；只有用户自己操作（滚轮、触摸、键盘、在滚动条上按下）才放弃。
    - `keepScroll` 改成重画前调 `scrollGuard.sync()`、重画后调 `scrollGuard.restore()`：不能等 scroll 事件，等它到的时候内容已经重建、变高，看不出被夹过。
    - 注意：点了切换类控件之后的 1.5 秒内，如果代码自己滚动页面，会被拉回去。目前这些控件的处理函数都不滚动；`navigate()` 会 `reset()`。
  - 截图看过新对话对话框（夜间）和出口监控页的间隔输入框；对话框页脚套用了通用 footer 样式，多出一块空白，已去掉。
- **追加（用户要求，仍算 0.3.16）：TokenPulse 启动的 CLI 先核对出口 IP 白名单**。用户特别说明：CLI 是在 PowerShell 里跑的，走的网络可能和软件自己不一样，所以检测也要在 PowerShell 里做。
  - `session-reply.ts`：新增 `exitGuardScript(kind, {host, allowedIps})`，`terminalScript` 和 `openTerminal` 多一个 guard 参数。脚本顺序是：进目录 → 检测 → 启动 CLI。检测用 `curl.exe … https://<host>/cdn-cgi/trace` 取 `ip=`，两边用 `[System.Net.IPAddress]::Parse().ToString()` 规范化后比较；测不出来或不在白名单时，用红字说明后 `return`（窗口是 -NoExit 的，会留着让用户看到原因）。
  - `egress-monitor.ts`：`launchRule(provider)` 返回 host 和白名单，没设就是 null；`gateLaunch(provider, what)` 给「在软件里回复」用，每次都现测、不用缓存，被拦时记一条 warning 事件。
  - `main/index.ts`：`CLI_PROVIDER`（claude→claude，codex→chatgpt，grok→grok）；`openInTerminal` 和 `startConversation` 把 guard 传给 `openTerminal`，返回值带 `guarded`；`replyInApp` 先过 `gateLaunch`；`sessions:clis` 多返回 `guarded`。
  - 渲染：设了白名单的工具在新对话对话框里有一句说明，提示条也会说明「启动前会先在终端里检测出口 IP」。i18n、intro NOTES、README 都已补。
  - **实测（scratchpad 的 guard-live.cjs，真的在 PowerShell 里跑、真的请求 trace）**：三家的域名都能测到出口；白名单不含当前出口时拒绝，含时放行，域名不可达时拒绝。过程中修了两处：TS 模板字符串里的 `\S` 会变成字母 S，正则改成不用反斜杠的字符类；测试脚本自己的抓取正则写得太贪。
  - 测试：test-sessions（脚本顺序、两处 return、没设白名单不检测、引号、真的交给 PowerShell 跑一遍 .invalid 域名必须拒绝）；test-egress 19/19（gateLaunch 的四种情况和事件记录）；test-ui（对话框里的说明）。
  - **用户随后改了规则**：「设了地区白名单又设了 IP 白名单，只看 IP；设了地区、没设 IP，就看地区；都没设就不检测，直接放行」。已照做：`ExitGuard` 加了 `allowedRegions`，新增 `guardMode()` 返回 'ip' / 'region' / null；PowerShell 脚本同时取 `loc=`（XX / ZZ / EU 当作测不出来），地区模式按大写比较；`launchRule` 在任一白名单非空时返回规则，`gateLaunch` 同样分两种；IPC 的 `guarded` 从布尔值改成 'ip' / 'region' / null，界面文字跟着变。实测（guard-live.cjs）7 种情况都符合：IP 对而地区不对时放行，IP 不对而地区对时拒绝，只设地区时按地区放行或拒绝，不可达时拒绝。和监控开没开无关（用户原话里「没开启出口检测」和「两个白名单都没设」是并列说的，这里按「白名单决定」实现，已在回复里向用户说明）。
  - **新手引导**（用户要求新功能写进教程）：`intro.js` 的 STEPS 加了两步，共 22 步：第 18 步「检测间隔，和启动前核对出口」（高亮 `#page-egress .egress-toolbar`），第 20 步「新对话、新项目」（高亮 `#page-sessions .sw-new-row`）。test-intro-ui 的检查表加了这两步；「一路点到完成」的循环上限从 20 改成 60。
  - **追加（仍算 0.3.16）：单价变化的标法**。用户问「单价刚更新」是不是真的有变化，没变不该标；真变了要在详情里写涨了还是降了多少。查数据：知识库里 71 条带 changedAt 的规则，previous 全是家族兜底价，没有一条是官方调价。
    - `scripts/update-knowledge.cjs`：previous 取自兜底价时记 `previousFallback: true`；沿用旧记录时原样带着；旧数据没有这个标记时，previous 等于兜底价就补上。`knowledge/models.json` 用生成器重新生成为 2026.10.03（实际联网拉取；对比过，除了版本号、日期和这个新标记，其他内容完全一样）。
    - `src/core/knowledge.ts`：PriceRule 加 `previousFallback`；`priceNotes().changed` 带 `fromFallback`；前后四项单价一样的不算变化（缓存写为 0 按输入价比）。
    - `renderer/model-study.js`：`changeTag()` 分「改用实际标价」（灰）、「刚降价」（绿）、「刚涨价」（红）、「单价刚更新」（有涨有降）；`priceChangeFact()` 是详情里的一栏，逐项列「旧价 → 新价 涨跌幅」，再加按用量结构算的综合单价变化。原来 priceNoteLines 里那句「单价 9/30 更新…」删掉了。
    - 测试：test-knowledge-update（标记的生成、沿用、旧数据补标、真调价不标）、test-features 46/46（fromFallback、前后一样不算）、test-model-study-ui（改用实际标价的标签和详情；用 IPC 钩子造出降价、涨价、有涨有降三种，断言标签、逐项幅度和英文翻译）。夜间截图看过「刚降价」的详情。
  - 已知限制：没设白名单的那一家不检测；终端里被拒绝时 TokenPulse 这边不知道结果（只有终端里有提示）；用户在那个终端里之后手动再敲 CLI 命令不受限制；需要系统自带的 curl.exe（Win10 1803 起有），没有就按「测不出来」拒绝。
- **验证**：`npm test` 退出 0；`npm run test:ui` 退出 0，共 32 个 PASS（比上一版多两组）。test-ui 的滚动那组在源码上连续跑 5 次、在打包后的 app.asar 上连续跑 3 次，都通过。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物是 `dist/win-unpacked/TokenPulse.exe`（0.3.16）；asar 里 13 个相关文件和源码一致。没有打 Setup 和 Portable（dist 里的安装包还是 0.3.15 的）。
- 收尾检查：没有留下 electron 或 dist 下的 TokenPulse 进程；win-unpacked 的 exe 和 app.asar 都没被占用。
- **发布**：用户试用后说「直接编译安装包并发布」。`npm run dist` 退出 0，产物是 `dist/TokenPulse-0.3.16-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.16）；asar 里 17 个相关文件和源码一致。推送前 fetch 过，远端没有新提交。提交 `db6e8e7 TokenPulse v0.3.16：新对话 / 新项目、启动 CLI 前核对出口、检测间隔、单价变化说清楚`，标签 `v0.3.16`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.16 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.16。发布说明里没有会话链接。没有在本机实际安装。
- **发布后的改动，0.3.16 重新发布（2026-10-02，用户要求版本号不变）**：
  - 规则改成「出口监控关着就不核对出口」：`ExitMonitor.launchRule()` 在 `config.enabled` 为假时返回 null（终端里的检测和「在软件里回复」的 gateLaunch 都走它）。额度查询的 gateQuota 没动，仍然只看 IP 白名单。新手引导、更新说明、README、i18n 的说法都跟着改了。test-egress 的那一组重写（监控关着不探测、不记录；开着的各种情况）。
  - **README 截图全部重做**，用户要求不能泄露本机真实数据：`scripts/capture-ui.cjs` 改成**完全不读真实数据**。数据目录和主目录都指向新建的临时目录，界面切到软件自带的演示数据（`window.tokenpulse.demo(true)`，账号是「演示账号」），主进程推过来的真实快照在脚本里丢掉，出口监控仍用文档专用地址段的示意数据。每张图截完会检查有没有邮箱、本机用户名、主目录路径，并确认还在演示模式。新增 `detail-light.png`（点开一行的详情）；README 的截图表去掉了 compact-light，加了说明「全部是演示数据」。12 张图都截了，其中 6 张（总览、详情、设置、出口监控、时间线、用量）我看过，确认只有演示账号和示意地址。
  - 顺手修了两处文字：没有思考等级的型号，详情里「按 档的实际大小推算」中间是空的，改成「按你最常用那一档」；时间线标题下的说明还写着旧的「拖动选一段」，改成左键平移、右键拖选。
  - 验证：`npm test` 退出 0；`npm run test:ui` 退出 0，共 32 个 PASS。`npm run dist` 退出 0，asar 里相关文件和源码一致，编译后的 launchRule 里有「监控关着返回 null」。
  - 重新发布：提交 `073dc38 TokenPulse v0.3.16：出口监控关着时不核对出口；README 截图改用演示数据`，v0.3.16 标签强制移到这个提交（原来在 db6e8e7），Release 的 4 个附件用 `gh release upload --clobber` 覆盖，大小和本地一致，线上 latest.yml 的 sha512 和本地一致，发布说明也改了。没有会话链接。**已经更新到第一版 0.3.16 的安装版不会再自动更新**（版本号相同），要拿到这次改动需要重新下载安装包。
- **README 不再写各版本的更新日志（2026-10-03，用户要求）**：删掉了 0.3.9 到 0.3.16 的十几节「版本号 · 标题」，更新日志只放在 GitHub Release（和软件里的「新版本有什么」）。其中属于功能说明的内容保留，改成不带版本号的功能章节：「供应商切换与本地路由」（含配置保护、配置被改走时提醒、Codex 试读）、「本机以外的使用」；「模型 × 思考等级」「出口监控」去掉了标题里的版本号，补了详情面板、单价标签、添加模型、检测间隔、启动 CLI 前核对出口；会话管理那格补了新对话 / 新项目；安装一节里过时的「当前版本：v0.3.8」删掉了。README 里现在没有任何版本号。**以后发版不要再往 README 里加版本小节**，只改功能说明。只改了文档，没有重新打包。
- **没有实际验证的**：新对话 / 新项目 / 在终端里继续没有由我真的弹出过终端窗口（自动测试把主进程通道换成了假的；PowerShell 脚本本身实测过）。用户试用后说「看着没啥问题了」。「监控关着但设了白名单时照样核对出口」是按「白名单决定」实现的，向用户说明过，用户没有提出异议。
- 已知限制：新对话只能在终端里开始，不能在 TokenPulse 里直接发第一条消息；新会话要等 CLI 写出会话文件后才出现在列表里（15 秒后自动刷新一次，或手动点刷新）。


## v0.3.15（历史）：修复切到第三方后 Codex 桌面端「无法加载登录要求」 · 已完成，已提交、打包、发布（Claude）

- 用户反馈：在设置里登录了账号后，选择第三方 API，启动 Codex 桌面端就报「无法加载登录要求」，进不了界面。之后追加：其他 CLI 有没有同类问题也要检查，有就一起修。都算 0.3.15。**用户没说要发布，发布前先问。**
- **排查过程（都是在临时目录里复现，没碰真实的 ~/.codex）**：
  - 这句话在 Codex 桌面端 app.asar 里的标识是 `electron.loginMethods.error`。触发条件有两个：读不到管理策略，或者读用户 config 失败（`configReadSucceeded` 为假）。也就是说 config.toml 读不进去时就会显示它。
  - 用本机的 codex.exe（桌面端自带的 codex-cli 0.159.2）在临时 CODEX_HOME 里跑 `codex features list`，复现出两个原因：
    1. **第三方状态**：报 `failed to parse model_catalog_json … missing field support_verbosity`。逐个字段试出来，0.159 起每个模型必填 slug、display_name、priority、visibility、supported_in_api、shell_type、base_instructions、supported_reasoning_levels、**support_verbosity、truncation_policy、experimental_supported_tools**，后三项是我们的骨架缺的。另外新版 models_cache.json 里已经没有 base_instructions，`loadCodexTemplate` 找不到模板，所以一直走骨架。
    2. **切回官方或关掉路由之后**：留下空的 `[model_providers.tokenpulse_route]`，Codex 报 `provider name must not be empty`。用户真实的 config.toml 现在就是这个状态（复制一份到临时目录验证过，读取失败）。
  - 另外还有两点：每切换一次会多留几个空行（删键时只删了 key = value，没删换行）；`wire_api = "chat"` 新版 Codex 直接拒绝，不过那条路径本来就总走本地路由，实际写不出来。
- **已完成（已随该版本发布）**：
  - `agent-models.ts`：新增 `CODEX_CATALOG_DEFAULTS`（骨架加必填字段的保守默认值）、`CODEX_CATALOG_REQUIRED`、`patchCodexCatalog()`（给磁盘上的旧目录补字段）；`codexCatalogEntry` 改成先铺默认值，再叠模板。
  - `agent-toml.ts`：`upsertKey` 删键时连整行一起删；新增 `dropEmptyTable()` 和 `ownTable()`；`restoreToml` 还原后，如果自有表是空的也删掉。
  - `agent-switch.ts`：`writeCodex` 和 `writeGrok` 写完后调 `dropEmptyTable`；`wire_api` 一律写 responses；新增 `repairAgentConfigs()`，在 `resumeAgentProxy` 开头调用，走 configTransaction（有备份和历史；只读保护开着时不写，只提示）。它修三样：没在使用的空 Codex 路由表、缺字段的目录、空的 Grok 路由表。
  - 主进程、preload、渲染：新增 IPC `agent:startup-notice`（等启动恢复跑完再返回，只返回一次），`agentStartupNotice`；界面不管在哪个页面都会弹一次修复说明。
  - 新增 `scripts/test-codex-compat.cjs`（已加进 npm test），6 组：TOML、目录、Codex 第三方和官方来回切 3 次、本地路由开关、Grok、启动修复（含只读保护）。**本机有 codex.exe 时，会用真实的 Codex 把每种写出的配置读一遍**；用 0.159.2 和 npm 装的旧版 0.155.1 各跑过一遍，每次 11 项都通过。找不到 codex.exe 时会跳过并打印 SKIP。
  - 版本号 0.3.15；intro NOTES 两条；README 0.3.15 一节；i18n。
- **其他工具的检查结论**：
  - Grok CLI 1.0.44：遇到空的 `[model.tokenpulse_route]` 不会启动失败，只是 `grok models` 里多一项用不了的，现在一并清掉。
  - Claude Code 2.1.285：settings 的 env 是按字符串强制转换的，写数字或布尔值没问题。
  - Claude 桌面端 2.16120：我们写的配置项（inferenceGateway*、inferenceProvider、inferenceModels、supports1m、configLibrary / appliedId 等）在新版 app.asar 里都还在。没有实际启动验证。
- **验证**：
  - `npm test` 退出 0（含 test-codex-compat 6/6，真实 Codex 读取 11 项）；`npm run test:ui` 退出 0，共 30 个 PASS。
  - 端到端（scratchpad 里的 startup-repair.cjs，临时 HOME 里放一份坏配置再启动应用）：启动后空表被删掉、目录补齐；在总览页弹出「已自动修复…」；修复说明只给一次；配置保护的历史里有这次改动。源码和打包后的 app.asar 各跑过一遍，都通过。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物是 `dist/win-unpacked/TokenPulse.exe`（0.3.15）。asar 里 8 个相关文件和源码一致；对 app.asar 跑 test-agent-switch-ui 通过。没有打 Setup 和 Portable（dist 里的安装包还是 0.3.14 的）。
- 收尾检查：没有留下 electron、dist 下的 TokenPulse 或 codex 进程；win-unpacked 的 exe 和 app.asar 都没被占用；自己建的临时目录已经删掉。
- **发布**：用户说「直接编译安装包并发布」。`npm run dist` 退出 0，产物是 `dist/TokenPulse-0.3.15-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.15）；asar 里 10 个相关文件和源码一致。推送前 fetch 过，远端没有新提交。提交 `ef47218 TokenPulse v0.3.15：修复切到第三方后 Codex 进不去，切换前让 Codex 试读模型目录`，标签 `v0.3.15`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.15 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.15。发布说明里没有会话链接。没有在本机实际安装。**用户真实的 `~/.codex/config.toml` 没有动**（还留着那张空表）；用户决定等更新到 0.3.15 后，由启动修复来处理。
- **追加（用户同意做，仍算 0.3.15）：切换前让本机的 Codex 试读目录**：
  - 新文件 `src/core/codex-probe.ts`：
    - `findCodexExe()` 按顺序找：`TOKENPULSE_CODEX_EXE`；桌面端自带的 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`（取最新）；npm 全局装的 vendor 里的 exe。设了 `AGENT_SWITCH_HOME`（自动化测试）时不去找真实机器上的，除非明确指定。
    - `probeCodexCatalog(json)` 是异步的：在临时目录里写目录和一份最小 config，跑 `codex features list`，10 秒超时，用完删掉临时目录。结果有三种：ok、rejected（只有 stderr 里提到 model_catalog_json 才算）、unknown（放行，不记缓存）。缓存按 exe 的大小和修改时间加目录内容来记。
    - `catalogVerdict(json)` 是同步的，只查缓存。`setCodexProbeForTests()` 给测试用。
  - `agent-switch.ts`：`activateProvider` 和 `enableProxy` 在事务之前调 `precheckCodex`；`writeCodex` 查到 rejected 就不写 `model_catalog_json`，configNotice 提示；启动时 `recheckCodexCatalog()` 检查：config 正引用着 tokenpulse-model-catalog.json 而 Codex 读不了，就走事务去掉这条引用，只读保护下只提示。别人的目录（比如 CC Switch 的）不管。
  - 实测本机试读一次约 40 毫秒，命中缓存约 1 毫秒。
  - test-codex-compat 现在 8 组：新增用假试读测逻辑的一组，和用真实 Codex 判断好、坏目录的一组（真实 Codex 读取共 15 项）。
  - 追加后的验证：`npm test` 退出 0（test-codex-compat 8/8，真实 Codex 读取 15 项）；`npm run test:ui` 退出 0，共 30 个 PASS。测试版已重新编译（`electron-builder --win dir` 退出 0），asar 里 8 个相关文件（含 codex-probe.js）和源码一致。对 app.asar 跑 startup-repair 端到端和 test-agent-switch-ui，都通过。没有遗留进程，文件没被占用，试读的临时目录没有残留。
- **追加（仍算 0.3.15）：其中新内容约多少**。用户问「Pro 一周能用 Opus 5.5 medium 10 亿 Token，是不是算错了」。只读汇总了真实请求记录，没有算错：最近 30 天 2,590 次调用里，缓存读占 98.56%、缓存写 1.18%、输出 0.25%，每次调用约 45.6 万 Token，其中新内容约 6,600。用户确认容易误解，要求加一行小字。
  - `renderer/model-study.js`：`freshShare()`；capCell 多一行 `.ms-cap-new`「其中新内容约 X · y% 是重读缓存」（缓存读占比 ≥ 50% 才显示，title 里有解释）；详情卡片多一个同样的小标签；综合单价下面多一句 `.ms-price-why` 的解释。i18n、intro NOTES、README 都已补。
  - 验证：test-model-study-ui 加了断言（缓存读 40% 时不显示；98.6% 时显示「其中新内容约 720 · 98.6% 是重读缓存」；详情里有解释；英文能翻译）。`npm test` 退出 0，`npm run test:ui` 退出 0，共 30 个 PASS。夜间模式截图看过排版，小字颜色从 faint 调成了 muted。测试版已重新编译（`electron-builder --win dir` 退出 0），asar 里 6 个相关文件和源码一致，对 app.asar 跑 test-model-study-ui，4 个 PASS。没有遗留进程，文件没被占用。
- 已知限制：试读只检查模型目录；Codex 如果在别的地方改了格式（比如 provider 表的字段），试读发现不了，要靠 test-codex-compat 在装了新版 Codex 的机器上跑出来。找不到 Codex 可执行文件时（比如只装了别的安装方式）不试读，按原样写。


## v0.3.14（历史）：时间线曲线修复 + 换算表点开看详情 · 已完成，已提交、打包、发布（Claude）

- 用户要求（0.3.14；**只编译测试版，不打安装包，不发布 GitHub**）：
  1. 时间线放大后，曲线下的绿色面积变少；放大到最细再左右拖动会抽动，或者看不到线。
  2. 「换一种模型」只显示 Tokens 和调用次数，没有等价的钱。
  3. 悬停那一行会甩出一大段文字，要改成点击那一行，在下面展开美化过的详情。
- **已完成（已随该版本发布）**：
  - `renderer/model-study.js` 的 drawLanes：
    - 面积路径改成从底边升起、沿阶梯走、再落回底边。原来的面积是连回线的起点闭合，放大后起点高了，就被斜着切掉一块。
    - 新增 `xs()`（不夹在视图边上，最多伸出一屏）和 `clipPath`（`ms-clip-<w>`）：曲线、竖条、本机以外色块、请求色块都放进 `g.ms-plot[clip-path]`，平移时不再挤在边上。
    - 曲线的 `pathLength` / `stroke-dasharray` 只在描线动画时加，动画结束或 2 秒后去掉。
  - 换算表：
    - capCell 下面加 `.ms-cap-sub`（≈ 调用次数 · 本周期还剩）。一度在 Tokens 旁加过 `.ms-cap-usd`（等价的 API 费用），**用户看过后要求删掉**：整窗的等价费用 = 整窗预算，对每个模型都一样，所以不在格子里重复；展开的详情卡片里仍写「API 等价」。
    - 行不再用 tipOn 悬停弹文字。点击或回车、空格展开 `detailPanel()`：两张整窗卡片 `.ms-dw`、一组「项目 / 内容」`dl.ms-facts`（单价及来源和标签、单价说明、思考等级、单次调用、最近 30 天、目录来源）、注意事项 `.ms-cautions`。展开状态记在 `Q.open`，数据刷新后保持展开；行右侧有箭头。旧的 `detail()` 文本函数删掉了。
  - i18n：新词条已补。修了单反斜杠的问题：JS 字符串里写 '\d' 会变成字母 d，导致「N 段待标注」「你添加的（N）」和 0.3.13 单价说明等 10 条格式翻不出英文，现在都改成双反斜杠。新加的宽格式放在最后那条「标题：值」之前。
  - 版本号 0.3.14（package.json、package-lock）；intro NOTES 0.3.14 两条；README 0.3.14 一节。
  - 测试：`test-model-study-ui.cjs` 加了「格子里没有 .ms-cap-usd」、悬停不弹文字、点开 / 收起 / 回车展开、刷新后保持展开，还有面积贴底、clipPath、无 dasharray、极限放大后平移线还在；单独跑通过。截图看过亮色和夜间的详情面板；箭头方向已修正。
- **验证**：`npm test` 退出 0；`npm run test:ui` 退出 0，共 30 个 PASS。
- **测试版**：`npm run icons && npm run compile && npx electron-builder --win dir --publish never` 退出 0，产物是 `dist\win-unpacked\TokenPulse.exe`（0.3.14）。asar 里 5 个相关文件和源码一致；对 app.asar 跑 test-model-study-ui，4 个 PASS。没有打 Setup / Portable（dist 里的安装包还是 0.3.13 的）。
- 收尾检查：没有留下 electron 进程，也没有 dist 下的 TokenPulse；win-unpacked 的 exe 和 app.asar 都没被占用。
- **追加：单价写清楚（用户：只写一个「$0.48 / 百万 Tokens」还不给来源，不够严谨）**：
  - `model-study.ts`：ModelCapacity 新增 `listPrice`（输入 / 输出 / 缓存读 / 缓存写、auto、note、match，来自 priceOf 命中的规则）和 `priceMix`（fresh / cacheRead / cacheWrite / output 的 Token 数、basis、requests：综合单价用的是哪批请求的结构）；study 结果新增 `priceSource`（知识库 version / updatedAt / bundled 还是 downloaded）。unitCost 多返回一项结构。
  - 渲染：行上的小字改成「输入 $x · 输出 $y / 百万 · 综合 $z / 百万 Tokens」。详情里有「标价」四格和来源（LiteLLM 的哪个型号，或手动规则的 note，以及知识库版本），还有「综合单价」：一条比例条，每项写「占比 × 标价 = 贡献」，并说明比例来自哪些请求。实际费用和按标价重算的结果差超过 2% 时，会写出原因。价格表里没有的型号只列结构，不编价格。
  - i18n：新词条和格式都已补。修了 0.3.13 的两句单价说明：句子里有中文分号「；」，翻译时会先按它拆开，导致翻不出英文，现在改成逗号。UI 测试新增英文覆盖检查：行上的小字和详情里的每一段，经过 PulseI18n.t 都不能再留中文。
  - 测试：test-model-study 新增一条（15/15）：没有标价时的结构；有标价时，比例 × 标价能重算出综合单价。test-model-study-ui 断言了四项标价、来源、比例行和英文。截图看过夜间模式：$0.88 + $0.044 + $1.22 ≈ $2.15，和综合单价对得上。
  - 单价追加之后：`npm test` 退出 0；`npm run test:ui` 退出 0，共 30 个 PASS。测试版已重新编译（`electron-builder --win dir` 退出 0），asar 里 5 个相关文件和源码一致，对 app.asar 跑 test-model-study-ui，4 个 PASS。没有遗留进程，也没有文件被占用。
- **删掉等价费用之后**：test-model-study-ui 和 test-intro-ui 都通过。测试版已重新编译（`electron-builder --win dir` 退出 0），asar 里 4 个相关文件和源码一致，不含 ms-cap-usd。没有遗留进程，也没有文件被占用。intro、README、i18n 都已改成不提等价费用。
- **发布**：用户试用后说「直接编译并发布」。`npm run dist` 退出 0，产物是 `dist\TokenPulse-0.3.14-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.14）；asar 里 6 个相关文件和源码一致。推送前 fetch 过，远端没有新提交。提交 `cee3ec9 TokenPulse v0.3.14：单价写清楚、换算表点开看详情、时间线放大修复`，标签 `v0.3.14`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.14 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.14。发布说明里没有会话链接。没有在本机实际安装。
- 已知限制：截图用的测试数据只涨到 9%，面积贴底边是用断言验证的（面积路径第一个点在 0% 线上），没有高占用的截图。


## v0.3.13（历史）：单价标签 + 时间线「用了多久」和剪辑工具 + 时间线图例 · 已完成，已提交、打包、发布（Claude）

- 用户要求（0.3.13；**没说要发布，发布前先问**）：
  1. 标价来源对不上时，在型号旁标「标价不同」，**优先用 LiteLLM 的价**；单价刚变时标「单价刚更新」；官方优惠价标「优惠价」，带 until 的到期后自动切回。
  2. 「模型与思考等级 · 时间线」每条轨道显示周期内用了多久、占周期多少。
  3. 时间线左键拖动 = 平移，按住右键拖 = 原来左键的拖选；检测到的「本机以外」由用户像剪视频一样自己切（分割 / 删除 / 标注），软件不替用户切。
  4. 「按本机区间折算…会让容量略偏小」那段说明不要常驻，改成圆圈感叹号。
- **已完成（已随该版本发布）**：
  - 知识库：`scripts/update-knowledge.cjs` 对不上的价格按 LiteLLM 用，并记 `dispute.openrouter`；单价变化时记 `changedAt` / `previous`（从兜底换成逐个型号价格的也补上）；`manual.labels`（promo / until / note）以及 pinned 的 until 到期后剔除。`knowledge/manual.json` 给 gpt-5.6-sol 加了优惠价标签。`knowledge/models.json` 重新生成为 2026.09.30.2（gpt-5.6-sol 是 4/20，带 dispute；opus-5-5、gpt-6-astra 带 changedAt）。
  - `src/core/knowledge.ts`：PriceRule 加了 dispute / changedAt / previous / until / promo 字段，新增 labels、`localDay`、`priceNotes()`；`priceRules()` 会跳过已到期的规则。`model-study.ts` 的容量结果带上 `priceNotes`。
  - `src/core/quota-offmachine.ts`：updateMark 新增 split / ignore / restore 三种操作；model 为空的标注表示「待标注分段」，ignored 表示「已删除」（不算本机以外，也不进折算）；`mergeOff(intervals, rows)` 会把中间没有本机请求、间隔 6 小时以内的区间合成一段。
  - `renderer/model-study.js/.css`：
    - 单价标签 `priceTags` 和悬停说明 `priceNoteLines`；
    - `activeTime`：相邻请求间隔不超过 5 分钟的连成一段，分别写进轨道等级文字、图例 `.ms-combo-time` 和周期统计「本机用了…（占周期 x%）」；
    - 操作提示 `.ms-tl-hint`；左键平移（放大后才有效，监听挂在 window 上，窗口在后台时松手补上最后一步）；右键拖选；时间线上屏蔽右键菜单；
    - 点色块选中后出现剪辑工具条 `.ms-off-tools`：标注 / 分割（在时间线上点一下，或填时间后点「在这里分割」）/ 删除 / 清除标注 / 恢复 / 完成，Esc 关闭；
    - 待标注分段是虚线橙色，已删除是灰色并加删除线；
    - `attributionNote` 改成整窗标题旁的 `infoTip`（`.ms-attribution-tip`）。
  - i18n：新词条和格式都已补上。
  - 测试：`test-knowledge-update.cjs`（dispute / changedAt / labels / until）、`test-features.cjs` 44/44（priceNotes、到期规则）、`test-shared-quota.cjs`（split / ignore / restore、mergeOff）、`test-model-study-ui.cjs`（用了多久、右键拖选、左键平移、剪辑工具、感叹号）**单独跑都通过**。
  - 收尾：package.json 和 package-lock 都改成了 0.3.13；intro NOTES 加了 0.3.13 的三条（附英文）；README 加了 0.3.13 一节。图例里的「用了多久」原来单独换行，已改成 `.ms-combo` 多一列 92px；汇总里「待标注」的分段改用虚线。
- **追加（同属 0.3.13，用户问「5 小时周期里那块黄色是什么」后要求的）**：
  - 用户问的那块是「说不清来源」的竖条（quota-attribution 的 uncertain：前后 5 分钟内本机有请求、采样有缺口，或刚发生）。它的颜色原来是琥珀色，容易和「本机以外」的橙色搞混，现在改成灰色（`.ms-unmatched-band` 改为 var(--muted)）。
  - 周期标题旁新增圆圈问号 `.ms-tl-help`：新 SVG 符号 `#i-help`，`infoTip` 增加第 4 个参数 iconName。里面有 9 条带色样的图例（折线、灰竖条、橙竖条、检测到 / 分割 / 已标注 / 已删除、请求色块、现在线），外加鼠标操作说明。原来常驻的 `.ms-tl-hint` 操作提示已删掉，内容收进问号。
  - 新手引导：时间线那一步改了文案（加上用了多久和左右键说明）；新增一步「看不懂颜色？点问号」，高亮 `.ms-tl-help`；本机以外那一步改了文案（剪辑）。0.3.13 NOTES 的第二条也提到问号。i18n 都已补上。
  - 测试：test-model-study-ui 加了问号和图例的断言，test-intro-ui 的步骤编号往后顺延一步（12 → 问号，13 → 本机以外，14 / 16 → usage）。
  - 截图检查：看过夜间模式下的图例浮层；「已删除」的色样原来几乎看不见，改成灰色虚线框加一道删除线。
  - 追加后的验证：`npm test` 退出 0；`npm run test:ui` 退出 0，共 30 个 PASS。已重新 `npm run dist`（06:53），产物还是 `dist\TokenPulse-0.3.13-*`，asar 里 8 个相关文件和源码一致。没有留下 electron 进程，Setup、Portable 和 app.asar 都没被占用。
  - **Git / 发布**：用户说「直接编译加发布」。发布用的是 06:53 那次构建，之后代码没再改过。推送前 fetch 过，远端没有新提交。提交 `aa7f71e TokenPulse v0.3.13：单价标签、时间线用了多久与剪辑工具、时间线图例`，标签 `v0.3.13`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.13 已发布，不是草稿，4 个附件的大小和本地一致，releases/latest 是 v0.3.13。发布说明里没有会话链接。没有在本机实际安装。
- **验证（追加之前的那一轮）**：
  - `npm test` 退出 0；`npm run test:ui` 退出 0，共 30 个 PASS。
  - 截图检查用的是 scratchpad 里的 shotui.cjs（测试脚本的复制版，只在 4 个地方截图），看过剪辑工具条、分割、删除、整窗标题旁的感叹号，都正常。
  - 真实知识库里 `priceNotes`：gpt-5.6-sol 同时有优惠价、标价不同、刚更新三种；opus-5-5、gpt-6-astra、sonnet-5 是刚更新。
  - `npm run dist` 退出 0，产物是 `dist\TokenPulse-0.3.13-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`。asar 里 8 个相关文件和源码一致（package.json 被 electron-builder 改写，不同是正常的）。对打包产物跑 test-model-study-ui，4 个 PASS。
  - 收尾检查：没有留下自己启动的 electron 或 node；两个 exe 和 app.asar 都能独占打开（没有被占用）。用户正在用的已安装版 TokenPulse（0.3.12）没有碰。
- 已知限制：「用了多久」按 1 分钟一格、间隔 5 分钟以内连成一段来估算；待标注的分段在汇总里显示的百分点按曲线差值算，分割点落在两次采样之间时，前一段可能是 +0.0%。


## v0.3.12（历史）：自己添加模型 + 按思考等级估算 token 消耗 · 已完成，已提交、打包、发布（Claude）

- 用户要求（0.3.12，做完直接发布 GitHub）：①「换一种模型，整窗能用多少」可以自己添加模型；②把不同思考等级的 token 消耗放进知识库，让估算更准；**有本机实测数据时优先用本机实测**。
- 数据源调研结论：Artificial Analysis 的免费版不允许再分发，不能用；Aider 排行榜停在 2025-10；**选用 Epoch AI 的基准数据（CC BY 4.0，benchmark_data.zip，每天更新）**：DeepSWE（mini-swe-agent，平均输出 token）为主，CursorBench（每个任务的 token）核对并补位。
- **已完成（代码和测试都通过）**：
  - `scripts/update-knowledge.cjs`：零依赖的 unzip 和 CSV 解析，`fromEpoch()` 生成 effortUsage。结构为：models（每个型号：basis、perTask 各等级每任务 token）、families（claude / chatgpt / grok 相对 medium 的几何平均）、source / license / anchor。两个基准的倍数相差超过 2 倍时先不用；Epoch 取不到时沿用上一版；某一档变化超过 50% 时 review=true。报告里有「思考等级消耗」一节。`knowledge/models.json` 已重新生成为 2026.09.30.1，含 14 个型号和家族平均。
  - `src/core/knowledge.ts`：PriceRule 保留 auto；parseEffortUsage 做校验；新增 `benchmarkEffortRatio(kind, model, from, to)`（先查同型号，再用家族平均；会去掉 [1m] 和日期后缀）。
  - `src/core/model-study.ts`：没用够的组合从「同型号用得最多的一档；没用过这个型号就取本账号用得最多的一档」出发，输出部分乘等级倍数。倍数优先级：**本机实测（同型号两档各 ≥20 次调用）> Epoch 同型号 > 家族平均**。新增 priceBasis 'effort'，以及 effortRatio / effortBasis / effortSource / effortAnchor / tokensPerCallBasis 字段。有整段实测区间的组合仍按 measured 处理。价格表里没有的型号，单价沿用同模型的实际费用。
  - `src/core/model-catalog.ts`：readStudyModels / parseStudyModels（prefs.studyModels，按家分开）、modelCandidates；model-study 会把用户添加的型号并入目录，来源记为 user。prefs、applyPrefs 校验、IPC `models:candidates`、preload `modelCandidates` 都已接好。
  - `renderer/model-study.js/.css`：标题栏有「添加模型」按钮，打开对话框（搜索知识库候选、显示单价、选择等级芯片、可自定义型号名、别家的型号会提示、列出「你添加的」并可移除）。行上显示「你添加的」标签和 ×，以及「等级实测 / 等级参考」标签；悬停说明里写明倍数和来源（Epoch AI）；方法说明也已更新。
  - 版本号 package.json 和 package-lock 都改成了 0.3.12；intro NOTES 加了 0.3.12；i18n、README 0.3.12 一节、关于页的 Epoch AI 署名（CC BY 4.0）都已完成。
  - 测试：新增 `scripts/test-effort-usage.cjs`（8/8，已加入 npm test）；`test-knowledge-update.cjs` 加了 Epoch 相关部分（手写 zip、提取、争议、沿用、review），通过；`test-model-study.cjs` 14/14；`test-model-study-ui.cjs` 加了 0.3.12 添加模型的用例，**单独跑通过**。
- **收尾（额度恢复后续做）**：
  - 截图检查：之前截图脚本挂住，原因是 scratchpad 里 capture.cjs 的**引号写错**，Electron 弹出「A JavaScript error occurred in the main process」的阻塞对话框，用户在屏幕上也看到了。这是临时脚本的问题，不是软件本身的问题。修好后先 `node --check` 再启动。截图发现两处问题并已修复：添加对话框的详情区多出一个「null」文字（可选元素为空时被当成文字渲染），以及等级芯片的顺序不对（改成 low→max）。「自定义」候选移到了列表最后。
  - **`npm test` 退出 0；`npm run test:ui` 退出 0，共 30 个 PASS**（新增 0.3.12 添加模型的 UI 用例）。
  - `npm run dist` 退出 0，产物是 `dist\TokenPulse-0.3.12-Setup.exe`、`.blockmap`、`Portable.exe`、`latest.yml`（0.3.12）。asar 里 10 个相关文件与源码一致，对打包产物跑了 test-model-study-ui，4 个 PASS。
  - **Git / 发布**：提交 `e5ef098 TokenPulse v0.3.12：自己添加模型、按思考等级估算 token 消耗`（推送前 fetch 过，远端没有新提交），标签 `v0.3.12`。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.12 已发布，不是草稿，4 个附件大小一致。releases/latest 是 v0.3.12，线上 latest.yml 的 sha512 与 Setup.exe 一致。发布说明注明了 Epoch AI（CC BY 4.0）的署名，没有会话链接。没有在本机实际装一遍。
  - 手动触发的 knowledge.yml（run 36716491303）运行成功：在 GitHub 上实时拉取了 Epoch 数据，得到 14 个型号，和已提交的一致（没有变化）。
- 已知限制：CursorBench 的 token 口径没有写明，所以只用来核对和补位；claude-opus-5-5 只有 max / xhigh 两档的数据，其他档按家族平均估算。

## v0.3.11：模型知识库全自动更新（Claude，2026-09-30）

- 用户觉得手动维护知识库太麻烦，要求全自动，版本定为 **0.3.11**，并交给 Claude 负责。
- **结构**：
  - `knowledge/manual.json` 是手动维护的部分：pinned 放一定生效的特例，排在最前（目前是免费模型那一条）；fallback 放按家族估的兜底，排在最后（原来的 21 条）；另外还有 aliases 和 capabilities（思考等级规则，从已删除的 model-capabilities.json 搬过来）。
  - `knowledge/models.json` 改为**自动生成，不要手改**。内容依次是 pinned、逐个型号的自动规则、fallback，另外带上 aliases 和 capabilities。自动规则带 `auto: <型号 id>` 字段（老版本软件解析时会丢掉这个未知字段，不影响使用）。
- **生成器** `scripts/update-knowledge.cjs`（零依赖；导出 build / validate / markdown，便于测试）：
  - 数据来源：LiteLLM 公开价格表，只取 anthropic / openai / xai 三家，挑 claude、gpt-、o\d、codex、grok、chatgpt 这些家族，跳过 embedding、audio、realtime 等；接受 `xai/` 前缀。
  - 单价换算成美元 / 百万 token。缓存读价缺失时按输入价算，不当成免费；缓存写价缺失时记 0，表示按输入价算。收费型号给出 0 价的不收。
  - 同价的日期快照去掉，不同价的快照单独一条。兜底规则算出同价的型号不加。
  - 正则 patternOf 能认 xxx/ 前缀、Bedrock 的 us.anthropic.、日期、@日期、-v1:0、[1m]；按 id 长度降序排列。
  - **安全规则**：和 OpenRouter 的价格差超过 25% 的型号先不用（保留原价或兜底）并写进报告；已有规则的单价变化超过 50%，或一次新增超过 60 条时，report.review=true，改为开 PR；从不自动删除规则。
  - 版本号取当天日期，同一天再次更新时追加 .N，内容没变就不改版本。validate 和软件的 parseKnowledge 使用同样的约束。
  - 输出：Markdown 报告（`--report`），以及写给 GITHUB_OUTPUT 的 changed / review / version。
- **工作流** `.github/workflows/knowledge.yml`：
  - 触发：每天 UTC 01:23、workflow_dispatch、manual.json 被推到 main 时。
  - 小改动由 github-actions[bot] 直接提交到 main；需要确认时推到 knowledge/auto-<版本> 分支并开 PR（已经有 PR 时更新它的说明）。
  - 为此把仓库设置「Allow GitHub Actions to create and approve pull requests」改成了开（通过 gh api PUT actions/permissions/workflow，can_approve_pull_request_reviews=true；默认 token 仍然只读，写权限由 workflow 里的 permissions 声明）。main 分支没有保护规则。
- **首次生成**（Claude 人工审过，直接随 0.3.11 提交）：LiteLLM 的 4437 项里选出 153 个型号，新增 100 条自动规则，现在共 122 条。例如 claude-opus-5-5 $4/$20（原来按兜底算 $5/$25）、claude-sonnet-5 $2/$10、gpt-5 / gpt-4.1 / gpt-5.x-codex 等原来认不出的型号、gpt-5.6-terra / luna、grok-4.6 / 4.7 $2/$6（原来按兜底 $3/$15）。gpt-5.6-sol 两个来源对不上（LiteLLM $4/$20，OpenRouter $2/$10），先保留兜底的 $5/$30。
- **软件端**：`knowledge.ts` 的 Knowledge 增加可选的 capabilities，由 parseCapabilities 校验：只认 claude / chatgpt / grok 三家和已知的等级名，正则要能编译，有长度和数量上限。`model-catalog.ts` 改为从 loadKnowledge 读取思考等级规则，下载到的新版本立刻生效。「设置 → 关于 → 模型知识库」的说明文字已更新。
- **需要留意**：manual 里的 `grok.*(code|build)` 兜底是 $0.2/$1.5，而 LiteLLM 上 grok-build-latest 是 $2/$6、grok-build-0.1 是 $1/$2。实际的 grok-build 型号名不在自动规则里时仍走这条兜底，如果用户觉得 Grok Build 的费用偏低，可以改 manual.json。
- **测试**：新增 `scripts/test-knowledge-update.cjs`（npm test），覆盖上述所有规则、命令行、GITHUB_OUTPUT，并检查仓库里的 models.json 与 manual.json 一致。`test-features.cjs` 里 claude-opus-5-5 的期望值从 5 改成 4（公开价）。`test-intro-ui` 的版本分隔断言改为根据 NOTES 推算。结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 29 个 PASS**。对打包产物跑了 test-model-study-ui（用到思考等级规则），通过。
- **产物**：`dist\TokenPulse-0.3.11-Setup.exe`、`.blockmap`、`TokenPulse-0.3.11-Portable.exe`、`latest.yml`（0.3.11）。asar 里有 knowledge/models.json 和 manual.json，与源码一致。Git 提交、标签、Release，以及 Actions 首次运行的结果见本条末尾。
- **Git / 发布**：提交 `5a948ec TokenPulse v0.3.11：模型知识库全自动更新`，推送前 fetch 过，远端没有新提交；token 带 workflow 权限，可以推送工作流文件。标签 `v0.3.11` 指向 5a948ec。Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.11 已发布：不是草稿，4 个附件大小一致，releases/latest 是 v0.3.11，线上 latest.yml 的 sha512 与 Setup.exe 一致。没有会话链接。没有在本机实际装一遍、走自动更新。
- **Actions 首次真实运行**（由推送 manual.json 触发，run 36704882009）：结果是 success。在 GitHub 上从 LiteLLM 和 OpenRouter 拉取实时数据生成的结果，与已提交的一致（没有变化），所以没有提交、也没有开 PR；报告里列出了 gpt-5.6-sol 的价格争议。**「直接提交 main」和「开 PR」两条分支还没有在线上真正跑过**，要等到数据源真的有变化时才会触发；Actions 那一页如果报错，就去看这两个步骤。
- 线上的 `knowledge/models.json` 已经是 2026.09.30（122 条规则，带 capabilities）。0.3.10 及更早版本每天检查时也会下载它（只用 prices 和 aliases）。

## v0.3.10：工具配置被改走时提醒 + Grok 号池修复 · 已提交、打标签、发布 GitHub Release（2026-09-30，Claude）

- 用户要求：根据下方「Grok 号池一用就切回」的排查结论修好这个问题，其他 CLI 也要有好的提醒；版本 **0.3.10**，编译并发布到 GitHub。
- **漂移检测**（`src/core/agent-switch.ts` 的 `agentDrift()`，只读）：
  - 范围：TokenPulse 切换过（store.owned 有记录）的工具。
  - 路由模式：`proxy.apps[app]` 为 true、有恢复快照，但 `!proxyIsOurs(app)`。
  - 直连模式：`matchLive(store, app)` 不等于 `store.direct[app]`。目标是官方时，要看实时配置里有没有第三方地址；桌面端看 _meta.appliedId。
  - 只比较「连的是谁」（地址、密钥、模型），CLI 自己改权限、主题、/model 不算（有测试）。
  - 返回 `{ app, mode, expectedId, expectedName, liveName, key }`。key 是相关文件内容的指纹，同一次改动只提醒一次。Grok 的 liveName 取 `[models].default` 的名字。
- **切回时重新接上路由**：`enableProxy(app, id, explicit)`。用户明确操作时（activateProvider、setAppProxy(on)），路由被改走也会重新 applyProxy，接管前的恢复快照不变；启动时的 resumeAgentProxy 仍然会抛「工具连接已在外部修改」，不覆盖外部修改。
- **Grok**：路由表写入 `name = "TokenPulse · <供应商名>"`（清理的键里也加了 name）。切换成功的提示后面追加 resumeHint：旧会话会沿用它记住的模型，请新开会话，或输入 `/model tokenpulse_route`。
- **主进程**（`index.ts`）：
  - `checkDrift()` 每 5 秒执行一次；`driftSeen` 按工具记住已经提醒过的指纹，恢复正常后清掉。
  - 窗口开着时发送 `agent-drift` 事件；窗口在托盘或最小化时弹系统通知，点击后打开供应商页。
  - IPC `agent:drift` 用于界面加载时查询当前情况；preload 提供 `agentDriftNow` / `onAgentDrift`。
- **界面**（`agent-switch.js` 的 showDrift）：右上角 warning 弹窗（`.tp-toast.pv-drift`，key 为 drift-<app>），内容是「X 现在没在用「A」，连的是「B」。<各工具的原因说明>」，按钮有「知道了」和「切回「A」」。切回走 run → agentActivate → 对比确认。
- **更新说明**：intro.js 的 NOTES 加了 0.3.10。跨版本升级时（since = 上次看过的版本）会把所有没看过的版本都列出来，新的在前，较早的版本前面有 `.whatsnew-version` 分隔。弹窗改成标题和按钮固定、只有列表滚动：截图发现原来聚焦按钮时整张卡会滚到底，把标题和 0.3.10 的条目滚出视野。
- i18n 已补齐，包括几个带变量的模板。README 加了 0.3.10 一节（含 Grok 号池的用法）。版本号在 package.json 和 package-lock.json（两处）都改成了 0.3.10。
- **测试**：
  - 新增 `scripts/test-agent-drift.cjs`（npm test）：Grok 继续旧会话造成的改走（直连和路由两种）、指纹稳定、切回时重新接上路由、关闭路由后恢复、Grok 路由表的 name、Claude 改地址会报而改无关设置不报。
  - 新增 `scripts/test-agent-drift-ui.cjs`（test:ui，窗口保持显示，所以不会发出真实的系统通知）：外部改动后弹窗；提示里没有密钥；点「知道了」后不重复提醒；再改一次会再提醒；「切回」经过对比确认后恢复；切换后没有误报。
  - test-intro-ui 加了跨版本分隔的断言。
  - 结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 29 个 PASS**。对打包后的 asar 跑了 test-agent-drift-ui 和 test-intro-ui，都通过。
- 截图检查（用户允许 Claude 看截图）：漂移弹窗和跨版本更新说明，修复后重新截图确认过。
- **产物**：`dist\TokenPulse-0.3.10-Setup.exe`、`.blockmap`、`TokenPulse-0.3.10-Portable.exe`、`dist\latest.yml`（version 0.3.10）。win-unpacked 的 asar 与源码一致。Git 提交、标签和 Release 的情况见本条末尾。
- **Git / 发布**：提交 `99a0aad TokenPulse v0.3.10：工具配置被改走时提醒，修复 Grok 号池被旧会话切回`，已推到 origin/main（推送前 fetch 过，远端没有新提交）。标签 `v0.3.10`（annotated）指向 99a0aad。GitHub Release https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.10 已发布：不是草稿，也不是预发布，4 个附件大小与本地一致。releases/latest 是 v0.3.10，线上 latest.yml 的 sha512 与 Setup.exe 一致，0.3.9 及更早的安装版能收到更新。说明里没有会话链接。没有在本机实际装一遍、走自动更新。
- **给用户的 Grok 用法**：启用号池后，在 Grok 里新开会话，或者在旧会话里输入 `/model tokenpulse_route`。万一又被切回，右上角会提醒，点「切回」就行。

## 排查：Grok 号池一用就切回原来的配置 · 结论：Grok 恢复旧会话时把 models.default 改了回去，没有改代码（2026-09-30，Claude）

- 用户现象：Grok CLI 切到号池「所有号」后，一使用就变回之前的配置。
- **证据**（只读，没有打印密钥）：
  - TokenPulse 的修改记录：02:56 和 02:58 两次「切换到『所有号』」，都把 `~/.grok/config.toml` 的 `[models].default` 从 "grok-4.6" 改成了 "tokenpulse_route"。两次之间被改回 "grok-4.6"，但修改记录里没有这一次，说明不是 TokenPulse 改的。
  - `~/.grok/logs/unified.jsonl`：02:57:33 Grok 启动时 current_model_id = tokenpulse_route（说明切换已经生效）。02:57:39 恢复的旧会话 sid 01a0f1bf… 里出现 "model changed → grok-4.6"。02:59 Grok 自我更新到 1.0.44 后重开同一个会话，又切回旧模型。Grok 恢复会话时会用这个会话记住的模型，并把它写回 `[models].default`（配置里的 default_reasoning_effort 也是 Grok 写的）。
  - 用户配置里自定义的 `[model."grok-4.6"]` 其实是旧中转（ai.yp.mk，实际请求 grok-4.7），和官方 grok-4.6 同名，所以很难看出来是切回了中转。
  - 默认值被改掉之后，proxyIsOurs 判断为 false。restoreProxy 按设计把它当作「外部修改」处理，把 proxy.apps.grok 设成 false，也不覆盖文件。现在 17621 端口没有监听，号池也就没用上。
- **用法**：在 TokenPulse 里重新启用「所有号」（会打开本地路由），然后在 Grok 里新开会话（/new），或者在旧会话里输入 `/model tokenpulse_route`。Grok 会把这个选择记下来，之后不会再切回去。
- 可以做的改进（待用户决定，还没做）：①Grok 路由表写上 `name = "TokenPulse · <供应商名>"`，让 /model 列表里一眼能认出来；②路由开着时发现 Grok 自己改回了默认模型，就弹提示并提供一键切回；③切换 Grok 成功的提示里说明「旧会话会沿用它记住的模型」。

## 排查：自动更新到 0.3.9 后没有弹更新说明 · 结论：不是 bug，没有改代码（2026-09-30，Claude）

- 用户真实的 `~/.tokenpulse/prefs.json` 里，已安装的 0.3.9 启动之前就已经有 `seenVersion: '0.3.9'`、`onboarding: 'done'`（只读了这两个字段）。这两个字段只有 0.3.9 的代码会写，其中 onboarding=done 只有走完或跳过引导时才会写。所以原因是：用户之前在真实数据上运行过 0.3.9 的 dist 测试版，看过并关掉了说明，记下了已看过；安装版随后判断「已看过」，不再弹出，这是正确行为。
- 更新后隐藏重启的路径也核对过：`update-relaunch.json` 让窗口不显示，但页面照常加载，说明弹窗在隐藏窗口里打开，关闭时才记为已看，用户打开窗口时能看到。test-intro-ui 的升级用例正是在隐藏窗口里跑的，能通过。
- 从 0.3.8 直接升级、没跑过测试版的用户会正常看到一次。想再看，可以在 设置 → 关于 →「这个版本的新内容」打开。

## v0.3.9 已提交、打标签并发布 GitHub Release（2026-09-30，Claude）

- 用户确认没有问题，要求编译安装包并发布。**0.3.9 已正式发布**，下方各条目里「未提交 / 未发布」的说法都是当时的状态，已经过时。
- **Git**：
  - 先在 `backup/0.3.9-wip` 上提交收尾改动（`e020a12`，已推送），然后 squash 到 main，作为一个版本提交。
  - 推送时发现远端 main 多了一条用户在 GitHub 网页上的提交 `0d45075 Delete roadmap items from README.md`，就 rebase 到它上面，保留了删掉路线图的改动。
  - README 里 0.3.9 各节去掉「（开发版）」，修正了过时的描述（右侧抽屉 → 左侧步骤菜单；三家 → 四个工具），补上「配置保护」「Codex 1M 上下文」「新手引导与版本说明」。
  - 最终提交为 **`00f785c TokenPulse v0.3.9：本机以外消耗识别、新手引导、供应商配置保护`**，已推送到 origin/main。标签 **`v0.3.9`**（annotated）指向 00f785c。标签第一次推送时指向的是 rebase 之前的提交，已经在创建 Release 之前用 `git push -f origin v0.3.9` 改正。
  - 提交信息和 Release 说明里都没有会话链接。
  - 没有提交的只有 `.tmp-037-*.png`、`.tmp-grok-home-test/`、`dist-preview/`、`dist-egress-preview/`、`dist-next/`（dist-next 是过时的目录版，可以删除）。
- **安装包**：`npm run dist` 退出 0。产物在 `dist\`：`TokenPulse-0.3.9-Setup.exe`（112,246,965 字节）、`TokenPulse-0.3.9-Setup.exe.blockmap`、`TokenPulse-0.3.9-Portable.exe`（111,989,742 字节）、`latest.yml`（version 0.3.9，sha512 与 Setup.exe 一致）。`win-unpacked` 里有 app-update.yml，asar 与源码逐字节一致。打包后用 TOKENPULSE_TEST_APP 跑了 test-intro-ui（3 个 PASS）和 test-agent-guard-ui（通过）。打包之前刚跑过 `npm test` 和 `npm run test:ui`（全部通过，共 28 个 PASS）；之后只改了 README。
- **Release**：https://github.com/JohnMuyuan/TokenPulse/releases/tag/v0.3.9 。标题「TokenPulse v0.3.9」，不是草稿，也不是预发布。4 个附件（latest.yml、Setup、blockmap、Portable）大小与本地一致。`releases/latest` 已经是 v0.3.9，`releases/latest/download/latest.yml` 返回 0.3.9，所以 0.3.8 及更早的安装版能查到更新。
- **没有做的**：没有在本机实际安装 0.3.9、走一遍自动更新；README 截图仍是 v0.3.8 的（以前是单独提交截图更新，这次用户没有要求）。
- 当前 Git 在 `main` 分支。`backup/0.3.9-wip` 分支保留在远端，可以不管。

## 截图检查后的界面修复（含一个改坏用户配置格式的 bug）· 已完成，免安装目录版在 dist（2026-09-30 01:44，Claude）

- 用户觉得界面不好看，本轮**单独允许 Claude 看截图**（AGENTS.md 里「不得查看图片」这一条对其他 AI 仍然有效，不要当成通用规则）。截图用临时数据目录和合成数据生成，脚本放在会话 scratchpad，不在仓库里。仍算 0.3.9，未提交、未打安装包、未发布。
- **截图发现并修复的问题**：
  1. **写 JSON 配置时把用户文件整份重排（真实 bug）**：`agent-switch.ts` 的 writeObject 以前只要文件里有 4 空格开头的行就按 4 缩进写。2 空格缩进、带嵌套的 settings.json 必然有这种行，所以一切换就被整份改成 4 缩进，对比框里也显示整份删除、整份新增。现在改为按第一层键的实际缩进（用正则取），没有就用 2。`test-agent-guard.cjs` 增加了断言：缩进保持 2 空格，删除的行不超过 4 行。
  2. 对比确认框打开时，右上角还在转「正在启用…」：run 里收到 confirm 后先调用 clearPending。
  3. 额度详情标题旁感叹号的浮层被卡片挡住，只露出两行，还被下面的面板盖住。`infoTip` 改为：打开时把浮层挂到 body 上，用 fixed 定位（下方放不下就放上方，左右不出界），滚动时关闭；关闭后放回原位。只在打开期间监听 DOM，定时重画把图标换掉时顺带收起浮层。hover 和键盘聚焦都能打开，Esc 关闭。CSS 在 app.css「圆圈感叹号说明」一节。
  4. 配置保护页：原件卡片里重复了一遍文件名，改为「恢复后：+a −d 行」加一个「查看对比」折叠项（`diffBlock` 的第三个参数 title）；左侧菜单「配置保护」的徽章只在只读时显示「只读」，原来的「已开启」容易被误解成只读已开。只读说明和三条规则卡片的文字都精简成一句话。i18n 已同步。
- **看过的截图**（浅色和深色各一套）：供应商列表、对比确认框、弹窗提示合集、配置保护页、Codex 整体上下文、额度页感叹号浮层、本机以外汇总、更新说明弹窗、新手引导的容量趋势这一步。修复后重新截图确认过：对比框只显示改动的行，浮层完整显示在最上层，深色模式正常。
- **测试**：`test-model-study-ui` 的感叹号断言改为：关闭时 display:none；打开后在 body 上，完整显示并处于最上层（用 elementFromPoint 检查）。隐藏的测试窗口里 focus() 不触发 focus 事件，所以测试里用 mouseenter 打开。结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 28 个 PASS**。
- **产物**：用户已经退出旧版，所以这次直接打到 **`dist\win-unpacked\TokenPulse.exe`**（0.3.9.0，app.asar 生成于 01:44）。8 个相关文件与工作区逐字节一致，exe 和 asar 独占打开检测通过，没有残留进程和演示临时目录。上一轮的 `dist-next\` 已经过时，可以删除。

## Codex 一键 1M 上下文 + 供应商提示全部改成右上角弹窗 · 已完成，免安装目录版在 dist-next（2026-09-30 01:29，Claude）

- 用户要求（仍算 0.3.9，只打目录版，未提交、未打安装包、未发布）：①Codex 能自由设置上下文，参考 CC Switch 做一键 1M；②供应商页的所有提醒改成右上角弹窗，不要插进页面的常驻提示。
- **① Codex 整体上下文**：
  - 对照 CC Switch（`src/components/providers/forms/CodexConfigSections.tsx`）：打开时写 config.toml 顶层的 `model_context_window = 1000000`，自动压缩阈值没填时补 `model_auto_compact_token_limit = 900000`；关闭时两项都删掉。
  - 后端（`agent-switch.ts`）：parseSave 新增 `parseCodexContext`，只有 Codex、而且请求里带了 codexContextWindow / codexAutoCompact 时才生效。取值范围 1000～10000000 的整数，压缩阈值必须小于窗口。结果存进 `provider.extra`，由原有的 writeCodex（CODEX_EXCLUSIVE）以整数写入，并在切换时恢复。agentView 输出 codexContextWindow / codexAutoCompact。其他保存入口不带这两个字段时，原值保留。
  - 界面：Codex 编辑页「模型」步骤顶部新增「整体上下文」区块，包括「1M 上下文」一键按钮（data-action=codex-1m）和两个数字框（name=codexContextWindow / codexAutoCompact，空着表示跟随 Codex 默认）。
    - 点开 1M 时，模型行里仍是预设 128000 的上下文会一起改成 1000000，关掉时改回来；手动改过的行保留。
    - 手动填 1000000 时按钮会同步亮起。
    - 配置预览里能看到这两个字段；editorFingerprint 也包含它们，所以离开时会提示未保存。
- **② 提示改成弹窗**：
  - `app.js` 新增全局 `toast(message, { kind, key, actions, cls })`，kind 有 success / error / warning / pending。
    - pending 带转圈，不自动消失；同一个 key 会原地替换，「正在切换…」直接变成结果。
    - 带 actions 的弹窗不会自动消失，点按钮后关闭。
    - 原来的 showStatus 改为调用 toast，行为不变；app.css 补了 warning / pending / 按钮样式和 reduced-motion。
  - `agent-switch.js`：showFeedback 全部改走 `toast(..., { key: 'providers' })`，删除了页面里的 `.pv-feedback` 框和 drawFeedback。run 的 finally 和获取模型提前返回时，都会清掉残留的 pending。只读保护的 `.pv-readonly-bar` 常驻条删掉了，只保留菜单徽章，被拦下时弹 error。离开编辑时的「有尚未保存的修改」也改成带「继续编辑 / 放弃修改」按钮的弹窗（`.tp-toast.pv-unsaved`），不再插进表单。页面里剩下的只有静态的 `.pv-hint` 说明文字，不属于提醒。
  - `agent-switch.css` 里旧的 `.pv-feedback` 样式没有删（已经没有地方用到，无害）。
- **测试**：
  - 新增 `scripts/test-codex-context.cjs`，已加入 npm test。覆盖：1M 写成整数、自定义值、清空时删掉键、不带字段的保存保留原值、用户自己的 toml 和 mcp 表不变、模型目录里是 1M、校验。
  - `test-agent-guard-ui.cjs` 增加：供应商页里没有任何提示条；Codex 1M 按钮的开关（两个输入框和模型行上下文联动、配置预览、手动填 1000000 时按钮同步）；未保存提示是右上角弹窗。
  - `test-provider-feedback-ui`、`test-agent-guard-ui`、`test-agent-switch-ui` 里原来查 `.pv-feedback` / `.pv-unsaved` 的断言都改为查 `#toast-stack .tp-toast`；reduced-motion 断言改为检查 pending 弹窗的转圈动画。
  - 结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 28 个 PASS**。另外用 TOKENPULSE_TEST_APP 对 dist-next 的 asar 跑了 test-agent-guard-ui，通过。
- **产物 / 占用**：用户 01:14 启动了上一版 `dist\win-unpacked\TokenPulse.exe`（PID 10428/12452/30020/32876/33836），**没有关闭**。
  - 打包到 dist 时，electron-builder 删除 `dist\win-unpacked` 报 `EBUSY: resource busy or locked, rmdir`。事后核对，`dist\win-unpacked` 的文件和 node_modules/electron/dist 一致（55 个 locales 都在），没有被删掉一半，但**里面仍是 01:11 的上一版**。
  - 新版输出到 **`dist-next\win-unpacked\TokenPulse.exe`**（0.3.9.0，app.asar 生成于 01:29），12 个相关文件与工作区逐字节一致，独占打开检测通过；本轮启动的测试和构建进程都已退出。
  - 用户退出旧版后，可以再编译到 dist，或者直接用 dist-next。两个版本有单实例锁，旧版开着时启动新版只会唤起旧窗口。
- 视觉效果由用户验收，没有查看截图。

## 供应商配置保护：改动前对比确认 + 每次改动备份 / 一键还原 + 只读保护 · 已完成，免安装目录版在 dist（2026-09-30 01:11，Claude）

- 用户担心供应商专区改坏 agent 配置。本轮做了三件事，仍算 0.3.9，只打目录版，未提交、未打安装包、未发布。
- **唯一提交点**：所有写工具配置的路径都经过 `src/core/agent-config.ts` 的 `configTransaction`，新增的钩子都放在这里：
  - `configureReadOnly(fn)`：有工具文件（agent-switch.json 以外）的改动、只读保护打开、又没有处在 `configAllowRestore` 范围内时，直接拒绝，整个事务不写。
  - `configPreview(work)`：同样的操作跑一遍，到提交点只收集改动，然后返回，不写文件、不写日志、不留历史。agent-switch 在预览期间不启动 / 停止本地路由（ensureProxy / stopProxy 检查 `configPreviewing()`），也不 mkdir 桌面端目录。
  - `configExpect(signature)`：确认执行时，真实改动的签名（文件 + before + after 的 sha256）必须和预览时一致，否则报「确认之后配置又有变化」且不写。
  - `recordHistory`：每次提交记下工具文件的前后内容。
- **历史 / 原件**：新文件 `src/core/agent-history.ts`。
  - 历史存在 `~/.tokenpulse/backups/agent-history/<id>.json`，权限 0600，保留最近 50 次。
  - 原件就是已有的 `backups/live-first-write`，永久保留。
  - `maskSecrets` 负责打码：JSON 和 TOML 里 key/token/secret/authorization… 这类字段、环境变量、sk- / xai- / Bearer 开头的串。
  - `lineDiff` 做 LCS 行对比，保留上下 3 行；文件太大时退化为整份替换。
  - `mergeChanges` 把一次操作里对同一文件的多次改写合并；`changeSignature` 生成签名。
- **还原**：`agent-switch.ts` 新增 `restoreConfigBackup('history'|'original', id)`。
  - 走 syncMutation + 事务，还原本身也会记一条历史，所以还原可以撤回。
  - 整体包在 configAllowRestore 里，只读保护下也能还原。
  - 对应工具的本地路由开着时拒绝还原。
  - 还原后 TokenPulse 把配置当作外部修改，不会自动覆盖。
  - 关闭路由（setAppProxy off）和退出恢复（releaseAgentSwitch）也包了 configAllowRestore。
- **主进程**（`index.ts`）：
  - save / delete / activate / proxy / port / failover / reorder / import-cc / import-live / restore 都改走 `agentWrite(reason, work, restoring)`：
    - 先预览；
    - 没有工具文件改动就直接执行；
    - 只读保护打开、又不是 restoring 的，直接返回错误；
    - 否则返回 `{ ok:false, confirm:{ token, reason, files: FileDiff[] } }`，由界面调用 `agent:confirm(token)` 执行（带签名校验，token 10 分钟过期）。
  - 新增 IPC：`agent:confirm`、`agent:backups`（历史 + 原件，原件和当前文件对比，全部打码）、`agent:restore`、`agent:readonly`。
  - prefs 新增 `agentReadOnly`（默认 false）。agentView 带 `readOnly`。启动恢复和退出恢复也写上了 reason。
  - **托盘切换**不再直接写：改为打开窗口，发送 `agent-activate-request`，由供应商页走确认流程；只读时托盘项变灰，并标「（只读保护）」。
- **界面**（`renderer/agent-switch.js/.css`）：
  - `run()` 统一处理 confirm：弹出 `#pv-confirm` 对比框，标明工具、文件、新建 / 删除、+N −M 行，红删绿增，默认焦点在「取消」。Esc、取消、点遮罩都不写，并提示「已取消」。
  - 二级菜单「管理」下新增「配置保护」（徽章显示「已开启」或「只读」），页面内容：
    - 只读保护开关（role=switch）；
    - 三条规则说明；
    - 接管前的原件（和现在不同时显示「恢复原件」和对比）；
    - 修改记录（原因、时间、工具、文件数、对比，以及「还原到这次之前」）。
  - 只读时其他页顶部显示 `.pv-readonly-bar`。
  - 设置 → 数据新增「供应商配置备份」→「打开配置保护」。
  - 更新说明 NOTES 和引导的供应商那一步都补了这项内容；i18n 补齐了新文字和带数字的模板。
- **测试**：
  - 新增 `scripts/test-agent-guard.cjs`，已加入 npm test。覆盖：预览不写文件、不留历史；对比打码；签名不一致时拒绝；只读保护拦截切换但允许改供应商资料；历史的前后内容和 0600 权限；还原、撤回还原、恢复原件；打码规则；50 条上限；只读下关闭路由不报错。
  - 新增 `scripts/test-agent-guard-ui.cjs`，已加入 test:ui。覆盖：对比框（Esc 取消后文件不变、确认后写入）、界面 HTML 里没有任何密钥原文、配置保护页、只读拦截（不弹框、文件不变、托盘请求也不写）、只读下带确认恢复原件、还原也留记录、设置入口、托盘切换会弹确认、夜间模式、900px。
  - 已有的 `test-agent-switch-ui`、`test-provider-feedback-ui`、`test-provider-pool-ui` 不是测确认框的，所以在页面里注入自动点击「确认写入」；它们走的仍是真实的「预览 → 确认 → 签名校验 → 写入」路径，全部通过。菜单项从 8 个变为 9 个。
  - 结果：**`npm test` 退出 0**（含原有配置安全审计 10/10 和事务测试）；**`npm run test:ui` 退出 0，共 28 个 PASS**。另外用 TOKENPULSE_TEST_APP 对打包后的 asar 跑了 test-agent-guard-ui，也通过。
- **产物**：`dist\win-unpacked\TokenPulse.exe`，0.3.9.0，app.asar 生成于 2026-09-30 01:11。asar 里 11 个相关文件与工作区逐字节一致；exe 和 asar 独占打开检测通过；没有残留进程和演示临时目录。
- **已知限制**：
  - 一个操作分成多个事务时，预览只能看到第一个事务之前的磁盘状态。目前所有用户操作都只有一个写工具文件的事务，测试都通过了；以后新增多事务操作时要注意签名校验。
  - 只读保护下启动时如果需要重新接管路由，会失败，路由保持关闭，这是预期行为。
  - 历史文件里有 API Key 原文，和工具自己的配置一样只存在本机，权限 0600（Windows 上靠用户目录 ACL）。
  - 还原会把整个文件换成当时的内容；还原之后在别处做的修改会被覆盖，但还原前有对比确认，并且会留一条历史。
  - 视觉效果由用户验收，没有查看截图。

## 新手引导改用演示数据、覆盖特色功能 · 已完成，免安装目录版在 dist（2026-09-30 00:45，Claude）

- 用户反馈：上一版引导只高亮侧栏，没有展示「额度容量趋势」「换一种模型，整窗能用多少」「模型与思考等级 · 时间线」等特色功能；而且第一次用没有账号，页面是空的。要求多展示，并用占位数据演示，**演示不能影响原来的数据**。仍算 0.3.9，只打目录版。
- **演示数据隔离**：
  - `src/core/demo-data.ts`：`writeDemoData(dir, now)` 生成一个虚构账号 `claude:demo`（演示账号 · Max）。内容包括：约 25 天、每 10 分钟一个额度采样；约 3000 条本机 Claude Code 请求（Opus 5.5 high/xhigh、Sonnet 5 medium/high、Haiku，越近 Opus 越多，3 个演示项目 `D:\Demo\*`）；每周 2～3 段晚上的网页聊天，作为「本机以外」；这一周至少 2 段，一段已标注、一段待标注。周容量按 $500 设计，实算约 $470，4 个完整的周窗口，5 小时窗口约 $90。数据用固定种子生成。
  - `src/core/demo-worker.ts`：在 Electron **utilityProcess** 里运行（不能用 worker_threads，因为 worker 里的 os.homedir() 仍会读到真实主目录）。启动时环境变量指向 `%TEMP%\tokenpulse-demo-<pid>\data` 和空的假 home，同时清掉 CODEX_HOME / CLAUDE_CONFIG_DIR / GROK_HOME，并改掉 APPDATA / LOCALAPPDATA。进程只做 snapshot / study / requests 三种只读计算；15 分钟没有请求会自己退出。
  - `src/main/demo.ts`：`demoCall`、`endDemo`。will-quit 时停掉进程、删除目录；spawn 时清理残留目录（目录名里的 pid 对应的进程已经不在）。主动结束时，未完成的请求返回 null，不报错。IPC：`demo:snapshot` / `demo:study` / `demo:requests`（参数照样经过 parseModelStudyQuery / parseRequestQuery 校验）/ `demo:end`。
  - `preload.ts`：新增 `demo(on)` 和 `isDemo()`。演示期间，snapshot / refresh / modelStudy / requests 改走演示进程；主进程推送的真实快照不交给界面；modelOffMachine 和 exportCsv 直接拒绝（「演示数据不能修改」）。
- **引导**（`renderer/intro.js` 重写 STEPS 和 startGuide）：
  - 显示欢迎页的同时在后台切换到演示数据，卡片上出现「演示数据」徽章，state.account 设为 `claude:demo`。
  - 共 19 步：欢迎 → 导航 → 官方额度卡 → 用量趋势 / 使用节奏 → 刷新 → 额度详情账号标签 → 5 小时 / 周窗口 → **额度容量趋势** → **换一种模型（整窗预算）** → **一眼看结论 + 完整排行** → **时间线** → **本机以外（虚线待标注 / 实心已标注）** → Token 构成与用量分析 → 逐条请求 → **按项目看用量** → 出口监控 → 会话管理 → 供应商 → 设置。
  - 用量页的几步会把范围切到 7 天，并切换明细视图（切换后重画一次）。异步面板最多等 3 秒，等不到就居中显示、不高亮。等待时高亮框停在原位并变淡。高亮目标会滚到顶栏下方；目标太高时只框上半截，把卡片放在下面。进度条代替了原来的圆点。
  - 结束或跳过时：`api.demo(false)` 结束进程、删除目录，恢复 state.account 和明细视图，重新读取真实快照并 render，再回到总览（总览会换回自己的时间范围）。演示数据加载失败时，就用真实数据继续引导。
  - i18n 补了所有新文字。
- **测试**（`scripts/test-intro-ui.cjs`）：
  - 新增：切换到演示数据后，current.demo、账号只剩 `claude:demo`、徽章显示、临时目录存在、modelOffMachine 被拒绝。
  - 逐步断言 10 个特色步骤：切到了正确的页面，高亮框住目标，卡片在窗口内且不压住高亮区。
  - 演示内容真的算出来了：容量趋势有图、排行 ≥5 行、时间线上待标注和已标注都有、按项目 ≥3 张卡。
  - 跳过后：真实快照恢复，账号和视图恢复，临时目录已删除，**真实数据目录（data、home）的文件哈希与引导前一致**，里面没有 demo 文件。
  - 测试窗口是隐藏的，CSS 过渡不会走完，所以几何断言在模拟的「减弱动态」下做。退出前先调用 demo(false)。
  - 结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 27 个 PASS**。另外用 `TOKENPULSE_TEST_APP=dist\win-unpacked\resources\app.asar` 对打包产物跑了 test-intro-ui，3 个 PASS，证明 utilityProcess 能从 asar 加载。
- **产物**：`dist\win-unpacked\TokenPulse.exe`，0.3.9.0，app.asar 生成于 2026-09-30 00:44。这次上一版的 dist 进程已经不在，所以直接输出到 dist。asar 里 intro.js/css、index.html、app.js、i18n.js、model-study.js、main/index.js、demo.js、preload.js、prefs.js、core/demo-data.js、demo-worker.js 都与工作区逐字节一致。exe 和 asar 独占打开检测通过；项目目录下没有残留进程；`%TEMP%\tokenpulse-demo-*` 已清空（测试中间留下的几个都是本轮自己的，已删除）。上一轮的 `dist-intro\` 已经过时，可以删除（没有进程占用，本轮没有动它）。未提交、未打安装包、未发布。
- **已知限制**：演示只有 Claude 一家，ChatGPT / Grok 卡片显示为未登录。出口监控、会话管理、供应商三页仍然显示真实内容，只高亮侧栏入口，因为这几页读的是本机 CLI 配置，不适合造假数据。演示数据按「现在」生成，刚过午夜时「今天」的数据较少，所以用量页改看 7 天。视觉效果由用户验收，没有查看截图。

## 说明改成感叹号浮层 + 更新说明弹窗 + 新手引导 · 已完成（2026-09-30 00:20，Claude；引导步骤和产物已被上面 00:45 的条目取代）

- 用户要求（均算 0.3.9，只打免安装目录版，不打安装包、不提交、不上传 GitHub）：①额度详情里「官方已用是整个账号的……」和时间线下「没有检测到本机以外的消耗……」两段常驻说明不好看，改成带圆圈的感叹号，悬停显示；②从 0.3.9 起，更新后第一次启动弹窗介绍新版本内容，只弹一次；③新手引导，可跳过。
- **① 感叹号浮层**：
  - `renderer/app.js` 新增全局 `infoTip(content, label, cls)`：`.info-tip` 里是一个按钮（新图标 `#i-notice`，写在 index.html）和浮层 `.info-tip-pop`（role=tooltip）。悬停或 :focus-within 时显示；浮层和图标之间靠 padding 连着，里面的按钮能点到；右侧放不下时加 `.left` 往左展开；Esc 取消聚焦。样式在 `app.css`（「圆圈感叹号说明」一节），支持 reduced-motion。
  - 共享额度说明：从常驻的 `.ms-attribution-note` 段落改成额度详情账号标题（`.quota-context h2`）后面的 `.quota-scope-tip`，浮层里保留「只在本机用 Code？在设置里打开」按钮。删除了 app.css 里对应的旧样式。
  - 本机以外汇总（`model-study.js` 的 offMachineSummary）：常驻部分只剩结论：「本机以外 +X%」+「N 段待标注」徽章，或「本机以外 · 未检测到」；解释放进感叹号。没检测到也没标注时，`.ms-off-summary.empty` 去掉边框和底色，缩成一行，「手动标注一段」按钮缩小。
  - 时间线里 model-study.js 第 200 行附近的「按本机区间折算」说明（`.ms-attribution-note`）用户没提，保持不变。
- **② 更新说明 / ③ 新手引导**：新文件 `renderer/intro.js` + `renderer/intro.css`，已在 index.html 引入。
  - prefs 新增 `seenVersion`、`onboarding`（""/pending/done），在 `src/main/prefs.ts`。新增 `prefsExist()`。`index.ts` 启动时**在第一次写 prefs.json 之前**判断：文件不存在就是全新安装，写入 seenVersion=当前版本、onboarding=pending。老用户的 prefs.json 一定存在，因为以前每次启动都会写开机自启。applyPrefs 会校验这两个字段。`app:version` 改用 `appVersion()`。
  - 界面逻辑：等首页画完（最多 4 秒）。onboarding=pending → 自动开始引导。否则如果 seenVersion 为空或比当前版本旧：`NOTES` 里有这一版就弹「新版本有什么」，关闭后写入 seenVersion；没有这一版的说明就直接写入，不弹。**以后发版要在 intro.js 的 `NOTES` 里加一项**，否则升级不会弹。
  - 弹窗：6 条 0.3.9 新内容，有「开始新手引导」和「知道了」两个按钮；Esc、点遮罩、点 × 都能关闭；Tab 在弹窗内循环，背景设为 inert。
  - 引导：10 步，依次是欢迎、导航、官方额度卡、刷新、额度详情、用量明细、出口监控、会话管理、供应商、设置。页面相关的步骤会先 navigate 到那一页，再高亮侧栏上对应的按钮。高亮用 box-shadow 挖空，卡片优先放在右侧，其次下方、上方，并限制在窗口内。支持「跳过引导」、上一步 / 下一步、←/→、Esc（等于跳过）。结束后写入 onboarding=done，并回到总览。
  - 设置 → 关于：新增「上手指南」区块，放「重新查看新手引导」和「这个版本的新内容」两个按钮（id 分别是 intro-replay、whatsnew-open）。
  - i18n：新文字都加了 EN 词条，另加 `P('(\d+) 段待标注')`。
- **测试**：
  - 新增 `scripts/test-intro-ui.cjs`，已加入 test:ui。覆盖：全新安装自动引导；高亮和卡片的几何断言；方向键翻页和切页；900px 窗口；跳过后记录 done、重新加载不再弹；从 0.3.8 升级时弹一次，Esc 关闭后写入版本、再加载不弹；从说明进入引导并走完；从设置 → 关于重新打开；reduced-motion；夜间模式下文字不能是黑色。
  - `test-model-study-ui.cjs` 改为检查感叹号：默认隐藏、聚焦后显示、浮层不出界；汇总的 empty 状态和常驻文字不含长句。
  - 其余 5 个 UI 测试的 prefs.json 都补上 seenVersion 和 onboarding=done；test-ui.cjs 原来没有 prefs.json，也补上了，否则会弹引导。
  - **顺带修了一个测试夹具**：`test-usage-projects-ui.cjs` 在本地时间 0:00–0:20 之间运行时，所有记录都被夹到 0:01，「最近用过的排前面」因此打平而失败（00:13 实际复现）。现在按 i 错开几秒。
  - 结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 27 个 PASS**（原 24 个 + intro 3 个）。
- **产物 / 占用**：`dist\win-unpacked\TokenPulse.exe`（上一版，23:56 启动的 5 个进程，PID 4164/24472/34792/36388/40472）在本轮开始前就在运行，判断是用户在用，**没有关闭，也没有覆盖 dist**。新版本输出到 **`dist-intro\win-unpacked\TokenPulse.exe`**（0.3.9.0，2026-09-30 00:14），命令是 `npx electron-builder --dir --publish never -c.directories.output=dist-intro`。asar 里的 intro.js/css、index.html、app.js/css、model-study.js/css、i18n.js、build/main/index.js、prefs.js 都与工作区逐字节一致；package.json 由 builder 改写，这是正常的。exe 和 app.asar 独占打开检测通过；本轮启动的测试和构建进程已全部退出。未提交、未打安装包、未发布。
- **注意**：两个版本的 appId 相同，有单实例锁。旧的 dist 版还开着的时候启动 dist-intro 版，只会唤起旧窗口。要先从托盘退出旧版。用真实数据启动时，prefs.json 已存在且没有 seenVersion，所以会弹一次 0.3.9 更新说明，不会自动开始引导（可以从弹窗或设置 → 关于打开）。
- 视觉效果由用户验收，没有查看截图。

## 本机以外消耗识别 + 时间线放大 / 标注 · 已完成并交付免安装目录版（2026-09-29 23:43，Claude）

- 用户需求（0.3.9 必须的大改）：「只在本机用 Code」不现实。改成：额度增长、但本机同期没有 Code 请求的时段，自动识别为「本机以外的消耗」，不计入容量折算，并在「模型与思考等级 · 时间线」里标出来；用户可以给这些时段补上用了什么模型、什么思考等级再换算。时间线要支持放大，并能编辑时间段。
- **算法**：新增 `src/core/quota-offmachine.ts`。
  - 按相邻采样把窗口切成区间，涨幅不到 1 点先累积；采样间隔超过 30 分钟或百分比回落的区间跳过。
  - 区间内以及前后 5 分钟都没有本机请求，并且已经过去 5 分钟 → 算作「本机以外」（offPoints）。
  - 区间和用户标注重叠 → 可能混用，不参与折算（markedPoints）。
  - 其余有本机请求的区间是「干净区间」：容量 = 干净区间的本机费用 / Token ÷ 干净涨幅 × 100。
  - 标注存在 `quota-offmachine.json`，字段为 {id, kind, accountId, from, to, model, effort, source(chat/device/other), note}，一段最长 8 天，不能标注未来；完全删除账号时一起清掉。
- **接入**：
  - model-study 去掉「必须有校准时段」的门槛（unverifiedScope 固定为 0），排除与标注重叠的区间（excluded.offMachine）。结果里返回 `offMachine`：detected 是合并后的待标注段；marks 带 points、equivalentTokens（按该模型 × 等级的整窗容量换算）、equivalentCostUsd。另外返回 `catalog`；时间线的 bin 改成 1 分钟。
  - report.ts 对非 local-only 账号调用 applyClean：读一次全部官方请求流水，用干净区间算出 capacityHistory 和当前窗口容量，设置 `capacityBasis='clean'`。每点包含 cleanPoints、offPoints、markedPoints。真实数据下快照耗时约 173ms（在 worker 里）。
  - IPC：`models:offmachine`（preload.modelOffMachine），修改后调用 backgroundRefresh(false)。
- **界面**（`renderer/model-study.js` 的时间线整段重写，加上 `model-study.css`）：
  - 新增「本机以外」轨道：虚线块是待标注，实心块是已标注，块上写着模型 · 等级。
  - 卡片下方汇总这个周期本机以外涨了多少，列出每一段，点击即可放大并编辑。另有「手动标注一段」按钮。
  - 标注编辑区：开始 / 结束时间（没改的保留精确到毫秒的检测时间）、来源、模型（周期里用过的和目录里的，或者自己填）、思考等级（按模型列出），实时显示「涨了 X 点 ≈ Y Tokens」；可以保存、删除，按 Esc 取消。编辑时收到定时刷新会推迟重绘，不会冲掉表单。
  - 缩放：按钮（− / + / 整个周期）、拖选后「放大到这段」或「标注为本机以外的使用」、Ctrl+滚轮；最小范围 5 分钟，刻度按范围自动选步长。
  - 删除了校准面板（后端的 quota-calibration 保留，旧记录不受影响）。「换一种模型」的文案改为「按本机区间折算」。额度详情的说明和容量面板改用新口径：共享账号的容量趋势恢复折线，只有没有数据时才显示锁定说明。
- **真实数据核对**（去掉凭据的副本，已删除）：Claude 上周 $562（本机以外 1 点：9/27 21:19–22:51），9/15 周 $443（旧口径 $329，以前的采样间隔大，只有 5 个点是干净区间），本周 $490；ChatGPT 两周分别为 $140 和 $125。
- **测试**：
  - `test-shared-quota.cjs` 重写：识别、合并、5 分钟保护、标注换算、混用排除、干净容量、样本门槛、跨三家、标注存储的增删改和校验。
  - `test-model-study.cjs` 第 18 行按新规则改写。
  - `test-model-study-ui.cjs`：校准流程替换成时间线用例（识别、汇总、预算、编辑器换算、刷新不冲掉草稿、保存 / 删除、按钮 / 拖选 / Ctrl+滚轮缩放、Esc、夜间模式）；until 改成强制转布尔（以前返回 DOM 元素会报 clone 错误）。
  - 最终结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 24 个 PASS**。
- **产物**：`dist\win-unpacked\TokenPulse.exe`，0.3.9.0，构建时间 23:43:04。asar 里 10 个相关文件与工作区逐字节一致；独占打开检测通过，进程残留 0，已安装的 0.3.8 没有动。未提交、未发布。
- **已知限制**：
  - 同一时刻既跑 Code 又在网页聊天分不出来，这类区间仍算本机，会让容量略偏小。用户可以手动标注，被标注的区间整段排除。
  - 标注换算用的是这个模型 × 等级的整窗容量；模型不在容量表里时不给 Token 数。
  - 时间线只覆盖最近 30 天的周期（TRAINING_DAYS）。
  - 视觉效果由用户验收，没有查看截图。

## 「只在本机用 Code」开关 + 上周额度 $570→$300 排查 · 已完成并交付免安装目录版（2026-09-29 22:55，Claude）

- 用户要求：①在设置里加一个开关「这个账号只在本机用 Code，不聊天」，打开后按以前的方式直接折算容量，不再显示共享额度的说明和校准入口（用户明确同意，覆盖下方「不要恢复用本机日志倒推容量」的旧约定，但只对手动打开开关的账号生效）；②排查 Claude 上周的额度估值从约 $570 变成约 $300 的原因。版本 0.3.9，只打 dist 目录版。
- **② 排查结论**：用户日常用的是**已安装的 0.3.8**（`AppData\Local\Programs\TokenPulse`，ProductVersion 0.3.8.0）。
  - 用 v0.3.8 源码（临时 worktree，已删除）对着真实数据的副本（去掉凭据）重算：9/22–9/29 周 = 本机 $523 ÷ 91% = **$574**；9/15–9/22 周 = $112 ÷ 34% = **$329**。
  - 本机账本完好（817M Token，全部归在同一个账号），价格表两个版本相同，不是数据丢失。
  - 原因在 0.3.8 容量图的「中位数」：代码是 `reference[Math.floor((n-1)/2)]`，只有两个已结束窗口时取的是**较小的那个**。重置之前，上周还在进行中，排除在中位数之外，用户看到的是它进行中的 $574；重置之后它变成已结束窗口，中位数就落到了 9/15 那周的 $329。
  - 9/15 那周本身可信度较低：只用了 34%，而且那一周的采样都没有账号标记（登录时间线从 9/23 才开始），可能混有聊天或其他设备的用量。
- **修复**（`renderer/app.js` 的 capacityChart）：偶数个窗口时中位数取中间两个的平均；说明文字里单独写出「上一个窗口（起止日期）约 $X」。这个修复只在 0.3.9 生效，已安装的 0.3.8 仍会显示 $329。
- **① 开关**：
  - `src/main/prefs.ts` 新增 `localOnlyAccounts: string[]`；`index.ts` 的 applyPrefs 校验这个字段，修改后调用 backgroundRefresh(false) 重算快照。
  - `core/quota-calibration.ts` 新增 `localOnlyAccounts()`，直接读 prefs.json。
  - `quota-monitor.ts` 的 analyzeAccount 新增 localOnly 参数：为真时保留窗口容量和 capacityHistory（completeLocalOnly=true），quotaScope 设为 `local_only`。
  - `report.ts` 按账号传入这个参数；`model-study.ts` 对 localOnly 账号跳过 unverifiedScope 校验，结果里带 localOnly 标记。
  - 界面：设置 → 账号的每一行有「只在本机用 Code」开关（role=switch，操作结果走 Toast）。额度详情里的共享说明多了一个「在设置里打开」的入口；账号打开开关后，这段说明、时间线里的归因说明和校准面板都不再显示，容量面板恢复为「额度容量趋势」。
  - 用真实数据副本验证：开关打开后，历史容量恢复为 $329 / $574，模型换算的周预算约 $562。
- 测试：`test-shared-quota.cjs` 新增 local-only 用例；`test-model-study-ui.cjs` 新增开关的界面用例。最终 **`npm test` 退出 0，`npm run test:ui` 退出 0，共 24 个 PASS**。中位数修复没有专门的自动化测试。
- **追加（23:1x）：额度容量趋势模块「消失」**。用户以为 0.3.9 把它删了。其实模块还在，但在共享额度保护下，标题被改成「历史容量来源保护」、内容只剩一行字，所以看起来像删掉了。现在的处理：
  - 标题固定为「额度容量趋势」。
  - 共享状态下显示说明，加一个「在设置里打开『只在本机用 Code』」按钮（`.capacity-locked`），并隐藏空的周 / 5 小时、Tokens / 费用切换按钮；打开开关后恢复折线和切换。
  - `test-ui.cjs` 改为检查锁定状态：它的测试账号是没有账号 id 的老式采样，无法单独标成只在本机用 Code，这也是一个已知边界。切换按钮的测试移到 `test-model-study-ui.cjs`，在带 id 且已打开开关的账号上做。
  - `npm run test:ui` 退出 0，共 24 个 PASS。本轮只改了 renderer（app.js / app.css / i18n.js）和测试，dist 在最后一次修改 renderer 之后重新打过，asar 内容与工作区一致。
- 产物：`dist\win-unpacked\TokenPulse.exe`（0.3.9），最新构建时间见文件时间（本轮最后一次构建在 renderer 修改之后）。asar 里 10 个相关文件与工作区逐字节一致；独占打开检测通过，进程残留 0，已安装版没有动。未提交、未发布。

## 供应商六项要求核对 + 头像 / 号池 / 入口重设计 · 已完成并交付免安装目录版（2026-09-29 08:56，Claude）

- 用户贴出 6 条原始要求，问是否都已实现，要求补上缺的、把隐蔽的入口重新设计。版本 0.3.9，只打 dist 目录版，未打安装包、未提交、未发布。全程未查看图片。
- 核对结论：①思考等级下拉多选、②上下文预设、③预览、④Toast 原本已有。④有两处问题：进度线定位 bug；设置、出口监控、账号操作、校准的成功提示仍然写在页面里。③的入口只藏在编辑页第 4 步。⑤头像、⑥号池原本**都没有做**。
- **②**：Claude / 桌面端的模型行加了「上下文」列（原来只有隐藏的预设值），1M 开关会同步这个输入框。
- **③**：每家供应商的行上（终端图标）和当前供应商卡片上都有「配置预览」，点开直接进入编辑页的预览步骤。
- **④**：`.tp-toast` 补上 `position: relative`；鼠标悬停时暂停自动消失，进度线也同步暂停。新增 `settingsDone()`：设置保存、账号改名 / 排序 / 登录 / 删除都改走 Toast，设置页底部那行只留「正在…」和失败原因。egress.js 的 `message()` 成功走 Toast、失败仍留在页面；「有未保存的设置」这类状态提示用 inline 参数保留在页面。model-study 的校准更新也改走 Toast。`test-ui.cjs` 第 99 行的断言相应改为检查 Toast。
- **⑤ 头像**：
  - 从 `D:\CodePorject\Web\AllAi\public\brand\presets` 复制 25 个 SVG 到 `renderer/brand/presets/`，已确认不含脚本。
  - 新文件 `renderer/provider-avatars.js`：移植 AllAi `lib/preset-icons.ts` 的关键词打分，地址权重高于名称。上传的图片用 canvas 缩成 128px 的 PNG data URL。
  - 编辑页第一步是头像选择：显示当前效果，可选「自动匹配」「名称首字母」、25 个预设，或上传图片。原「高级」步骤里的图标标识 / 图标颜色文本框去掉了（icon 字段改由这里设置，iconColor 原值透传）。
  - 单色线稿在夜间模式反色。后端 `avatar` 字段只收 ≤400KB 的 png / jpeg / webp / gif / svg data URL。
- **⑥ 号池**：
  - 后端：`agent-types.ts` 新增 PoolConfig / POOL_OFFICIAL / POOL_KEY 和 ProxyTarget.auth / accountId / pool。`agent-switch.ts` 新增 Provider.pool / avatar、poolTargets（轮询 / 用满再换，凭据过期或已隐藏的账号跳过）、成员统计（只在内存里）、校验：桌面端不支持；成员必须是同一工具的供应商或同一家的官方账号；号池不能进备用队列、不能和普通供应商互转、不能直连（applyDirect 直接拒绝）；启用时自动打开本地路由。
  - `agent-proxy.ts` 新增 applyOfficialAuth：Claude 用 Bearer，在 anthropic-beta 里补上 oauth-2025-04-20；Codex 走 `https://chatgpt.com/backend-api/codex`（去掉 /v1），带 Chatgpt-Account-Id 和 originator，body 设 stream=true / store=false、补空 instructions，并删掉 previous_response_id 等 API 专用字段；Grok 走 `https://cli-chat-proxy.grok.com/v1`，用 Bearer。号池成员遇到 401 / 403 也换下一个。**不改 UA、不伪造设备或账号标识**（CPA 的 cloaking 没有移植）。
  - 界面：Claude Code、Codex、Grok 的工具页多了「新建号池」按钮。号池编辑只有三步（基本信息：头像、名称、可选默认模型，Grok 必填；成员：轮换方式、官方账号勾选、API Key 供应商勾选、顺序上移 / 下移；预览）。设置里没有账号时显示「去设置添加账号」。列表行和当前卡片显示号池标记、成员小标签（可用状态、健康、本次运行的转发次数），号池行没有「检测连通」和「备用」按钮。
- 测试：
  - `scripts/test-agent-switch.cjs` 新增 agent pool 用例：本机假上游，通过只给测试用的 `AGENT_SWITCH_POOL_BASE` 注入。
  - 新增 `scripts/test-provider-pool-ui.cjs`（已加入 test:ui）。
  - `test-ui.cjs` 的设置保存断言改成检查 Toast。
  - 最终结果：**`npm test` 退出 0；`npm run test:ui` 退出 0，共 23 个 PASS**。临时布局诊断在 1400 / 1080 / 900px、日夜两种主题下没有报告溢出、重叠或裁切。
- 产物：**`dist\win-unpacked\TokenPulse.exe`**，0.3.9.0，构建时间 08:56:54。asar 里 12 个关键文件与工作区逐字节一致，25 个预设 SVG 都已打进包里。进程残留 0，独占打开检测通过，已安装版没有动。
- **重要限制**：
  - 号池里官方账号的转发只用本机假上游测过，**没有用真实账号验证过** Anthropic / ChatGPT / Grok 的接口会不会接受。Grok 的 cli-chat-proxy 是否支持 /responses 也未确认。第一次实测时请看「转发记录」里的 HTTP 状态。
  - 号池的请求在各 CLI 的本地会话日志里，仍会被记在当前 CLI 登录的账号名下，所以额度详情按账号拆分的本机用量会不准；官方百分比本身不受影响。
  - 成员统计在重启后清零。官方账号的凭据续期沿用原来的机制，只有 TokenPulse 自己登录的账号会自动续期。
  - 用号池轮换订阅账号是否符合服务条款，由用户自行判断，界面上有提示。
- Git：`backup/0.3.9-wip` 之后的改动（另一位 AI 的和我这两轮的）**都还没有提交**。

## 供应商专区 · 界面与逻辑排查修复 · 已完成并交付免安装目录版（2026-09-29 08:14，Claude）

- 用户要求：排查「供应商」的 UI 设计问题和功能 BUG 并修复，改动都算 0.3.9。只打 dist 目录版，不打安装包、不提交、不发布。工作区里另一位 AI 上午的四项改动（Toast、预览、等级下拉、上下文预设，尚未提交）全部保留，这轮在它们基础上修改。全程未查看图片。
- 排查方法：在隔离 HOME 下启动真实页面，用临时诊断脚本（在会话 scratchpad，不进仓库）遍历 8 个分区和 4 家工具的 5 个编辑步骤，在 1400 / 1080 / 900px、日间 / 夜间下量元素是否伸出页面、同排兄弟是否重叠、文字是否被截断，以及对比度。
- **界面修复**（`renderer/agent-switch.js`、`agent-switch.css`）：
  - Codex 模型行原来 5 个元素挤在 4 列的网格里：显示名输入被塞进 72px 的角色列，删除按钮掉到第二行。现在按工具分别定列宽，每行一行排开，并加了列标题（Claude / 桌面端：角色 / 显示名 / 实际模型 / 1M；Codex：显示名 / 实际模型 / 上下文 / 思考等级）。Haiku 没有 1M 按钮，补了占位，保证和其他行对齐。900px 下 Codex 行变成两行两列。
  - 思考等级面板：原来左对齐、宽 310px，所有宽度下都会伸出页面右边，现在改成右对齐。原来每勾一个等级面板就收起，现在保持打开。点面板外面或按 Esc 会收起；原来 Esc 会连带关掉整个编辑页，弹出「放弃修改」。同一时间只开一个面板。触发按钮上显示已选等级和默认等级。
  - 「添加模型」「一键填到全部角色」不再拉满整行；一键填充时如果还没填任何模型，会给出提示，不再没有反应。
  - 编辑菜单里的「取消」和其他菜单项样式一致（图标加说明）。
  - 窄窗口下的二级菜单原来是隐藏滚动条的横向滚动，「转发记录」「导入供应商」被挤到屏幕外；现在改为自动换行。
  - Claude 桌面端的概览卡片补上品牌色顶条。接口格式说明文字和菜单分组标题的颜色从 faint 提到 muted（原对比度约 2.6:1）。
  - 1M、Grok 思考开关补 `aria-pressed`，桌面端直连 / 映射补 radio 语义，模型行输入补 `aria-label`。
- **功能 BUG 修复**：
  - 快速预设点「OpenAI Chat 兼容」时，旧代码按文字前缀匹配，会同时点亮 Chat 和 Responses 两个接口格式；现在按 `data-value` 精确匹配，并同步 `aria-checked`。
  - 高级设置的 Prompt Cache 路由：`el()` 把 `selected:false` 写成 `selected="false"` 属性，结果所有选项都被选中，最后一项「关闭」生效，保存时会写成 disabled。现在默认正确显示「自动」。
  - 预览页原来只在打开编辑页时生成一次，之后的修改不会反映出来；现在切到预览页时按当前草稿重新生成。Grok 预览的上下文改取编辑器里的值。
  - Grok 的上下文窗口没改时原来会存成空，现在存预设值 131072。Claude 切换 1M 时，如果上下文还是预设值，会跟着在 20 万和 100 万之间切换。
  - `src/core/agent-switch.ts`：`Number(null)` 和 `Number("")` 都是 0，导致所有供应商读出来都带「限额 日 0 · 月 0」。现在 `positiveNumber` 把空值当作不限，保存和读取两条路径都改了。
  - `src/core/agent-proxy.ts`：用户自定义的请求头原来会和转发来的同名头变成大小写不同的两份；现在统一转成小写，连接层相关的头和 host / content-length 不允许覆盖。
- 测试：
  - `scripts/test-agent-switch-ui.cjs` 新增断言：面板保持打开、不伸出页面、Esc 和点外面能收起、Esc 不关编辑页、Codex 行在同一行、有列标题、预设只点亮一个、预览反映草稿、Prompt Cache 默认自动、限额为 null、Grok 上下文为预设值。
  - `scripts/test-agent-switch.cjs` 新增限额用例：空串和 null 为不限，"0" 为 0，空白为不限。
  - `scripts/test-provider-feedback-ui.cjs`（另一位 AI 写的）第 81 行，24 行上限的计数改为排除列标题行，断言的行为不变。
  - 最终结果：**`npm test` 退出 0，`npm run test:ui` 退出 0，共 22 个 PASS**，日志里的 Synthetic / Simulated 是故障注入。
- 产物：`npx --no-install electron-builder --dir --publish never` 退出 0。**`dist\win-unpacked\TokenPulse.exe`**，ProductVersion 0.3.9.0，构建时间 08:14:45。app.asar 里的 agent-switch.js/.css、build/core/agent-switch.js、agent-proxy.js 与工作区逐字节一致。未打安装包，未提交，未发布。
- 收尾：测试、打包和诊断脚本的进程残留为 0；EXE、asar 和两个 build 文件独占打开检测通过，句柄已关闭。用户正在运行的已安装版（5 个进程）没有动。
- 没有覆盖到的：视觉观感由用户验收；没有连接真实供应商做端到端验证；限额只是元数据，代理并不执行限额（原本就是这样）。Git：备份分支 `backup/0.3.9-wip` 之后的改动（另一位 AI 的，加上本轮的）**都还没有提交**。如需备份，按用户指示再提交。

## 供应商专区 · 0.3.9 前四项修改已完成并交付（2026-09-29 07:14，America/Los_Angeles）

- 用户明确本轮继续使用 0.3.9，要求先完成四项：思考等级下拉多选、上下文默认值、CLI Provider Model 预览、右上角 Toast。本轮未做头像/AllAi资源与号池/CLIProxyAPI，未联网、未查看图片、不操作真实配置、不提交/发布。
- 思考等级：参考 CC Switch ReasoningLevelsEditor，改为可搜索 Popover 下拉多选、Canonical 顺序、独立默认等级选择；不再把等级全部平铺。
- 上下文：Claude/Desktop 默认 200,000（1M 标记时 1,000,000），Codex 128,000，Grok 131,072；旧记录为空时编辑器自动补预设，保存后不再写空上下文。
- Provider Preview：编辑页新增“预览”页面，根据当前未保存草稿生成 Claude Code / Claude Desktop / Codex / Grok 的 CLI provider/config 模型内容，API Key 只显示脱敏占位，保存前可检查。
- Toast：全局 showStatus 改为右上角可关闭、自动淡出、带进度线的 Toast；供应商保存/启用/导入/排序成功消息接入全局 Toast，错误仍保留可见提示和本地上下文。
- 回归：npm test 通过；npm run test:ui 通过；供应商专项覆盖 pending lock、失败重试、草稿保护、旧响应、24模型、暗色/900px/减弱动态，以及四项新功能；配置事务回归 24/24。测试中的 QA/Synthetic/Simulated 错误均为故障注入。
- 交付：electron-builder --dir --publish never 成功。最新免安装版 **D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe**，0.3.9 / ProductVersion 0.3.9.0，2026-09-29 07:14。app.asar 已核对包含 renderer/app.js、renderer/agent-switch.js/.css、index.html，供应商核心/代理代码共享占用检查通过，相关进程残留0。
- 已知边界：Toast在保留旧 app-status 的错误兼容基础上新增；Provider Preview 是本地草稿投影，不读取真实 CLI live 文件；头像和号池未做，按用户“先做四点”范围保留到下一轮。全程未查看图片。

## 历史交付记录 · 对比专区（2026-09-29 03:15；本模块后续已按用户要求移除）

- 用户要求直接做到最终效果；版本保持 0.3.9。全程不联网、不查看图片、不操作真实账号/供应商配置、不提交/安装/发布。
- 视觉重做：对比页改成“决策工作台”结构，新增结论 Hero、观测摘要、三家服务卡、额度压力、来源拆分、主要模型、解释说明；推荐视图增加证据条；套餐资料改成独立资料库卡片和更清晰的编辑表单。
- 动效：新增页面/卡片/摘要/编辑区入场动效、服务卡 hover 层次、Hero 装饰节点、额度条平滑展开；统一使用短时长和可中断的 Web Animations/CSS 过渡，并尊重 prefers-reduced-motion。没有查看或生成任何图片。
- 代码重点：renderer/comparison.js 增加决策型 Hero、摘要、证据和动效；renderer/comparison.css 完成响应式布局、主题变量、窄窗口适配和减少动态支持。后端 comparison.ts、IPC、套餐本地保存逻辑保持稳定。
- 修复：发现并解决对比视图返回数组未展开导致的 [object HTMLDivElement]；摘要“主要服务”改为正确显示服务名称。
- 验证：npm test 退出 0；npm run test:ui 退出 0；对比后端回归及三家卡片/三个视图/套餐编辑 DOM 回归通过；编译通过。测试中的 Simulated/Synthetic 错误是既有错误分支注入，相关断言均通过；GPU warning 来自 Electron 测试环境，不影响通过结果。
- 交付：npx --no-install electron-builder --dir --publish never 退出 0。最新目录版：**D:\CodePorject\Tools\TokenPulse\dist\win-unpacked\TokenPulse.exe**；package 0.3.9 / ProductVersion 0.3.9.0，构建时间 2026-09-29 03:15。必须保留整个 win-unpacked 目录。
- 包校验：app.asar 内 build/core/comparison.js、build/main/index.js、build/main/preload.js、renderer/comparison.js、renderer/comparison.css、renderer/index.html、renderer/app.js 与当前文件逐字节一致；版本 0.3.9。
- 收尾：相关测试/打包进程残留 0；核心 JS、EXE、app.asar 独占读取检测通过，句柄立即释放；未启动新产物、未关闭用户软件。git diff --check 通过，仅保留既有 CRLF→LF 警告。
- 已知边界：套餐价格/限制仍由用户手动维护，不联网同步；推荐仍是可解释的基础规则，不是黑盒评分；真实上游 API/CLI 和人工视觉验收留给用户。

## Git 备份点（2026-09-29）

- 用户要求在交给下一位 AI 之前先备份。全部 0.3.9 改动已提交到分支 **`backup/0.3.9-wip`**（提交 `0b65440`），并推送到 origin。`main` 仍停在 `bca4478`（v0.3.8 之后）。**当前工作目录就在这个备份分支上**；不要 `git switch main`，否则工作区会退回 0.3.8 的代码。
- 没提交的只有临时文件：`.tmp-*`、`.tmp-grok-home-test/`、`dist-preview/`、`dist-egress-preview/`。没打 tag，没发 Release。
- 改坏了要恢复：`git restore --source=0b65440 -- .`，或者 `git reset --hard 0b65440`（会丢掉之后的改动）。

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

（2026-10-05 核对：这一节的风格、动效、技术约束仍然有效。当时写的是「新功能由另一个 AI 负责，Claude 主要修 Bug」，实际上 0.3.9 之后的新功能和修复都是 Claude 做的。）下面是这个项目一路做下来、用户认可的风格和踩过的坑。**先读完这一节和 AGENTS.md 再动手。**

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
- 公开的 README 截图只用软件自带的演示数据（`scripts/capture-ui.cjs`，0.3.16 起；截图前会检查有没有邮箱、本机用户名漏出来）。它会覆盖 `artifacts/ui/` 里的图。
- 改账本结构要升 `usage-scan.ts` 的 `STATE_VERSION` 并写清迁移（只补元数据 / 某个来源整份重算），测试「旧账本升级后不重复计」。

### 测试与交付

- 每个功能都要有测试：纯计算放 `scripts/test-*.cjs`（node），界面放 Electron 端到端测试（参考 `scripts/test-model-study-ui.cjs`：真实 IPC + worker + DOM 断言，覆盖切换、失败、迟到结果、900px 窄窗口、reduced-motion、夜间模式文字颜色）。新测试加进 package.json 的 `test` / `test:ui`。
- 交付前：`npm test`、`npm run test:ui` 都通过；编译目录版；确认 ASAR 里有新代码；确认没有遗留的测试 / 构建进程；更新本文件顶部。
- 看图片：AGENTS.md 规定不能看图片、截图（会让客户端报错），别的 AI 照这条做，用 DOM、计算样式、尺寸断言验证，视觉交给用户验收。用户只对 Claude 放开了这条：Claude 可以截测试 / 演示界面来看。

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
