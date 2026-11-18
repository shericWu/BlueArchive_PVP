// 畫面與互動。資料存取都在 db.js。
import * as DB from './db.js';
import { StudentIndex } from './students.js';
import { today, compactDate, cleanSlots, duplicatesIn, STRIKER_SLOTS, SLOT_COUNT } from './util.js';

const APP_VERSION = '1.0.0';

const state = {
  idx: new StudentIndex([]),
  settings: { roleLimit: true },
};

// ======================= 小工具 =======================

/** 建立元素。attrs 的 onXxx 為事件；class、style、dataset 等照常設定。字串子節點一律當純文字。 */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const $view = () => document.getElementById('view');

/** 取代子節點；陣列會攤平（replaceChildren 會把陣列變成字串）。 */
function mount(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false));
}

function setHeader(title, { back = false } = {}) {
  const top = document.getElementById('top');
  mount(top,
    back ? h('button', { class: 'back', 'aria-label': '返回', onclick: () => history.length > 1 ? history.back() : go('#/') }, '‹') : null,
    h('h1', {}, title),
  );
  document.title = title === '戰術對抗戰紀錄' ? title : `${title}｜戰術對抗戰紀錄`;
}

function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

function toast(message, { undo = null, error = false, ms = undo ? 10000 : 3000, action = null } = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: 'toast' + (error ? ' error' : '') }, h('span', {}, message));
  let timer;
  const close = () => { clearTimeout(timer); el.remove(); };
  if (undo) el.append(h('button', { onclick: async () => { close(); await undo(); } }, '復原'));
  if (action) el.append(h('button', { onclick: () => { close(); action.run(); } }, action.label));
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  timer = setTimeout(close, ms);
  return close;
}

function showError(e) {
  console.warn(e);
  toast(e?.message || String(e), { error: true, ms: 5000 });
}

/**
 * 對話框。body 為元素；actions 為 [{label, value, kind, validate}]。
 * 回傳 Promise，解析為被按下按鈕的 value（關閉則為 null）。
 */
