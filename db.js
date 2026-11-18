// 資料層：Dexie（IndexedDB）存取、版本規則、刪除復原、備份、換季清除。
import Dexie from './vendor/dexie.mjs';
import { normalize, cleanSlots, signatureOf, studentSetOf, duplicatesIn, today } from './util.js';
import { mergeStudentList, newCustomId, AUTO_FIELDS } from './students.js';

export const SCHEMA_VERSION = 1;
export const APP_ID = 'ba-pvp';

export class AppError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

export let db;

export function openDb(name = 'ba-pvp') {
  db = new Dexie(name);
  db.version(1).stores({
    opponents: '++id, nameNorm, updatedAt',
    defenses: '++id, opponentId, *studentSet, signature',
    attacks: '++id, defenseId, opponentId, *studentSet, signature, date',
    students: 'id, source',
    meta: 'key',
  });
  return db;
}

const now = () => new Date().toISOString();

function team(slots) {
  const s = cleanSlots(slots);
  const dup = duplicatesIn(s);
  if (dup.length) throw new AppError('duplicate_student', '同一隊不能放同一位學生兩次', dup);
  return { slots: s, studentSet: studentSetOf(s), signature: signatureOf(s) };
}

function requireTeam(slots, label) {
  const t = team(slots);
  if (!t.studentSet.length) throw new AppError('empty_team', `${label}至少要填一位學生`);
  return t;
}

// ---------- meta / settings ----------

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}
export async function setMeta(key, value) { await db.meta.put({ key, value }); }

export async function getSettings() {
  return { roleLimit: await getMeta('roleLimit', true) };
}

// ---------- students ----------

export async function allStudents() { return db.students.toArray(); }

/** 內建名單版本與本機不同時合併。回傳 {added, changed} 或 null（無需更新）。 */
export async function syncBundledStudents(bundle) {
  if (!bundle?.students?.length) return null;
  const cur = await getMeta('studentsVersion');
  if (cur === bundle.version) return null;
  return db.transaction('rw', db.students, db.meta, async () => {
    const local = await db.students.toArray();
    const { put, added, changed } = mergeStudentList(local, bundle.students);
    if (put.length) await db.students.bulkPut(put);
    await setMeta('studentsVersion', bundle.version);
    await setMeta('studentsInfo', { version: bundle.version, generatedAt: bundle.generatedAt, source: bundle.source, count: bundle.count });
    return { added, changed };
  });
}

export async function addCustomStudent({ zh, ja = '', en = '', role = null }) {
  zh = (zh || '').trim();
  if (!zh) throw new AppError('name_required', '請輸入中文名');
  const s = { id: newCustomId(), zh, ja: ja.trim(), en: en.trim(), role, aliases: [], source: 'manual', edited: [], hidden: false };
  await db.students.add(s);
  return s;
}

/** 手動修改學生；自動來源的學生會記下改過的欄位，之後更新名單不覆蓋。 */
export async function updateStudent(id, patch) {
  return db.transaction('rw', db.students, async () => {
    const s = await db.students.get(id);
    if (!s) throw new AppError('not_found', '找不到學生');
    const edited = new Set(s.edited || []);
    for (const f of AUTO_FIELDS) if (f in patch && patch[f] !== s[f]) edited.add(f);
    await db.students.put({ ...s, ...patch, edited: [...edited] });
  });
}

// ---------- opponents ----------

export async function findOpponentByName(name) {
  const n = normalize(name);
  if (!n) return null;
  return (await db.opponents.where('nameNorm').equals(n).first()) || null;
}

export async function currentDefense(opponentId) {
  const list = await db.defenses.where('opponentId').equals(opponentId).toArray();
  return list.find(d => d.isCurrent === 1) || null;
}

