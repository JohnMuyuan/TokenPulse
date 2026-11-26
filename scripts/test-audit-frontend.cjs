'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const readRenderer = name => fs.readFileSync(path.join(RENDERER, name), 'utf8');

async function main() {
  const results = [];
  const check = async (name, fn) => {
    await fn();
    results.push(name);
    console.log('PASS:', name);
  };

  // 1. Every renderer JS file parses cleanly
  await check('all renderer/*.js files parse without syntax errors', () => {
    const files = fs.readdirSync(RENDERER).filter(f => f.endsWith('.js'));
    assert.ok(files.length >= 20, `expected >= 20 renderer JS files, got ${files.length}`);
    for (const file of files) {
      new vm.Script(readRenderer(file), { filename: file });
    }
  });

  // 2. i18n.js: semicolon-containing PATTERNS match before splitting, SCRIPT/STYLE rejected, new keys translated
  await check('i18n.js translates semicolon patterns intact, skips SCRIPT/STYLE, covers audit strings', () => {
    const storage = new Map([['tokenpulse-lang', 'en']]);
    let capturedFilter = null;
    const makeNode = (type, tag, text = '', attrs = {}) => ({
      nodeType: type,
      tagName: tag,
      nodeValue: text,
      parentElement: null,
      getAttribute: k => attrs[k] ?? null,
      hasAttribute: k => Object.prototype.hasOwnProperty.call(attrs, k),
      setAttribute() {},
      closest: () => null,
    });
    const sandbox = {
      console,
      localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
      NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
      MutationObserver: class { observe() {} disconnect() {} },
      document: {
        documentElement: { lang: '', setAttribute() {} },
        title: '',
        body: null,
        readyState: 'loading',
        addEventListener() {},
        createTreeWalker(_root, _what, filter) {
          capturedFilter = filter;
          return { nextNode: () => null };
        },
      },
      window: null,
    };
    sandbox.window = sandbox;
    vm.runInNewContext(readRenderer('i18n.js'), sandbox, { filename: 'i18n.js' });
    const i18n = sandbox.PulseI18n;
    assert.ok(i18n && i18n.lang() === 'en', 'PulseI18n initialized in English mode');

    // Semicolon-containing patterns must translate as a complete sentence with zero leftover CJK
    const semiSamples = [
      '点是那段时间（一天）的中位数，竖线是中间一半请求的范围。走势线每一行用自己的刻度（左边标着上下限），看的是这个模型自己变快还是变慢；模型之间比快慢看右边：数字是整段时间的中位数，下面的条都按 0 – 120 Token/秒画。速度 = 输出 Token ÷ 出字用的时间（含思考）。',
      '登录在 Claude Code 里，凭据过期了。Claude Code 没在运行时 TokenPulse 会替它续期；正在运行时等它下次发请求自己续上，不用重新登录。',
      '已开启：换号时会发通知提醒你；已经开着的 Codex 会话，要重新打开才会用新账号',
      '连接上游超时（没有走代理；需要代理的话，请打开系统代理或设置 HTTPS_PROXY 环境变量后重启 TokenPulse）',
      '上游拒绝了连接（没有走代理；需要代理的话，请打开系统代理或设置 HTTPS_PROXY 环境变量后重启 TokenPulse）',
      '找不到上游的地址（DNS 解析失败）（没有走代理；需要代理的话，请打开系统代理或设置 HTTPS_PROXY 环境变量后重启 TokenPulse）',
    ];
    for (const sample of semiSamples) {
      const translated = i18n.t(sample);
      assert.ok(!/[\u4e00-\u9fff]/.test(translated), `semicolon pattern left untranslated CJK: ${sample} -> ${translated}`);
    }

    // All newly added audit strings must translate to English without CJK
    const newStrings = [
      '可能已接近上限，刷新确认',
      '按最近趋势，可能已接近上限，刷新确认',
      '按最近的速度，可能已接近用完，刷新确认',
      '官方账号成员周额度已全部用完，等待重置',
      '已经重置，等待下一次查询',
      '旧窗口已结束',
      '对话读取失败，请重试。',
      '移除失败，请重试。',
      '已用完',
      '这个窗口没有实测',
      '已保存到本地',
      '已复制图片',
      '当前未检查，点击重新检查。',
      '没有找到有效的最近检测 IP，请先点击「立即检测」。',
      '每一行是 DeepSeek Harness 的一个模型目录项，第一行作为新会话默认模型。',
      'DeepSeek Harness 的号池必须写一个模型名。',
      'DeepSeek 号池要填一个模型名。',
      '例如 deepseek-chat',
    ];
    for (const s of newStrings) {
      const out = i18n.t(s);
      assert.ok(out && out !== s && !/[\u4e00-\u9fff]/.test(out), `missing EN translation for: ${s} -> ${out}`);
    }

    // TreeWalker filter must reject SCRIPT, STYLE, and translate="no"
    i18n.apply(makeNode(1, 'DIV'));
    assert.ok(capturedFilter, 'TreeWalker filter should be captured');
    assert.equal(capturedFilter.acceptNode(makeNode(1, 'SCRIPT')), 2, 'SCRIPT must be rejected');
    assert.equal(capturedFilter.acceptNode(makeNode(1, 'STYLE')), 2, 'STYLE must be rejected');
    assert.equal(capturedFilter.acceptNode(makeNode(1, 'SPAN', '', { translate: 'no' })), 2, 'translate=no must be rejected');
    assert.equal(capturedFilter.acceptNode(makeNode(1, 'SPAN')), 1, 'normal element must be accepted');
  });

  // 3. pet-desk.js: #RGBA/#RRGGBBAA parseColor and DeskState.resetInput
  await check('pet-desk.js supports 4/8-digit hex colors and DeskState.resetInput clears transient state', () => {
    const sandbox = { console, Math, Date, Map, Set, Number, String, Object, Array, RegExp, isFinite, parseInt, performance: { now: () => 1000 } };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(readRenderer('pet-desk.js'), sandbox, { filename: 'pet-desk.js' });
    const desk = sandbox.PulsePetDesk;
    assert.ok(desk && typeof desk.DeskState === 'function');

    // Verify #RGBA and #RRGGBBAA in custom desk pack resolve cleanly without falling back to default
    const resolved4 = desk.resolveStyle('custom', { base: 'white', colors: { glow: '#f08c' } }, 'light');
    assert.equal(resolved4.dp.glow, '#f08c');
    const resolved8 = desk.resolveStyle('custom', { base: 'white', colors: { glow: '#12345680' } }, 'light');
    assert.equal(resolved8.dp.glow, '#12345680');
    const src = readRenderer('pet-desk.js');
    assert.ok(src.includes('[0-9a-f]{3,4}') && src.includes('(?:[0-9a-f]{2})?'), 'parseColor handles 4 and 8 hex digits');

    // DeskState.resetInput clears passwordActive, mouse buttons, held keys, and floats
    const st = new desk.DeskState();
    st.passwordActive = true;
    st.mouseLeft = true;
    st.mouseRight = true;
    st.heldKeys.set('0:0', { key: '0:0', at: 1000 });
    st.floats.push({ text: 'A', at: 1000 });
    st.resetInput(2000);
    assert.equal(st.passwordActive, false, 'resetInput clears passwordActive');
    assert.equal(st.mouseLeft, false, 'resetInput clears mouseLeft');
    assert.equal(st.mouseRight, false, 'resetInput clears mouseRight');
    assert.equal(st.heldKeys.size, 0, 'resetInput clears heldKeys');
    assert.equal(st.floats.length, 0, 'resetInput clears floats');
  });

  // 4. pet-sound.js: NaN volume guard, closed AudioContext recreation, suspended dedupe
  await check('pet-sound.js handles NaN volume, closed AudioContext recreation, and suspended deduplication', async () => {
    let created = 0;
    let scheduledGains = [];
    let resumeResolvers = [];
    class FakeAudioContext {
      constructor() {
        created += 1;
        this.state = created === 1 ? 'suspended' : 'running';
        this.currentTime = 0;
        this.destination = {};
      }
      resume() {
        return new Promise(resolve => {
          resumeResolvers.push(() => { this.state = 'running'; resolve(); });
        });
      }
      createGain() {
        const g = {
          gain: {
            value: 1,
            setValueAtTime() {},
            exponentialRampToValueAtTime() {},
            linearRampToValueAtTime() {},
          },
          connect() {},
        };
        scheduledGains.push(g);
        return g;
      }
      createOscillator() {
        return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} };
      }
    }
    const sandbox = { console, Math, Number, Set, Object, Promise, AudioContext: FakeAudioContext };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.runInNewContext(readRenderer('pet-sound.js'), sandbox, { filename: 'pet-sound.js' });
    const sound = sandbox.PulsePetSound;

    // Rapid calls while suspended deduplicate to one chime on resume
    assert.equal(sound.play('done', Number.NaN), true);
    assert.equal(sound.play('ask', 0.5), true);
    assert.equal(created, 1);
    assert.equal(resumeResolvers.length, 1, 'should only call resume() once while pending');
    assert.equal(scheduledGains.length, 0, 'should not schedule before resume resolves');
    resumeResolvers[0]();
    await new Promise(r => setImmediate(r));
    // 'ask' has 2 notes * 2 oscillators (soft) + 1 master gain = 5 gain nodes
    assert.equal(scheduledGains.length, 5, 'only latest pending chime (ask) should play after resume');
    assert.ok(Number.isFinite(scheduledGains[0].gain.value) && scheduledGains[0].gain.value > 0, 'master gain must be finite');

    // Closed AudioContext is recreated cleanly
    sandbox.AudioContext.prototype; // keep ref
    // Force close by accessing closure through second play after closing via hook
    let closedCtx = null;
    class RecreateCtx extends FakeAudioContext {
      constructor() { super(); this.state = 'running'; closedCtx = this; }
    }
    const s2 = { console, Math, Number, Set, Object, Promise, AudioContext: RecreateCtx };
    s2.window = s2; s2.globalThis = s2;
    vm.runInNewContext(readRenderer('pet-sound.js'), s2, { filename: 'pet-sound.js' });
    const before = created;
    assert.equal(s2.PulsePetSound.play('error', NaN), true);
    assert.equal(created, before + 1);
    closedCtx.state = 'closed';
    assert.equal(s2.PulsePetSound.play('error', 0.4), true);
    assert.equal(created, before + 2, 'closed AudioContext must be recreated');
  });

  // 5. pet-theme.js uses localName === 'img' (case-insensitive across HTML/SVG)
  await check('pet-theme.js checks localName instead of lowercase tagName on HTML img elements', () => {
    const src = readRenderer('pet-theme.js');
    assert.ok(!/\.tagName\s*===\s*['"]img['"]/.test(src), 'must not use case-sensitive tagName === "img"');
    assert.ok(src.includes(".localName === 'img'"), 'must check localName === "img"');
  });

  // 6. usage-insights.js: bandAreaPath forward-reversing Bezier + peakVal reducer + speedResize cleanup
  await check('usage-insights.js fixes bandAreaPath, peakVal reducer, and ResizeObserver cleanup', () => {
    const src = readRenderer('usage-insights.js');
    assert.ok(src.includes('monotoneSegments(lower)'), 'bandAreaPath must compute monotone tangents forward on lower');
    assert.ok(src.includes('lowInfo.segs.length - 1; i >= 0; i--'), 'bandAreaPath must reverse cubic segments mathematically');
    assert.ok(!/return\s+max;\s*\},\s*0\)\s*\)/.test(src), 'peakVal reducer must return val, not max');
    assert.ok(src.includes('speedResize?.disconnect()'), 'speedResize observer must be disconnected before replacing');
  });

  // 7. share-card.js: negative USD formatting and zero-span guards
  await check('share-card.js formats negative USD properly and guards zero-span ranges', () => {
    const src = readRenderer('share-card.js');
    assert.ok(src.includes("value < 0 ? '-$' : '$'"), 'usd() must put minus sign before dollar sign');
    assert.ok(src.includes('Math.max(1, ...r.fastest.map'), 'fastPanel must guard zero max');
    assert.ok(src.includes('Math.max(1, points.at(-1).tokens'), 'journeyPanel must guard zero max');
  });

  // 8. CSS & accessibility regressions across all audited stylesheets
  await check('CSS fixes: tokens, z-index layering, pointer-events, mobile grid, reduced motion, contrast', () => {
    const appCss = readRenderer('app.css');
    assert.ok(appCss.includes('--font-mono:'), 'app.css must define --font-mono');
    assert.ok(!appCss.includes('var(--surface-soft)'), 'app.css must not reference undefined --surface-soft');
    assert.ok(/\.layout-panel\s*\{[^}]*z-index:\s*50\b/.test(appCss), '.layout-panel z-index must stay below modals (80)');
    assert.ok(appCss.includes('.pool-queue-row:focus-visible'), 'pool rows must have custom :focus-visible outline');

    const agyCss = readRenderer('antigravity.css');
    assert.ok(!/#quota-detail button\b/.test(agyCss), 'antigravity.css must not globally override #quota-detail button color');
    assert.ok(!agyCss.includes('--brand-claude'), 'antigravity.css must not reference undefined --brand-claude');

    const poolCss = readRenderer('pool-quota.css');
    assert.ok(poolCss.includes('grid-template-columns: 100px minmax(0, 1fr) 88px 70px;'), 'pool-quota.css mobile .pq-req must have 4 columns for 4 visible cells');

    const msCss = readRenderer('model-study.css');
    assert.ok(/\.ms-quota-area\s*\{[^}]*pointer-events:\s*none/.test(msCss), '.ms-quota-area must have pointer-events: none');
    assert.ok(/\.ms-quota-line\s*\{[^}]*pointer-events:\s*none/.test(msCss), '.ms-quota-line must have pointer-events: none');
    assert.ok(/\.ms-quota-dot\s*\{[^}]*pointer-events:\s*none/.test(msCss), '.ms-quota-dot must have pointer-events: none');

    const egressCss = readRenderer('egress.css');
    assert.ok(!egressCss.includes('var(--bad'), 'egress.css must use var(--danger) instead of undefined --bad');
    assert.ok(egressCss.includes('.egress-loading::before'), 'egress.css reduced motion must disable spinner animation');

    const askCss = readRenderer('desk-pet-ask.css');
    assert.ok(/body\.ak-body\s*\{[^}]*overflow-y:\s*auto/.test(askCss), 'desk-pet-ask.css must allow vertical scroll on tall prompts');

    const trayCss = readRenderer('tray-panel.css');
    assert.ok(/\.tp-options\s*\{[^}]*max-height:\s*168px/.test(trayCss), 'tray-panel.css .tp-options must have bounded scroll height');
    assert.ok(trayCss.includes('.tp-avatar.deepseek') && trayCss.includes('.tp-avatar.pi'), 'tray-panel.css must style deepseek and pi avatars');

    const introCss = readRenderer('intro.css');
    assert.ok(/\.tour-card\s*\{[^}]*overflow-y:\s*auto/.test(introCss), 'intro.css .tour-card must scroll on short viewports');

    const dsCss = readRenderer('deepseek-balance.css');
    assert.ok(dsCss.includes('var(--titlebar-h)'), 'deepseek-balance.css modal height must account for --titlebar-h');
  });

  // 9. Provider, quota, sessions, and tokens-ci behavioral invariants
  await check('provider/quota/sessions/tokens-ci structural regression invariants', () => {
    const agentJs = readRenderer('agent-switch.js');
    assert.ok(agentJs.includes("if (app === 'deepseek')"), 'agent-switch.js buildPreview must handle deepseek');
    assert.ok(agentJs.includes("'data-slot-field': 'model'") && agentJs.includes('[data-slot-field="name"]'), 'agent-switch.js must query slot inputs via data-slot-field, not localized placeholder');
    assert.ok(!agentJs.includes("step: '1000'"), 'agent-switch.js Codex context inputs must allow exact integer step=1');
    assert.ok(agentJs.includes('s.providerStale, s.modelSwap, s.models'), 'prismKey must include providerStale, modelSwap, models');

    const poolJs = readRenderer('pool-quota.js');
    assert.ok(poolJs.includes("item.type === 'account' && item.id === member.id"), 'pool-quota.js must match members by type+id, not undefined member.key');
    assert.ok(poolJs.includes("days <= 0 ? '已用完'"), 'pool-quota.js daysText must handle <= 0');

    const sessionsJs = readRenderer('sessions.js');
    assert.ok(sessionsJs.includes("node?.closest('[hidden]')"), 'sessions.js markHit/scrollToHit must expand collapsed hidden tool groups');
    assert.ok(sessionsJs.includes('S.detailSeq') && sessionsJs.includes('S.detailError'), 'sessions.js select must sequence requests and show retry on error');

    const tokensJs = readRenderer('tokens-ci.js');
    assert.ok(tokensJs.includes("checking = state.running === 'check';"), 'tokens-ci.js envStep must not treat unchecked as perpetually checking');
    assert.ok(tokensJs.includes('if (!state) return;'), 'tokens-ci.js openWizard must guard null state');

    const dsJs = readRenderer('deepseek-balance.js');
    assert.ok(dsJs.includes('Promise.allSettled'), 'deepseek-balance.js multi-account refresh must use Promise.allSettled + api.state()');
    assert.ok(dsJs.includes("days <= 0 ? '已用完'"), 'deepseek-balance.js daysText must handle <= 0');

    const agyJs = readRenderer('antigravity-quota.js');
    assert.ok(agyJs.includes("windowKind === 'week' ? (group?.week || groupInsightOf(group)?.week)"), 'antigravity-quota.js forecast/forecastText must resolve fallback week from insight');
    assert.ok(agyJs.includes('const any = Boolean(ins.d30?.requests > 0'), 'antigravity-quota.js localUsage must not leak other accounts when insight exists with zero requests');
  });

  console.log(`\nALL ${results.length} FRONTEND AUDIT CHECKS PASSED`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
