// 除錯紀錄：記錄觸控、焦點、鍵盤與輸入法事件，顯示在畫面下方，可一鍵複製。
// 在 App 裡由「設定 → 除錯模式」開啟；debug.html 打字測試頁也會使用。

const MAX = 300;
const lines = [];
let panel, list, countEl;
const t0 = performance.now();

function describe(el) {
  if (!el || el === document || el === window) return String(el === window ? 'window' : el === document ? 'document' : el);
  if (!el.tagName) return el.nodeName || '?';
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).join('.');
  const label = el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder');
  if (label) s += `[${label}]`;
  if (el.disabled) s += '(disabled)';
  if (el.readOnly) s += '(readonly)';
  return s;
}

function log(type, detail = '') {
  const ms = Math.round(performance.now() - t0);
  const line = `${String(ms).padStart(7)}ms ${type} ${detail}`;
  lines.push(line);
  if (lines.length > MAX) lines.shift();
  if (list) {
    const row = document.createElement('div');
    row.textContent = line;
    list.append(row);
    while (list.children.length > MAX) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
    countEl.textContent = lines.length;
  }
}

async function envInfo(appVersion) {
  const out = [];
  out.push(`App: ${appVersion}`);
  out.push(`URL: ${location.href}`);
  out.push(`UA: ${navigator.userAgent}`);
  out.push(`standalone: ${matchMedia('(display-mode: standalone)').matches}, pointer coarse: ${matchMedia('(pointer: coarse)').matches}, touchPoints: ${navigator.maxTouchPoints}`);
  out.push(`viewport: ${innerWidth}x${innerHeight}, dpr ${devicePixelRatio}, visualViewport ${visualViewport ? `${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)}` : 'n/a'}`);
  try { out.push(`storage persisted: ${await navigator.storage?.persisted?.()}`); } catch (e) { out.push('storage persisted: error ' + e.message); }
  out.push(`SW controller: ${!!navigator.serviceWorker?.controller}`);
  out.push(`lang: ${navigator.language}`);
  return out.join('\n');
}

function copyText(text) {
  const done = () => log('debug', '已複製');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => showText(text));
  } else showText(text);
}

/** 剪貼簿不可用時：顯示唯讀文字框，讓使用者長按全選複製。 */
function showText(text) {
  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.value = text;
  ta.style.cssText = 'position:fixed;inset:10% 4%;z-index:100000;width:92%;height:70%;font:11px monospace;';
  const close = document.createElement('button');
  close.textContent = '關閉';
  close.style.cssText = 'position:fixed;top:4%;right:4%;z-index:100001;padding:8px 14px;';
  close.onclick = () => { ta.remove(); close.remove(); };
  document.body.append(ta, close);
}

export async function startDebug({ appVersion = '?', bottom = 70 } = {}) {
  if (panel) return;
  panel = document.createElement('div');
  panel.style.cssText = `position:fixed;left:4px;right:4px;bottom:${bottom}px;z-index:99999;background:rgba(15,20,30,.92);color:#cfe;font:11px/1.35 ui-monospace,monospace;border-radius:8px;padding:6px;max-height:34vh;display:flex;flex-direction:column;`;
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:4px;';
  const title = document.createElement('span');
  title.style.flex = '1';
  title.textContent = '除錯紀錄 ';
  countEl = document.createElement('b');
  title.append(countEl);
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'font:12px sans-serif;padding:4px 8px;border-radius:6px;border:0;background:#2d6cdf;color:#fff;';
    b.addEventListener('mousedown', e => e.preventDefault());   // 不搶走輸入框的焦點
    b.addEventListener('click', fn);
    return b;
  };
  let collapsed = false;
  list = document.createElement('div');
  list.style.cssText = 'overflow:auto;white-space:pre;flex:1;';
  bar.append(title,
    mk('複製', async () => copyText(`${await envInfo(appVersion)}\n---\n${lines.join('\n')}`)),
    mk('清除', () => { lines.length = 0; list.replaceChildren(); countEl.textContent = 0; }),
    mk('縮小', e => { collapsed = !collapsed; list.style.display = collapsed ? 'none' : ''; e.target.textContent = collapsed ? '展開' : '縮小'; }));
  panel.append(bar, list);
  document.body.append(panel);

  const opts = { capture: true, passive: true };
  const act = () => describe(document.activeElement);
  document.addEventListener('pointerdown', e => log('pointerdown', `${e.pointerType} → ${describe(e.target)}${e.defaultPrevented ? ' (prevented)' : ''}`), opts);
  document.addEventListener('touchstart', e => log('touchstart', describe(e.target)), opts);
  document.addEventListener('click', e => log('click', describe(e.target)), opts);
  document.addEventListener('focusin', e => log('focusin', describe(e.target)), opts);
  document.addEventListener('focusout', e => log('focusout', `${describe(e.target)} → ${describe(e.relatedTarget)}`), opts);
  document.addEventListener('keydown', e => log('keydown', `key=${JSON.stringify(e.key)} code=${e.code} keyCode=${e.keyCode} composing=${e.isComposing} on ${describe(e.target)}`), opts);
  document.addEventListener('beforeinput', e => log('beforeinput', `${e.inputType} data=${JSON.stringify(e.data)} cancelable=${e.cancelable} on ${describe(e.target)}`), opts);
  document.addEventListener('input', e => log('input', `${e.inputType || ''} value=${JSON.stringify(e.target.value)} on ${describe(e.target)}`), opts);
  document.addEventListener('compositionstart', e => log('compositionstart', describe(e.target)), opts);
  document.addEventListener('compositionupdate', e => log('compositionupdate', JSON.stringify(e.data)), opts);
  document.addEventListener('compositionend', e => log('compositionend', JSON.stringify(e.data)), opts);
  document.addEventListener('visibilitychange', () => log('visibility', document.visibilityState), opts);
  window.addEventListener('blur', () => log('window.blur', `active=${act()}`), opts);
  window.addEventListener('focus', () => log('window.focus', `active=${act()}`), opts);
  window.addEventListener('hashchange', () => log('hashchange', location.hash), opts);
  window.addEventListener('error', e => log('ERROR', `${e.message} @${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => log('REJECTION', String(e.reason?.message || e.reason)));
  visualViewport?.addEventListener('resize', () => log('viewport', `${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)} active=${act()}`));
  // 有些輸入法不送 keydown/input；每秒檢查一次焦點所在
  let lastActive = '';
  setInterval(() => { const a = act(); if (a !== lastActive) { lastActive = a; log('activeElement', a); } }, 1000);
  log('debug', '開始記錄');
  (await envInfo(appVersion)).split('\n').forEach(l => log('env', l));
}