/** 首頁與搜尋用：對手 + 現行防禦 + 紀錄數，依最近更新排序。 */
export async function listOpponents({ query = '' } = {}) {
  const q = normalize(query);
  let opps = await db.opponents.orderBy('updatedAt').reverse().toArray();
  if (q) opps = opps.filter(o => o.nameNorm.includes(q));
  const ids = opps.map(o => o.id);
  const defs = await db.defenses.where('opponentId').anyOf(ids).toArray();
  const atks = await db.attacks.where('opponentId').anyOf(ids).toArray();
  return opps.map(o => {
    const mine = defs.filter(d => d.opponentId === o.id);
    const a = atks.filter(x => x.opponentId === o.id);
    return {
      ...o,
      current: mine.find(d => d.isCurrent === 1) || null,
      versionCount: mine.length,
      attackCount: a.length,
      wins: a.filter(x => x.result === 'win').length,
    };
  });
}

export async function getOpponentDetail(id) {
  const opponent = await db.opponents.get(id);
  if (!opponent) return null;
  const versions = (await db.defenses.where('opponentId').equals(id).toArray()).sort((a, b) => b.version - a.version);
  const attacks = await db.attacks.where('opponentId').equals(id).toArray();
  attacks.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  for (const v of versions) v.attacks = attacks.filter(a => a.defenseId === v.id);
  return { opponent, versions };
}

export async function updateOpponent(id, { name, note }) {
  return db.transaction('rw', db.opponents, async () => {
    const o = await db.opponents.get(id);
    if (!o) throw new AppError('not_found', '找不到對手');
    const patch = { updatedAt: now() };
    if (name !== undefined) {
      const n = normalize(name);
      if (!n) throw new AppError('name_required', '請輸入對手名稱');
      const other = await db.opponents.where('nameNorm').equals(n).first();
      if (other && other.id !== id) throw new AppError('name_taken', `已有名為「${other.name}」的對手`);
      patch.name = name.trim(); patch.nameNorm = n;
    }
    if (note !== undefined) patch.note = note;
    await db.opponents.update(id, patch);
  });
}

// ---------- defenses ----------

/** 換陣前檢查：新組合是否與現行或某個舊版本相同。 */
export async function checkDefenseChange(opponentId, slots) {
  const { signature } = team(slots);
  const list = await db.defenses.where('opponentId').equals(opponentId).toArray();
  const same = list.find(d => d.signature === signature);
  if (!same) return { kind: 'new' };
  return same.isCurrent === 1 ? { kind: 'same_as_current', version: same } : { kind: 'matches_old', version: same };
}

async function _setCurrent(opponentId, defenseId, date) {
  const list = await db.defenses.where('opponentId').equals(opponentId).toArray();
  for (const d of list) {
    if (d.id === defenseId) {
      if (d.isCurrent !== 1) await db.defenses.update(d.id, { isCurrent: 1, retiredAt: null });
    } else if (d.isCurrent === 1) {
      await db.defenses.update(d.id, { isCurrent: 0, retiredAt: date });
    }
  }
}

/** 換陣：建立新版本（或在 revert=true 且與舊版相同時改回舊版）。回傳現行防禦 id。 */
async function _changeDefense(opponentId, slots, { revert = false, note = '', date = today() } = {}) {
  const t = requireTeam(slots, '防禦');
  const list = await db.defenses.where('opponentId').equals(opponentId).toArray();
  const same = list.find(d => d.signature === t.signature);
  if (same) {
    if (same.isCurrent === 1) return same.id;
    if (!revert) throw new AppError('matches_old', `這和第 ${same.version} 版相同`, same);
    await _setCurrent(opponentId, same.id, date);
    return same.id;
  }
  const version = list.reduce((m, d) => Math.max(m, d.version), 0) + 1;
  const id = await db.defenses.add({ opponentId, version, isCurrent: 0, ...t, note, firstSeen: date, retiredAt: null });
  await _setCurrent(opponentId, id, date);
  return id;
}

export async function changeDefense(opponentId, slots, opts = {}) {
  return db.transaction('rw', db.defenses, db.opponents, async () => {
    const id = await _changeDefense(opponentId, slots, opts);
    await db.opponents.update(opponentId, { updatedAt: now() });
    return id;
  });
}

