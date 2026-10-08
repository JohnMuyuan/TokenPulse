'use strict';
/*
 * tokens.ci 自动上传（0.3.38）：用量明细上方的一条状态栏，加上第一次用时的设置向导。
 * 真正的计时和执行都在主进程（src/main/tokens-ci.ts），这里只负责显示和把用户的选择交过去。
 *
 * - 没设置过：一张介绍卡，「开始设置」或「不需要」（不需要就不再出现，设置 → 数据里还能打开）。
 * - 设置向导四步：检查运行环境 → 账号（已登录就跳过；没登录先选公开 / 隐私，不预先选中）→ 预览会传什么 → 间隔和启动时上传。
 * - 设置好了：状态栏写上次 / 下次、每隔多久，按钮是立即上传、预览、设置。
 * - 演示模式（新手引导）不显示。
 */
(() => {
  const api = window.tokenpulse?.tokensCi;
  const host = document.getElementById('tokens-ci');
  if (!api || !host) return;
  const lang = () => window.PulseI18n?.lang() === 'en' ? 'en' : 'zh';
  const locale = () => lang() === 'en' ? 'en-US' : 'zh-CN';
  const NODE_URL = 'https://nodejs.org/';
  const SITE_URL = 'https://tokens.ci/';
  let state = null, seenRun = null, wizard = null;

  const clock = at => {
    const day = new Date(at);
    const sameDay = day.toDateString() === new Date().toDateString();
    return sameDay ? day.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : day.toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const every = minutes => minutes % 1440 === 0 ? '每天' : minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  const button = (text, onClick, { cls = 'btn', glyph = null, action = null, disabled = false } = {}) => {
    const node = el('button', { type: 'button', class: cls, 'data-action': action, disabled: disabled ? '' : null }, [glyph ? icon(glyph) : null, el('span', { text })]);
    node.addEventListener('click', onClick);
    return node;
  };
  const call = async (work, failText) => {
    try { const next = await work(); if (next) apply(next); return next; }
    catch (error) { toast(failText + (error?.message ? `：${String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}` : ''), { kind: 'error' }); return null; }
  };
  const copy = async (text, label) => { try { await navigator.clipboard.writeText(text); toast(`已复制${label}`); } catch { toast('复制失败，请手动选中复制', { kind: 'error' }); } };

  /* ---------------- 用量明细里的状态栏 ---------------- */

  function render() {
    const demo = window.tokenpulse?.isDemo?.();
    const s = state?.settings;
    const setUp = s && (s.enabled || s.version || s.lastRunAt);
    if (!state || demo || (!s.enabled && s.dismissed)) { host.hidden = true; host.replaceChildren(); return; }
    host.hidden = false;
    if (!setUp) {
      host.className = 'panel tokens-ci tokens-ci-intro';
      host.replaceChildren(
        el('div', { class: 'tokens-ci-mark', 'aria-hidden': 'true' }, [icon('up')]),
        el('div', { class: 'tokens-ci-body' }, [
          el('b', { text: '把用量自动上传到 tokens.ci' }),
          el('p', { text: 'tokens.ci 是一个 AI 编程用量排行榜。TokenPulse 可以按你设的间隔替你运行它的官方工具上传，不用每天手动传。上传的只有 Token 数、型号和时间，不含对话内容。' }),
        ]),
        el('div', { class: 'tokens-ci-actions' }, [
          button('开始设置', () => openWizard('env'), { cls: 'btn btn-accent', action: 'tokens-setup' }),
          button('不需要', () => call(() => api.save({ dismissed: true }), '保存失败'), { action: 'tokens-dismiss' }),
        ]));
      return;
    }
    const running = state.running === 'submit', last = state.last;
    let status, tone = '';
    if (running) status = '正在上传…';
    else if (s.enabled && state.paused) { status = 'tokens.ci 登录已失效，自动上传已暂停'; tone = 'bad'; }
    else if (s.enabled && !state.loggedIn) { status = '还没有登录 tokens.ci，自动上传不会进行'; tone = 'bad'; }
    else if (last && !last.ok) { status = `上次 ${clock(last.at)} 上传失败：${last.error || '原因未知'}`; tone = 'bad'; }
    else if (last) status = `上次 ${clock(last.at)} 已上传`;
    else status = '还没有上传过';
    const plan = !s.enabled ? '自动上传已关闭' : [every(s.intervalMin), state.nextAt && !running ? `下次 ${clock(Math.max(state.nextAt, Date.now()))}` : null].filter(Boolean).join(' · ');
    const signIn = s.enabled && (state.paused || !state.loggedIn);
    host.className = 'panel tokens-ci tokens-ci-strip' + (tone ? ' ' + tone : '');
    host.replaceChildren(
      el('div', { class: 'tokens-ci-mark', 'aria-hidden': 'true' }, [icon('up')]),
      el('div', { class: 'tokens-ci-body' }, [
        el('b', {}, ['tokens.ci 上传', s.username ? el('span', { class: 'tokens-ci-user', translate: 'no', text: '@' + s.username }) : null]),
        el('p', { class: 'tokens-ci-status', role: 'status' }, [running ? el('span', { class: 'tokens-ci-spin', 'aria-hidden': 'true' }) : null, el('span', { text: status }), el('span', { class: 'tokens-ci-plan', text: plan })]),
      ]),
      el('div', { class: 'tokens-ci-actions' }, [
        signIn ? button('重新登录', () => openWizard('account'), { cls: 'btn btn-accent', action: 'tokens-relogin' })
          : !s.enabled ? button('开启', () => openWizard('schedule'), { cls: 'btn btn-accent', action: 'tokens-enable' })
            : button(running ? '正在上传…' : '立即上传', () => call(() => api.upload(), '上传失败'), { cls: 'btn btn-accent', glyph: 'up', action: 'tokens-upload', disabled: !!state.running }),
        button('预览', () => openWizard('preview', { single: true }), { action: 'tokens-preview', disabled: !!state.running && state.running !== 'preview' }),
        button('设置', () => openWizard('settings'), { glyph: 'settings', action: 'tokens-settings' }),
      ]));
  }

  /** 上传有了新结果：手动的告诉一声成功 / 失败；自动的只在连续失败的第一次提醒（之后状态栏上一直写着）。 */
  function announce() {
    const last = state?.last;
    // 打开软件时已有的结果不算新的
    if (seenRun === null) { seenRun = last?.at ?? 0; return; }
    if (!last || last.at === seenRun) return;
    seenRun = last.at;
    if (last.ok && last.trigger === 'manual') toast('已上传到 tokens.ci');
    else if (!last.ok && (last.trigger === 'manual' || state.failures === 1)) toast(`tokens.ci 上传失败：${last.error || '原因未知'}`, { kind: 'error' });
  }

  function apply(next) {
    state = next;
    announce();
    render();
    if (wizard) drawWizard();
  }

  /* ---------------- 设置向导 / 设置 ---------------- */

  const STEPS = [['env', '运行环境'], ['account', '账号'], ['preview', '预览'], ['schedule', '自动上传']];

  function openWizard(step, { single = false } = {}) {
    closeWizard(true);
    const overlay = el('div', { class: 'modal tokens-ci-modal', id: 'tokens-ci-dialog' });
    const card = el('section', { class: 'modal-card tokens-ci-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tokens-ci-title' });
    overlay.append(card);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeWizard(); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeWizard(); } });
    document.body.append(overlay);
    document.body.classList.add('modal-open');
    for (const selector of ['.workspace', '.sidebar']) { const node = document.querySelector(selector); if (node) node.inert = true; }
    const s = state?.settings || {};
    wizard = { overlay, card, step, single, from: step, relogin: step === 'account', lastFocus: document.activeElement, privacy: null, interval: s.intervalMin || 60, onLaunch: s.onLaunch !== false, channel: s.channel || 'pinned' };
    if (step === 'env' && !state?.tools?.checked) call(() => api.check(), '检查失败');
    drawWizard();
    card.querySelector('button, input, select')?.focus();
  }
  function closeWizard(silent = false) {
    if (!wizard) return;
    const { overlay, lastFocus } = wizard;
    // 登录还在等浏览器授权就关了窗口：停掉登录，不在后台挂着
    if (!silent && state?.running === 'login') api.cancel();
    if (state?.login) api.clearLogin();
    if (state?.preview) api.clearPreview();
    wizard = null;
    overlay.remove();
    if (!document.querySelector('.modal:not([hidden])')) {
      document.body.classList.remove('modal-open');
      for (const selector of ['.workspace', '.sidebar']) { const node = document.querySelector(selector); if (node) node.inert = false; }
    }
    lastFocus?.focus?.();
  }
  function go(step) { wizard.step = step; if (step === 'env' && !state?.tools?.checked) call(() => api.check(), '检查失败'); drawWizard(); wizard.card.querySelector('.tokens-ci-step button, .tokens-ci-step input')?.focus(); }

  function drawWizard() {
    if (!wizard || !state) return;
    const { card, step, single } = wizard;
    const settingsView = step === 'settings';
    const title = settingsView ? 'tokens.ci 上传设置' : single ? '预览会上传什么' : '设置 tokens.ci 自动上传';
    const head = el('header', { class: 'tokens-ci-head' }, [
      el('div', {}, [el('h2', { id: 'tokens-ci-title', text: title }), el('p', { text: 'TokenPulse 按你设的间隔运行 tokens.ci 的官方工具上传，定时完全由 TokenPulse 管，不往系统里加计划任务。' })]),
      (() => { const close = el('button', { type: 'button', class: 'icon-circle', 'aria-label': '关闭', 'data-action': 'tokens-close' }, [icon('close')]); close.addEventListener('click', () => closeWizard()); return close; })(),
    ]);
    const steps = settingsView || single ? null : el('ol', { class: 'tokens-ci-steps' }, STEPS.map(([id, label], i) => el('li', { class: id === step ? 'on' : STEPS.findIndex(([x]) => x === step) > i ? 'done' : '' }, [el('span', { text: String(i + 1) }), el('b', { text: label })])));
    const body = { env: envStep, account: accountStep, preview: previewStep, schedule: scheduleStep, settings: settingsStep }[step]();
    const focused = document.activeElement && card.contains(document.activeElement) ? document.activeElement.dataset.action || document.activeElement.name : null;
    card.replaceChildren(...[head, steps, el('div', { class: 'tokens-ci-step' }, body)].filter(Boolean));
    if (focused) (card.querySelector(`[data-action="${focused}"]`) || card.querySelector(`[name="${focused}"]`))?.focus();
  }
  const footer = (...buttons) => el('div', { class: 'tokens-ci-foot' }, buttons.filter(Boolean));
  const row = (ok, text, extra) => el('li', { class: ok === null ? 'wait' : ok ? 'ok' : 'bad' }, [el('span', { class: 'tokens-ci-dot', 'aria-hidden': 'true' }), el('span', { text }), extra || null]);

  function envStep() {
    const tools = state.tools, checking = state.running === 'check' || !tools.checked;
    const s = state.settings;
    const version = s.channel === 'installed' ? '本机安装的 tokens 命令' : s.channel === 'latest' ? 'tokens-cli 最新版（每次运行都用最新的）' : s.version ? `tokens-cli ${s.version}（固定版本，不会自己换成新代码）` : '';
    const ready = !checking && tools.npx && (s.channel !== 'pinned' || s.version);
    return [
      el('p', { class: 'tokens-ci-lead', text: 'tokens.ci 的工具要靠 Node.js 运行。先看看这台电脑能不能跑。' }),
      el('ul', { class: 'tokens-ci-checks' }, [
        row(checking ? null : tools.npx, checking ? '正在检查 Node.js（npx）…' : tools.npx ? '已找到 Node.js（npx）' : '没有找到 Node.js（npx）'),
        checking ? null : row(!!version, version ? `将使用 ${version}` : tools.error || '查不到 tokens-cli 的版本'),
      ]),
      !checking && !tools.npx ? el('p', { class: 'tokens-ci-hint', text: '请先安装 Node.js（选 LTS 版本），装好后点「重新检查」。用 Claude Code 或 Codex 的电脑一般已经装过。' }) : null,
      footer(
        !checking && !tools.npx ? button('下载 Node.js', () => api.open(NODE_URL), { glyph: 'external', action: 'tokens-node' }) : null,
        button('重新检查', () => call(() => api.check(), '检查失败'), { action: 'tokens-recheck', disabled: checking }),
        button('下一步', () => go('account'), { cls: 'btn btn-accent', action: 'tokens-next', disabled: !ready }),
      ),
    ];
  }

  function accountStep() {
    const login = state.login;
    if (login && !login.done) {
      return [
        el('p', { class: 'tokens-ci-lead', text: '浏览器已经打开 tokens.ci 的授权页。用 GitHub 登录后，输入下面这个码：' }),
        el('div', { class: 'tokens-ci-code' }, [
          el('code', { translate: 'no', text: login.code || '……' }),
          login.code ? button('复制', () => copy(login.code, '登录码'), { glyph: 'copy', action: 'tokens-copy-code' }) : null,
        ]),
        el('p', { class: 'tokens-ci-hint' }, [el('span', { class: 'tokens-ci-spin', 'aria-hidden': 'true' }), el('span', { text: ' 正在等你在浏览器里授权，完成后这里会自动继续。浏览器没打开的话，点「打开授权页」。' })]),
        footer(
          login.url ? button('打开授权页', () => api.open(login.url), { glyph: 'external', action: 'tokens-open-auth' }) : null,
          button('取消', () => api.cancel(), { action: 'tokens-cancel-login' }),
        ),
      ];
    }
    if (login?.done && login.ok) {
      return [
        el('p', { class: 'tokens-ci-lead tokens-ci-good', text: '已登录 tokens.ci' + (state.settings.username ? ` · @${state.settings.username}` : '') }),
        login.readToken ? el('div', { class: 'tokens-ci-token' }, [
          el('b', { text: '隐私模式的只读令牌' }),
          el('p', { text: '用它才能看到你自己的隐私数据（比如在 iOS App 里）。它只显示这一次，TokenPulse 不会保存，请自己存好。' }),
          el('div', { class: 'tokens-ci-code' }, [el('code', { translate: 'no', text: login.readToken }), button('复制', () => copy(login.readToken, '只读令牌'), { glyph: 'copy', action: 'tokens-copy-token' })]),
        ]) : null,
        footer(afterLogin()),
      ];
    }
    if (state.loggedIn && !state.paused && !login && !wizard.relogin) {
      return [
        el('p', { class: 'tokens-ci-lead tokens-ci-good', text: '这台电脑已经登录过 tokens.ci' + (state.settings.username ? ` · @${state.settings.username}` : '') }),
        el('p', { class: 'tokens-ci-hint', text: '登录信息保存在 tokens.ci 工具自己的文件里，TokenPulse 只看它在不在，不读内容。想换账号可以重新登录。' }),
        footer(
          button('重新登录', () => { wizard.relogin = true; drawWizard(); }, { action: 'tokens-switch-account' }),
          afterLogin(),
        ),
      ];
    }
    return choosePrivacy(login);
  }
  /** 账号这一步之后去哪：设置向导接着预览；从设置里来的回设置；从状态栏「重新登录」来的就结束。 */
  function afterLogin() {
    const back = wizard.from === 'settings', done = wizard.from === 'account';
    return button(done ? '完成' : back ? '返回设置' : '下一步', () => {
      if (state.login) api.clearLogin();
      wizard.relogin = false;
      // 从状态栏「重新登录」进来的：登录好了马上补传一次，状态栏不再挂着上次「登录已失效」的失败
      if (done) { closeWizard(); if (state.settings.enabled && state.loggedIn) call(() => api.upload(), '上传失败'); }
      else go(back ? 'settings' : 'preview');
    }, { cls: 'btn btn-accent', action: 'tokens-next' });
  }
  function choosePrivacy(login) {
    const option = (value, title, text) => {
      const input = el('input', { type: 'radio', name: 'tokens-privacy', value, checked: wizard.privacy === value ? '' : null });
      input.addEventListener('change', () => { wizard.privacy = value; drawWizard(); });
      return el('label', { class: 'tokens-ci-choice' + (wizard.privacy === value ? ' on' : '') }, [input, el('span', {}, [el('b', { text: title }), el('small', { text })])]);
    };
    return [
      el('p', { class: 'tokens-ci-lead', text: 'tokens.ci 默认会把你放进公开排行榜。登录前先选一个：' }),
      el('div', { class: 'tokens-ci-choices', role: 'radiogroup', 'aria-label': '公开还是隐私' }, [
        option('public', '公开上榜', '排行榜和你的主页上能看到你的 GitHub 用户名、排名和用量（设备名会打码）。'),
        option('private', '隐私模式', '不上榜，主页、设备和徽章对别人来说就像不存在，只有你自己能看。以后可以在 tokens.ci 的设置里改成公开。'),
      ]),
      login?.done && !login.ok ? el('p', { class: 'tokens-ci-hint tokens-ci-bad', role: 'alert', text: login.error || '登录没有成功' }) : null,
      el('p', { class: 'tokens-ci-hint', text: '点登录后浏览器会打开 tokens.ci 的授权页，用 GitHub 登录并输入 TokenPulse 显示的码即可，不用打开终端。' }),
      footer(
        state.loggedIn && !state.paused ? button('返回', () => { wizard.relogin = false; drawWizard(); }, { action: 'tokens-back' }) : null,
        button('登录 tokens.ci', () => { if (state.login) api.clearLogin(); call(() => api.login(wizard.privacy), '登录失败'); }, { cls: 'btn btn-accent', glyph: 'external', action: 'tokens-login', disabled: !wizard.privacy || !!state.running }),
      ),
    ];
  }

  function previewStep() {
    const preview = state.preview, running = state.running === 'preview';
    return [
      el('p', { class: 'tokens-ci-lead', text: '用 tokens.ci 工具的「只看不传」模式跑一次，看看会上传什么。这一步不会上传。' }),
      preview ? el('pre', { class: 'tokens-ci-output' + (preview.ok ? '' : ' bad'), translate: 'no', tabindex: '0', text: preview.output || '（没有输出）' })
        : running ? el('p', { class: 'tokens-ci-hint' }, [el('span', { class: 'tokens-ci-spin', 'aria-hidden': 'true' }), el('span', { text: ' 正在扫描本机的会话，第一次可能要一两分钟（npx 还要先下载工具）…' })]) : null,
      footer(
        button(preview ? '重新预览' : '生成预览', () => call(() => api.preview(), '预览失败'), { action: 'tokens-run-preview', disabled: !!state.running }),
        wizard.single ? button('关闭', () => closeWizard(), { cls: 'btn btn-accent', action: 'tokens-close-preview' })
          : button(preview ? '下一步' : '跳过预览', () => go('schedule'), { cls: 'btn btn-accent', action: 'tokens-next', disabled: running }),
      ),
    ];
  }

  /** 间隔：数字 + 单位（分钟 / 小时），最少 10 分钟，最多一天。 */
  function intervalField() {
    const minutes = wizard.interval;
    const hours = minutes % 60 === 0;
    const amount = el('input', { type: 'number', name: 'tokens-interval', min: hours ? '1' : '10', max: hours ? '24' : '1440', step: '1', value: String(hours ? minutes / 60 : minutes), 'aria-label': '间隔' });
    const unit = el('select', { name: 'tokens-unit', 'aria-label': '单位' }, [el('option', { value: 'min', text: '分钟', selected: hours ? null : '' }), el('option', { value: 'hour', text: '小时', selected: hours ? '' : null })]);
    const sync = () => {
      const value = Math.round(Number(amount.value) || 0) * (unit.value === 'hour' ? 60 : 1);
      wizard.interval = Math.min(1440, Math.max(10, value || 60));
    };
    amount.addEventListener('change', () => { sync(); drawWizard(); });
    unit.addEventListener('change', () => { sync(); drawWizard(); });
    const launch = el('input', { type: 'checkbox', name: 'tokens-launch', checked: wizard.onLaunch ? '' : null });
    launch.addEventListener('change', () => { wizard.onLaunch = launch.checked; });
    return [
      el('label', { class: 'tokens-ci-field' }, [el('span', { text: '每隔' }), amount, unit, el('small', { text: `最少 10 分钟，最多一天一次。现在是${every(wizard.interval)}。` })]),
      el('label', { class: 'tokens-ci-check' }, [launch, el('span', { text: '每次打开 TokenPulse 时先上传一次' })]),
    ];
  }

  function scheduleStep() {
    return [
      el('p', { class: 'tokens-ci-lead', text: '多久上传一次？TokenPulse 在运行（包括收在托盘里）时按这个间隔上传；关掉 TokenPulse 就不传。' }),
      ...intervalField(),
      footer(
        button('上一步', () => go('preview'), { action: 'tokens-prev' }),
        button('开启并立即上传', async () => {
          const saved = await call(() => api.save({ enabled: true, intervalMin: wizard.interval, onLaunch: wizard.onLaunch, dismissed: false }), '保存失败');
          if (!saved) return;
          closeWizard();
          call(() => api.upload(), '上传失败');
        }, { cls: 'btn btn-accent', glyph: 'up', action: 'tokens-finish', disabled: !!state.running }),
      ),
    ];
  }

  function settingsStep() {
    const s = state.settings, tools = state.tools;
    const channel = (value, title, text) => {
      const input = el('input', { type: 'radio', name: 'tokens-channel', value, checked: wizard.channel === value ? '' : null });
      input.addEventListener('change', () => { wizard.channel = value; drawWizard(); });
      return el('label', { class: 'tokens-ci-choice' + (wizard.channel === value ? ' on' : '') }, [input, el('span', {}, [el('b', { text: title }), el('small', { text })])]);
    };
    const newer = tools.latest && s.version && tools.latest !== s.version;
    const enabled = el('input', { type: 'checkbox', name: 'tokens-enabled', checked: s.enabled ? '' : null });
    enabled.addEventListener('change', () => call(() => api.save({ enabled: enabled.checked }), '保存失败'));
    const lastOutput = state.last?.output ? el('details', { class: 'tokens-ci-last' }, [el('summary', { text: `最近一次上传的输出（${clock(state.last.at)}）` }), el('pre', { class: 'tokens-ci-output', translate: 'no', text: state.last.output })]) : null;
    return [
      el('label', { class: 'tokens-ci-check tokens-ci-master' }, [enabled, el('span', { text: '自动上传' })]),
      ...intervalField(),
      el('div', { class: 'tokens-ci-section' }, [
        el('b', { text: '用哪个版本的 tokens.ci 工具' }),
        el('div', { class: 'tokens-ci-choices' }, [
          channel('pinned', `固定版本${s.version ? ' ' + s.version : ''}（推荐）`, '每次都用同一个版本，不会自己换成新代码；有新版时这里会提示，你点了才换。'),
          channel('latest', '总是用最新版', '和 npx tokens-cli@latest 一样，每次运行都会下载最新版。'),
          tools.installed || s.channel === 'installed' ? channel('installed', '本机安装的 tokens 命令', '用你自己装好的 tokens（比如 npm i -g tokens-cli），升级由你自己负责。') : null,
        ]),
        el('div', { class: 'tokens-ci-inline' }, [
          button(state.running === 'check' ? '正在检查…' : '检查新版本', () => call(() => api.check(), '检查失败'), { action: 'tokens-check-version', disabled: !!state.running }),
          newer ? el('span', { text: `有新版本 ${tools.latest}` }) : tools.checked && tools.latest ? el('span', { class: 'muted', text: '已经是最新版' }) : null,
          newer ? button(`换成 ${tools.latest}`, () => call(() => api.useLatest(), '保存失败'), { action: 'tokens-use-latest' }) : null,
        ]),
      ]),
      el('div', { class: 'tokens-ci-section' }, [
        el('b', { text: '账号' }),
        state.loggedIn
          ? el('p', { class: 'tokens-ci-hint' }, [el('b', { text: '已登录 tokens.ci' + (s.username ? ` · @${s.username}` : '') }), ' ', el('span', { text: '登录信息在 tokens.ci 工具自己的文件里，TokenPulse 不读内容。' })])
          : el('p', { class: 'tokens-ci-hint', text: '还没有登录 tokens.ci。' }),
        el('div', { class: 'tokens-ci-inline' }, [
          button(state.loggedIn ? '换个账号 / 重新登录' : '登录 tokens.ci', () => { wizard.relogin = true; go('account'); }, { action: 'tokens-account' }),
          button('打开 tokens.ci', () => api.open(SITE_URL), { glyph: 'external', action: 'tokens-site' }),
        ]),
      ]),
      lastOutput,
      footer(
        button('不在用量明细里显示', () => { call(() => api.save({ enabled: false, dismissed: true }), '保存失败'); closeWizard(); }, { action: 'tokens-hide' }),
        button('保存', async () => { if (await call(() => api.save({ intervalMin: wizard.interval, onLaunch: wizard.onLaunch, channel: wizard.channel }), '保存失败')) { toast('设置已保存'); closeWizard(); } }, { cls: 'btn btn-accent', action: 'tokens-save' }),
      ),
    ];
  }

  /* ---------------- 启动 ---------------- */

  api.onState(apply);
  api.state().then(apply).catch(() => {});
  // 「下次」的时间每分钟刷新一下；进出演示模式时 app.js 的 render 会调 refresh
  setInterval(() => { if (state && !document.hidden) render(); }, 60_000);
  document.getElementById('open-tokens-ci')?.addEventListener('click', async () => {
    await call(() => api.save({ dismissed: false }), '保存失败');
    window.closeModal?.('settings');
    window.navigate?.('usage');
    openWizard(state?.settings?.enabled || state?.settings?.version ? 'settings' : 'env');
  });
  window.PulseTokensCi = { open: openWizard, state: () => state, refresh: render };
})();
