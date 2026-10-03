// README 截图：全部用软件自带的**演示数据**（新手引导用的那份虚构账号，src/core/demo-data.ts），逐页截图到 artifacts/ui。
//
// 截图要进公开的 README，所以一点真实数据都不用（0.3.16 起；以前是读本机真实用量再把名字遮掉）：
// - 数据目录、用户主目录都指向一个新建的临时目录：本机的 ~/.tokenpulse、~/.claude、~/.codex、~/.grok 碰都不碰；
// - 界面切到演示模式（window.tokenpulse.demo(true)）：快照、模型换算、请求流水都由演示进程按虚构数据算；
// - 出口监控用示意数据（文档专用的 IP 段 203.0.113.0/24、198.51.100.0/24 和示例 ASN）；
// - 不向官方查额度（fetchOfficialQuota 换成空实现）；会话管理页不截（它不走演示数据）。
// 每张图截完检查页面上有没有邮箱、有没有本机用户名 / 主目录路径，有就停下，不写文件。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// 先记下真实的用户名和主目录（只用来检查截图里有没有漏出来），再把环境指向临时目录
const realHome = os.homedir(), realUser = os.userInfo().username;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-preview-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
process.env.AGENT_SWITCH_HOME = process.env.HOME = process.env.USERPROFILE = path.join(temp, 'home');
process.env.AGENT_SWITCH_CC_DB = path.join(temp, 'missing.db');
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME']) delete process.env[key];
app.setPath('userData', path.join(temp, 'electron'));
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
// 不弹新手引导和更新说明；不自动更新、不开机自启
fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'prefs.json'), JSON.stringify({ autoLaunch: false, autoUpdate: false, closeToTray: false, startMinimized: false, language: 'zh', notifyAt: 0, notifyMismatch: false, ccSwitch: false, seenVersion: require('../package.json').version, onboarding: 'done', theme: 'light' }));
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});

/* ---- 截图里不该出现的：本机用户名、主目录路径（邮箱另外按格式查） ---- */
const forbidden = [...new Set([realHome, realHome.replace(/\\/g, '/'), realUser].filter(value => typeof value === 'string' && value.length >= 3))];
const replacements = forbidden.map(value => [value, '***']);

/* ---- 出口监控：示意数据 ---- */
const egressModule = require('../build/main/egress-monitor.js');
const RealExitMonitor = egressModule.ExitMonitor;
const DEMO = {
  chatgpt: { ip: '203.0.113.24', region: 'US', latencyMs: 182 },
  claude: { ip: '203.0.113.24', region: 'US', latencyMs: 176 },
  grok: { ip: '198.51.100.77', region: 'JP', latencyMs: 96 },
};
const DEMO_INTEL = {
  '203.0.113.24': { countryCode: 'US', region: 'California', city: 'San Jose', asn: 'AS64500', asName: 'EXAMPLE-BROADBAND', isp: 'Example Broadband', type: 'isp',
    sources: [{ id: 'proxycheck', name: 'proxycheck.io', url: 'https://proxycheck.io/threats/203.0.113.24', ok: true, risk: 0, flags: { proxy: false, vpn: false }, type: 'isp', note: 'Residential' },
      { id: 'ipapicom', name: 'ip-api.com', url: 'https://ip-api.com/#203.0.113.24', ok: true, flags: { hosting: false, proxy: false, mobile: false }, type: 'isp' },
      { id: 'ipinfo', name: 'ipinfo.io', url: 'https://ipinfo.io/203.0.113.24', ok: true, flags: { anycast: false }, note: 'Example Broadband' },
      { id: 'ipapiis', name: 'ipapi.is', url: 'https://ipapi.is/?q=203.0.113.24', ok: true, flags: {}, note: 'Example Broadband' }] },
  '198.51.100.77': { countryCode: 'JP', region: 'Tokyo', city: 'Tokyo', asn: 'AS64511', asName: 'EXAMPLE-CLOUD', isp: 'Example Cloud', org: 'Example Cloud Hosting', type: 'hosting',
    sources: [{ id: 'proxycheck', name: 'proxycheck.io', url: 'https://proxycheck.io/threats/198.51.100.77', ok: true, risk: 42, flags: { proxy: false, vpn: true }, type: 'hosting', note: 'Hosting' },
      { id: 'ipapicom', name: 'ip-api.com', url: 'https://ip-api.com/#198.51.100.77', ok: true, flags: { hosting: true, proxy: false, mobile: false }, type: 'hosting' },
      { id: 'ipinfo', name: 'ipinfo.io', url: 'https://ipinfo.io/198.51.100.77', ok: true, flags: { anycast: false }, note: 'Example Cloud' },
      { id: 'ipapiis', name: 'ipapi.is', url: 'https://ipapi.is/?q=198.51.100.77', ok: true, flags: {}, note: 'Example Cloud Hosting' }] },
};
egressModule.ExitMonitor = class extends RealExitMonitor {
  constructor(options) {
    super({
      ...options,
      probe: async (provider, host) => ({ provider, host, ...DEMO[provider], checkedAt: Date.now() }),
      lookup: async ip => ({ ip, fetchedAt: Date.now(), ...DEMO_INTEL[ip] }),
    });
  }
};

