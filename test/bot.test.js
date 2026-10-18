// 動作確認テスト：node --test で実行（LINE には何も送らない）
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { runScheduled } from "../src/index.js";
import { parseDue } from "../src/deadline.js";
import { parseExpense } from "../src/expense.js";
import { jstNow } from "../src/time.js";
import { reportToken } from "../src/line.js";
import { validateSchedule, DEFAULT_SCHEDULE } from "../src/schedule.js";
import { DEFAULT_JOB, parseHours, parseWorkDate, validateJob, remainingHoursLines } from "../src/shift.js";

const SECRET = "test-channel-secret";

// KV の代わり（メモリ上の Map）
function memoryKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    _m: m,
  };
}

let env, sent;
beforeEach(() => {
  env = { TASKS_KV: memoryKV(), LINE_TOKEN: "x", LINE_CHANNEL_SECRET: SECRET, MY_USER_ID: "U1" };
  sent = [];
  // LINE API への送信を横取りして記録する
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
});

async function sign(body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...sig));
}

// LINE からテキストが届いたことにして、返信の中身を返す
async function say(text) {
  sent = [];
  const body = JSON.stringify({ events: [{ type: "message", replyToken: "r", source: { userId: "U1" }, message: { type: "text", text } }] });
  const res = await worker.fetch(
    new Request("https://bot.example.workers.dev/webhook", { method: "POST", body, headers: { "x-line-signature": await sign(body) } }),
    env
  );
  assert.equal(res.status, 200);
  return sent[0].body.messages[0];
}

// ---- 署名検証 ----
test("署名が無い・違うリクエストは 401 で拒否", async () => {
  const body = JSON.stringify({ events: [] });
  const bad = await worker.fetch(new Request("https://x/webhook", { method: "POST", body, headers: { "x-line-signature": "AAAA" } }), env);
  assert.equal(bad.status, 401);
  const none = await worker.fetch(new Request("https://x/webhook", { method: "POST", body }), env);
  assert.equal(none.status, 401);
});

test("シークレット未設定なら受け付けない", async () => {
  delete env.LINE_CHANNEL_SECRET;
  const res = await worker.fetch(new Request("https://x/webhook", { method: "POST", body: "{}" }), env);
  assert.equal(res.status, 500);
});

test("/test エンドポイントは廃止", async () => {
  await worker.fetch(new Request("https://x/test"), env);
  assert.equal(sent.length, 0);
});

// ---- 締め切りの日付読み取り（2026-10-15 木曜を今日とする） ----
test("締め切り日の読み取り", () => {
  const T = "2026-10-15", D = 4;
  assert.equal(parseDue("レポート 金曜まで", T, D), "2026-10-16");
  assert.equal(parseDue("木曜まで", T, D), "2026-10-15");
  assert.equal(parseDue("水曜まで", T, D), "2026-10-21");
  assert.equal(parseDue("来週の月曜", T, D), "2026-10-19");
  assert.equal(parseDue("来週金曜", T, D), "2026-10-23");
  assert.equal(parseDue("10/20まで", T, D), "2026-10-20");
  assert.equal(parseDue("11月3日", T, D), "2026-11-03");
  assert.equal(parseDue("1/10", T, D), "2027-01-10");
  assert.equal(parseDue("20日まで", T, D), "2026-10-20");
  assert.equal(parseDue("10日まで", T, D), "2026-11-10");
  assert.equal(parseDue("明日まで", T, D), "2026-10-16");
  assert.equal(parseDue("2/30", T, D), null);
  assert.equal(parseDue("そのうち", T, D), null);
});

test("締め切り：登録→一覧→削除", async () => {
  const r1 = await say("追加: レポート提出 明日まで");
  assert.match(r1.text, /あと1日/);
  await say("追加：ゼミ資料 来週の月曜");
  await say("追加: 部屋の模様替え");
  const list = (await say("締め切り")).text;
  // 日付の近い順、日付なしは最後
  assert.ok(list.indexOf("レポート提出") < list.indexOf("ゼミ資料"));
  assert.ok(list.indexOf("ゼミ資料") < list.indexOf("部屋の模様替え"));
  assert.match((await say("削除 1")).text, /レポート提出/);
  assert.doesNotMatch((await say("締め切り")).text, /レポート提出/);
  assert.match((await say("削除 9")).text, /無いよ/);
  assert.match((await say("削除　２")).text, /部屋の模様替え/); // 全角も可
});

