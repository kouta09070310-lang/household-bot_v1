// 家事コーチ：LINE で家事・締め切り・支出を管理する Bot（Cloudflare Workers）
import { jstNow, prevYm, addDays } from "./time.js";
import { reply, push, verifySignature, reportToken, safeEqual } from "./line.js";
import { addDeadline, listDeadlines, deleteDeadline, deadlineReminders } from "./deadline.js";
import { parseExpense, recordExpense, undoLast, getMonth, weekTotal, yen } from "./expense.js";
import { buildFlex, renderHtml, renderCsv } from "./report.js";
import { getSchedule, saveSchedule, listSchedule, eveItems, dueItems, formatEve, formatDue } from "./schedule.js";
import { issueSettingsToken, isValidSettingsToken, renderSettings, LINK_TTL } from "./settings.js";

const HELP =
  "使い方👇\n\n" +
  "「今日のタスク」→ 今日やること\n" +
  "「追加: レポート 金曜まで」→ 締め切り登録\n" +
  "「締め切り」→ 一覧\n" +
  "「削除 1」→ 締め切りを消す\n" +
  "「支出 800 食費 ランチ」→ 支出記録\n" +
  "「取消」→ 直前の支出を消す\n" +
  "「今月」「先月」→ 支出の集計\n" +
  "「予定」→ 毎週の予定の一覧\n" +
  "「予定設定」→ 予定を変更するページ";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, url);
    }

    // 月次レポート：/report/2026-10 （HTML）と /report/2026-10.csv
    const m = url.pathname.match(/^\/report\/(\d{4}-\d{2})(\.csv)?$/);
    if (request.method === "GET" && m) {
      return handleReport(env, m[1], Boolean(m[2]), url);
    }

    // 予定の設定ページ：/settings?t=…（30分有効）
    if (url.pathname === "/settings") {
      return handleSettings(request, env, url);
    }

    return new Response("ok");
  },

  async scheduled(_event, env) {
    await runScheduled(env, jstNow());
  },
};

async function handleWebhook(request, env, url) {
  if (!env.LINE_CHANNEL_SECRET) {
    console.error("LINE_CHANNEL_SECRET が未設定です");
    return new Response("server not configured", { status: 500 });
  }
  const raw = await request.text();
  const ok = await verifySignature(env.LINE_CHANNEL_SECRET, raw, request.headers.get("x-line-signature"));
  if (!ok) return new Response("invalid signature", { status: 401 });

  // 定期通知でレポートの URL を作るため、自分の公開 URL を覚えておく
  if ((await env.TASKS_KV.get("base_url")) !== url.origin) {
    await env.TASKS_KV.put("base_url", url.origin);
  }

  const body = JSON.parse(raw);
  for (const event of body.events || []) {
    if (event.type === "message" && event.message.type === "text") {
      await handleMessage(env, event, url.origin);
    } else if (event.type === "follow") {
      await reply(env, event.replyToken, "家事コーチだよ！\n\n" + HELP);
    }
  }
  return new Response("OK");
}

