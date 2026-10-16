// 予定の設定ページ：LINE で「予定設定」と送った本人にだけ、30分有効のリンクを発行する
import { DOW_JA } from "./schedule.js";

export const LINK_TTL = 30 * 60; // 秒
const tokenKey = (t) => `settings_token_${t}`;

// 使い捨てではなく「30分だけ有効」。期限は KV の expirationTtl に任せる
export async function issueSettingsToken(env) {
  const t = crypto.randomUUID().replace(/-/g, "");
  await env.TASKS_KV.put(tokenKey(t), "1", { expirationTtl: LINK_TTL });
  return t;
}

export async function isValidSettingsToken(env, t) {
  if (!/^[0-9a-f]{32}$/.test(t || "")) return false;
  return Boolean(await env.TASKS_KV.get(tokenKey(t)));
}

// JSON を <script> に埋め込むときに </script> で閉じられないようにする
const embed = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");

export function renderSettings(schedule, token) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>予定の設定</title>
<style>
:root{--bg:#f6f7f6;--card:#fff;--ink:#1d2320;--sub:#6b736f;--line:#e3e6e4;--accent:#06C755;--danger:#d64545;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121513;--card:#1b1f1d;--ink:#e8ece9;--sub:#9aa39e;--line:#2b302d;--field:#232825}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;line-height:1.5}
main{max-width:640px;margin:0 auto;padding:24px 16px 120px}
h1{font-size:20px;margin:0 0 4px}.lead{color:var(--sub);font-size:13px;margin:0 0 20px}
h2{font-size:14px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.row:first-child{margin-top:0}
label.t{font-size:12px;color:var(--sub);width:100%}
input[type=text],select{font:inherit;color:inherit;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
input.emoji{width:56px;text-align:center}input.name{flex:1;min-width:0}input.memo{width:100%}
.days{display:flex;gap:4px}
.days label{display:block}.days input{position:absolute;opacity:0;pointer-events:none}
.days span{display:inline-flex;width:36px;height:36px;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:50%;font-size:14px;cursor:pointer}
.days input:checked+span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.days input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.chk{display:flex;gap:6px;align-items:center;font-size:14px}
button{font:inherit;border-radius:8px;padding:9px 14px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
button.del{color:var(--danger);border-color:transparent;background:none;margin-left:auto;padding:6px 8px}
button.add{width:100%;border-style:dashed}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px}
.bar div{max-width:640px;margin:0 auto;display:flex;gap:12px;align-items:center}
.save{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;padding:10px 20px}
#msg{font-size:13px;color:var(--sub)}#msg.err{color:var(--danger)}
</style></head><body><main>
<h1>予定の設定</h1>
<p class="lead">このリンクは発行から30分有効です。保存するとすぐ通知に反映されます。</p>
<h2>毎週の予定</h2>
<div id="weekly"></div>
<button class="add" id="add" type="button">＋ 予定を追加</button>
<h2>平日朝6時の小さなタスク</h2>
<div class="card" id="morning"></div>
</main>
<div class="bar"><div><button class="save" id="save" type="button">保存</button><span id="msg" role="status"></span></div></div>
<script id="data" type="application/json">${embed(schedule)}</script>
<script>
const TOKEN = ${embed(token)};
const DOW = ${embed(DOW_JA)};
const state = JSON.parse(document.getElementById("data").textContent);
const $ = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k in el ? (el[k] = v) : el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const HOURS = [["", "当日通知なし"], ...Array.from({ length: 24 }, (_, h) => [String(h), "当日 " + h + "時"])];

function card(w, i) {
  const bind = (key) => (e) => { w[key] = e.target.value; };
  const days = $("div", { className: "days" }, ...DOW.map((d, n) => {
    const cb = $("input", { type: "checkbox", checked: w.days.includes(n), "aria-label": d + "曜" });
    cb.onchange = () => { w.days = cb.checked ? [...w.days, n] : w.days.filter((x) => x !== n); };
    return $("label", {}, cb, $("span", {}, d));
  }));
  const hour = $("select", { "aria-label": "当日の通知時刻" }, ...HOURS.map(([v, t]) => $("option", { value: v, selected: String(w.hour ?? "") === v }, t)));
  hour.onchange = () => { w.hour = hour.value === "" ? null : Number(hour.value); };
  const eve = $("input", { type: "checkbox", checked: w.eve });
  eve.onchange = () => { w.eve = eve.checked; };
  const del = $("button", { type: "button", className: "del" }, "削除");
  del.onclick = () => { state.weekly.splice(i, 1); draw(); };
  return $("div", { className: "card" },
    $("div", { className: "row" },
      $("input", { type: "text", className: "emoji", value: w.emoji, oninput: bind("emoji"), "aria-label": "絵文字" }),
      $("input", { type: "text", className: "name", value: w.name, placeholder: "例：燃えるゴミの日", oninput: bind("name"), "aria-label": "名前" }),
      del),
    $("div", { className: "row" }, days),
    $("div", { className: "row" }, $("label", { className: "chk" }, eve, "前日21時に予告"),
      $("input", { type: "text", className: "memo", value: w.eveMemo, placeholder: "前日のひとこと（任意）", oninput: bind("eveMemo") })),
    $("div", { className: "row" }, hour,
      $("input", { type: "text", className: "memo", value: w.memo, placeholder: "当日のひとこと（任意）", oninput: bind("memo") })));
}

function draw() {
  document.getElementById("weekly").replaceChildren(...state.weekly.map(card));
  document.getElementById("morning").replaceChildren(...[1, 2, 3, 4, 5].map((d) =>
    $("div", { className: "row" }, $("label", { className: "t" }, DOW[d] + "曜"),
      $("input", { type: "text", className: "memo", value: state.morning[d] || "", oninput: (e) => { state.morning[d] = e.target.value; } }))));
}

document.getElementById("add").onclick = () => {
  state.weekly.push({ emoji: "🔔", name: "", days: [], eve: true, eveMemo: "", hour: null, memo: "" });
  draw();
  document.querySelectorAll("input.name")[state.weekly.length - 1].focus();
};

document.getElementById("save").onclick = async () => {
  const msg = document.getElementById("msg");
  msg.className = ""; msg.textContent = "保存中…";
  try {
    const res = await fetch("/settings?t=" + TOKEN, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "保存できませんでした");
    Object.assign(state, out.schedule); draw();
    msg.textContent = "保存しました ✓";
  } catch (e) { msg.className = "err"; msg.textContent = e.message; }
};
draw();
</script></body></html>`;
}
