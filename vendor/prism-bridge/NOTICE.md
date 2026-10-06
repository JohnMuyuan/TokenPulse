# Prism Bridge

`bridge.py` 来自开源项目 Prism Bridge，作者 [@yyyllllming](https://github.com/yyyllllming)，MIT 协议（见同目录 `LICENSE`）。当前这份对应上游提交 `1bd4b79`（2026-10-05，Use unmanaged system Chrome for Windows login）。

TokenPulse 对它的改动有六处（代码里都带 `TokenPulse` 注释），其余内容和原项目一致：

- 新增环境变量 `PRISM_PROXY`（`http://主机:端口`），传给浏览器当代理（服务、Playwright 登录窗口、上游自己拉起的系统浏览器登录窗口）。
- 新增常量 `LOGIN_CHANNEL`（环境变量 `PRISM_LOGIN_CHANNEL`，`chrome` / `msedge`），只给 `collect_login.py` 用：告诉它用哪个浏览器去读登录结果。
- `cookie_header_to_playwright` 不再注入已经过期的 `prism_session_token`。这个令牌只有 12 小时，`auth.json` 只在登录时写一次；过期的那份会盖住 Prism 打开页面时新发的令牌，表现为登录 12 小时后再启动服务报 `401 Request verification failed`。
- `PrismPage.chat`：Prism 返回 `Project file synchronization timed out while starting the response` 或 `Unable to confirm the response started` 时重建会话（`boot`）再发一次。这一轮没有开始执行；上游 `1bd4b79` 去掉了旧版的「start failed, re-boot and retry」，同一个会话会一直报这个错，直到重启服务。
- `PrismPage.chat`：Prism 返回 `Error while processing conversation (403 Forbidden). Please submit prompt again.`（限流）时，按 20 / 40 / 60 秒……等待后重发同一轮，累计不超过 `PRISM_THROTTLE_WAIT`。上游 `1bd4b79` 改成直接把错误交回客户端，Codex 会每两三秒重试一次，越试限流越久。
- 拆成多段发送时，每段之后固定等 `PRISM_PART_GAP` 秒，不扣掉这一段已经花的时间。上游 `1bd4b79` 改成扣掉之后，8 段之间只隔约 3 秒，容易触发限流。

同目录的 `collect_login.py` 是 TokenPulse 自己写的：登录改成用正常启动的 Chrome / Edge（不被程序控制），窗口关掉后由它从那份浏览器数据里读出登录结果。

更新它：用新版的 `bridge.py` 覆盖后，把这三处改动补回去（搜索 `TokenPulse:`）。