function modal(title, body, actions = [{ label: '確定', value: true, kind: 'primary' }]) {
  return new Promise(resolve => {
    const dlg = h('dialog', {});
    const err = h('div', { class: 'dlg-error', role: 'alert', hidden: true });
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    const btns = actions.map(a => h('button', {
      class: 'btn' + (a.kind ? ' ' + a.kind : ''),
      onclick: async () => {
        err.hidden = true;
        if (a.validate) {
          // 錯誤顯示在對話框裡（toast 會被對話框的背景蓋住）
          try { if ((await a.validate()) === false) return; }
          catch (e) { console.warn(e); err.textContent = e?.message || String(e); err.hidden = false; return; }
        }
        done(a.value);
      },
    }, a.label));
    dlg.append(h('div', { class: 'dlg-body' }, h('h3', {}, title), body, err), h('div', { class: 'dlg-actions' }, btns));
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

function confirmDialog(title, message, { ok = '確定', danger = false } = {}) {
  return modal(title, h('p', {}, message), [
    { label: '取消', value: false },
    { label: ok, value: true, kind: danger ? 'danger solid' : 'primary' },
  ]).then(v => v === true);
}

function download(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function exportBackup(suffix = '') {
  const data = await DB.exportAll();
  download(`ba-pvp-${compactDate()}${suffix}.json`, data);
  await DB.markBackedUp();
  return data;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${today(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ======================= 組合顯示與輸入 =======================

function teamView(slots, { compact = false } = {}) {
  const s = cleanSlots(slots);
  const chip = id => id === null ? h('div', { class: 'chip empty' }, '—') : h('div', { class: 'chip' }, state.idx.name(id));
  return h('div', { class: 'team' + (compact ? ' compact' : '') },
    h('div', { class: 'team-row' }, h('div', { class: 'lbl' }, 'ST'), s.slice(0, STRIKER_SLOTS).map(chip)),
    h('div', { class: 'team-row' }, h('div', { class: 'lbl' }, 'SP'), s.slice(STRIKER_SLOTS).map(chip)),
  );
}

const ROLE_LABEL = { striker: 'STRIKER', special: 'SPECIAL' };

/**
 * 6 格學生輸入。輸入中文、日文、英文或別名皆可，候選清單顯示在組合下方。
 * @returns {{el: HTMLElement, getSlots(): any[], validate(): boolean, setSlots(s): void, setDisabled(b): void, focus(): void}}
 */
function teamInput(initial = [], { disabled = false, onChange = null } = {}) {
  let values = cleanSlots(initial);
  let active = -1;        // 目前輸入中的格子
  let cursor = 0;         // 候選清單的鍵盤游標
  let candidates = [];
  let beforeEdit = null;  // 開始編輯某格時原本的學生（交換站位用）
  const slotEls = [], inputs = [];
  const list = h('ul', { class: 'suggest', hidden: true });

  const roleFor = i => state.settings.roleLimit ? (i < STRIKER_SLOTS ? 'striker' : 'special') : null;

  function paint(i) {
    const v = values[i];
    inputs[i].value = v === null ? '' : state.idx.name(v);
    slotEls[i].classList.toggle('filled', v !== null);
    slotEls[i].classList.remove('invalid');
  }

  function pick(i, student) {
    // 已在其他格子的學生：兩格交換（方便調整站位）
    const j = values.findIndex((v, k) => v === student.id && k !== i);
    if (j > -1) { values[j] = beforeEdit; paint(j); }
    values[i] = student.id;
    beforeEdit = student.id;
    paint(i);
    hideList();
    onChange?.(values.slice());
    const next = inputs.slice(i + 1).find(inp => !inp.disabled && values[inputs.indexOf(inp)] === null);
    if (next) next.focus(); else inputs[i].blur();
  }

  function hideList() { list.hidden = true; list.replaceChildren(); candidates = []; }

  function showList(i) {
    const text = inputs[i].value;
    candidates = text.trim() ? state.idx.search(text, { role: roleFor(i), limit: 12 }) : [];
    cursor = 0;
    list.replaceChildren();
    if (!text.trim()) { list.hidden = true; return; }
    candidates.forEach((s, k) => {
      const at = values.findIndex((v, j) => v === s.id && j !== i);
      list.append(h('li', {
        class: k === cursor ? 'active' : '',
        onpointerdown: e => { e.preventDefault(); pick(i, s); },
      },
      h('span', { class: 'zh' }, s.zh || s.ja || s.en),
      h('span', { class: 'alt' }, [s.ja, s.en].filter(Boolean).join(' · ')),
      at > -1 ? h('span', { class: 'role' }, `在第 ${at + 1} 格・交換`)
        : s.role ? h('span', { class: 'role' }, s.role === 'striker' ? 'ST' : 'SP') : null));
    });
    if (!candidates.length) list.append(h('li', { class: 'empty' }, '找不到符合的學生'));
    list.append(h('li', {
      class: 'add',
      onpointerdown: async e => {
        e.preventDefault();
        const s = await addCustomStudentDialog(text.trim(), roleFor(i));
        if (s) pick(i, s);
      },
    }, `＋ 新增自訂學生「${text.trim()}」`));
    list.hidden = false;
  }

  for (let i = 0; i < SLOT_COUNT; i++) {
    const input = h('input', {
      type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'next',
      'aria-label': `第 ${i + 1} 格（${i < STRIKER_SLOTS ? 'STRIKER' : 'SPECIAL'}）`,
      onfocus: () => { hideList(); active = i; beforeEdit = values[i]; input.select(); if (input.value && values[i] === null) showList(i); },
      oninput: () => {
        values[i] = null;
        slotEls[i].classList.remove('filled', 'invalid');
        showList(i);
        onChange?.(values.slice());
      },
      onkeydown: e => {
        if (list.hidden) return;
        const items = [...list.querySelectorAll('li')].filter(li => !li.classList.contains('empty'));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items.forEach((li, k) => li.classList.toggle('active', k === cursor));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          items[cursor]?.dispatchEvent(new PointerEvent('pointerdown', { cancelable: true }));
        } else if (e.key === 'Escape') hideList();
      },
      onblur: () => {
        setTimeout(() => {
          if (active === i && document.activeElement !== input) active = -1;
          if (document.activeElement === input) return;
          const text = input.value.trim();
          if (values[i] === null && text) {
            const exact = state.idx.exact(text, { role: roleFor(i), exclude: new Set(values.filter(v => v !== null)) });
            if (exact) { values[i] = exact.id; paint(i); onChange?.(values.slice()); }
            else slotEls[i].classList.add('invalid');
          }
          if (active === -1) hideList();
        }, 0);
      },
    });
    inputs.push(input);
    slotEls.push(h('div', { class: 'slot' }, input, h('span', { class: 'num' }, i + 1)));
  }

  const el = h('div', {},
    h('div', { class: 'team' },
      h('div', { class: 'team-row' }, h('div', { class: 'lbl' }, 'ST'), slotEls.slice(0, STRIKER_SLOTS)),
      h('div', { class: 'team-row' }, h('div', { class: 'lbl' }, 'SP'), slotEls.slice(STRIKER_SLOTS))),
    list);

  const api = {
    el,
    getSlots: () => values.slice(),
    setSlots(s) { values = cleanSlots(s); values.forEach((_, i) => paint(i)); },
    setDisabled(b) { inputs.forEach(inp => { inp.disabled = b; }); if (b) hideList(); },
    focus() { inputs.find(inp => !inp.value)?.focus(); },
    /** 有打字但沒選到學生的格子會標紅並回傳 false。 */
    validate() {
      let ok = true;
      inputs.forEach((inp, i) => {
        if (values[i] === null && inp.value.trim()) { slotEls[i].classList.add('invalid'); ok = false; }
      });
      if (!ok) throw new Error('紅色格子沒有對應到學生，請從候選清單選擇或清空');
      if (duplicatesIn(values).length) throw new Error('同一隊不能放同一位學生兩次');
      return ok;
    },
  };
  api.setSlots(values);
  api.setDisabled(disabled);
  return api;
}

async function addCustomStudentDialog(text, role) {
  const zh = h('input', { class: 'input', value: text });
  const ja = h('input', { class: 'input' });
  const en = h('input', { class: 'input' });
  const roleSel = h('select', { class: 'input' },
    h('option', { value: 'striker', selected: role !== 'special' }, 'STRIKER'),
    h('option', { value: 'special', selected: role === 'special' }, 'SPECIAL'));
  let created = null;
  const body = h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, '名單裡沒有的學生可以先自訂。之後學生名單更新時不會影響自訂學生。'),
    h('label', { class: 'field' }, h('span', {}, '中文名（顯示用，必填）'), zh),
    h('label', { class: 'field' }, h('span', {}, '日文名'), ja),
    h('label', { class: 'field' }, h('span', {}, '英文名'), en),
    h('label', { class: 'field' }, h('span', {}, '角色'), roleSel));
  const ok = await modal('新增自訂學生', body, [
    { label: '取消', value: false },
    { label: '新增', value: true, kind: 'primary', validate: async () => {
      created = await DB.addCustomStudent({ zh: zh.value, ja: ja.value, en: en.value, role: roleSel.value });
    } },
  ]);
  if (!ok) return null;
  await reloadStudents();
  return created;
}

async function reloadStudents() {
  state.idx = new StudentIndex(await DB.allStudents());
}

function resultToggle(initial = null, onChange) {
  let value = initial;
  const win = h('button', { type: 'button', class: 'win' }, '贏');
  const lose = h('button', { type: 'button', class: 'lose' }, '輸');
  const paint = () => { win.classList.toggle('on', value === 'win'); lose.classList.toggle('on', value === 'lose'); };
  win.onclick = () => { value = 'win'; paint(); onChange?.(value); };
  lose.onclick = () => { value = 'lose'; paint(); onChange?.(value); };
  paint();
  return { el: h('div', { class: 'seg' }, win, lose), get: () => value, set: v => { value = v; paint(); } };
}

// ======================= 畫面：首頁 =======================

function opponentCard(o) {
  return h('a', { class: 'card list-item', href: `#/opp/${o.id}` },
    h('div', { class: 'row' },
      h('span', { class: 'title grow' }, o.name),
      o.current ? h('span', { class: 'badge' }, `第 ${o.current.version} 版`) : null),
    h('div', { class: 'muted small', style: 'margin:2px 0 8px' },
      `${o.attackCount} 戰 ${o.wins} 勝`, o.versionCount > 1 ? ` · 共 ${o.versionCount} 個版本` : ''),
    o.current ? teamView(o.current.slots, { compact: true }) : null);
}

async function viewHome() {
  setHeader('戰術對抗戰紀錄');
  const opps = await DB.listOpponents();
  const v = $view();
  mount(v,
    h('a', { class: 'btn primary block big', href: '#/new', style: 'margin:4px 0 8px' }, '＋ 新增對戰'),
    h('div', { class: 'section-title' }, opps.length ? `最近的對手（${opps.length}）` : '最近的對手'),
    opps.length ? opps.slice(0, 30).map(opponentCard)
      : h('div', { class: 'empty-state' }, '還沒有紀錄。打完一場後按「新增對戰」記下來。'),
    opps.length > 30 ? h('a', { class: 'btn block', href: '#/search' }, '查看全部對手') : null,
  );
}

// ======================= 畫面：新增對戰 =======================

async function viewNew(params) {
  setHeader('新增對戰', { back: true });
  let opponent = null;       // 既有對手
  let current = null;        // 其現行防禦
  let changing = false;      // 是否按了「對手換陣了」

  const nameInput = h('input', { class: 'input', placeholder: '對手名稱', autocomplete: 'off', enterkeyhint: 'next' });
  const oppList = h('ul', { class: 'suggest', hidden: true });
  const defStatus = h('div', { class: 'row' });
  const defense = teamInput();
  const attack = teamInput();
  const result = resultToggle();
  const date = h('input', { class: 'input', type: 'date', value: today() });
  const note = h('textarea', { class: 'input', placeholder: '備註（選填）' });
  const after = h('div', {});

  function paintDefense() {
    defStatus.replaceChildren();
    if (!opponent) {
      defStatus.append(h('span', { class: 'badge new' }, nameInput.value.trim() ? '新對手' : '先輸入對手名稱'));
      defense.setDisabled(false);
      return;
    }
    if (changing) {
      defStatus.append(h('span', { class: 'badge new' }, `換陣：儲存後建立第 ${nextVersion} 版`),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => { changing = false; defense.setSlots(current.slots); paintDefense(); } }, '取消換陣'));
      defense.setDisabled(false);
    } else {
      defStatus.append(h('span', { class: 'badge' }, `現行 第 ${current.version} 版`),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => { changing = true; paintDefense(); defense.focus(); } }, '對手換陣了'));
      defense.setDisabled(true);
    }
  }
  let nextVersion = 2;

  async function setOpponent(o) {
    opponent = o;
    changing = false;
    if (o) {
      nameInput.value = o.name;
      const det = await DB.getOpponentDetail(o.id);
      current = det.versions.find(v => v.isCurrent === 1);
      nextVersion = Math.max(...det.versions.map(v => v.version)) + 1;
      defense.setSlots(current?.slots || []);
    } else {
      current = null;
      defense.setSlots([]);
    }
    paintDefense();
  }

  let nameTimer;
  nameInput.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(async () => {
      const text = nameInput.value.trim();
      const exact = await DB.findOpponentByName(text);
      if ((exact?.id ?? null) !== (opponent?.id ?? null)) {
        if (exact) await setOpponent(exact);
        else await setOpponent(null);   // 改成新對手：清空沿用的防禦
      } else paintDefense();
      const matches = text ? (await DB.listOpponents({ query: text })).filter(o => o.id !== exact?.id).slice(0, 6) : [];
      oppList.replaceChildren(...matches.map(o => h('li', {
        onpointerdown: async e => { e.preventDefault(); oppList.hidden = true; await setOpponent(o); },
      }, h('span', { class: 'zh' }, o.name), h('span', { class: 'alt' }, `第 ${o.current?.version ?? '?'} 版 · ${o.attackCount} 戰`))));
      oppList.hidden = !matches.length;
    }, 150);
  });
  nameInput.addEventListener('blur', () => setTimeout(() => { oppList.hidden = true; }, 0));

  async function save() {
    try {
      const name = nameInput.value.trim();
      if (!name) throw new Error('請輸入對手名稱');
      defense.validate(); attack.validate();
      let revert = false;
      let mode = opponent ? (changing ? 'change' : 'keep') : 'new';
      if (opponent && changing) {
        const chk = await DB.checkDefenseChange(opponent.id, defense.getSlots());
        if (chk.kind === 'same_as_current') { mode = 'keep'; toast('防禦與現行版本相同，沿用現行版本'); }
        else if (chk.kind === 'matches_old') {
          const yes = await confirmDialog('與舊版本相同', `這和第 ${chk.version.version} 版相同，要改回第 ${chk.version.version} 版嗎？`, { ok: `改回第 ${chk.version.version} 版` });
          if (!yes) return;
          revert = true;
        }
      }
      const r = await DB.saveMatch({
        opponentName: name, defenseSlots: defense.getSlots(), defenseMode: mode === 'change' ? 'change' : 'keep', revert,
        attackSlots: attack.getSlots(), result: result.get(), date: date.value || today(), note: note.value,
      });
      toast(r.created ? `已新增對手「${name}」並儲存` : '已儲存');
      // 停在同一個對手，方便馬上再記一次攻擊
      await setOpponent(await DB.db.opponents.get(r.opponentId));
      attack.setSlots([]); result.set(null); note.value = '';
      after.replaceChildren(h('a', { class: 'btn block', href: `#/opp/${r.opponentId}` }, `查看「${name}」的紀錄`));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { showError(e); }
  }

  mount($view(),
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', {}, '對手名稱'), nameInput), oppList),
    h('div', { class: 'card stack' },
      h('h2', {}, '防禦組合'), defStatus, defense.el),
    h('div', { class: 'card stack' },
      h('h2', {}, '攻擊組合'), attack.el),
    h('div', { class: 'card stack' },
      h('h2', {}, '結果'), result.el,
      h('label', { class: 'field' }, h('span', {}, '日期'), date),
      h('label', { class: 'field' }, h('span', {}, '備註'), note)),
    h('button', { class: 'btn primary block big', onclick: save }, '儲存'),
    h('div', { style: 'margin-top:10px' }, after),
  );

  const oppId = Number(params.get('opp'));
  if (oppId) {
    const o = await DB.db.opponents.get(oppId);
    if (o) { await setOpponent(o); attack.focus(); return; }
  }
  paintDefense();
  nameInput.focus();
}

