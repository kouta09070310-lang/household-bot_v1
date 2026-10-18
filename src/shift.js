// バイトカウンター：働いた時間を区分ごとに記録し、月の予算（上限金額）から残り時間を返す
// 記録は月ごとのキー（shift_YYYY-MM）に1件ずつ。設定は1キー（job_settings）
import { addDays, isValidDate, ymd } from "./time.js";
import { yen } from "./expense.js";

const SETTINGS_KEY = "job_settings";
const PENDING_KEY = "shift_pending";
export const PENDING_TTL = 10 * 60; // 区分を選んでから時間を送るまでの猶予（秒）
const monthKey = (ym) => `shift_${ym}`;

// 公開用の見本。本物の区分名・時給・予算は設定ページ（KV）に入れる
export const DEFAULT_JOB = {
  kinds: [
    { id: "a", name: "区分A", rate: 1000 },
    { id: "b", name: "区分B", rate: 1000 },
    { id: "c", name: "区分C", rate: 1100 },
  ],
  budget: 50000, // 毎月の上限（円）
  monthly: {}, // 月ごとの上書き { "2026-11": 75000 }
};

const LIMITS = { kinds: 5, name: 10, rate: 100000, budget: 10000000, months: 24 };

// 設定ページから届いた値を検証して整える。不正なら Error を投げる
export function validateJob(input) {
  if (!input || typeof input !== "object") throw new Error("バイトの設定の形式が正しくありません");
  const { kinds, budget, monthly } = input;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > LIMITS.kinds) {
    throw new Error(`バイトの区分は1〜${LIMITS.kinds}個にしてください`);
  }
  const ids = new Set();
  const names = new Set();
  const cleanKinds = kinds.map((k, i) => {
    const name = String(k?.name ?? "").trim();
    // 名前は「バイト 区分A 5」のように空白区切りで使うので、空白は禁止
    if (!name || /\s/.test(name) || name.length > LIMITS.name) {
      throw new Error(`${i + 1}つ目の区分名は空白なし${LIMITS.name}文字以内にしてください`);
    }
    if (names.has(name)) throw new Error(`区分名「${name}」が重複しています`);
    names.add(name);
    const rate = Number(k.rate);
    if (!Number.isInteger(rate) || rate <= 0 || rate > LIMITS.rate) throw new Error(`「${name}」の時給が正しくありません`);
    let id = /^[\w-]{1,40}$/.test(k.id || "") ? k.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return { id, name, rate };
  });

  const money = (v, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.budget) throw new Error(`${label}の金額が正しくありません`);
    return n;
  };
  const cleanMonthly = {};
  const entries = Object.entries(monthly || {});
  if (entries.length > LIMITS.months) throw new Error(`月ごとの予算は${LIMITS.months}件までです`);
  for (const [ym, v] of entries) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error(`月の指定「${ym}」が正しくありません`);
    cleanMonthly[ym] = money(v, `${ym}の予算`);
  }
  return { kinds: cleanKinds, budget: money(budget, "毎月の予算"), monthly: cleanMonthly };
}

export async function getJob(env) {
  const raw = await env.TASKS_KV.get(SETTINGS_KEY);
  return raw ? JSON.parse(raw) : structuredClone(DEFAULT_JOB);
}

export async function saveJob(env, input) {
  const clean = validateJob(input);
  await env.TASKS_KV.put(SETTINGS_KEY, JSON.stringify(clean));
  return clean;
}

export const budgetFor = (job, ym) => job.monthly?.[ym] ?? job.budget;

export function findKind(job, name) {
  const n = String(name || "").toLowerCase();
  return job.kinds.find((k) => k.name.toLowerCase() === n) || null;
}

// 「5」「5.5」「5時間」「5h」「5:30」「5時間30分」→ 時間（小数）。読めなければ null
export function parseHours(text) {
  const s = String(text).trim();
  let m = s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{1,2})時間(\d{1,2})分$/);
  if (m) {
    const min = Number(m[2]);
    if (min >= 60) return null;
    return valid(Number(m[1]) + min / 60);
  }
  m = s.match(/^(\d{1,2}(?:\.\d{1,2})?)\s*(?:時間|h|H)?$/);
  if (m) return valid(Number(m[1]));
  m = s.match(/^(\d{1,3})分$/);
  if (m) return valid(Number(m[1]) / 60);
  return null;
}
const valid = (h) => (h > 0 && h <= 24 ? Math.round(h * 60) / 60 : null);

