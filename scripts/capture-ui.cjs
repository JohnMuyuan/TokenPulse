// README 截图：读本机真实用量和额度采样到隔离的数据目录，逐页截图到 artifacts/ui。
//
// 截图要进公开的 README，所以：
// - 账号的邮箱、邮箱 @ 前面那段、别名、名字全部换成「账号 A / B / C…」，邮箱换成 you@example.com；
//   每张图截完都检查页面文字和悬停提示里还有没有真实的名字，有就停下，不写文件。
// - 出口监控用示意数据（文档专用的 IP 段 203.0.113.0/24、198.51.100.0/24 和示例 ASN），不暴露真实出口 IP、运营商和城市；
//   README 里标明是示意数据。
// - 会话管理（对话标题、项目）和设置里的账号页（邮箱）不截。
// - 账号库复制时去掉 credential，截图期间不向官方查额度（fetchOfficialQuota 换成空实现），额度数字来自采样历史。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenpulse-preview-'));
process.env.TOKENPULSE_DATA_DIR = path.join(temp, 'data');
app.setPath('userData', path.join(temp, 'electron'));
// 额度预测和历史折线图要靠采样历史，复制一份本机的过来（只复制采样，不带任何账号凭据）。
const realData = path.join(os.homedir(), '.tokenpulse');
fs.mkdirSync(process.env.TOKENPULSE_DATA_DIR, { recursive: true });
for (const name of ['quota-history.json', 'quota-checked.json', 'cli-logins.json']) {
  if (fs.existsSync(path.join(realData, name))) fs.copyFileSync(path.join(realData, name), path.join(process.env.TOKENPULSE_DATA_DIR, name));
}
// 模型 × 思考等级要知道每条请求是哪个账号的：账号列表复制一份，但去掉 credential（令牌），截图时也不去官方查额度。
try {
  const store = JSON.parse(fs.readFileSync(path.join(realData, 'official-accounts.json'), 'utf8'));
  for (const account of store.accounts || []) delete account.credential;
  fs.writeFileSync(path.join(process.env.TOKENPULSE_DATA_DIR, 'official-accounts.json'), JSON.stringify(store));
} catch { /* 没有账号库就只截用量 */ }
require('../build/core/quota.js').fetchOfficialQuota = async () => ({});

