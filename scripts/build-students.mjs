#!/usr/bin/env node
// 產生 data/students.json：合併 SchaleDB 的繁中、日文、英文學生資料，只保留國際服已實裝的學生。
//
// 用法：
//   node scripts/build-students.mjs                 從 schaledb.com 下載
//   node scripts/build-students.mjs --allow-archive 下載失敗時改用 GitHub 封存（2024-08 舊資料）
//   node scripts/build-students.mjs --from-dir DIR  從本機檔案讀取（DIR/students_tw.json 等）
//   STUDENTS_BASE=https://... node scripts/build-students.mjs   指定資料來源網址
//
// 需要 Node.js 18 以上（內建 fetch）。資料有變動才會改寫檔案。

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'students.json');

// 資料來源：依序嘗試。{base}/{lang}/students.min.json
// GitHub 儲存庫已於 2025-06 封存，資料停在 2024-08；只有加上 --allow-archive 才會使用，
// 避免排程執行時用舊資料蓋掉較新的名單。
const ARCHIVE = { base: 'https://raw.githubusercontent.com/SchaleDB/SchaleDB/main/data', label: 'SchaleDB GitHub 封存（2024-08，資料可能過舊）' };
const SOURCES = process.env.STUDENTS_BASE
  ? [{ base: process.env.STUDENTS_BASE, label: process.env.STUDENTS_BASE }]
  : [
      { base: 'https://schaledb.com/data', label: 'SchaleDB (schaledb.com)' },
      ...(process.argv.includes('--allow-archive') ? [ARCHIVE] : []),
    ];

// 每個語言可能的資料夾名稱（新網站若改名，可在這裡加入候選）
const LANGS = { zh: ['tw'], ja: ['jp', 'ja'], en: ['en'] };

// 伺服器在 IsReleased 陣列中的位置：[日服, 國際服, 國服]
const GLOBAL_INDEX = 1;

// ---- 欄位對應：SchaleDB 改格式時只需修改這個函式 ----
function readStudent(raw) {
  const role = raw.SquadType === 'Main' ? 'striker' : raw.SquadType === 'Support' ? 'special' : null;
  return {
    id: raw.Id,
    name: raw.Name,
    role,
    globalReleased: Array.isArray(raw.IsReleased) ? raw.IsReleased[GLOBAL_INDEX] === true : null,
  };
}

function toList(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') return Object.values(json);
  throw new Error('無法辨識的資料格式');
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ba-pvp-tracker student list builder' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function loadFromNetwork() {
  const errors = [];
  for (const src of SOURCES) {
    try {
      const out = {};
      for (const [key, candidates] of Object.entries(LANGS)) {
        let lastErr;
        for (const lang of candidates) {
          try { out[key] = toList(await fetchJson(`${src.base}/${lang}/students.min.json`)); break; }
          catch (e) { lastErr = e; }
        }
        if (!out[key]) throw lastErr;
      }
      return { data: out, source: src.label };
    } catch (e) {
      errors.push(`${src.label}: ${e.message}`);
      console.warn(`無法從 ${src.label} 取得資料：${e.message}`);
    }
  }
  throw new Error('所有資料來源都失敗：\n' + errors.join('\n'));
}

async function loadFromDir(dir) {
  const out = {};
  for (const key of Object.keys(LANGS)) {
    const file = { zh: 'students_tw.json', ja: 'students_jp.json', en: 'students_en.json' }[key];
    out[key] = toList(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
  }
  return { data: out, source: `本機檔案 ${dir}` };
}

function build({ zh, ja, en }) {
  const jaById = new Map(ja.map(r => [readStudent(r).id, readStudent(r)]));
  const enById = new Map(en.map(r => [readStudent(r).id, readStudent(r)]));
  const students = [];
  const problems = [];
  for (const raw of zh) {
    const s = readStudent(raw);
    if (s.globalReleased === null) problems.push(`${s.id} 缺少 IsReleased`);
    if (!s.globalReleased) continue;
    if (!s.role) problems.push(`${s.id} 無法辨識 SquadType`);
    const j = jaById.get(s.id), e = enById.get(s.id);
    if (!s.name || !j?.name || !e?.name) problems.push(`${s.id} 缺少某個語言的名字`);
    students.push({ id: s.id, zh: s.name, ja: j?.name ?? '', en: e?.name ?? '', role: s.role });
  }
  students.sort((a, b) => a.id - b.id);
  if (students.length < 50) problems.push(`只找到 ${students.length} 位國際服學生，數量異常`);
  return { students, problems };
}

async function main() {
  const dirArg = process.argv.indexOf('--from-dir');
  const { data, source } = dirArg > -1 ? await loadFromDir(process.argv[dirArg + 1]) : await loadFromNetwork();
  const { students, problems } = build(data);
  if (problems.length) {
    console.error('資料檢查失敗，未寫入檔案：\n' + problems.slice(0, 20).join('\n'));
    process.exit(1);
  }

  const hash = createHash('sha256').update(JSON.stringify(students)).digest('hex').slice(0, 12);
  let old = null;
  try { old = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  if (old?.version === hash) {
    console.log(`學生名單沒有變動（${students.length} 位），不改寫檔案。`);
    return;
  }
  const out = { version: hash, generatedAt: new Date().toISOString(), source, count: students.length, students };
  await writeFile(OUT, JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{') + '\n');
  console.log(`已寫入 ${students.length} 位學生（來源：${source}，版本 ${hash}）。`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
