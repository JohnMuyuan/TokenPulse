'use strict';
/*
 * 问题卡片：Agent 在问你。数据由主进程送来（src/main/desk-pet.ts 的 DeskPetAskData），最新的提问在前面；
 * 这里把最新的摆在最下面，挨着屏幕右下角。每张写着哪个工具、哪个会话、问题和选项（选择题），或者计划的开头（计划等你批准）。
 * 只是给你看：回答还是回到终端里。「知道了」收起这一张，回答了主进程会自己收起。窗口不抢焦点。
 */
(() => {
  const api = window.tokenpulse.deskPet;
  const box = document.getElementById('ak');
  const EN = window.PulseI18n?.lang?.() === 'en';
  const L = (zh, en) => EN ? en : zh;
  const EDGE = 6;
  box.setAttribute('aria-label', L('Agent 在问你', 'An agent is asking you'));
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) { if (value == null) continue; if (key === 'text') node.textContent = value; else node.setAttribute(key, value); }
    node.append(...children.filter(Boolean));
    return node;
  };
  const KIND = { claude: 'claude', codex: 'chatgpt' };
  /** 弹过的提问：只有新来的才播弹出来的动画。 */
  const seen = new Set();

  function questionBlock(q) {
    return el('div', { class: 'ak-q' }, [
      el('p', { class: 'ak-question' }, [q.header ? el('i', { class: 'bb-chip', text: q.header }) : null, el('span', { text: q.question })]),
      q.options.length ? el('ol', { class: 'ak-opts' }, q.options.map((option, i) => el('li', {}, [
        el('i', { text: String(i + 1) }),
        el('div', {}, [el('b', { text: option.label }), option.description ? el('small', { text: option.description }) : null]),
      ]))) : null,
      q.multi ? el('p', { class: 'ak-multi', text: L('可以多选', 'Pick any number') }) : null,
    ]);
  }

  function card(item, fresh) {
    const ask = item.ask, id = `${item.key}|${ask.id}`, plan = ask.tool === 'ExitPlanMode';
    const close = el('button', { type: 'button', class: 'ak-x', title: L('知道了', 'Got it'), 'aria-label': L('知道了', 'Got it'), text: '×' });
    close.addEventListener('click', () => api.askAction('dismiss', id));
    const ok = el('button', { type: 'button', class: 'ak-btn', text: L('知道了', 'Got it') });
    ok.addEventListener('click', () => api.askAction('dismiss', id));
    const say = plan ? L('计划写好了，等你批准', 'A plan is waiting for your approval')
      : ask.questions.length > 1 ? L(`有 ${ask.questions.length} 个问题想问你`, `${ask.questions.length} questions for you`)
      : L('有个问题想问你', 'A question for you');
    const node = el('section', { class: 'ak-card' + (fresh ? ' pop' : ''), 'data-key': id, 'data-tool': ask.tool }, [
      el('div', { class: 'ak-head' }, [
        el('i', { class: 'bb-kind ' + (KIND[item.kind] || '') }),
        el('b', { text: item.agent }),
        el('span', { text: [item.project, item.title].filter(Boolean).join(' · '), title: item.title }),
        close,
      ]),
      el('p', { class: 'ak-say', text: say }),
      ...(plan ? [ask.plan ? el('pre', { class: 'ak-plan', text: ask.plan }) : null] : ask.questions.map(questionBlock)),
      el('div', { class: 'ak-foot' }, [
        el('small', { text: plan ? L('回到终端里批准或修改', 'Approve or edit it in the terminal') : L('回到终端里回答', 'Answer it in the terminal') }),
        ok,
      ]),
    ]);
    return node;
  }

  let last = null;
  function report() { api.askSize(box.offsetWidth + EDGE * 2, box.offsetHeight + EDGE * 2); }
  function draw(data) {
    if (!data) return;
    last = data;
    document.documentElement.dataset.theme = data.theme === 'dark' ? 'dark' : 'light';
    const ids = new Set();
    const cards = [...data.cards].reverse().map(item => {
      const id = `${item.key}|${item.ask.id}`;
      ids.add(id);
      const node = card(item, !seen.has(id));
      seen.add(id);
      return node;
    });
    for (const id of seen) if (!ids.has(id)) seen.delete(id);
    let more = null;
    if (data.more > 0 || data.cards.length > 1) {
      const all = el('button', { type: 'button', class: 'ak-btn', text: L('全部收起', 'Dismiss all') });
      all.addEventListener('click', () => api.askAction('dismiss-all'));
      more = el('p', { class: 'ak-more' }, [el('span', { text: data.more > 0 ? L(`还有 ${data.more} 个提问`, `${data.more} more`) : L(`${data.cards.length} 个提问在等你`, `${data.cards.length} questions waiting`) }), all]);
    }
    box.replaceChildren(...[more, ...cards].filter(Boolean));
    report();
  }

  new ResizeObserver(() => { if (last) report(); }).observe(box);
  api.onAsk(draw);
  api.askData().then(draw).catch(() => undefined);
})();
