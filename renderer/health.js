/*
 * 体检页（0.3.55）：把工具配置、本地路由、官方账号续期、网络和出口、数据目录集中检查一遍。
 *
 * 判断在主进程（src/core/health-check.ts，读状态在 src/main/health.ts），这里只管展示。
 * 体检只读、不改配置：有问题的项给一个「去哪一页处理」的按钮。
 * 用到 app.js 里的公共函数（el / icon / $ / api / navigate / openSettings / number），所以要在它后面加载。
 */
(function () {
  const STALE_MS = 5 * 60_000;
  const GROUPS = [['tools', '工具配置', 'route'], ['accounts', '官方账号', 'user'], ['network', '网络', 'globe'], ['data', '数据', 'folder']];
  const LEVEL = { bad: ['有问题', 'alert'], warn: ['建议看看', 'alert'], info: ['提示', 'info'], ok: ['正常', 'check'] };
  const ORDER = { bad: 0, warn: 1, info: 2, ok: 3 };
  const S = { report: null, running: false, error: '' };
  let built = false;
  const N = {};

  function build() {
    if (built) return;
    built = true;
    N.run = el('button', { type: 'button', class: 'btn btn-accent hc-run', 'data-action': 'run' }, [icon('refresh'), el('span', { text: '重新体检' })]);
    N.run.addEventListener('click', () => run());
    N.summary = el('div', { class: 'hc-summary', role: 'status', 'aria-live': 'polite' });
    N.groups = el('div', { class: 'hc-groups' });
    $('page-health').replaceChildren(el('div', { class: 'panel hc-head' }, [N.summary, N.run]), N.groups);
    N.groups.addEventListener('click', event => {
      const hit = event.target.closest('[data-go-page], [data-go-settings]');
      if (!hit) return;
      if (hit.dataset.goSettings) openSettings(hit.dataset.goSettings);
      else navigate(hit.dataset.goPage);
    });
  }

  function time(at) {
    return new Date(at).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function drawSummary() {
    const r = S.report;
    N.run.disabled = S.running;
    N.run.classList.toggle('is-busy', S.running);
    if (S.running && !r) { N.summary.replaceChildren(el('span', { class: 'sw-spinner' }), el('b', { text: '正在体检…' }), el('small', { text: '要连一下三家官方地址，最多十几秒' })); return; }
    if (S.error && !r) { N.summary.replaceChildren(el('b', { class: 'hc-bad-text', text: S.error })); return; }
    if (!r) { N.summary.replaceChildren(); return; }
    const { bad, warn } = r.summary;
    const verdict = bad ? `有 ${number(bad)} 项需要处理` : warn ? `有 ${number(warn)} 项建议看看` : '一切正常';
    const level = bad ? 'bad' : warn ? 'warn' : 'ok';
    N.summary.replaceChildren(
      el('span', { class: `hc-badge ${level}` }, [icon(level === 'ok' ? 'check' : 'alert')]),
      el('div', { class: 'hc-verdict' }, [
        el('b', { text: S.running ? '正在重新体检…' : verdict }),
        el('small', { text: `${time(r.at)} 检查 · 用了 ${(r.ms / 1000).toFixed(1)} 秒 · 有问题 ${number(bad)} · 建议看看 ${number(warn)} · 正常 ${number(r.summary.ok)}` })
      ])
    );
  }

  function itemRow(item) {
    const [label, iconName] = LEVEL[item.level];
    const action = item.action
      ? el('button', { type: 'button', class: 'btn hc-go', ...(item.action.settings ? { 'data-go-settings': item.action.settings } : { 'data-go-page': item.action.page }) }, [el('span', { text: item.action.label }), icon('right')])
      : null;
    return el('div', { class: `hc-item ${item.level}`, 'data-health-item': item.id }, [
      el('span', { class: `hc-dot ${item.level}`, title: label, 'aria-label': label }, [icon(iconName)]),
      el('div', { class: 'hc-text' }, [
        el('b', { text: item.title }),
        item.detail ? el('p', { text: item.detail }) : null,
        item.lines?.length ? el('ul', { class: 'hc-lines' }, item.lines.map(line => el('li', { text: line }))) : null
      ]),
      action
    ]);
  }

  function drawGroups() {
    const r = S.report;
    if (!r) { N.groups.replaceChildren(); return; }
    N.groups.replaceChildren(...GROUPS.map(([key, title, iconName]) => {
      const items = r.items.filter(item => item.group === key).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
      if (!items.length) return null;
      const worst = items[0].level;
      return el('section', { class: 'panel hc-group', 'data-health-group': key }, [
        el('div', { class: 'panel-heading' }, [el('h2', {}, [icon(iconName), title]), el('span', { class: `section-tag hc-tag ${worst}`, text: LEVEL[worst][0] })]),
        el('div', { class: 'hc-items' }, items.map(itemRow))
      ]);
    }));
  }

  function syncNav() {
    const alert = $('nav-health-alert');
    if (alert) alert.hidden = !(S.report?.summary.bad > 0);
  }

  async function run() {
    if (S.running) return;
    S.running = true; S.error = '';
    drawSummary();
    try {
      S.report = await api.runHealthCheck();
    } catch (error) {
      S.error = '体检没做完，请重试。';
      showStatus(S.error, true);
    } finally {
      S.running = false;
      drawSummary(); drawGroups(); syncNav();
    }
  }

  window.PulseHealth = {
    show() {
      build();
      drawSummary(); drawGroups();
      if (!S.running && (!S.report || Date.now() - S.report.at > STALE_MS)) run();
    }
  };
})();
