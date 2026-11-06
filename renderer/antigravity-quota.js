/*
 * Google Antigravity 的额度与深度分析（主进程见 src/main/antigravity-quota.ts）。
 *
 * 和 ChatGPT / Claude / Grok 一样，在总览「官方额度」里占一张卡片、在额度详情顶上占一个标签。
 * Antigravity 的额度按型号分组（例如 Gemini 一组、Claude 与 GPT-OSS 一组），每组同时有「5 小时窗口」和「周额度窗口」两道配额：
 * - GetUserStatus 提供套餐等级、积分（Prompt / Flow）与 5 小时窗口剩余比例；
 * - RetrieveUserQuotaSummary 提供分组的 5 小时与周额度双窗口剩余比例与重置时间；
 * - 本机对话数据库（~/.gemini/antigravity/conversations/*.db）提供每次生成的 Token 明细、内部返回型号、首字延迟与流式出字速度。
 * 用到 app.js 的公共函数（el / svg / icon / ring / track / avatar / duration / date / percent / tokens / amount / money / number / markLayout / navigate / state / chart / speedPanel / stagger / keepScroll / entering / syncSeg），所以在它后面加载。
 */
(function () {
  const api = window.tokenpulse?.antigravityQuota;
  if (!api) return;
  const KEY = 'antigravity';
  const COLORS = ['var(--antigravity)', 'var(--claude)', '#8b5cf6', '#0ea5a4'];
  /** 超过这么久没查到就当作过期（和官方账号一样 15 分钟）。 */
  const STALE_MS = 15 * 60000;
  const EFFORT_LABEL = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
  const CONFIDENCE_TEXT = { medium: '样本较充分', low: '初步参考', current: '按当前窗口估算', insufficient: '样本不足' };
  let quota = null;
  let studyWindow = 'five';
  let capWindow = 'five';
  let capMetric = 'tokens';

  const demo = () => Boolean(window.tokenpulse?.isDemo?.());
  const visible = () => Boolean(quota?.installed) && !demo();
  const last = () => quota?.last;
  const insight = () => quota?.insight || null;
  const groups = () => last()?.groups || [];
  const stale = () => !last()?.ok || Date.now() - (last()?.at || 0) > STALE_MS;
  /** 组名：组里的型号（不翻译）。 */
  const groupName = group => el('span', { class: 'agy-group-name', translate: 'no', text: group.models.join(' · ') });
  /** 重置时间已经过了、还没查到新的：不显示旧的百分比。 */
  const ended = item => Boolean(item?.resetAt && Date.parse(item.resetAt) <= Date.now());
  const resetText = item => !item ? '没有重置时间' : ended(item) ? '已经重置，等待下一次查询' : item.resetAt ? `${duration(Date.parse(item.resetAt) - Date.now())}后重置 · ${date(Date.parse(item.resetAt))}` : '没有重置时间';
  const effectiveUsed = group => {
    const fiveUsed = ended(group) ? 0 : (group.used || 0);
    const weekUsed = group.week && !ended(group.week) ? (group.week.used || 0) : 0;
    return Math.max(fiveUsed, weekUsed);
  };
  const levelOf = group => {
    const u = effectiveUsed(group);
    if (ended(group) && (!group.week || ended(group.week))) return '';
    return u >= 100 ? 'critical' : u >= 90 ? 'critical' : u >= 75 ? 'warning' : 'good';
  };
  const planText = () => [last()?.tier, last()?.plan && last()?.plan !== last()?.tier ? last()?.plan : ''].filter(Boolean).join(' · ');
  const updatedText = () => {
    const at = last()?.at;
    if (quota?.loading) return '正在查询…';
    if (!at) return '还没查询过';
    return `${date(at)} ${last()?.ok ? '更新' : '查询失败'}`;
  };
  /** 关着、查询失败、过期：说清楚现在看到的是什么。 */
  function notes() {
    const out = [];
    if (!quota?.running) out.push(last()?.at ? 'Antigravity 现在没有开着，下面是最后一次查到的额度。打开 Antigravity 后会自动更新。' : '打开 Antigravity 后才能查到额度：额度只能问本机开着的 Antigravity。');
    else if (last() && !last().ok) out.push([last().error || '查询失败', '下面是之前查到的额度。']);
    else if (last()?.ok && stale()) out.push('超过 15 分钟没有查到新的额度，数字可能已经变了。');
    return out;
  }
  const refresh = async () => {
    try { apply(await api.refresh()); } catch (error) { toast(error?.message || '查询失败', { kind: 'error' }); }
  };
  const refreshButton = (cls = 'btn') => {
    const b = el('button', { type: 'button', class: cls + (quota?.loading ? ' is-busy' : ''), 'data-action': 'agy-refresh', disabled: quota?.loading ? '' : null }, [icon('refresh'), el('span', { text: '刷新' })]);
    b.addEventListener('click', refresh);
    return b;
  };

  /* ---------------- 按窗口采样估速度 ---------------- */

  /** 这一组在当前窗口（同一个重置时间）里的采样：算每小时用掉几个百分点，预测重置时用到多少。 */
  function forecast(group, windowKind = 'five') {
    const target = windowKind === 'week' ? group?.week : group;
    if (!target?.resetAt || ended(target)) return null;
    const reset = Date.parse(target.resetAt);
    const points = (quota?.history || []).flatMap(sample => sample.groups.filter(item => {
      if (item.key !== group.key) return false;
      const r = windowKind === 'week' ? item.weekResetAt : item.resetAt;
      const u = windowKind === 'week' ? item.weekUsed : item.used;
      return u != null && r && Math.abs(Date.parse(r) - reset) < 15 * 60000;
    }).map(item => ({ at: sample.at, used: windowKind === 'week' ? item.weekUsed : item.used })));
    if (points.length < 2) return null;
    const first = points[0], end = points[points.length - 1];
    const hours = (end.at - first.at) / 3600000;
    if (hours < 1 / 6) return null;
    const ratePerH = Math.max(0, (end.used - first.used) / hours);
    const left = (reset - Date.now()) / 3600000;
    const projected = Math.min(200, target.used + ratePerH * Math.max(0, left));
    const etaAt = ratePerH > 0 ? Date.now() + (100 - target.used) / ratePerH * 3600000 : null;
    return { ratePerH, projected, etaAt: etaAt && etaAt < reset ? etaAt : null };
  }
  function forecastText(group, windowKind = 'five') {
    const target = windowKind === 'week' ? group?.week : group;
    if (!target) return '暂未获取到这一窗口的数据';
    if (ended(target)) return '已经重置，等待下一次查询';
    if (target.used >= 100) return '这一组已经用完，等待重置';
    const f = forecast(group, windowKind);
    if (!f) return '采样还不够，暂不估计';
    if (f.etaAt) return `按最近的速度，约 ${duration(f.etaAt - Date.now())}后用完`;
    if (f.ratePerH === 0) return '这个窗口里还没有新增用量';
    return `按最近的速度，重置时大约用到 ${percent(Math.min(100, f.projected))}`;
  }

  /* ---------------- 本机用量（扫描到的 Antigravity 对话） ---------------- */

  function localUsage() {
    const ins = insight()?.localUsage;
    if (ins && (ins.d30?.requests > 0 || ins.today?.requests > 0 || ins.models?.length > 0)) {
      return {
        today: ins.today,
        week: ins.d7,
        d30: ins.d30,
        hourly: ins.hourly || [],
        models: ins.models.slice(0, 8),
        any: true,
      };
    }
    if (typeof current === 'undefined' || !current?.usage) return null;
    const today = D.dayKey(current.now), week = D.shift(today, -6), d30Key = D.shift(today, -29);
    const rows = current.usage.filter(row => row.source === 'Antigravity');
    const sum = list => list.reduce((out, row) => ({ tokens: out.tokens + (row.tokens || 0), requests: out.requests + (row.requests || 0), costUsd: out.costUsd + (row.costUsd || 0) }), { tokens: 0, requests: 0, costUsd: 0 });
    const recent = rows.filter(row => row.day >= week);
    const byModel = new Map();
    for (const row of recent) {
      const item = byModel.get(row.model) || { model: row.model, tokens: 0, requests: 0, costUsd: 0 };
      item.tokens += row.tokens || 0; item.requests += row.requests || 0; item.costUsd += row.costUsd || 0;
      byModel.set(row.model, item);
    }
    return {
      today: sum(rows.filter(row => row.day === today)),
      week: sum(recent),
      d30: sum(rows.filter(row => row.day >= d30Key)),
      hourly: ins?.hourly || [],
      models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8),
      any: rows.length > 0,
    };
  }

  /** 给请求记录列表估算单次请求占所属分组 5 小时 / 周额度的比例。 */
  function quotaShare(row) {
    if (!row || row.source !== 'Antigravity' || !(row.tokens > 0)) return null;
    const gList = insight()?.groups || [];
    const model = String(row.model || row.requested || '').toLowerCase();
    const g = gList.find(item => item.items?.some(m => m.model === model) || ( /gemini/i.test(model) && item.models.some(m => /gemini/i.test(m)) ) || ( /claude|gpt/i.test(model) && item.models.some(m => /claude|gpt/i.test(m)) ));
    if (!g) return null;
    const fiveCap = g.five?.capacity?.fullTokens;
    const weekCap = g.week?.capacity?.fullTokens;
    const five = fiveCap > 0 ? { pct: row.tokens / fiveCap * 100, confidence: g.five.capacity.confidence === 'medium' ? 'medium' : 'low' } : null;
    const week = weekCap > 0 ? { pct: row.tokens / weekCap * 100, confidence: g.week.capacity.confidence === 'medium' ? 'medium' : 'low' } : null;
    return five || week ? { five, week } : null;
  }

  /* ---------------- 额度详情顶上的标签 ---------------- */

  function tabs() {
    if (!visible()) return [];
    return [{ key: KEY, kind: KEY, who: planText(), title: planText() || 'Google Antigravity' }];
  }
  function tabButton(tab) {
    return el('button', { type: 'button', 'data-account': KEY, 'data-kind': KEY, 'data-antigravity': '', title: tab.title }, [
      el('span', { class: 'brand-glyph' }, [brandSvg('antigravity')]), 'Antigravity',
      tab.who ? el('small', { class: 'tab-who', text: tab.who, translate: 'no' }) : null,
    ]);
  }
  const owns = key => key === KEY && visible();

  /* ---------------- 额度详情：各板块 ---------------- */

  function groupInsightOf(group) {
    return (insight()?.groups || []).find(item => item.key === group.key) || null;
  }

  function groupPanel(group, index) {
    const gInsight = groupInsightOf(group);
    const panel = el('article', { class: 'panel window-panel agy-group', 'data-group': group.key, style: `--agy-color: ${COLORS[index % COLORS.length]}` }, [
      el('div', { class: 'panel-heading' }, [
        el('h2', {}, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(group)]),
        el('span', { class: 'section-tag', text: '共用一份额度' }),
      ]),
    ]);
    const done = ended(group);
    panel.append(el('div', { class: 'window-number' }, [
      el('strong', { text: done ? '—' : percent(Math.max(0, 100 - group.used)) }),
      el('span', { text: stale() ? '上次查到的剩余' : '剩余额度' }),
      el('small', { class: 'agy-win-pill', text: '5 小时窗口' }),
    ]));
    const bar = done ? el('div', { class: 'track' }) : track(group.used, group.used >= 75);
    bar.classList.add('window-track');
    panel.append(bar);
    panel.append(el('div', { class: 'window-meta' }, [
      el('span', { text: done ? '等待查询确认' : `已用 ${percent(group.used)}` }),
      el('span', { text: resetText(group) }),
    ]));
    const f = forecast(group, 'five');
    const caution = Boolean(f?.etaAt) || stale() || (!done && group.used >= 75);
    panel.append(el('div', { class: 'prediction-line' + (caution ? ' caution' : '') }, [
      icon(caution ? 'alert' : 'trend'),
      stale() ? '数据不是最新的，打开 Antigravity 后再判断' : forecastText(group, 'five'),
    ]));

    // 周额度窗口（RetrieveUserQuotaSummary 返回的二级窗口）
    const week = group.week || gInsight?.week || null;
    if (week) {
      const weekDone = ended(week);
      const wf = forecast(group, 'week');
      const weekCaution = Boolean(wf?.etaAt) || (!weekDone && week.used >= 75);
      const weekBar = weekDone ? el('div', { class: 'track' }) : track(week.used, week.used >= 75, '周已用额度');
      weekBar.classList.add('window-track', 'agy-week-track');
      panel.append(el('div', { class: 'agy-week-box' }, [
        el('div', { class: 'agy-week-head' }, [
          el('div', { class: 'agy-week-title' }, [
            el('b', { text: '周额度窗口' }),
            el('span', { class: 'section-tag', text: '7 天周期' }),
          ]),
          el('div', { class: 'agy-week-remaining' }, [
            el('strong', { class: 'num', text: weekDone ? '—' : percent(Math.max(0, 100 - week.used)) }),
            el('span', { text: '周剩余额度' }),
          ]),
        ]),
        weekBar,
        el('div', { class: 'window-meta agy-week-meta' }, [
          el('span', { text: weekDone ? '等待查询确认' : `周已用 ${percent(week.used)}` }),
          el('span', { text: resetText(week) }),
        ]),
        el('div', { class: 'prediction-line agy-week-pred' + (weekCaution ? ' caution' : '') }, [
          icon(weekCaution ? 'alert' : 'trend'),
          stale() ? '数据不是最新的，打开 Antigravity 后再判断' : forecastText(group, 'week'),
        ]),
      ]));
    } else {
      panel.append(el('div', { class: 'agy-week-box is-empty' }, [
        el('div', { class: 'agy-week-head' }, [
          el('div', { class: 'agy-week-title' }, [
            el('b', { text: '周额度窗口' }),
            el('span', { class: 'section-tag', text: '7 天周期' }),
          ]),
          el('span', { class: 'muted', text: '打开 Antigravity 刷新后显示周额度' }),
        ]),
      ]));
    }

    // Token 与费用（当前 5h 窗口、当前周窗口、整窗容量折算）
    const fiveLocal = gInsight?.five?.local;
    const weekLocal = gInsight?.week?.local;
    const fiveCap = gInsight?.five?.capacity;
    const weekCap = gInsight?.week?.capacity;
    panel.append(metricGroup('Token 与费用', 'tokens', [
      metric('5 小时本机已用', fiveLocal ? amount(fiveLocal.tokens) : '0', {
        unit: 'Tokens',
        sub: `${money(fiveLocal?.costUsd || 0)} · ${number(fiveLocal?.requests || 0)} 次请求`,
      }),
      metric('周窗口本机已用', weekLocal ? amount(weekLocal.tokens) : '0', {
        unit: 'Tokens',
        sub: `${money(weekLocal?.costUsd || 0)} · ${number(weekLocal?.requests || 0)} 次请求`,
      }),
      metric('5 小时整窗折算', fiveCap?.fullTokens ? amount(fiveCap.fullTokens) : '—', {
        unit: fiveCap?.fullTokens ? 'Tokens' : '',
        sub: fiveCap?.fullCostUsd != null ? `${money(fiveCap.fullCostUsd)} · 约剩 ${tokens(fiveCap.remainingTokens || 0)}` : '需窗口内有扣额与本机用量',
        chip: fiveCap?.fullTokens ? { tone: fiveCap.confidence === 'medium' ? 'medium' : 'low', text: CONFIDENCE_TEXT[fiveCap.confidence] || '估算' } : null,
      }),
      metric('周额度整窗折算', weekCap?.fullTokens ? amount(weekCap.fullTokens) : '—', {
        unit: weekCap?.fullTokens ? 'Tokens' : '',
        sub: weekCap?.fullCostUsd != null ? `${money(weekCap.fullCostUsd)} · 约剩 ${tokens(weekCap.remainingTokens || 0)}` : '需窗口内有扣额与本机用量',
        chip: weekCap?.fullTokens ? { tone: weekCap.confidence === 'medium' ? 'medium' : 'low', text: CONFIDENCE_TEXT[weekCap.confidence] || '估算' } : null,
      }),
    ], 'two'));

    // 速度与时间
    panel.append(metricGroup('速度与时间', 'clock', [
      metric('最近速度', f && !stale() ? f.ratePerH.toFixed(2) : '—', { unit: f && !stale() ? '点 / 时' : '', sub: '这个窗口里的采样' }),
      metric('重置时预计使用', f && !stale() ? percent(Math.min(100, f.projected)) : '—', { sub: f ? '按最近的速度' : '采样还不够' }),
      metric('重置时间', group.resetAt ? date(Date.parse(group.resetAt)) : '未知', { sub: group.resetAt && !done ? `${duration(Date.parse(group.resetAt) - Date.now())}后` : '' }),
      metric(week?.resetAt ? '周额度重置时间' : '这一组的型号', week?.resetAt ? date(Date.parse(week.resetAt)) : String(group.models.length), {
        sub: week?.resetAt ? `${!ended(week) ? `${duration(Date.parse(week.resetAt) - Date.now())}后 · ` : ''}共 ${group.models.length} 个型号` : '用哪一个都扣这一份',
      }),
    ], 'two'));

    // 组内各模型档位明细
    const items = gInsight?.items || [];
    if (items.length) {
      panel.append(el('div', { class: 'agy-tier-list' }, [
        el('div', { class: 'agy-tier-head' }, [
          el('b', { text: '组内模型档位' }),
          el('small', { text: '最近 7 天本机使用' }),
        ]),
        ...items.map(item => el('div', { class: 'agy-tier-row' }, [
          el('div', { class: 'agy-tier-name' }, [
            el('span', { translate: 'no', text: item.family }),
            item.effort ? el('span', { class: 'ms-level' + (item.effort === 'medium' ? ' plain' : ''), text: EFFORT_LABEL[item.effort] || item.effort }) : null,
          ]),
          el('span', { class: 'num agy-tier-usage', text: item.d7?.requests > 0 ? `${tokens(item.d7.tokens)} Tokens · ${number(item.d7.requests)} 次` : '7 天未调用' }),
        ])),
      ]));
    }
    return panel;
  }

  /** 额度容量趋势：对比各组在 5 小时窗口 / 周额度窗口下折算出的整窗容量。 */
  function agyCapacityPanel() {
    const gList = insight()?.groups || [];
    const body = el('div', { class: 'agy-cap-body' });
    const note = el('p', { class: 'sample-caption' });
    const winSeg = el('div', { class: 'seg compact', 'aria-label': '额度窗口' }, [
      el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...[['five', '5 小时'], ['week', '周额度']].map(([id, label]) => el('button', { type: 'button', 'data-agy-cap-win': id, class: capWindow === id ? 'on' : null, text: label })),
    ]);
    const metricSeg = el('div', { class: 'seg compact', 'aria-label': '单位' }, [
      el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...[['tokens', 'Tokens'], ['costUsd', '费用']].map(([id, label]) => el('button', { type: 'button', 'data-agy-cap-metric': id, class: capMetric === id ? 'on' : null, text: label })),
    ]);

    const draw = () => {
      const pointsByGroup = gList.map((g, idx) => {
        const w = capWindow === 'week' ? g.week : g.five;
        const cap = w?.capacity;
        const hist = g.capacityHistory?.[capWindow] || [];
        return { g, idx, w, cap, hist };
      });
      const anyCap = pointsByGroup.some(item => (capMetric === 'costUsd' ? item.cap?.fullCostUsd : item.cap?.fullTokens) > 0 || item.hist.length > 0);
      if (!anyCap) {
        body.replaceChildren(empty('还没有足够折算整窗容量的样本：需要窗口内额度已用百分比上涨，并且同期本机有 Antigravity 对话记录。'));
        note.textContent = '整窗容量按「本机窗口内用量 ÷ 官方已用百分比变化」倒推，用来观察每组 100% 额度大约相当于多少 Tokens 或参考 API 费用。';
        return;
      }
      const fmt = capMetric === 'costUsd' ? money : tokens;
      const valOf = c => capMetric === 'costUsd' ? (c?.fullCostUsd || 0) : (c?.fullTokens || 0);
      const maxVal = Math.max(1, ...pointsByGroup.map(item => Math.max(valOf(item.cap), ...item.hist.map(p => capMetric === 'costUsd' ? p.fullCostUsd : p.fullTokens))));
      const cards = pointsByGroup.map(({ g, idx, w, cap, hist }) => {
        const fullVal = valOf(cap);
        const remVal = capMetric === 'costUsd' ? cap?.remainingCostUsd : cap?.remainingTokens;
        const pct = Math.min(100, Math.max(fullVal > 0 ? 4 : 0, (fullVal / maxVal) * 100));
        const fill = el('i', { class: 'agy-cap-fill', style: `width: ${pct.toFixed(1)}%; background: ${COLORS[idx % COLORS.length]}` });
        return el('div', { class: 'agy-cap-row', style: `--agy-color: ${COLORS[idx % COLORS.length]}` }, [
          el('div', { class: 'agy-cap-head' }, [
            el('span', { class: 'agy-cap-title' }, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(g)]),
            el('span', { class: 'num agy-cap-val' }, [
              el('strong', { text: fullVal > 0 ? fmt(fullVal) : '—' }),
              el('small', { text: fullVal > 0 ? (capWindow === 'week' ? ' / 整周' : ' / 5 小时') : '样本不足' }),
            ]),
          ]),
          el('div', { class: 'agy-cap-bar' }, [fill]),
          el('div', { class: 'agy-cap-sub' }, [
            el('span', { text: remVal != null && fullVal > 0 ? `当前窗口约剩 ${fmt(remVal)}` : '等待额度变化以校准容量' }),
            el('span', { text: hist.length ? `已累计 ${number(hist.length)} 个周期样本 · 观测 ${cap?.points || 0}% 额度变化` : w ? `当前已用 ${percent(w.used)}` : '' }),
          ]),
        ]);
      });
      body.replaceChildren(el('div', { class: 'agy-cap-list' }, cards));
      note.textContent = '整窗容量按「本机窗口内用量 ÷ 官方已用百分比变化」倒推，只统计这台电脑上的 Antigravity 对话。';
    };

    const panel = el('article', { class: 'panel capacity-panel agy-capacity' }, [
      el('div', { class: 'panel-heading' }, [
        el('div', {}, [
          el('h2', { text: '额度容量趋势' }),
          el('p', { text: '按本机用量与额度消耗比例折算每组 100% 额度大约能用多少 Tokens 与参考费用' }),
        ]),
        el('div', { class: 'capacity-controls' }, [winSeg, metricSeg]),
      ]),
      body,
      note,
    ]);
    panel.addEventListener('click', event => {
      const btn = event.target.closest('[data-agy-cap-win], [data-agy-cap-metric]');
      if (!btn) return;
      if (btn.dataset.agyCapWin) capWindow = btn.dataset.agyCapWin;
      else capMetric = btn.dataset.agyCapMetric;
      for (const item of panel.querySelectorAll('[data-agy-cap-win]')) item.classList.toggle('on', item.dataset.agyCapWin === capWindow);
      for (const item of panel.querySelectorAll('[data-agy-cap-metric]')) item.classList.toggle('on', item.dataset.agyCapMetric === capMetric);
      if (typeof syncSeg === 'function') { syncSeg(winSeg); syncSeg(metricSeg); }
      draw();
    });
    draw();
    return panel;
  }

  /** 最近 7 天每组的已用百分比（含 5 小时实线与周额度虚线）。 */
  function historyPanel() {
    const panel = el('article', { class: 'panel agy-history' }, [
      el('div', { class: 'panel-heading' }, [
        el('h2', { text: '最近 7 天的额度' }),
        el('span', { class: 'section-tag', text: '5 小时与周额度已用百分比' }),
      ]),
    ]);
    const list = groups();
    const samples = quota?.history || [];
    if (samples.length < 2) {
      panel.append(empty('采样还不够。Antigravity 开着的时候每次查询都会记一条，过一阵就能看到走势。'));
      return panel;
    }
    const now = Date.now(), from = now - 7 * 86400000;
    const W = 700, H = 180, pad = { l: 34, r: 8, t: 8, b: 22 };
    const x = at => pad.l + (at - from) / (now - from) * (W - pad.l - pad.r);
    const y = used => pad.t + (1 - Math.min(100, Math.max(0, used)) / 100) * (H - pad.t - pad.b);
    const chartSvg = svg('svg', { class: 'agy-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '最近 7 天各组额度的已用百分比' });
    for (const v of [0, 50, 100]) {
      chartSvg.append(svg('line', { class: 'agy-grid', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
      const label = svg('text', { class: 'agy-axis', x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = v + '%';
      chartSvg.append(label);
    }
    for (let d = 0; d <= 7; d += 1) {
      const at = from + d * 86400000;
      const label = svg('text', { class: 'agy-axis', x: x(at), y: H - 6, 'text-anchor': d === 0 ? 'start' : d === 7 ? 'end' : 'middle' });
      label.textContent = new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' });
      chartSvg.append(label);
    }
    let hasWeekLine = false;
    list.forEach((group, index) => {
      const color = COLORS[index % COLORS.length];
      const points = samples.flatMap(sample => sample.groups.filter(item => item.key === group.key).map(item => [x(sample.at), y(item.used)]));
      if (points.length) {
        chartSvg.append(svg('polyline', { class: 'agy-line', points: points.map(p => p.join(',')).join(' '), style: `stroke: ${color}` }));
      }
      const weekPoints = samples.flatMap(sample => sample.groups.filter(item => item.key === group.key && item.weekUsed != null).map(item => [x(sample.at), y(item.weekUsed)]));
      if (weekPoints.length >= 2) {
        hasWeekLine = true;
        chartSvg.append(svg('polyline', { class: 'agy-line-week', points: weekPoints.map(p => p.join(',')).join(' '), style: `stroke: ${color}` }));
      }
    });
    panel.append(chartSvg);
    panel.append(el('div', { class: 'agy-legend' }, [
      ...list.map((group, index) => el('span', { class: 'agy-legend-item', style: `--agy-color: ${COLORS[index % COLORS.length]}` }, [
        el('i', { class: 'agy-dot', 'aria-hidden': 'true' }),
        groupName(group),
      ])),
      hasWeekLine ? el('span', { class: 'agy-legend-note', text: '实线：5 小时已用 · 虚线：周额度已用' }) : null,
    ]));
    return panel;
  }

  function usagePanel() {
    const local = localUsage();
    const panel = el('article', { class: 'panel agy-local' }, [
      el('div', { class: 'panel-heading' }, [
        el('h2', { text: '最近 24 小时 · 本机用量' }),
        el('span', { class: 'section-tag', text: 'Antigravity 的对话记录' }),
      ]),
    ]);
    if (!local?.any) {
      panel.append(empty('还没有扫到 Antigravity 的对话。用 Antigravity 聊几句，下一次扫描之后这里就有数了。'));
      return panel;
    }
    panel.append(el('div', { class: 'agy-local-figures' }, [
      metric('今天', tokens(local.today.tokens), { unit: 'Tokens', sub: `${number(local.today.requests)} 次请求 · ${money(local.today.costUsd || 0)}` }),
      metric('最近 7 天', tokens(local.week.tokens), { unit: 'Tokens', sub: `${number(local.week.requests)} 次请求 · ${money(local.week.costUsd || 0)}` }),
      metric('最近 30 天', tokens((local.d30 || local.week).tokens), { unit: 'Tokens', sub: `${number((local.d30 || local.week).requests)} 次请求 · ${money((local.d30 || local.week).costUsd || 0)}` }),
    ]));
    if (local.hourly?.length && typeof chart === 'function') {
      const hourlyHost = el('div', { class: 'chart agy-hourly-chart' });
      panel.append(hourlyHost);
      chart(hourlyHost, local.hourly, 'tokens', true, typeof entering === 'function' ? entering() : false);
    }
    if (local.models.length) {
      panel.append(el('div', { class: 'agy-models' }, local.models.map(row => el('div', { class: 'agy-model-row' }, [
        el('div', { class: 'agy-model-main' }, [
          el('span', { class: 'agy-model', translate: 'no', text: row.model }),
          row.effort ? el('span', { class: 'ms-level' + (row.effort === 'medium' ? ' plain' : ''), text: EFFORT_LABEL[row.effort] || row.effort }) : null,
        ]),
        el('span', { class: 'num', text: `${tokens(row.tokens)} Tokens · ${number(row.requests)} 次${row.avgSpeed ? ` · ${row.avgSpeed} Token/秒` : ''}` }),
      ]))));
    }
    const go = el('button', { type: 'button', class: 'text-btn', 'data-action': 'agy-usage' }, [
      el('span', { text: '在用量明细里看每一次请求' }),
      icon('arrow'),
    ]);
    go.addEventListener('click', () => {
      const select = document.getElementById('source-filter');
      if (select && [...select.options].some(option => option.value === 'Antigravity')) select.value = 'Antigravity';
      state.source = 'Antigravity'; state.tablePage = 0; state.reqPage = 0;
      navigate('usage');
    });
    panel.append(el('div', { class: 'agy-local-foot' }, [go]));
    return panel;
  }

  /** 换一种模型，整窗能用多少（支持 5 小时窗口与周额度窗口切换）。 */
  function modelsPanel() {
    const ins = insight();
    const rows = ins?.modelCapacities || [];
    const gList = ins?.groups || [];
    if (!rows.length && !gList.length) return null;

    const panel = el('article', { class: 'panel model-study agy-model-study' });
    const winSeg = el('div', { class: 'seg compact', 'aria-label': '换算窗口' }, [
      el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...[['five', '5 小时窗口'], ['week', '周额度窗口']].map(([id, label]) => el('button', { type: 'button', 'data-agy-study-win': id, class: studyWindow === id ? 'on' : null, text: label })),
    ]);
    const heading = el('div', { class: 'panel-heading ms-head' }, [
      el('div', { class: 'ms-title' }, [
        avatar('antigravity', 'ms-brand'),
        el('div', {}, [
          el('h2', {}, [
            '换一种模型，整窗能用多少',
            el('span', { class: 'section-tag', text: '按分组额度与 Token 结构推算' }),
          ]),
          el('p', { text: '如果把某一组的整窗 100% 额度全部用来跑同一种模型与思考等级，大约能用多少 Tokens、调用多少次。' }),
        ]),
      ]),
      winSeg,
    ]);
    const body = el('div', { class: 'agy-study-body' });
    panel.append(heading, body);

    const draw = () => {
      const isWeek = studyWindow === 'week';
      const budgets = el('div', { class: 'ms-budgets' }, gList.map((g, idx) => {
        const w = isWeek ? g.week : g.five;
        const cap = w?.capacity;
        const badgeTone = cap?.confidence === 'medium' ? 'good' : cap?.fullTokens ? 'warn' : 'warn';
        const badgeText = CONFIDENCE_TEXT[cap?.confidence || 'insufficient'] || '样本不足';
        return el('div', { class: 'ms-budget', style: `--agy-color: ${COLORS[idx % COLORS.length]}` }, [
          el('div', { class: 'ms-budget-top' }, [
            el('i', { class: 'agy-dot', 'aria-hidden': 'true' }),
            groupName(g),
            el('span', { class: `ms-badge ${badgeTone}`, text: badgeText }),
          ]),
          el('strong', { class: 'ms-budget-value' }, [
            el('span', { class: 'num', text: cap?.fullTokens ? `${tokens(cap.fullTokens)} Tokens` : '等待额度变化' }),
            el('small', { text: isWeek ? '周额度整窗容量' : '5 小时整窗容量' }),
          ]),
          el('p', {}, cap?.fullCostUsd != null
            ? [
                el('span', { text: '按 API 公开标价折合参考预算约' }),
                el('span', { class: 'num', text: ` ${money(cap.fullCostUsd)}` }),
                cap.remainingTokens != null ? el('span', { text: ' · 当前窗口约剩' }) : null,
                cap.remainingTokens != null ? el('span', { class: 'num', text: ` ${tokens(cap.remainingTokens)} Tokens` }) : null,
              ]
            : [el('span', { text: '当前还没有足够的额度变化与本机请求对照，先显示各模型按标价的相对比例。' })]),
        ]);
      }));

      const tokenField = isWeek ? 'weekTokens' : 'fiveTokens';
      const callField = isWeek ? 'weekCalls' : 'fiveCalls';
      const remField = isWeek ? 'weekRemainingTokens' : 'fiveRemainingTokens';
      const sorted = [...rows].sort((a, b) => (b[tokenField] ?? -1) - (a[tokenField] ?? -1) || (b.relative ?? -1) - (a.relative ?? -1) || a.family.localeCompare(b.family));
      const maxTokens = Math.max(1, ...sorted.map(r => r[tokenField] || 0));
      const maxRel = Math.max(1, ...sorted.map(r => r.relative || 0));
      const price = value => '$' + (value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3).replace(/0$/, ''));

      const rankList = el('div', { class: 'ms-rank', role: 'list' }, sorted.map((row, i) => {
        const capTokens = row[tokenField];
        const capCalls = row[callField];
        const remTokens = row[remField];
        const cell = el('div', { class: 'ms-cap' });
        const fill = el('i', { class: 'full' + (capTokens == null ? ' relative' : '') });
        if (capTokens != null) {
          cell.append(el('div', { class: 'ms-cap-num' }, [
            el('b', { text: tokens(capTokens) }),
            el('small', { text: 'Tokens' }),
          ]));
          fill.style.width = Math.max(2, capTokens / maxTokens * 100).toFixed(1) + '%';
          cell.append(el('div', { class: 'ms-meter' }, [fill]));
          const subs = [];
          if (capCalls) subs.push(`≈ ${number(capCalls)} 次调用`);
          if (remTokens != null) subs.push(`当前剩 ${tokens(remTokens)}`);
          if (subs.length) cell.append(el('small', { class: 'ms-cap-sub', text: subs.join(' · ') }));
        } else if (row.relative != null) {
          cell.append(el('div', { class: 'ms-cap-num' }, [
            el('b', { text: `×${row.relative.toFixed(2)}` }),
            el('small', { text: 'API 价格参考比' }),
          ]));
          fill.style.width = Math.max(2, row.relative / maxRel * 100).toFixed(1) + '%';
          cell.append(el('div', { class: 'ms-meter' }, [fill]));
        } else {
          cell.append(el('div', { class: 'ms-cap-num' }, [el('b', { class: 'muted', text: '—' }), el('small', { text: '暂无标价' })]));
        }

        const lp = row.listPrice;
        return stagger(el('div', { class: 'ms-row ds-row' + (i < 3 ? ' top' : ''), role: 'listitem', 'data-model': row.model, 'data-effort': row.effort }, [
          el('span', { class: 'ms-no', text: String(i + 1).padStart(2, '0') }),
          el('div', { class: 'ms-name' }, [
            avatar('antigravity', 'ms-row-logo'),
            el('div', { class: 'ms-name-text' }, [
              el('div', { class: 'ms-name-top' }, [
                el('b', { text: row.family, title: row.model, translate: 'no' }),
                el('span', { class: 'ms-level' + (row.effort === 'medium' ? ' plain' : ''), text: EFFORT_LABEL[row.effort] || row.effort }),
                row.mixBasis === 'model' ? el('span', { class: 'ms-basis measured', text: '按你用它的结构' }) : null,
              ]),
              el('small', {}, [
                lp ? el('span', { class: 'num', text: `输入 ${price(lp.input)} · 输出 ${price(lp.output)} · 缓存读 ${price(lp.cacheRead)} / 百万` }) : el('span', { text: '没有标价' }),
                row.recentTokens > 0 ? el('span', { class: 'num', text: ` · 30 天用了 ${tokens(row.recentTokens)}（${number(row.recentCalls)} 次）` }) : null,
              ]),
            ]),
          ]),
          cell,
          el('div', { class: 'ms-cap ds-unit' }, row.usdPerMTokens == null ? [el('div', { class: 'ms-cap-num' }, [el('b', { class: 'muted', text: '—' })])] : [
            el('div', { class: 'ms-cap-num' }, [el('b', { text: price(row.usdPerMTokens) }), el('small', { text: '/ 百万 Tokens' })]),
            row.tokensPerCall ? el('small', { class: 'ms-cap-sub', text: `平均每次 ${tokens(row.tokensPerCall)} Tokens` }) : null,
          ]),
        ]), i);
      }));

      body.replaceChildren(
        budgets,
        el('div', { class: 'ms-rank-head ds-rank-head', 'aria-hidden': 'true' }, [
          el('span'),
          el('span', { text: '模型 · 思考等级' }),
          el('span', { text: isWeek ? '整周 100% 额度能用' : '5 小时 100% 额度能用' }),
          el('span', { text: '综合单价' }),
        ]),
        rankList,
        el('p', { class: 'ms-note', text: '综合单价 = 按模型公开标价和你的 Token 结构（新输入、缓存读取、输出各占多少）算出来的每百万 Tokens 参考费用。同一组内的模型共用同一份额度池。' }),
      );
    };

    panel.addEventListener('click', event => {
      const btn = event.target.closest('[data-agy-study-win]');
      if (!btn) return;
      studyWindow = btn.dataset.agyStudyWin;
      for (const item of winSeg.querySelectorAll('button')) item.classList.toggle('on', item.dataset.agyStudyWin === studyWindow);
      if (typeof syncSeg === 'function') syncSeg(winSeg);
      draw();
    });
    draw();
    return panel;
  }

  /** 这个账号的请求：显示本机 Antigravity 的核验汇总与最近请求列表（含首字延迟与流式速度）。 */
  function requestsPanel() {
    const ins = insight()?.localUsage;
    if (!ins) return null;
    const panel = el('article', { class: 'panel account-requests agy-requests' });
    const openAll = el('button', { type: 'button', class: 'text-btn', 'data-action': 'agy-requests-all' }, [
      el('span', { text: '在请求记录里查看全部' }),
      icon('arrow'),
    ]);
    openAll.addEventListener('click', () => {
      const select = document.getElementById('source-filter');
      if (select && [...select.options].some(option => option.value === 'Antigravity')) select.value = 'Antigravity';
      state.source = 'Antigravity'; state.reqStatus = 'all'; state.reqPage = 0;
      const statusSel = document.getElementById('request-status');
      if (statusSel) statusSel.value = 'all';
      if (typeof showUsageView === 'function') showUsageView('requests');
      navigate('usage');
    });

    const heading = el('div', { class: 'panel-heading' }, [
      el('div', {}, [
        el('h2', {}, ['这个账号的请求 ', el('span', { class: 'section-tag', text: 'Google Antigravity' })]),
        el('p', { text: '从本机 Antigravity 对话数据库读取的每次模型调用，包含内部返回型号、首字延迟和流式速度。' }),
      ]),
      openAll,
    ]);
    const body = el('div', { class: 'account-requests-body' });
    const v = ins.verifySummary || { match: 0, mismatch: 0, suspect: 0, unverified: 0, total: 0 };
    body.append(metricGroup('请求与核验汇总', 'requests', [
      metric('今天请求', amount(ins.today.tokens), { unit: 'Tokens', sub: `${number(ins.today.requests)} 次请求 · ${money(ins.today.costUsd)}` }),
      metric('最近 7 天请求', amount(ins.d7.tokens), { unit: 'Tokens', sub: `${number(ins.d7.requests)} 次请求 · ${money(ins.d7.costUsd)}` }),
      metric('型号核验', number(v.mismatch + v.suspect), {
        unit: '次异常',
        tone: v.mismatch + v.suspect ? 'warn' : '',
        sub: `${number(v.match)} 次一致 · ${number(v.unverified)} 次无法核验`,
      }),
    ]));

    const rows = ins.recentRequests || [];
    if (rows.length) {
      const toneMap = { match: 'good', mismatch: 'critical', suspect: 'warning', unverified: 'neutral' };
      const fmtSec = ms => ms >= 59500 ? `${Math.floor(Math.round(ms / 1000) / 60)}m ${Math.round(ms / 1000) % 60}s` : `${(ms / 1000).toFixed(2)}s`;
      body.append(el('div', { class: 'table-scroll compact-table', tabindex: '0', role: 'region', 'aria-label': 'Antigravity 最近请求记录' }, [
        el('table', {}, [
          el('thead', {}, [
            el('tr', {}, ['时间', '项目', '型号', '首字 / 速度', 'Tokens', '参考费用', '核验'].map((text, i) => el('th', { class: i === 4 || i === 5 ? 'n' : '', text }))),
          ]),
          el('tbody', {}, rows.map(row => {
            const d = new Date(row.at), pad = n => String(n).padStart(2, '0');
            const dayStr = `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            const proj = row.cwd ? row.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || row.cwd : '—';
            const speedText = row.timing?.tokensPerSec != null
              ? `${row.timing.firstTokenMs != null ? `首字 ${fmtSec(row.timing.firstTokenMs)} · ` : ''}${row.timing.tokensPerSec} Token/秒`
              : row.estimate?.tokensPerSec != null
                ? `≈ ${row.estimate.tokensPerSec} Token/秒`
                : '—';
            const mainModel = row.returned || row.requested || row.model;
            const diffSub = row.requested && row.returned && row.requested !== row.returned ? `请求 ${row.requested}` : null;
            return el('tr', { class: `request-row ${row.verify.status}` }, [
              el('td', { class: 'request-time' }, [el('b', { translate: 'no', text: dayStr })]),
              el('td', { class: 'project-cell', translate: 'no', text: proj, title: row.cwd || '' }),
              el('td', { class: 'request-model' }, [
                el('b', { translate: 'no', text: mainModel, title: mainModel }),
                diffSub ? el('small', { text: diffSub }) : null,
                row.effort ? el('div', { class: 'request-tags' }, [el('span', { class: 'request-tag', translate: 'no', text: row.effort })]) : null,
              ]),
              el('td', { class: 'agy-req-speed', text: speedText }),
              el('td', { class: 'n token-strong', title: number(row.tokens), text: tokens(row.tokens) }),
              el('td', { class: 'n', text: row.priced ? money(row.costUsd) : '未定价' }),
              el('td', {}, [el('span', { class: 'badge ' + (toneMap[row.verify.status] || 'neutral'), text: row.verify.label, title: row.verify.reasons?.[0] || '' })]),
            ]);
          })),
        ]),
      ]));
    } else {
      body.append(el('p', { class: 'muted account-empty', text: '还没有扫到本机 Antigravity 的请求记录。' }));
    }
    panel.append(heading, body);
    return panel;
  }

  function renderQuota(host, timelineNode) {
    const ins = insight();
    const credits = last()?.credits;
    const creditParts = [];
    if (credits?.availablePromptCredits != null && credits?.monthlyPromptCredits != null) {
      creditParts.push(`Prompt 积分 ${number(credits.availablePromptCredits)} / ${number(credits.monthlyPromptCredits)}`);
    }
    if (credits?.availableFlowCredits != null && credits?.monthlyFlowCredits != null) {
      creditParts.push(`Flow 积分 ${number(credits.availableFlowCredits)} / ${number(credits.monthlyFlowCredits)}`);
    }
    const convCount = ins?.conversations ?? quota?.conversations ?? 0;
    const sampleCount = ins?.sampleCount ?? (quota?.history || []).length;

    host.append(el('div', { class: 'quota-context agy-context' }, [
      avatar('antigravity'),
      el('div', {}, [
        el('h2', {}, ['Google Antigravity', planText() ? el('span', { class: 'context-who', text: planText(), translate: 'no' }) : null]),
        el('p', { class: 'muted', text: '额度按型号分组：一组里的型号共用一份，包含 5 小时窗口与周额度窗口。只能问本机开着的 Antigravity。' }),
        el('p', { class: 'muted agy-context-sub', text: [`${number(convCount)} 个本机对话`, `${number(sampleCount)} 个额度采样`, ...creditParts].join(' · ') }),
      ]),
      el('div', { class: 'context-meta agy-context-meta' }, [el('span', { text: updatedText() }), refreshButton()]),
    ]));
    // 一条说明可以是几句：分开放，翻译按句对得上
    for (const note of notes()) host.append(el('p', { class: 'stale-note agy-note' }, [icon('alert'), ...[].concat(note).map(text => el('span', { text: text + ' ' }))]));
    const list = groups();
    if (!list.length) {
      host.append(el('article', { class: 'panel empty large' }, [
        el('h3', { text: quota?.loading ? '正在查询额度…' : '还没有查到额度' }),
        el('p', { text: '打开 Antigravity，等它登录好之后点「刷新」。' }),
      ]));
    } else {
      host.append(markLayout(el('div', { class: 'quota-window-grid agy-groups' }, list.map((group, index) => groupPanel(group, index))), 'quota:agy-groups'));
      host.append(markLayout(agyCapacityPanel(), 'quota:agy-capacity'));
    }
    host.append(el('div', { class: 'quota-history-grid agy-history-grid' }, [
      markLayout(usagePanel(), 'quota:agy-local'),
      ...(list.length ? [markLayout(historyPanel(), 'quota:agy-history')] : []),
    ]));
    if (timelineNode) {
      host.append(timelineNode);
      if (typeof current !== 'undefined' && current) {
        window.PulseModelStudy?.timeline(current, KEY, { kind: KEY, accountId: KEY, lastCheckedAt: last()?.at || 0 });
      }
    }
    if (typeof speedPanel === 'function') {
      const speed = speedPanel({ accountId: KEY, accountLabel: 'Antigravity' }, KEY, {
        tag: 'Antigravity 本地记录',
        hint: '每个模型每秒输出多少 Token、首字延迟多少秒，直接从本机 Antigravity 对话数据库（gen_metadata）读取。',
        load: days => api.speed(days),
        empty: () => el('div', { class: 'empty speed-empty' }, [
          el('p', { text: '这段时间还没有带流式耗时的 Antigravity 回复记录。用 Antigravity 生成几条回复后，这里就会显示各模型的出字速度和首字延迟。' }),
        ]),
      });
      if (speed) host.append(markLayout(speed, 'quota:speed'));
    }
    const study = modelsPanel();
    if (study) host.append(markLayout(study, 'quota:agy-models'));
    const reqs = requestsPanel();
    if (reqs) host.append(markLayout(reqs, 'quota:agy-requests'));
    return KEY;
  }

  /* ---------------- 总览里的卡片 ---------------- */

  function card() {
    const list = groups();
    const live = list.filter(group => !ended(group) || (group.week && !ended(group.week)));
    const worst = live.slice().sort((a, b) => effectiveUsed(b) - effectiveUsed(a))[0];
    const worstUsed = worst ? effectiveUsed(worst) : 0;
    const level = !last() ? '' : stale() ? '' : worst ? levelOf(worst) : '';
    const badge = !last()?.at ? [quota?.loading ? '正在查询…' : quota?.running ? '还没查询过' : '没有开着', '']
      : !quota?.running ? ['没有开着', ''] : !last().ok ? ['查询失败', 'critical'] : stale() ? ['采样已过期', '']
      : worstUsed >= 100 ? ['有一组用完了', 'critical'] : worstUsed >= 90 ? ['快用完了', 'critical'] : worstUsed >= 75 ? ['用量偏高', 'warning'] : ['节奏正常', 'good'];
    const body = [el('div', { class: 'account-head' }, [
      avatar('antigravity'),
      el('div', { class: 'account-title' }, [el('span', { class: 'account-name', text: 'Antigravity' }), el('span', { class: 'plan who', translate: 'no', text: planText() || 'Google' })]),
      el('span', { class: 'badge ' + badge[1], text: badge[0] }),
    ])];
    const ringNode = ring({ five: live[0] ? { used: effectiveUsed(live[0]) } : null, week: live[1] ? { used: effectiveUsed(live[1]) } : null });
    ringNode.title = live.length > 1 ? `外环：${live[0].models.join(' · ')}　内环：${live[1].models.join(' · ')}` : '';
    const left = live.length ? Math.min(...live.map(group => Math.max(0, 100 - effectiveUsed(group)))) : null;
    ringNode.append(el('div', { class: 'ring-center' }, [el('div', { class: 'quota-remaining' + (left == null ? ' empty-number' : ''), text: left == null ? '—' : left.toFixed(1) }, left == null ? [] : [el('small', { text: '%' })])]));
    const worstReset = worst?.resetAt || worst?.week?.resetAt;
    body.push(el('div', { class: 'quota-hero' }, [ringNode, el('div', { class: 'quota-hero-text' }, [
      el('span', { class: 'quota-hero-label', text: `${stale() ? '上次' : ''}${live.length > 1 ? '较低一组' : '额度'}剩余` }),
      el('span', { class: 'quota-hero-value', text: worstReset ? `${duration(Date.parse(worstReset) - Date.now())}后重置` : list.length ? '重置时间未知' : '尚未取得额度' }),
      el('span', { class: 'quota-hero-sub', text: worstReset ? `${date(Date.parse(worstReset))} · 本地时间` : '额度只能问本机开着的 Antigravity' }),
    ])]));
    list.forEach((group, index) => {
      const done = ended(group);
      const rows = [
        el('div', { class: 'quota-mini-head' }, [
          el('span', { class: 'mini-label' }, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(group)]),
          el('span', { class: 'mini-used' }, [el('span', { class: 'num', text: done ? '等待确认' : `已用 ${percent(group.used)}` })]),
        ]),
        done ? el('div', { class: 'track' }) : track(group.used, group.used >= 75),
        el('div', { class: 'mini-reset' }, [icon('clock'), el('span', { text: resetText(group) })]),
      ];
      if (group.week) {
        const weekDone = ended(group.week);
        const weekTrack = weekDone ? el('div', { class: 'track agy-week-track' }) : track(group.week.used, group.week.used >= 75, '周已用额度');
        weekTrack.classList.add('agy-week-track');
        rows.push(el('div', { class: 'agy-mini-week' }, [
          el('div', { class: 'agy-mini-week-head' }, [
            el('span', { class: 'agy-mini-week-label', text: '周额度' }),
            el('span', { class: 'num', text: weekDone ? '等待确认' : `周已用 ${percent(group.week.used)} · 剩 ${percent(Math.max(0, 100 - group.week.used))}` }),
          ]),
          weekTrack,
          el('div', { class: 'mini-reset agy-mini-week-reset' }, [icon('clock'), el('span', { text: resetText(group.week) })]),
        ]));
      }
      body.push(el('div', { class: 'quota-mini agy-mini', 'data-group': group.key, style: `--agy-color: ${COLORS[index % COLORS.length]}` }, rows));
    });
    if (!list.length) body.push(el('div', { class: 'quota-missing' }, [el('p', { text: [].concat(notes()[0] || '打开 Antigravity 后会自动查询。')[0] })]));
    const link = el('button', { type: 'button', class: 'text-btn', 'data-go': 'quota', 'aria-label': 'Antigravity 额度详情' }, ['详情', icon('arrow')]);
    link.hidden = typeof navHidden === 'function' && navHidden('quota');
    link.addEventListener('click', () => { state.account = KEY; navigate('quota'); });
    body.push(el('div', { class: 'quota-card-foot' }, [el('span', { text: updatedText() }), el('span', { class: 'agy-card-actions' }, [refreshButton('text-btn'), link])]));
    return el('article', { class: 'quota-card antigravity ' + level, 'data-antigravity': '' }, body);
  }
  const marked = () => { const node = card(); return window.markLayout ? window.markLayout(node, 'overview:quota:antigravity') : node; };
  function cards() { return visible() ? [marked()] : []; }
  /** 刚查到：只换总览里这一张卡片。 */
  function renderCard() {
    const host = document.getElementById('quota-cards');
    if (!host || !quota) return;
    const old = host.querySelector('[data-layout="overview:quota:antigravity"]') || host.querySelector('[data-antigravity]');
    if (!visible()) { old?.remove(); return; }
    const next = marked();
    next.style.setProperty('--i', String(old ? [...host.children].indexOf(old) : host.children.length));
    if (old) old.replaceWith(next); else if (host.children.length) host.append(next);
  }
  function render() {
    renderCard();
    if (typeof current !== 'undefined' && current && !document.getElementById('page-quota').hidden) keepScroll(() => window.renderQuota());
  }
  function apply(next) { if (!next || typeof next !== 'object') return; quota = next; render(); }

  window.AntigravityQuota = { render, cards, tabs, tabButton, owns, renderQuota, quotaShare, state: () => quota };
  api.onState(apply);
  api.state().then(apply).catch(() => {});
})();