/* ---- 要遮住的名字：账号库和登录时间线里出现过的邮箱、邮箱前缀、名字、别名 ---- */
const readJson = file => { try { return JSON.parse(fs.readFileSync(path.join(realData, file), 'utf8')); } catch { return null; } };
const secrets = new Set();
// 一两个字符的名字（比如邮箱前缀只有一个字母）认不出任何人，换了反而会把普通单词里的同样字母也换掉，跳过
const addName = value => { if (typeof value === 'string' && value.trim().length >= 3 && !/账号$/.test(value.trim())) secrets.add(value.trim()); };
for (const account of readJson('official-accounts.json')?.accounts || []) { addName(account.email); addName(account.label); addName(account.alias); if (account.email) addName(account.email.split('@')[0]); }
for (const span of Object.values(readJson('cli-logins.json')?.kinds || {}).flat()) { addName(span?.email); addName(span?.label); if (span?.email) addName(span.email.split('@')[0]); }
// 长的先换（邮箱先于它的前缀）；邮箱统一换成占位邮箱，其余按出现顺序编号
const names = [...secrets].sort((a, b) => b.length - a.length);
const replacements = names.map((name, i) => [name, name.includes('@') ? 'you@example.com' : `账号 ${String.fromCharCode(65 + (i % 26))}`]);

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
      // 遮名字：任何时候页面里出现真实名字都换掉（表格、卡片都是异步画的，换一次会被重画盖回来）。只在真的变了时才写回，免得观察器无限循环
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
      // 大日志分批扫描，一轮扫不完：隔一会儿多刷几轮（连着不停地刷会把进程内存撑爆）
      let summary;
      for (let i = 0; i < 5; i++) { await pause(2500); summary = await js(`window.tokenpulse.refresh().then(s => ({ files: s.fileCount, accounts: s.accounts.length }))`); }
      console.log('Real data:', JSON.stringify(summary), '· names masked:', replacements.length);
      const capture = async (name, script, wait = 1800) => {
        if (script) await js(script);
        await pause(wait);
        await js('window.scrollTo(0, 0)');
        contents.invalidate(); await pause(150);
        // 刚重画的内容要等遮名字的观察器跑一轮：隔一会儿再查几次，还在才算泄露
        await js('window.__remask()');
        let leaks = await js('window.__leak()');
        for (let i = 0; leaks && i < 4; i++) { await pause(400); leaks = await js('window.__leak()'); }
        if (leaks) throw new Error(`截图 ${name} 里还有 ${leaks} 处真实账号名 / 邮箱，停下：${JSON.stringify(await js('window.__leakWhere()'))}`);
        fs.writeFileSync(path.join(output, name + '.png'), (await contents.capturePage()).toPNG());
        console.log('saved', name);
      };
      const scrollTo = selector => `(() => { const n = document.querySelector('${selector}'), w = document.querySelector('.workspace'); if (n && w) w.scrollTop = n.getBoundingClientRect().top + w.scrollTop - 150; })()`;
      await js("setThemeMode('light')");
      await capture('overview-light', "document.querySelector('.workspace').scrollTop = 0");
      // Claude 的两个窗口都在用，预测和容量卡片都有数；容量折线图在页面下方，单独截一张
      await capture('quota-light', "document.querySelector('[data-page=quota]').click(); document.querySelector('#account-tabs [data-kind=claude]')?.click(); document.querySelector('.workspace').scrollTop = 0");
      await capture('capacity-light', scrollTo('.capacity-panel'));
      // 0.3.8：换一种模型，整窗能用多少（ChatGPT 的模型和等级最多）
      await capture('models-light', `document.querySelector('#account-tabs [data-kind=chatgpt]')?.click(); setTimeout(() => { ${scrollTo('#quota-model-study')} }, 2500)`, 6000);
      // 0.3.8 起：模型与思考等级时间线（0.3.9 移到额度详情，跟随账号标签；ChatGPT 本周用了好几个模型）
      // 当前 5 小时周期刚开始、还没有请求时，往前翻到最近一个有请求的周期
      await capture('timeline-light', `setTimeout(() => { if (!document.querySelector('#quota-model-timeline .ms-cycle.five .ms-run')) document.querySelector('#quota-model-timeline .ms-cycle.five .ms-step')?.click(); }, 500);
        setTimeout(() => { ${scrollTo('#quota-model-timeline')} }, 3000)`, 6000);
      // 用量明细：用量分析（分工具趋势）和时段分布 / 排行，30 天
      await js("navigate('usage'); applyRange(30)");
      await capture('usage-light', scrollTo('#usage-insights'), 4000);
      await capture('insights-light', scrollTo('.insight-grid'), 1200);
      // 0.3.9：按项目
      await capture('projects-light', `document.querySelector('#usage-view [data-view=projects]').click(); setTimeout(() => { document.querySelector('#view-projects .pj-card .pj-head')?.click(); ${scrollTo('.usage-records')} }, 2500)`, 5000);
      await js("document.querySelector('#usage-view [data-view=requests]').click()");
      // 出口监控（示意数据）：开启监控、给 ChatGPT / Claude 设好白名单
      await js(`(async () => { navigate('egress'); const s = await window.tokenpulse.egressState(); const c = s.config;
        c.enabled = true; c.providers.chatgpt.allowedIps = ['203.0.113.24']; c.providers.claude.allowedIps = ['203.0.113.24']; await window.tokenpulse.saveEgress(c); })()`);
      await capture('egress-light', "document.querySelector('.workspace').scrollTop = 0", 3000);
      await capture('overview-dark', "navigate('overview'); applyRange(30); setThemeMode('dark'); document.querySelector('.workspace').scrollTop = 0");
      await capture('settings-light', "setThemeMode('light'); openSettings('general').then(() => document.activeElement?.blur())");
      await js("closeModal('settings')");
      window.setSize(900, 650);
      await capture('compact-light', "document.querySelector('.workspace').scrollTop = 0");
      console.log('Saved README screenshots to artifacts/ui');
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('../build/main/index.js');