/** 修正：直接覆寫同一個版本。 */
export async function correctDefense(defenseId, slots, note) {
  const t = requireTeam(slots, '防禦');
  return db.transaction('rw', db.defenses, db.opponents, async () => {
    const d = await db.defenses.get(defenseId);
    if (!d) throw new AppError('not_found', '找不到防禦版本');
    const patch = { ...t };
    if (note !== undefined) patch.note = note;
    await db.defenses.update(defenseId, patch);
    await db.opponents.update(d.opponentId, { updatedAt: now() });
  });
}

export async function setCurrentVersion(defenseId) {
  return db.transaction('rw', db.defenses, db.opponents, async () => {
    const d = await db.defenses.get(defenseId);
    if (!d) throw new AppError('not_found', '找不到防禦版本');
    await _setCurrent(d.opponentId, d.id, today());
    await db.opponents.update(d.opponentId, { updatedAt: now() });
  });
}

// ---------- matches / attacks ----------

/**
 * 新增一場對戰。
 * @param {object} m
 * @param {string} m.opponentName
 * @param {(number|string|null)[]} m.defenseSlots
 * @param {'keep'|'change'} m.defenseMode keep = 沿用現行防禦；change = 對手換陣
 * @param {boolean} [m.revert] 換陣且與舊版相同時，改回舊版
 * @param {(number|string|null)[]} m.attackSlots
 * @param {'win'|'lose'} m.result
 * @param {string} [m.date]
 * @param {string} [m.note]
 * @returns {Promise<{opponentId:number, defenseId:number, attackId:number, created:boolean}>}
 */
export async function saveMatch(m) {
  const name = (m.opponentName || '').trim();
  const nameNorm = normalize(name);
  if (!nameNorm) throw new AppError('name_required', '請輸入對手名稱');
  if (m.result !== 'win' && m.result !== 'lose') throw new AppError('result_required', '請選擇輸贏');
  const atk = requireTeam(m.attackSlots, '攻擊');
  const date = m.date || today();
  return db.transaction('rw', db.opponents, db.defenses, db.attacks, async () => {
    let opp = await db.opponents.where('nameNorm').equals(nameNorm).first();
    let defenseId, created = false;
    if (!opp) {
      const def = requireTeam(m.defenseSlots, '防禦');
      const opponentId = await db.opponents.add({ name, nameNorm, note: '', createdAt: now(), updatedAt: now() });
      defenseId = await db.defenses.add({ opponentId, version: 1, isCurrent: 1, ...def, note: '', firstSeen: date, retiredAt: null });
      opp = { id: opponentId };
      created = true;
    } else if (m.defenseMode === 'change') {
      defenseId = await _changeDefense(opp.id, m.defenseSlots, { revert: !!m.revert, date });
    } else {
      const cur = (await db.defenses.where('opponentId').equals(opp.id).toArray()).find(d => d.isCurrent === 1);
      if (!cur) throw new AppError('no_defense', '這個對手沒有現行防禦');
      defenseId = cur.id;
    }
    const attackId = await db.attacks.add({
      defenseId, opponentId: opp.id, ...atk, result: m.result, date, note: m.note || '', createdAt: now(), updatedAt: now(),
    });
    await db.opponents.update(opp.id, { updatedAt: now() });
    return { opponentId: opp.id, defenseId, attackId, created };
  });
}

export async function getAttack(id) { return db.attacks.get(id); }

export async function updateAttack(id, { slots, result, date, note, defenseId }) {
  return db.transaction('rw', db.attacks, db.defenses, db.opponents, async () => {
    const a = await db.attacks.get(id);
    if (!a) throw new AppError('not_found', '找不到攻擊紀錄');
    const patch = { updatedAt: now() };
    if (slots !== undefined) Object.assign(patch, requireTeam(slots, '攻擊'));
    if (result !== undefined) {
      if (result !== 'win' && result !== 'lose') throw new AppError('result_required', '請選擇輸贏');
      patch.result = result;
    }
    if (date !== undefined) patch.date = date;
    if (note !== undefined) patch.note = note;
    if (defenseId !== undefined && defenseId !== a.defenseId) {
      const d = await db.defenses.get(defenseId);
      if (!d || d.opponentId !== a.opponentId) throw new AppError('bad_version', '只能移到同一個對手的其他版本');
      patch.defenseId = defenseId;
    }
    await db.attacks.update(id, patch);
    await db.opponents.update(a.opponentId, { updatedAt: now() });
  });
}

