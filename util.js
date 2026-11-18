// 共用小工具：文字正規化、組合簽章、日期。

const STRIP = /[\s　・·･()\[\]（）「」『』【】\-_.,，、'"’]/g;

/** 比對用的正規化：全形半形統一、英文小寫、平假名轉片假名、去掉空白與符號。 */
export function normalize(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .replace(STRIP, '');
}

export const SLOT_COUNT = 6;
export const STRIKER_SLOTS = 4;

/** 6 格固定長度，空格為 null。 */
export function cleanSlots(slots) {
  const out = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const v = slots?.[i];
    out.push(v === undefined || v === '' ? null : v);
  }
  return out;
}

/** 依格子順序產生簽章：站位不同就是不同組合。空格寫 _。 */
export function signatureOf(slots) {
  return cleanSlots(slots).map(v => (v === null ? '_' : String(v))).join(',');
}

/** 去掉空格的學生集合，供「含有某位學生」的搜尋使用（不看站位）。 */
export function studentSetOf(slots) {
  return [...new Set(cleanSlots(slots).filter(v => v !== null))];
}

/** 同一隊不能放同一位學生兩次。回傳重複的學生 ID 陣列。 */
export function duplicatesIn(slots) {
  const seen = new Set(), dup = new Set();
  for (const v of cleanSlots(slots)) {
    if (v === null) continue;
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

/** 本地時間的 YYYY-MM-DD。 */
export function today(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function compactDate(d = new Date()) {
  return today(d).replaceAll('-', '');
}