// ======================= 畫面：搜尋 =======================

async function viewSearch(params) {
  setHeader('搜尋');
  const input = h('input', { class: 'input', type: 'search', placeholder: '搜尋對手名稱', value: params.get('q') || '', autocomplete: 'off' });
  const results = h('div', {});
  let timer;
  async function run() {
    const q = input.value.trim();
    history.replaceState(null, '', q ? `#/search?q=${encodeURIComponent(q)}` : '#/search');
    const list = await DB.listOpponents({ query: q });
    mount(results,
      h('div', { class: 'section-title' }, q ? `符合「${q}」的對手（${list.length}）` : `全部對手（${list.length}）`),
      list.length ? list.map(opponentCard) : h('div', { class: 'empty-state' }, q ? '找不到符合的對手' : '還沒有紀錄'));
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
  mount($view(), h('div', { class: 'card' }, input), results);
  await run();
  input.focus();
}

// ======================= 畫面：對手詳情 =======================

async function viewOpponent(id) {
  const det = await DB.getOpponentDetail(id);
  if (!det) { setHeader('找不到對手', { back: true }); mount($view(), h('div', { class: 'empty-state' }, '這個對手不存在，可能已被刪除。')); return; }
  const { opponent, versions } = det;
  setHeader(opponent.name, { back: true });
  const cur = versions.find(v => v.isCurrent === 1);
  const olds = versions.filter(v => v.isCurrent !== 1);
  const total = versions.reduce((n, v) => n + v.attacks.length, 0);

  async function editOpponent() {
    const name = h('input', { class: 'input', value: opponent.name });
    const note = h('textarea', { class: 'input', value: opponent.note || '' });
    const ok = await modal('編輯對手', h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', {}, '名稱'), name),
      h('p', { class: 'muted small' }, '對手改暱稱時，請當作新對手另外記錄。這裡只用來修正打錯的名稱。'),
      h('label', { class: 'field' }, h('span', {}, '備註'), note)), [
      { label: '取消', value: false },
      { label: '儲存', value: true, kind: 'primary', validate: () => DB.updateOpponent(id, { name: name.value, note: note.value }) },
    ]);
    if (ok) { toast('已更新'); render(); }
  }

  async function changeDefense() {
    const t = teamInput(cur.slots);
    const ok = await modal('對手換陣', h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, `儲存後建立新版本，第 ${cur.version} 版與它的紀錄會保留為舊版。只調換站位也算換陣。`), t.el), [
      { label: '取消', value: false },
      { label: '建立新版本', value: true, kind: 'primary', validate: async () => {
        t.validate();
        const chk = await DB.checkDefenseChange(id, t.getSlots());
        if (chk.kind === 'same_as_current') throw new Error('和現行版本完全相同，不需要換陣');
        if (chk.kind === 'matches_old') {
          const yes = await confirmDialog('與舊版本相同', `這和第 ${chk.version.version} 版相同，要改回第 ${chk.version.version} 版嗎？`, { ok: `改回第 ${chk.version.version} 版` });
          if (!yes) return false;
          await DB.changeDefense(id, t.getSlots(), { revert: true });
          return;
        }
        await DB.changeDefense(id, t.getSlots());
      } },
    ]);
    if (ok) { toast('已更新防禦'); render(); }
  }

  async function correct(v) {
    const t = teamInput(v.slots);
    const note = h('textarea', { class: 'input', value: v.note || '' });
    const ok = await modal(`修正第 ${v.version} 版`, h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, '直接覆寫這個版本，用來修正打錯的學生。對手真的換陣請改用「對手換陣」。'),
      t.el, h('label', { class: 'field' }, h('span', {}, '防禦備註'), note)), [
      { label: '取消', value: false },
      { label: '儲存修正', value: true, kind: 'primary', validate: () => { t.validate(); return DB.correctDefense(v.id, t.getSlots(), note.value); } },
    ]);
    if (ok) { toast('已修正'); render(); }
  }

  async function removeVersion(v) {
    const msg = v.attacks.length ? `會一併刪除這個版本的 ${v.attacks.length} 筆攻擊紀錄。` : '這個版本沒有攻擊紀錄。';
    if (!await confirmDialog(`刪除第 ${v.version} 版？`, msg + (v.isCurrent === 1 ? ' 前一個版本會變成現行版本。' : ''), { ok: '刪除', danger: true })) return;
    try {
      const undo = await DB.deleteDefense(v.id);
      render();
      toast(`已刪除第 ${v.version} 版`, { undo: async () => { await DB.restore(undo); render(); } });
    } catch (e) { showError(e); }
  }

  async function removeOpponent() {
    if (!await confirmDialog(`刪除「${opponent.name}」？`, `會一併刪除 ${versions.length} 個防禦版本與 ${total} 筆攻擊紀錄。`, { ok: '刪除', danger: true })) return;
    const undo = await DB.deleteOpponent(id);
    go('#/');
    toast(`已刪除「${opponent.name}」`, { undo: async () => { await DB.restore(undo); go(`#/opp/${id}`); } });
  }

  function attackRow(a) {
    return h('div', { class: 'attack', onclick: () => go(`#/attack/${a.id}`) },
      h('div', { class: 'meta' },
        h('span', { class: 'badge ' + a.result }, a.result === 'win' ? '贏' : '輸'),
        h('span', { class: 'muted' }, a.date)),
      teamView(a.slots, { compact: true }),
      a.note ? h('div', { class: 'note' }, a.note) : null);
  }

  function versionBody(v) {
    const wins = v.attacks.filter(a => a.result === 'win').length;
    return [
      teamView(v.slots),
      v.note ? h('p', { class: 'small', style: 'white-space:pre-wrap;margin:8px 0 0' }, v.note) : null,
      h('div', { class: 'row', style: 'margin:10px 0 4px' },
        v.isCurrent !== 1 ? h('button', { class: 'btn small', onclick: async () => { await DB.setCurrentVersion(v.id); toast(`已將第 ${v.version} 版設為現行`); render(); } }, '設為現行版本') : null,
        h('button', { class: 'btn small', onclick: () => correct(v) }, '修正'),
        versions.length > 1 ? h('button', { class: 'btn small danger', onclick: () => removeVersion(v) }, '刪除版本') : null),
      h('div', { class: 'section-title', style: 'margin:14px 0 2px' }, v.attacks.length ? `攻擊紀錄（${v.attacks.length} 戰 ${wins} 勝）` : '還沒有攻擊紀錄'),
      v.attacks.map(attackRow),
    ];
  }

  mount($view(),
    opponent.note ? h('div', { class: 'card small', style: 'white-space:pre-wrap' }, opponent.note) : null,
    h('div', { class: 'row', style: 'margin-bottom:12px' },
      h('a', { class: 'btn primary grow', href: `#/new?opp=${id}` }, '＋ 記一次攻擊'),
      h('button', { class: 'btn', onclick: changeDefense }, '對手換陣')),
    cur ? h('div', { class: 'card current' },
      h('h2', {}, h('span', { class: 'badge' }, '現行'), `第 ${cur.version} 版`, h('span', { class: 'muted small' }, `從 ${cur.firstSeen || '—'}`)),
      versionBody(cur)) : null,
    olds.length ? h('div', { class: 'section-title' }, `舊版本（${olds.length}）`) : null,
    olds.map(v => h('details', { class: 'old' },
      h('summary', {}, h('span', { class: 'badge old' }, '舊版'), `第 ${v.version} 版`,
        h('span', { class: 'muted small' }, `${v.firstSeen || '—'} ～ ${v.retiredAt || '—'} · ${v.attacks.length} 戰`)),
      h('div', { class: 'card' }, versionBody(v)))),
    h('div', { class: 'row', style: 'margin-top:20px' },
      h('button', { class: 'btn', onclick: editOpponent }, '編輯對手'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn danger', onclick: removeOpponent }, '刪除對手')),
  );
}

// ======================= 畫面：攻擊紀錄編輯 =======================

async function viewAttack(id) {
  const a = await DB.getAttack(id);
  if (!a) { setHeader('找不到紀錄', { back: true }); mount($view(), h('div', { class: 'empty-state' }, '這筆紀錄不存在，可能已被刪除。')); return; }
  const det = await DB.getOpponentDetail(a.opponentId);
  setHeader(`攻擊紀錄｜${det.opponent.name}`, { back: true });
  const t = teamInput(a.slots);
  const result = resultToggle(a.result);
  const date = h('input', { class: 'input', type: 'date', value: a.date || today() });
  const note = h('textarea', { class: 'input', value: a.note || '' });
  const version = h('select', { class: 'input' },
    det.versions.map(v => h('option', { value: v.id, selected: v.id === a.defenseId }, `第 ${v.version} 版${v.isCurrent === 1 ? '（現行）' : ''}`)));
  const defPreview = h('div', {});
  const paintDef = () => defPreview.replaceChildren(teamView(det.versions.find(v => v.id === Number(version.value)).slots, { compact: true }));
  version.addEventListener('change', paintDef);
  paintDef();

  async function save() {
    try {
      t.validate();
      await DB.updateAttack(id, { slots: t.getSlots(), result: result.get(), date: date.value, note: note.value, defenseId: Number(version.value) });
      toast('已儲存');
      go(`#/opp/${a.opponentId}`);
    } catch (e) { showError(e); }
  }
  async function remove() {
    if (!await confirmDialog('刪除這筆攻擊紀錄？', '刪除後 10 秒內可以復原。', { ok: '刪除', danger: true })) return;
    const undo = await DB.deleteAttack(id);
    go(`#/opp/${a.opponentId}`);
    toast('已刪除攻擊紀錄', { undo: async () => { await DB.restore(undo); render(); } });
  }

  mount($view(),
    h('div', { class: 'card stack' },
      h('label', { class: 'field' }, h('span', {}, '對手的防禦版本'), version), defPreview),
    h('div', { class: 'card stack' }, h('h2', {}, '攻擊組合'), t.el),
    h('div', { class: 'card stack' },
      h('h2', {}, '結果'), result.el,
      h('label', { class: 'field' }, h('span', {}, '日期'), date),
      h('label', { class: 'field' }, h('span', {}, '備註'), note)),
    h('button', { class: 'btn primary block big', onclick: save }, '儲存'),
    h('button', { class: 'btn danger block', style: 'margin-top:12px', onclick: remove }, '刪除這筆紀錄'),
  );
}

// ======================= 畫面：設定 =======================

async function viewSettings() {
  setHeader('設定');
  const c = await DB.counts();
  const info = await DB.getMeta('studentsInfo');
  const lastBackup = await DB.getMeta('lastBackupAt');
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;

  const roleLimit = h('input', { type: 'checkbox', checked: state.settings.roleLimit, onchange: async e => {
    state.settings.roleLimit = e.target.checked;
    await DB.setMeta('roleLimit', e.target.checked);
    toast(e.target.checked ? '已開啟站位限制' : '已關閉站位限制');
  } });

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => importFile(fileInput.files[0]) });
  let importMode = 'replace';

  async function importFile(file) {
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const replace = importMode === 'replace';
      const msg = replace
        ? `會以備份檔取代目前的 ${c.opponents} 個對手與 ${c.attacks} 筆紀錄。匯入前會先自動下載一份目前資料的備份。`
        : '備份檔的對手與紀錄會合併進目前資料，重複的紀錄會略過。';
      if (!await confirmDialog(replace ? '取代全部資料？' : '合併匯入？', msg, { ok: '匯入', danger: replace })) return;
      if (replace && c.opponents + c.attacks > 0) await exportBackup('-before-import');
      const r = await DB.importAll(data, importMode);
      await reloadStudents();
      toast(`已匯入：${r.opponents} 個對手、${r.attacks} 筆紀錄${r.skipped ? `，略過 ${r.skipped} 筆重複` : ''}`, { ms: 5000 });
      render();
    } catch (e) { showError(e instanceof SyntaxError ? new Error('檔案不是有效的 JSON') : e); }
  }

  async function newSeason() {
    const confirmText = h('input', { class: 'input', placeholder: '輸入「清除」' });
    const backupFirst = h('input', { type: 'checkbox', checked: true });
    const ok = await modal('開始新一季', h('div', { class: 'stack' },
      h('p', {}, `會刪除全部 ${c.opponents} 個對手、${c.defenses} 個防禦版本、${c.attacks} 筆攻擊紀錄。學生名單與設定會保留。`),
      h('label', { class: 'switch' }, backupFirst, '清除前先下載備份'),
      h('label', { class: 'field' }, h('span', {}, '確認請輸入「清除」'), confirmText)), [
      { label: '取消', value: false },
      { label: '清除全部資料', value: true, kind: 'danger solid', validate: () => {
        if (confirmText.value.trim() !== '清除') throw new Error('請輸入「清除」兩個字');
      } },
    ]);
    if (!ok) return;
    try {
      if (backupFirst.checked) await exportBackup('-season-end');
      await DB.clearSeason();
      toast('已清除，新一季開始！');
      render();
    } catch (e) { showError(e); }
  }

  mount($view(),
    h('div', { class: 'section-title' }, '備份'),
    h('div', { class: 'card stack' },
      h('p', { class: 'small muted', style: 'margin:0' }, '資料只存在這支手機的瀏覽器裡。清除 Firefox 資料或換手機前，請先匯出備份。'),
      h('dl', { class: 'kv' }, h('dt', {}, '目前資料'), h('dd', {}, `${c.opponents} 個對手、${c.defenses} 個版本、${c.attacks} 筆紀錄`),
        h('dt', {}, '上次備份'), h('dd', {}, fmtDateTime(lastBackup))),
      h('button', { class: 'btn primary block', onclick: async () => { await exportBackup(); toast('已下載備份檔'); render(); } }, '匯出備份（JSON）'),
      h('div', { class: 'row' },
        h('label', { class: 'switch small' }, h('input', { type: 'radio', name: 'imode', checked: true, onchange: () => { importMode = 'replace'; } }), '取代全部'),
        h('label', { class: 'switch small' }, h('input', { type: 'radio', name: 'imode', onchange: () => { importMode = 'merge'; } }), '合併')),
      h('button', { class: 'btn block', onclick: () => fileInput.click() }, '匯入備份…'), fileInput),

    h('div', { class: 'section-title' }, '換季'),
    h('div', { class: 'card stack danger-zone' },
      h('p', { class: 'small', style: 'margin:0' }, '新一季的場地與對手都會更換。開始新一季會清除全部對戰資料，學生名單保留。'),
      h('button', { class: 'btn danger block', onclick: newSeason }, '開始新一季（清除全部資料）')),

    h('div', { class: 'section-title' }, '輸入'),
    h('div', { class: 'card' },
      h('label', { class: 'switch' }, roleLimit, h('span', {}, '站位限制', h('div', { class: 'small muted' }, '第 1～4 格只列 STRIKER，第 5～6 格只列 SPECIAL')))),

    h('div', { class: 'section-title' }, '學生名單'),
    h('div', { class: 'card' },
      h('dl', { class: 'kv' },
        h('dt', {}, '學生數'), h('dd', {}, `${c.students} 位`),
        h('dt', {}, '名單版本'), h('dd', {}, info ? `${info.version}（${fmtDateTime(info.generatedAt)}）` : '—'),
        h('dt', {}, '來源'), h('dd', {}, info?.source || '—'))),

    h('div', { class: 'section-title' }, '儲存空間'),
    h('div', { class: 'card small' },
      persisted === true ? '瀏覽器已允許永久儲存，空間不足時不會自動清除資料。'
        : h('div', { class: 'warn-box' }, '瀏覽器沒有允許永久儲存，空間不足時可能清除資料。請定期匯出備份。')),

    h('div', { class: 'section-title' }, '關於'),
    h('div', { class: 'card small muted' },
      h('div', {}, `戰術對抗戰紀錄 v${APP_VERSION}`),
      h('div', {}, '學生資料來源：', h('a', { href: 'https://schaledb.com/home', target: '_blank', rel: 'noopener' }, 'SchaleDB')),
      h('div', {}, '角色名稱版權屬於 NEXON Games 與 Yostar。')),
  );
}

