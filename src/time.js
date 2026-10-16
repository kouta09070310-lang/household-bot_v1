// 日本時間（JST, UTC+9）の扱いをまとめたモジュール
// Workers は UTC で動くので、9時間ずらした Date を UTC として読む

const DAY_MS = 24 * 60 * 60 * 1000;

// 現在の日本時間を分解して返す
export function jstNow(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year,
    month,
    day,
    hour: d.getUTCHours(),
    dow: d.getUTCDay(), // 0=日 1=月 … 6=土
    date: ymd(year, month, day),
    ym: ymKey(year, month),
  };
}

// "YYYY-MM-DD" 形式の文字列を作る
export function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// "YYYY-MM" 形式（月ごとのキーに使う）
export function ymKey(y, m) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

// "YYYY-MM-DD" を n 日ずらす
export function addDays(dateStr, n) {
  const t = Date.parse(dateStr + "T00:00:00Z") + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

// b - a の日数（どちらも "YYYY-MM-DD"）
export function diffDays(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
}

// その日付の曜日（0=日）
export function dowOf(dateStr) {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

// 前の月の "YYYY-MM"
export function prevYm(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? ymKey(y - 1, 12) : ymKey(y, m - 1);
}

// 日付が実在するか（2/30 などを弾く）
export function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  return ymd(y, m, d) === new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

// 表示用 "10/20(火)"
const DOW_JA = ["日", "月", "火", "水", "木", "金", "土"];
export function formatMd(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}(${DOW_JA[dowOf(dateStr)]})`;
}
