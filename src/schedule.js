// 曜日ごとの予定：KV（キー "schedule"）に保存し、設定ページから編集する
// ここにあるのは KV が空のときに使う「見本」の初期値

export const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
const KEY = "schedule";

export const DEFAULT_SCHEDULE = {
  weekly: [
    { id: "garbage", emoji: "🗑️", name: "燃えるゴミの日", days: [2, 5], eve: true, eveMemo: "今夜のうちにまとめておこう", hour: null, memo: "" },
    { id: "recycle", emoji: "♻️", name: "資源ゴミの日", days: [3], eve: true, eveMemo: "ペットボトルと缶をまとめておこう", hour: null, memo: "" },
    { id: "bath", emoji: "🛁", name: "風呂洗いの日", days: [3, 6], eve: false, eveMemo: "", hour: 21, memo: "5分あればできるよ" },
    { id: "weekend", emoji: "💪", name: "週末の掃除", days: [6], eve: true, eveMemo: "時間を作っておいてね", hour: 10, memo: "トイレ掃除（5分）・掃除機（10分）" },
  ],
  // 平日朝6時の小さなタスク（1=月 … 5=金）
  morning: {
    1: "床に置いてあるものを1つ定位置に戻す🧹",
    2: "机の上を30秒片付ける📋",
    3: "ゴミ箱をまとめてゴミ袋に入れる🗑️",
    4: "クローゼットを1箇所だけ整理する👕",
    5: "埃を1箇所だけ拭く✨",
  },
};

const LIMITS = { items: 30, name: 30, emoji: 8, memo: 100 };

// 設定ページから届いた値を検証して整える。不正なら Error を投げる
export function validateSchedule(input) {
  if (!input || typeof input !== "object") throw new Error("形式が正しくありません");
  const { weekly, morning } = input;
  if (!Array.isArray(weekly) || weekly.length > LIMITS.items) throw new Error(`予定は${LIMITS.items}件までです`);

  const str = (v, max, label) => {
    const s = String(v ?? "").trim();
    if (s.length > max) throw new Error(`${label}は${max}文字までです`);
    return s;
  };
  const ids = new Set();
  const items = weekly.map((w, i) => {
    const name = str(w?.name, LIMITS.name, "名前");
    if (!name) throw new Error(`${i + 1}件目の名前が空です`);
    const days = [...new Set((w.days || []).map(Number))].sort();
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error(`「${name}」の曜日を1つ以上選んでください`);
    }
    const hour = w.hour === null || w.hour === "" || w.hour === undefined ? null : Number(w.hour);
    if (hour !== null && !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) throw new Error(`「${name}」の時刻が正しくありません`);
    if (!w.eve && hour === null) throw new Error(`「${name}」は前日予告か当日の時刻のどちらかを設定してください`);
    let id = /^[\w-]{1,40}$/.test(w.id || "") ? w.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    return {
      id,
      emoji: str(w.emoji, LIMITS.emoji, "絵文字") || "🔔",
      name,
      days,
      eve: Boolean(w.eve),
      eveMemo: str(w.eveMemo, LIMITS.memo, "前日メモ"),
      hour,
      memo: str(w.memo, LIMITS.memo, "当日メモ"),
    };
  });

  const m = {};
  for (let d = 1; d <= 5; d++) m[d] = str(morning?.[d], LIMITS.memo, "朝のタスク");
  return { weekly: items, morning: m };
}

export async function getSchedule(env) {
  const raw = await env.TASKS_KV.get(KEY);
  return raw ? JSON.parse(raw) : structuredClone(DEFAULT_SCHEDULE);
}

export async function saveSchedule(env, input) {
  const clean = validateSchedule(input);
  await env.TASKS_KV.put(KEY, JSON.stringify(clean));
  return clean;
}

const daysLabel = (days) => days.map((d) => DOW_JA[d]).join("・");
const line = (w, memo) => `${w.emoji} ${w.name}${memo ? `\n　${memo}` : ""}`;

// 前日21時に予告する予定（明日が該当日のもの）
export function eveItems(s, dow) {
  const tomorrow = (dow + 1) % 7;
  return s.weekly.filter((w) => w.eve && w.days.includes(tomorrow));
}

// その時刻に当日通知する予定
export function dueItems(s, dow, hour) {
  return s.weekly.filter((w) => w.hour === hour && w.days.includes(dow));
}

export function formatEve(items) {
  return items.map((w) => line(w, w.eveMemo)).join("\n");
}

export function formatDue(items) {
  return items.map((w) => line(w, w.memo)).join("\n");
}

// LINE の「予定」への返信
export function listSchedule(s) {
  if (s.weekly.length === 0) return "定期の予定は登録されていないよ\n「予定設定」で追加できるよ";
  const lines = s.weekly.map((w) => {
    const when = [w.eve ? "前日21時" : "", w.hour !== null ? `当日${w.hour}時` : ""].filter(Boolean).join("・");
    return `${w.emoji} ${w.name}\n　${daysLabel(w.days)}曜（${when}）`;
  });
  return `📅 定期の予定\n\n${lines.join("\n")}\n\n変更は「予定設定」と送ってね`;
}
