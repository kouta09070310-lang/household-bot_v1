// 月次レポート：LINE用の Flex Message、Webページ（HTML）、CSV を作る
import { summarize, yen } from "./expense.js";
import { fmtHours } from "./shift.js";

const GREEN = "#06C755"; // LINE のブランドカラーに寄せたアクセント
const RED = "#D64545"; // 予算超過
const MAX_ROWS = 6; // LINE のカードに出すカテゴリ数（残りは「その他」にまとめる）

function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 1日平均の分母：今月なら今日まで、過去の月ならその月の日数
function elapsedDays(ym, jst) {
  return ym === jst.ym ? jst.day : daysInMonth(ym);
}

function monthLabel(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${y}年${m}月`;
}

function topCategories(categories) {
  if (categories.length <= MAX_ROWS) return categories;
  const head = categories.slice(0, MAX_ROWS - 1);
  const rest = categories.slice(MAX_ROWS - 1).reduce((s, c) => s + c.amount, 0);
  return [...head, { name: "その他", amount: rest }];
}

// ---------- LINE（Flex Message） ----------
// バイト欄：合計／予算、使った割合のバー、区分ごとの時間と金額
function workFlex(w) {
  const s = w.summary;
  const over = s.remaining < 0;
  const ratio = s.budget > 0 ? Math.min(100, Math.round((s.total / s.budget) * 100)) : 100;
  return [
    { type: "separator", margin: "xl" },
    { type: "text", text: "バイト", size: "sm", color: "#888888", margin: "lg" },
    {
      type: "box",
      layout: "baseline",
      contents: [
        { type: "text", text: `¥${yen(s.total)}`, size: "xl", weight: "bold", flex: 0 },
        { type: "text", text: ` ／ 予算 ¥${yen(s.budget)}`, size: "xs", color: "#888888", margin: "sm" },
      ],
    },
    {
      type: "box",
      layout: "vertical",
      margin: "sm",
      height: "6px",
      cornerRadius: "3px",
      backgroundColor: "#E6E9E7",
      contents: [
        { type: "box", layout: "vertical", contents: [], height: "6px", cornerRadius: "3px", backgroundColor: over ? RED : GREEN, width: `${Math.max(2, ratio)}%` },
      ],
    },
    {
      type: "text",
      text: over ? `⚠️ 予算を ¥${yen(-s.remaining)} 超過` : `残り ¥${yen(s.remaining)}・${fmtHours(s.hours)}働いた`,
      size: "xs",
      color: over ? RED : "#888888",
      margin: "sm",
    },
    ...s.kinds.map((k) => ({
      type: "box",
      layout: "horizontal",
      margin: "sm",
      contents: [
        { type: "text", text: k.name, size: "sm", flex: 2 },
        { type: "text", text: fmtHours(k.hours), size: "sm", color: "#888888", align: "end", flex: 3 },
        { type: "text", text: `¥${yen(k.amount)}`, size: "sm", align: "end", flex: 3 },
      ],
    })),
  ];
}

// work: バイトの集計 { entries, summary }（記録がなければ null）
export function buildFlex(ym, entries, jst, url, work = null) {
  const s = summarize(entries);
  if (s.count === 0 && !work) return `${monthLabel(ym)}の記録はまだないよ\n「支出 800 食費」「バイト」で記録できるよ`;

  const avg = Math.round(s.total / elapsedDays(ym, jst));
  const max = s.categories[0]?.amount || 1;
  const rows = topCategories(s.categories).map((c) => ({
    type: "box",
    layout: "vertical",
    margin: "md",
    spacing: "xs",
    contents: [
      {
        type: "box",
        layout: "horizontal",
        contents: [
          { type: "text", text: c.name, size: "sm", flex: 3, wrap: false },
          { type: "text", text: `¥${yen(c.amount)}`, size: "sm", align: "end", flex: 2 },
        ],
      },
      {
        // 横棒：一番多いカテゴリを100%にした比率
        type: "box",
        layout: "vertical",
        contents: [],
        height: "4px",
        cornerRadius: "2px",
        backgroundColor: GREEN,
        width: `${Math.max(2, Math.round((c.amount / max) * 100))}%`,
      },
    ],
  }));

  const bubble = {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: `${monthLabel(ym)}の支出`, size: "sm", color: "#888888" },
        { type: "text", text: `¥${yen(s.total)}`, size: "xxl", weight: "bold" },
        { type: "text", text: `${s.count}件・1日平均 ¥${yen(avg)}`, size: "xs", color: "#888888" },
        { type: "separator", margin: "lg" },
        ...(rows.length ? rows : [{ type: "text", text: "支出の記録はまだないよ", size: "sm", color: "#888888", margin: "md" }]),
        ...(work ? workFlex(work) : []),
      ],
    },
  };
  if (url) {
    bubble.footer = {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          color: GREEN,
          height: "sm",
          action: { type: "uri", label: "表とグラフを見る", uri: url },
        },
      ],
    };
  }
  return { type: "flex", altText: `${monthLabel(ym)}の支出 ¥${yen(s.total)}${work ? `・バイト ¥${yen(work.summary.total)}` : ""}`, contents: bubble };
}

// ---------- CSV ----------
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// 支出とバイトを1つの表に。「種別」列で見分ける（バイトはカテゴリ欄に区分名）
export function renderCsv(entries, shifts = []) {
  const rows = [
    ...entries.map((e) => ({ ts: e.ts, cells: ["支出", e.date, e.amount, e.category, e.memo, "", ""] })),
    ...shifts.map((e) => ({ ts: e.ts, cells: ["バイト", e.date, e.amount, e.name, "", e.hours, e.rate] })),
  ].sort((a, b) => a.cells[1].localeCompare(b.cells[1]) || a.ts - b.ts);
  const lines = [["種別", "日付", "金額", "カテゴリ・区分", "メモ", "時間", "時給"].map(csvCell).join(",")];
  for (const r of rows) lines.push(r.cells.map(csvCell).join(","));
  // 先頭の BOM で Excel でも文字化けしない
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------- Webページ ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function workHtml(w) {
  const s = w.summary;
  const over = s.remaining < 0;
  const ratio = s.budget > 0 ? Math.min(100, (s.total / s.budget) * 100) : 100;
  const kinds = s.kinds
    .map((k) => `<tr><td>${esc(k.name)}</td><td class="num">${fmtHours(k.hours)}</td><td class="num">¥${yen(k.amount)}</td></tr>`)
    .join("");
  const rows = [...w.entries]
    .sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts)
    .map(
      (e) => `<tr><td>${esc(e.date.slice(5).replace("-", "/"))}</td><td>${esc(e.name)}</td><td class="num">${fmtHours(e.hours)}</td><td class="num">¥${yen(e.amount)}</td></tr>`
    )
    .join("");
  return `<section><h2>バイト</h2>
<div class="cat-head"><span><b class="big">¥${yen(s.total)}</b> ／ 予算 ¥${yen(s.budget)}</span><span class="num">${fmtHours(s.hours)}</span></div>
<div class="track"><div class="bar${over ? " over" : ""}" style="width:${Math.max(1, ratio)}%"></div></div>
<p class="meta${over ? " warn" : ""}" style="margin:6px 0 12px">${over ? `予算を ¥${yen(-s.remaining)} 超えています` : `残り ¥${yen(s.remaining)}`}</p>
<table>${kinds}</table>
<h2 style="margin-top:16px">バイトの明細</h2><table>${rows}</table></section>`;
}

export function renderHtml(ym, entries, jst, csvUrl, work = null) {
  const s = summarize(entries);
  const avg = s.count ? Math.round(s.total / elapsedDays(ym, jst)) : 0;
  const maxCat = s.categories[0]?.amount || 1;
  const days = daysInMonth(ym);
  const maxDay = Math.max(1, ...Object.values(s.byDay));

  const catRows = s.categories
    .map(
      (c) => `<div class="cat">
        <div class="cat-head"><span>${esc(c.name)}</span><span class="num">¥${yen(c.amount)}<small>${Math.round((c.amount / s.total) * 100)}%</small></span></div>
        <div class="track"><div class="bar" style="width:${Math.max(1, (c.amount / maxCat) * 100)}%"></div></div>
      </div>`
    )
    .join("");

  // 日別の縦棒（記録のない日は高さ0）
  const dayBars = Array.from({ length: days }, (_, i) => {
    const date = `${ym}-${String(i + 1).padStart(2, "0")}`;
    const v = s.byDay[date] || 0;
    const label = (i + 1) % 5 === 0 || i === 0 ? i + 1 : "";
    return `<div class="col" title="${i + 1}日 ¥${yen(v)}"><div class="colbar" style="height:${(v / maxDay) * 100}%"></div><span>${label}</span></div>`;
  }).join("");

  const rows = [...entries]
    .sort((a, b) => b.ts - a.ts)
    .map(
      (e) => `<tr><td>${esc(e.date.slice(5).replace("-", "/"))}</td><td>${esc(e.category)}</td><td>${esc(e.memo || "")}</td><td class="num">¥${yen(e.amount)}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${monthLabel(ym)}の支出</title>
<style>
:root{--bg:#f6f7f6;--card:#fff;--ink:#1d2320;--sub:#6b736f;--line:#e3e6e4;--accent:${GREEN};--track:#edf0ee}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1b1f1d;--ink:#e8ece9;--sub:#9aa39e;--line:#2b302d;--track:#262b28}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.5}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:15px;color:var(--sub);font-weight:600;margin:0}
.total{font-size:40px;font-weight:700;letter-spacing:-.02em;margin:2px 0}
.meta{color:var(--sub);font-size:13px;margin:0 0 20px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
h2{font-size:14px;margin:0 0 12px}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.cat{margin-bottom:10px}.cat-head{display:flex;justify-content:space-between;font-size:14px}
.cat-head small{color:var(--sub);margin-left:6px}
.track{height:6px;background:var(--track);border-radius:3px;margin-top:4px}.bar{height:100%;background:var(--accent);border-radius:3px}
.days{display:flex;align-items:flex-end;gap:2px;height:120px}
.col{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
.colbar{width:100%;background:var(--accent);border-radius:2px 2px 0 0;min-height:0}
.col span{font-size:10px;color:var(--sub);height:14px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:8px 4px;border-top:1px solid var(--line)}
td:first-child{color:var(--sub);width:52px}
.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;padding:10px 16px;border-radius:8px;font-size:14px}
.empty{color:var(--sub)}
.big{font-size:20px}.bar.over{background:#d64545}.warn{color:#d64545}
</style></head><body><main>
<h1>${monthLabel(ym)}の支出</h1>
<div class="total num" style="text-align:left">¥${yen(s.total)}</div>
<p class="meta">${s.count}件・1日平均 ¥${yen(avg)}</p>
${s.count === 0 ? '<section class="empty">この月の支出の記録はまだありません。</section>' : `
<section><h2>カテゴリ別</h2>${catRows}</section>
<section><h2>日別</h2><div class="days">${dayBars}</div></section>
<section><h2>明細</h2><table>${rows}</table></section>`}
${work ? workHtml(work) : ""}
<a class="btn" href="${esc(csvUrl)}">CSVをダウンロード</a>
</main></body></html>`;
}