// ======================= 路由 =======================

let rendering = Promise.resolve();
function render() {
  rendering = rendering.then(_render).catch(showError);
  return rendering;
}

async function _render() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean);
  const nav = parts[0] === 'new' ? 'new' : parts[0] === 'search' ? 'search' : parts[0] === 'settings' ? 'settings' : parts[0] ? '' : 'home';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
  document.querySelectorAll('dialog').forEach(d => d.remove());
  window.scrollTo(0, 0);
  switch (parts[0]) {
    case undefined: return viewHome();
    case 'new': return viewNew(params);
    case 'search': return viewSearch(params);
    case 'opp': return viewOpponent(Number(parts[1]));
    case 'attack': return viewAttack(Number(parts[1]));
    case 'settings': return viewSettings();
    default: go('#/');
  }
}

// ======================= 啟動 =======================

async function loadBundledStudents() {
  try {
    const res = await fetch('data/students.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const r = await DB.syncBundledStudents(await res.json());
    if (r && (r.added || r.changed) && (await DB.getMeta('studentsToastShown'))) toast(`學生名單已更新：新增 ${r.added} 位、更新 ${r.changed} 位`);
    await DB.setMeta('studentsToastShown', true);
  } catch (e) { console.warn('無法載入學生名單', e); }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 只有使用者按了「重新整理」才重新載入；第一次安裝時的 controllerchange 不處理，避免打字到一半被重新整理。
  let updateRequested = false;
  const offerUpdate = sw => toast('App 有新版本', { ms: 30000, action: { label: '重新整理', run: () => { updateRequested = true; sw.postMessage('SKIP_WAITING'); } } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw);
      });
    });
  }).catch(e => console.warn('Service Worker 註冊失敗', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) location.reload(); });
}

async function init() {
  DB.openDb();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  state.settings = await DB.getSettings();
  await loadBundledStudents();
  await reloadStudents();
  window.addEventListener('hashchange', render);
  await render();
  registerServiceWorker();
}

init().catch(showError);