// 勤務日：「昨日」「おととい」「10/31」「10月31日」。書いていなければ今日
// 記録するのは過去の勤務なので、未来の日付は受け付けない。
// ただし1月に「12/31」と書いたときは去年の12月とみなす（60日以内に限る）
export function parseWorkDate(text, today) {
  if (!text) return today;
  if (/^(昨日|きのう)$/.test(text)) return addDays(today, -1);
  if (/^(一昨日|おととい)$/.test(text)) return addDays(today, -2);
  if (/^(今日|きょう)$/.test(text)) return today;
  const m = text.match(/^(\d{1,2})\s*[\/月]\s*(\d{1,2})日?$/);
  if (!m) return null;
  const [y] = today.split("-").map(Number);
  const mo = Number(m[1]);
  const d = Number(m[2]);
  if (isValidDate(y, mo, d) && ymd(y, mo, d) <= today) return ymd(y, mo, d);
  if (isValidDate(y - 1, mo, d) && ymd(y - 1, mo, d) >= addDays(today, -60)) return ymd(y - 1, mo, d);
  return null;
}

// 「バイト 区分A 5.5 10/31」の区分より後ろを読む → { hours, date } / エラー文
export function parseShiftArgs(rest, today) {
  const [h, d, ...extra] = rest;
  const hours = parseHours(h);
  if (hours === null) return { error: "時間は「5」「5.5」「5:30」のように送ってね（24時間まで）" };
  const date = parseWorkDate(d, today);
  if (date === null || extra.length) return { error: "日付は「10/31」「昨日」のように送ってね（未来の日付は不可）" };
  return { hours, date };
}

export async function getShifts(env, ym) {
  return JSON.parse((await env.TASKS_KV.get(monthKey(ym))) || "[]");
}

async function putShifts(env, ym, list) {
  await env.TASKS_KV.put(monthKey(ym), JSON.stringify(list));
}

// 1件記録する。時給は記録した時点の値を一緒に保存する（後で時給を変えても過去は変わらない）
export async function recordShift(env, kind, hours, date) {
  const ym = date.slice(0, 7);
  const entry = {
    id: crypto.randomUUID(),
    date,
    kindId: kind.id,
    name: kind.name,
    hours,
    rate: kind.rate,
    amount: Math.round(hours * kind.rate),
    ts: Date.now(),
  };
  const list = await getShifts(env, ym);
  list.push(entry);
  await putShifts(env, ym, list);
  return { entry, ym };
}

export async function removeShift(env, ym, id) {
  const list = await getShifts(env, ym);
  const hit = list.find((e) => e.id === id);
  if (!hit) return null;
  await putShifts(env, ym, list.filter((e) => e.id !== id));
  return hit;
}

// 集計：合計金額・時間、区分ごと、予算と残り
export function summarizeShifts(entries, job, ym) {
  const byKind = {};
  let total = 0;
  let hours = 0;
  for (const e of entries) {
    total += e.amount;
    hours += e.hours;
    const k = (byKind[e.name] ||= { name: e.name, hours: 0, amount: 0 });
    k.hours += e.hours;
    k.amount += e.amount;
  }
  const budget = budgetFor(job, ym);
  return {
    total,
    hours,
    count: entries.length,
    kinds: Object.values(byKind).sort((a, b) => b.amount - a.amount),
    budget,
    remaining: budget - total,
  };
}

// 時間の表示：5.5 → "5時間30分"
export function fmtHours(h) {
  const min = Math.round(h * 60);
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return mm ? `${hh}時間${mm}分` : `${hh}時間`;
}

// 残りの予算で、あと何時間働けるか（時給ごと。分単位で切り捨て）
export function remainingHoursLines(job, remaining) {
  const byRate = new Map();
  for (const k of job.kinds) byRate.set(k.rate, [...(byRate.get(k.rate) || []), k.name]);
  return [...byRate].map(([rate, names]) => {
    const min = Math.max(0, Math.floor((remaining / rate) * 60));
    return `${names.join("・")}（¥${yen(rate)}）なら ${fmtHours(min / 60)}`;
  });
}

// 今月の状況（記録後の返事と「バイト」への返事で共通）
export function statusText(s, job, ym) {
  const [, m] = ym.split("-").map(Number);
  const head = `${m}月：¥${yen(s.total)}（${fmtHours(s.hours)}）／ 予算 ¥${yen(s.budget)}`;
  if (s.remaining < 0) return `${head}\n⚠️ 予算を ¥${yen(-s.remaining)} 超えています`;
  return `${head}\n残り ¥${yen(s.remaining)}\n${remainingHoursLines(job, s.remaining).map((l) => `・${l}`).join("\n")}`;
}

// 区分を選んでから時間が届くまでの「待ち」状態
export const setPending = (env, kindId) => env.TASKS_KV.put(PENDING_KEY, kindId, { expirationTtl: PENDING_TTL });
export const getPending = (env) => env.TASKS_KV.get(PENDING_KEY);
export const clearPending = (env) => env.TASKS_KV.delete(PENDING_KEY);
