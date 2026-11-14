import type { Context, Telegraf } from "telegraf";
import { dueAmount, loadFinance } from "../finance/index.js";
import type { LedgerEntry } from "../finance/index.js";
import {
  addDebt,
  creditPaid,
  currentPeriod,
  debtsInOrder,
  moveDebt,
  overdueNow,
  payDebt,
  payOverdue,
  recentLedger,
  recordCreditPayment,
  setCreditBalance,
  setCashOnHand,
  toUsd,
  recordIncome,
  recordedIncome,
  remainingNative,
  undoEntry,
} from "../finance/actions.js";
import { dm, formatUpcoming, moneyText, upcomingEvents } from "../finance/schedule.js";
import { buildMonthPlan, formatMonthPlan } from "../finance/plan.js";
import { updateRates } from "../finance/rates.js";
import { addBill, billOpen, billPaid, billPeriod, deleteBill, findBill, nextDue, parseBillText, payBill, updateBill } from "../finance/bills.js";
import type { Bill, FinanceData } from "../finance/index.js";
import { todayLocal } from "../spending/index.js";
import { aiEnabled } from "../ai/index.js";
import { setPending } from "./pending.js";
import type { Pending } from "./pending.js";
import { back, btn, canSeeFinance, errMsg, esc, parseAmount, show, unitOf } from "./ui.js";
import type { Rows } from "./ui.js";

// 💼 Финансы and everything below it: debts, payments, incomes, plan, rates,
// history. Every action is recorded in finance.json's ledger and can be undone.

const who = (ctx: Context) => ctx.from?.first_name;

function ledgerLine(e: LedgerEntry): string {
  const amount = e.amount !== undefined && e.currency ? moneyText(e.amount, e.currency) : "";
  const what: Record<LedgerEntry["kind"], string> = {
    "debt-paid": `✅ ${esc(e.label)} — долг закрыт (${amount})`,
    "debt-partial": `🔸 ${esc(e.label)} — отдано ${amount}`,
    "debt-added": `➕ Новый долг: ${esc(e.label)} — ${amount}`,
    income: `📥 ${esc(e.label)} — пришло ${amount}`,
    "credit-payment": `📤 ${esc(e.label)} — оплачено ${amount}`,
    "overdue-paid": `🔴 ${esc(e.label)} — внесено ${amount}`,
    "bill-paid": `🧾 ${esc(e.label)} — оплачено ${amount}`,
    "credit-balance": `✏️ ${esc(e.label)}: ${amount}`,
  };
  return `${dm(e.date)}${e.by ? ` · ${esc(e.by)}` : ""} · ${what[e.kind]}`;
}

/** After an action: what happened, plus undo and a way back. */
async function done(ctx: Context, text: string, entry: LedgerEntry, backTo: string, backLabel: string): Promise<void> {
  await show(ctx, text, [[btn("↩️ Отменить", `lg:${entry.id}`), btn(backLabel, `m:${backTo}`)]]);
}

// ── Screens ───────────────────────────────────────────────────────────────

export function financeHome(ctx: Context): Promise<void> {
  const today = todayLocal();
  const { fin, debts } = debtsInOrder();
  const total = debts.reduce((s, d) => s + d.amountUsd, 0);
  const events = upcomingEvents(fin, today, 45);
  const nextIn = events.find((e) => e.kind === "in" && !e.done);
  const nextOut = events.find((e) => (e.kind === "out" || e.kind === "bill") && !e.done && e.from);
  const monthly = fin.credits.filter((c) => c.currency === "MDL").reduce((s, c) => s + c.monthlyPayment, 0);
  const lines = ["💼 <b>Финансы</b>", ""];
  lines.push(`👥 Долги: ~$${Math.round(total).toLocaleString("ru-RU")} · ${debts.length} чел.` +
    (debts[0] ? ` · следующий: ${esc(debts[0].name)}` : ""));
  lines.push(`🏦 Кредиты: ${fin.credits.length} · ~${moneyText(monthly, "MDL")} в месяц`);
  for (const c of fin.credits.filter((c) => c.overdue)) {
    lines.push(`🔴 Просрочка ${esc(c.name)}: ~${moneyText(overdueNow(c.overdue!, today), c.currency)}`);
  }
  if (nextIn) lines.push(`📥 Ближайшее поступление: ${esc(nextIn.name)}, ${dm(nextIn.from)}`);
  if (nextOut) lines.push(`📤 Ближайший платёж: ${esc(nextOut.name)}, ${dm(nextOut.from)}`);
  lines.push(`💱 $1 = ${fin.mdlPerUsd} лей · ${fin.rubPerUsd ?? "?"} руб ПМР`);
  lines.push(fin.cashOnHandUsd !== undefined && fin.cashAsOf
    ? `💵 На руках: ~$${Math.round(fin.cashOnHandUsd)} (на ${dm(fin.cashAsOf)})`
    : "💵 Сколько на руках — не указано");

  const rows: Rows = [
    [btn("📆 Ближайшее", "m:upc"), btn("👥 Долги", "m:debts")],
    [btn("🏦 Кредиты", "m:credits"), btn("🗓 План месяца", "m:plan")],
    [btn("🧾 Платежи", "m:bills"), btn("💱 Курсы", "m:rates")],
    [btn("💵 На руках", "cash"), btn("📜 История", "m:hist")],
  ];
  if (aiEnabled()) rows.push([btn("🤖 Спросить ИИ", "m:ai")]);
  return show(ctx, lines.join("\n"), rows);
}

