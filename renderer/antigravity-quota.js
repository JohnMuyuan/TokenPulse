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
  const SHARE_MODES = [
    ['auto', '自动防偏移', '自动剥离本机空闲时段与同期多人共用的外部涨幅，防止家庭组共享把整窗容量算小'],
    ['family', '家庭组共享', '明确标记为 Google One 家庭组共享额度池，始终启用家庭组并发防偏移校准'],
    ['solo', '仅本机独享', '这个账号的额度变化全部按这台电脑的使用直接折算整窗容量，不做外部扣除'],
  ];
  const RESET_NOTE = {
    moved: '窗口已提前重置，重置日期已顺延',
    kept: '窗口已提前重置，重置日期不变',
  };
  let quota = null;
  let activeId = KEY;
  let studyWindow = 'five';
  let capWindow = 'five';
  let capMetric = 'tokens';
  let detailResizeObs = null;

  const demo = () => Boolean(window.tokenpulse?.isDemo?.());
  const visible = () => Boolean(quota?.installed) && !demo();
  const accountsList = () => Array.isArray(quota?.accounts) ? quota.accounts : [];
  const resolveAccount = preferred => {
    const list = accountsList();
    if (!list.length) return null;
    if (preferred && preferred !== KEY) {
      const hit = list.find(item => item.id === preferred);
      if (hit) return hit;
    }
    return list.find(item => item.id === activeId) || list[0];
  };
  const curAcc = () => resolveAccount(activeId);
  const last = (acc = curAcc()) => acc ? acc.last : quota?.last;
  const insight = (acc = curAcc()) => acc ? (acc.insight || null) : (quota?.insight || null);
  const historyOf = (acc = curAcc()) => acc ? (acc.history || []) : (quota?.history || []);
  const groups = (acc = curAcc()) => last(acc)?.groups || [];
  const isBusy = (acc = curAcc()) => Boolean(acc ? acc.loading : quota?.loading);
  const stale = (acc = curAcc()) => !last(acc)?.ok || Date.now() - (last(acc)?.at || 0) > STALE_MS;
  /** 页面启用了 CSP style-src 'self'，行内颜色与尺寸统一经 CSSOM 设置，不走 setAttribute('style')。 */
  const paint = (node, props) => {
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === '') continue;
      if (k.startsWith('--') || k.includes('-')) node.style.setProperty(k, String(v));
      else node.style[k] = String(v);
    }
    return node;
  };
  /** 识别同一官方额度池：组内模型上下线（如新增 Carbon/Hydrogen/Orchestrator 或移除 GPT-OSS）时保持 7 天走势与预测连续。 */
  function poolIdOf(modelsOrKey, title) {
    const text = Array.isArray(modelsOrKey) ? modelsOrKey.join('|') : String(modelsOrKey || '');
    const hasGemini = /gemini|orchestrator/i.test(text) || /gemini/i.test(title || '');
    const has3p = /claude|gpt|openai|anthropic/i.test(text) || /claude|gpt|3p/i.test(title || '');
    if (hasGemini && !has3p) return 'pool:gemini';
    if (has3p && !hasGemini) return 'pool:3p';
    return Array.isArray(modelsOrKey) ? [...modelsOrKey].sort().join('|') : text;
  }
  function pickPoolItem(sampleGroups, group) {
    if (!Array.isArray(sampleGroups) || !sampleGroups.length || !group) return null;
    const exact = sampleGroups.find(item => item.key === group.key);
    if (exact) return exact;
    const pool = poolIdOf(group.models || group.key, group.title);
    const matches = sampleGroups.filter(item => poolIdOf(item.key) === pool);
    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    return [...matches].sort((a, b) => Number(b.weekUsed != null) - Number(a.weekUsed != null) || b.key.length - a.key.length)[0];
  }
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
  const planText = (acc = curAcc()) => [last(acc)?.tier, last(acc)?.plan && last(acc)?.plan !== last(acc)?.tier ? last(acc)?.plan : ''].filter(Boolean).join(' · ');
  const displayNameOf = acc => {
    const raw = acc?.displayName || '';
    return raw === '未命名账号' && window.PulseI18n?.lang() === 'en' ? window.PulseI18n.t(raw) : raw;
  };
  const updatedText = (acc = curAcc()) => {
    const at = last(acc)?.at;
    if (isBusy(acc)) return '正在查询…';
    if (!at) return '还没查询过';
    return `${date(at)} ${last(acc)?.ok ? '更新' : '查询失败'}`;
  };
  /** 关着、查询失败、过期、待重新授权：说清楚现在看到的是什么。 */
  function notes(acc = curAcc()) {
    const out = [];
    if (acc) {
      if (acc.needsLogin) out.push('这个账号的授权已经失效，请在「设置 → 官方账号」里点「重新授权」。');
      else if (acc.waitLocal && !acc.inLocal) out.push(last(acc)?.at ? '这个账号只登记了本机登录，现在 Antigravity 登录的不是它（或没有打开），下面是上次查到的额度。在「设置 → 官方账号」里重新授权后，关着 Antigravity 也能自动查。' : '这个账号只登记了本机登录，请打开 Antigravity 切到它，或在「设置 → 官方账号」里点「重新授权」保存独立凭据。');
      else if (!acc.cloudAuth && !quota?.running) out.push(last(acc)?.at ? 'Antigravity 现在没有开着，下面是最后一次查到的额度。打开 Antigravity 后会自动更新。' : '打开 Antigravity 后才能查到额度：额度只能问本机开着的 Antigravity。');
      else if (last(acc) && !last(acc).ok) out.push([last(acc).error || '查询失败', '下面是之前查到的额度。']);
      else if (last(acc)?.ok && stale(acc)) out.push('超过 15 分钟没有查到新的额度，数字可能已经变了。');
      return out;
    }
    if (!quota?.running) out.push(last()?.at ? 'Antigravity 现在没有开着，下面是最后一次查到的额度。打开 Antigravity 后会自动更新。' : '打开 Antigravity 后才能查到额度：额度只能问本机开着的 Antigravity。');
    else if (last() && !last().ok) out.push([last().error || '查询失败', '下面是之前查到的额度。']);
    else if (last()?.ok && stale()) out.push('超过 15 分钟没有查到新的额度，数字可能已经变了。');
    return out;
  }
  const refresh = async targetId => {
    const id = typeof targetId === 'string' && targetId.startsWith('antigravity:') ? targetId : undefined;
    try { apply(await api.refresh(id)); } catch (error) { toast(error?.message || '查询失败', { kind: 'error' }); }
  };
  const refreshButton = (cls = 'btn', targetId = undefined) => {
    const busy = Boolean(quota?.loading);
    const b = el('button', { type: 'button', class: cls + (busy ? ' is-busy' : ''), 'data-action': 'agy-refresh', disabled: busy ? '' : null }, [icon('refresh'), el('span', { text: '刷新' })]);
    b.addEventListener('click', () => refresh(targetId));
    return b;
  };

  /* ---------------- 按窗口采样估速度 ---------------- */

  /** 这一组在当前窗口（同一个重置时间）里的采样：算每小时用掉几个百分点，预测重置时用到多少。 */
  function forecast(group, windowKind = 'five') {
    const target = windowKind === 'week' ? group?.week : group;
    if (!target?.resetAt || ended(target)) return null;
    const wIns = groupInsightOf(group)?.[windowKind];
    if (wIns && wIns.ratePerHour != null) {
      return {
        ratePerH: wIns.ratePerHour,
        projected: wIns.projected != null ? wIns.projected : target.used,
        etaAt: wIns.etaAt || null,
      };
    }
    const reset = Date.parse(target.resetAt);
    const points = historyOf().flatMap(sample => {
      const item = pickPoolItem(sample.groups, group);
      if (!item) return [];
      const r = windowKind === 'week' ? item.weekResetAt : item.resetAt;
      const u = windowKind === 'week' ? item.weekUsed : item.used;
      return u != null && r && Math.abs(Date.parse(r) - reset) < 15 * 60000 ? [{ at: sample.at, used: u }] : [];
    });
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
    const matchedAcc = row.accountId ? accountsList().find(a => a.id === row.accountId) : null;
    const gList = (matchedAcc?.insight || insight())?.groups || [];
    const model = String(row.model || row.requested || '').toLowerCase();
    const g = gList.find(item => item.items?.some(m => m.model === model || model.startsWith(m.model + '-')) || (/gemini|orchestrator/i.test(model) && item.models.some(m => /gemini|orchestrator/i.test(m))) || (/claude|gpt/i.test(model) && item.models.some(m => /claude|gpt/i.test(m))));
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
    const list = accountsList();
    if (!list.length) {
      return [{ key: KEY, kind: KEY, who: planText(null), title: planText(null) || 'Google Antigravity' }];
    }
    return list.map(acc => {
      const dn = displayNameOf(acc);
      const plan = planText(acc);
      const who = [dn, list.length === 1 ? plan : ''].filter(Boolean).join(' · ') || plan;
      return {
        key: acc.id,
        kind: KEY,
        who,
        familyShared: Boolean(acc.familyShared),
        title: [acc.accountHint || dn, plan, acc.familyShared ? '家庭组共享额度' : ''].filter(Boolean).join(' · ') || 'Google Antigravity',
      };
    });
  }
  function tabButton(tab) {
    return el('button', { type: 'button', 'data-account': tab.key || KEY, 'data-kind': KEY, 'data-antigravity': '', title: tab.title }, [
      el('span', { class: 'brand-glyph' }, [brandSvg('antigravity')]), 'Antigravity',
      tab.who ? el('small', { class: 'tab-who', text: tab.who, translate: 'no' }) : null,
    ]);
  }
  const owns = key => Boolean(visible() && typeof key === 'string' && (key === KEY || key.startsWith('antigravity:')));

  /* ---------------- 额度详情：各板块 ---------------- */

  function groupInsightOf(group) {
    const list = insight()?.groups || [];
    return list.find(item => item.key === group.key)
      || list.find(item => poolIdOf(item.models || item.key, item.title) === poolIdOf(group.models || group.key, group.title))
      || null;
  }

  /** 家庭组 / 其他设备共享额度归因条：直观区分「本机消耗」与「家庭成员/他端消耗」，说明防偏移校准。 */
  function sharedAttributionBox(shared) {
    if (!shared || shared.mode === 'solo' || (!shared.familyShared && !(shared.externalUsedPct >= 0.5))) return null;
    const localW = Math.max(0, Math.min(100, shared.localUsedPct || 0));
    const extW = Math.max(0, Math.min(100 - localW, shared.externalUsedPct || 0));
    const subText = shared.coUsedPoints >= 0.5 && shared.offPoints >= 0.5
      ? `空闲时段外部 +${shared.offPoints.toFixed(1)}% · 同期多人共用 +${shared.coUsedPoints.toFixed(1)}%，均已从整窗容量折算中剔除`
      : shared.coUsedPoints >= 0.5
        ? `检测到同期多人共用约 +${shared.coUsedPoints.toFixed(1)}%，已按独享基准从容量折算中剔除`
        : shared.offPoints >= 0.5
          ? `本机空闲时段外部消耗 +${shared.offPoints.toFixed(1)}%，已从整窗容量折算中剔除`
          : '当前窗口涨幅均与本机请求吻合，未检测到家庭成员额外占用';
    const localSeg = paint(el('i', { class: 'agy-shared-fill local' }), { width: `${localW.toFixed(1)}%` });
    const extSeg = paint(el('i', { class: 'agy-shared-fill external' }), { width: `${extW.toFixed(1)}%` });
    return el('div', { class: 'agy-shared-box' }, [
      el('div', { class: 'agy-shared-head' }, [
        el('div', { class: 'agy-shared-title' }, [
          el('b', { text: shared.familyShared ? '家庭组共享归因' : '多端共享归因' }),
          el('span', { class: 'ms-badge good', text: '已防偏移校准' }),
        ]),
        el('span', { class: 'num agy-shared-nums', text: `本机约 ${percent(shared.localUsedPct)} · 家庭组/他端约 ${percent(shared.externalUsedPct)}` }),
      ]),
      el('div', {
        class: 'agy-shared-track',
        role: 'img',
        'aria-label': `本机约 ${percent(shared.localUsedPct)}，家庭组或其他设备约 ${percent(shared.externalUsedPct)}`,
      }, [localSeg, extSeg]),
      el('p', { class: 'agy-shared-sub', text: subText }),
    ]);
  }

  function groupPanel(group, index) {
    const gInsight = groupInsightOf(group);
    const fiveShared = gInsight?.five?.shared || null;
    const weekShared = gInsight?.week?.shared || null;
    const staleHint = curAcc()?.cloudAuth ? '数据不是最新的，点右上角「刷新」后再判断' : '数据不是最新的，打开 Antigravity 后再判断';
    const panel = paint(el('article', { class: 'panel window-panel agy-group', 'data-group': group.key }, [
      el('div', { class: 'panel-heading' }, [
        el('h2', {}, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(group)]),
        el('span', { class: 'section-tag', text: '共用一份额度' }),
      ]),
    ]), { '--agy-color': COLORS[index % COLORS.length] });
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
      stale() ? staleHint : forecastText(group, 'five'),
    ]));
    if (gInsight?.five?.startedByReset && !done) {
      panel.append(el('p', { class: 'reset-card-note' }, [
        icon('refresh'),
        `${RESET_NOTE[gInsight.five.startedByReset] || RESET_NOTE.moved} · 从 ${date(gInsight.five.startAt)} 起算`,
      ]));
    }
    if (!done) {
      const sharedBox = sharedAttributionBox(fiveShared);
      if (sharedBox) panel.append(sharedBox);
    }

    // 周额度窗口（RetrieveUserQuotaSummary 返回的二级窗口）
    const week = group.week || gInsight?.week || null;
    if (week) {
      const weekDone = ended(week);
      const wf = forecast(group, 'week');
      const weekCaution = Boolean(wf?.etaAt) || (!weekDone && week.used >= 75);
      const weekBar = weekDone ? el('div', { class: 'track' }) : track(week.used, week.used >= 75, '周已用额度');
      weekBar.classList.add('window-track', 'agy-week-track');
      const showWeekShared = !weekDone && weekShared && weekShared.mode !== 'solo' && weekShared.externalUsedPct >= 0.5;
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
        showWeekShared
          ? el('div', { class: 'agy-week-shared num', text: `周归因：本机约 ${percent(weekShared.localUsedPct)} · 家庭组/他端约 ${percent(weekShared.externalUsedPct)}（已防偏移校准）` })
          : null,
        el('div', { class: 'prediction-line agy-week-pred' + (weekCaution ? ' caution' : '') }, [
          icon(weekCaution ? 'alert' : 'trend'),
          stale() ? staleHint : forecastText(group, 'week'),
        ]),
        gInsight?.week?.startedByReset && !weekDone
          ? el('p', { class: 'reset-card-note' }, [
              icon('refresh'),
              `${RESET_NOTE[gInsight.week.startedByReset] || RESET_NOTE.moved} · 从 ${date(gInsight.week.startAt)} 起算`,
            ])
          : null,
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
        sub: fiveCap?.fullCostUsd != null
          ? `${money(fiveCap.fullCostUsd)} · 约剩 ${tokens(fiveCap.remainingTokens || 0)}`
          : !done && group.used > 0 && group.used < 2
            ? '已用不到 2%，暂不折算整窗容量'
            : fiveShared && fiveShared.externalUsedPct >= 0.5 && !(fiveLocal?.tokens > 0)
              ? '当前涨幅来自家庭组/他端，等待本机使用后再折算'
              : '需窗口内已用 ≥ 2% 且有本机用量',
        chip: fiveCap?.fullTokens ? { tone: fiveCap.confidence === 'medium' ? 'medium' : 'low', text: CONFIDENCE_TEXT[fiveCap.confidence] || '估算' } : null,
      }),
      metric('周额度整窗折算', weekCap?.fullTokens ? amount(weekCap.fullTokens) : '—', {
        unit: weekCap?.fullTokens ? 'Tokens' : '',
        sub: weekCap?.fullCostUsd != null
          ? `${money(weekCap.fullCostUsd)} · 约剩 ${tokens(weekCap.remainingTokens || 0)}`
          : week && !ended(week) && week.used > 0 && week.used < 2
            ? '已用不到 2%，暂不折算整窗容量'
            : weekShared && weekShared.externalUsedPct >= 0.5 && !(weekLocal?.tokens > 0)
              ? '当前涨幅来自家庭组/他端，等待本机使用后再折算'
              : '需窗口内已用 ≥ 2% 且有本机用量',
        chip: weekCap?.fullTokens ? { tone: weekCap.confidence === 'medium' ? 'medium' : 'low', text: CONFIDENCE_TEXT[weekCap.confidence] || '估算' } : null,
      }),
    ], 'two'));

    // 速度与时间
    const dualPaceSub = f && !stale() && fiveShared && fiveShared.mode !== 'solo' && (fiveShared.externalUsedPct >= 0.5 || fiveShared.familyShared) && (fiveShared.localRatePerHour != null || fiveShared.externalRatePerHour != null)
      ? `本机 ${(fiveShared.localRatePerHour || 0).toFixed(2)} · 他端 ${(fiveShared.externalRatePerHour || 0).toFixed(2)} 点/时`
      : '这个窗口里的采样';
    panel.append(metricGroup('速度与时间', 'clock', [
      metric('最近速度', f && !stale() ? f.ratePerH.toFixed(2) : '—', { unit: f && !stale() ? '点 / 时' : '', sub: dualPaceSub }),
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

  /** 额度容量趋势：按额度池分别绘制 5 小时窗口 / 周额度窗口的历史折算容量曲线与校准中位线。 */
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
    const hideTip = () => { const t = document.getElementById('tip'); if (t) t.hidden = true; };

    function renderPoolCapChart(chartHost, pts, fullVal, w, color, fmt) {
      const W = Math.max(320, Math.round(chartHost.clientWidth || 430));
      const H = Math.max(150, Math.round(chartHost.clientHeight || 168));
      const left = 52, right = 20, top = 24, bottom = 24;
      const plotW = W - left - right, plotH = H - top - bottom;
      const valOfPt = p => capMetric === 'costUsd' ? (p.fullCostUsd || 0) : (p.fullTokens || 0);
      const rawVals = pts.map(valOfPt).filter(v => v > 0).sort((a, b) => a - b);
      const rawMax = Math.max(fullVal || 0, ...rawVals, 1);
      // 防止个别纯 Flash 窗口（同样 1% 多出十余倍 Token）把其余常规窗口压扁到底线
      const p75 = rawVals.length >= 4 ? rawVals[Math.min(rawVals.length - 1, Math.floor(rawVals.length * 0.75))] : rawMax;
      const yMax = (p75 > 0 && rawMax > p75 * 4.5 ? Math.max(p75 * 3.5, fullVal * 1.6) : rawMax * 1.16) || 1;
      const from = pts[0].startAt, span = Math.max(1, pts[pts.length - 1].startAt - from);
      const x = (p, i) => pts.length === 1
        ? left + plotW / 2
        : span > 60000
          ? left + 12 + ((p.startAt - from) / span) * (plotW - 24)
          : left + 12 + (i / (pts.length - 1)) * (plotW - 24);
      const y = v => top + (1 - Math.min(yMax, Math.max(0, v)) / yMax) * plotH;

      const node = paint(svg('svg', {
        class: 'agy-cap-svg',
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': capWindow === 'week' ? '历史周额度容量折线' : '历史 5 小时额度容量折线',
      }), { '--agy-color': color });

      for (const f of [0, 0.5, 1]) {
        const yy = y(yMax * f);
        node.append(svg('line', { class: 'agy-grid', x1: left, x2: W - right, y1: yy, y2: yy }));
        const lbl = svg('text', { class: 'agy-axis', x: left - 7, y: yy + 3.5, 'text-anchor': 'end' });
        lbl.textContent = f ? fmt(yMax * f) : '0';
        node.append(lbl);
      }

      if (fullVal > 0) {
        const my = y(fullVal);
        node.append(svg('line', { class: 'agy-cap-median', x1: left, x2: W - right, y1: my, y2: my }));
      }

      const coords = pts.map((p, i) => [x(p, i), y(valOfPt(p))]);
      if (coords.length >= 2) {
        const dLine = coords.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)},${cy.toFixed(1)}`).join(' ');
        const baseY = y(0).toFixed(1);
        const dArea = `${dLine} L${coords[coords.length - 1][0].toFixed(1)},${baseY} L${coords[0][0].toFixed(1)},${baseY} Z`;
        node.append(paint(svg('path', { class: 'agy-cap-area', d: dArea }), { fill: color }));
        node.append(paint(svg('path', { class: 'agy-cap-line', d: dLine }), { stroke: color }));
      }

      const activeResetMs = w && !w.ended && w.resetAt ? Date.parse(w.resetAt) || 0 : 0;
      const dayLabel = at => span < 36 * 3600000 && pts.length > 1
        ? new Date(at).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
        : new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' });
      pts.forEach((p, i) => {
        const [cx, cy] = coords[i];
        const rawV = valOfPt(p);
        const isCurrent = Boolean(p.current || (i === pts.length - 1 && activeResetMs > 0 && !p.endedByReset && Math.abs((p.resetAt || 0) - activeResetMs) < 15 * 60000));
        const isLow = (p.usedPct || 0) < 5;
        const clamped = rawV > yMax;
        const deltaLine = p.excludedPct >= 0.5
          ? `净计本机额度 +${Number(p.usedPct || 0).toFixed(1)}%（总涨 +${Number(p.rawUsedPct ?? ((p.usedPct || 0) + p.excludedPct)).toFixed(1)}%，已剔除家庭组/他端 +${Number(p.excludedPct).toFixed(1)}%）`
          : `区间额度变化 +${Number(p.usedPct || 0).toFixed(1)}%`;
        const tipLines = [
          `${date(p.startAt)} → ${date(p.endAt || p.resetAt)}${isCurrent ? '（进行中）' : ''}`,
          ...(p.startedByReset ? [RESET_NOTE[p.startedByReset] || RESET_NOTE.moved] : []),
          deltaLine,
          `同期本机 ${tokens(p.tokens || 0)} Tokens · ${money(p.costUsd || 0)}`,
          `折算整窗约 ${tokens(p.fullTokens || 0)} Tokens · ${money(p.fullCostUsd || 0)}`,
        ];
        const tipText = tipLines.join('\n');
        const dot = paint(svg('circle', {
          class: `agy-cap-dot ${isLow ? 'low' : 'solid'}${isCurrent ? ' current' : ''}${clamped ? ' clamped' : ''}`,
          cx: cx.toFixed(1),
          cy: cy.toFixed(1),
          r: isCurrent ? 5.2 : 4,
          tabindex: '0',
          'aria-label': tipText,
        }), { stroke: color, ...(isLow || isCurrent ? {} : { fill: color }) });
        dot.addEventListener('pointermove', ev => { if (typeof tipAt === 'function') tipAt(tipText, ev.clientX, ev.clientY); });
        dot.addEventListener('pointerleave', hideTip);
        dot.addEventListener('focus', () => { if (typeof tipAt === 'function') { const box = dot.getBoundingClientRect(); tipAt(tipText, box.x, box.y); } });
        dot.addEventListener('blur', hideTip);
        node.append(dot);

        if (isCurrent) {
          const tag = svg('text', { class: 'agy-axis agy-cap-current-label', x: cx.toFixed(1), y: Math.max(11, cy - 9).toFixed(1), 'text-anchor': 'middle' });
          tag.textContent = '进行中';
          node.append(tag);
        }
        if (i === 0 || i === pts.length - 1 || (pts.length >= 5 && i === Math.floor(pts.length / 2))) {
          const anchor = pts.length === 1 ? 'middle' : i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
          const tick = svg('text', { class: 'agy-axis', x: cx.toFixed(1), y: H - 6, 'text-anchor': anchor });
          tick.textContent = dayLabel(p.startAt);
          node.append(tick);
        }
      });

      chartHost.replaceChildren(node);
    }

    let capChartSlots = [];
    const draw = () => {
      capChartSlots = [];
      const pointsByGroup = gList.map((g, idx) => {
        const w = capWindow === 'week' ? g.week : g.five;
        const cap = w?.capacity;
        const rawHist = g.capacityHistory?.[capWindow] || [];
        const fullVal = capMetric === 'costUsd' ? (cap?.fullCostUsd || 0) : (cap?.fullTokens || 0);
        const pts = rawHist.length
          ? rawHist
          : fullVal > 0 && w
            ? [{ startAt: w.startAt, endAt: w.endAt, resetAt: w.endAt, usedPct: w.used || 0, tokens: w.local?.tokens || 0, costUsd: w.local?.costUsd || 0, fullTokens: cap?.fullTokens || 0, fullCostUsd: cap?.fullCostUsd || 0, current: !w.ended }]
            : [];
        return { g, idx, w, cap, pts, fullVal };
      });
      const anyCap = pointsByGroup.some(item => item.fullVal > 0 || item.pts.length > 0);
      if (!anyCap) {
        body.replaceChildren(empty('还没有足够折算整窗容量的样本：需要窗口内额度已用百分比上涨，并且同期本机有 Antigravity 对话记录。'));
        note.textContent = '整窗容量按「本机窗口内用量 ÷ 官方已用百分比变化」倒推，用来观察每组 100% 额度大约相当于多少 Tokens 或参考 API 费用。';
        return;
      }
      const fmt = capMetric === 'costUsd' ? money : tokens;
      const cards = pointsByGroup.map(({ g, idx, w, cap, pts, fullVal }) => {
        const color = COLORS[idx % COLORS.length];
        const remVal = capMetric === 'costUsd' ? cap?.remainingCostUsd : cap?.remainingTokens;
        const conf = cap?.confidence || 'insufficient';
        const badgeTone = conf === 'medium' ? 'good' : fullVal > 0 ? 'warn' : '';
        const badgeText = CONFIDENCE_TEXT[conf] || '样本不足';
        let chartArea;
        if (pts.length) {
          chartArea = el('div', { class: 'agy-cap-chart' });
          capChartSlots.push({ chartHost: chartArea, pts, fullVal, w, color, fmt });
        } else {
          chartArea = el('div', { class: 'agy-cap-empty' }, [
            el('strong', { text: '等待额度变化以校准容量' }),
            el('span', { text: '需要这一组额度已用百分比上涨，且同期本机有对话记录' }),
          ]);
        }
        const obsPct = cap?.points || Math.round(pts.reduce((s, p) => s + (p.usedPct || 0), 0) * 10) / 10;
        return paint(el('div', { class: 'agy-cap-row agy-cap-card', 'data-group': g.key }, [
          el('div', { class: 'agy-cap-head' }, [
            el('div', { class: 'agy-cap-title-wrap' }, [
              el('span', { class: 'agy-cap-title' }, [el('i', { class: 'agy-dot', 'aria-hidden': 'true' }), groupName(g)]),
              el('span', { class: 'ms-badge' + (badgeTone ? ' ' + badgeTone : ''), text: badgeText }),
            ]),
            el('span', { class: 'num agy-cap-val' }, [
              el('strong', { text: fullVal > 0 ? fmt(fullVal) : '—' }),
              fullVal > 0 ? el('small', { text: capWindow === 'week' ? ' / 整周' : ' / 5 小时' }) : null,
            ]),
          ]),
          chartArea,
          el('div', { class: 'agy-cap-sub' }, [
            el('span', { text: remVal != null && fullVal > 0 ? `当前窗口约剩 ${fmt(remVal)}` : '等待额度变化以校准容量' }),
            el('span', { text: pts.length ? `已累计 ${number(pts.length)} 个周期样本 · 观测 ${obsPct}% 额度变化` : w ? `当前已用 ${percent(w.used)}` : '' }),
          ]),
        ]), { '--agy-color': color });
      });
      body.replaceChildren(el('div', { class: 'agy-cap-list' }, cards));
      for (const slot of capChartSlots) renderPoolCapChart(slot.chartHost, slot.pts, slot.fullVal, slot.w, slot.color, slot.fmt);
      note.textContent = '实心点可信，空心点已用不到 5%、偏差较大；虚线为近期窗口加权中位数。按本机用量倒推，只统计这台电脑上的 Antigravity 对话。';
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
    panel.drawChart = () => {
      for (const slot of capChartSlots) renderPoolCapChart(slot.chartHost, slot.pts, slot.fullVal, slot.w, slot.color, slot.fmt);
    };
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

  /** 最近 7 天每组的已用百分比（独立整行卡片，含 5 小时实线与周额度虚线，自动串联模型增减前后的同池采样）。 */
  function historyPanel() {
    const panel = el('article', { class: 'panel agy-history' }, [
      el('div', { class: 'panel-heading' }, [
        el('h2', { text: '最近 7 天的额度' }),
        el('span', { class: 'section-tag', text: '5 小时与周额度已用百分比' }),
      ]),
    ]);
    const list = groups();
    const samples = historyOf();
    if (samples.length < 2) {
      panel.append(empty(curAcc()?.cloudAuth ? '采样还不够。TokenPulse 每次定时查询都会记一条，过一阵就能看到走势。' : '采样还不够。Antigravity 开着的时候每次查询都会记一条，过一阵就能看到走势。'));
      return panel;
    }
    const now = Math.max(Date.now(), last()?.at || 0, samples[samples.length - 1]?.at || 0);
    const minFrom = now - 7 * 86400000;
    const GAP_MS = 6 * 3600000;
    const plotSamples = samples.filter(s => Number.isFinite(s?.at) && s.at >= minFrom - 60000 && s.at <= now + 60000).slice().sort((a, b) => a.at - b.at);
    if (last()?.ok && last()?.at >= minFrom && (!plotSamples.length || last().at > plotSamples[plotSamples.length - 1].at + 1000)) {
      plotSamples.push({
        at: last().at,
        groups: list.map(g => ({
          key: g.key,
          used: g.used,
          resetAt: g.resetAt,
          ...(g.week ? { weekUsed: g.week.used, weekResetAt: g.week.resetAt } : {}),
        })),
      });
    }
    if (plotSamples.length < 2) {
      panel.append(empty('采样还不够。Antigravity 开着的时候每次查询都会记一条，过一阵就能看到走势。'));
      return panel;
    }
    const rawSpan = Math.max(3600000, now - plotSamples[0].at);
    const from = rawSpan >= 6.5 * 86400000
      ? minFrom
      : Math.max(minFrom, plotSamples[0].at - Math.min(1800000, rawSpan * 0.04));
    const spanMs = Math.max(3600000, now - from);

    const buildSegmentedPath = pts => {
      const cmds = [];
      const isolated = [];
      let segLen = 0;
      for (let i = 0; i < pts.length; i++) {
        const cur = pts[i], prev = pts[i - 1];
        const startNew = i === 0 || cur.at - prev.at > GAP_MS;
        if (startNew) {
          if (i > 0 && segLen === 1) isolated.push(pts[i - 1]);
          cmds.push(`M${cur.cx.toFixed(1)},${cur.cy.toFixed(1)}`);
          segLen = 1;
        } else {
          cmds.push(`L${cur.cx.toFixed(1)},${cur.cy.toFixed(1)}`);
          segLen += 1;
        }
      }
      if (pts.length > 0 && segLen === 1) isolated.push(pts[pts.length - 1]);
      return { d: cmds.join(' '), isolated };
    };

    const hasWeekLine = list.some(group => {
      let n = 0;
      for (const sample of plotSamples) {
        const item = pickPoolItem(sample.groups, group);
        if (item?.weekUsed != null && Number.isFinite(item.weekUsed) && ++n >= 2) return true;
      }
      return false;
    });

    const chartHost = el('div', { class: 'agy-chart-host' });
    panel.append(chartHost);
    panel.append(el('div', { class: 'agy-legend' }, [
      ...list.map((group, index) => paint(el('span', { class: 'agy-legend-item' }, [
        el('i', { class: 'agy-dot', 'aria-hidden': 'true' }),
        groupName(group),
      ]), { '--agy-color': COLORS[index % COLORS.length] })),
      hasWeekLine ? el('span', { class: 'agy-legend-note', text: '实线：5 小时已用 · 虚线：周额度已用' }) : null,
    ]));

    panel.drawChart = () => {
      const W = Math.max(460, Math.round(chartHost.clientWidth || 860));
      const H = Math.max(180, Math.round(chartHost.clientHeight || 224));
      const pad = { l: 42, r: 16, t: 12, b: 26 };
      const x = at => pad.l + Math.max(0, Math.min(1, (at - from) / spanMs)) * (W - pad.l - pad.r);
      const y = used => pad.t + (1 - Math.min(100, Math.max(0, used)) / 100) * (H - pad.t - pad.b);
      const chartSvg = svg('svg', { class: 'agy-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '最近 7 天各组额度的已用百分比' });
      for (const v of [0, 25, 50, 75, 100]) {
        const major = v === 0 || v === 50 || v === 100;
        chartSvg.append(svg('line', { class: major ? 'agy-grid' : 'agy-grid faint', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
        if (major) {
          const label = svg('text', { class: 'agy-axis', x: pad.l - 7, y: y(v) + 4, 'text-anchor': 'end' });
          label.textContent = v + '%';
          chartSvg.append(label);
        }
      }
      const tickCount = spanMs >= 2 * 86400000 ? Math.min(7, Math.max(3, Math.round(spanMs / 86400000))) : W >= 720 ? 6 : 4;
      for (let d = 0; d <= tickCount; d += 1) {
        const at = from + (d / tickCount) * spanMs;
        const label = svg('text', { class: 'agy-axis', x: x(at), y: H - 6, 'text-anchor': d === 0 ? 'start' : d === tickCount ? 'end' : 'middle' });
        label.textContent = spanMs >= 2 * 86400000
          ? new Date(at).toLocaleDateString(dateLocale(), { month: 'numeric', day: 'numeric' })
          : new Date(at).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', hour12: false });
        chartSvg.append(label);
      }

      list.forEach((group, index) => {
        const color = COLORS[index % COLORS.length];
        const series = paint(svg('g', { class: 'agy-series' }), { '--agy-color': color });
        const fivePts = [];
        const weekPts = [];
        for (const sample of plotSamples) {
          const item = pickPoolItem(sample.groups, group);
          if (!item) continue;
          if (Number.isFinite(item.used)) fivePts.push({ at: sample.at, used: item.used, cx: x(sample.at), cy: y(item.used) });
          if (item.weekUsed != null && Number.isFinite(item.weekUsed)) weekPts.push({ at: sample.at, used: item.weekUsed, cx: x(sample.at), cy: y(item.weekUsed) });
        }
        if (fivePts.length) {
          const { d, isolated } = buildSegmentedPath(fivePts);
          series.append(paint(svg('path', { class: 'agy-line', d }), { stroke: color }));
          const latest = fivePts[fivePts.length - 1];
          const dotPts = isolated.includes(latest) ? isolated : [...isolated, latest];
          for (const dp of dotPts) {
            series.append(paint(svg('circle', {
              class: 'agy-chart-dot' + (dp === latest ? ' is-latest' : ''),
              cx: dp.cx.toFixed(1),
              cy: dp.cy.toFixed(1),
              r: dp === latest ? 3.4 : 2.5,
            }), { fill: color }));
          }
        }
        if (weekPts.length >= 2) {
          const { d } = buildSegmentedPath(weekPts);
          series.append(paint(svg('path', { class: 'agy-line-week', d }), { stroke: color }));
        }
        chartSvg.append(series);
      });

      const hoverLine = svg('line', { class: 'agy-hover-line', x1: pad.l, x2: pad.l, y1: pad.t, y2: H - pad.b, hidden: 'hidden' });
      chartSvg.append(hoverLine);
      const hideTip = () => {
        hoverLine.setAttribute('hidden', 'hidden');
        const t = document.getElementById('tip');
        if (t) t.hidden = true;
      };
      chartSvg.addEventListener('pointermove', ev => {
        const box = chartSvg.getBoundingClientRect();
        if (!box.width) return;
        const svgX = ((ev.clientX - box.left) / box.width) * W;
        const targetAt = from + Math.max(0, Math.min(1, (svgX - pad.l) / (W - pad.l - pad.r))) * spanMs;
        let nearest = null, bestDiff = Infinity;
        for (const s of plotSamples) {
          const diff = Math.abs(s.at - targetAt);
          if (diff < bestDiff) { bestDiff = diff; nearest = s; }
        }
        if (!nearest) return;
        const hx = x(nearest.at).toFixed(1);
        hoverLine.setAttribute('x1', hx);
        hoverLine.setAttribute('x2', hx);
        hoverLine.removeAttribute('hidden');
        const lines = [date(nearest.at)];
        for (const group of list) {
          const item = pickPoolItem(nearest.groups, group);
          if (!item) continue;
          const shortName = group.title || group.models.slice(0, 2).join(' · ');
          lines.push(`${shortName}：5 小时已用 ${percent(item.used)}${item.weekUsed != null ? ` · 周已用 ${percent(item.weekUsed)}` : ''}`);
        }
        if (typeof tipAt === 'function') tipAt(lines.join('\n'), ev.clientX, ev.clientY);
      });
      chartSvg.addEventListener('pointerleave', hideTip);
      chartHost.replaceChildren(chartSvg);
    };

    panel.drawChart();
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
    let hourlyHost = null;
    if (local.hourly?.length && typeof chart === 'function') {
      hourlyHost = el('div', { class: 'chart agy-hourly-chart' });
      panel.append(hourlyHost);
    }
    panel.drawChart = (animate = false) => {
      if (hourlyHost && local.hourly?.length && typeof chart === 'function') {
        chart(hourlyHost, local.hourly, 'tokens', true, animate);
      }
    };
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
        return paint(el('div', { class: 'ms-budget' }, [
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
        ]), { '--agy-color': COLORS[idx % COLORS.length] });
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
                row.effort ? el('span', { class: 'ms-level' + (row.effort === 'medium' ? ' plain' : ''), text: EFFORT_LABEL[row.effort] || row.effort }) : null,
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
              : row.timing?.firstTokenMs != null
                ? `首字 ${fmtSec(row.timing.firstTokenMs)}`
                : row.timing?.ms != null
                  ? `耗时 ${fmtSec(row.timing.ms)}`
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

  function accountLiveSummary(acc) {
    const gList = acc?.last?.groups || [];
    const live = gList.filter(g => !ended(g) || (g.week && !ended(g.week)));
    const reporting = Boolean(acc?.last?.ok && live.length > 0);
    const left = reporting ? Math.min(...live.map(g => Math.max(0, 100 - effectiveUsed(g)))) : null;
    const exhausted = reporting && left != null && left <= 0;
    return { gList, live, reporting, left, exhausted };
  }

  function leadAccount() {
    const list = accountsList();
    if (!list.length) return null;
    return list.find(a => a.usable && !accountLiveSummary(a).exhausted && accountLiveSummary(a).reporting)
      || list.find(a => accountLiveSummary(a).reporting)
      || list[0];
  }

  function accountStrip(selectedAcc) {
    const list = accountsList();
    if (list.length <= 1) return null;
    const poolIds = new Set(list.map(a => a.familyGroupId || a.id));
    const readyPools = new Set(list.filter(a => {
      const s = accountLiveSummary(a);
      return s.reporting && !s.exhausted;
    }).map(a => a.familyGroupId || a.id));
    const hasSharedPool = poolIds.size < list.length || list.some(a => a.familyShared);
    const summaryText = hasSharedPool
      ? `${number(list.length)} 个账号 · ${number(readyPools.size)} / ${number(poolIds.size)} 份独立额度池有余量`
      : `${number(list.length)} 个账号 · ${number(readyPools.size)} / ${number(list.length)} 个有余量`;

    const manageBtn = el('button', { type: 'button', class: 'text-btn agy-manage-btn', 'data-action': 'agy-manage-accounts' }, [
      el('span', { text: '管理账号' }),
      icon('arrow'),
    ]);
    manageBtn.addEventListener('click', () => { if (typeof openSettings === 'function') openSettings('accounts'); });

    const items = list.map(item => {
      const on = item.id === selectedAcc?.id;
      const sum = accountLiveSummary(item);
      const name = displayNameOf(item) || item.accountHint || '未命名账号';
      const statusText = sum.exhausted ? '已用完' : sum.reporting && sum.left != null ? `剩 ${sum.left.toFixed(1)}%` : item.needsLogin ? '需重登' : '待查询';
      const btn = el('button', {
        type: 'button',
        class: 'agy-strip-item' + (on ? ' on' : '') + (sum.exhausted ? ' exhausted' : ''),
        'data-agy-pick': item.id,
        'aria-pressed': String(on),
        'aria-label': `${name}，${statusText}${item.familyShared ? '，家庭组共享池' : ''}`,
      }, [
        el('div', { class: 'agy-strip-main' }, [
          el('b', { class: 'agy-strip-name', translate: 'no', text: name }),
          item.inLocal ? el('span', { class: 'agy-mini-tag local', text: '本机当前' }) : null,
          item.familyShared ? el('span', { class: 'agy-mini-tag family', text: '家庭共享' }) : null,
        ]),
        el('div', { class: 'agy-strip-meta' }, [
          el('span', { class: 'muted', translate: 'no', text: planText(item) || 'Google' }),
          el('span', { class: 'num agy-strip-left', text: statusText }),
        ]),
      ]);
      btn.addEventListener('click', () => {
        if (item.id === activeId && state.account === item.id) return;
        activeId = item.id;
        state.account = item.id;
        keepScroll(() => window.renderQuota());
      });
      return btn;
    });

    return el('div', { class: 'panel agy-account-strip', role: 'region', 'aria-label': 'Antigravity 账号概览' }, [
      el('div', { class: 'agy-strip-head' }, [
        el('div', { class: 'agy-strip-title' }, [
          el('b', { text: 'Antigravity 多账号概览' }),
          el('span', { class: 'section-tag', text: summaryText }),
        ]),
        manageBtn,
      ]),
      hasSharedPool
        ? el('p', { class: 'agy-strip-hint muted', text: '同 Google One 家庭组的账号共用同一份 Antigravity 额度池：上方计数已自动合并同池账号，避免重复计池。' })
        : null,
      el('div', { class: 'agy-strip-grid' }, items),
    ]);
  }

  function shareModeBar(acc) {
    if (!acc) {
      const addBtn = el('button', { type: 'button', class: 'text-btn agy-manage-btn', 'data-action': 'agy-open-accounts' }, [
        icon('plus'),
        el('span', { text: '添加更多 Antigravity 账号' }),
      ]);
      addBtn.addEventListener('click', () => { if (typeof openSettings === 'function') openSettings('accounts'); });
      return el('div', { class: 'agy-share-bar is-lite' }, [addBtn]);
    }
    const modeGroup = el('div', { class: 'seg compact agy-share-seg', role: 'group', 'aria-label': '额度共享校准模式' }, [
      el('span', { class: 'seg-thumb', 'aria-hidden': 'true' }),
      ...SHARE_MODES.map(([mode, label, hint]) => {
        const on = (acc.shareMode || 'auto') === mode;
        const b = el('button', {
          type: 'button',
          'data-agy-share': mode,
          class: on ? 'on' : null,
          'aria-pressed': String(on),
          title: hint,
          text: label,
        });
        b.addEventListener('click', async () => {
          if ((acc.shareMode || 'auto') === mode || b.disabled) return;
          for (const item of modeGroup.querySelectorAll('button')) item.disabled = true;
          try {
            await api.manage('share-mode', acc.id, mode);
            const fresh = await api.state();
            apply(fresh);
            if (typeof showStatus === 'function') showStatus(`已切换为「${label}」`);
          } catch (err) {
            if (typeof toast === 'function') toast(err?.message || '设置保存失败', { kind: 'error' });
          } finally {
            for (const item of modeGroup.querySelectorAll('button')) if (item.isConnected) item.disabled = false;
          }
        });
        return b;
      }),
    ]);

    const familyBadge = acc.familyShared
      ? el('span', {
          class: 'agy-family-pill',
          title: '检测到该账号处于 Google One 家庭组共享池：本机空闲与多人并发消耗会自动从容量折算中剥离，防止容量算小',
        }, [
          el('span', { text: '家庭组共享池' }),
          acc.familyPeers?.length ? el('small', { text: ` · 与 ${acc.familyPeers.join(' / ')} 共用` }) : null,
        ])
      : null;

    const manageBtn = el('button', { type: 'button', class: 'text-btn agy-manage-btn', 'data-action': 'agy-open-accounts' }, [
      el('span', { text: '账号设置' }),
      icon('arrow'),
    ]);
    manageBtn.addEventListener('click', () => { if (typeof openSettings === 'function') openSettings('accounts'); });

    return el('div', { class: 'agy-share-bar' }, [
      familyBadge,
      el('span', { class: 'agy-share-label muted', text: '容量校准：' }),
      modeGroup,
      manageBtn,
    ]);
  }

  function renderQuota(host, keyOrTimeline, maybeTimeline) {
    if (detailResizeObs) { detailResizeObs.disconnect(); detailResizeObs = null; }
    const isLegacyCall = keyOrTimeline && typeof keyOrTimeline === 'object' && keyOrTimeline.nodeType === 1;
    const requestedKey = isLegacyCall ? KEY : (typeof keyOrTimeline === 'string' ? keyOrTimeline : KEY);
    const timelineNode = isLegacyCall ? keyOrTimeline : maybeTimeline;

    const acc = resolveAccount(requestedKey);
    activeId = acc ? acc.id : KEY;
    const selectedKey = activeId;

    const ins = insight(acc);
    const credits = last(acc)?.credits;
    const creditParts = [];
    if (credits?.availablePromptCredits != null && credits?.monthlyPromptCredits != null) {
      creditParts.push(`Prompt 积分 ${number(credits.availablePromptCredits)} / ${number(credits.monthlyPromptCredits)}`);
    }
    if (credits?.availableFlowCredits != null && credits?.monthlyFlowCredits != null) {
      creditParts.push(`Flow 积分 ${number(credits.availableFlowCredits)} / ${number(credits.monthlyFlowCredits)}`);
    }
    const convCount = ins?.conversations ?? quota?.conversations ?? 0;
    const sampleCount = ins?.sampleCount ?? historyOf(acc).length;
    const whoParts = [acc ? displayNameOf(acc) : '', planText(acc)].filter(Boolean).join(' · ');
    const descText = acc?.cloudAuth
      ? '额度按型号分组：一组里的型号共用一份，包含 5 小时窗口与周额度窗口。已保存独立授权，关着 Antigravity 也能自动续期并直连查询。'
      : '额度按型号分组：一组里的型号共用一份，包含 5 小时窗口与周额度窗口。只能问本机开着的 Antigravity。';

    host.append(el('div', { class: 'quota-context agy-context' }, [
      avatar('antigravity'),
      el('div', { class: 'agy-context-body' }, [
        el('h2', {}, ['Google Antigravity', whoParts ? el('span', { class: 'context-who', text: whoParts, translate: 'no' }) : null]),
        el('p', { class: 'muted', text: descText }),
        el('p', { class: 'muted agy-context-sub', text: [`${number(convCount)} 个本机对话`, `${number(sampleCount)} 个额度采样`, ...creditParts].join(' · ') }),
        shareModeBar(acc),
      ]),
      el('div', { class: 'context-meta agy-context-meta' }, [el('span', { text: updatedText(acc) }), refreshButton('btn', acc?.id)]),
    ]));

    const strip = accountStrip(acc);
    if (strip) host.append(strip);

    // 一条说明可以是几句：分开放，翻译按句对得上
    for (const note of notes(acc)) host.append(el('p', { class: 'stale-note agy-note' }, [icon('alert'), ...[].concat(note).map(text => el('span', { text: text + ' ' }))]));
    const list = groups(acc);
    let capPanel = null;
    let histPanel = null;
    if (!list.length) {
      host.append(el('article', { class: 'panel empty large' }, [
        el('h3', { text: isBusy(acc) ? '正在查询额度…' : '还没有查到额度' }),
        el('p', { text: acc?.cloudAuth ? '点右上角「刷新」立即从 Google Cloud Code 拉取最新额度。' : '打开 Antigravity，等它登录好之后点「刷新」，或在设置里登录独立账号。' }),
      ]));
    } else {
      host.append(markLayout(el('div', { class: 'quota-window-grid agy-groups' }, list.map((group, index) => groupPanel(group, index))), 'quota:agy-groups'));
      capPanel = agyCapacityPanel();
      host.append(markLayout(capPanel, 'quota:agy-capacity'));
      histPanel = historyPanel();
      host.append(markLayout(histPanel, 'quota:agy-history'));
    }
    const locPanel = usagePanel();
    host.append(markLayout(locPanel, 'quota:agy-local'));
    if (timelineNode) {
      delete timelineNode.dataset.layoutNatural;
      host.append(timelineNode);
      window.PulseModelStudy?.timeline(typeof current !== 'undefined' ? current : null, selectedKey, { kind: KEY, accountId: selectedKey, lastCheckedAt: last(acc)?.at || 0 });
    }
    if (typeof speedPanel === 'function') {
      const speed = speedPanel({ accountId: selectedKey, accountLabel: acc ? `Antigravity · ${displayNameOf(acc) || '账号'}` : 'Antigravity' }, KEY, {
        tag: 'Antigravity 本地记录',
        hint: '每个模型每秒输出多少 Token、首字延迟多少秒，直接从本机 Antigravity 对话数据库（gen_metadata）读取。',
        load: days => api.speed(days, acc?.id),
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

    const animate = typeof entering === 'function' ? entering() : false;
    capPanel?.drawChart?.();
    histPanel?.drawChart?.();
    locPanel?.drawChart?.(animate);
    let lastHostWidth = Math.round(host.clientWidth || 0);
    if (typeof ResizeObserver === 'function') {
      detailResizeObs = new ResizeObserver(() => {
        if (!host.isConnected || !host.querySelector(':scope > .agy-context')) {
          detailResizeObs?.disconnect();
          detailResizeObs = null;
          return;
        }
        const nextWidth = Math.round(host.clientWidth || 0);
        if (!nextWidth || Math.abs(nextWidth - lastHostWidth) < 4) return;
        lastHostWidth = nextWidth;
        capPanel?.drawChart?.();
        histPanel?.drawChart?.();
        locPanel?.drawChart?.(false);
      });
      detailResizeObs.observe(host);
    }
    return selectedKey;
  }

  /* ---------------- 总览里的卡片 ---------------- */

  function agyQueueSection(lead) {
    const all = accountsList();
    if (all.length <= 1 || !lead) return null;
    const others = all.filter(item => item.id !== lead.id);
    const poolIds = new Set(all.map(a => a.familyGroupId || a.id));
    const readyPools = new Set(all.filter(a => {
      const s = accountLiveSummary(a);
      return s.reporting && !s.exhausted;
    }).map(a => a.familyGroupId || a.id));
    const hasSharedPool = poolIds.size < all.length || all.some(a => a.familyShared);
    const headRight = hasSharedPool
      ? `${number(readyPools.size)} / ${number(poolIds.size)} 份额度池有余量`
      : `${number(readyPools.size)} / ${number(all.length)} 个有余量`;

    const MAX_ROWS = 4;
    const rows = others.slice(0, MAX_ROWS).map(item => {
      const sum = accountLiveSummary(item);
      const mini = ring({
        five: sum.live[0] ? { used: effectiveUsed(sum.live[0]) } : null,
        week: sum.live[1] ? { used: effectiveUsed(sum.live[1]) } : null,
      });
      mini.classList.add('pool-mini-ring');
      mini.removeAttribute('title');
      const statusText = sum.exhausted ? '已用完' : !sum.reporting || sum.left == null ? '暂无数据' : `剩 ${sum.left.toFixed(1)}%`;
      const name = displayNameOf(item) || item.accountHint || '未命名账号';
      const row = el('button', {
        type: 'button',
        class: 'pool-queue-row' + (sum.exhausted ? ' exhausted' : ''),
        title: [item.accountHint || name, planText(item)].filter(Boolean).join(' · '),
      }, [
        mini,
        el('span', { class: 'pool-queue-name', text: name, translate: 'no' }),
        item.familyShared
          ? el('span', { class: 'agy-queue-tag', text: '同家庭组' })
          : el('span', { 'aria-hidden': 'true' }),
        el('span', { class: 'pool-queue-left', text: statusText }),
      ]);
      row.addEventListener('click', () => { activeId = item.id; state.account = item.id; navigate('quota'); });
      return row;
    });
    const more = others.length > MAX_ROWS
      ? el('button', { type: 'button', class: 'pool-queue-more' }, [`还有 ${number(others.length - MAX_ROWS)} 个账号`, icon('arrow')])
      : null;
    more?.addEventListener('click', () => { activeId = lead.id; state.account = lead.id; navigate('quota'); });
    return el('div', { class: 'pool-queue agy-pool-queue' }, [
      el('div', { class: 'pool-queue-head' }, [el('span', { text: '其他账号' }), el('small', { text: headRight })]),
      ...rows,
      more,
    ]);
  }

  function card() {
    const lead = leadAccount();
    const list = groups(lead);
    const live = list.filter(group => !ended(group) || (group.week && !ended(group.week)));
    const worst = live.slice().sort((a, b) => effectiveUsed(b) - effectiveUsed(a))[0];
    const worstUsed = worst ? effectiveUsed(worst) : 0;
    const isStaleLead = stale(lead);
    const leadLast = last(lead);
    const canQuery = lead ? (lead.cloudAuth || lead.inLocal || quota?.running) : Boolean(quota?.running);
    const level = !leadLast ? '' : isStaleLead ? '' : worst ? levelOf(worst) : '';
    const badge = !leadLast?.at ? [isBusy(lead) ? '正在查询…' : canQuery ? '还没查询过' : '没有开着', '']
      : !canQuery ? ['没有开着', ''] : !leadLast.ok ? ['查询失败', 'critical'] : isStaleLead ? ['采样已过期', '']
      : worstUsed >= 100 ? ['有一组用完了', 'critical'] : worstUsed >= 90 ? ['快用完了', 'critical'] : worstUsed >= 75 ? ['用量偏高', 'warning'] : ['节奏正常', 'good'];
    const whoText = lead ? ([displayNameOf(lead), planText(lead)].filter(Boolean).join(' · ') || 'Google') : (planText(null) || 'Google');
    const body = [el('div', { class: 'account-head' }, [
      avatar('antigravity'),
      el('div', { class: 'account-title' }, [
        el('span', { class: 'account-name', text: 'Antigravity' }),
        el('span', { class: 'plan who', translate: 'no', text: whoText }),
      ]),
      el('span', { class: 'badge ' + badge[1], text: badge[0] }),
    ])];
    const ringNode = ring({ five: live[0] ? { used: effectiveUsed(live[0]) } : null, week: live[1] ? { used: effectiveUsed(live[1]) } : null });
    ringNode.title = live.length > 1 ? `外环：${live[0].models.join(' · ')}　内环：${live[1].models.join(' · ')}` : '';
    const left = live.length ? Math.min(...live.map(group => Math.max(0, 100 - effectiveUsed(group)))) : null;
    ringNode.append(el('div', { class: 'ring-center' }, [el('div', { class: 'quota-remaining' + (left == null ? ' empty-number' : ''), text: left == null ? '—' : left.toFixed(1) }, left == null ? [] : [el('small', { text: '%' })])]));
    const worstReset = worst?.resetAt || worst?.week?.resetAt;
    const subFallback = lead?.cloudAuth ? '已开启独立授权自动查询' : '额度只能问本机开着的 Antigravity';
    body.push(el('div', { class: 'quota-hero' }, [ringNode, el('div', { class: 'quota-hero-text' }, [
      el('span', { class: 'quota-hero-label', text: `${isStaleLead ? '上次' : ''}${live.length > 1 ? '较低一组' : '额度'}剩余` }),
      el('span', { class: 'quota-hero-value', text: worstReset ? `${duration(Date.parse(worstReset) - Date.now())}后重置` : list.length ? '重置时间未知' : '尚未取得额度' }),
      el('span', { class: 'quota-hero-sub', text: worstReset ? `${date(Date.parse(worstReset))} · ${lead?.familyShared ? '家庭组共享额度' : '本地时间'}` : subFallback }),
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
      body.push(paint(el('div', { class: 'quota-mini agy-mini', 'data-group': group.key }, rows), { '--agy-color': COLORS[index % COLORS.length] }));
    });
    if (!list.length) body.push(el('div', { class: 'quota-missing' }, [el('p', { text: [].concat(notes(lead)[0] || '打开 Antigravity 后会自动查询。')[0] })]));
    const queue = agyQueueSection(lead);
    if (queue) body.push(queue);
    const targetAccount = lead ? lead.id : KEY;
    const link = el('button', { type: 'button', class: 'text-btn', 'data-go': 'quota', 'aria-label': 'Antigravity 额度详情' }, ['详情', icon('arrow')]);
    link.hidden = typeof navHidden === 'function' && navHidden('quota');
    link.addEventListener('click', () => { activeId = targetAccount; state.account = targetAccount; navigate('quota'); });
    body.push(el('div', { class: 'quota-card-foot' }, [el('span', { text: updatedText(lead) }), el('span', { class: 'agy-card-actions' }, [refreshButton('text-btn'), link])]));
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

  window.AntigravityQuota = { render, cards, tabs, tabButton, owns, renderQuota, quotaShare, apply, state: () => quota };
  api.onState(apply);
  api.state().then(apply).catch(() => {});
})();
