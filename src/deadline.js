// 締め切り管理：登録・一覧・削除・リマインド
import { addDays, diffDays, isValidDate, ymd, formatMd } from "./time.js";

const KEY = "deadlines";
const DOW = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

// 文章から締め切り日を読み取る。読めなければ null
// today: "YYYY-MM-DD", dow: 今日の曜日(0=日)
export function parseDue(text, today, dow) {
  const [ty, tm, td] = today.split("-").map(Number);

  if (/明後日|あさって/.test(text)) return addDays(today, 2);
  if (/明日|あした/.test(text)) return addDays(today, 1);
  if (/今日|きょう/.test(text)) return today;

  // 「10/20」「10月20日」→ 過ぎていたら来年
  let m = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (!isValidDate(ty, mo, d) && !isValidDate(ty + 1, mo, d)) return null;
    let due = isValidDate(ty, mo, d) ? ymd(ty, mo, d) : ymd(ty + 1, mo, d);
    if (due < today) due = ymd(ty + 1, mo, d);
    return due;
  }

  // 「20日」だけ → 今月。過ぎていたら来月
  m = text.match(/(?<![\d\/月])(\d{1,2})日/);
  if (m) {
    const d = Number(m[1]);
    for (let i = 0; i < 3; i++) {
      const y = ty + Math.floor((tm - 1 + i) / 12);
      const mo = ((tm - 1 + i) % 12) + 1;
      if (isValidDate(y, mo, d) && ymd(y, mo, d) >= today) return ymd(y, mo, d);
    }
    return null;
  }

  // 「金曜」「来週の月曜」
  m = text.match(/(来週の?)?(月|火|水|木|金|土|日)曜/);
  if (m) {
    const target = DOW[m[2]];
    if (m[1]) {
      // 来週 = 次の月曜から始まる週
      const monIdx = (dow + 6) % 7; // 月曜=0 に直す
      const nextMon = addDays(today, 7 - monIdx);
      return addDays(nextMon, (target + 6) % 7);
    }
    return addDays(today, (target - dow + 7) % 7); // 今日が金曜なら今日
  }
  return null;
}

async function load(env) {
  return JSON.parse((await env.TASKS_KV.get(KEY)) || "[]");
}

async function save(env, list) {
  await env.TASKS_KV.put(KEY, JSON.stringify(list));
}

// 締め切り日順（日付なしは最後）
function sorted(list) {
  return [...list].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || (a.created || 0) - (b.created || 0));
}

export async function addDeadline(env, content, jst) {
  const due = parseDue(content, jst.date, jst.dow);
  const list = await load(env);
  // ID は Date.now() だと同じミリ秒の登録で重複し、削除で2件消えるため UUID にする
  list.push({ id: crypto.randomUUID(), content, due, created: Date.now() });
  await save(env, list);
  if (!due) {
    return `📝 登録したよ！\n「${content}」\n\n⚠️ 日付が読み取れなかったので通知はしないよ\n「金曜まで」「10/20まで」「明日まで」みたいに書くと通知できるよ`;
  }
  const left = diffDays(jst.date, due);
  return `📝 登録したよ！\n「${content}」\n締め切り：${formatMd(due)}（あと${left}日）\n\n3日前・前日・当日の朝8時に知らせるね`;
}

export async function listDeadlines(env, jst) {
  const list = sorted(await load(env));
  if (list.length === 0) return "締め切りは何も登録されていないよ✨";
  const lines = list.map((d, i) => {
    if (!d.due) return `${i + 1}. ${d.content}（日付なし）`;
    const left = diffDays(jst.date, d.due);
    const tag = left < 0 ? "⚠️期限切れ" : left === 0 ? "🔥今日" : `あと${left}日`;
    return `${i + 1}. ${d.content}\n　→ ${formatMd(d.due)} ${tag}`;
  });
  return `📋 締め切り一覧\n\n${lines.join("\n")}\n\n終わったら「削除 1」みたいに番号で消してね`;
}

// 一覧の表示順と同じ番号で削除する
export async function deleteDeadline(env, n) {
  const list = sorted(await load(env));
  const target = list[n - 1];
  if (!target) return `${n}番は無いよ。「締め切り」で番号を確認してね`;
  await save(env, list.filter((d) => d.id !== target.id));
  return `🗑️「${target.content}」を消したよ。おつかれさま！`;
}

// 毎朝8時に呼ばれる。3日前・前日・当日に1回ずつ通知
export async function deadlineReminders(env, jst) {
  const list = await load(env);
  const out = [];
  for (const d of list) {
    if (!d.due) continue;
    const left = diffDays(jst.date, d.due);
    const msg =
      left === 3 ? `⏰ 締め切り3日前！\n「${d.content}」（${formatMd(d.due)}）\n進んでる？`
      : left === 1 ? `🚨 締め切りは明日！\n「${d.content}」\n今日中に目処をつけよう`
      : left === 0 ? `🔥 今日が締め切り！\n「${d.content}」\n終わったら「削除」で消してね`
      : null;
    if (!msg) continue;
    const key = `remind_${d.id}_${left}`;
    if (await env.TASKS_KV.get(key)) continue; // 同じ通知を2回送らない
    await env.TASKS_KV.put(key, "1", { expirationTtl: 60 * 60 * 24 * 10 });
    out.push(msg);
  }
  return out;
}