export function upcomingScreen(ctx: Context): Promise<void> {
  const today = todayLocal();
  const fin = loadFinance();
  const events = upcomingEvents(fin, today);
  const period = currentPeriod();
  const rows: Rows = [];
  for (const c of fin.credits.filter((c) => c.overdue)) {
    rows.push([btn(`🔴 Внёс в просрочку: ${c.name}`, `od:${c.id}`)]);
  }
  // Everything of this month not yet marked — even if its window already
  // passed and the calendar above has moved on to next month's occurrence.
  for (const i of fin.incomeSchedule ?? []) {
    if (!recordedIncome(fin, i.id, period)) rows.push([btn(`📥 Пришло: ${i.name}`, `inc:${i.id}`)]);
  }
  for (const c of [...fin.credits].sort((a, b) => (a.paymentDay ?? 99) - (b.paymentDay ?? 99))) {
    if (dueAmount(c, period) > 0 && !creditPaid(fin, c.id, period)) rows.push([btn(`✅ Оплатил: ${c.name}`, `cp:${c.id}`)]);
  }
  for (const b of fin.bills ?? []) {
    if (billOpen(fin, b, today) && (b.every !== "once" || !b.dueDate || b.dueDate.slice(0, 7) <= period)) {
      rows.push([btn(`🧾 Оплатил: ${b.name}`, `bp:${b.id}`)]);
    }
  }
  rows.push([btn("➕ Другое поступление", "incother")]);
  rows.push(back("fin", "⬅️ Финансы"));
  return show(ctx, formatUpcoming(events, today), rows);
}

export function debtsScreen(ctx: Context): Promise<void> {
  const { debts } = debtsInOrder();
  const total = debts.reduce((s, d) => s + d.amountUsd, 0);
  const text = [
    `👥 <b>Личные долги</b>: ~$${Math.round(total).toLocaleString("ru-RU")} · ${debts.length} чел.`,
    "",
    "В порядке отдачи. Нажми на человека, чтобы отметить, что отдал, или сдвинуть в очереди.",
  ].join("\n");
  const rows: Rows = debts.slice(0, 40).map((d, i) => [
    btn(`${i + 1}. ${d.name} — ${moneyText(remainingNative(d), d.currency)}`, `dv:${d.id}`),
  ]);
  rows.push([btn("➕ Новый долг", "dnew")]);
  rows.push(back("fin", "⬅️ Финансы"));
  return show(ctx, text, rows);
}

function debtCard(ctx: Context, id: string): Promise<void> {
  const { debts } = debtsInOrder();
  const i = debts.findIndex((d) => d.id === id);
  const d = debts[i];
  if (!d) return show(ctx, "Этого долга уже нет — возможно, закрыт.", [back("debts", "⬅️ Долги")]);
  const text = [
    `👤 <b>${esc(d.name)}</b>`,
    `Осталось: <b>${moneyText(remainingNative(d), d.currency)}</b>` + (d.currency === "USD" ? "" : ` (~$${Math.round(d.amountUsd)})`),
    `Место в очереди: ${i + 1} из ${debts.length}`,
    d.due ? `Срок: ${esc(d.due)}` : "",
    d.note ? `\n<i>${esc(d.note)}</i>` : "",
  ].filter(Boolean).join("\n");
  return show(ctx, text, [
    [btn("✅ Отдал всё", `dfull:${id}`), btn("✏️ Отдал часть", `dpart:${id}`)],
    [btn("⬆️ Раньше", `dup:${id}`), btn("⬇️ Позже", `ddn:${id}`)],
    back("debts", "⬅️ Долги"),
  ]);
}