test("締め切りリマインド：3日前・前日・当日に1回ずつ", async () => {
  const today = jstNow();
  env.TASKS_KV._m.set("deadlines", JSON.stringify([
    { id: 1, content: "A", due: addDaysStr(today.date, 3) },
    { id: 2, content: "B", due: addDaysStr(today.date, 1) },
    { id: 3, content: "C", due: addDaysStr(today.date, 2) },
  ]));
  await runScheduled(env, { ...today, hour: 8 });
  const texts = sent.map((s) => s.body.messages[0].text).filter((t) => t.includes("締め切り"));
  assert.equal(texts.length, 2);
  sent = [];
  await runScheduled(env, { ...today, hour: 8 }); // 2回目は送らない
  assert.equal(sent.filter((s) => s.body.messages[0].text?.includes("締め切り")).length, 0);
});

function addDaysStr(d, n) {
  return new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}

// ---- 支出 ----
test("支出の読み取り", () => {
  assert.deepEqual(parseExpense("支出 800"), { amount: 800, category: "未分類", memo: "" });
  assert.deepEqual(parseExpense("支出 1,200円 食費 ランチ 学食"), { amount: 1200, category: "食費", memo: "ランチ 学食" });
  assert.equal(parseExpense("支出 abc"), null);
  assert.equal(parseExpense("支出 0"), null);
});

test("支出：記録→取消→今月（Flex）", async () => {
  assert.match((await say("支出 800 食費 ランチ")).text, /今月：¥800/);
  assert.match((await say("支出 ３５００ 交通")).text, /今月：¥4,300/);
  assert.match((await say("取消")).text, /3,500/);
  await say("支出 1200 日用品");
  const flex = await say("今月");
  assert.equal(flex.type, "flex");
  assert.match(flex.altText, /¥2,000/);
  // ボタンのリンクに合言葉が付いている
  const uri = flex.contents.footer.contents[0].action.uri;
  assert.match(uri, /^https:\/\/bot\.example\.workers\.dev\/report\/\d{4}-\d{2}\?t=[0-9a-f]{24}$/);
  assert.match((await say("先月")).text, /まだないよ/);
});

