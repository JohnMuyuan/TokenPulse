'use strict';
/*
 * 出口监控页。
 *
 * 每家一张卡片：顶部是出口本身（国旗、IP、地区、ASN、家宽 / 机房、延迟），中间是几个公开 IP 数据库的判断
 * （风险分、VPN / 代理 / 机房标记，数据见 src/core/ip-intel.ts），白名单这些设置收进卡片底部的折叠区 ——
 * 以前表单占了卡片的大半，出口信息本身只有两行字。
 *
 * 国旗用随包的 Twemoji Country Flags 字体（renderer/fonts）：Windows 自带的表情字体不画国旗，只显示两个字母。
 */
(() => {
  const root = document.getElementById('page-egress'), api = window.tokenpulse;
  const keys = ['chatgpt', 'claude', 'grok'];
  const controls = new Map();
  let snapshot, built = false, dirty = false, saving = false, historyKey = '';
  const lang = () => window.PulseI18n?.lang() === 'en' ? 'en' : 'zh';
  const t = text => lang() === 'en' ? window.PulseI18n.t(text) : text;
  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = t(text); return n; };
  const button = (text, action, cls = 'btn') => { const n = node('button', cls, text); n.type = 'button'; n.addEventListener('click', action); return n; };
  const iconNode = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'icon'); s.setAttribute('aria-hidden', 'true'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${name}`); s.append(u); return s; };
  const split = value => value.trim().split(/[\s,，;；]+/).filter(Boolean);
  const time = at => at ? new Date(at).toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '—';
  const clock = at => at ? new Date(at).toLocaleTimeString(lang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '—';
  const errorText = error => error?.startsWith('http_') ? `HTTP ${error.slice(5)}` : t(({ timeout: '请求超时', tls: 'TLS 连接失败', network: '网络连接失败', invalid_trace: '响应不是目标域名的有效出口信息', invalid_host: '检测域名无效' })[error] || '无法验证');
  const countryName = code => { try { return new Intl.DisplayNames([lang() === 'en' ? 'en' : 'zh-CN'], { type: 'region' }).of(code); } catch { return code; } };
  const regionText = code => code ? `${code} · ${countryName(code)}` : t('地区未知');
  /** 两位国家代码 → 国旗表情（区域指示符），配合 Twemoji 国旗字体显示成图。 */
  const flagOf = code => /^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
  const TYPE_LABEL = { isp: '家宽 ISP', hosting: '机房 Hosting', business: '企业 Business', mobile: '移动 Mobile', education: '教育 Education', unknown: '类型未知' };
  const TYPE_TONE = { isp: 'good', hosting: 'warn', business: 'info', mobile: 'info', education: 'info', unknown: '' };
  /** 风险分按 proxycheck 的口径分三档：0–33 低、34–66 中、67 起高。 */
  const riskLevel = risk => risk == null ? '' : risk < 34 ? 'low' : risk < 67 ? 'medium' : 'high';
  const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' };
  /** 成功（已保存、已复制）走右上角提示；失败原因留在页面里，方便对着改。 */
  function message(text, error = false, inline = false) {
    const n = document.getElementById('egress-message');
    if (!error && !inline && typeof showStatus === 'function') { if (n) { n.textContent = ''; n.classList.remove('error'); } showStatus(text); return; }
    if (n) { n.textContent = t(text); n.classList.toggle('error', error); n.setAttribute('role', error ? 'alert' : 'status'); }
  }
  function markDirty() { dirty = true; message('有未保存的设置，保存后生效。', false, true); }
  function field(title, input) { const label = node('label', 'egress-field'); label.append(node('span', '', title), input); return label; }
  function toggleField(title, input) { const label = node('label', 'egress-switch'); label.append(input, node('span', '', title)); return label; }

  function make(data) {
    /* ---- 顶部：状态 + 操作 ---- */
    const toolbar = node('div', 'panel egress-toolbar');
    const status = node('div', 'egress-status');
    const pulse = node('span', 'egress-pulse'); pulse.id = 'egress-pulse'; pulse.setAttribute('aria-hidden', 'true');
    const statusText = node('div', 'egress-status-text');
    const statusTitle = node('strong', '', '已暂停'); statusTitle.id = 'egress-status-title';
    const statusSub = node('span', 'muted', '每 10 秒检查一次 · 连续两次异常才告警'); statusSub.id = 'egress-status-sub';
    statusText.append(statusTitle, statusSub); status.append(pulse, statusText);
    const actions = node('div', 'egress-actions');
    const toggle = button('开启监控', async () => {
      if (!snapshot || saving) return;
      if (!snapshot.config.enabled) { await save(true); return; }
      // 暂停不验证未保存的草稿；无效输入不能阻止用户停止后台请求。
      saving = true; toggle.disabled = true;
      try { receive(await api.saveEgress({ ...snapshot.config, enabled: false })); message(dirty ? '监控已暂停，未保存的修改仍保留。' : '监控已暂停。'); }
      catch { message('暂停失败，请重试。', true); }
      finally { saving = false; render(); }
    }, 'btn btn-accent'); toggle.id = 'egress-toggle'; toggle.setAttribute('role', 'switch');
    const check = button('立即检测', async () => { check.disabled = true; try { receive(await api.checkEgress()); message('本轮检测已完成；手动检测同样间隔至少 5 秒。'); } catch { message('检测失败，请稍后重试。', true); } finally { check.disabled = Boolean(snapshot?.checking); } }); check.id = 'egress-check';
    check.prepend(iconNode('refresh'));
    const notify = node('input'); notify.type = 'checkbox'; notify.id = 'egress-notifications'; notify.addEventListener('change', markDirty);
    const intel = node('input'); intel.type = 'checkbox'; intel.id = 'egress-intel'; intel.addEventListener('change', markDirty);
    const intelLabel = toggleField('查询 IP 数据库', intel); intelLabel.title = t('出口 IP 变了时，发给 proxycheck.io、ip-api.com、ipinfo.io、ipapi.is 查询归属和风险；同一个 IP 12 小时内只查一次。');
    // 0.3.16：检测间隔自己定，5 到 60 秒
    const interval = node('input'); interval.type = 'number'; interval.id = 'egress-interval'; interval.min = '5'; interval.max = '60'; interval.step = '1'; interval.inputMode = 'numeric';
    interval.setAttribute('aria-label', '检测间隔（秒）'); interval.addEventListener('input', markDirty);
    const intervalLabel = node('label', 'egress-interval'); intervalLabel.title = t('每隔多少秒自动检测一轮：最少 5 秒，最多 60 秒，默认 10 秒。');
    intervalLabel.append(node('span', '', '检测间隔'), interval, node('span', 'muted', '秒'));
    actions.append(intervalLabel, toggleField('系统通知', notify), intelLabel, check, toggle);
    toolbar.append(status, actions);

    const note = node('p', 'egress-explanation', '只验证所选域名经 TokenPulse 的 curl 和环境代理的出口，不代表全部分流域名或其他程序；不读取账号凭证，也不调用模型或额度接口。收进托盘后继续监控，退出软件即停止。');

    /* ---- 三家卡片 ---- */
    const grid = node('div', 'egress-grid');
    for (const provider of data.providers) {
      const card = node('article', 'panel egress-card'); card.dataset.provider = provider.provider;
      const head = node('div', 'egress-card-head');
      const logo = typeof avatar === 'function' ? avatar(provider.provider) : node('span');
      const titles = node('div', 'egress-card-title');
      const name = node('h2', '', provider.name), hostLine = node('span', 'egress-host muted');
      titles.append(name, hostLine);
      const badge = node('span', 'badge');
      head.append(logo, titles, badge);

      // 出口本身
      const hero = node('div', 'egress-hero');
      const flag = node('span', 'egress-flag'); flag.setAttribute('aria-hidden', 'true');
      const ipBox = node('div', 'egress-ip-box');
      const ipLine = node('div', 'egress-ip-line');
      const ip = node('p', 'egress-ip', '—'); ip.setAttribute('translate', 'no');
      const copyIp = button('', async () => { const value = ip.textContent; if (!value || value === '—') return; try { await api.copyText(value); message('出口 IP 已复制。'); } catch { message('复制失败。', true); } }, 'egress-icon-btn');
      copyIp.append(iconNode('copy')); copyIp.title = t('复制 IP'); copyIp.setAttribute('aria-label', t('复制 IP'));
      ipLine.append(ip, copyIp);
      const place = node('p', 'egress-place', '地区未知');
      ipBox.append(ipLine, place);
      hero.append(flag, ipBox);
      const chips = node('div', 'egress-chips');

      // 归属
      const facts = node('dl', 'egress-facts');
      // 数据库评分
      const intelBox = node('section', 'egress-intel');
      const intelHead = node('div', 'egress-section-head');
      const refresh = button('重新查询', async () => {
        const row = snapshot?.providers.find(p => p.provider === provider.provider)?.row, value = row?.ip || row?.lastGood?.ip;
        if (!value) return;
        refresh.disabled = true;
        try { receive(await api.refreshEgressIntel(value)); } catch (e) { message(String(e.message || '查询失败。').replace(/^Error invoking remote method '[^']+': Error: /, ''), true); }
        finally { refresh.disabled = false; }
      }, 'text-btn egress-refresh');
      intelHead.append(node('h3', '', 'IP 数据库'), refresh);
      const sources = node('div', 'egress-sources');
      intelBox.append(intelHead, sources);

      const reason = node('p', 'egress-reason'); reason.setAttribute('role', 'status');

      // 设置（折叠）
      const settings = node('details', 'egress-settings');
      const summary = node('summary'); const summaryText = node('span', '', '白名单与检测设置'), summaryState = node('span', 'egress-settings-state muted');
      summary.append(iconNode('chevron'), summaryText, summaryState); settings.append(summary);
      const body = node('div', 'egress-settings-body');
      const host = node('select'); host.id = `egress-host-${provider.provider}`; for (const h of provider.hosts) { const opt = node('option', '', h); opt.value = h; host.append(opt); } host.addEventListener('change', () => { markDirty(); render(); });
      const ips = node('textarea'); ips.id = `egress-ips-${provider.provider}`; ips.rows = 3; ips.maxLength = 4096; ips.placeholder = t('允许的 IPv4 / IPv6，每行一个'); ips.spellcheck = false; ips.addEventListener('input', markDirty);
      const regions = node('input'); regions.id = `egress-regions-${provider.provider}`; regions.type = 'text'; regions.maxLength = 256; regions.placeholder = 'US, JP'; regions.spellcheck = false; regions.addEventListener('input', markDirty);
      const useIp = button('加入当前 IP', () => { const latest = snapshot.providers.find(p => p.provider === provider.provider); if (!latest.row?.ip || latest.row.error || latest.row.host !== host.value || Date.now() - latest.row.checkedAt > 15000) return; ips.value = [...new Set([...split(ips.value), latest.row.ip])].join('\n'); markDirty(); }); useIp.dataset.action = 'allow-current';
      useIp.prepend(iconNode('plus'));
      const ipField = field('允许的出口 IP', ips); ipField.append(useIp);
      const official = node('p', 'egress-policy');
      const source = node('a', 'text-btn', '官方地区说明'); source.href = provider.policy.source; source.target = '_blank'; source.rel = 'noreferrer';
      const rules = node('details', 'egress-rules'); rules.append(node('summary', '', '分流规则参考'));
      const content = node('div', 'egress-rules-content'); content.append(node('p', 'muted', provider.provider === 'grok' ? 'Grok 为已验证官方域名的最小集合，不是完整分流清单。' : '用户提供的分流规则；部分共享域名也服务于其他网站。'));
      const pre = node('pre', '', provider.rules.join('\n')); const copy = button('复制分流规则', async () => { try { await api.copyText(provider.rules.join('\n')); message('分流规则已复制。'); } catch { message('复制失败。', true); } }); content.append(pre, copy); rules.append(content);
      body.append(field('检测域名', host), ipField, field('自定义允许地区（可选）', regions), node('p', 'muted egress-hint', '地区使用两位代码；留空时仅使用已核实的官方规则。'), official, source, rules);
      settings.append(body);

      const stamp = node('p', 'egress-stamp');
      card.append(head, hero, chips, reason, facts, intelBox, settings, stamp);
      controls.set(provider.provider, { card, badge, hostLine, flag, ip, copyIp, place, chips, facts, sources, refresh, reason, summaryState, official, stamp, host, ips, regions, useIp });
      grid.append(card);
    }

    const saveBar = node('div', 'egress-savebar'), saveButton = button('保存设置', () => save(), 'btn btn-accent'); saveButton.id = 'egress-save'; const statusLine = node('p', '', '设置保存在本机。'); statusLine.id = 'egress-message'; statusLine.setAttribute('role', 'status'); saveBar.append(saveButton, statusLine);
    const history = node('section', 'panel egress-history'), historyHead = node('div', 'egress-section-head');
    const historyTitle = node('div'); historyTitle.append(node('h2', '', '变化与告警'), node('p', 'muted', '仅保留最近 50 条变化记录和告警，不保存每轮采样。'));
    historyHead.append(historyTitle, button('清空记录', async () => { try { receive(await api.clearEgressHistory()); message('监控历史已清空。'); } catch { message('清空记录失败。', true); } }));
    const list = node('ol'); list.id = 'egress-events'; history.append(historyHead, list);
    root.replaceChildren(toolbar, note, grid, saveBar, history); built = true; syncInputs();
  }

  function syncInputs() {
    if (!snapshot || !built) return;
    for (const p of keys) { const c = controls.get(p), s = snapshot.config.providers[p]; c.host.value = s.host; c.ips.value = s.allowedIps.join('\n'); c.regions.value = s.allowedRegions.join(', '); }
    document.getElementById('egress-notifications').checked = snapshot.config.notifications;
    document.getElementById('egress-intel').checked = snapshot.config.ipIntel !== false;
    document.getElementById('egress-interval').value = String(snapshot.config.intervalSeconds ?? 10);
    dirty = false;
  }
  async function save(enabled = snapshot?.config.enabled) {
    if (saving || !snapshot) return;
    const next = { enabled, notifications: document.getElementById('egress-notifications').checked, ipIntel: document.getElementById('egress-intel').checked, intervalSeconds: Number(document.getElementById('egress-interval').value.trim() || NaN), providers: {} };
    for (const p of keys) { const c = controls.get(p); next.providers[p] = { host: c.host.value, allowedIps: split(c.ips.value), allowedRegions: split(c.regions.value) }; }
    saving = true; root.querySelectorAll('input,select,textarea,button').forEach(n => n.disabled = true);
    try { snapshot = await api.saveEgress(next); syncInputs(); message('设置已保存。'); } catch (e) { message(String(e.message || '保存失败。').replace(/^Error invoking remote method '[^']+': Error: /, ''), true); }
    finally { saving = false; root.querySelectorAll('input,select,textarea,button').forEach(n => n.disabled = false); render(); }
  }
  function receive(data) { snapshot = data; updateBadge(); if (!root.hidden) { if (!built) make(data); render(); } }
  function updateBadge() {
    if (!snapshot) return;
    const count = snapshot.config.enabled ? snapshot.providers.filter(p => p.row?.confirmed && p.row.reasons.length > 0).length : 0;
    const badge = document.getElementById('nav-egress-alert'); badge.hidden = !count; badge.textContent = String(count); badge.title = t('出口监控存在告警');
  }

  function chip(text, tone = '', title = '') { const n = node('span', `egress-chip ${tone}`.trim(), text); if (title) n.title = title; return n; }
  /** 一行数据库结果：名字（链到它自己的查询页）+ 风险条或标记。 */
  function sourceRow(source) {
    const row = node('div', 'egress-source' + (source.ok ? '' : ' failed'));
    const nameCell = source.url ? node('a', 'egress-source-name', source.name) : node('span', 'egress-source-name', source.name);
    if (source.url) { nameCell.href = source.url; nameCell.target = '_blank'; nameCell.rel = 'noreferrer'; nameCell.title = t('在浏览器里查看'); }
    const value = node('div', 'egress-source-value');
    if (!source.ok) value.append(node('span', 'muted', source.error === 'network' ? '查询失败' : '暂无数据'));
    else {
      if (source.risk != null) {
        const level = riskLevel(source.risk);
        const meter = node('span', `egress-meter ${level}`); meter.setAttribute('role', 'meter'); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', String(source.risk));
        const fill = node('i'); fill.style.width = `${Math.max(3, source.risk)}%`; meter.append(fill);
        value.append(meter, node('b', `egress-risk ${level}`, String(source.risk)), node('span', `egress-risk-label ${level}`, RISK_LABEL[level]));
      }
      const f = source.flags || {};
      const marks = [];
      if (f.vpn) marks.push(chip('VPN', 'warn')); if (f.proxy) marks.push(chip('代理', 'warn')); if (f.tor) marks.push(chip('Tor', 'bad'));
      if (f.hosting === true) marks.push(chip('机房', 'warn')); if (f.mobile) marks.push(chip('移动网络', 'info')); if (f.anycast) marks.push(chip('Anycast', 'info'));
      // 明确说「不是」的也写出来：「非代理」比什么都不写更有信息量
      if (source.risk == null && !marks.length) {
        const clean = [f.proxy === false && '非代理', f.vpn === false && '非 VPN', f.hosting === false && '非机房', f.mobile === false && '非移动'].filter(Boolean);
        for (const text of clean) marks.push(chip(text, 'good'));
      }
      value.append(...marks);
      // 连接类型（proxycheck 的 Business 等）已经汇总在上面的线路类型标签里，这里不再重复，免得一行挤成两行
      if (source.note && !marks.length && source.risk == null) value.append(node('span', 'egress-source-note', source.note));
    }
    row.append(nameCell, value);
    return row;
  }

  function render() {
    if (!built || !snapshot || root.hidden) return;
    const on = snapshot.config.enabled;
    const toggle = document.getElementById('egress-toggle'); toggle.textContent = t(on ? '暂停监控' : '开启监控'); toggle.setAttribute('aria-checked', String(on)); toggle.disabled = saving;
    toggle.classList.toggle('btn-accent', !on);
    const check = document.getElementById('egress-check'); check.disabled = saving || snapshot.checking;
    check.lastChild.textContent = t(snapshot.checking ? '检测中…' : '立即检测');
    const alerts = snapshot.providers.filter(p => p.row?.confirmed && p.row.reasons.length).length;
    document.getElementById('egress-pulse').className = 'egress-pulse ' + (!on ? 'off' : alerts ? 'bad' : 'live');
    document.getElementById('egress-status-title').textContent = t(!on ? '监控已暂停' : alerts ? `${alerts} 家出口异常` : '监控中');
    const last = Math.max(0, ...snapshot.providers.map(p => p.row?.checkedAt || 0));
    const seconds = Math.round((snapshot.intervalMs || 10000) / 1000);
    document.getElementById('egress-status-sub').textContent = on ? `${t(`每 ${seconds} 秒检查一次`)} · ${t('上次检测')} ${clock(last || null)}` : t(`开启后每 ${seconds} 秒检查一次，连续两次异常才告警`);
    const intelMap = snapshot.intel || {}, loading = new Set(snapshot.intelLoading || []);

    for (const p of snapshot.providers) {
      const c = controls.get(p.provider), row = p.row;
      c.badge.textContent = t(!on ? '已暂停' : !row ? '等待检测' : row.status === 'ok' ? 'IP 已匹配' : row.status === 'unconfigured' ? '未设置白名单' : row.status === 'unknown' ? '无法验证' : row.confirmed ? '风险已确认' : '风险待确认');
      c.badge.className = 'badge ' + (!on ? '' : row?.status === 'warning' ? 'critical' : row?.status === 'ok' ? 'good' : row?.status === 'unknown' ? 'warning' : '');
      c.hostLine.textContent = `${p.host}${row && !row.error ? ` · ${row.latencyMs} ms` : ''}`;
      // 检测失败时显示上次有效出口，但标成灰色
      const shown = row?.error ? row.lastGood : row;
      const ipText = row?.error ? '—' : row?.ip || '—';
      if (c.ip.textContent !== ipText) { const old = c.ip.textContent; c.ip.textContent = ipText; if (old !== '—' && ipText !== '—' && !matchMedia('(prefers-reduced-motion: reduce)').matches) { c.ip.getAnimations().forEach(a => a.cancel()); c.ip.animate([{ opacity: .45 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' }); } }
      c.copyIp.hidden = ipText === '—';
      const intel = shown?.ip ? intelMap[shown.ip] : undefined;
      const region = row?.error ? undefined : row?.region;
      c.flag.textContent = flagOf(region) || '🌐';
      c.flag.classList.toggle('empty', !flagOf(region));
      const cityBits = intel && intel.countryCode === region ? [intel.region, intel.city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i) : [];
      c.place.textContent = row?.error ? `${errorText(row.error)}${row.lastGood ? ` · ${t('上次有效出口')} ${row.lastGood.ip}` : ''}` : region ? [countryName(region), ...cityBits].join(' · ') : t('地区未知');
      c.place.classList.toggle('error', Boolean(row?.error));

      // 标签：ASN、线路类型、综合风险、官方地区
      const chips = [];
      if (intel?.asn) chips.push(chip(intel.asn, 'mono', intel.asName || intel.org || ''));
      if (intel) chips.push(chip(TYPE_LABEL[intel.type] || TYPE_LABEL.unknown, TYPE_TONE[intel.type] || '', t('按 IP 数据库判断的线路类型')));
      const risks = intel?.sources.filter(s => s.ok && s.risk != null).map(s => s.risk) || [];
      if (risks.length) { const worst = Math.max(...risks), level = riskLevel(worst); chips.push(chip(`${t('风险')} ${worst}`, level === 'low' ? 'good' : level === 'medium' ? 'warn' : 'bad', t('几个数据库里最高的风险分（0–100）'))); }
      if (row && !row.error) chips.push(chip(({ supported: '官方支持地区', unsupported: '不在官方支持清单', partial: '国内部分地区受限', unknown: '地区规则未核实' })[row.regionStatus], ({ supported: 'good', unsupported: 'bad', partial: 'warn', unknown: '' })[row.regionStatus]));
      if (intel?.countryCode && region && intel.countryCode !== region) chips.push(chip(`${t('数据库记为')} ${intel.countryCode}`, 'warn', t('IP 数据库记录的国家和目标站点看到的不一样，常见于刚分配或广播的地址')));
      c.chips.replaceChildren(...chips);

      const reasons = (row?.reasons || []).map(r => t(({ ip_mismatch: 'IP 不在允许列表内', unsupported_region: '地区不在官方支持清单内', partial_region: '该国家存在地区限制，需进一步确认', region_mismatch: '地区不在自定义允许列表内', region_unknown: '地区未知或规则已过期，无法确认', probe_failed: '本轮检测失败，不代表已切换地区' })[r]));
      c.reason.replaceChildren(...(reasons.length ? [iconNode('alert'), node('span', '', reasons.join(' · '))] : []));
      c.reason.hidden = !reasons.length;
      c.reason.classList.toggle('confirmed', Boolean(row?.confirmed));

      // 归属
      const facts = [['运营商', intel?.isp], ['组织', intel?.org && intel.org !== intel.isp ? intel.org : undefined], ['ASN 名称', intel?.asName && intel.asName !== intel.org ? intel.asName : undefined], ['反查域名', intel?.hostname]].filter(([, v]) => v);
      c.facts.replaceChildren(...facts.flatMap(([k, v]) => { const dd = node('dd', '', v); dd.title = v; dd.setAttribute('translate', 'no'); return [node('dt', '', k), dd]; }));
      c.facts.hidden = !facts.length;

      // 数据库
      const ipForIntel = shown?.ip;
      if (snapshot.config.ipIntel === false && !intel) c.sources.replaceChildren(node('p', 'muted egress-sources-note', '已关闭 IP 数据库查询。可以在上方打开，或点「重新查询」查一次。'));
      else if (!ipForIntel) c.sources.replaceChildren(node('p', 'muted egress-sources-note', on ? '检测到出口 IP 后查询。' : '开启监控或点「立即检测」后查询。'));
      else if (!intel) c.sources.replaceChildren(node('p', 'muted egress-sources-note egress-loading', loading.has(ipForIntel) ? '正在查询 IP 数据库…' : '暂无数据库结果。'));
      else c.sources.replaceChildren(...intel.sources.map(sourceRow), node('p', 'muted egress-sources-note', `${loading.has(ipForIntel) ? t('正在重新查询…') : `${t('查询于')} ${time(intel.fetchedAt)}`} · ${t('结果缓存 12 小时')}`));
      c.refresh.hidden = !ipForIntel;
      c.refresh.disabled = loading.has(ipForIntel);

      const allowed = snapshot.config.providers[p.provider].allowedIps.length;
      c.summaryState.textContent = allowed ? `${allowed} ${t('个允许的 IP')}` : t('未设置');
      c.useIp.disabled = saving || !row?.ip || Boolean(row.error) || row.host !== c.host.value || Date.now() - row.checkedAt > 15000;
      c.official.textContent = t(row?.regionStatus === 'supported' ? '国家在已核实的官方清单内，不保证具体账号可用。' : row?.regionStatus === 'unsupported' ? '国家不在已核实的官方清单内。' : row?.regionStatus === 'partial' ? '国家内存在地区限制，IP 国家代码不足以判断。' : '官方地区规则未核实、已过期或地区未知；不会据此判定支持。') + (p.policy.checkedAt ? ` ${t('核实日期')}：${p.policy.checkedAt}` : '') + (!p.allowedRegions.length && p.policy.status !== 'verified' ? ' ' + t('可先设置自定义允许地区。') : '');
      c.stamp.textContent = `${t('检测时间')}：${time(row?.checkedAt)}`;
    }
    if (snapshot.configError) message(snapshot.configError, true);
    else if (snapshot.storageError) message('历史写入失败，当前结果仍可查看。', true);
    const key = JSON.stringify(snapshot.events);
    if (historyKey !== key) {
      historyKey = key; const list = document.getElementById('egress-events');
      list.replaceChildren(...snapshot.events.map(event => {
        const li = node('li', 'egress-event ' + event.type);
        const dot = node('span', 'egress-event-dot'); dot.setAttribute('aria-hidden', 'true');
        const main = node('div', 'egress-event-main'), title = node('div', 'egress-event-title');
        title.append(node('strong', '', `${snapshot.providers.find(p => p.provider === event.provider)?.name || event.provider} · ${t(event.message)}`), node('time', '', time(event.at)));
        const detail = node('p', 'muted'); detail.setAttribute('translate', 'no');
        detail.textContent = `${flagOf(event.region) ? flagOf(event.region) + ' ' : ''}${event.host}${event.previousIp ? ' · ' + event.previousIp + ' → ' : ' · '}${event.ip || '—'}${event.region ? ' · ' + regionText(event.region) : ''}`;
        main.append(title, detail); li.append(dot, main); return li;
      }));
      if (!snapshot.events.length) list.append(node('li', 'muted egress-empty', '暂无变化或告警。'));
    }
  }
  let loading;
  window.PulseEgress = { show() { if (snapshot) { if (!built) make(snapshot); render(); } if (!loading) { loading = api.egressState().then(receive).catch(() => { if (!built) root.textContent = t('监控状态读取失败，请重新打开此页。'); else message('监控状态读取失败，请重新打开此页。', true); }).finally(() => { loading = null; }); } } };
  api.onEgressState(receive);
  api.egressState().then(receive).catch(() => {});
})();