export function creditsScreen(ctx: Context): Promise<void> {
  const today = todayLocal();
  const fin = loadFinance();
  const period = currentPeriod();
  const lines = ["🏦 <b>Кредиты</b>", ""];
  const rows: Rows = [];
  for (const c of [...fin.credits].sort((a, b) => b.aprPct - a.aprPct)) {
    const paid = creditPaid(fin, c.id, period);
    lines.push(
      `${paid ? "✅" : "▫️"} <b>${esc(c.name)}</b> — ${c.aprPct}%\n` +
        `      остаток ~${moneyText(c.balance, c.currency)}` +
        (c.balanceAsOf ? ` <i>(банк ${dm(c.balanceAsOf)}, дальше по платежам)</i>` : " <i>(оценка)</i>") +
        `\n      платёж ${moneyText(c.monthlyPayment, c.currency)}` +
        (c.paymentDay ? ` ${c.paymentDay}-го` : " (день ?)"),
    );
    if (c.overdue) {
      lines.push(`      🔴 просрочка ~${moneyText(overdueNow(c.overdue, today), c.currency)}`);
      rows.push([btn(`🔴 Внёс в просрочку: ${c.name}`, `od:${c.id}`)]);
    }
    if (!paid) rows.push([btn(`✅ Оплатил: ${c.name}`, `cp:${c.id}`)]);
  }
  const monthly = fin.credits.filter((c) => c.currency === "MDL").reduce((s, c) => s + c.monthlyPayment, 0);
  lines.push("", `Платежей в месяц: ~${moneyText(monthly, "MDL")} · ✅ — оплачено в этом месяце`);
  lines.push("<i>Остаток уменьшается на основной долг при каждой отметке «Оплатил». Точнее всего — цифра из приложения банка: «✏️ Уточнить остаток».</i>");
  rows.push([btn("✏️ Уточнить остаток по данным банка", "cbal")]);
  rows.push(back("fin", "⬅️ Финансы"));
  return show(ctx, lines.join("\n"), rows);
}

export function planScreen(ctx: Context): Promise<void> {
  const fin = loadFinance();
  return show(ctx, formatMonthPlan(buildMonthPlan(fin, todayLocal()), fin), [back("fin", "⬅️ Финансы")]);
}

function ratesScreen(ctx: Context, note = ""): Promise<void> {
  const fin = loadFinance();
  const text = [
    "💱 <b>Курсы</b>",
    "",
    `$1 = <b>${fin.mdlPerUsd}</b> лей`,
    fin.usdPerEur ? `€1 = <b>${(fin.usdPerEur * fin.mdlPerUsd).toFixed(4)}</b> лей ($${fin.usdPerEur})` : "",
    `$1 = <b>${fin.rubPerUsd ?? "?"}</b> руб ПМР`,
    fin.rubPerUsd ? `1 лей = <b>${(fin.rubPerUsd / fin.mdlPerUsd).toFixed(4)}</b> руб ПМР (кросс)` : "",
    "",
    `Обновлено: ${fin.ratesUpdatedAt ?? "вручную"}${fin.ratesSource ? ` · ${esc(fin.ratesSource)}` : ""}`,
    "<i>Это официальные курсы НБМ и ПРБ; в обменнике и банке будет чуть хуже. Обновляются каждое утро сами, суммы долгов в $ пересчитываются.</i>",
    note,
  ].filter(Boolean).join("\n");
  return show(ctx, text, [[btn("🔄 Обновить сейчас", "rt:refresh")], back("fin", "⬅️ Финансы")]);
}

function historyScreen(ctx: Context): Promise<void> {
  const entries = recentLedger(12);
  const text = entries.length
    ? ["📜 <b>Последние действия</b>", "", ...entries.map(ledgerLine)].join("\n")
    : "📜 Пока ничего не отмечено. Отдал долг, пришли деньги, оплатил кредит — отмечай в разделах «Долги» и «Ближайшее».";
  const rows: Rows = [];
  if (entries[0]) rows.push([btn("↩️ Отменить последнее", `lg:${entries[0].id}`)]);
  rows.push(back("fin", "⬅️ Финансы"));
  return show(ctx, text, rows);
}

function ask(ctx: Context, p: Pending, question: string, backTo: string): Promise<void> {
  setPending(ctx.from!.id, p);
  return show(ctx, `${question}\n\n<i>Напиши ответ сообщением.</i>`, [[btn("✖️ Отмена", `m:${backTo}`)]]);
}

// ── 🧾 Платежи ────────────────────────────────────────────────────────────

const BILL_EXAMPLES =
  "<code>Карате 600 руб 5</code> — каждый месяц 5-го\n" +
  "<code>Интернет 225 руб</code> — каждый месяц, день не важен\n" +
  "<code>Сад фонд 500 руб до 20.12</code> — один раз, до даты\n" +
  "<code>Фото 400 руб разово</code> — один раз\n" +
  "<code>Страховка 1200 лей ежегодно 15.03</code> — раз в год";