test("レポートページ：合言葉なしは404、ありならHTMLとCSV", async () => {
  await say("支出 800 食費 \"ランチ\"");
  const ym = jstNow().ym;
  const t = await reportToken(SECRET, ym);
  assert.equal((await worker.fetch(new Request(`https://x/report/${ym}`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://x/report/${ym}?t=wrong`), env)).status, 404);
  const html = await (await worker.fetch(new Request(`https://x/report/${ym}?t=${t}`), env)).text();
  assert.match(html, /¥800/);
  assert.match(html, /&quot;ランチ&quot;/); // HTML エスケープ
  const csvRes = await worker.fetch(new Request(`https://x/report/${ym}.csv?t=${t}`), env);
  assert.match(csvRes.headers.get("content-type"), /text\/csv/);
  const bytes = new Uint8Array(await csvRes.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // BOM（.text() だと消えるのでバイトで確認）
  const csv = new TextDecoder().decode(bytes);
  assert.ok(csv.startsWith("\"種別\",\"日付\",\"金額\""));
  assert.match(csv, /"800","食費","""ランチ"""/);
});

test("月末22時に月次レポートを1回だけ送る", async () => {
  await say("支出 500 食費");
  const jst = jstNow();
  const lastDay = { ...jst, hour: 22, date: lastDate(jst), day: Number(lastDate(jst).slice(8)), dow: 9 };
  sent = [];
  await runScheduled(env, lastDay);
  assert.equal(sent.filter((s) => s.body.messages[0].type === "flex").length, 1);
  sent = [];
  await runScheduled(env, lastDay);
  assert.equal(sent.filter((s) => s.body.messages[0].type === "flex").length, 0);
  // 月末以外の日は送らない
  sent = [];
  await runScheduled(env, { ...jst, hour: 22, date: `${jst.ym}-10`, day: 10, dow: 9 });
  assert.equal(sent.filter((s) => s.body.messages[0].type === "flex").length, 0);
});

function lastDate(jst) {
  const d = new Date(Date.UTC(jst.year, jst.month, 0));
  return d.toISOString().slice(0, 10);
}

// ---- 締め切りID ----
test("同じミリ秒に登録しても締め切りIDが重複しない", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000; // 時刻を固定
  try {
    await say("追加: A 明日まで");
    await say("追加: B 明日まで");
  } finally {
    Date.now = realNow;
  }
  const list = JSON.parse(env.TASKS_KV._m.get("deadlines"));
  assert.notEqual(list[0].id, list[1].id);
  await say("削除 1");
  assert.equal(JSON.parse(env.TASKS_KV._m.get("deadlines")).length, 1); // 1件だけ消える
});

// ---- 予定 ----
test("予定の検証：不正な値を弾く", () => {
  const ok = validateSchedule(DEFAULT_SCHEDULE);
  assert.equal(ok.weekly.length, DEFAULT_SCHEDULE.weekly.length);
  const bad = (w) => () => validateSchedule({ weekly: [{ name: "x", days: [1], eve: true, hour: null, ...w }], morning: {} });
  assert.throws(bad({ name: "" }), /名前が空/);
  assert.throws(bad({ days: [] }), /曜日/);
  assert.throws(bad({ days: [7] }), /曜日/);
  assert.throws(bad({ hour: 24, eve: false }), /時刻/);
  assert.throws(bad({ eve: false, hour: null }), /どちらか/);
  assert.throws(bad({ memo: "あ".repeat(101) }), /100文字/);
  assert.throws(() => validateSchedule({ weekly: Array(31).fill({ name: "x", days: [1], eve: true }), morning: {} }), /30件/);
});

test("21時の通知は1通にまとめる（予告・今夜・支出）", async () => {
  const jst = jstNow();
  // 見本：水曜21時 → 明日(木)は無し、今夜は風呂洗い。火曜21時 → 明日(水)は資源ゴミ
  sent = [];
  await runScheduled(env, { ...jst, hour: 21, dow: 2, day: 10 });
  assert.equal(sent.length, 1);
  const text = sent[0].body.messages[0].text;
  assert.match(text, /【明日】[\s\S]*資源ゴミ/);
  assert.match(text, /今日いくら使った/);
  assert.doesNotMatch(text, /【今夜】/);
  sent = [];
  await runScheduled(env, { ...jst, hour: 21, dow: 3, day: 10 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.messages[0].text, /【今夜】[\s\S]*風呂洗い/);
});

test("当日通知は設定した時刻に送る", async () => {
  const jst = jstNow();
  sent = [];
  await runScheduled(env, { ...jst, hour: 10, dow: 6, day: 10 }); // 見本：土曜10時に週末の掃除
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.messages[0].text, /週末の掃除/);
  sent = [];
  await runScheduled(env, { ...jst, hour: 11, dow: 6, day: 10 });
  assert.equal(sent.length, 0);
});

test("予定設定：本人だけにリンク、期限切れ・不正トークンは404、保存で反映", async () => {
  // 本人以外
  const other = JSON.stringify({ events: [{ type: "message", replyToken: "r", source: { userId: "U_other" }, message: { type: "text", text: "予定設定" } }] });
  sent = [];
  await worker.fetch(new Request("https://bot.example.workers.dev/webhook", { method: "POST", body: other, headers: { "x-line-signature": await sign(other) } }), env);
  assert.match(sent[0].body.messages[0].text, /登録したユーザーだけ/);

  // 本人
  const link = (await say("予定設定")).text.match(/https:\S+/)[0];
  const t = new URL(link).searchParams.get("t");
  assert.match(link, /^https:\/\/bot\.example\.workers\.dev\/settings\?t=[0-9a-f]{32}$/);

  const page = await worker.fetch(new Request(link), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /燃えるゴミの日/);
  assert.equal((await worker.fetch(new Request("https://x/settings?t=" + "0".repeat(32)), env)).status, 404);

  // 保存：名前に </script> を入れても埋め込みが壊れない
  const next = structuredClone(DEFAULT_SCHEDULE);
  next.weekly[0] = { ...next.weekly[0], name: "歯ブラシ交換</script>", days: [2] };
  const post = (body) => worker.fetch(new Request(`https://x/settings?t=${t}`, { method: "POST", body: JSON.stringify(body) }), env);
  assert.equal((await post({ schedule: next, job: DEFAULT_JOB })).status, 200);
  assert.match((await say("予定")).text, /歯ブラシ交換<\/script>\n　火曜/);
  const html = await (await worker.fetch(new Request(link), env)).text();
  assert.ok(!html.includes("交換</script>"));

  // 不正な値は 400 で、保存されない
  const res = await post({ schedule: { weekly: [{ name: "", days: [1], eve: true }], morning: {} }, job: DEFAULT_JOB });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /名前が空/);

  // 期限切れ（KV のキーが消えた状態）
  env.TASKS_KV._m.delete(`settings_token_${t}`);
  assert.equal((await worker.fetch(new Request(link), env)).status, 404);
  assert.equal((await post({ schedule: next, job: DEFAULT_JOB })).status, 404);
});

test("朝のタスクも予定から読む", async () => {
  const jst = jstNow();
  sent = [];
  await runScheduled(env, { ...jst, hour: 6, dow: 0, day: 10 }); // 日曜は送らない
  assert.equal(sent.length, 0);
  await runScheduled(env, { ...jst, hour: 6, dow: 1, day: 10 });
  assert.match(sent[0].body.messages[0].text, /床に置いてあるもの/);
});

test("MY_USER_ID に空白や改行が混ざっていても本人と判定する", async () => {
  env.MY_USER_ID = " U1\n";
  assert.match((await say("予定設定")).text, /settings\?t=/);
});

// ---- バイトカウンター（見本の区分 A・B=¥1,000、C=¥1,100、予算 ¥50,000） ----
test("バイト：時間と勤務日の読み取り", () => {
  assert.equal(parseHours("5"), 5);
  assert.equal(parseHours("5.5"), 5.5);
  assert.equal(parseHours("5:30"), 5.5);
  assert.equal(parseHours("5時間30分"), 5.5);
  assert.equal(parseHours("6h"), 6);
  assert.equal(parseHours("90分"), 1.5);
  assert.equal(parseHours("0"), null);
  assert.equal(parseHours("25"), null);
  assert.equal(parseHours("5:75"), null);
  assert.equal(parseHours("abc"), null);
  assert.equal(parseWorkDate(undefined, "2026-11-02"), "2026-11-02");
  assert.equal(parseWorkDate("昨日", "2026-11-01"), "2026-10-31");
  assert.equal(parseWorkDate("10/31", "2026-11-02"), "2026-10-31");
  assert.equal(parseWorkDate("12/31", "2027-01-05"), "2026-12-31"); // 年をまたぐ
  assert.equal(parseWorkDate("11/05", "2026-11-02"), null); // 未来は不可
  assert.equal(parseWorkDate("2/30", "2026-11-02"), null);
});

test("バイト：残り時間は時給ごとに分単位で切り捨て", () => {
  assert.deepEqual(remainingHoursLines(DEFAULT_JOB, 45000), ["区分A・区分B（¥1,000）なら 45時間", "区分C（¥1,100）なら 40時間54分"]);
  assert.deepEqual(remainingHoursLines(DEFAULT_JOB, -100), ["区分A・区分B（¥1,000）なら 0時間", "区分C（¥1,100）なら 0時間"]);
});

test("バイト：区分をボタンで選んで時間を送ると記録し、残りを返す", async () => {
  const menu = await say("バイト");
  assert.match(menu.text, /予算 ¥50,000/);
  assert.deepEqual(menu.quickReply.items.map((i) => i.action.text), ["バイト 区分A", "バイト 区分B", "バイト 区分C"]);

  const ask = await say("バイト 区分A");
  assert.match(ask.text, /何時間/);
  assert.equal(ask.quickReply.items[0].action.text, "3");

  const done = (await say("5")).text;
  assert.match(done, /区分A 5時間（¥5,000）/);
  assert.match(done, /残り ¥45,000/);
  assert.match(done, /区分C（¥1,100）なら 40時間54分/);

  // 記録したら待ち状態は解除。数字だけ送っても記録しない
  assert.match((await say("5")).text, /使い方/);
});

test("バイト：1行入力・全角・前日分・時間待ちの期限切れ", async () => {
  const r = (await say("バイト 区分C ５：３０ 昨日")).text;
  assert.match(r, /区分C 5時間30分（¥6,050）/);
  const y = addDaysStr(jstNow().date, -1);
  const stored = JSON.parse(env.TASKS_KV._m.get(`shift_${y.slice(0, 7)}`));
  assert.equal(stored[0].date, y);
  assert.equal(stored[0].rate, 1100); // 記録時点の時給を保存

  assert.match((await say("バイト 区分Z")).text, /登録されていない/);
  assert.match((await say("バイト 区分A abc")).text, /時間は/);
  assert.match((await say("バイト 区分A 5 12/40")).text, /日付は/);

  await say("バイト 区分B");
  env.TASKS_KV._m.delete("shift_pending"); // 10分経って消えた状態
  assert.match((await say("4")).text, /使い方/);
});

test("バイト：予算を超えたら警告。月ごとの上書きが優先される", async () => {
  const ym = jstNow().ym;
  env.TASKS_KV._m.set("job_settings", JSON.stringify({ ...DEFAULT_JOB, monthly: { [ym]: 8000 } }));
  assert.match((await say("バイト 区分A 5")).text, /予算 ¥8,000\n残り ¥3,000/);
  assert.match((await say("バイト 区分A 5")).text, /⚠️ 予算を ¥2,000 超えています/);
});

test("取消：支出とバイトを入力の新しい順に取り消す", async () => {
  await say("支出 800 食費");
  await say("バイト 区分A 3");
  assert.match((await say("取消")).text, /バイトを取り消したよ.*区分A 3時間/);
  assert.match((await say("取り消し")).text, /支出を取り消したよ.*¥800/);
  assert.match((await say("取消")).text, /取り消せる記録がない/);
  assert.equal(JSON.parse(env.TASKS_KV._m.get(`shift_${jstNow().ym}`)).length, 0);
});

test("月次レポート：Flex・HTML・CSV にバイトが入る", async () => {
  await say("支出 1200 食費");
  await say("バイト 区分B 4");
  const flex = await say("今月");
  assert.match(flex.altText, /バイト ¥4,000/);
  const texts = JSON.stringify(flex.contents.body);
  assert.match(texts, /バイト/);
  assert.match(texts, /残り ¥46,000/);

  const ym = jstNow().ym;
  const t = await reportToken(SECRET, ym);
  const html = await (await worker.fetch(new Request(`https://x/report/${ym}?t=${t}`), env)).text();
  assert.match(html, /バイトの明細/);
  const csv = new TextDecoder().decode(await (await worker.fetch(new Request(`https://x/report/${ym}.csv?t=${t}`), env)).arrayBuffer());
  assert.match(csv, /"支出","[\d-]+","1200","食費"/);
  assert.match(csv, /"バイト","[\d-]+","4000","区分B","","4","1000"/);

  // 支出がなくてもバイトだけでレポートを出す
  env.TASKS_KV._m.delete(`exp_${ym}`);
  const only = await say("今月");
  assert.equal(only.type, "flex");
  assert.match(JSON.stringify(only.contents.body), /支出の記録はまだない/);
});

test("バイト設定の検証と保存", async () => {
  assert.throws(() => validateJob({ ...DEFAULT_JOB, kinds: [] }), /1〜5個/);
  assert.throws(() => validateJob({ ...DEFAULT_JOB, kinds: [{ name: "区分 A", rate: 1000 }] }), /空白なし/);
  assert.throws(() => validateJob({ ...DEFAULT_JOB, kinds: [{ name: "A", rate: 1000 }, { name: "A", rate: 1100 }] }), /重複/);
  assert.throws(() => validateJob({ ...DEFAULT_JOB, kinds: [{ name: "A", rate: 0 }] }), /時給/);
  assert.throws(() => validateJob({ ...DEFAULT_JOB, monthly: { "2026-13": 1 } }), /正しくありません/);
  assert.deepEqual(validateJob({ kinds: [{ name: "A", rate: "1200" }], budget: "60000", monthly: { "2026-12": "40000" } }).monthly, { "2026-12": 40000 });

  // 設定ページから保存 → 区分名が変わり、ボタンにも反映
  const t = new URL((await say("予定設定")).text.match(/https:\S+/)[0]).searchParams.get("t");
  const job = { kinds: [{ id: "x", name: "早番", rate: 1200 }], budget: 60000, monthly: {} };
  const res = await worker.fetch(new Request(`https://x/settings?t=${t}`, { method: "POST", body: JSON.stringify({ schedule: DEFAULT_SCHEDULE, job }) }), env);
  assert.equal(res.status, 200);
  const menu = await say("バイト");
  assert.equal(menu.quickReply.items[0].action.text, "バイト 早番");
  assert.match(menu.text, /予算 ¥60,000/);

  // バイトの設定が不正なら、予定も保存しない
  const bad = await worker.fetch(new Request(`https://x/settings?t=${t}`, { method: "POST", body: JSON.stringify({ schedule: { ...DEFAULT_SCHEDULE, morning: { 1: "変更" } }, job: { ...job, budget: -1 } }) }), env);
  assert.equal(bad.status, 400);
  assert.notEqual(JSON.parse(env.TASKS_KV._m.get("schedule") || "{}").morning?.[1], "変更");
});
