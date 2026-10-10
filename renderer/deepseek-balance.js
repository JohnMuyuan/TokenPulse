'use strict';
/*
 * DeepSeek 余额监控（0.3.42）。DeepSeek 按量付费，没有订阅额度窗口，看的是余额。
 * 查询和计时都在主进程（src/main/deepseek-balance.ts），这里只负责显示。API Key 只往主进程送，界面拿不回来，只有「sk-…后四位」。
 *
 * - 额度详情：每个 DeepSeek 账号（一个 API Key）在顶上有自己的标签，和 ChatGPT / Claude / Grok 的账号并排；点进去是这个账号的一页：
 *   余额和预测、本机用量、消耗趋势、最近 24 小时用量、余额走势、时间线、模型速度、换一种模型余额能用多少。
 *   标签和页面由 app.js 的 drawAccountTabs / renderQuota 调这里的 tabs() / renderQuota()。
 * - 总览：和 ChatGPT / Claude / Grok 一样在「官方额度」那一排里占一张卡片（app.js 的 renderOverview 调 card()）。
 * - 没填 Key：本机装过 DeepSeek Harness 才露出入口；没装过就不显示（设置 → 数据里还能打开）。
 * - 演示模式（新手引导）不显示。
 */
(() => {
  const api = window.tokenpulse?.deepseekBalance;
  if (!api) return;
  const locale = () => window.PulseI18n?.lang() === 'en' ? 'en-US' : 'zh-CN';
  const KEYS_URL = 'https://platform.deepseek.com/api_keys';
  const PREFIX = 'deepseek';
  // 余额数据叫 balance：app.js 里选中的账号在全局的 state.account，别重名
  let balance = null, dialog = null;

  // 叫 cash 不叫 amount：app.js 里有个全局的 amount()（Token 数字的写法），这一页也要用
  const cash = (value, currency) => (currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' ') + (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clock = at => {
    const day = new Date(at);
    const sameDay = day.toDateString() === new Date().toDateString();
    return sameDay ? day.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }) : day.toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const clean = error => String(error?.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const button = (text, onClick, { cls = 'btn', glyph = null, action = null, disabled = false } = {}) => {
    const node = el('button', { type: 'button', class: cls, 'data-action': action, disabled: disabled ? '' : null }, [glyph ? icon(glyph) : null, el('span', { text })]);
    node.addEventListener('click', onClick);
    return node;
  };
  const call = async (work, failText) => {
    try { const next = await work(); if (next) apply(next); return next; }
    catch (error) { toast(failText + (clean(error) ? `：${clean(error)}` : ''), { kind: 'error' }); return null; }
  };
  const demo = () => Boolean(window.tokenpulse?.isDemo?.());
  const accounts = () => (demo() ? [] : balance?.accounts || []);
  const visible = () => Boolean(balance) && !demo() && (accounts().length > 0 || balance.detected);
  /** DeepSeek 的图标（renderer/brand.js，和 AllAi 同源）。 */
  const logo = cls => el('span', { class: cls, 'aria-hidden': 'true' }, [brandSvg('deepseek')]);
  /** 第三方中转站的 Key（kind: relay）：没有品牌图标，用名字的首字母；名字没填就用站点的域名。 */
  const isRelay = account => account?.kind === 'relay';
  const nameOf = account => account.label || (isRelay(account) ? account.host : account.keyHint);
  const FLAVOR = { sub2api: 'sub2api', newapi: 'new-api' };
  const initial = account => (nameOf(account) || '?').trim().charAt(0).toUpperCase();
  /*
   * 第三方 Key 的图标：和供应商页用同一套（provider-avatars.js，预设图标与 AllAi 同源）——
   * 上传的图片 → 选的预设 → 按名字和站点地址自动匹配 → 都没有就用首字母。
   */
  const imageOf = account => window.PulseAvatars?.resolve({ name: account.label || account.host || '', baseUrl: account.baseUrl || '', icon: account.icon || '', avatar: account.avatar || '' }) || null;
  const picture = image => el('img', { src: image.src, alt: '', draggable: 'false', class: image.mono ? 'mono' : null });
  const mark = (account, cls) => {
    if (!isRelay(account)) return logo(cls);
    const image = imageOf(account);
    return image ? el('span', { class: cls + ' ds-pic', 'aria-hidden': 'true' }, [picture(image)]) : el('span', { class: cls + ' ds-letter', 'aria-hidden': 'true', text: initial(account) });
  };
  const avatarOf = account => {
    if (!isRelay(account)) return avatar('deepseek');
    const image = imageOf(account);
    return el('span', { class: 'account-avatar relay' + (image ? ' ds-pic' : ''), 'aria-hidden': 'true' }, [image ? picture(image) : letterMark(nameOf(account))]);
  };
  /** 一个账号现在的状况：bad 接口报错或余额用完、low 低于提醒线。 */
  const health = account => {
    const last = account.last, infos = last?.infos || [];
    const low = account.alertBelow != null && last?.ok && infos.find(info => info.total < account.alertBelow);
    const empty = Boolean(last?.ok && last.available === false);
    return { last, infos, low: low || null, empty, level: (last && !last.ok) || empty ? 'bad' : low ? 'low' : '' };
  };
  const warning = account => {
    const { last, low, empty } = health(account);
    if (last && !last.ok) return [el('span', { class: 'ds-balance-warn', text: last.error || '查询失败' })];
    if (empty) return [el('span', { class: 'ds-balance-warn', text: '余额不足，接口已经不能调用' })];
    if (low) return [el('span', { class: 'ds-balance-warn', text: '已低于提醒线' }), el('span', { class: 'num ds-balance-line', text: cash(account.alertBelow, low.currency) })];
    return [];
  };
  const updated = account => account.last ? el('span', { class: 'ds-balance-time' }, [el('span', { class: 'num', text: clock(account.last.at) + ' ' }), el('span', { text: account.last.ok ? '更新' : '查询失败，显示的是之前的余额' })]) : account.loading ? el('span', { class: 'ds-balance-time', text: '正在查询…' }) : null;
  const goQuota = key => { state.account = key; navigate('quota'); };

  /* ---------------- 额度详情顶上的标签 ---------------- */

  /** 给 app.js 的 drawAccountTabs：一个账号一个标签；装过 DeepSeek Harness 但还没填 Key 时给一个空的入口。 */
  function tabs() {
    if (!visible()) return [];
    const list = accounts();
    // 还没填 DeepSeek 的 Key、本机又装了 DeepSeek Harness：留一个空的 DeepSeek 标签当入口
    const intro = balance.detected && !list.some(account => !isRelay(account)) ? [{ key: PREFIX, kind: PREFIX, who: '', title: null }] : [];
    return [...intro, ...list.map(account => isRelay(account)
      ? { key: PREFIX + ':' + account.id, kind: 'relay', account, who: nameOf(account) + '|' + (account.icon || '') + '|' + (account.avatar ? account.avatar.length : 0), name: nameOf(account), title: `${nameOf(account)} · ${account.host} · ${account.keyHint}` }
      : { key: PREFIX + ':' + account.id, kind: PREFIX, who: nameOf(account), title: account.label ? `${account.label} · ${account.keyHint}` : account.keyHint })];
  }
  /** data-kind 是 deepseek 或 relay（第三方中转站）：和官方账号一样可以按住拖动调整顺序（app.js 的拖动排序，存顺序走 reorder）。 */
  function tabButton(tab) {
    if (tab.kind === 'relay') return el('button', { type: 'button', 'data-account': tab.key, 'data-kind': 'relay', 'data-relay': '', title: tab.title }, [mark(tab.account, 'brand-glyph'), el('span', { text: tab.name, translate: 'no' })]);
    return el('button', { type: 'button', 'data-account': tab.key, 'data-kind': PREFIX, 'data-deepseek': '', title: tab.title }, [logo('brand-glyph'), 'DeepSeek', tab.who ? el('small', { class: 'tab-who', text: tab.who, translate: 'no' }) : null]);
  }
  const owns = key => typeof key === 'string' && (key === PREFIX || key.startsWith(PREFIX + ':')) && tabs().length > 0;

  /* ---------------- 额度详情：一个账号一页 ---------------- */

  /*
   * 官方账号的额度详情看的是「窗口用了百分之几」；DeepSeek 按量付费，对应的是余额。这一页照着官方账号那一页的结构来：
   * 余额和预测（对应额度窗口）→ 消耗趋势（对应容量趋势）→ 最近 24 小时用量 / 余额走势 → 时间线 → 模型速度 → 换一种模型余额能用多少。
   * 数字在主进程的 worker 里算（src/core/deepseek-insight.ts）：余额历史 + 本机 DeepSeek Harness 的请求流水。
   * 本机用量只算在一个账号上（account.harness，Harness 是账号授权登录的，对不上 API Key，由用户指定）。
   */
  const DAY = 86400000;
  const insights = new Map();
  const quotaShowing = id => typeof current !== 'undefined' && current && !document.getElementById('page-quota').hidden && state.account === PREFIX + ':' + id;
  /** 这个账号的分析。数据变了（余额刚查过、本机刚扫过、换了本机归属）才重新取；新的回来之前继续显示上一份。 */
  function insightOf(account) {
    const stamp = [account.last?.at || 0, account.harness ? 1 : 0, typeof current !== 'undefined' ? current?.scannedAt || 0 : 0].join('|');
    let entry = insights.get(account.id);
    if (!entry) insights.set(account.id, entry = { stamp: '', data: null, pending: false, failed: false });
    if (entry.stamp !== stamp && !entry.pending) {
      entry.pending = true;
      api.insight(account.id).then(data => { entry.data = data; entry.failed = false; }).catch(() => { entry.failed = true; }).finally(() => {
        entry.pending = false; entry.stamp = stamp;
        renderCard();
        if (quotaShowing(account.id)) keepScroll(() => renderQuota_());
      });
    }
    return entry;
  }
  const daysText = days => days >= 365 ? '一年以上' : days >= 10 ? `${Math.round(days)} 天` : days >= 1 ? `${days.toFixed(1)} 天` : `${Math.max(1, Math.round(days * 24))} 小时`;
  const dayLabel = at => new Date(at).toLocaleDateString(locale(), { month: 'numeric', day: 'numeric' });
  const hideTip = () => { $('tip').hidden = true; };
  const tipOn = (node, text) => {
    node.addEventListener('pointermove', event => tipAt(text, event.clientX, event.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => { const box = node.getBoundingClientRect(); tipAt(text, box.x, box.y); });
    node.addEventListener('blur', hideTip);
    return node;
  };
  const segOf = (options, value, onPick, label) => {
    const group = el('div', { class: 'seg compact', role: 'group', 'aria-label': label }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...options.map(([id, text]) => el('button', { type: 'button', 'data-value': id, class: value() === id ? 'on' : null, text }))]);
    group.addEventListener('click', event => {
      const picked = event.target.closest('button[data-value]');
      if (!picked || picked.dataset.value === value()) return;
      onPick(picked.dataset.value);
      for (const item of group.querySelectorAll('button')) item.classList.toggle('on', item === picked);
      syncSeg(group);
    });
    return group;
  };

  /** 每天一根柱子。rows：{ at, value, text }；没有数据的那天 value 为 null，不画。 */
  function barChart(host, rows, format, animate) {
    host.replaceChildren();
    const w = Math.max(280, host.clientWidth), h = host.clientHeight || 220, left = 58, bottom = 28, top = 14;
    const max = Math.max(0, ...rows.map(row => row.value || 0)) || 1;
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '每天的消耗柱状图' });
    for (let i = 0; i <= 2; i++) {
      const y = top + (h - top - bottom) * i / 2;
      node.append(svg('line', { class: 'grid', x1: left, x2: w - 5, y1: y, y2: y }));
      const label = svg('text', { class: 'axis', x: left - 9, y: y + 4, 'text-anchor': 'end' }); label.textContent = format(max * (1 - i / 2)); node.append(label);
    }
    const slot = (w - left - 8) / rows.length, barWidth = Math.max(.5, Math.min(slot * .62, 30));
    rows.forEach((row, i) => {
      const x = left + i * slot + (slot - barWidth) / 2;
      if (row.value != null) {
        const barHeight = Math.max(row.value > 0 ? 2 : 0, row.value / max * (h - top - bottom));
        const rect = svg('rect', { class: 'col' + (i === rows.length - 1 ? ' today' : ''), x, y: h - bottom - barHeight, width: barWidth, height: Math.max(barHeight, 0), rx: Math.min(4, barWidth / 2), tabindex: 0, 'aria-label': row.text });
        rect.style.animationDelay = `${Math.round(i * 16)}ms`;
        // 柱子太矮时不好指：再垫一条看不见的整列
        const hit = svg('rect', { class: 'ds-col-hit', x: left + i * slot, y: top, width: slot, height: h - top - bottom });
        node.append(tipOn(hit, row.text), tipOn(rect, row.text));
        if (row.mark) node.append(svg('circle', { class: 'ds-topup-dot', cx: x + barWidth / 2, cy: top + 4, r: 3 }));
      }
      if (i % Math.max(1, Math.ceil(rows.length / 7)) === 0 || i === rows.length - 1) {
        const tick = svg('text', { class: 'axis', x: x + barWidth / 2, y: h - 6, 'text-anchor': 'middle' }); tick.textContent = dayLabel(row.at); node.append(tick);
      }
    });
    host.append(node);
    playChart(host, animate);
  }
  /** 余额走势：余额是一段一段平的，画成阶梯。纵轴只取这段时间里的范围（从 0 画起的话花掉的那一点看不出来）。 */
  function balanceChart(host, points, currency, now, animate) {
    host.replaceChildren();
    if (points.length < 2) { host.append(empty('余额记录还不够画走势。TokenPulse 开着的时候每 10 分钟记一次。')); return; }
    const w = Math.max(280, host.clientWidth), h = host.clientHeight || 190, left = 62, right = 12, top = 14, bottom = 28;
    const low = Math.min(...points.map(p => p.total)), high = Math.max(...points.map(p => p.total));
    const pad = Math.max((high - low) * .18, high * .002, .01), min = Math.max(0, low - pad), max = high + pad;
    const from = points[0].at, span = Math.max(1, now - from);
    const x = at => left + (at - from) / span * (w - left - right), y = value => top + (1 - (value - min) / (max - min)) * (h - top - bottom);
    const node = svg('svg', { viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': '余额走势' });
    for (const value of [min, (min + max) / 2, max]) {
      node.append(svg('line', { class: 'grid', x1: left, x2: w - right, y1: y(value), y2: y(value) }));
      const label = svg('text', { class: 'axis', x: left - 9, y: y(value) + 4, 'text-anchor': 'end' }); label.textContent = cash(value, currency); node.append(label);
    }
    let line = `M${x(from).toFixed(1)},${y(points[0].total).toFixed(1)}`;
    for (const p of points.slice(1)) line += ` H${x(p.at).toFixed(1)} V${y(p.total).toFixed(1)}`;
    line += ` H${x(now).toFixed(1)}`;
    node.append(svg('path', { class: 'trend-area', d: `${line} V${(h - bottom).toFixed(1)} H${x(from).toFixed(1)} Z` }));
    node.append(svg('path', { class: 'trend-line', d: line }));
    node.append(svg('circle', { class: 'trend-dot', cx: x(now), cy: y(points.at(-1).total), r: 4 }));
    for (const [at, anchor] of [[from, 'start'], [now, 'end']]) { const text = svg('text', { class: 'axis', x: x(at), y: h - 6, 'text-anchor': anchor }); text.textContent = date(at); node.append(text); }
    const hit = svg('rect', { class: 'ds-col-hit', x: left, y: top, width: w - left - right, height: h - top - bottom });
    hit.addEventListener('pointermove', event => {
      const box = node.getBoundingClientRect(), at = from + ((event.clientX - box.left) * (w / box.width) - left) / (w - left - right) * span;
      let value = points[0].total; for (const p of points) { if (p.at > at) break; value = p.total; }
      tipAt(`${date(at)}\n${cash(value, currency)}`, event.clientX, event.clientY);
    });
    hit.addEventListener('pointerleave', hideTip);
    node.append(hit);
    host.append(node);
    playChart(host, animate);
  }

  /** 还能用几天的提示，加上「花掉的」「预测」两组数字。 */
  function spendBlocks(panel, spend, data, info) {
    const left = spend.daysLeft;
    panel.append(el('div', { class: 'prediction-line' + (left != null && left < 3 ? ' caution' : '') }, [icon(left != null && left < 3 ? 'alert' : 'trend'), left != null
      ? el('span', {}, [el('span', { text: '按最近 7 天的速度，大约还能用' }), el('span', { class: 'num', text: ' ' }), el('span', { text: daysText(left) })])
      : el('span', { text: data.since == null ? '还没有余额记录，查到几次之后开始估算。' : spend.coveredDays < .25 ? '刚开始记录余额，过几个小时就能估算还能用多久。' : '最近 7 天余额没有减少，估不出还能用多久。' })]));
    const none = data.since == null;
    panel.append(metricGroup('花掉的', 'cost', [
      metric('今天', none ? '—' : cash(spend.today, info.currency), { sub: none ? '还没有记录' : '从今天 0 点算起' }),
      metric('最近 7 天', none ? '—' : cash(spend.d7, info.currency), { sub: none ? '' : '昨天', chip: none ? null : { tone: 'medium', text: cash(spend.yesterday, info.currency) } }),
      metric('最近 30 天', none ? '—' : cash(spend.d30, info.currency), { sub: none ? '' : '从有记录时算起' }),
    ]));
    panel.append(metricGroup('预测', 'trend', [
      metric('平均每天', spend.perDay == null ? '—' : cash(spend.perDay, info.currency), { sub: spend.perDay == null ? '暂无法估计' : '按最近 7 天' }),
      metric('还能用', left == null ? '—' : daysText(left), { sub: left == null ? '暂无法估计' : '按最近 7 天的速度', tone: left != null && left < 3 ? 'warn' : left != null ? 'accent' : '' }),
      metric('预计用完', spend.emptyAt == null ? '—' : left >= 365 ? '很久以后' : dayLabel(spend.emptyAt), { sub: spend.emptyAt == null ? '暂无法估计' : left >= 365 ? '' : String(new Date(spend.emptyAt).getFullYear()), tone: left != null && left < 3 ? 'warn' : '' }),
    ]));
  }
  /** 余额和预测：对应官方账号的「额度窗口」那一块。 */
  function balancePanel(account, info, data, level) {
    const spend = data?.spend, same = data && data.currency === info.currency;
    const panel = el('article', { class: 'panel window-panel ds-window ' + level, 'data-currency': info.currency }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '余额' }), el('span', { class: 'section-tag', text: '按量付费' })])]);
    panel.append(el('div', { class: 'window-number' }, [el('strong', { class: 'num ds-total', text: cash(info.total, info.currency) }), el('span', { text: '总余额' })]));
    panel.append(el('div', { class: 'window-meta' }, [
      el('span', {}, [el('span', { text: '充值余额' }), el('span', { class: 'num', text: ' ' + cash(info.toppedUp, info.currency) })]),
      el('span', {}, [el('span', { text: '赠送余额' }), el('span', { class: 'num', text: ' ' + cash(info.granted, info.currency) })]),
    ]));
    if (!same) { panel.append(el('div', { class: 'prediction-line' }, [icon('trend'), el('span', { text: data ? '消耗和预测按这个账号的另一种币种算。' : '正在读取消耗记录…' })])); return panel; }
    spendBlocks(panel, spend, data, info);
    panel.append(el('p', { class: 'quota-footnote' }, [
      el('span', { text: '花掉多少按余额的变化算：TokenPulse 开着的时候每 10 分钟查一次余额，关着的那段时间合在一起算到下一次查到的时候。' }),
      data.since != null ? el('span', {}, [el('span', { text: '余额记录开始于' }), el('span', { class: 'num', text: ' ' + date(data.since, true) }), el('span', { text: '。' })]) : null,
      el('span', { text: '余额是整个 DeepSeek 账号的，其他设备和其他程序花的也在里面；赠送余额过期也会算成花掉的。' }),
    ]));
    return panel;
  }

  /** 本机用量：只有指定给这个账号的时候才有。 */
  function localPanel(account, data, currency) {
    const panel = el('article', { class: 'panel window-panel ds-local' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '本机用量' }), el('span', { class: 'section-tag', text: 'DeepSeek Harness', translate: 'no' })])]);
    if (!account.harness) {
      const owner = accounts().find(item => item.harness);
      panel.append(el('div', { class: 'empty ds-local-off' }, [
        el('p', { text: owner ? '本机 DeepSeek Harness 的用量现在算在另一个账号上：' : '本机 DeepSeek Harness 的用量现在没有算在任何账号上。' }),
        owner ? el('p', {}, [el('b', { text: owner.label || owner.keyHint, translate: 'no' })]) : null,
        el('p', { text: 'DeepSeek Harness 是用账号登录的，和 API Key 对不上号，TokenPulse 分不出它用的是哪个账号，需要你指定一个。' }),
        button('本机 Harness 用的是这个账号', () => call(() => api.update(account.id, { harness: true }), '保存失败'), { cls: 'btn btn-accent', action: 'ds-own' }),
      ]));
      return panel;
    }
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    const usage = data.localUsage, spend = data.spend, rate = data.rate;
    panel.append(el('div', { class: 'window-number' }, [el('strong', { class: 'num', text: tokens(usage.today.tokens) }), el('span', { text: '今天的 Tokens' })]));
    panel.append(el('div', { class: 'window-meta' }, [
      el('span', {}, [el('span', { class: 'num', text: number(usage.today.requests) + ' ' }), el('span', { text: '次请求' })]),
      el('span', {}, [el('span', { text: '参考费用' }), el('span', { class: 'num', text: ' ' + money(usage.today.costUsd) })]),
    ]));
    const off = spend.offMachine7 > 0;
    panel.append(el('div', { class: 'prediction-line' + (off ? ' caution' : '') }, [icon(off ? 'alert' : 'check'), off
      ? el('span', {}, [el('span', { text: '最近 7 天有一部分是本机以外花的：' }), el('span', { class: 'num', text: cash(spend.offMachine7, currency) }), el('span', { text: '（余额减少的时候本机没有请求）' })])
      : el('span', { text: spend.d7 > 0 ? '最近 7 天余额每次减少的时候，本机都有请求。' : usage.lastAt ? '最近 7 天余额没有减少。' : '还没有扫到 DeepSeek Harness 的请求。' })]));
    const usageMetric = (label, part) => metric(label, amount(part.tokens), { unit: 'Tokens', approx: cnApprox(part.tokens), sub: money(part.costUsd), chip: { tone: 'medium', text: `${number(part.requests)} 次` } });
    panel.append(metricGroup('Token 与参考费用', 'tokens', [usageMetric('今天', usage.today), usageMetric('最近 7 天', usage.d7), usageMetric('最近 30 天', usage.d30)]));
    const sign = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' ';
    panel.append(metricGroup('实际扣费', 'cost', [
      metric('参考 1 美元实际扣', rate.perUsd == null ? '—' : sign + rate.perUsd.toFixed(2), { sub: rate.basis === 'measured' ? '按实际扣费校准' : rate.basis === 'reference' ? '参考比例，还没校准' : '这种币种没有参考比例' }),
      metric('本机花的', cash(rate.drop, currency), { sub: '最近 30 天' }),
      metric('本机以外花的', cash(spend.offMachine30, currency), { sub: '最近 30 天', tone: spend.offMachine30 > 0 ? 'warn' : '' }),
    ]));
    panel.append(el('p', { class: 'quota-footnote', text: '参考费用按 DeepSeek 官方标价和每次请求的时间（高峰 / 闲时半价）算，单位是美元；实际从余额里扣了多少看左边。本机只统计 DeepSeek Harness 的请求；余额减少时本机有请求就算本机花的，没有就算本机以外。' }));
    return panel;
  }

  /** 消耗趋势：最近 30 天每天花了多少。对应官方账号的「额度容量趋势」。 */
  function trendPanel(account, data, after) {
    state.dsTrend ??= 'spent';
    if (!account.harness && state.dsTrend !== 'spent') state.dsTrend = 'spent';
    const host = el('div', { class: 'chart capacity-chart ds-trend-chart' }), note = el('p', { class: 'sample-caption' });
    const draw = animate => {
      if (!data) { host.replaceChildren(empty('正在读取…')); return; }
      const byTokens = state.dsTrend === 'tokens';
      const rows = data.days.map(day => {
        const value = byTokens ? day.tokens : day.covered ? day.spent : null;
        const lines = [day.day, byTokens ? `${tokens(day.tokens)} Tokens · ${money(day.costUsd)} · ${number(day.requests)} 次请求` : day.covered ? `花掉 ${cash(day.spent, data.currency)}` : '这一天还没有余额记录',
          !byTokens && day.added > 0 ? `充值 / 赠送 +${cash(day.added, data.currency)}` : '', !byTokens && day.balance != null ? `当天结束时余额 ${cash(day.balance, data.currency)}` : '', !byTokens && account.harness && day.tokens ? `本机 ${tokens(day.tokens)} Tokens` : ''];
        return { at: day.from, value, text: lines.filter(Boolean).join('\n'), mark: !byTokens && day.added > 0 };
      });
      if (!rows.some(row => row.value > 0)) host.replaceChildren(empty(byTokens ? '最近 30 天没有扫到 DeepSeek Harness 的请求。' : data.since == null ? '还没有余额记录。TokenPulse 开着的时候每 10 分钟记一次，余额有变化就会出现在这里。' : '有余额记录以来，余额还没有减少过。'));
      else barChart(host, rows, byTokens ? tokens : value => cash(value, data.currency), animate);
      note.replaceChildren(...(byTokens
        ? [el('span', { text: '本机 DeepSeek Harness 每天用的 Tokens。' })]
        : [el('span', { text: '每根柱子是那一天余额减少了多少，蓝点表示当天有充值或新的赠送。' }), data.topUps.length ? el('span', {}, [el('span', { text: '最近一次充值 / 赠送：' }), el('span', { class: 'num', text: `${date(data.topUps[0].at)} +${cash(data.topUps[0].amount, data.currency)}` }), el('span', { text: '。' })]) : null,
          el('span', { text: 'TokenPulse 关着的时候不查余额，那几天花的会合在重新打开的那一天。' })]));
    };
    const seg = account.harness ? segOf([['spent', '余额消耗'], ['tokens', '本机 Tokens']], () => state.dsTrend, value => { state.dsTrend = value; draw(true); }, '看什么') : null;
    after.push(() => draw(entering()));
    return el('article', { class: 'panel capacity-panel ds-trend' }, [
      el('div', { class: 'panel-heading' }, [el('div', {}, [el('h2', { text: '消耗趋势' }), el('p', { text: '最近 30 天每天从余额里花掉多少' })]), seg ? el('div', { class: 'capacity-controls' }, [seg]) : null]),
      host, note,
    ]);
  }

  /** 最近 24 小时用量 + 余额走势，对应官方账号那两张并排的图。 */
  function historyGrid(account, data, after) {
    const hourly = el('div', { class: 'chart' }), line = el('div', { class: 'chart quota-trend' });
    after.push(() => {
      const animate = entering();
      if (!account.harness) hourly.replaceChildren(empty('本机 DeepSeek Harness 的用量没有算在这个账号上。'));
      else if (!data) hourly.replaceChildren(empty('正在读取…'));
      else chart(hourly, data.hourly, 'tokens', true, animate);
      if (!data) line.replaceChildren(empty('正在读取…')); else balanceChart(line, data.track, data.currency, data.now, animate);
    });
    return el('div', { class: 'quota-history-grid' }, [
      el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '最近 24 小时 · 本机用量' })]), hourly, el('p', { class: 'sample-caption', text: '本机 DeepSeek Harness 的请求。横轴按本地时间，含当前未结束的小时。' })]),
      el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '余额走势' })]), line, el('p', { class: 'sample-caption' }, [el('span', { text: '最近 30 天查到的余额。' }), data ? el('span', {}, [el('span', { class: 'num', text: number(data.sampleCount) + ' ' }), el('span', { text: '笔记录' })]) : null])]),
    ]);
  }

  /** 换一种模型，余额能用多少：对应官方账号的「换一种模型，整窗能用多少」。 */
  function modelsPanel(account, data) {
    const panel = el('article', { class: 'panel model-study ds-models' });
    const heading = el('div', { class: 'panel-heading ms-head' }, [el('div', { class: 'ms-title' }, [avatar('deepseek', 'ms-brand'), el('div', {}, [
      el('h2', {}, ['换一种模型，余额能用多少', el('span', { class: 'section-tag', text: account.harness ? '按最近 30 天的用法' : '按典型用法' })]),
      el('p', { text: '现在的余额如果全用一种模型，大约能用多少 Tokens、多少次调用。DeepSeek 分高峰和闲时两个价（闲时半价），所以每个型号两行。' }),
    ])])]);
    panel.append(heading);
    if (!data) { panel.append(empty('正在读取…')); return panel; }
    const { currency, rate, current: now } = data, total = data.balance?.total ?? 0;
    const sign = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency + ' ';
    const rateBadge = rate.basis === 'measured' ? ['按实际扣费校准', 'good'] : rate.basis === 'reference' ? ['参考比例', 'warn'] : ['没有参考比例', 'warn'];
    panel.append(el('div', { class: 'ms-budgets' }, [
      el('div', { class: 'ms-budget ds-budget' }, [
        el('div', { class: 'ms-budget-top' }, [el('i', { class: 'ms-dot ds-dot' }), el('b', { text: '现在的余额' })]),
        el('strong', { class: 'ms-budget-value' }, [el('span', { class: 'num', text: cash(total, currency) }), el('small', { text: '整个账号的' })]),
        el('p', {}, now.capacityTokens != null
          ? [el('span', { text: '照现在的用法大约还能用' }), el('span', { class: 'num', text: ` ${tokens(now.capacityTokens)} Tokens` }), now.calls ? el('span', { class: 'num', text: ` · ≈ ${number(now.calls)} ` }) : null, now.calls ? el('span', { text: '次调用' }) : null]
          : [el('span', { text: account.harness ? '本机最近 30 天没有 DeepSeek Harness 的请求，下面按典型的编程用法估算。' : '本机用量没有算在这个账号上，下面按典型的编程用法估算。' })]),
        now.peakShare != null ? el('small', {}, [el('span', { text: '你最近 30 天的 Tokens 里，高峰时段占' }), el('span', { class: 'num', text: ` ${(now.peakShare * 100).toFixed(0)}%` })]) : null,
      ]),
      el('div', { class: 'ms-budget ds-budget' }, [
        el('div', { class: 'ms-budget-top' }, [el('i', { class: 'ms-dot ds-dot' }), el('b', { text: '参考费用怎么换成余额' }), el('span', { class: `ms-badge ${rateBadge[1]}`, text: rateBadge[0] })]),
        el('strong', { class: 'ms-budget-value' }, [el('span', { class: 'num', text: rate.perUsd == null ? '—' : `$1 ≈ ${sign}${rate.perUsd.toFixed(2)}` }), el('small', { text: '参考 1 美元实际扣多少余额' })]),
        el('p', { text: rate.basis === 'measured' ? '用你自己的记录校准的：余额减少、同时本机有请求的那些时段，余额实际减少的数 ÷ 这些请求的参考费用。'
          : rate.basis === 'reference' ? '还没有足够的实际扣费可以对照，先用一个粗略的比例。等余额有了几次变化、同时本机有请求，会自动换成你自己的实际比例。'
          : '这种币种没有参考比例，下面只能比较各个模型的相对价格。' }),
        rate.basis === 'measured' ? el('small', {}, [el('span', { class: 'num', text: number(rate.steps) + ' ' }), el('span', { text: '次余额变化' }), el('span', { class: 'num', text: ` · ${cash(rate.drop, currency)} ÷ ${money(rate.costUsd)}` })])
          : rate.measured != null ? el('small', {}, [el('span', { text: '按你的记录算出来是' }), el('span', { class: 'num', text: ` ${sign}${rate.measured.toFixed(2)} ` }), el('span', { text: '，偏离太多（多半别处也在用这个账号），没有采用。' })]) : null,
      ]),
    ]));
    const rows = [...data.models].sort((a, b) => (b.capacityTokens ?? -1) - (a.capacityTokens ?? -1) || (b.relative ?? -1) - (a.relative ?? -1) || a.model.localeCompare(b.model));
    const max = Math.max(0, ...rows.map(row => row.capacityTokens || 0)), maxRelative = Math.max(0, ...rows.map(row => row.relative || 0));
    const price = value => '$' + (value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3).replace(/0$/, ''));
    const list = el('div', { class: 'ms-rank', role: 'list' }, rows.map((row, i) => {
      const cell = el('div', { class: 'ms-cap' });
      const fill = el('i', { class: 'full' + (row.capacityTokens == null ? ' relative' : '') });
      if (row.capacityTokens != null) {
        cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { text: tokens(row.capacityTokens) }), el('small', { text: 'Tokens' })]));
        fill.style.width = Math.max(1.5, row.capacityTokens / (max || 1) * 100).toFixed(2) + '%';
        if (row.calls) cell.append(el('div', { class: 'ms-meter' }, [fill]), el('small', { class: 'ms-cap-sub' }, [el('span', { class: 'num', text: `≈ ${number(row.calls)} ` }), el('span', { text: '次调用' })]));
        else cell.append(el('div', { class: 'ms-meter' }, [fill]));
      } else if (row.relative != null) {
        cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { text: `×${row.relative.toFixed(2)}` }), el('small', { text: 'API 价格参考比' })]));
        fill.style.width = Math.max(1.5, row.relative / (maxRelative || 1) * 100).toFixed(2) + '%';
        cell.append(el('div', { class: 'ms-meter' }, [fill]));
      } else cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { class: 'muted', text: '—' }), el('small', { text: '价格表里没有这个型号' })]), el('div', { class: 'ms-meter' }));
      const lp = row.listPrice;
      return stagger(el('div', { class: 'ms-row ds-row' + (i < 3 ? ' top' : ''), role: 'listitem', 'data-model': row.model, 'data-period': row.period }, [
        el('span', { class: 'ms-no', text: String(i + 1).padStart(2, '0') }),
        el('div', { class: 'ms-name' }, [avatar('deepseek', 'ms-row-logo'), el('div', { class: 'ms-name-text' }, [
          el('div', { class: 'ms-name-top' }, [el('b', { text: row.model, title: row.model, translate: 'no' }), el('span', { class: 'ms-level' + (row.period === 'peak' ? '' : ' plain'), text: row.period === 'peak' ? '高峰' : '闲时' }),
            row.mixBasis === 'model' ? el('span', { class: 'ms-basis measured', text: '按你用它的结构' }) : null]),
          el('small', {}, [
            lp ? el('span', { class: 'num', text: `输入 ${price(lp.input)} · 输出 ${price(lp.output)} · 缓存读 ${price(lp.cacheRead)} / 百万` }) : el('span', { text: '没有标价' }),
            el('span', { class: 'num', text: row.recentTokens ? ` · 30 天用了 ${tokens(row.recentTokens)}` : '' }),
          ]),
        ])]),
        cell,
        el('div', { class: 'ms-cap ds-unit' }, row.usdPerM == null ? [el('div', { class: 'ms-cap-num' }, [el('b', { class: 'muted', text: '—' })])] : [
          el('div', { class: 'ms-cap-num' }, [el('b', { text: row.balancePerM != null ? cash(row.balancePerM, currency) : money(row.usdPerM) }), el('small', { text: '/ 百万 Tokens' })]),
          el('small', { class: 'ms-cap-sub' }, [el('span', { text: '参考' }), el('span', { class: 'num', text: ` ${price(row.usdPerM)}` })]),
        ]),
      ]), i);
    }));
    panel.append(
      el('div', { class: 'ms-rank-head ds-rank-head', 'aria-hidden': 'true' }, [el('span'), el('span', { text: '模型 · 时段' }), el('span', { text: '现在的余额能用' }), el('span', { text: '综合单价' })]),
      list,
      el('p', { class: 'ms-note', text: '综合单价 = 按标价和你的 Token 结构（新输入、缓存读取、输出各占多少）算出来的每百万 Tokens 的费用。Tokens 里大部分是每次调用重读对话的缓存，很便宜，所以综合单价比输入标价低得多。高峰是北京时间工作日 9:00–12:00 和 14:00–18:00，其余时间和节假日是闲时。' }),
      el('p', { class: 'ms-note' }, [el('span', { text: '单价来自模型知识库' }), el('span', { class: 'num', text: ` ${data.priceSource.version}` }), el('span', { text: '。这是估算，不是 DeepSeek 的承诺；余额是整个账号的，别处也在用的话会用得更快。' })]),
    );
    return panel;
  }

  /* ---------------- 额度详情：第三方中转站的 Key ---------------- */

  /*
   * 第三方中转站（sub2api、new-api 这类）的 Key：余额、限额和这个 Key 的用量都是站点给的（src/core/relay-balance.ts）。
   * 余额那一半和 DeepSeek 一样（余额历史 → 花了多少、还能用几天、消耗趋势、余额走势）；
   * 另一半是站点自己的统计：Key 的总额度、限速窗口 / 订阅限额（画成进度条）、今天和累计的用量、每天的用量。
   * 没有本机用量、时间线、速度：TokenPulse 不知道本机哪些请求用的是这个 Key。
   */
  const WINDOW_NAME = { quota: 'Key 总额度', '5h': '5 小时', '1d': '1 天', '7d': '7 天', daily: '每日限额', weekly: '每周限额', monthly: '每月限额' };
  function relayBalancePanel(account, info, data, level) {
    const extra = account.last?.extra || {};
    const spend = info && data && data.currency === info.currency ? data.spend : null;
    const panel = el('article', { class: 'panel window-panel ds-window ' + level }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '余额' }), el('span', { class: 'section-tag', text: extra.plan || '第三方 Key', translate: extra.plan ? 'no' : null })])]);
    panel.append(el('div', { class: 'window-number' }, [
      el('strong', { class: 'num ds-total', text: info ? cash(info.total, info.currency) : extra.unlimited ? '不限额' : '—' }),
      el('span', { text: info ? '还能用的额度' : extra.unlimited ? '站点没有给这个 Key 设上限' : '站点没有返回余额' }),
    ]));
    panel.append(el('div', { class: 'window-meta' }, [
      el('span', {}, [el('span', { text: '站点' }), el('span', { class: 'num', text: ' ' + account.host, translate: 'no' })]),
      el('span', {}, [el('span', { text: '接口' }), el('span', { class: 'num', text: ' ' + (FLAVOR[account.flavor] || '—'), translate: 'no' })]),
    ]));
    if (!info) { panel.append(el('div', { class: 'prediction-line' }, [icon('trend'), el('span', { text: '没有余额这个数，花了多少和还能用几天算不出来。限额看右边。' })])); return panel; }
    if (!spend) { panel.append(el('div', { class: 'prediction-line' }, [icon('trend'), el('span', { text: '正在读取消耗记录…' })])); return panel; }
    spendBlocks(panel, spend, data, info);
    panel.append(el('p', { class: 'quota-footnote' }, [
      el('span', { text: '花掉多少按余额的变化算：TokenPulse 开着的时候每 10 分钟查一次余额，关着的那段时间合在一起算到下一次查到的时候。' }),
      data.since != null ? el('span', {}, [el('span', { text: '余额记录开始于' }), el('span', { class: 'num', text: ' ' + date(data.since, true) }), el('span', { text: '。' })]) : null,
      el('span', { text: '余额是站点上这个账户的，同一个账户下别的 Key、别的设备花的也在里面。' }),
    ]));
    return panel;
  }
  /** 站点自己统计的：这个 Key 的限额和用量。 */
  function sitePanel(account) {
    const extra = account.last?.extra, currency = account.last?.infos?.[0]?.currency || 'USD';
    const panel = el('article', { class: 'panel window-panel ds-local ds-site' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '这个 Key 在站点上' }), el('span', { class: 'section-tag', text: FLAVOR[account.flavor] || '站点统计', translate: 'no' })])]);
    if (!extra) { panel.append(empty('还没有查到。点「刷新」再查一次。')); return panel; }
    const { today, total } = extra;
    if (today) {
      panel.append(el('div', { class: 'window-number' }, [el('strong', { class: 'num', text: cash(today.cost, currency) }), el('span', { text: '这个 Key 今天花了' })]));
      panel.append(el('div', { class: 'window-meta' }, [
        el('span', {}, [el('span', { class: 'num', text: number(today.requests) + ' ' }), el('span', { text: '次请求' })]),
        el('span', { class: 'num', text: `${tokens(today.tokens)} Tokens` }),
      ]));
    }
    const bars = [...(extra.quota ? [{ name: 'quota', ...extra.quota }] : []), ...(extra.windows || [])];
    if (bars.length) {
      panel.append(el('div', { class: 'ds-limits' }, bars.map(bar => {
        const pct = bar.limit > 0 ? Math.min(100, bar.used / bar.limit * 100) : 0;
        return el('div', { class: 'quota-mini ds-limit', 'data-window': bar.name }, [
          el('div', { class: 'quota-mini-head' }, [el('span', { text: WINDOW_NAME[bar.name] || bar.name }), el('span', { class: 'num' + (pct >= 90 ? ' warn-text' : ''), text: `${cash(bar.used, currency)} / ${cash(bar.limit, currency)}` })]),
          track(pct, pct >= 90, '已用额度'),
          el('div', { class: 'mini-reset' }, [icon('clock'), bar.resetAt ? el('span', { class: 'num', text: `${duration(bar.resetAt - Date.now())}后重置 · ${date(bar.resetAt)}` })
            : el('span', { text: bar.name === 'quota' ? '这个 Key 的总额度，用完为止' : '站点没有给重置时间' })]),
        ]);
      })));
    } else {
      panel.append(el('div', { class: 'prediction-line' }, [icon('check'), el('span', { text: extra.unlimited ? '这个 Key 没有额度上限。' : '这个 Key 没有单独的额度上限和限速，用的是账户余额。' })]));
    }
    if (total) {
      panel.append(metricGroup('这个 Key 累计', 'tokens', [
        metric('花了', cash(total.cost, currency), { sub: '站点统计' }),
        metric('请求', number(total.requests), { unit: '次' }),
        metric('Tokens', amount(total.tokens), { approx: cnApprox(total.tokens) }),
      ]));
    }
    if (extra.expiresAt) {
      const left = extra.expiresAt - Date.now();
      panel.append(el('div', { class: 'prediction-line' + (left < 3 * DAY ? ' caution' : '') }, [icon(left < 3 * DAY ? 'alert' : 'clock'), el('span', {}, [el('span', { text: left > 0 ? '到期时间' : '已经到期' }), el('span', { class: 'num', text: ' ' + date(extra.expiresAt, true) })])]));
    }
    panel.append(el('p', { class: 'quota-footnote', text: account.flavor === 'newapi'
      ? '这类站点只告诉我们总额度和已经用了多少，没有每天的用量。数字是站点统计的。'
      : '这些是站点自己统计的数字，只算这一个 Key；别的工具用同一个 Key 也算在里面。' }));
    return panel;
  }
  function relayHistory(account, data, after) {
    const daily = el('div', { class: 'chart' }), line = el('div', { class: 'chart quota-trend' });
    const rows = (account.last?.extra?.daily || []).map(day => ({ day: day.date, tokens: day.tokens, costUsd: day.cost, requests: day.requests }));
    after.push(() => {
      const animate = entering();
      if (!rows.length) daily.replaceChildren(empty(account.flavor === 'newapi' ? '这类站点不提供每天的用量。' : '站点没有返回每天的用量：这个 Key 最近 30 天没用过，或者站点的版本不提供。'));
      else chart(daily, rows, 'tokens', false, animate);
      if (!data) line.replaceChildren(empty('正在读取…')); else balanceChart(line, data.track, data.currency, data.now, animate);
    });
    return el('div', { class: 'quota-history-grid' }, [
      el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '每天的用量 · 站点统计' })]), daily, el('p', { class: 'sample-caption', text: '这个 Key 最近 30 天每天用的 Tokens，数字来自站点。' })]),
      el('article', { class: 'panel' }, [el('div', { class: 'panel-heading' }, [el('h2', { text: '余额走势' })]), line, el('p', { class: 'sample-caption' }, [el('span', { text: '最近 30 天查到的余额。' }), data ? el('span', {}, [el('span', { class: 'num', text: number(data.sampleCount) + ' ' }), el('span', { text: '笔记录' })]) : null])]),
    ]);
  }
  function renderRelay(host, account, page) {
    page.classList.add('ds-no-timeline');
    const { last, infos, level } = health(account), name = nameOf(account);
    const entry = insightOf(account), data = entry.data, after = [];
    host.append(el('div', { class: 'quota-context ds-context ' + level }, [
      avatarOf(account),
      el('div', {}, [
        el('h2', {}, [el('span', { text: name, translate: 'no' }), account.label ? el('span', { class: 'context-who', text: account.host, translate: 'no' }) : null]),
        el('p', { class: 'muted', text: '第三方中转站的 Key：余额、限额和用量由站点提供' }),
      ]),
      el('div', { class: 'context-meta ds-context-meta' }, [
        el('div', {}, [last ? el('span', { class: 'num', text: clock(last.at) + ' ' }) : null, el('span', { text: last ? (last.ok ? '更新' : '查询失败') : account.loading ? '正在查询…' : '还没查询过' }), el('span', { text: ' · ' }), el('span', { text: '每 10 分钟自动查询' })]),
        el('div', { class: 'ds-context-actions' }, [
          button('刷新', () => call(() => api.refresh(account.id), '查询失败'), { glyph: 'refresh', action: 'ds-refresh', disabled: account.loading, cls: 'btn' + (account.loading ? ' is-busy' : '') }),
          button('设置', () => openDialog(account.id), { glyph: 'settings', action: 'ds-settings' }),
          button('添加账号', () => openDialog(null, 'relay'), { glyph: 'plus', action: 'ds-add' }),
        ]),
      ]),
    ]));
    const notes = warning(account);
    if (notes.length) host.append(el('p', { class: 'stale-note ds-note ' + level }, [icon('alert'), el('span', { class: 'ds-note-text' }, notes), last && !last.ok && infos.length ? el('span', { text: '下面显示的是之前查到的余额。' }) : null]));
    if (!infos.length && !last?.extra) {
      host.append(el('article', { class: 'panel empty large' }, [el('h3', { text: account.loading ? '正在查询余额…' : '还没有查到余额' }), el('p', { text: last?.error || '点「刷新」再查一次。' })]));
      return PREFIX + ':' + account.id;
    }
    const info = infos[0] || null;
    host.append(el('div', { class: 'quota-window-grid' }, [relayBalancePanel(account, info, data, level), sitePanel(account)]));
    if (info) host.append(trendPanel(account, data, after));
    host.append(relayHistory(account, data, after));
    host.append(el('article', { class: 'panel ds-about' }, [
      el('div', { class: 'ds-about-row' }, [el('b', { text: '余额提醒' }), account.alertBelow != null
        ? el('span', { class: 'ds-about-alert num', text: `余额低于 ${cash(account.alertBelow, info?.currency || 'USD')} 时提醒一次` })
        : el('span', { text: '没有设提醒线。点「设置」可以设一个数，余额低于它时提醒你。' })]),
      el('div', { class: 'ds-about-row' }, [el('b', { text: 'API Key' }), el('span', { class: 'num', text: account.keyHint, translate: 'no' }), el('span', { class: 'ds-about-faint', text: '只保存在这台电脑上，只用来查余额' })]),
      el('div', { class: 'ds-about-row' }, [el('b', { text: '站点地址' }), el('span', { class: 'num', text: account.baseUrl, translate: 'no' }), el('span', { class: 'ds-about-faint', text: 'Key 只发给这个地址' })]),
      el('p', { class: 'ds-about-hint', text: '查余额用的是站点提供的查询接口，不花额度。本机哪些请求用了这个 Key，TokenPulse 分不出来，所以这一页没有本机用量、时间线和速度。' }),
    ]));
    for (const draw of after) draw();
    return PREFIX + ':' + account.id;
  }

  /** 画这个账号的那一页，返回实际选中的标签（账号被删了就落到第一个）。timelineNode：app.js 里那块「模型与思考等级 · 时间线」。 */
  function renderQuota(host, key, timelineNode) {
    const list = accounts();
    // 空的 DeepSeek 入口（key 就是 deepseek）：不落到别的账号上
    const account = key === PREFIX ? null : list.find(item => PREFIX + ':' + item.id === key) || list[0];
    const page = document.getElementById('page-quota');
    page.classList.toggle('ds-no-timeline', !account?.harness);
    if (account && isRelay(account)) return renderRelay(host, account, page);
    if (!account) {
      host.append(el('article', { class: 'panel empty large ds-empty' }, [
        el('h3', { text: 'DeepSeek 余额监控' }),
        el('p', { text: 'DeepSeek 按量付费，没有订阅额度。填一个 API Key，就能在这里看到余额，低于你设的数时提醒你。' }),
        el('p', { text: '有几个 DeepSeek 账号就可以填几个 Key，每个账号各有一页。' }),
        button('填写 API Key', () => openDialog(null), { cls: 'btn btn-accent', action: 'ds-setup' }),
      ]));
      return PREFIX;
    }
    const { last, infos, level } = health(account);
    const name = account.label || account.keyHint;
    const entry = insightOf(account), data = entry.data, after = [];
    host.append(el('div', { class: 'quota-context ds-context ' + level }, [
      avatar('deepseek'),
      el('div', {}, [
        el('h2', {}, ['DeepSeek', el('span', { class: 'context-who', text: name, title: `${name} · ${account.keyHint}`, translate: 'no' })]),
        el('p', { class: 'muted', text: account.harness ? '按量付费，没有订阅额度窗口，看的是余额 · 本机 DeepSeek Harness 的用量算在这个账号上' : '按量付费，没有订阅额度窗口，看的是余额' }),
      ]),
      el('div', { class: 'context-meta ds-context-meta' }, [
        el('div', {}, [last ? el('span', { class: 'num', text: clock(last.at) + ' ' }) : null, el('span', { text: last ? (last.ok ? '更新' : '查询失败') : account.loading ? '正在查询…' : '还没查询过' }), el('span', { text: ' · ' }), el('span', { text: '每 10 分钟自动查询' })]),
        el('div', { class: 'ds-context-actions' }, [
          button('刷新', () => call(() => api.refresh(account.id), '查询失败'), { glyph: 'refresh', action: 'ds-refresh', disabled: account.loading, cls: 'btn' + (account.loading ? ' is-busy' : '') }),
          button('设置', () => openDialog(account.id), { glyph: 'settings', action: 'ds-settings' }),
          button('添加账号', () => openDialog(null), { glyph: 'plus', action: 'ds-add' }),
        ]),
      ]),
    ]));
    const notes = warning(account);
    if (notes.length) host.append(el('p', { class: 'stale-note ds-note ' + level }, [icon('alert'), el('span', { class: 'ds-note-text' }, notes), last && !last.ok && infos.length ? el('span', { text: '下面显示的是之前查到的余额。' }) : null]));
    if (entry.failed && !data) host.append(el('p', { class: 'stale-note ds-note' }, [icon('alert'), el('span', { text: '消耗和用量的统计没有读出来，下面只有余额。点「刷新」再试一次。' })]));
    if (!infos.length) {
      host.append(el('article', { class: 'panel empty large' }, [el('h3', { text: account.loading ? '正在查询余额…' : '还没有查到余额' }), el('p', { text: last?.error || '点「刷新」再查一次。' })]));
      page.classList.add('ds-no-timeline');
      return PREFIX + ':' + account.id;
    }
    const main = infos.find(info => info.currency === data?.currency) || infos[0];
    host.append(el('div', { class: 'quota-window-grid' }, [balancePanel(account, main, data, level), localPanel(account, data, main.currency)]));
    // 同一个账号还有别的币种的余额：只列数字
    const others = infos.filter(info => info !== main);
    if (others.length) host.append(el('div', { class: 'ds-other-grid' }, others.map(info => el('article', { class: 'panel ds-other', 'data-currency': info.currency }, [
      el('span', { class: 'ds-figure-title', text: '另一种币种的余额' }), el('strong', { class: 'num', text: cash(info.total, info.currency) }),
      el('small', {}, [el('span', { text: '充值余额' }), el('span', { class: 'num', text: ` ${cash(info.toppedUp, info.currency)} · ` }), el('span', { text: '赠送余额' }), el('span', { class: 'num', text: ` ${cash(info.granted, info.currency)}` })]),
    ]))));
    host.append(trendPanel(account, data, after), historyGrid(account, data, after));
    if (account.harness) {
      // 时间线、速度：只画本机 DeepSeek Harness 的请求，所以只在指定了本机用量的那个账号下面有
      if (timelineNode) host.append(timelineNode);
      window.PulseModelStudy?.timeline(current, PREFIX + ':' + account.id, { kind: 'deepseek', accountId: PREFIX + ':' + account.id, lastCheckedAt: last?.at || 0 });
      host.append(speedPanel({ accountId: 'harness', accountLabel: '' }, 'deepseek', {
        tag: 'DeepSeek Harness',
        hint: '每个模型每秒输出多少 Token。DeepSeek Harness 自己在日志里记了每次回复的出字时间，不用开透明转发。只要会话文件还在，以前的也能看。',
        load: days => api.speed(days),
        empty: () => el('div', { class: 'empty speed-empty' }, [el('p', { text: '这段时间还没有量到速度。用 DeepSeek Harness 聊几句，下一次扫描之后这里就会有走势；回复太短（不到 20 个 Token）的不算。' })]),
      }));
    }
    host.append(modelsPanel(account, data));
    const currency = main.currency;
    host.append(el('article', { class: 'panel ds-about' }, [
      el('div', { class: 'ds-about-row' }, [el('b', { text: '余额提醒' }), account.alertBelow != null
        ? el('span', { class: 'ds-about-alert num', text: `余额低于 ${cash(account.alertBelow, currency)} 时提醒一次` })
        : el('span', { text: '没有设提醒线。点「设置」可以设一个数，余额低于它时提醒你。' })]),
      el('div', { class: 'ds-about-row' }, [el('b', { text: 'API Key' }), el('span', { class: 'num', text: account.keyHint, translate: 'no' }), el('span', { class: 'ds-about-faint', text: '只保存在这台电脑上，只用来查余额' })]),
      el('p', { class: 'ds-about-hint', text: '本机 DeepSeek Harness 的每一次请求在「用量明细」里，工具选 DeepSeek Harness。' }),
    ]));
    for (const draw of after) draw();
    return PREFIX + ':' + account.id;
  }

  /* ---------------- 总览里的卡片 ---------------- */

  /*
   * 和 ChatGPT / Claude / Grok 一样，在总览的「官方额度」那一排里占卡片（app.js 的 renderOverview 调 cards()）：
   * DeepSeek 一张，第三方中转站的 Key 一张（有才出现）。
   * 结构照着官方账号的卡片：头（图标、名字、状态）→ 圆环 + 大数字 → 几行小结 → 其余账号的队列 → 页脚。
   * 官方账号的圆环是「额度还剩百分之几」，这里没有百分比：圆环画的是按最近 7 天的速度还能用多少天（30 天以上画满），中间写天数。
   * DeepSeek 的主角是指定了本机用量的那个账号（没有就第一个），中转站的主角是第一个；其余的排在下面，点哪一行去哪个账号的页。
   */
  function leftRing(left) {
    const node = ring({});
    const center = el('div', { class: 'ring-center' });
    if (left == null) center.append(el('div', { class: 'quota-remaining empty-number', text: '—' }));
    else {
      const [value, unit] = left >= 365 ? ['>1', '年'] : left >= 1 ? [String(left >= 10 ? Math.round(left) : left.toFixed(1)), '天'] : [String(Math.max(1, Math.round(left * 24))), '时'];
      node.firstChild.append(svg('circle', { class: 'ring-value ring-five' + (left < 3 ? ' critical' : ''), cx: 50, cy: 50, r: 44, 'stroke-dasharray': RING, 'stroke-dashoffset': RING * (1 - Math.min(1, left / 30)) }));
      center.append(el('div', { class: 'quota-remaining' }, [el('span', { class: 'num', text: value }), el('small', { text: unit })]));
    }
    node.append(center);
    node.title = '按最近 7 天的速度还能用多久；30 天以上画满';
    return node;
  }
  function cardFor(kind) {
    const relay = kind === 'relay';
    const list = accounts().filter(account => isRelay(account) === relay);
    const node = (level, body) => el('article', { class: `quota-card ${relay ? 'relay' : 'deepseek'} ${level}`, 'data-ds-balance': kind }, body);
    const head = (lead, badge) => el('div', { class: 'account-head' }, [
      lead && relay ? avatarOf(lead) : avatar('deepseek'),
      el('div', { class: 'account-title' }, [el('span', { class: 'account-name', text: relay ? nameOf(lead) : 'DeepSeek', translate: 'no' }),
        relay ? el('span', { class: 'plan', text: '第三方 Key' }) : lead ? el('span', { class: 'plan who', text: nameOf(lead), translate: 'no' }) : el('span', { class: 'plan', text: '按量付费' })]),
      el('span', { class: 'badge ' + badge[1], text: badge[0] }),
    ]);
    if (!list.length) {
      // 还没填 DeepSeek 的 Key：本机装了 DeepSeek Harness 才主动露出这张卡片
      if (relay || !balance.detected) return null;
      return node('intro', [
        head(null, ['还没填 Key', '']),
        el('div', { class: 'quota-hero' }, [leftRing(null), el('div', { class: 'quota-hero-text' }, [el('span', { class: 'quota-hero-label', text: '总余额' }), el('span', { class: 'quota-hero-value', text: 'DeepSeek 余额监控' })])]),
        el('div', { class: 'quota-missing' }, [el('p', { text: 'DeepSeek 按量付费，没有订阅额度。填一个 API Key，就能在这里看到余额，低于你设的数时提醒你。' })]),
        el('div', { class: 'ds-card-setup' }, button('填写 API Key', () => openDialog(null), { cls: 'btn btn-accent', action: 'setup' })),
        el('div', { class: 'quota-card-foot' }, [el('span', { text: '本机装了 DeepSeek Harness' }), el('span')]),
      ]);
    }
    const lead = (!relay && list.find(account => account.harness)) || list[0];
    const { last, infos, level } = health(lead), extra = last?.extra;
    const data = insightOf(lead).data, info = infos.find(item => item.currency === data?.currency) || infos[0];
    const spend = info && data && data.currency === info.currency ? data.spend : null;
    const levels = list.map(account => health(account).level);
    const worst = levels.includes('bad') ? 'bad' : levels.includes('low') ? 'low' : '';
    const badge = !last ? [lead.loading ? '正在查询…' : '还没查询过', ''] : !last.ok ? ['查询失败', 'critical'] : level === 'bad' ? ['余额用完', 'critical'] : level === 'low' ? ['余额偏低', 'warning']
      : spend?.daysLeft != null && spend.daysLeft < 3 ? ['快用完了', 'critical'] : !info && extra?.unlimited ? ['不限额', 'good'] : ['余额充足', 'good'];
    const body = [head(lead, badge)];
    body.push(el('div', { class: 'quota-hero' }, [leftRing(spend?.daysLeft ?? null), el('div', { class: 'quota-hero-text' }, [
      el('span', { class: 'quota-hero-label', text: relay ? '余额' : '总余额' }),
      el('span', { class: 'quota-hero-value ds-card-total num ' + level, text: info ? cash(info.total, info.currency) : extra?.unlimited ? '不限额' : '—' }),
      relay ? el('span', { class: 'quota-hero-sub', translate: 'no', text: [extra?.plan, lead.label ? lead.host : ''].filter(Boolean).join(' · ') || lead.host })
        : info ? el('span', { class: 'quota-hero-sub' }, [el('span', { text: '充值' }), el('span', { class: 'num', text: ` ${cash(info.toppedUp, info.currency)} · ` }), el('span', { text: '赠送' }), el('span', { class: 'num', text: ` ${cash(info.granted, info.currency)}` })])
        : el('span', { class: 'quota-hero-sub', text: last?.error || '还没有查到余额' }),
    ])]));
    const notes = warning(lead);
    if (notes.length) body.push(el('p', { class: 'ds-card-warn ' + level }, [icon('alert'), el('span', { class: 'ds-note-text' }, notes)]));
    const row = (label, value) => el('div', { class: 'ds-card-row' }, [el('span', { text: label }), el('b', { class: 'num', text: value })]);
    const none = !spend || data.since == null;
    body.push(el('div', { class: 'ds-card-rows' }, [
      row('今天花了', none ? '—' : cash(spend.today, info.currency)),
      row('最近 7 天花了', none ? '—' : cash(spend.d7, info.currency)),
      el('div', { class: 'ds-card-row' }, [el('span', { text: '按这个速度还能用' }), spend?.daysLeft != null ? el('b', { class: spend.daysLeft < 3 ? 'warn-text' : '', text: daysText(spend.daysLeft) }) : el('b', { class: 'muted', text: '暂无法估计' })]),
      !relay && lead.harness && data ? el('div', { class: 'ds-card-row' }, [el('span', { text: '本机今天用了' }), el('b', { class: 'num', text: `${tokens(data.localUsage.today.tokens)} Tokens` })]) : null,
      relay && extra?.today ? el('div', { class: 'ds-card-row' }, [el('span', { text: '这个 Key 今天用了' }), el('b', { class: 'num', text: `${tokens(extra.today.tokens)} Tokens` })]) : null,
    ]));
    const others = list.filter(account => account !== lead);
    if (others.length) {
      body.push(el('div', { class: 'pool-queue ds-card-queue' }, [
        el('div', { class: 'pool-queue-head' }, [el('span', { text: relay ? '其他第三方 Key' : '其他 DeepSeek 账号' }), el('small', {}, [el('span', { class: 'num', text: String(list.length) + ' ' }), el('span', { text: relay ? '个 Key' : '个账号' })])]),
        ...others.slice(0, 3).map(account => {
          const state = health(account), first = state.infos[0];
          const item = el('button', { type: 'button', class: 'pool-queue-row ds-balance-row ' + state.level, 'data-account': account.id, title: '查看这个账号' }, [
            mark(account, 'ds-queue-logo'),
            el('span', { class: 'pool-queue-name', text: nameOf(account), translate: 'no' }),
            state.level ? el('span', { class: 'pool-queue-tag ds-queue-tag ' + state.level, text: state.last && !state.last.ok ? '查询失败' : state.empty ? '余额用完' : '余额偏低' }) : el('span', { 'aria-hidden': 'true' }),
            el('span', { class: 'pool-queue-left num', text: first ? cash(first.total, first.currency) : state.last?.extra?.unlimited ? '不限额' : '—' }),
          ]);
          item.addEventListener('click', () => goQuota(PREFIX + ':' + account.id));
          return item;
        }),
        others.length > 3 ? el('small', { class: 'ds-queue-more' }, [el('span', { text: '还有' }), el('span', { class: 'num', text: ` ${others.length - 3} ` }), el('span', { text: '个账号，在额度详情里' })]) : null,
      ]));
    }
    const loading = list.some(account => account.loading);
    const refresh = el('button', { type: 'button', class: 'text-btn' + (loading ? ' is-busy' : ''), 'data-action': 'refresh', disabled: loading ? '' : null }, [icon('refresh'), el('span', { text: '刷新' })]);
    refresh.addEventListener('click', () => call(() => Promise.all(list.map(account => api.refresh(account.id))).then(states => states.at(-1)), '查询失败'));
    const link = el('button', { type: 'button', class: 'text-btn', 'data-action': 'detail', 'aria-label': relay ? '第三方 Key 额度详情' : 'DeepSeek 额度详情' }, [el('span', { text: '详情' }), icon('arrow')]);
    link.addEventListener('click', () => goQuota(PREFIX + ':' + lead.id));
    body.push(el('div', { class: 'quota-card-foot' }, [updated(lead) || el('span'), el('span', { class: 'ds-card-actions' }, [refresh, link])]));
    return node(worst, body);
  }
  function cards() { return balance && !demo() ? [cardFor(PREFIX), cardFor('relay')].filter(Boolean) : []; }
  /** 余额刚查到、分析刚算完的时候：只换总览里这两张卡片，别的卡片不动。 */
  function renderCard() {
    const host = document.getElementById('quota-cards');
    if (!host || !balance || demo()) return;
    for (const kind of [PREFIX, 'relay']) {
      const old = host.querySelector(`[data-ds-balance="${kind}"]`), next = cardFor(kind);
      if (next) next.style.setProperty('--i', String(old ? [...host.children].indexOf(old) : host.children.length));
      if (old && next) old.replaceWith(next); else if (old) old.remove(); else if (next && host.children.length) host.append(next);
    }
  }

  function render() {
    renderCard();
    // 额度详情开着：标签和这一页跟着更新（选中的不是 DeepSeek 的账号时，等于只重画了标签）
    if (typeof current !== 'undefined' && current && !document.getElementById('page-quota').hidden) keepScroll(() => renderQuota_());
  }
  const renderQuota_ = () => window.renderQuota();
  function apply(next) { if (!next || !Array.isArray(next.accounts)) return; balance = next; render(); if (dialog) syncDialog(); }

  /* ---------------- 添加 / 设置一个账号的对话框 ---------------- */

  /** kind：新加的时候先选中哪一种（deepseek / relay），对话框里可以换；改已有账号时类型不能换。 */
  function openDialog(id, kind = PREFIX) {
    if (dialog || !balance || demo()) return;
    const account = id ? accounts().find(item => item.id === id) : null;
    if (id && !account) return;
    let relay = account ? isRelay(account) : kind === 'relay';
    const overlay = el('div', { class: 'modal ds-balance-modal', id: 'ds-balance-dialog' });
    const card = el('section', { class: 'modal-card ds-balance-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ds-balance-title' });
    const label = el('input', { type: 'text', name: 'ds-balance-label', maxlength: '30', autocomplete: 'off', spellcheck: 'false', 'aria-label': '账号名称', placeholder: '比如：个人、公司', value: account?.label || '' });
    const key = el('input', { type: 'password', name: 'ds-balance-key', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API Key', placeholder: account ? `已保存 ${account.keyHint}，不换就留空` : 'sk-…' });
    // 站点地址：只有第三方中转站要填；保存之后不能改（换站点等于换了一个账号，删掉重加）
    const url = el('input', { type: 'text', name: 'ds-balance-url', autocomplete: 'off', spellcheck: 'false', 'aria-label': '站点地址', placeholder: 'https://example.com', value: account?.baseUrl || '', disabled: account ? '' : null });
    const alert = el('input', { type: 'number', name: 'ds-balance-alert', min: '0', step: '1', inputmode: 'decimal', 'aria-label': '提醒金额', value: account?.alertBelow != null ? String(account.alertBelow) : '' });
    // 本机 DeepSeek Harness 的用量算在哪个账号上：第一个 DeepSeek 账号默认勾上，之后加的默认不勾
    const harness = el('input', { type: 'checkbox', name: 'ds-balance-harness', checked: (account ? account.harness : !accounts().some(item => !isRelay(item))) ? '' : null });
    const error = el('p', { class: 'ds-balance-error', role: 'alert', hidden: '' });
    // 图标（只有第三方 Key 有）：自动匹配 / 首字母 / 预设 / 上传的图片。选的东西先记在 look 里，保存时一起送
    const look = { icon: account?.icon || '', avatar: account?.avatar || '' };
    const lookNow = el('div', { class: 'pv-avatar-now' });
    const lookGrid = el('div', { class: 'pv-avatar-grid', role: 'radiogroup', 'aria-label': '选择图标' });
    const syncLook = () => {
      const draft = { kind: 'relay', label: label.value.trim(), host: (() => { try { return new URL(/^https?:\/\//i.test(url.value.trim()) ? url.value.trim() : 'https://' + url.value.trim()).host; } catch { return ''; } })(), baseUrl: url.value.trim(), icon: look.icon, avatar: look.avatar };
      const image = imageOf(draft);
      lookNow.replaceChildren(avatarOf(draft), el('div', {}, [el('b', { text: '图标' }), el('small', { text: look.avatar ? '自定义图片' : look.icon === 'letter' ? '名称首字母' : look.icon ? (window.PulseAvatars?.byId(look.icon)?.label || look.icon) : image ? `自动匹配：${image.label}` : '自动匹配：没认出来，先用首字母' })]));
      for (const tile of lookGrid.querySelectorAll('[data-icon]')) { const on = !look.avatar && tile.dataset.icon === look.icon; tile.classList.toggle('on', on); tile.setAttribute('aria-checked', String(on)); }
    };
    const lookTile = (value, text, content) => { const tile = el('button', { type: 'button', class: 'pv-avatar-tile', role: 'radio', 'data-icon': value, title: text, 'aria-label': text }, content); tile.addEventListener('click', () => { look.icon = value; look.avatar = ''; syncLook(); }); return tile; };
    lookGrid.append(lookTile('', '自动匹配', [icon('refresh')]), lookTile('letter', '名称首字母', [el('b', { text: 'Aa' })]),
      ...(window.PulseAvatars?.PRESETS || []).map(item => lookTile(item.id, item.label, [el('img', { src: item.src, alt: '', class: item.mono ? 'mono' : null, draggable: 'false' })])));
    const lookFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', hidden: '', 'aria-label': '上传图标图片' });
    lookFile.addEventListener('change', async () => {
      const picked = lookFile.files?.[0]; lookFile.value = '';
      if (!picked) return;
      try { look.avatar = await window.PulseAvatars.readImage(picked); error.hidden = true; syncLook(); }
      catch (failure) { error.textContent = failure?.message || '图片读取失败'; error.hidden = false; }
    });
    const lookField = el('section', { class: 'pv-avatar-field ds-balance-look' }, [
      el('div', { class: 'pv-avatar-head' }, [lookNow, el('div', { class: 'pv-avatar-actions' }, [button('上传图片', () => lookFile.click(), { glyph: 'plus', action: 'upload-icon' }), lookFile])]),
      lookGrid,
    ]);
    label.addEventListener('input', () => { if (!look.icon && !look.avatar) syncLook(); });
    url.addEventListener('input', () => { if (!look.icon && !look.avatar) syncLook(); });
    const save = button(account ? '保存' : '添加', () => submit(), { cls: 'btn btn-accent', action: 'save' });
    const remove = account ? button('删除这个账号', async () => { const next = await call(() => api.remove(account.id), '删除失败'); if (next) { toast(relay ? '已删除这个 Key' : '已删除这个 DeepSeek 账号'); closeDialog(); } }, { glyph: 'trash', action: 'remove' }) : null;
    const link = el('button', { type: 'button', class: 'ds-balance-link', text: KEYS_URL.replace('https://', ''), title: '复制网址' });
    link.addEventListener('click', async () => { try { await navigator.clipboard.writeText(KEYS_URL); toast('已复制网址'); } catch { toast('复制失败，请手动选中复制', { kind: 'error' }); } });
    const close = button('', () => closeDialog(), { cls: 'btn icon-only ds-balance-close', glyph: 'close', action: 'close' });
    close.setAttribute('aria-label', '关闭');
    const title = el('h3', { id: 'ds-balance-title' });
    const pick = account ? null : el('div', { class: 'seg compact ds-balance-kind', role: 'group', 'aria-label': 'Key 的类型' }, [el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      el('button', { type: 'button', 'data-kind-pick': PREFIX, text: 'DeepSeek 官方' }), el('button', { type: 'button', 'data-kind-pick': 'relay', text: '第三方中转站' })]);
    const urlField = el('label', { class: 'ds-balance-field' }, [el('span', { text: '站点地址' }), url,
      el('small', { text: account ? '站点地址保存之后不能改；换站点请删掉重新添加。' : '中转站的网址，比如 https://example.com。支持 sub2api 和 new-api / one-api 搭的站，添加时会自动认。' })]);
    const officialHint = el('small', {}, [el('span', { text: '在 DeepSeek 开放平台创建：' }), link]);
    const relayHint = el('small', { text: 'Key 只会发给你上面填的这个站点地址。' });
    const harnessField = el('label', { class: 'ds-balance-check' }, [harness, el('span', {}, [el('b', { text: '本机 DeepSeek Harness 用的是这个账号' }),
      el('small', { text: '勾上之后，本机 Harness 的用量、时间线、速度都显示在这个账号下面。只能有一个账号勾上。' })])]);
    const syncKind = () => {
      title.textContent = account ? (relay ? '设置第三方 Key' : '设置 DeepSeek 账号') : relay ? '添加第三方 Key' : '添加 DeepSeek 账号';
      urlField.hidden = !relay; relayHint.hidden = !relay; officialHint.hidden = relay; harnessField.hidden = relay; lookField.hidden = !relay;
      if (relay) syncLook();
      if (pick) { for (const item of pick.querySelectorAll('button')) item.classList.toggle('on', (item.dataset.kindPick === 'relay') === relay); syncSeg(pick); }
      if (dialog) dialog.relay = relay;
    };
    pick?.addEventListener('click', event => {
      const picked = event.target.closest('[data-kind-pick]');
      if (!picked) return;
      relay = picked.dataset.kindPick === 'relay'; error.hidden = true; syncKind(); (relay ? url : key).focus();
    });
    card.append(
      el('header', { class: 'ds-balance-head' }, [title, close]),
      ...(pick ? [pick] : []),
      urlField,
      el('label', { class: 'ds-balance-field' }, [el('span', { text: 'API Key' }), key, officialHint, relayHint,
        el('small', { text: 'Key 只保存在这台电脑上，只用来查余额。查余额不花钱。' })]),
      el('label', { class: 'ds-balance-field' }, [el('span', { text: '账号名称（可以不填）' }), label,
        el('small', { text: '有几个账号时用来区分，显示在标签上。' })]),
      lookField,
      el('label', { class: 'ds-balance-field' }, [el('span', { text: '余额低于多少时提醒' }), alert,
        el('small', { text: '按余额的币种算。留空或填 0 表示不提醒。' })]),
      harnessField,
      error,
      el('div', { class: 'ds-balance-foot' }, [remove, el('span', { class: 'ds-balance-gap' }), button('取消', () => closeDialog(), { action: 'cancel' }), save]),
    );
    overlay.append(card);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeDialog(); });
    overlay.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeDialog(); } else if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); submit(); } });
    document.body.append(overlay);
    document.body.classList.add('modal-open');
    dialog = { overlay, id: account?.id || null, relay, look, label, key, url, alert, harness, error, save, remove, busy: false, lastFocus: document.activeElement };
    syncKind();
    (account ? label : relay ? url : key).focus();
  }
  function syncDialog() {
    const { save, remove, busy, id } = dialog;
    save.disabled = busy; if (remove) remove.disabled = busy;
    save.querySelector('span').textContent = busy ? '正在验证…' : id ? '保存' : '添加';
  }
  function closeDialog() {
    if (!dialog) return;
    const { overlay, lastFocus } = dialog;
    dialog = null;
    overlay.remove();
    if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
    if (lastFocus?.isConnected) lastFocus.focus?.();
  }
  async function submit() {
    if (!dialog || dialog.busy) return;
    const now = dialog, value = now.key.value.trim(), raw = now.alert.value.trim();
    const fail = text => { now.error.textContent = text; now.error.hidden = false; };
    now.error.hidden = true;
    const site = now.url.value.trim();
    if (now.relay && !now.id && !site) return fail('请先填站点地址');
    if (now.relay && !now.id && !/^(https?:\/\/)?[^\s/]+\.[^\s/]+|^https?:\/\/localhost/i.test(site)) return fail('站点地址不对，应该像 https://example.com');
    if (!value && !now.id) return fail('请先填 API Key');
    if (value && !now.relay && !/^sk-[A-Za-z0-9_-]{16,200}$/.test(value)) return fail('这不像 DeepSeek 的 API Key（应该是 sk- 开头的一串）');
    if (value && now.relay && !/^[\x21-\x7e]{8,300}$/.test(value)) return fail('这不像 API Key（应该是一串不带空格的字符）');
    if (raw && !(Number(raw) >= 0)) return fail('提醒金额请填 0 或更大的数');
    now.busy = true; syncDialog();
    try {
      const body = { label: now.label.value, alertBelow: raw ? Number(raw) : null, ...(now.relay ? { kind: 'relay', baseUrl: site, icon: now.look.icon, avatar: now.look.avatar } : { harness: now.harness.checked }), ...(value ? { key: value } : {}) };
      const next = now.id ? await api.update(now.id, body) : await api.add(body);
      now.key.value = '';
      const id = now.id || next.id;
      // 新加的账号：额度详情开着的话直接切到它那一页
      if (!now.id && id && owns(state.account)) state.account = PREFIX + ':' + id;
      apply(next);
      toast(now.id ? '已保存' : now.relay ? '已添加第三方 Key' : '已添加 DeepSeek 账号');
      if (dialog === now) closeDialog();
      const saved = next.accounts.find(item => item.id === id);
      if (saved?.last && !saved.last.ok) toast(saved.last.error || '查询失败', { kind: 'error' });
    } catch (error) {
      if (dialog === now) { now.busy = false; syncDialog(); fail(clean(error) || '保存失败'); }
    }
  }

  document.getElementById('open-deepseek-balance')?.addEventListener('click', async () => {
    if (demo()) return;
    if (!balance) balance = await api.state().catch(() => null);
    if (balance) openDialog(null);
  });
  /** 拖动标签之后存顺序。keys 是标签上的 deepseek:<id>。 */
  // 拖的是同一类（DeepSeek 或中转站）里的几个：别的类的账号留在原来的位置
  const reorder = async keys => {
    const ids = keys.map(key => String(key).slice(PREFIX.length + 1)), moved = new Set(ids), queue = [...ids];
    apply(await api.reorder(accounts().map(account => (moved.has(account.id) ? queue.shift() : account.id))));
  };
  document.getElementById('open-relay-balance')?.addEventListener('click', async () => {
    if (demo()) return;
    if (!balance) balance = await api.state().catch(() => null);
    if (balance) openDialog(null, 'relay');
  });
  window.DeepSeekBalance = { render, cards, tabs, tabButton, owns, renderQuota, reorder, state: () => balance, open: openDialog };
  api.onState(apply);
  api.state().then(apply).catch(() => {});
})();
