// LINE Messaging API との通信まわり

const API = "https://api.line.me/v2/bot/message";

// 文字列ならテキストメッセージに包む
function toMessages(msg) {
  const list = Array.isArray(msg) ? msg : [msg];
  return list.map((m) => (typeof m === "string" ? { type: "text", text: m } : m));
}

async function post(env, path, payload) {
  const res = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LINE_TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    // 失敗しても Bot 全体は止めず、ログ（wrangler tail で見える）に残す
    console.error(`LINE ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.ok;
}

// 返信（ユーザーのメッセージへの応答）
export function reply(env, replyToken, msg) {
  return post(env, "reply", { replyToken, messages: toMessages(msg) });
}

// プッシュ（Bot から自発的に送る通知）
export function push(env, to, msg) {
  return post(env, "push", { to, messages: toMessages(msg) });
}

// HMAC-SHA256 の生バイト列
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

// 長さが同じなら全バイトを比べる（比較時間から中身を推測されないようにする）
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Webhook の署名検証
// LINE は本文をチャネルシークレットで HMAC-SHA256 し、Base64 にしたものを
// X-Line-Signature ヘッダーに入れて送ってくる。同じ計算をして一致すれば本物
export async function verifySignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const bytes = await hmac(secret, rawBody);
  const expected = btoa(String.fromCharCode(...bytes));
  return safeEqual(expected, signature);
}

// レポートページ用の合言葉（月ごとに変わる）。URL を知らない人には見られない
export async function reportToken(secret, ym) {
  const bytes = await hmac(secret, `report:${ym}`);
  return [...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export { safeEqual };
