# Prism Bridge

`bridge.py` 来自开源项目 Prism Bridge，作者 [@yyyllllming](https://github.com/yyyllllming)，MIT 协议（见同目录 `LICENSE`）。当前这份对应上游提交 `1bd4b79`（2026-10-05，Use unmanaged system Chrome for Windows login）。

TokenPulse 对它的改动有三处（代码里都带 `TokenPulse` 注释），其余内容和原项目一致：

- 新增环境变量 `PRISM_PROXY`（`http://主机:端口`），传给浏览器当代理（服务、Playwright 登录窗口、上游自己拉起的系统浏览器登录窗口）。
- 新增常量 `LOGIN_CHANNEL`（环境变量 `PRISM_LOGIN_CHANNEL`，`chrome` / `msedge`），只给 `collect_login.py` 用：告诉它用哪个浏览器去读登录结果。
- `cookie_header_to_playwright` 不再注入已经过期的 `prism_session_token`。这个令牌只有 12 小时，`auth.json` 只在登录时写一次；过期的那份会盖住 Prism 打开页面时新发的令牌，表现为登录 12 小时后再启动服务报 `401 Request verification failed`。

同目录的 `collect_login.py` 是 TokenPulse 自己写的：登录改成用正常启动的 Chrome / Edge（不被程序控制），窗口关掉后由它从那份浏览器数据里读出登录结果。

更新它：用新版的 `bridge.py` 覆盖后，把这三处改动补回去（搜索 `TokenPulse:`）。
