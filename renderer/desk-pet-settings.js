/*
 * 「桌宠」页（0.3.61）：打开 / 关闭桌宠、选宠物（三只内置 + 导入的自定义宠物）、大小透明度这些外观、额度跟哪个账号。
 * 设置照常存进 prefs.json（api.writePrefs），主进程的 applyPrefs 落实到宠物窗口（src/main/desk-pet.ts）。
 * 预览用的是和桌宠窗口同一份像素画（pet-engine.js），状态取桌宠现在的（剩余额度、在不在干活）。
 * 用到 app.js 里的公共函数（el / icon / $ / api / toast / optionSelect），所以要在它后面加载。
 */
(function () {
  const Pet = window.PulsePet;
  const pet = api.deskPet;
  // 带数字、名字的句子按语言直接拼好（节点标 translate=no）；固定的文字交给 i18n.js 的词典
  const EN = window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => EN ? en : zh;
  const T = text => (EN && window.PulseI18n?.t ? window.PulseI18n.t(text) : text);
  const BUILT_IN = [
    { id: 'squirrel', name: '松鼠 · 栗栗', line: '额度是身边的橡果堆，干活时侧过身来回搬橡果。' },
    { id: 'hamster', name: '仓鼠 · 豆豆', line: '腮帮子越鼓额度越多，干活时在跑轮里冲刺。' },
    { id: 'octopus', name: '章鱼 · 墨墨', line: '身体颜色表示额度，每条举起的触手抱着一个任务。' },
  ];
  const S = { prefs: null, packs: [], accounts: [], view: null, visible: false, images: {} };
  const N = {};
  let built = false, frameTimer = 0, statusTimer = 0;
  let previews = [];

  function build() {
    if (built) return;
    built = true;
    N.hero = el('div', { class: 'panel dps-hero' });
    N.choices = el('div', { class: 'dps-choices', role: 'group', 'aria-label': '选一只宠物' });
    N.options = el('div', { class: 'dps-options' });
    N.about = el('div', { class: 'panel dps-about' });
    $('page-pet').replaceChildren(
      N.hero,
      el('section', { class: 'panel dps-section' }, [el('h2', { class: 'dps-title', text: '选一只' }), N.choices]),
      el('section', { class: 'panel dps-section' }, [el('h2', { class: 'dps-title', text: '外观和行为' }), N.options]),
      N.about,
    );
    about();
  }

  function ctx() {
    const v = S.view;
    return { state: v?.mode || 'idle', quota: v?.quota ?? 72, mood: v?.mood || 'ok', tasks: v?.tasks || 0, fidget: S.prefs?.deskPetFidget !== false };
  }

  /** 一块会动的预览。内置宠物画在 canvas 上；自定义宠物显示它的 idle 图。 */
  function preview(kind, scale) {
    if (!BUILT_IN.some(item => item.id === kind)) {
      const image = el('img', { class: 'dps-custom-img', alt: '' });
      image.style.width = Pet.W * scale + 'px'; image.style.height = Pet.H * scale + 'px';
      const show = images => { if (images?.idle) image.src = images.idle; };
      if (S.images[kind]) show(S.images[kind]);
      else pet.packImages(kind).then(data => { S.images[kind] = data?.images || null; show(S.images[kind]); }).catch(() => undefined);
      return image;
    }
    const canvas = el('canvas', { class: 'dps-canvas', 'aria-hidden': 'true' });
    const pixel = Math.max(1, Math.round(scale * (window.devicePixelRatio || 1)));
    canvas.width = Pet.W * pixel; canvas.height = Pet.H * pixel;
    canvas.style.width = Pet.W * scale + 'px'; canvas.style.height = Pet.H * scale + 'px';
    const item = { canvas, pixel, ctl: new Pet.Controller(kind) };
    previews.push(item);
    Pet.paint(canvas, item.ctl.frame(ctx()), pixel);
    return canvas;
  }

  function statusText() {
    if (!S.prefs.deskPet) return L('桌宠没有打开。打开后它会出现在屏幕右下角，可以拖到任何地方。', 'The desk pet is off. Turn it on and it appears in the bottom-right corner; drag it anywhere.');
    const v = S.view;
    if (!v) return L('桌宠已打开。', 'The desk pet is on.');
    const doing = v.mode === 'work' ? L(`${v.tasks} 个任务进行中`, `${v.tasks} task${v.tasks === 1 ? '' : 's'} running`) : v.mode === 'sleep' ? L('在睡觉', 'Sleeping') : L('没有任务在跑', 'No tasks running');
    const quota = v.quota == null ? L('还没有额度数据', 'No quota data yet') : `${v.account ? v.account + ' ' : ''}${L(`剩余 ${v.quota}%`, `${v.quota}% left`)}`;
    return `${doing} · ${quota}`;
  }

  function hero() {
    const on = !!S.prefs.deskPet;
    const toggle = el('button', { type: 'button', id: 'dps-toggle', class: 'dps-switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), 'aria-label': '在桌面上显示桌宠' }, [el('span', { class: 'dps-knob' })]);
    toggle.addEventListener('click', () => save({ deskPet: !on }));
    const reset = el('button', { type: 'button', class: 'btn', id: 'dps-reset', disabled: on ? null : '' }, [icon('refresh'), el('span', { text: '放回屏幕右下角' })]);
    reset.addEventListener('click', async () => { await pet.resetPosition(); toast('已把桌宠放回屏幕右下角'); });
    N.status = el('p', { class: 'dps-status', id: 'dps-status', translate: 'no', text: statusText() });
    N.hero.replaceChildren(
      el('div', { class: 'dps-stage' }, [preview(S.prefs.deskPetKind, 3)]),
      el('div', { class: 'dps-hero-text' }, [
        el('div', { class: 'dps-toggle-row' }, [el('b', { text: '在桌面上显示桌宠' }), toggle]),
        N.status,
        el('p', { class: 'setting-hint', text: '点一下宠物，它会冒出一个对话气泡，告诉你正在用的账号还剩多少额度；按住可以拖到别处；右键可以查看任务和更多选项。宠物身边透明的地方不挡鼠标，点下去落到后面的窗口。' }),
        el('div', { class: 'dps-actions' }, [reset]),
      ]),
    );
  }

  function choiceCard(id, name, line, on, extra = []) {
    const card = el('div', { class: 'dps-choice' + (on ? ' on' : ''), 'data-kind': id });
    const pick = el('button', { type: 'button', class: 'dps-pick', 'aria-pressed': String(on), 'aria-label': L(`选择${name}`, `Choose ${T(name)}`), translate: 'no' });
    pick.addEventListener('click', () => { if (!on) save({ deskPetKind: id }); });
    // append() 会把 null 写成文字「null」，先滤掉
    card.append(...[
      el('div', { class: 'dps-choice-stage' }, [preview(id, 2)]),
      el('div', { class: 'dps-choice-text' }, [
        el('b', { text: name, translate: BUILT_IN.some(item => item.id === id) ? null : 'no' }),
        el('small', { text: line, translate: BUILT_IN.some(item => item.id === id) ? null : 'no' }),
      ]),
      on ? el('span', { class: 'dps-chip', text: '正在用' }) : null,
      ...extra,
      pick,
    ].filter(Boolean));
    return card;
  }

  function choices() {
    const current = S.prefs.deskPetKind;
    const custom = S.packs.map(pack => {
      const remove = el('button', { type: 'button', class: 'text-btn dps-remove', 'data-remove': pack.id, text: '删除' });
      remove.addEventListener('click', event => {
        event.stopPropagation();
        // 点两下才删：第一下变成「再点一次删除」，3 秒没点就复原
        if (!remove.classList.contains('armed')) {
          remove.classList.add('armed'); remove.textContent = '再点一次删除';
          setTimeout(() => { if (remove.isConnected) { remove.classList.remove('armed'); remove.textContent = '删除'; } }, 3000);
          return;
        }
        pet.removePack(pack.id).then(packs => { S.packs = packs; delete S.images[pack.id]; return load(); }).catch(() => toast('删除失败，请检查数据目录权限', { kind: 'warning' }));
      });
      return choiceCard(pack.id, pack.name, pack.author ? `作者：${pack.author}` : '自己导入的宠物', current === pack.id, [remove]);
    });
    const add = el('button', { type: 'button', class: 'dps-choice dps-add', id: 'dps-import' }, [
      icon('plus'), el('b', { text: '导入自己的宠物' }), el('small', { text: '选一个放着 pet.json 和图片的文件夹' }),
    ]);
    add.addEventListener('click', importPack);
    N.choices.replaceChildren(...BUILT_IN.map(item => choiceCard(item.id, item.name, item.line, current === item.id)), ...custom, add);
  }

  function row(id, title, hint, value, options, onChange) {
    return el('div', { class: 'setting-block' }, [
      el('div', { class: 'setting-title', text: title }),
      el('p', { class: 'setting-hint', text: hint }),
      optionSelect({ id, label: title, value, options, onChange }),
    ]);
  }

  function options() {
    const p = S.prefs;
    const accounts = [{ value: '', label: '跟着正在用的账号', hint: '默认。有任务在跑的工具当前登录的账号；没有任务时用最近用过的' }, ...S.accounts.map(item => ({ value: item.id, label: item.name }))];
    if (p.deskPetAccount && !S.accounts.some(item => item.id === p.deskPetAccount)) accounts.push({ value: p.deskPetAccount, label: '已选的账号（现在没有额度数据）' });
    N.options.replaceChildren(
      row('dps-scale', '大小', '像素按整数倍放大，放大后依然清晰。', p.deskPetScale, [
        { value: 1, label: '小', hint: '72 × 56' }, { value: 2, label: '中', hint: '默认，144 × 112' }, { value: 3, label: '大', hint: '216 × 168' }], value => save({ deskPetScale: value })),
      row('dps-opacity', '不透明度', '半透明一点就没那么抢眼。悬停提示和对话气泡不受影响。', p.deskPetOpacity, [
        { value: 100, label: '不透明', hint: '默认' }, { value: 85, label: '85%' }, { value: 70, label: '70%' }, { value: 50, label: '50%' }], value => save({ deskPetOpacity: value })),
      row('dps-ontop', '窗口层级', '总在最前时，桌宠会显示在其他窗口上面。', p.deskPetOnTop, [
        { value: true, label: '总在最前', hint: '默认' }, { value: false, label: '和普通窗口一样', hint: '会被别的窗口挡住' }], value => save({ deskPetOnTop: value })),
      row('dps-account', '额度跟哪个账号', '宠物表现的剩余额度取这个账号的 5 小时和周窗口里用得多的那一个，点宠物冒出的气泡里也显示这个账号。', p.deskPetAccount, accounts, value => save({ deskPetAccount: value })),
      row('dps-fidget', '空闲时', '没有任务在跑时，每隔二三十秒随机做一个小动作。', p.deskPetFidget, [
        { value: true, label: '偶尔做小动作', hint: '默认' }, { value: false, label: '安静待着' }], value => save({ deskPetFidget: value })),
      row('dps-badge', '自定义宠物的额度标签', '自己导入的宠物画不出额度，在它右下角显示剩余百分比和任务数。只对自定义宠物有效。', p.deskPetBadge, [
        { value: true, label: '显示', hint: '默认' }, { value: false, label: '不显示' }], value => save({ deskPetBadge: value })),
    );
  }

  function about() {
    const example = '{\n  "name": "我的猫",\n  "author": "可选",\n  "states": {\n    "idle": "idle.gif",\n    "work": "work.gif",\n    "sleep": "sleep.png",\n    "celebrate": "happy.gif"\n  }\n}';
    N.about.replaceChildren(
      el('h2', { class: 'dps-title', text: '它会怎么表现' }),
      el('ul', { class: 'dps-list' }, [
        el('li', { text: '剩余额度：松鼠看身边的橡果堆，仓鼠看腮帮子，章鱼看身体颜色。额度紧张时皱着眉，隔一阵冒一下汗；用完会发呆；额度重置时补满一下。' }),
        el('li', { text: '任务：本机的 Claude Code 或 Codex 有任务在跑时，宠物开始干活；任务做完会庆祝一下。只读会话文件，不改任何工具的配置。' }),
        el('li', { text: '工具调用 90 秒还没有结果时，任务上写「可能在等你」：可能是在等你确认，也可能只是工具跑得久。' }),
        el('li', { text: '电脑 5 分钟没人用、也没有任务在跑时，它会去睡觉；回来时揉揉眼睛醒过来。' }),
      ]),
      el('details', { class: 'dps-format' }, [
        el('summary', { text: '自定义宠物的格式' }),
        el('p', { class: 'setting-hint', text: '准备一个文件夹，放一个 pet.json 和各个状态的图片。只有 idle（空闲）是必须的，缺的状态用 idle 代替。可用的状态：idle 空闲、work 干活、sleep 睡觉、celebrate 庆祝、tight 额度紧张、empty 额度用完、drag 被拖着、startle 受惊。图片支持 PNG、GIF、WebP、JPEG，单张不超过 5 MB、整套不超过 20 MB。导入时复制一份到数据目录，原文件夹之后删改都不影响。' }),
        el('pre', { class: 'dps-code', translate: 'no', text: example }),
      ]),
    );
  }

  function render() {
    if (!S.prefs) return;
    previews = [];
    hero(); choices(); options();
  }

  async function save(patch) {
    try { S.prefs = await api.writePrefs(patch); S.view = (await pet.status())?.view || S.view; render(); return true; }
    catch { toast('保存失败，请检查数据目录权限', { kind: 'warning' }); return false; }
  }

  async function importPack() {
    let result;
    try { result = await pet.importPack(); } catch { toast('演示模式下不能导入', { kind: 'warning' }); return; }
    if (!result || result.canceled) return;
    if (!result.ok) { toast(result.error || '导入失败', { kind: 'warning' }); return; }
    S.packs = result.packs;
    toast(L(`已导入「${result.pack.name}」`, `Imported “${result.pack.name}”`));
    await save({ deskPetKind: result.pack.id });
  }

  async function load() {
    const [prefs, packs, accounts, status] = await Promise.all([api.readPrefs(), pet.packs(), pet.accounts(), pet.status()]);
    S.prefs = prefs; S.packs = packs || []; S.accounts = accounts || []; S.view = status?.view || null;
    render();
  }

  function tick() {
    if (!S.visible || document.hidden) return;
    const context = ctx();
    for (const item of previews) {
      if (!item.canvas.isConnected) continue;
      item.ctl.tick(context);
      Pet.paint(item.canvas, item.ctl.frame(context), item.pixel);
    }
  }

  function show() {
    build();
    S.visible = true;
    load().catch(() => toast('桌宠设置读取失败', { kind: 'warning' }));
    clearInterval(frameTimer); clearInterval(statusTimer);
    frameTimer = setInterval(tick, 100);
    // 宠物现在的样子（剩余额度、在不在干活）每 4 秒跟一次，只改状态那一行
    statusTimer = setInterval(async () => {
      if (!S.visible || document.hidden || !S.prefs) return;
      try { S.view = (await pet.status())?.view || S.view; if (N.status) N.status.textContent = statusText(); } catch { /* 下一次再试 */ }
    }, 4000);
  }

  function hide() {
    S.visible = false;
    clearInterval(frameTimer); clearInterval(statusTimer);
    frameTimer = statusTimer = 0;
  }

  // 在宠物的右键菜单里点了「隐藏桌宠」这类：页面开着就重新读一遍
  pet.onChanged(() => { if (S.visible) load().catch(() => undefined); });
  window.PulseDeskPet = { show, hide };
})();