function billWhen(fin: FinanceData, b: Bill): string {
  if (b.every === "once") return b.dueDate ? `до ${dm(b.dueDate)}` : "срок ?";
  if (b.every === "year") return b.day && b.month ? `ежегодно ${b.day}.${String(b.month).padStart(2, "0")}` : "раз в год, дата ?";
  const next = nextDue(fin, b);
  return b.day ? `${b.day}-го${next ? ` (след. ${dm(next)})` : ""}` : "день ?";
}

export function billsScreen(ctx: Context): Promise<void> {
  const fin = loadFinance();
  const today = todayLocal();
  const bills = fin.bills ?? [];
  const groups: [string, Bill[]][] = [
    ["Каждый месяц", bills.filter((b) => b.every === "month")],
    ["Раз в год", bills.filter((b) => b.every === "year")],
    ["Разовые", bills.filter((b) => b.every === "once")],
  ];
  const lines = ["🧾 <b>Платежи</b>", ""];
  for (const [title, list] of groups) {
    if (list.length === 0) continue;
    lines.push(`<b>${title}</b>`);
    for (const b of list) {
      const paid = billPaid(fin, b, billPeriod(b, today));
      lines.push(`${paid ? "✅" : "▫️"} ${esc(b.name)} — ${moneyText(b.amount, b.currency)} · ${billWhen(fin, b)}${b.inLifeCost ? " · <i>в быту</i>" : ""}`);
    }
    lines.push("");
  }
  if (bills.length === 0) lines.push("Пока пусто. Добавь первый платёж кнопкой ниже.", "");
  lines.push("<i>✅ — оплачено за этот период. Накануне платежа с известной датой бот напомнит в 19:00. «в быту» — уже заложено в ежемесячные расходы.</i>");
  const rows: Rows = bills.slice(0, 30).map((b) => [btn(`${billPaid(fin, b, billPeriod(b, today)) ? "✅" : "▫️"} ${b.name}`, `bv:${b.id}`)]);
  rows.push([btn("➕ Новый платёж", "bnew")]);
  rows.push(back("fin", "⬅️ Финансы"));
  return show(ctx, lines.join("\n"), rows);
}

function billCard(ctx: Context, id: string): Promise<void> {
  const fin = loadFinance();
  const b = fin.bills?.find((x) => x.id === id);
  if (!b) return show(ctx, "Этого платежа уже нет.", [back("bills", "⬅️ Платежи")]);
  const paid = billPaid(fin, b, billPeriod(b, todayLocal()));
  const text = [
    `🧾 <b>${esc(b.name)}</b>`,
    `${moneyText(b.amount, b.currency)} · ${billWhen(fin, b)}`,
    paid ? `✅ Оплачено ${dm(paid.date)}${paid.by ? ` (${esc(paid.by)})` : ""}` : "▫️ В этом периоде ещё не оплачено",
    b.inLifeCost ? "<i>Уже заложено в ежемесячные расходы.</i>" : "",
    b.note ? `\n<i>${esc(b.note)}</i>` : "",
  ].filter(Boolean).join("\n");
  const rows: Rows = [];
  if (!paid) rows.push([btn("✅ Оплатил", `bp:${b.id}`)]);
  rows.push([btn("✏️ Изменить", `bedit:${b.id}`), btn("🗑 Удалить", `bdel:${b.id}`)]);
  rows.push(back("bills", "⬅️ Платежи"));
  return show(ctx, text, rows);
}

// ── Answers to "сколько?" ─────────────────────────────────────────────────