// ---------- delete & undo ----------
// 每個刪除回傳一個 undo 物件：{ put: {table: rows[]} }，交給 restore() 還原。

export async function deleteAttack(id) {
  return db.transaction('rw', db.attacks, async () => {
    const a = await db.attacks.get(id);
    if (!a) return null;
    await db.attacks.delete(id);
    return { put: { attacks: [a] } };
  });
}

export async function countForDefense(defenseId) { return db.attacks.where('defenseId').equals(defenseId).count(); }

export async function deleteDefense(id) {
  return db.transaction('rw', db.defenses, db.attacks, async () => {
    const d = await db.defenses.get(id);
    if (!d) return null;
    const siblings = await db.defenses.where('opponentId').equals(d.opponentId).toArray();
    if (siblings.length <= 1) throw new AppError('last_version', '這是唯一的版本，請改為刪除對手');
    const atks = await db.attacks.where('defenseId').equals(id).toArray();
    const changed = [];
    if (d.isCurrent === 1) {
      const prev = siblings.filter(x => x.id !== id).sort((a, b) => b.version - a.version)[0];
      changed.push({ ...prev });
      await db.defenses.update(prev.id, { isCurrent: 1, retiredAt: null });
    }
    await db.attacks.bulkDelete(atks.map(a => a.id));
    await db.defenses.delete(id);
    return { put: { defenses: [d, ...changed], attacks: atks } };
  });
}

export async function deleteOpponent(id) {
  return db.transaction('rw', db.opponents, db.defenses, db.attacks, async () => {
    const o = await db.opponents.get(id);
    if (!o) return null;
    const defs = await db.defenses.where('opponentId').equals(id).toArray();
    const atks = await db.attacks.where('opponentId').equals(id).toArray();
    await db.attacks.bulkDelete(atks.map(a => a.id));
    await db.defenses.bulkDelete(defs.map(d => d.id));
    await db.opponents.delete(id);
    return { put: { opponents: [o], defenses: defs, attacks: atks } };
  });
}

export async function restore(undo) {
  if (!undo?.put) return;
  await db.transaction('rw', db.opponents, db.defenses, db.attacks, async () => {
    for (const [table, rows] of Object.entries(undo.put)) if (rows.length) await db[table].bulkPut(rows);
  });
}

// ---------- counts ----------

export async function counts() {
  const [opponents, defenses, attacks, students] = await Promise.all([
    db.opponents.count(), db.defenses.count(), db.attacks.count(), db.students.count(),
  ]);
  return { opponents, defenses, attacks, students };
}

// ---------- backup ----------

export async function exportAll() {
  const [opponents, defenses, attacks, students] = await Promise.all([
    db.opponents.toArray(), db.defenses.toArray(), db.attacks.toArray(), db.students.toArray(),
  ]);
  return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: now(), opponents, defenses, attacks, students };
}

export async function markBackedUp() { await setMeta('lastBackupAt', now()); }

function validateBackup(data) {
  if (!data || data.app !== APP_ID) throw new AppError('bad_file', '這不是本 App 的備份檔');
  if (typeof data.schemaVersion !== 'number') throw new AppError('bad_file', '備份檔缺少版本資訊');
  if (data.schemaVersion > SCHEMA_VERSION) throw new AppError('too_new', '備份檔來自較新版的 App，請先更新 App');
  for (const t of ['opponents', 'defenses', 'attacks']) if (!Array.isArray(data[t])) throw new AppError('bad_file', `備份檔缺少 ${t}`);
  // 之後若 schemaVersion 升級，在這裡把舊格式轉成新格式。
  return data;
}

/** 學生名單：以本機為主，只補上本機沒有的學生（例如備份裡的自訂學生）。 */
async function mergeStudentsFromBackup(students = []) {
  for (const s of students) if (!(await db.students.get(s.id))) await db.students.put(s);
}

