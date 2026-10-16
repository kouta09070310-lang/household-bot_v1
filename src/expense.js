// 支出記録：1件ずつ月ごとのキー（exp_YYYY-MM）に保存する
import { addDays, prevYm, dowOf } from "./time.js";

const key = (ym) => `exp_${ym}`;

// 「支出 800」「支出 1,200円 食費 ランチ」を読み取る
// 金額の後の1語目をカテゴリ、残りをメモとして扱う
export function parseExpense(text) {
  const m = text.match(/^支出\s*([\d,]+)\s*円?\s*(.*)$/);
  if (!m) return null;
  const amount = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const [category = "未分類", ...rest] = m[2].trim().split(/\s+/).filter(Boolean);
  return { amount, category, memo: rest.join(" ") };
}

export async function getMonth(env, ym) {
  return JSON.parse((await env.TASKS_KV.get(key(ym))) || "[]");
}

async function putMonth(env, ym, list) {
  await env.TASKS_KV.put(key(ym), JSON.stringify(list));
}

// 月曜始まりの週（今日を含む）の合計
export async function weekTotal(env, jst) {
  const monday = addDays(jst.date, -((dowOf(jst.date) + 6) % 7));
  const months = new Set([jst.ym, monday.slice(0, 7)]);
  let total = 0;
  for (const ym of months) {
    for (const e of await getMonth(env, ym)) {
      if (e.date >= monday && e.date <= jst.date) total += e.amount;
    }
  }
  return total;
}

export async function recordExpense(env, entry, jst) {
  const list = await getMonth(env, jst.ym);
  list.push({ ...entry, date: jst.date, ts: Date.now() });
  await putMonth(env, jst.ym, list);
  const month = list.reduce((s, e) => s + e.amount, 0);
  const week = await weekTotal(env, jst);
  const label = entry.memo ? `${entry.category}・${entry.memo}` : entry.category;
  return `💰 記録したよ！ ¥${yen(entry.amount)}（${label}）\n今週：¥${yen(week)}\n今月：¥${yen(month)}\n\n間違えたら「取消」で消せるよ`;
}

// 直前の1件を取り消す
export async function undoLast(env, jst) {
  for (const ym of [jst.ym, prevYm(jst.ym)]) {
    const list = await getMonth(env, ym);
    if (list.length === 0) continue;
    const last = list.pop();
    await putMonth(env, ym, list);
    return `↩️ 取り消したよ：${last.date.slice(5).replace("-", "/")} ¥${yen(last.amount)}（${last.category}）`;
  }
  return "取り消せる記録がないよ";
}

// 集計：合計・件数・カテゴリ別・日別
export function summarize(entries) {
  const byCategory = {};
  const byDay = {};
  let total = 0;
  for (const e of entries) {
    total += e.amount;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    byDay[e.date] = (byDay[e.date] || 0) + e.amount;
  }
  const categories = Object.entries(byCategory)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  return { total, count: entries.length, categories, byDay };
}

export function yen(n) {
  return n.toLocaleString("ja-JP");
}
