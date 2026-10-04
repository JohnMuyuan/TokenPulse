# Prism Bridge

`bridge.py` 来自开源项目 Prism Bridge，作者 [@yyyllllming](https://github.com/yyyllllming)，MIT 协议（见同目录 `LICENSE`）。

TokenPulse 对它的改动有两处，其余内容和原项目一致：

- 新增环境变量 `PRISM_PROXY`（`http://主机:端口`），传给 Playwright 启动的浏览器当代理（登录和服务两处）。
- 新增环境变量 `PRISM_LOGIN_CHANNEL`（`chrome` / `msedge`），登录窗口用系统里装的浏览器。

同目录的 `collect_login.py` 是 TokenPulse 自己写的：登录改成用正常启动的 Chrome / Edge（不被程序控制），窗口关掉后由它从那份浏览器数据里读出登录结果。

更新它：用新版的 `bridge.py` 覆盖后，把这两处改动补回去（搜索 `PROXY_OPTION` 和 `LOGIN_CHANNEL`）。