async function handleReport(env, ym, isCsv, url) {
  const expected = await reportToken(env.LINE_CHANNEL_SECRET || "", ym);
  if (!env.LINE_CHANNEL_SECRET || !safeEqual(url.searchParams.get("t") || "", expected)) {
    return new Response("not found", { status: 404 });
  }
  const entries = await getMonth(env, ym);
  if (isCsv) {
    return new Response(renderCsv(entries), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="expenses-${ym}.csv"`,
      },
    });
  }
  const csvUrl = `/report/${ym}.csv?t=${expected}`;
  return new Response(renderHtml(ym, entries, jstNow(), csvUrl), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleSettings(request, env, url) {
  const t = url.searchParams.get("t") || "";
  const html = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (!(await isValidSettingsToken(env, t))) {
    return new Response("リンクの期限が切れています。LINE で「予定設定」と送り直してください。", { status: 404, headers: { ...html, "content-type": "text/plain; charset=utf-8" } });
  }
  if (request.method === "GET") {
    return new Response(renderSettings(await getSchedule(env), t), { headers: html });
  }
  if (request.method === "POST") {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    try {
      const schedule = await saveSchedule(env, await request.json());
      return json({ ok: true, schedule });
    } catch (e) {
      return json({ error: e instanceof SyntaxError ? "形式が正しくありません" : e.message }, 400);
    }
  }
  return new Response("method not allowed", { status: 405 });
}

// レポートページの URL（公開 URL がまだ分からなければ null）
async function reportUrl(env, ym) {
  const base = env.PUBLIC_URL || (await env.TASKS_KV.get("base_url"));
  if (!base || !env.LINE_CHANNEL_SECRET) return null;
  return `${base}/report/${ym}?t=${await reportToken(env.LINE_CHANNEL_SECRET, ym)}`;
}

async function monthlyMessage(env, ym, jst) {
  return buildFlex(ym, await getMonth(env, ym), jst, await reportUrl(env, ym));
}

// 通知先のユーザーID。secret 登録時に紛れ込んだ空白・改行を取り除く
function myUserId(env) {
  return (env.MY_USER_ID || "").trim();
}

// 全角の数字・コロン・スペースを半角にそろえる
function normalize(s) {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .trim();
}

async function handleMessage(env, event, origin) {
  const text = normalize(event.message.text);
  const rt = event.replyToken;
  const jst = jstNow();
  const say = (msg) => reply(env, rt, msg);

  if (/^追加\s*[:：]/.test(text)) {
    const content = text.replace(/^追加\s*[:：]/, "").trim();
    return say(content ? await addDeadline(env, content, jst) : "「追加: レポート 金曜まで」みたいに送ってね");
  }
  if (text === "締め切り" || text === "タスク一覧") return say(await listDeadlines(env, jst));

  let m = text.match(/^削除\s*(\d+)$/);
  if (m) return say(await deleteDeadline(env, Number(m[1])));

  const expense = parseExpense(text);
  if (expense) return say(await recordExpense(env, expense, jst));
  if (text.startsWith("支出")) return say("「支出 800」「支出 1200 食費 ランチ」みたいに送ってね");
  if (text === "取消" || text === "取り消し") return say(await undoLast(env, jst));

  if (text === "今月") return say(await monthlyMessage(env, jst.ym, jst));
  if (text === "先月") return say(await monthlyMessage(env, prevYm(jst.ym), jst));

  if (text.includes("バックアップ完了")) return say("✅ バックアップ完了！お疲れさま💪\n来月末にまた知らせるね");
  if (["完了", "おわり", "done"].includes(text)) return say("✅ えらい！完了！\nその調子で💪");

  if (text === "myid") return say(`あなたのID: ${event.source.userId}`);

  if (text === "予定") return say(listSchedule(await getSchedule(env)));
  if (text === "予定設定" || text === "予定変更") {
    // 予定を書き換えられるリンクなので、通知先に登録した本人にだけ出す
    if (!myUserId(env) || event.source.userId !== myUserId(env)) return say("この操作は登録したユーザーだけができるよ");
    const t = await issueSettingsToken(env);
    return say(`📅 予定の設定ページ👇（${LINK_TTL / 60}分有効）\n${origin}/settings?t=${t}`);
  }

  if (["今日のタスク", "タスク", "おはよう"].includes(text)) {
    const task = (await getSchedule(env)).morning[jst.dow] || "今日はゆっくり休もう🌿";
    return say(`今日の1つ👇\n\n${task}\n\n終わったら「完了」と返信してね`);
  }
  return say(HELP);
}

// 毎時0分（UTC）に呼ばれる。日本時間の時・曜日で送る内容を決める
export async function runScheduled(env, jst) {
  const to = myUserId(env);
  if (!to) return;
  const send = (msg) => push(env, to, msg);
  const { hour, dow, day } = jst;
  const isLastDay = addDays(jst.date, 1).endsWith("-01");
  const schedule = await getSchedule(env);
  const morning = schedule.morning[dow];

  if (hour === 6 && dow >= 1 && dow <= 5 && morning) {
    await send(`おはよう！今日の1つ👇\n\n${morning}\n\n終わったら「完了」と返信してね`);
  }

  // 当日通知（21時以外）。21時の分は下のまとめに入れる
  if (hour !== 21) {
    const due = dueItems(schedule, dow, hour);
    if (due.length) await send(`🔔 今日の予定\n\n${formatDue(due)}\n\n終わったら「完了」と返信してね`);
  }

  // 21時：明日の予告・今夜の予定・支出の記録を1通にまとめる
  if (hour === 21) {
    const parts = [];
    const eve = eveItems(schedule, dow);
    const due = dueItems(schedule, dow, 21);
    if (eve.length) parts.push(`【明日】\n${formatEve(eve)}`);
    if (due.length) parts.push(`【今夜】\n${formatDue(due)}`);
    if (day === 25) parts.push("📁 もうすぐ月末！\n　写真とPCのバックアップの準備をしておいてね");
    parts.push("💰 今日いくら使った？\n　「支出 800 食費」みたいに返信してね");
    await send(`🌙 今夜のお知らせ\n\n${parts.join("\n\n")}`);
  }

  // 日曜22時：今週の合計
  if (hour === 22 && dow === 0) {
    const total = await weekTotal(env, jst);
    await send(total === 0 ? "💰 今週の支出記録がないよ\n毎晩「支出 金額」で記録してみてね" : `📊 今週の支出合計\n¥${yen(total)}\n\n来週もほどほどにね！`);
  }

  // 月末22時：今月の支出レポート（表とグラフのリンク付き）
  if (hour === 22 && isLastDay) {
    const sentKey = `monthly_sent_${jst.ym}`;
    if (!(await env.TASKS_KV.get(sentKey))) {
      await send(await monthlyMessage(env, jst.ym, jst));
      await env.TASKS_KV.put(sentKey, "1", { expirationTtl: 60 * 60 * 24 * 40 });
    }
  }

  // 月末バックアップ（28日以降の朝9時に1回）
  if (hour === 9 && day >= 28) {
    const k = `backup_notified_${jst.ym}`;
    if (!(await env.TASKS_KV.get(k))) {
      await send("📁 月末バックアップの時間！\n\n・スマホの写真をHDDに移す\n・PCのバックアップを取る\n\n終わったら「バックアップ完了」と返信してね");
      await env.TASKS_KV.put(k, "1", { expirationTtl: 60 * 60 * 24 * 40 });
    }
  }

  // 朝8時：締め切りの3日前・前日・当日
  if (hour === 8) {
    for (const msg of await deadlineReminders(env, jst)) await send(msg);
  }
}