/** Handles the text reply to a pending question. Returns false if it wasn't a finance question. */
export async function answerFinance(ctx: Context, p: Pending, text: string): Promise<boolean> {
  const by = who(ctx);
  const again = (msg: string) => {
    setPending(ctx.from!.id, p);
    return ctx.reply(`${msg}\nПопробуй ещё раз или нажми «✖️ Отмена».`);
  };
  try {
    switch (p.kind) {
      case "debt-part": {
        const a = parseAmount(text);
        if (!a) return void (await again("Не вижу суммы.")), true;
        const r = payDebt(p.debtId, a.amount, by);
        const name = r.entry.label;
        await done(ctx, r.closed
          ? `✅ <b>${esc(name)}</b> — долг закрыт полностью.`
          : `🔸 <b>${esc(name)}</b>: отдано ${moneyText(a.amount, r.entry.currency!)}, осталось ${moneyText(r.left, r.entry.currency!)}.`,
          r.entry, "debts", "⬅️ Долги");
        return true;
      }
      case "debt-new": {
        const a = parseAmount(text);
        if (!a || !a.rest) return void (await again("Нужно имя и сумма, например: Петя 500 лей.")), true;
        const d = addDebt(a.rest, a.amount, a.currency ?? "MDL", by);
        await ctx.reply(`➕ Записал: <b>${esc(d.name)}</b> — ${moneyText(a.amount, d.currency)}, в конец очереди.`, { parse_mode: "HTML" });
        return true;
      }
      case "income": {
        const sched = loadFinance().incomeSchedule?.find((i) => i.id === p.incomeId);
        const a = parseAmount(text);
        if (!a || !sched) return void (await again("Не вижу суммы.")), true;
        const e = recordIncome(p.incomeId, a.amount, a.currency ?? sched.currency, by);
        await done(ctx, `📥 <b>${esc(e.label)}</b>: пришло ${moneyText(a.amount, e.currency!)}.`, e, "upc", "⬅️ Ближайшее");
        return true;
      }
      case "income-other": {
        const a = parseAmount(text);
        if (!a || !a.rest) return void (await again("Нужно что и сколько, например: PS5 4000 лей.")), true;
        const e = recordIncome("other", a.amount, a.currency ?? "MDL", by, a.rest);
        await done(ctx, `📥 <b>${esc(e.label)}</b>: пришло ${moneyText(a.amount, e.currency!)}.`, e, "upc", "⬅️ Ближайшее");
        return true;
      }
      case "credit": {
        const a = parseAmount(text);
        if (!a) return void (await again("Не вижу суммы.")), true;
        const e = recordCreditPayment(p.creditId, a.amount, by);
        await done(ctx, `✅ <b>${esc(e.label)}</b>: оплачено ${moneyText(a.amount, e.currency!)}.`, e, "credits", "⬅️ Кредиты");
        return true;
      }
      case "cash": {
        // "600$ и 800 руб", "450 + 2000 лей" — several pockets, summed in USD. Bare numbers are dollars.
        const parts = text.split(/\s*(?:\+|,|;|\sи\s)\s*/).map((t) => parseAmount(t)).filter((a) => a !== null);
        if (parts.length === 0) return void (await again("Не вижу суммы. Например: 600$ и 800 руб")), true;
        const fin = loadFinance();
        const usdTotal = parts.reduce((s, a) => s + toUsd(fin, a!.amount, a!.currency ?? "USD"), 0);
        setCashOnHand(usdTotal);
        await ctx.reply(
          `💵 Записал: на руках ~<b>$${Math.round(usdTotal)}</b>${parts.length > 1 ? ` (${parts.map((a) => moneyText(a!.amount, a!.currency ?? "USD")).join(" + ")})` : ""}.\nПлан месяца и план погашения теперь считают от этой суммы.`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[btn("🗓 План месяца", "m:plan")], [btn("⬅️ Финансы", "m:fin")]] } },
        );
        return true;
      }
      case "credit-balance": {
        const a = parseAmount(text);
        if (!a) return void (await again("Не вижу суммы. Например: 285 400")), true;
        const e = setCreditBalance(p.creditId, a.amount, by);
        await done(ctx, `✏️ <b>${esc(e.label)}</b>: ${moneyText(a.amount, e.currency!)}. Дальше каждый отмеченный платёж будет уменьшать его сам.`, e, "credits", "⬅️ Кредиты");
        return true;
      }
      case "overdue": {
        const a = parseAmount(text);
        if (!a) return void (await again("Не вижу суммы.")), true;
        const r = payOverdue(p.creditId, a.amount, by);
        await done(ctx, r.closed
          ? `✅ Просрочка закрыта (внесено ${moneyText(a.amount, r.entry.currency!)}).`
          : `🔴 Внесено ${moneyText(a.amount, r.entry.currency!)}, осталось ~${moneyText(r.left, r.entry.currency!)}.`,
          r.entry, "credits", "⬅️ Кредиты");
        return true;
      }
      case "bill-new":
      case "bill-edit": {
        const parsed = parseBillText(text);
        if (!parsed) return void (await again("Не разобрал. Пример: Карате 600 руб 5")), true;
        const b = p.kind === "bill-new" ? addBill(parsed) : updateBill(p.billId, parsed);
        await ctx.reply(
          `${p.kind === "bill-new" ? "➕ Добавил" : "✏️ Обновил"}: <b>${esc(b.name)}</b> — ${moneyText(b.amount, b.currency)} · ${billWhen(loadFinance(), b)}`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[btn("🧾 Все платежи", "m:bills")]] } },
        );
        return true;
      }
      case "bill-pay": {
        const a = parseAmount(text);
        if (!a) return void (await again("Не вижу суммы.")), true;
        const e = payBill(p.billId, a.amount, by);
        await done(ctx, `🧾 <b>${esc(e.label)}</b>: оплачено ${moneyText(a.amount, e.currency!)}.`, e, "bills", "⬅️ Платежи");
        return true;
      }
      default:
        return false;
    }
  } catch (err) {
    await ctx.reply(`⚠️ ${errMsg(err)}`);
    return true;
  }
}