const output = path.resolve(__dirname, '../artifacts/ui');
fs.mkdirSync(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeout = setTimeout(() => { console.error('Preview timed out'); app.exit(1); }, 170000);
app.on('web-contents-created', (_, contents) => {
  contents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
  contents.on('did-finish-load', async () => {
    try {
      const window = BrowserWindow.fromWebContents(contents);
      window.show();
      window.setSize(1440, 960);
      const js = code => contents.executeJavaScript(code);
      // 主进程定时推过来的是真实快照（这里是空的临时目录）：丢掉，界面只显示演示数据
      const send = contents.send.bind(contents);
      contents.send = (channel, ...args) => (channel === 'snapshot' ? undefined : send(channel, ...args));
      // 兜底：万一页面里出现本机用户名 / 主目录路径就换掉（用的是演示数据，正常不会出现）；截图前还会再检查一遍，有就停下
      await js(`(() => {
        const pairs = ${JSON.stringify(replacements)};
        // 邮箱只由 ASCII 组成：前面不能吞进中文（「重命名：you@example.com」整段会被当成一个邮箱，检查误报）
        const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
        // 邮箱先换成一个占位符再换名字：不然占位邮箱 you@example.com 里的字母也会被当成名字换掉
        const HOLD = '#MAIL#PLACEHOLDER#';
        const clean = text => { let next = text.replace(email, HOLD); for (const [from, to] of pairs) if (!from.includes('@')) next = next.split(from).join(to); return next.split(HOLD).join('you@example.com'); };
        const mask = root => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
          for (let n = walker.currentNode; n; n = walker.nextNode()) {
            if (n.nodeType === 3) { const next = clean(n.nodeValue); if (next !== n.nodeValue) n.nodeValue = next; }
            else for (const a of ['title', 'aria-label', 'data-email', 'data-alias']) { const v = n.getAttribute?.(a); if (v) { const next = clean(v); if (next !== v) n.setAttribute(a, next); } }
          }
        };
        new MutationObserver(records => { for (const r of records) mask(r.target.nodeType === 3 ? r.target.parentNode || document.body : r.target); }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['title', 'aria-label'] });
        mask(document.body);
        window.__remask = () => mask(document.body);
        // 只报位置（元素的 class / 属性名），不报名字本身
        window.__leakWhere = () => { const hits = []; const names = pairs.map(p => p[0]);
          for (const n of document.querySelectorAll('*')) { for (const a of n.getAttributeNames()) { const v = n.getAttribute(a); if (names.some(x => v.includes(x)) || (v.match(email) || []).some(m => m !== 'you@example.com')) hits.push(a + '@' + n.tagName + '.' + n.className); }
            for (const c of n.childNodes) if (c.nodeType === 3 && (names.some(x => c.nodeValue.includes(x)) || (c.nodeValue.match(email) || []).some(m => m !== 'you@example.com'))) hits.push('text@' + n.tagName + '.' + n.className + (n.closest('[hidden]') ? ' (hidden)' : '')); }
          const text = document.body.innerText;
          for (const x of names) { let i = text.indexOf(x); if (i >= 0) hits.push('innerText: …' + text.slice(Math.max(0, i - 24), i).split(String.fromCharCode(10)).join('⏎') + '***' + text.slice(i + x.length, i + x.length + 24).split(String.fromCharCode(10)).join('⏎') + '…'); }
          for (const m of (text.match(email) || []).filter(m => m !== 'you@example.com')) hits.push('innerText email: ' + m.replace(/[^@]/g, '*'));
          return [...new Set(hits)].slice(0, 12); };
        window.__leak = () => { const text = document.body.innerText + ' ' + [...document.querySelectorAll('[title],[aria-label]')].map(n => (n.getAttribute('title') || '') + ' ' + (n.getAttribute('aria-label') || '')).join(' ');
          return pairs.map(p => p[0]).filter(name => text.includes(name)).length + (text.match(email) || []).filter(m => m !== 'you@example.com').length; };
      })()`);
      // 切到演示数据：之后界面读的快照、模型换算、请求流水全是演示进程按虚构账号算的
      await js("typeof navigate === 'function'");
      const demo = await js(`(async () => { const s = await window.tokenpulse.demo(true); state.account = 'claude:demo'; render(s); return { demo: s.demo === true, accounts: s.accounts.map(a => a.accountId), files: s.fileCount }; })()`);
      if (!demo.demo || demo.accounts.join() !== 'claude:demo') throw new Error('没有切到演示数据，停下：' + JSON.stringify(demo));
      console.log('Demo data only:', JSON.stringify(demo));
      const redraw = "window.tokenpulse.snapshot().then(s => { if (s.demo !== true) throw new Error('not demo'); render(s); })";
      const capture = async (name, script, wait = 1800) => {
        if (script) await js(script);
        await pause(wait);
        if (!await js('window.tokenpulse.isDemo()')) throw new Error(`截图 ${name} 时已经不在演示模式，停下`);
        await js('window.scrollTo(0, 0)');
        contents.invalidate(); await pause(150);
        // 刚重画的内容要等遮名字的观察器跑一轮：隔一会儿再查几次，还在才算泄露
        await js('window.__remask()');
        let leaks = await js('window.__leak()');
        for (let i = 0; leaks && i < 4; i++) { await pause(400); leaks = await js('window.__leak()'); }
        if (leaks) throw new Error(`截图 ${name} 里有 ${leaks} 处邮箱 / 本机用户名 / 路径，停下：${JSON.stringify(await js('window.__leakWhere()'))}`);
        fs.writeFileSync(path.join(output, name + '.png'), (await contents.capturePage()).toPNG());
        console.log('saved', name);
      };
      const scrollTo = selector => `(() => { const n = document.querySelector('${selector}'), w = document.querySelector('.workspace'); if (n && w) w.scrollTop = n.getBoundingClientRect().top + w.scrollTop - 150; })()`;
      await js("setThemeMode('light')");
      await capture('overview-light', "document.querySelector('.workspace').scrollTop = 0");
      // Claude 的两个窗口都在用，预测和容量卡片都有数；容量折线图在页面下方，单独截一张
      await capture('quota-light', "document.querySelector('[data-page=quota]').click(); document.querySelector('.workspace').scrollTop = 0");
      await capture('capacity-light', scrollTo('.capacity-panel'));
      // 换一种模型，整窗能用多少；点开第一行看详情（0.3.14 起：标价、来源、综合单价）
      await capture('models-light', `setTimeout(() => { ${scrollTo('#quota-model-study')} }, 2500)`, 6000);
      await capture('detail-light', `(() => { const row = document.querySelector('#quota-model-study .ms-row'); row?.click(); const w = document.querySelector('.workspace'); if (row) w.scrollTop = row.getBoundingClientRect().top + w.scrollTop - 150; })()`, 2500);
      await js("document.querySelector('#quota-model-study .ms-row.open')?.click()");
      // 模型与思考等级时间线（跟随账号标签）
      // 当前 5 小时周期刚开始、还没有请求时，往前翻到最近一个有请求的周期
      await capture('timeline-light', `setTimeout(() => { if (!document.querySelector('#quota-model-timeline .ms-cycle.five .ms-run')) document.querySelector('#quota-model-timeline .ms-cycle.five .ms-step')?.click(); }, 500);
        setTimeout(() => { ${scrollTo('#quota-model-timeline')} }, 3000)`, 6000);
      // 用量明细：用量分析（分工具趋势）和时段分布 / 排行，30 天
      await js("navigate('usage'); applyRange(30)");
      await capture('usage-light', scrollTo('#usage-insights'), 4000);
      await capture('insights-light', scrollTo('.insight-grid'), 1200);
      // 出口监控（示意数据）：开启监控、给 ChatGPT / Claude 设好白名单
      await js(`(async () => { navigate('egress'); const s = await window.tokenpulse.egressState(); const c = s.config;
        c.enabled = true; c.intervalSeconds = 10; c.providers.chatgpt.allowedIps = ['203.0.113.24']; c.providers.claude.allowedIps = ['203.0.113.24']; await window.tokenpulse.saveEgress(c); })()`);
      await capture('egress-light', "document.querySelector('.workspace').scrollTop = 0", 3000);
      await capture('overview-dark', "navigate('overview'); applyRange(30); setThemeMode('dark'); document.querySelector('.workspace').scrollTop = 0");
      await capture('settings-light', "setThemeMode('light'); openSettings('general').then(() => document.activeElement?.blur())");
      await js("closeModal('settings')");
      window.setSize(900, 650);
      await capture('compact-light', "document.querySelector('.workspace').scrollTop = 0");
      console.log('Saved README screenshots to artifacts/ui');
      await js('window.tokenpulse.demo(false)').catch(() => {});
      clearTimeout(timeout); try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* 还被占着就留给系统清理 */ }
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../build/main/index.js');
