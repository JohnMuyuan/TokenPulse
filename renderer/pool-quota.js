'use strict';
/*
 * 额度详情的号池页（0.3.44）。号池是供应商页里建的：同一个工具的几个官方账号 / API Key 轮流用。
 * 每个号池在额度详情顶上有自己的标签（和官方账号、DeepSeek 并排，key 是 pool:<号池 id>），点进去看这个号池整体用了多少：
 * 总额度（官方账号成员的剩余加起来、还能用多久）→ 用量和用了多久 → 成员分摊 → 最近 24 小时 / 30 天 → 时间线 → 模型速度 → 模型 → 最近的请求。
 * 数字在主进程的 worker 里算（src/core/pool-insight.ts），来自号池的转发记录和官方账号成员的额度采样。
 * 标签和页面由 app.js 的 drawAccountTabs / renderQuota 调这里的 tabs() / renderQuota()。演示模式（新手引导）不显示。
 */
(() => {
  const api = window.tokenpulse?.poolInsight;
  if (!api) return;
  const PREFIX = 'pool';
  const ORDER_KEY = 'tokenpulse-pool-tabs';
  const APP = {
    claude: { name: 'Claude Code', kind: 'claude', brand: 'claude' },
    codex: { name: 'Codex', kind: 'chatgpt', brand: 'openai' },
    grok: { name: 'Grok CLI', kind: 'grok', brand: 'grok' },
    deepseek: { name: 'DeepSeek Harness', kind: 'deepseek', brand: 'deepseek' },
  };
  const STRATEGY = { 'round-robin': '轮询', 'fill-first': '用满再换', 'reset-first': '快重置优先', 'most-left': '剩余最多' };
  const HUES = ['#4f7fd9', '#d9774f', '#10a37f', '#8b5cf6', '#c9832f', '#e05a8a', '#0ea5a4', '#65a30d'];
  const DAY = 86400000;
  // 供应商状态（agent-switch 推过来的整份，里面有号池和成员）；叫 agentView 不叫 view：app.js 里没有，但别的文件有同名的局部变量
  let agentView = null;
  const demo = () => Boolean(window.tokenpulse?.isDemo?.());
  const savedOrder = () => { try { const list = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
  /** 有成员的号池，按拖动标签排过的顺序；没排过的按供应商页的顺序跟在后面。 */
  function pools() {
    if (demo()) return [];
    const list = (agentView?.providers || []).filter(provider => provider.pool && provider.pool.members?.length);
    const order = savedOrder();
    const rank = provider => { const at = order.indexOf(provider.id); return at < 0 ? order.length + list.indexOf(provider) : at; };
    return [...list].sort((a, b) => rank(a) - rank(b));
  }
  const appOf = provider => APP[provider.app] || { name: provider.app, kind: provider.app, brand: provider.app };

  /* ---------------- 额度详情顶上的标签 ---------------- */

  function tabs() {
    return pools().map(provider => ({ key: PREFIX + ':' + provider.id, kind: PREFIX, who: provider.name + '|' + provider.app, provider }));
  }
  function tabButton(tab) {
    const app = appOf(tab.provider);
    return el('button', { type: 'button', 'data-account': tab.key, 'data-kind': PREFIX, 'data-pool': '', title: `${tab.provider.name} · ${app.name} 的号池` }, [
      el('span', { class: 'brand-glyph' }, [brandSvg(app.brand)]), '号池',
      el('small', { class: 'tab-who', text: tab.provider.name, translate: 'no' }),
    ]);
  }
  const owns = key => typeof key === 'string' && key.startsWith(PREFIX + ':') && tabs().some(tab => tab.key === key);
  /** 拖动标签之后存顺序（只记在本机，不改供应商页的顺序）。keys 是 pool:<id>。 */
  async function reorder(keys) {
    const ids = keys.map(key => String(key).slice(PREFIX.length + 1));
    const rest = savedOrder().filter(id => !ids.includes(id));
    try { localStorage.setItem(ORDER_KEY, JSON.stringify([...ids, ...rest])); } catch { /* 存不下来：这次的顺序到下次重画为止 */ }
  }

  /* ---------------- 数据 ---------------- */

  const summaries = new Map();
  const showing = id => typeof current !== 'undefined' && current && !document.getElementById('page-quota').hidden && state.account === PREFIX + ':' + id;
  /** 这个号池的汇总。本机刚扫过、号池刚转发过请求、或者过了一分钟才重新取；新的回来之前继续显示上一份。 */
  function summaryOf(provider) {
    const last = Math.max(0, ...provider.pool.members.map(member => member.lastAt || 0));
    const stamp = [typeof current !== 'undefined' ? current?.scannedAt || 0 : 0, last, provider.pool.members.length, Math.floor(Date.now() / 60000)].join('|');
    let entry = summaries.get(provider.id);
    if (!entry) summaries.set(provider.id, entry = { stamp: '', data: null, pending: false, failed: false });
    if (entry.stamp !== stamp && !entry.pending) {
      entry.pending = true;
      api.summary(provider.id).then(data => { entry.data = data; entry.failed = false; }).catch(() => { entry.failed = true; }).finally(() => {
        entry.pending = false; entry.stamp = stamp;
        if (showing(provider.id)) keepScroll(() => window.renderQuota());
      });
    }
    return entry;
  }

  /* ---------------- 小工具 ---------------- */

  const hideTip = () => { $('tip').hidden = true; };
  const tipOn = (node, text) => {
    node.addEventListener('pointermove', event => tipAt(text, event.clientX, event.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => { const box = node.getBoundingClientRect(); tipAt(text, box.x, box.y); });
    node.addEventListener('blur', hideTip);
    return node;
  };
  const span = (text, cls = null) => el('span', { class: cls, text });
  /** 用了多久：分钟、小时、天。 */
  function lasted(ms) {
    if (ms > 0 && ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
    const m = Math.round((ms || 0) / 60000);
    if (m < 60) return `${m} 分钟`;
    const h = Math.floor(m / 60), rest = m % 60;
    if (h < 24) return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
    const d = Math.floor(h / 24), hh = h % 24;
    return hh ? `${d} 天 ${hh} 小时` : `${d} 天`;
  }
  const daysText = days => days >= 365 ? '一年以上' : days >= 10 ? `${Math.round(days)} 天` : days >= 1 ? `${days.toFixed(1)} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
  const resetText = at => at ? `${date(at)} 重置` : '';
  const pct = value => value == null ? '—' : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
  const colorOf = (data, key) => { const i = data.members.findIndex(member => member.key === key); return HUES[(i < 0 ? data.members.length : i) % HUES.length]; };

  /** 每个官方账号成员一个小圆环（剩余越多环越满），双环 = 5 小时 + 每周。 */
  function memberRing(quota) {
    const five = quota?.fiveLeft != null ? { used: 100 - quota.fiveLeft } : null, week = quota?.weekLeft != null ? { used: 100 - quota.weekLeft } : null;
    const node = ring(five || week ? { five, week } : {});
    node.classList.add('pool-ring', 'pq-ring');
    node.removeAttribute('title');
    const left = quota ? (week ? quota.weekLeft : quota.fiveLeft) : null;
    node.append(el('div', { class: 'ring-center' }, [el('div', { class: 'quota-remaining' + (left == null ? ' empty-number' : ''), text: left == null ? '—' : left.toFixed(0) }, left == null ? [] : [el('small', { text: '%' })])]));
    return node;
  }

  /** 按成员叠起来的柱子。rows：{ at, tokens, requests, byMember, label, tick, current }。 */
  function stackChart(host, data, rows, animate) {
    host.replaceChildren();
    if (!rows.some(row => row.tokens > 0)) { host.append(empty('这段时间号池没有转发过请求。')); return; }
    const w = Math.max(280, host.clientWidth), h = host.clientHeight || 220, left = 48, bottom = 28, top = 14;
    const max = Math.max(1, ...rows.map(row => row.tokens));
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '号池用量柱状图，按成员分颜色' });
    for (let i = 0; i <= 2; i++) {
      const y = top + (h - top - bottom) * i / 2;
      node.append(svg('line', { class: 'grid', x1: left, x2: w - 5, y1: y, y2: y }));
      const label = svg('text', { class: 'axis', x: left - 9, y: y + 4, 'text-anchor': 'end' }); label.textContent = tokens(max * (1 - i / 2)); node.append(label);
    }
    const slot = (w - left - 8) / rows.length, barWidth = Math.max(.5, Math.min(slot * .62, 30));
    const names = new Map(data.members.map(member => [member.key, member.name]));
    rows.forEach((row, i) => {
      const x = left + i * slot + (slot - barWidth) / 2;
      const order = key => { const at = data.members.findIndex(member => member.key === key); return at < 0 ? data.members.length : at; };
      const parts = Object.entries(row.byMember || {}).filter(([, value]) => value > 0).sort((a, b) => order(a[0]) - order(b[0]));
      const text = [row.label, `${tokens(row.tokens)} Tokens · ${number(row.requests)} 次请求`, ...parts.map(([key, value]) => `${names.get(key) || key}：${tokens(value)}`)].join('\n');
      let y = h - bottom;
      const group = svg('g', { class: 'pq-stack' + (row.current ? ' today' : '') });
      group.style.animationDelay = `${Math.round(i * Math.min(16, 700 / rows.length))}ms`;
      for (const [key, value] of parts) {
        const height = Math.max(1, value / max * (h - top - bottom));
        y -= height;
        const rect = svg('rect', { class: 'pq-seg', x, y, width: barWidth, height });
        rect.style.fill = colorOf(data, key);
        group.append(rect);
      }
      const hit = svg('rect', { class: 'pq-hit', x: left + i * slot, y: top, width: slot, height: h - top - bottom, tabindex: 0, 'aria-label': text.replaceAll('\n', '，') });
      node.append(group, tipOn(hit, text));
      if (i % Math.max(1, Math.ceil(rows.length / 7)) === 0 || i === rows.length - 1) {
        const tick = svg('text', { class: 'axis', x: x + barWidth / 2, y: h - 6, 'text-anchor': 'middle' }); tick.textContent = row.tick; node.append(tick);
      }
    });
    host.append(node);
    playChart(host, animate);
  }
  const legend = data => el('div', { class: 'pq-legend' }, data.members.filter(member => member.tokens > 0).map(member => {
    const dot = el('i', { class: 'pq-dot', 'aria-hidden': 'true' }); dot.style.background = colorOf(data, member.key);
    return el('span', {}, [dot, el('span', { text: member.name, translate: 'no' })]);
  }));

  /** 占比条用成员自己的颜色，和图里一致。 */
  const memberTrack = (share, color) => { const bar = track(share, false, '占号池 Token 的比例'); bar.querySelector('.track-fill').style.background = color; return bar; };

  /* ---------------- 页面的各块 ---------------- */

  /** 号池总额度：官方账号成员的剩余加起来，折成「相当于几个号的周额度」，按最近 7 天的速度估计还能用多久。 */
  function quotaPanel(provider, data) {
    const panel = el('article', { class: 'panel window-panel pq-quota' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '号池总额度' }), el('span', { class: 'section-tag', text: '官方账号成员' })])]);
    const accounts = provider.pool.members.filter(member => member.type === 'account');
    if (!accounts.length) {
      panel.append(el('div', { class: 'empty pq-none' }, [el('p', { text: '这个号池里只有 API Key 成员，按量付费，没有订阅额度。' }), el('p', { text: '花了多少看右边的参考费用；第三方 Key 的余额可以在额度详情里单独添加。' })]));
      return panel;
    }
    const quota = data?.quota;
    const measured = quota?.measured || 0;
    panel.append(el('div', { class: 'window-number' }, [
      el('strong', { class: 'num', text: quota && measured ? quota.left.toFixed(quota.left >= 10 ? 0 : 1) : '—' }),
      el('span', { text: measured ? '个号的周额度还剩下' : '还没有查到成员的额度' }),
    ]));
    panel.append(el('div', { class: 'window-meta' }, [
      el('span', {}, [span(`${number(measured)} / ${number(accounts.length)} `, 'num'), span('个账号查到了额度')]),
      el('span', {}, [span('7 天用掉 '), span(quota ? `${quota.used7.toFixed(2)} 个号` : '—', 'num')]),
    ]));
    const daysLeft = quota?.daysLeft;
    panel.append(el('div', { class: 'prediction-line' + (daysLeft != null && daysLeft < 2 ? ' caution' : '') }, [icon(daysLeft != null && daysLeft < 2 ? 'alert' : 'trend'), daysLeft != null
      ? span(`按最近 7 天每天用掉 ${quota.perDay.toFixed(2)} 个号的速度，不算之后的重置，大约还能用 ${daysText(daysLeft)}`)
      : span(!data ? '正在读取…' : '额度采样还不够，或者最近 7 天额度没有涨，估不出还能用多久。')]));
    const rows = el('div', { class: 'pq-rings' }, accounts.map(member => {
      const info = data?.members.find(item => item.key === member.key)?.quota ?? member.quota ?? null;
      const lines = [info?.weekLeft != null ? `每周剩 ${pct(info.weekLeft)}` : '', info?.fiveLeft != null ? `5 小时剩 ${pct(info.fiveLeft)}` : ''].filter(Boolean);
      const node = el('div', { class: 'pq-ring-row' + (provider.pool.next === member.id ? ' next' : '') + (member.quota?.limited ? ' limited' : '') }, [
        memberRing(info),
        el('div', { class: 'pq-ring-copy' }, [
          el('b', { text: member.name, translate: 'no', title: member.name }),
          el('small', { text: lines.join(' · ') || '还没有额度数据' }),
          el('small', { class: 'pq-faint', text: info?.weekResetAt ? resetText(info.weekResetAt) : info?.fiveResetAt ? resetText(info.fiveResetAt) : '' }),
        ]),
        provider.pool.next === member.id ? el('span', { class: 'pv-member-next pq-next', text: '下一个' }) : member.quota?.limited ? el('span', { class: 'pq-limited', text: '刚被限流' }) : null,
      ]);
      return node;
    }));
    panel.append(rows);
    panel.append(el('p', { class: 'quota-footnote', text: '官方的百分比是整个账号的消耗，网页聊天、其他设备也算在里面，不只是这个号池转发的请求。「相当于几个号」= 各成员每周剩余的百分比加起来 ÷ 100。' }));
    return panel;
  }

  /** 未来 7 天的额度排法：使用主进程按最近 7 天速度算出的成员时段。 */
  function planPanel(provider, data) {
    const panel = el('article', { class: 'panel pq-plan' }, [el('div', { class: 'panel-heading' }, [
      el('h2', { text: '预排' }), el('span', { class: 'section-tag', text: `轮换方式：${STRATEGY[provider.pool.strategy] || provider.pool.strategy}` }),
    ])]);
    const plan = data?.plan;
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    const accounts = provider.pool.members.filter(member => member.type === 'account');
    const byId = new Map(accounts.map(member => [member.id, member]));
    const order = plan?.order || [];
    const next = el('div', { class: 'pq-plan-next' }, [span('接下来：')]);
    order.forEach((id, i) => {
      if (i) next.append(document.createTextNode(' → '));
      next.append(el('span', { class: 'pq-plan-order-name', text: byId.get(id)?.name || id, translate: 'no' }));
    });
    panel.append(next);
    if (!plan || plan.rate == null) {
      panel.append(el('p', { class: 'pq-plan-unknown', text: '用量数据还不够，先按重置时间排' }));
      return panel;
    }
    const now = plan?.now ?? data.now, end = now + 7 * DAY;
    const planMembers = plan?.members || [];
    const dateText = at => {
      const d = new Date(at), english = window.PulseI18n?.lang() === 'en';
      const days = english ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return `${days[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const exact = at => new Date(at).toLocaleString(window.PulseI18n?.lang() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const lanes = el('div', { class: 'pq-plan-lanes' }, accounts.map(member => {
      const item = planMembers.find(row => row.id === member.id);
      const resetAt = item?.resetAt ?? member.quota?.weekResetAt ?? null;
      const title = item?.waste == null ? '作废待估' : item.waste < 0.5 ? '用得完' : `重置时作废 ≈ ${Math.round(item.waste)}%`;
      const name = el('div', { class: 'pq-plan-member-name' }, [
        el('b', { text: member.name, translate: 'no', title: member.name }),
        el('small', { text: resetAt && resetAt <= end ? `${dateText(resetAt)} 重置` : item ? '7 天内不重置' : '暂无周额度数据' }),
      ]);
      const track = el('div', { class: 'pq-plan-track', title: member.name });
      for (const segment of (plan?.segments || []).filter(row => row.id === member.id)) {
        const from = Math.max(now, segment.from), to = Math.min(end, segment.to);
        if (to <= from) continue;
        const bar = el('i', { class: 'pq-plan-bar', title: `${member.name} · ${exact(from)} – ${exact(to)}` });
        bar.style.setProperty('--left', `${Math.max(0, (from - now) / (7 * DAY) * 100)}%`);
        bar.style.setProperty('--width', `${Math.max(.2, (to - from) / (7 * DAY) * 100)}%`);
        track.append(bar);
      }
      if (resetAt && resetAt >= now && resetAt <= end) {
        const tick = el('i', { class: 'pq-plan-reset', title: `${dateText(resetAt)} 重置 · ${exact(resetAt)}` });
        tick.style.setProperty('--at', `${(resetAt - now) / (7 * DAY) * 100}%`);
        track.append(tick);
      }
      if (item?.drainAt && item.drainAt >= now && item.drainAt <= end) {
        const drain = el('i', { class: 'pq-plan-drain', text: '×', title: `预计 ${exact(item.drainAt)} 用完` });
        drain.style.setProperty('--at', `${(item.drainAt - now) / (7 * DAY) * 100}%`);
        track.append(drain);
      }
      return el('div', { class: 'pq-plan-lane' }, [name, track, el('span', { class: 'pq-plan-waste', text: item ? title : '暂无周额度数据' })]);
    }));
    // 刻度和泳道用同一套网格列，「现在」「7 天后」正好落在时间条的两端
    panel.append(lanes, el('div', { class: 'pq-plan-lane pq-plan-axis' }, [el('span'), el('div', { class: 'pq-plan-axis-scale' }, [span('现在'), span('7 天后')])]));
    if (plan?.outAt) {
      const firstReset = planMembers.map(item => item.resetAt).filter(at => at != null && at >= now).sort((a, b) => a - b)[0];
      panel.append(el('p', { class: 'pq-plan-out', text: firstReset
        ? `预计 ${dateText(plan.outAt)} 前后全部用完，最早的重置在 ${dateText(firstReset)}`
        : `预计 ${dateText(plan.outAt)} 前后全部用完，最早的重置时间暂不可知` }));
    }
    if (plan?.rate != null) panel.append(el('p', { class: 'pq-plan-footnote', text: `按最近 7 天平均每小时用掉 ${plan.rate.toFixed(2)} 个百分点推算。网页聊天和其他设备的用量也算在官方额度里，实际还会受 5 小时窗口和限流影响。` }));
    // 现在的方式比快重置优先多作废 5 个百分点以上才提示
    if (data.compare?.strategyWaste != null && data.compare.resetFirstWaste != null && data.compare.strategyWaste - data.compare.resetFirstWaste >= 5) {
      panel.append(el('p', { class: 'pq-plan-suggestion', text: `换成「快重置优先」预计少作废约 ${Math.round(data.compare.strategyWaste - data.compare.resetFirstWaste)} 个百分点` }));
    }
    return panel;
  }

  /*
   * 生存分析（0.3.51）：这周的额度能撑到底吗。数字在 pool-insight.ts 的 survivalOf 里算：
   * 曲线是号池剩余（个号）随时间的变化，灰线是前几周；虚线按最近 7 天平均每天用掉的量往后推，成员的重置时间到了就回满；
   * 「把握」= 拿最近 14 天里每一天的用量各当一次「以后天天这么用」推 7 天，撑得住的天数占多少。
   */
  function survivalPanel(provider, data) {
    const panel = el('article', { class: 'panel pq-survival' }, [el('div', { class: 'panel-heading' }, [
      el('div', {}, [el('h2', {}, ['生存分析 ', el('span', { class: 'section-tag', text: '本周 · 周一起' })]), el('p', { text: '把号池的额度当成一条生命线：这周撑不撑得住、什么时候最惊险、每个号哪天倒下的。' })]),
    ])]);
    const s = data?.survival;
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    if (!s) { panel.append(empty('号池里没有官方账号成员的额度采样，没法做生存分析（API Key 成员没有额度可看）。')); return panel; }
    const sure = s.confidence ? Math.round(s.confidence.survive / s.confidence.of * 100) : null;
    const out = s.projection?.outAt ?? null;
    const weekEnd = s.weekStart + 7 * DAY;
    // 把握圆环
    const ring = svg('svg', { viewBox: '0 0 100 100', class: 'pq-sv-ring', 'aria-hidden': 'true' });
    ring.append(svg('circle', { cx: 50, cy: 50, r: 42, class: 'pq-sv-ring-bg' }));
    if (sure != null) { const arc = svg('circle', { cx: 50, cy: 50, r: 42, class: 'pq-sv-ring-fg' + (sure < 60 ? ' bad' : sure < 85 ? ' warn' : ''), 'stroke-dasharray': 263.9, 'stroke-dashoffset': 263.9 * (1 - sure / 100) }); ring.append(arc); }
    const verdict = !s.projection ? { tone: 'warn', title: '无法预测', text: '额度采样不足，暂时无法估计未来 7 天。' } : out == null
      ? { tone: 'ok', title: '未来 7 天都撑得住', text: s.perDay != null ? `照最近 7 天平均每天用掉 ${s.perDay.toFixed(2)} 个号的速度，加上各成员的重置，号池在未来 7 天里不会断粮。` : '最近没有用量。' }
      : { tone: out - s.now < 2 * DAY ? 'bad' : 'warn', title: `大约 ${date(out)} 会断粮`, text: `照最近 7 天平均每天用掉 ${s.perDay.toFixed(2)} 个号的速度推下去，算上各成员的重置，号池在 ${date(out)} 左右全部见底。` };
    const chip = (color, label, value) => { const dot = el('i', { class: 'pq-dot', 'aria-hidden': 'true' }); dot.style.background = color; return el('span', { class: 'pq-sv-chip' }, [dot, span(label + ' '), el('b', { text: value })]); };
    panel.append(el('div', { class: 'pq-sv-hero' }, [
      el('div', { class: 'pq-sv-ringbox', title: s.confidence ? `最近 ${s.confidence.of} 天里，有 ${s.confidence.survive} 天的用量节奏能撑满 7 天` : '' }, [ring, el('div', { class: 'pq-sv-ring-center' }, [el('b', { class: 'num', text: sure == null ? '—' : sure + '%' }), el('small', { text: sure == null ? '数据还不够' : '撑住的把握' })])]),
      el('div', { class: 'pq-sv-verdict' }, [
        el('h3', { class: verdict.tone, text: verdict.title }),
        el('p', { text: verdict.text }),
        el('p', { class: 'pq-faint', text: s.confidence ? `把握：拿最近 ${s.confidence.of} 天里每一天的实际用量，各当一次「以后天天这么用」推 7 天，有 ${s.confidence.survive} 天的节奏撑得住。` : '把握要至少 3 天的额度采样才算得出来。' }),
        el('div', { class: 'pq-sv-chips' }, [
          chip('var(--accent)', '剩余', s.left != null ? `${s.left.toFixed(1)} 个号` : '—'),
          chip('var(--ring-week)', '下一个号重置', s.nextReset ? date(s.nextReset) : '—'),
          s.danger ? chip('var(--warn)', '本周最惊险', `${date(s.danger.at)} · ${s.danger.left.toFixed(1)} 个号`) : null,
        ]),
      ]),
    ]));
    // 生存曲线
    const W = 960, H = 260, L = 40, R = 14, T = 14, B = 30, max = Math.max(1, s.accounts);
    const x = at => L + Math.min(1, Math.max(0, (at - s.weekStart) / (7 * DAY))) * (W - L - R), y = v => T + (1 - Math.min(max, Math.max(0, v)) / max) * (H - T - B);
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pq-sv-curve', role: 'img', 'aria-label': '号池剩余额度随时间的变化' });
    for (let v = 0; v <= max; v++) { chart.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' })); const t = svg('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }); t.textContent = String(v); chart.append(t); }
    ['周一', '周二', '周三', '周四', '周五', '周六', '周日'].forEach((label, i) => { const t = svg('text', { x: x(s.weekStart + (i + .5) * DAY), y: H - 8, 'text-anchor': 'middle', class: 'axis' }); t.textContent = label; chart.append(t); });
    chart.append(svg('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'pq-sv-zero' }));
    for (const week of s.past) chart.append(svg('polyline', { class: 'pq-sv-past', points: week.points.map(p => `${x(s.weekStart + p.d * DAY)},${y(p.left)}`).join(' ') }));
    if (s.curve.length) {
      chart.append(svg('path', { class: 'pq-sv-area', d: `M${x(s.curve[0].at)},${y(0)} ` + s.curve.map(p => `L${x(p.at)},${y(p.left)}`).join(' ') + ` L${x(s.curve.at(-1).at)},${y(0)} Z` }));
      chart.append(svg('polyline', { class: 'pq-sv-line', points: s.curve.map(p => `${x(p.at)},${y(p.left)}`).join(' ') }));
    }
    const ahead = (s.projection?.points || []).filter(p => p.at <= weekEnd);
    if (ahead.length && s.left != null) chart.append(svg('polyline', { class: 'pq-sv-ahead', points: [`${x(s.now)},${y(s.left)}`, ...ahead.map(p => `${x(p.at)},${y(p.left)}`)].join(' ') }));
    const mark = (at, v, cls, label, anchor = 'middle', offset = -12) => {
      chart.append(svg('circle', { cx: x(at), cy: y(v), r: 6, class: cls }));
      const t = svg('text', { x: x(at) + (anchor === 'end' ? -10 : anchor === 'start' ? 10 : 0), y: y(v) + offset, 'text-anchor': anchor, class: cls + '-label' }); t.textContent = label; chart.append(t);
    };
    if (s.danger && s.curve.length > 3) mark(s.danger.at, s.danger.left, 'pq-sv-danger', `最惊险 ${s.danger.left.toFixed(1)}`, x(s.danger.at) > W - 160 ? 'end' : 'start');
    if (s.left != null) mark(s.now, s.left, 'pq-sv-now', `现在 ${s.left.toFixed(1)}`, x(s.now) > W - 120 ? 'end' : 'middle', s.danger && Math.abs(x(s.now) - x(s.danger.at)) < 130 && Math.abs(y(s.left) - y(s.danger.left)) < 30 ? 22 : -12);
    if (out != null && out <= weekEnd) { const t = svg('text', { x: Math.min(W - R - 4, x(out)), y: y(0) - 8, 'text-anchor': 'end', class: 'pq-sv-out-label' }); t.textContent = '断粮'; chart.append(t, svg('circle', { cx: x(out), cy: y(0), r: 5, class: 'pq-sv-out' })); }
    const legendItem = (cls, label) => el('span', {}, [el('i', { class: 'pq-sv-key ' + cls, 'aria-hidden': 'true' }), span(label)]);
    panel.append(el('div', { class: 'pq-sv-chart' }, [chart, el('div', { class: 'pq-sv-legend' }, [legendItem('line', '本周'), legendItem('ahead', '照最近 7 天的速度往后推'), s.past.length ? legendItem('past', `前 ${s.past.length} 周`) : null, legendItem('zero', '断粮线')])]));
    // 每个号的寿命 + 这周的数字
    const lanes = el('div', { class: 'pq-sv-lanes' }, [el('h3', { text: '每个号这周的状态' }), ...s.members.map(member => {
      const lane = el('div', { class: 'pq-sv-lane' });
      const pos = at => `${Math.min(100, Math.max(0, (at - s.weekStart) / (7 * DAY) * 100))}%`;
      const alive = el('i', { class: 'pq-sv-alive' }); alive.style.width = pos(s.now); lane.append(alive);
      for (const span_ of member.dead) { const dead = el('i', { class: 'pq-sv-dead', title: `${date(span_.from)} – ${date(span_.to)} 额度用完` }); dead.style.left = pos(span_.from); dead.style.width = `calc(${pos(span_.to)} - ${pos(span_.from)})`; lane.append(dead); }
      for (const at of member.resets) { const tick = el('i', { class: 'pq-sv-reset', title: `${date(at)} 重置` }); tick.style.left = pos(at); lane.append(tick); }
      if (member.outAt && member.outAt <= weekEnd) { const fall = el('i', { class: 'pq-sv-fall', title: `照现在的速度，${date(member.outAt)} 左右见底`, text: '×' }); fall.style.left = pos(member.outAt); lane.append(fall); }
      const dead = member.left != null && member.left < 1;
      return el('div', { class: 'pq-sv-member' }, [
        el('b', { text: member.name, translate: 'no', title: member.name }),
        lane,
        el('span', { class: 'pq-sv-life' + (dead ? ' out' : '') }, [el('b', { class: 'num', text: member.left == null ? '—' : dead ? '见底' : `剩 ${pct(member.left)}` }), el('small', { text: `占用量 ${percent(member.share * 100)}` })]),
      ]);
    })]);
    const stat = (label, value, sub, tone = '') => el('div', { class: 'pq-sv-stat ' + tone }, [el('span', { text: label }), el('b', { class: 'num', text: value }), el('small', { text: sub })]);
    const weeks = el('div', { class: 'pq-sv-weeks' }, [...[...s.past].reverse().map(week => el('span', { class: week.min > 0.05 ? 'ok' : 'out', title: `${date(week.week).slice(0, 5)} 那周最低 ${week.min.toFixed(1)} 个号` }, [el('i', { text: week.min > 0.05 ? '✓' : '×' }), el('small', { text: date(week.week).slice(0, 5) })])),
      el('span', { class: 'now', title: '本周' }, [el('i', { text: sure == null ? '?' : sure + '%' }), el('small', { text: '本周' })])]);
    const stats = el('div', { class: 'pq-sv-side' }, [el('div', { class: 'pq-sv-stats' }, [
      stat('满额一个号能撑', s.avgLifeDays != null ? `${s.avgLifeDays.toFixed(1)} 天` : '—', '按各号最近 7 天的用量'),
      stat('号池每天用掉', s.perDay != null ? `${s.perDay.toFixed(2)} 个号` : '—', '最近 7 天平均'),
      stat('本周最低', s.danger ? `${s.danger.left.toFixed(1)} 个号` : '—', s.danger ? date(s.danger.at) : '', s.danger && s.danger.left < 0.5 ? 'warn' : ''),
      stat('连续撑过', `${s.streak} 周`, s.past.length ? `前 ${s.past.length} 周里` : '还没有往周的数据'),
    ]), s.past.length ? weeks : null]);
    panel.append(el('div', { class: 'pq-sv-grid' }, [lanes, stats]));
    panel.append(el('p', { class: 'quota-footnote', text: '只算官方账号成员。官方的百分比是整个账号的消耗（网页聊天、其他设备也算），「断粮」指所有官方账号成员的每周额度都见底；号池里的 API Key 成员还能接着用。往后推是估计，用量忽多忽少时会有偏差。' }));
    return panel;
  }

  /** 号池用了多少：Token、参考费用、用了多久。 */
  function usagePanel(provider, data) {
    const panel = el('article', { class: 'panel window-panel pq-usage' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '号池用量' }), el('span', { class: 'section-tag', text: appOf(provider).name })])]);
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    const t = data.totals;
    panel.append(el('div', { class: 'window-number' }, [el('strong', { class: 'num', text: tokens(t.today.tokens) }), el('span', { text: '今天的 Tokens' })]));
    panel.append(el('div', { class: 'window-meta' }, [
      el('span', {}, [span(number(t.today.requests) + ' ', 'num'), span('次请求')]),
      el('span', {}, [span('参考费用 '), span(money(t.today.costUsd), 'num')]),
    ]));
    const part = (label, value, sub) => metric(label, amount(value.tokens), { unit: 'Tokens', approx: cnApprox(value.tokens), sub: `${money(value.costUsd)}${sub ? ' · ' + sub : ''}`, chip: { tone: 'medium', text: `${number(value.requests)} 次` } });
    panel.append(metricGroup('Token 与参考费用', 'tokens', [part('今天', t.today), part('最近 7 天', t.d7), part('最近 30 天', t)]));
    panel.append(metricGroup('用了多久', 'clock', [
      metric('今天', lasted(t.today.activeMs), { sub: '有请求的时段连起来' }),
      metric('最近 7 天', lasted(t.d7.activeMs), { sub: `平均每天 ${lasted(t.d7.activeMs / 7)}` }),
      metric('最近 30 天', lasted(t.activeMs), { sub: data.since ? `从 ${date(data.since)} 起` : '还没有记录' }),
    ]));
    panel.append(el('p', { class: 'quota-footnote', text: '数据来自号池的转发记录（每次请求都记，永久保存）。用了多久：每次请求从发出到结束算一段，相隔不到 5 分钟的连在一起。参考费用按官方标价估算；官方账号成员走的是订阅额度，不会真的按这个扣钱。' }));
    return panel;
  }

  /** 成员分摊：每个成员用了多少、占多少、成功率、限流次数。 */
  function membersPanel(provider, data) {
    const panel = el('article', { class: 'panel pq-members' }, [el('div', { class: 'panel-heading' }, [
      el('div', {}, [el('h2', {}, ['成员分摊 ', el('span', { class: 'section-tag', text: '最近 30 天' })]), el('p', { text: `轮换方式：${STRATEGY[provider.pool.strategy] || provider.pool.strategy}。占比按成功请求的 Token 算；失败后自动换下一个成员的那次也记在原来那个成员上。` })]),
    ])]);
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    if (!data.members.length) { panel.append(empty('号池里还没有成员。')); return panel; }
    panel.append(el('div', { class: 'pq-member-head', 'aria-hidden': 'true' }, [span(''), span('成员'), span('Tokens · 占比'), span('请求'), span('参考费用'), span('最近一次')]));
    panel.append(...data.members.map((member, i) => {
      const dot = el('i', { class: 'pq-dot', 'aria-hidden': 'true' }); dot.style.background = colorOf(data, member.key);
      const rate = member.attempts ? member.requests / member.attempts * 100 : null;
      const row = el('div', { class: 'pq-member' + (member.removed ? ' removed' : '') }, [
        dot,
        el('div', { class: 'pq-member-name' }, [
          el('b', { text: member.name, translate: 'no', title: member.name }),
          el('small', { text: [member.type === 'account' ? '官方账号' : 'API Key', member.removed ? '已移出号池' : '', member.quota?.weekLeft != null ? `每周剩 ${pct(member.quota.weekLeft)}` : ''].filter(Boolean).join(' · ') }),
        ]),
        el('div', { class: 'pq-member-share' }, [el('span', { class: 'num', text: `${tokens(member.tokens)} · ${percent(member.share * 100)}` }), memberTrack(member.share * 100, colorOf(data, member.key))]),
        el('div', {}, [el('span', { class: 'num', text: number(member.requests) }), el('small', { class: member.limited ? 'warn-text' : '', text: [rate == null ? '' : `成功 ${pct(rate)}`, member.limited ? `限流 ${number(member.limited)} 次` : ''].filter(Boolean).join(' · ') || '—' })]),
        el('div', {}, [el('span', { class: 'num', text: money(member.costUsd) }), el('small', { text: `7 天 ${money(member.d7.costUsd)}` })]),
        el('div', {}, [el('span', { class: 'num', text: member.lastAt ? date(member.lastAt) : '—' }), el('small', { text: member.activeMs ? `用了 ${lasted(member.activeMs)}` : '' })]),
      ]);
      row.style.setProperty('--i', i);
      return row;
    }));
    return panel;
  }

  /** 最近 24 小时 / 最近 30 天，按成员叠起来。 */
  function historyGrid(data, after) {
    const hourly = el('div', { class: 'chart' }), daily = el('div', { class: 'chart' });
    const hourPanel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 24 小时 · 号池用量' })]), hourly, data ? legend(data) : null, el('p', { class: 'sample-caption', text: '按成员分颜色叠起来。横轴按本地时间，含当前未结束的小时。' })]);
    const dayPanel = el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 30 天 · 号池用量' })]), daily, data ? legend(data) : null, el('p', { class: 'sample-caption', text: '每天一根，按成员分颜色叠起来。' })]);
    after.push(() => {
      if (!data) { hourly.replaceChildren(empty('正在读取…')); daily.replaceChildren(empty('正在读取…')); return; }
      const animate = entering();
      const thisHour = Math.floor(Date.now() / 3600000) * 3600000;
      stackChart(hourly, data, data.hourly.map(row => ({ ...row, label: date(row.hour), tick: `${new Date(row.hour).getHours()}:00`, current: row.hour === thisHour })), animate);
      stackChart(daily, data, data.daily.map((row, i) => ({ ...row, label: row.day, tick: row.day.slice(5), current: i === data.daily.length - 1 })), animate);
    });
    return el('div', { class: 'quota-history-grid' }, [markLayout(hourPanel, 'quota:pool-hourly'), markLayout(dayPanel, 'quota:pool-daily')]);
  }

  /** 模型 × 思考等级：用了多少、用了多久。 */
  function modelsPanel(data) {
    const panel = el('article', { class: 'panel pq-models' }, [el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', {}, ['号池用过的模型 ', el('span', { class: 'section-tag', text: '最近 30 天' })]), el('p', { text: '按实际回复的型号和思考等级分开；用了多久同样按有请求的时段连起来算。' })])])]);
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    if (!data.models.length) { panel.append(empty('最近 30 天号池还没有成功的请求。')); return panel; }
    const top = data.models[0].tokens || 1;
    panel.append(...data.models.slice(0, 12).map((row, i) => stagger(el('div', { class: 'rank-row pq-model' }, [
      el('span', { class: 'rank-number', text: String(i + 1).padStart(2, '0') }),
      el('div', { class: 'rank-body' }, [
        el('div', { class: 'rank-name', text: row.model + (row.effort ? ` · ${row.effort}` : ''), title: row.model, translate: 'no' }),
        el('div', { class: 'rank-meta', text: `${number(row.requests)} 次 · 用了 ${lasted(row.activeMs)} · 最近 ${date(row.lastAt)}` }),
        track(row.tokens / top * 100, false, '和用得最多的模型相比'),
      ]),
      el('div', { class: 'rank-value' }, [...qty(row.tokens), el('div', { class: 'rank-meta', text: money(row.costUsd) })]),
    ]), i)));
    return panel;
  }

  /** 最近的请求（含失败后换成员的那次）。 */
  function requestsPanel(provider, data) {
    const panel = el('article', { class: 'panel pq-requests' }, [el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', {}, ['这个号池的请求 ', el('span', { class: 'section-tag', text: '最近 60 次' })]), el('p', { text: '每次转发一行；第几次 > 1 是前一个成员失败后换的。' })])])]);
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    if (!data.recent.length) { panel.append(empty('还没有经过这个号池的请求。把工具切到这个号池，用一会儿这里就会有记录。')); return panel; }
    const list = el('div', { class: 'pq-req-list', role: 'table', 'aria-label': '号池最近的请求' }, [
      el('div', { class: 'pq-req head', role: 'row' }, ['时间', '成员', '模型', '结果', 'Tokens', '用时'].map(text => el('span', { role: 'columnheader', text }))),
      ...data.recent.map(row => el('div', { class: 'pq-req' + (row.ok ? '' : ' bad'), role: 'row' }, [
        el('span', { class: 'num', role: 'cell', text: date(row.at) }),
        el('span', { role: 'cell', text: row.memberName, translate: 'no', title: row.memberName }),
        el('span', { role: 'cell', text: row.model + (row.effort ? ` · ${row.effort}` : ''), translate: 'no', title: row.model }),
        el('span', { role: 'cell', class: 'num', text: (row.ok ? '成功' : row.status === 429 ? '限流 429' : row.status ? `失败 ${row.status}` : '失败') + (row.attempt > 1 ? ` · 第 ${row.attempt} 次` : '') }),
        el('span', { role: 'cell', class: 'num', text: row.tokens ? tokens(row.tokens) : '—' }),
        el('span', { role: 'cell', class: 'num', text: row.ms ? (row.ms >= 1000 ? `${(row.ms / 1000).toFixed(1)} 秒` : `${row.ms} 毫秒`) : '—' }),
      ])),
    ]);
    panel.append(list);
    return panel;
  }

  /** 画这个号池的那一页，返回实际选中的标签（号池被删了就落到第一个）。timelineNode：app.js 里那块「模型与思考等级 · 时间线」。 */
  function renderQuota(host, key, timelineNode) {
    const list = pools();
    const provider = list.find(item => PREFIX + ':' + item.id === key) || list[0];
    if (!provider) return key;
    const app = appOf(provider), entry = summaryOf(provider), data = entry.data?.pool?.id === provider.id ? entry.data : null, after = [];
    const members = provider.pool.members;
    const next = members.find(member => member.id === provider.pool.next);
    const edit = el('button', { type: 'button', class: 'btn', 'data-action': 'pool-edit' }, [icon('settings'), span('在供应商页编辑')]);
    edit.addEventListener('click', () => { navigate('providers'); window.PulseProviders?.open(provider.app); });
    host.append(el('div', { class: 'quota-context pq-context' }, [
      avatar(app.kind),
      el('div', {}, [
        el('h2', {}, ['号池', el('span', { class: 'context-who', text: provider.name, title: provider.name, translate: 'no' })]),
        el('p', { class: 'muted', text: `${app.name} · ${STRATEGY[provider.pool.strategy] || provider.pool.strategy} · ${number(members.filter(m => m.type === 'account').length)} 个官方账号、${number(members.filter(m => m.type === 'provider').length)} 个 API Key${provider.active ? ' · 正在使用' : ''}` }),
      ]),
      el('div', { class: 'context-meta pq-context-meta' }, [
        el('div', { text: next ? `下一个请求交给：${next.name}` : data?.lastAt ? `最近一次请求 ${date(data.lastAt)}` : '还没有经过号池的请求' }),
        edit,
      ]),
    ]));
    if (entry.failed && !data) host.append(el('p', { class: 'stale-note' }, [icon('alert'), span('号池的统计没有读出来，稍后会自动重试。')]));
    host.append(el('div', { class: 'quota-window-grid' }, [markLayout(quotaPanel(provider, data), 'quota:pool-quota'), markLayout(usagePanel(provider, data), 'quota:pool-usage')]));
    if (provider.pool.members.some(member => member.type === 'account')) host.append(markLayout(planPanel(provider, data), 'quota:pool-plan'));
    if (provider.pool.members.some(member => member.type === 'account')) host.append(markLayout(survivalPanel(provider, data), 'quota:pool-survival'));
    host.append(markLayout(membersPanel(provider, data), 'quota:pool-members'));
    host.append(historyGrid(data, after));
    if (timelineNode) host.append(timelineNode);
    window.PulseModelStudy?.timeline(current, PREFIX + ':' + provider.id, { kind: PREFIX, accountId: PREFIX + ':' + provider.id, brand: app.kind, lastCheckedAt: data?.lastAt || 0 });
    host.append(markLayout(speedPanel({ accountId: PREFIX + ':' + provider.id, accountLabel: '' }, PREFIX, {
      tag: '号池 · ' + provider.name,
      hint: '每个模型每秒输出多少 Token，经过这个号池转发时量出来的。记录永久保存。',
      load: days => api.speed(provider.id, days),
      empty: () => el('div', { class: 'empty speed-empty' }, [el('p', { text: '这段时间还没有量到速度。号池转发过请求之后这里就会有走势；回复太短（不到 20 个 Token）的不算。' })]),
    }), 'quota:speed'));
    host.append(markLayout(modelsPanel(data), 'quota:pool-models'));
    host.append(markLayout(requestsPanel(provider, data), 'quota:pool-requests'));
    for (const draw of after) draw();
    return PREFIX + ':' + provider.id;
  }

  /** 供应商状态变了（号池新建、删掉、改名、成员变了）：标签跟着变；额度详情开着就重画。 */
  /** 只看号池相关的部分：别的供应商变了、转发了不经过号池的请求，都不用重画。 */
  const signature = () => pools().map(provider => [provider.id, provider.name, provider.app, provider.active ? 1 : 0, provider.pool.strategy, provider.pool.next || '',
    ...provider.pool.members.map(member => [member.id, member.name, member.lastAt || 0, member.quota?.left ?? '', member.quota?.limited ? 1 : 0].join(':'))].join(',')).join('|');
  let signed = '';
  function apply(next) {
    if (!next || !Array.isArray(next.providers)) return;
    agentView = next;
    const now = signature();
    if (now === signed) return;
    signed = now;
    const open = typeof current !== 'undefined' && current && !document.getElementById('page-quota').hidden;
    if (open) keepScroll(() => window.renderQuota());
  }
  window.PoolQuota = { tabs, tabButton, owns, renderQuota, reorder };
  window.tokenpulse.onAgentSwitch?.(apply);
  window.tokenpulse.agentState?.().then(apply).catch(() => {});
})();
