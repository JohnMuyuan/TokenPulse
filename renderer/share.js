'use strict';
(() => {
  const api = window.tokenpulse?.share;
  if (!api) return;
  const tr = text => window.PulseI18n?.lang() === 'en' ? window.PulseI18n.t(text) : text;
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 本轮仍可使用 */ } };
  let dialog = null, generation = 0, checking = false, checked = 0;
  const button = (text, action, cls = 'btn') => { const node = el('button', { type: 'button', class: cls, text: tr(text) }); node.addEventListener('click', action); return node; };
  const errorText = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  async function open(kind = 'month', pick = '') {
    if (window.tokenpulse.isDemo?.()) { toast(tr('演示模式下请先结束引导，再生成自己的分享卡片。'), { kind: 'warning' }); return; }
    if (dialog) dialog.close();
    const returnTo = document.activeElement;
    const node = el('dialog', { id: 'share-dialog', class: 'share-dialog', 'aria-labelledby': 'share-title' });
    dialog = node;
    const close = button('关闭', () => node.close());
    const status = el('p', { class: 'share-status', role: 'status', text: tr('正在读取…') });
    const controls = el('div', { class: 'share-controls' });
    const preview = el('div', { class: 'share-preview', 'aria-busy': 'true' });
    const collection = el('div', { class: 'share-collection' });
    const tabs = el('div', { class: 'share-tabs', role: 'tablist', 'aria-label': tr('分享卡片') });
    const monthTab = button('月报', () => switchKind('month'));
    const weekTab = button('周报', () => switchKind('week'));
    const medalTab = button('里程碑', () => switchKind('milestone'));
    const reportTabs = [monthTab, weekTab, medalTab];
    for (const tab of reportTabs) tab.setAttribute('role', 'tab');
    tabs.append(...reportTabs);
    const save = button('保存 PNG', () => exportImage('save'), 'btn btn-accent');
    const copy = button('复制图片', () => exportImage('copy'));
    const retry = button('重试', () => refresh()); retry.hidden = true;
    let png = '', data = null, month = '', week = '', id = '', exporting = false;
    const subscription = el('input', { id: 'share-subscription', type: 'number', min: 0, max: 1000000, step: '0.01', value: read('tokenpulse-share-subscription', '') });
    const showNames = el('input', { type: 'checkbox', id: 'share-names' });
    const field = (label, input) => el('label', { class: 'share-field' }, [el('span', { text: tr(label) }), input]);
    node.append(el('header', {}, [el('div', {}, [el('h2', { id: 'share-title', text: tr('分享卡片') }), el('p', { text: tr('先看预览，再保存或复制图片。') })]), close]), tabs, controls, collection, status, preview,
      el('footer', {}, [el('small', { text: tr('API 价值与缓存节省按参考标价估算。') }), retry, copy, save]));
    document.body.append(node);
    const keydown = event => {
      if (event.key === 'Escape') { event.stopPropagation(); node.close(); }
      if (event.target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const index = reportTabs.findIndex(tab => tab === event.target), next = (index + (event.key === 'ArrowRight' ? 1 : -1) + reportTabs.length) % reportTabs.length;
        switchKind(['month', 'week', 'milestone'][next]); reportTabs[next].focus();
      }
    };
    node.addEventListener('keydown', keydown);
    node.addEventListener('click', event => { if (event.target === node) { const r = node.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) node.close(); } });
    node.addEventListener('close', () => { node.remove(); if (dialog === node) { generation++; dialog = null; returnTo?.focus?.(); } }, { once: true });
    node.showModal();
    const setReady = ready => { save.disabled = copy.disabled = !ready || exporting; };
    async function exportImage(action) {
      if (!png || exporting) return;
      exporting = true; setReady(false);
      try {
        const name = kind === 'month' ? `TokenPulse-${month}` : kind === 'week' ? `TokenPulse-week-${week}` : `TokenPulse-${id}`;
        const result = action === 'save' ? await api.save(png, name) : await api.copy(png);
        if (result.saved || result.copied) toast(tr(result.saved ? '分享卡片已保存' : '分享卡片已复制'));
      } catch (error) { toast(tr('导出失败') + ': ' + errorText(error), { kind: 'error' }); }
      finally { exporting = false; if (node.isConnected) setReady(Boolean(png)); }
    }
    async function renderPreview() {
      const token = ++generation;
      png = ''; setReady(false); retry.hidden = true; preview.setAttribute('aria-busy', 'true');
      status.textContent = tr('正在生成预览…');
      try {
        const value = Number(subscription.value);
        if (!Number.isFinite(value) || value < 0 || value > 1000000) throw new Error(tr('订阅费请填 0 到 1000000 之间的数'));
        write('tokenpulse-share-subscription', subscription.value);
        const image = await api.render(kind, data, { id, subscriptionUsd: value, showNames: showNames.checked, lang: window.PulseI18n?.lang() || 'zh' });
        if (!node.isConnected || token !== generation) return;
        png = image;
        preview.replaceChildren(el('img', { src: image, alt: tr(kind === 'month' ? '月报预览' : kind === 'week' ? '周报预览' : '里程碑预览') }));
        status.textContent = tr('预览就是导出的图片。'); setReady(true);
      } catch (error) { if (node.isConnected && token === generation) { status.textContent = errorText(error); preview.replaceChildren(); retry.hidden = false; } }
      finally { if (node.isConnected && token === generation) preview.setAttribute('aria-busy', 'false'); }
    }
    async function refresh() {
      const token = ++generation;
      png = ''; data = null; setReady(false); controls.replaceChildren(); collection.replaceChildren(); retry.hidden = true;
      preview.replaceChildren(); preview.setAttribute('aria-busy', 'true'); status.textContent = tr('正在读取…');
      monthTab.setAttribute('aria-selected', String(kind === 'month')); weekTab.setAttribute('aria-selected', String(kind === 'week')); medalTab.setAttribute('aria-selected', String(kind === 'milestone'));
      try {
        const result = kind === 'month' ? await api.month(month || undefined) : kind === 'week' ? await api.week(week || undefined) : await api.milestones();
        if (!node.isConnected || token !== generation) return;
        if (kind === 'month') {
          data = result.report; month = data?.month || '';
          if (!data) { status.textContent = tr('还没有用量记录，月报会在有用量后出现。'); return; }
          const select = el('select', { id: 'share-month' }, result.months.map(value => el('option', { value, text: value })));
          select.value = month;
          select.addEventListener('change', () => { month = select.value; refresh(); });
          controls.append(field('月份', select), field('订阅费 $/月（可选）', subscription), field('在卡片里显示号池名／供应商名', showNames));
          write('tokenpulse-share-month-seen', month);
        } else if (kind === 'week') {
          data = result.report; week = data?.week || '';
          if (!data) { status.textContent = tr('还没有用量记录，周报会在有用量后出现。'); return; }
          const select = el('select', { id: 'share-week' }, result.weeks.map(item => el('option', { value: item.week, text: item.label })));
          select.value = week;
          select.addEventListener('change', () => { week = select.value; refresh(); });
          controls.append(field('周', select), field('在卡片里显示号池名／供应商名', showNames));
        } else {
          data = result;
          const unlocked = result.list.filter(item => item.achievedAt);
          id = unlocked.some(item => item.id === id) ? id : unlocked.at(-1)?.id || '';
          collection.append(...result.list.map(item => {
            const badge = button(`${item.icon} ${tr(item.label)}`, () => { id = item.id; drawBadges(); renderPreview(); }, 'share-badge');
            badge.disabled = !item.achievedAt;
            badge.dataset.id = item.id; badge.setAttribute('aria-pressed', String(item.id === id));
            badge.title = item.achievedAt || tr('尚未解锁'); return badge;
          }));
          if (!unlocked.length) { status.textContent = tr('还没有达成里程碑，继续积累用量吧。'); return; }
        }
        await renderPreview();
      } catch (error) { if (node.isConnected && token === generation) { status.textContent = errorText(error); retry.hidden = false; } }
      finally { if (node.isConnected && token === generation) preview.setAttribute('aria-busy', 'false'); }
    }
    function drawBadges() { for (const badge of collection.children) badge.setAttribute('aria-pressed', String(badge.dataset.id === id)); }
    function switchKind(next) { kind = next; refresh(); }
    if (kind === 'month') month = pick; else if (kind === 'week') week = pick; else id = pick;
    subscription.addEventListener('change', renderPreview); showNames.addEventListener('change', renderPreview);
    await refresh();
  }

  async function check(snapshot) {
    if (window.tokenpulse.isDemo?.() || checking || !snapshot?.scannedAt || Date.now() - checked < 60000) return;
    checking = true;
    try {
      const state = await api.milestones();
      const ids = state.list.filter(item => item.achievedAt).map(item => item.id);
      const seen = read('tokenpulse-share-milestones', null);
      if (Array.isArray(seen)) {
        const fresh = state.list.filter(item => item.achievedAt && !seen.includes(item.id));
        if (fresh.length) toast(tr('🎉 新里程碑：') + fresh.map(item => tr(item.label)).join(' · '), { key: 'share-milestone', actions: [{ label: tr('生成分享卡'), primary: true, onClick: () => open('milestone', fresh.at(-1).id) }] });
      }
      write('tokenpulse-share-milestones', ids);
      const now = new Date(snapshot.now || Date.now());
      if (now.getDate() <= 7) {
        const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const month = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
        if (read('tokenpulse-share-month-seen', '') !== month) {
          const result = await api.month(month);
          if (result.report?.tokens > 0) {
            write('tokenpulse-share-month-seen', month);
            toast(tr('月报出炉了：') + month, { key: 'share-month', actions: [{ label: tr('生成分享卡'), primary: true, onClick: () => open('month', month) }] });
          }
        }
      }
      checked = Date.now();
    } catch { /* 下次快照再尝试 */ }
    finally { checking = false; }
  }
  document.getElementById('share-open')?.addEventListener('click', () => open());
  window.PulseShare = { open, check };
  if (typeof current !== 'undefined' && current) check(current);
})();