/**
 * 匯入備份。
 * replace：清空對手、版本、紀錄後原樣寫入（ID 保留）。
 * merge：對手依名稱、版本依簽章對應，紀錄追加；日期、組合、勝負都相同者跳過。ID 重新編號。
 */
export async function importAll(raw, mode = 'replace') {
  const data = validateBackup(raw);
  return db.transaction('rw', db.opponents, db.defenses, db.attacks, db.students, async () => {
    await mergeStudentsFromBackup(data.students);
    if (mode === 'replace') {
      await Promise.all([db.opponents.clear(), db.defenses.clear(), db.attacks.clear()]);
      await db.opponents.bulkAdd(data.opponents);
      await db.defenses.bulkAdd(data.defenses);
      await db.attacks.bulkAdd(data.attacks);
      return { opponents: data.opponents.length, defenses: data.defenses.length, attacks: data.attacks.length, skipped: 0 };
    }
    const stat = { opponents: 0, defenses: 0, attacks: 0, skipped: 0 };
    const oppMap = new Map(), defMap = new Map();
    for (const o of data.opponents) {
      const nameNorm = normalize(o.name);
      let local = await db.opponents.where('nameNorm').equals(nameNorm).first();
      if (!local) {
        const { id, ...rest } = o;
        const newId = await db.opponents.add({ ...rest, nameNorm });
        local = { id: newId, isNew: true };
        stat.opponents++;
      }
      oppMap.set(o.id, local);
    }
    const byOpp = [...data.defenses].sort((a, b) => a.version - b.version);
    for (const d of byOpp) {
      const local = oppMap.get(d.opponentId);
      if (!local) continue;
      const list = await db.defenses.where('opponentId').equals(local.id).toArray();
      const same = list.find(x => x.signature === d.signature);
      if (same) { defMap.set(d.id, same.id); continue; }
      const { id, ...rest } = d;
      const version = list.reduce((m, x) => Math.max(m, x.version), 0) + 1;
      const isCurrent = local.isNew ? d.isCurrent : 0;
      const newId = await db.defenses.add({ ...rest, opponentId: local.id, version, isCurrent, retiredAt: isCurrent ? null : (d.retiredAt || d.firstSeen || null) });
      defMap.set(d.id, newId);
      stat.defenses++;
    }
    // 確保每個新對手恰有一個現行版本
    for (const local of oppMap.values()) {
      const list = await db.defenses.where('opponentId').equals(local.id).toArray();
      if (list.length && !list.some(x => x.isCurrent === 1)) {
        const top = list.sort((a, b) => b.version - a.version)[0];
        await db.defenses.update(top.id, { isCurrent: 1, retiredAt: null });
      }
    }
    // 本機原有紀錄的「日期 + 組合 + 勝負」計數；備份中的相同紀錄先抵銷這些，多出來的才新增。
    const localKeys = new Map();
    const key = (defenseId, x) => `${defenseId}|${x.date}|${x.signature}|${x.result}`;
    for (const defenseId of new Set(defMap.values())) {
      for (const x of await db.attacks.where('defenseId').equals(defenseId).toArray()) {
        const k = key(defenseId, x);
        localKeys.set(k, (localKeys.get(k) || 0) + 1);
      }
    }
    for (const a of data.attacks) {
      const defenseId = defMap.get(a.defenseId);
      const opp = oppMap.get(a.opponentId);
      if (!defenseId || !opp) continue;
      const k = key(defenseId, a);
      if (localKeys.get(k) > 0) { localKeys.set(k, localKeys.get(k) - 1); stat.skipped++; continue; }
      const { id, ...rest } = a;
      await db.attacks.add({ ...rest, defenseId, opponentId: opp.id });
      stat.attacks++;
    }
    return stat;
  });
}

// ---------- season ----------

/** 換季：清空對手、版本、紀錄；學生名單與設定保留。 */
export async function clearSeason() {
  await db.transaction('rw', db.opponents, db.defenses, db.attacks, db.meta, async () => {
    await Promise.all([db.opponents.clear(), db.defenses.clear(), db.attacks.clear()]);
    await setMeta('seasonStartedAt', now());
  });
}