// ── Buttons ───────────────────────────────────────────────────────────────

export function registerFinance(b: Telegraf): void {
  // Every finance callback is family-only.
  const guard = (fn: (ctx: Context & { match: RegExpExecArray }) => Promise<unknown>) =>
    async (ctx: Context & { match: RegExpExecArray }) => {
      if (!canSeeFinance(ctx.from?.id)) return ctx.answerCbQuery("🔒 Финансы видны только семье");
      try {
        await fn(ctx);
        await ctx.answerCbQuery().catch(() => undefined);
      } catch (err) {
        await ctx.answerCbQuery(errMsg(err), { show_alert: true }).catch(() => undefined);
      }
    };

  b.action("m:fin", guard(financeHome));
  b.action("m:upc", guard(upcomingScreen));
  b.action("m:debts", guard(debtsScreen));
  b.action("m:credits", guard(creditsScreen));
  b.action("m:plan", guard(planScreen));
  b.action("m:rates", guard((ctx) => ratesScreen(ctx)));
  b.action("m:hist", guard(historyScreen));
  b.action("m:ai", guard((ctx) =>
    ask(ctx, { kind: "ask" }, "🤖 <b>Спроси про деньги семьи</b>\nНапример: «сколько останется после зарплаты?», «кого можно закрыть в ноябре?», «на что ушло больше всего в этом месяце?»", "fin")));

  b.action(/^dv:(.+)$/, guard((ctx) => debtCard(ctx, ctx.match[1]!)));
  b.action(/^dup:(.+)$/, guard((ctx) => (moveDebt(ctx.match[1]!, -1), debtCard(ctx, ctx.match[1]!))));
  b.action(/^ddn:(.+)$/, guard((ctx) => (moveDebt(ctx.match[1]!, 1), debtCard(ctx, ctx.match[1]!))));
  b.action(/^dfull:(.+)$/, guard((ctx) => {
    const d = debtsInOrder().debts.find((x) => x.id === ctx.match[1]);
    if (!d) return show(ctx, "Этого долга уже нет.", [back("debts", "⬅️ Долги")]);
    return show(ctx, `Точно отдал <b>${esc(d.name)}</b> всё — ${moneyText(remainingNative(d), d.currency)}?`, [
      [btn("✅ Да, отдал", `dfullok:${d.id}`), btn("⬅️ Нет", `dv:${d.id}`)],
    ]);
  }));
  b.action(/^dfullok:(.+)$/, guard(async (ctx) => {
    const r = payDebt(ctx.match[1]!, null, who(ctx));
    await done(ctx, `✅ <b>${esc(r.entry.label)}</b> — долг закрыт (${moneyText(r.entry.amount!, r.entry.currency!)}). 🎉`, r.entry, "debts", "⬅️ Долги");
  }));
  b.action(/^dpart:(.+)$/, guard((ctx) => {
    const d = debtsInOrder().debts.find((x) => x.id === ctx.match[1]);
    if (!d) return show(ctx, "Этого долга уже нет.", [back("debts", "⬅️ Долги")]);
    return ask(ctx, { kind: "debt-part", debtId: d.id! },
      `✏️ Сколько отдал <b>${esc(d.name)}</b>? Сумма в ${unitOf(d.currency)}, осталось ${moneyText(remainingNative(d), d.currency)}.`, "debts");
  }));
  b.action("dnew", guard((ctx) =>
    ask(ctx, { kind: "debt-new" }, "➕ <b>Новый долг</b>\nНапиши имя и сумму: <code>Петя 500 лей</code>, <code>Ваня 200$</code>, <code>Брат 800 руб</code>.", "debts")));

  b.action(/^inc:(.+)$/, guard((ctx) => {
    const fin = loadFinance();
    const i = fin.incomeSchedule?.find((x) => x.id === ctx.match[1]);
    if (!i) return show(ctx, "Поступление не найдено.", [back("upc")]);
    if (recordedIncome(fin, i.id, currentPeriod())) return show(ctx, `«${esc(i.name)}» в этом месяце уже отмечено.`, [back("upc")]);
    return show(ctx, `📥 <b>${esc(i.name)}</b>\nОжидалось ${moneyText(i.amount, i.currency)}. Сколько пришло?`, [
      [btn(`✅ Ровно ${moneyText(i.amount, i.currency)}`, `incok:${i.id}`)],
      [btn("✏️ Другая сумма", `incamt:${i.id}`)],
      back("upc", "⬅️ Ближайшее"),
    ]);
  }));
  b.action(/^incok:(.+)$/, guard(async (ctx) => {
    const i = loadFinance().incomeSchedule?.find((x) => x.id === ctx.match[1]);
    if (!i) throw new Error("Поступление не найдено");
    const e = recordIncome(i.id, i.amount, i.currency, who(ctx));
    await done(ctx, `📥 <b>${esc(i.name)}</b>: пришло ${moneyText(i.amount, i.currency)}.`, e, "upc", "⬅️ Ближайшее");
  }));
  b.action(/^incamt:(.+)$/, guard((ctx) => {
    const i = loadFinance().incomeSchedule?.find((x) => x.id === ctx.match[1]);
    if (!i) throw new Error("Поступление не найдено");
    return ask(ctx, { kind: "income", incomeId: i.id }, `✏️ Сколько пришло — <b>${esc(i.name)}</b>? Валюту можно указать: <code>1 120$</code>, <code>68 900 лей</code>.`, "upc");
  }));
  b.action("incother", guard((ctx) =>
    ask(ctx, { kind: "income-other" }, "➕ <b>Другое поступление</b>\nНапиши, что и сколько: <code>PS5 4000 лей</code>, <code>Нанашул 2000 лей</code>.", "upc")));

  b.action(/^cp:(.+)$/, guard((ctx) => {
    const fin = loadFinance();
    const c = fin.credits.find((x) => x.id === ctx.match[1]);
    if (!c) return show(ctx, "Кредит не найден.", [back("credits")]);
    if (creditPaid(fin, c.id, currentPeriod())) return show(ctx, `Платёж «${esc(c.name)}» в этом месяце уже отмечен.`, [back("credits")]);
    const due = dueAmount(c, currentPeriod());
    const why = c.paymentOverride?.period === currentPeriod() && c.paymentOverride.note ? ` <i>(${esc(c.paymentOverride.note)})</i>` : "";
    return show(ctx, `📤 <b>${esc(c.name)}</b>\nПлатёж ${moneyText(due, c.currency)}${why}. Оплатил?`, [
      [btn(`✅ Да, ${moneyText(due, c.currency)}`, `cpok:${c.id}`)],
      [btn("✏️ Другая сумма", `cpamt:${c.id}`)],
      back("credits", "⬅️ Кредиты"),
    ]);
  }));
  b.action(/^cpok:(.+)$/, guard(async (ctx) => {
    const c = loadFinance().credits.find((x) => x.id === ctx.match[1]);
    if (!c) throw new Error("Кредит не найден");
    const due = dueAmount(c, currentPeriod());
    const e = recordCreditPayment(c.id, due, who(ctx));
    await done(ctx, `✅ <b>${esc(c.name)}</b>: оплачено ${moneyText(due, c.currency)}. Напоминания по нему в этом месяце больше не будет.`, e, "credits", "⬅️ Кредиты");
  }));
  b.action(/^cpamt:(.+)$/, guard((ctx) =>
    ask(ctx, { kind: "credit", creditId: ctx.match[1]! }, "✏️ Сколько заплатил? Сумма в лей.", "credits")));

  b.action(/^od:(.+)$/, guard((ctx) => {
    const c = loadFinance().credits.find((x) => x.id === ctx.match[1]);
    if (!c?.overdue) return show(ctx, "Просрочки нет. 👍", [back("credits")]);
    return show(ctx, `🔴 <b>${esc(c.name)}</b>: просрочка ~${moneyText(overdueNow(c.overdue, todayLocal()), c.currency)} на сегодня.\nСколько внёс?`, [
      [btn("✅ Погасил полностью", `odfull:${c.id}`)],
      [btn("✏️ Внёс часть", `odpart:${c.id}`)],
      back("credits", "⬅️ Кредиты"),
    ]);
  }));
  b.action(/^odfull:(.+)$/, guard(async (ctx) => {
    const r = payOverdue(ctx.match[1]!, null, who(ctx));
    await done(ctx, `✅ Просрочка погашена (~${moneyText(r.entry.amount!, r.entry.currency!)}). Отлично!`, r.entry, "credits", "⬅️ Кредиты");
  }));
  b.action("cash", guard((ctx) =>
    ask(ctx, { kind: "cash" },
      "💵 <b>Сколько сейчас на руках?</b> Наличные и карты вместе, можно в разных валютах: <code>600$ и 800 руб</code>, <code>450 + 2000 лей</code>. Без валюты — доллары.\nОт этой суммы считается, что реально останется на долги в этом месяце.", "fin")));
  b.action("cbal", guard((ctx) => show(ctx,
    "✏️ <b>Уточнить остаток</b>\nКакой кредит? Возьми в приложении банка сумму <b>досрочного погашения</b> или остаток основного долга.",
    [...loadFinance().credits.map((c) => [btn(c.name, `cbal:${c.id}`)]), back("credits", "⬅️ Кредиты")])));
  b.action(/^cbal:(.+)$/, guard((ctx) => {
    const c = loadFinance().credits.find((x) => x.id === ctx.match[1]);
    if (!c) return show(ctx, "Кредит не найден.", [back("credits")]);
    return ask(ctx, { kind: "credit-balance", creditId: c.id },
      `✏️ Сколько сейчас осталось по <b>${esc(c.name)}</b>? Сумма в ${c.currency === "MDL" ? "лей" : esc(c.currency)}.\nСейчас записано ~${moneyText(c.balance, c.currency)}.`, "credits");
  }));
  b.action(/^odpart:(.+)$/, guard((ctx) =>
    ask(ctx, { kind: "overdue", creditId: ctx.match[1]! }, "✏️ Сколько внёс в просрочку? Сумма в лей.", "credits")));

  b.action("rt:refresh", guard(async (ctx) => {
    const changed = await updateRates();
    await ratesScreen(ctx, changed.length ? `\n✅ Обновлено: ${changed.join(", ")}` : "\n⚠️ Источники не ответили — оставил прежние курсы.");
  }));

  b.action("m:bills", guard(billsScreen));
  b.action(/^bv:(.+)$/, guard((ctx) => billCard(ctx, ctx.match[1]!)));
  b.action("bnew", guard((ctx) =>
    ask(ctx, { kind: "bill-new" }, `➕ <b>Новый платёж</b>\nНазвание, сумма и когда:\n${BILL_EXAMPLES}`, "bills")));
  b.action(/^bedit:(.+)$/, guard((ctx) => {
    const b = findBill(loadFinance(), ctx.match[1]!);
    return ask(ctx, { kind: "bill-edit", billId: b.id },
      `✏️ <b>${esc(b.name)}</b> — напиши заново одной строкой (оплаты сохранятся):\n${BILL_EXAMPLES}`, "bills");
  }));
  b.action(/^bdel:(.+)$/, guard((ctx) => {
    const b = findBill(loadFinance(), ctx.match[1]!);
    return show(ctx, `Удалить платёж <b>${esc(b.name)}</b>?`, [[btn("🗑 Да, удалить", `bdelok:${b.id}`), btn("⬅️ Нет", `bv:${b.id}`)]]);
  }));
  b.action(/^bdelok:(.+)$/, guard(async (ctx) => {
    const b = deleteBill(ctx.match[1]!);
    await show(ctx, `🗑 Удалён: ${esc(b.name)}`, [back("bills", "⬅️ Платежи")]);
  }));
  b.action(/^bp:(.+)$/, guard((ctx) => {
    const fin = loadFinance();
    const bill = findBill(fin, ctx.match[1]!);
    if (billPaid(fin, bill, billPeriod(bill, todayLocal()))) {
      return show(ctx, `«${esc(bill.name)}» за этот период уже отмечен.`, [back("bills", "⬅️ Платежи")]);
    }
    return show(ctx, `🧾 <b>${esc(bill.name)}</b>\nОплатил ${moneyText(bill.amount, bill.currency)}?`, [
      [btn(`✅ Да, ${moneyText(bill.amount, bill.currency)}`, `bpok:${bill.id}`)],
      [btn("✏️ Другая сумма", `bpamt:${bill.id}`)],
      back("bills", "⬅️ Платежи"),
    ]);
  }));
  b.action(/^bpok:(.+)$/, guard(async (ctx) => {
    const bill = findBill(loadFinance(), ctx.match[1]!);
    const e = payBill(bill.id, bill.amount, who(ctx));
    await done(ctx, `🧾 <b>${esc(bill.name)}</b>: оплачено ${moneyText(bill.amount, bill.currency)}.`, e, "bills", "⬅️ Платежи");
  }));
  b.action(/^bpamt:(.+)$/, guard((ctx) => {
    const bill = findBill(loadFinance(), ctx.match[1]!);
    return ask(ctx, { kind: "bill-pay", billId: bill.id }, `✏️ Сколько заплатил за «${esc(bill.name)}»?`, "bills");
  }));

  b.action(/^lg:(.+)$/, guard(async (ctx) => {
    const e = undoEntry(ctx.match[1]!);
    await show(ctx, `↩️ Отменено: ${ledgerLine(e)}`, [back("fin", "⬅️ Финансы")]);
  }));
}
