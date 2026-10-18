// 家事コーチ：LINE で家事・締め切り・支出を管理する Bot（Cloudflare Workers）
import { jstNow, prevYm, addDays } from "./time.js";
import { reply, push, verifySignature, reportToken, safeEqual, withQuickReply } from "./line.js";
import { addDeadline, listDeadlines, deleteDeadline, deadlineReminders } from "./deadline.js";
import { parseExpense, recordExpense, getMonth, weekTotal, yen } from "./expense.js";
import { pushUndo, undoLast } from "./undo.js";
import {
  getJob, saveJob, validateJob, findKind, parseHours, parseShiftArgs, recordShift, getShifts, summarizeShifts,
  statusText, fmtHours, setPending, getPending, clearPending,
} from "./shift.js";
import { buildFlex, renderHtml, renderCsv } from "./report.js";
import { getSchedule, saveSchedule, validateSchedule, listSchedule, eveItems, dueItems, formatEve, formatDue } from "./schedule.js";
import { issueSettingsToken, isValidSettingsToken, renderSettings, LINK_TTL } from "./settings.js";

const HELP =
  "使い方👇\n\n" +
  "「今日のタスク」→ 今日やること\n" +
  "「追加: レポート 金曜まで」→ 締め切り登録\n" +
  "「締め切り」→ 一覧\n" +
  "「削除 1」→ 締め切りを消す\n" +
  "「支出 800 食費 ランチ」→ 支出記録\n" +
  "「バイト」→ バイト時間の記録・残り時間\n" +
  "「取消」→ 直前の入力（支出・バイト）を消す\n" +
  "「今月」「先月」→ 支出の集計\n" +
  "「予定」→ 毎週の予定の一覧\n" +
  "「予定設定」→ 予定・バイトの設定ページ";

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
  const work = await workSummary(env, ym);
  if (isCsv) {
    return new Response(renderCsv(entries, work?.entries || []), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="expenses-${ym}.csv"`,
      },
    });
  }
  const csvUrl = `/report/${ym}.csv?t=${expected}`;
  return new Response(renderHtml(ym, entries, jstNow(), csvUrl, work), {
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
    return new Response(renderSettings(await getSchedule(env), await getJob(env), t), { headers: html });
  }
  if (request.method === "POST") {
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
    try {
      // 予定とバイトは両方検証してから保存する（片方だけ保存されるのを防ぐ）
      const body = await request.json();
      validateSchedule(body?.schedule);
      validateJob(body?.job);
      const schedule = await saveSchedule(env, body.schedule);
      const job = await saveJob(env, body.job);
      return json({ ok: true, schedule, job });
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

// 月次レポートに入れるバイトの集計（記録がなければ null）
async function workSummary(env, ym) {
  const entries = await getShifts(env, ym);
  if (entries.length === 0) return null;
  return { entries, summary: summarizeShifts(entries, await getJob(env), ym) };
}

async function monthlyMessage(env, ym, jst) {
  return buildFlex(ym, await getMonth(env, ym), jst, await reportUrl(env, ym), await workSummary(env, ym));
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
  if (expense) {
    const r = await recordExpense(env, expense, jst);
    await pushUndo(env, { type: "expense", ym: r.ym, id: r.id });
    return say(r.message);
  }
  if (text.startsWith("支出")) return say("「支出 800」「支出 1200 食費 ランチ」みたいに送ってね");
  if (text === "取消" || text === "取り消し") return say(await undoLast(env));

  // バイト：「バイト」→区分を選ぶ→時間を送る。「バイト 区分A 5.5 10/31」の1行でも可
  if (text === "バイト" || text.startsWith("バイト ")) return say(await handleShift(env, text, jst));
  // 区分を選んだ直後なら、数字だけのメッセージを時間として受け取る
  const pendingKind = parseHours(shiftNormalize(text).split(" ")[0]) !== null ? await getPending(env) : null;
  if (pendingKind) return say(await handleShift(env, `バイト ${pendingKind} ${text}`, jst, true));

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

// バイト入力の「．」「：」もそろえる（数字の全角は normalize 済み）
function shiftNormalize(s) {
  return s.replace(/．/g, ".").replace(/：/g, ":");
}

async function handleShift(env, text, jst, byId = false) {
  const job = await getJob(env);
  const [, kindArg, ...rest] = shiftNormalize(text).split(/\s+/);
  const status = async (ym) => statusText(summarizeShifts(await getShifts(env, ym), job, ym), job, ym);
  const kindButtons = job.kinds.map((k) => ({ label: k.name, text: `バイト ${k.name}` }));

  // 「バイト」だけ：今月の状況と区分のボタン
  if (!kindArg) {
    return withQuickReply(`🕒 バイト

${await status(jst.ym)}

区分を選んでね👇`, kindButtons);
  }
  const kind = byId ? job.kinds.find((k) => k.id === kindArg) : findKind(job, kindArg);
  if (!kind) {
    return withQuickReply(`区分「${kindArg}」は登録されていないよ。下から選んでね👇`, kindButtons);
  }
  // 区分だけ：時間を聞く（10分以内に数字を送れば記録）
  if (rest.length === 0) {
    await setPending(env, kind.id);
    const hours = [3, 4, 5, 6, 7, 8].map((h) => ({ label: `${h}時間`, text: String(h) }));
    return withQuickReply(`${kind.name}（¥${yen(kind.rate)}）
何時間働いた？

「5.5」「5:30」でもOK。前の日の分は「5 10/31」「5 昨日」`, hours);
  }
  const args = parseShiftArgs(rest, jst.date);
  if (args.error) return args.error;
  await clearPending(env);
  const { entry, ym } = await recordShift(env, kind, args.hours, args.date);
  await pushUndo(env, { type: "shift", ym, id: entry.id });
  const day = entry.date === jst.date ? "" : `${entry.date.slice(5).replace("-", "/")} `;
  return `✅ ${day}${kind.name} ${fmtHours(entry.hours)}（¥${yen(entry.amount)}）

${await status(ym)}

間違えたら「取消」で消せるよ`;
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
