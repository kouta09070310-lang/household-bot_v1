// 「取消」：支出とバイトのうち、最後に入力したものから順に取り消す
// 入力のたびに { type, ym, id } を積み、取消で1つずつ下ろす
import { removeExpense, yen } from "./expense.js";
import { removeShift, fmtHours } from "./shift.js";

const KEY = "undo_stack";
const MAX = 20;

async function load(env) {
  return JSON.parse((await env.TASKS_KV.get(KEY)) || "[]");
}

export async function pushUndo(env, action) {
  const stack = await load(env);
  stack.push(action);
  await env.TASKS_KV.put(KEY, JSON.stringify(stack.slice(-MAX)));
}

const md = (date) => date.slice(5).replace("-", "/");

export async function undoLast(env) {
  const stack = await load(env);
  while (stack.length) {
    const a = stack.pop();
    await env.TASKS_KV.put(KEY, JSON.stringify(stack));
    if (a.type === "expense") {
      const e = await removeExpense(env, a.ym, a.id);
      if (e) return `↩️ 支出を取り消したよ：${md(e.date)} ¥${yen(e.amount)}（${e.category}）`;
    } else if (a.type === "shift") {
      const e = await removeShift(env, a.ym, a.id);
      if (e) return `↩️ バイトを取り消したよ：${md(e.date)} ${e.name} ${fmtHours(e.hours)}（¥${yen(e.amount)}）`;
    }
    // すでに消えていた記録は飛ばして、その前の入力を取り消す
  }
  return "取り消せる記録がないよ";
}
