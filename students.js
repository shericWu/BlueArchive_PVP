// 學生名單：中日英比對、內建名單合併。純函式，不碰資料庫。
import { normalize } from './util.js';

export const AUTO_FIELDS = ['zh', 'ja', 'en', 'role'];

/** 顯示名稱：中文優先。 */
export function displayName(s) {
  if (!s) return '';
  return s.zh || s.ja || s.en || `#${s.id}`;
}

/** 建立比對用索引。students 為完整名單（含隱藏者）。 */
export class StudentIndex {
  constructor(students) {
    this.byId = new Map();
    this.entries = [];
    for (const s of students) {
      this.byId.set(s.id, s);
      const keys = [s.zh, s.ja, s.en, ...(s.aliases || [])].map(normalize).filter(Boolean);
      this.entries.push({ s, keys });
    }
  }

  get(id) { return this.byId.get(id); }
  name(id) { return id === null || id === undefined ? '' : (displayName(this.byId.get(id)) || `#${id}`); }

  /**
   * 依輸入找學生。排序：完全相符 > 開頭相符 > 包含；同級時中文名相符者優先，再依 ID。
   * @param {string} query
   * @param {{role?: 'striker'|'special'|null, limit?: number, exclude?: Set}} opts
   */
  search(query, { role = null, limit = 20, exclude = null } = {}) {
    const q = normalize(query);
    if (!q) return [];
    const hits = [];
    for (const { s, keys } of this.entries) {
      if (s.hidden) continue;
      if (role && s.role && s.role !== role) continue;
      if (exclude && exclude.has(s.id)) continue;
      let best = null;
      keys.forEach((k, i) => {
        const rank = k === q ? 0 : k.startsWith(q) ? 1 : k.includes(q) ? 2 : null;
        if (rank === null) return;
        const score = rank * 10 + Math.min(i, 9);
        if (best === null || score < best) best = score;
      });
      if (best !== null) hits.push({ s, score: best });
    }
    hits.sort((a, b) => a.score - b.score || String(a.s.id).localeCompare(String(b.s.id), 'en', { numeric: true }));
    return hits.slice(0, limit).map(h => h.s);
  }

  /** 輸入恰好完全相符一位學生時回傳該學生（離開輸入框時自動選取用）。 */
  exact(query, opts = {}) {
    const q = normalize(query);
    if (!q) return null;
    const list = this.search(query, { ...opts, limit: 50 });
    const exact = list.filter(s => [s.zh, s.ja, s.en, ...(s.aliases || [])].some(k => normalize(k) === q));
    return exact.length === 1 ? exact[0] : null;
  }
}

/**
 * 把內建名單合併進本機名單。
 * 規則：新學生加入；既有學生更新 zh/ja/en/role，但手動改過的欄位（edited）與 aliases 不動；
 * 名單中消失的學生不刪除。
 * @returns {{put: object[], added: number, changed: number}}
 */
export function mergeStudentList(local, incoming) {
  const byId = new Map(local.map(s => [s.id, s]));
  const put = [];
  let added = 0, changed = 0;
  for (const inc of incoming) {
    const cur = byId.get(inc.id);
    if (!cur) {
      put.push({ id: inc.id, zh: inc.zh, ja: inc.ja, en: inc.en, role: inc.role, aliases: [], source: 'auto', edited: [], hidden: false });
      added++;
      continue;
    }
    const edited = new Set(cur.edited || []);
    const next = { ...cur };
    let diff = false;
    for (const f of AUTO_FIELDS) {
      if (edited.has(f)) continue;
      if (inc[f] !== undefined && inc[f] !== cur[f]) { next[f] = inc[f]; diff = true; }
    }
    if (diff) { put.push(next); changed++; }
  }
  return { put, added, changed };
}

/** 自訂學生的 ID。 */
export function newCustomId() {
  return 'custom-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
