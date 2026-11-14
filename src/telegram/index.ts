import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { fmt } from "../utils/crypto.js";
import { loadExpenses, addExpense, deleteExpense, CATEGORIES, guessCategory } from "../expenses/index.js";
import type { CashExpense, Currency, Preset } from "../expenses/index.js";
import { addReceiptFromUrl, loadReceipts } from "../receipts/index.js";
import {
  currentWeekDigest,
  monthDigest,
  previousMonth,
  previousWeekDigest,
  todayLocal,
  weekOfMonth,
  weekStart,
  addDays,
  ordinalWeek,
} from "../spending/index.js";
import { loadShopping, createList, toggleItemAt, listTotals, formatQty, USUAL_FREQUENCY } from "../shopping/index.js";
import type { ListSource, ShoppingList } from "../shopping/index.js";
import { aiEnabled, askFinance } from "../ai/index.js";
import { answerFinance, billsScreen, creditsScreen, debtsScreen, financeHome, planScreen, registerFinance, upcomingScreen } from "./finance-screens.js";
import { recordPurchase, registerShopping, shoppingHome, tryStoreLine } from "./shopping-screens.js";
import { registerPhotoReceipts } from "./photo-receipts.js";
import { registerInvest } from "./invest.js";
import { compareStores, formatMonthlyAverages } from "../prices/index.js";
import { productOf, storeById } from "../prices/catalog.js";
import { clearPending, setPending, takePending } from "./pending.js";
import { loadFinance } from "../finance/index.js";
import { payDebt } from "../finance/actions.js";
import { payBill } from "../finance/bills.js";
import { debtPayAmount, inCurrency, matchObligations } from "../finance/match.js";
import { moneyText } from "../finance/schedule.js";
import { backupCaption, buildBackup, logBackup, subscribe, unsubscribe } from "../backup/index.js";
import { LEGACY, MAIN, back, btn, canSeeFinance, errMsg, esc, isAllowed, keyboardFor, show } from "./ui.js";
import type { Rows } from "./ui.js";

let bot: Telegraf | null = null;

const amountLabel = (n: number): string => fmt(n, n % 1 ? 2 : 0);

// ── Texts ─────────────────────────────────────────────────────────────────

function welcomeText(name: string, finance: boolean): string {
  const buttons = [
    "💵 <b>Трата</b> — записать наличку в одно касание",
    "🧾 <b>Чек</b> — как прислать чек по QR-коду",
    "📝 <b>Покупки</b> — список покупок, где что дешевле, рынок и молдавские магазины",
    "📊 <b>Отчёты</b> — сегодня, неделя, месяц",
    ...(finance ? ["💼 <b>Финансы</b> — долги, кредиты, поступления, план месяца"] : []),
    "❓ <b>Помощь</b> — подсказки",
  ];
  return [
    `👋 Привет, ${esc(name)}!`,
    "",
    `Я веду учёт семейных денег. Внизу ${buttons.length === 6 ? "шесть" : "пять"} кнопок:`,
    "",
    ...buttons,
    "",
    "Можно и без кнопок: напиши <code>кофе 30</code> или пришли ссылку на чек.",
  ].join("\n");
}

const HELP_TEXT = [
  "❓ <b>Как пользоваться</b>",
  "",
  "<b>Наличка</b> — «💵 Трата» и кнопка с суммой. Другая сумма — текстом:",
  "<code>кофе 30</code> · <code>50 такси</code> · <code>200 лей обед</code> · <code>12 usd подарок</code>",
  "Без валюты — рубли ПМР.",
  "",
  "<b>Чек</b> — пришли ссылку из QR-кода чека (ПМР и Молдова), разберу по позициям. Нет QR — пришли фото.",
  "",
  "<b>Без чека</b> (рынок, Linella, Casa, Local, Kaufland, METRO) — магазин, товар, количество, цена:",
  "<code>рынок помидоры 2кг 40</code> · <code>Linella молоко 2 шт 36 лей</code> · <code>Kaufland сыр 300г 45</code>",
  "Запишется и трата, и цена — по ним «🏪 Где дешевле» сравнивает магазины.",
  "",
  "<b>Ошибся</b> — «↩️ Отменить» под записью удаляет именно её.",
  "",
  "<b>Финансы</b> — отдал долг, пришли деньги, оплатил кредит: отмечай в «💼 Финансы», тогда долги, календарь и план всегда актуальны. Любое действие можно отменить.",
  "",
  "<i>Сервер выключен? Пиши всё равно: Telegram держит сообщения до суток.</i>",
].join("\n");

const RECEIPT_HOWTO = [
  "🧾 <b>Как записать чек</b>",
  "",
  "1. Открой камеру телефона и наведи на QR-код внизу чека.",
  "2. Появится ссылка — нажми «Поделиться» (или скопируй её).",
  "3. Отправь ссылку сюда, в этот чат.",
  "",
  "Разберу чек по позициям за пару секунд: магазин, сумма, еда/хозтовары.",
  "Работает и с чеками ПМР (Шериф), и с молдавскими (Linella, Casa, аптеки — ссылка mev.sfs.md).",
  "",
  "📷 <b>Нет QR-кода или ссылка не открывается</b> — пришли <b>фото чека</b>: ровно, целиком, при хорошем свете. " +
    "Мелкий шрифт лучше отправлять «как файл» (без сжатия). Я покажу, что распознал, и сохраню после «✅ Сохранить».",
].join("\n");

// ── Receipts by link ──────────────────────────────────────────────────────

/** Fiscal QR → link → bot: the whole receipt, item by item, same parser as the web page. */
async function handleReceiptLink(ctx: Context, url: string): Promise<void> {
  await ctx.sendChatAction("typing").catch(() => undefined);
  try {
    const { receipt: r, duplicate } = await addReceiptFromUrl(url);
    const share = (group: string): number =>
      r.total > 0 ? (r.items.filter((i) => i.group === group).reduce((s, i) => s + i.total, 0) / r.total) * 100 : 0;
    const unknown = r.items.filter((i) => i.category === "Не разобрано").length;
    const lines = [
      `🧾 <b>Чек ${duplicate ? "обновлён" : "записан"}</b>`,
      `${esc(r.merchant)} · ${r.date.slice(8, 10)}.${r.date.slice(5, 7)}${r.time ? " " + r.time.slice(0, 5) : ""}`,
      `<b>${fmt(r.total, 2)} ${r.currency}</b> ($${fmt(r.totalUsd, 2)}) · ${r.items.length} поз.`,
      `🍽 еда ${fmt(share("food"))}% · 🧴 хоз ${fmt(share("household"))}%`,
    ];
    if (unknown > 0) lines.push(`⚠️ Не разобрано: ${unknown} поз. — категории можно поправить на сайте`);
    if (r.mismatch) lines.push("⚠️ Сумма позиций не сходится с итогом чека — проверь на сайте");
    logger.info(`[Telegram] Receipt ${duplicate ? "updated" : "added"} by ${ctx.from?.first_name}: ${r.merchant} ${r.date} ${r.total} ${r.currency}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply(`Не смог разобрать чек: ${errMsg(err)}\n\nКак правильно — /receipt`);
  }
}

// ── 💵 Трата ──────────────────────────────────────────────────────────────

function spendScreen(ctx: Context): Promise<void> {
  const presets = loadExpenses().presets;
  const rows: Rows = [];
  for (let i = 0; i < presets.length; i += 3) {
    rows.push(presets.slice(i, i + 3).map((p) => btn(`${p.label} ${amountLabel(p.amount)}`, `ex:${p.id}`)));
  }
  rows.push([btn("↩️ Отменить мою последнюю", "ex:undo")]);
  return show(
    ctx,
    "💵 <b>Записать трату</b>\nНажми — запишется сразу. Другая сумма или категория — напиши текстом: <code>кофе 30</code>, <code>200 лей обед</code>.",
    rows,
  );
}

function describeExpense(e: CashExpense): string {
  return `${esc(e.category)} — ${amountLabel(e.amount)} ${e.currency}`;
}

async function confirmExpense(ctx: Context, e: CashExpense, backdated = false): Promise<void> {
  // "учёба 1663" or "штраф жены 900 лей" is a bill/debt payment, not spending:
  // offer to move it, so the report isn't inflated and the item gets closed.
  const matches = e.note && canSeeFinance(ctx.from?.id) ? matchObligations(loadFinance(), e.note) : [];
  const rows = [
    ...matches.map((m) => [btn(`${m.kind === "bill" ? "🧾 Это платёж" : "👥 Это долг"}: ${m.name}`, `mv:${e.id}:${m.kind[0]}:${m.id}`)]),
    [btn("↩️ Отменить", `undo:${e.id}`)],
  ];
  await ctx.reply(
    `✓ ${describeExpense(e)} <i>($${fmt(e.amountUsd, 2)})</i>` +
      (e.note ? `\n📝 ${esc(e.note)}` : "") +
      (backdated ? `\n<i>записано задним числом за ${e.date}</i>` : "") +
      (matches.length ? "\n\nЕсли это оплата из списка ниже — нажми, перенесу в 💼 Финансы и уберу из трат." : ""),
    { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) },
  );
}

/** mv:<expenseId>:<b|d>:<id> — turn a logged spend into a bill/debt payment. */
function moveExpenseToFinance(ctx: Context, expenseId: string, kind: string, id: string): string {
  const e = loadExpenses().expenses.find((x) => x.id === expenseId);
  if (!e) return "Эта трата уже удалена.";
  const fin = loadFinance();
  const by = ctx.from?.first_name;
  let done: string;
  if (kind === "b") {
    const bill = (fin.bills ?? []).find((x) => x.id === id);
    if (!bill) return "Такого платежа уже нет.";
    const amount = inCurrency(fin, e.amount, e.currency, bill.currency);
    payBill(bill.id, amount, by, e.date);
    done = `🧾 Платёж «${esc(bill.name)}» отмечен: ${moneyText(amount, bill.currency)}`;
  } else {
    const debt = fin.personalDebts.find((x) => x.id === id);
    if (!debt) return "Такого долга уже нет.";
    const amount = inCurrency(fin, e.amount, e.currency, debt.currency);
    const r = payDebt(id, debtPayAmount(fin, id, amount), by);
    done = r.closed
      ? `👥 Долг «${esc(debt.name)}» закрыт ✅`
      : `👥 «${esc(debt.name)}»: отдано ${moneyText(amount, debt.currency)}, осталось ${moneyText(r.left, debt.currency)}`;
  }
  deleteExpense(e.id);
  return `${done}\nИз трат убрал. Отменить можно в 💼 Финансы → 📜 История.`;
}

/** Only your own entries: with two people logging, "last" would hit the other's coffee. */
function undoLastOf(ctx: Context): string {
  const uid = ctx.from?.id;
  const name = ctx.from?.first_name;
  const mine = loadExpenses()
    .expenses.filter((e) => (e.addedById !== undefined ? e.addedById === uid : !!name && e.addedBy === name))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = mine[0];
  if (!last) return "Нечего отменять — твоих записей нет.";
  deleteExpense(last.id);
  return `↩️ Удалено: ${describeExpense(last)} (${last.date})`;
}

// ── 📊 Отчёты ─────────────────────────────────────────────────────────────

function todaySummary(): string {
  const today = todayLocal();
  const cash = loadExpenses().expenses.filter((e) => e.date === today);
  const receipts = loadReceipts().receipts.filter((r) => r.date === today);
  if (cash.length === 0 && receipts.length === 0) return "📊 Сегодня ещё ничего не записано.";
  const total = cash.reduce((s, e) => s + e.amountUsd, 0) + receipts.reduce((s, r) => s + r.totalUsd, 0);
  const lines = [`📊 <b>Сегодня</b>: <b>$${fmt(total, 2)}</b>`];
  for (const r of receipts) lines.push(`🧾 ${esc(r.merchant)} — ${fmt(r.total, 2)} ${r.currency}`);
  for (const e of cash) lines.push(`💵 ${describeExpense(e)}` + (e.addedBy ? ` <i>(${esc(e.addedBy)})</i>` : ""));
  return lines.join("\n");
}

const REPORTS: Record<string, () => string> = {
  today: todaySummary,
  week: () => currentWeekDigest(),
  month: () => monthDigest(todayLocal().slice(0, 7)),
  pweek: () => previousWeekDigest(),
  pmonth: () => monthDigest(previousMonth()),
  avg: () => formatMonthlyAverages(),
};

function reportsScreen(ctx: Context): Promise<void> {
  return show(ctx, "📊 <b>Отчёты</b>\nЧеки и наличка вместе. По понедельникам итог недели приходит сам.", [
    [btn("📊 Сегодня", "r:today"), btn("📅 Неделя", "r:week"), btn("🗓 Месяц", "r:month")],
    [btn("⏪ Прошлая неделя", "r:pweek"), btn("⏪ Прошлый месяц", "r:pmonth")],
    [btn("📈 В среднем за месяц", "r:avg"), btn("🏪 Где дешевле", "m:cheaper")],
  ]);
}

// ── 📝 Покупки ────────────────────────────────────────────────────────────

/** Telegram allows 100 buttons per keyboard; leave room for the nav rows. */
const MAX_LIST_BUTTONS = 90;
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** "Молоко — Шериф, Яйца — Рынок": where the list's items were cheapest (known in 2+ stores). */
function cheapestTips(list: ShoppingList): string {
  const compared = compareStores().compared;
  const seen = new Set<string>();
  const tips: string[] = [];
  for (const i of list.items) {
    if (i.checked) continue;
    const p = productOf(i.name);
    const c = p && !seen.has(p.id) ? compared.find((x) => x.product.id === p.id) : undefined;
    if (!p || !c) continue;
    seen.add(p.id);
    tips.push(`${esc(p.name)} — ${esc(c.cheapest.storeName)}`);
  }
  return tips.length ? `\n💡 Дешевле всего: ${tips.slice(0, 6).join(", ")}${tips.length > 6 ? "…" : ""}` : "";
}

function listView(list: ShoppingList, others: ShoppingList[]) {
  const t = listTotals(list);
  const doneCount = list.items.filter((i) => i.checked).length;
  const text = [
    `📝 <b>${esc(list.title)}</b>`,
    `<i>${esc(list.basis)}</i>`,
    "",
    `Отмечено ${doneCount} из ${list.items.length} · осталось ~${fmt(t.left)} руб` + cheapestTips(list),
    list.items.length > MAX_LIST_BUTTONS ? `Показаны первые ${MAX_LIST_BUTTONS} — весь список на сайте.` : "Нажми на позицию, чтобы отметить.",
  ].join("\n");
  const rows = list.items.slice(0, MAX_LIST_BUTTONS).map((i, idx) => [
    btn(
      `${i.checked ? "✅" : "▫️"} ${truncate(i.name, 34)} · ${formatQty(i)}` + ((i.frequency ?? 1) < USUAL_FREQUENCY ? " · иногда" : ""),
      `sl:${list.id}:${list.rev}:${idx}`,
    ),
  ]);
  if (others.length > 0) rows.push(others.slice(0, 3).map((o) => btn(`📋 ${truncate(o.title, 22)}`, `slv:${o.id}`)));
  rows.push([btn("➕ Новый список", "slnew"), btn("⬅️ Покупки", "m:shop")]);
  return { text, rows };
}

const listsByRecency = (): ShoppingList[] =>
  [...loadShopping().lists].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

function newListRows(): Rows {
  const n = weekOfMonth(weekStart(todayLocal())).n;
  return [
    [btn("🔁 Как прошлая неделя", "slnew:pw")],
    [btn(`📆 Типичная ${ordinalWeek(n)} (как сейчас)`, `slnew:tw:${n}`)],
    [btn("🗓 Типичный месяц", "slnew:tm")],
  ];
}

function listScreen(ctx: Context): Promise<void> {
  const lists = listsByRecency();
  const list = lists[0];
  if (!list) {
    return show(ctx, "📝 Списков пока нет. Из чего собрать?\n<i>Списки строятся по чекам — чем больше чеков, тем точнее.</i>", newListRows());
  }
  const v = listView(list, lists.slice(1));
  return show(ctx, v.text, v.rows);
}

function sourceFromCallback(code: string): ListSource {
  const today = todayLocal();
  if (code === "pw") {
    const from = addDays(weekStart(today), -7);
    return { kind: "period", from, to: addDays(from, 6) };
  }
  if (code.startsWith("tw:")) return { kind: "typical-week", n: Number(code.slice(3)) };
  return { kind: "typical-month" };
}

// ── Parsing ───────────────────────────────────────────────────────────────

/**
 * Telegram queues updates for ~24h while the bot is offline and replays them on
 * reconnect, so the expense must be dated by when the message was *sent* — and
 * on the family's local calendar, or a coffee after midnight lands on yesterday.
 */
export function dateOfMessage(unixSeconds?: number): { date: string; backdated: boolean } {
  const ms = unixSeconds ? unixSeconds * 1000 : Date.now();
  const backdated = Date.now() - ms > 5 * 60_000;
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { date, backdated };
}

/** "кофе 30", "30 кофе", "35" — anything with a number and maybe a word. */
export function parseFreeform(
  text: string,
  presets: Preset[],
): { amount: number; category: string; currency: Currency; note?: string } | null {
  const amountMatch = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1]!.replace(",", "."));
  if (!(amount > 0)) return null;

  const lower = text.replace(amountMatch[0], " ").trim().toLowerCase();
  let currency: Currency = "RUP";
  if (/лей|mdl/i.test(lower)) currency = "MDL";
  else if (/\$|usd|долл/i.test(lower)) currency = "USD";
  else if (/€|eur|евро/i.test(lower)) currency = "EUR";

  const words = lower.replace(/руб|лей|mdl|usd|eur|евро|долл|\$|€/gi, "").trim();
  for (const p of presets) {
    const bare = p.label.replace(/[^\p{L}]/gu, "").toLowerCase();
    if (bare && words.includes(bare.slice(0, 4))) return { amount, category: p.category, currency };
  }
  for (const c of CATEGORIES) {
    if (words && c.toLowerCase().includes(words.split(/\s+/)[0]!)) return { amount, category: c, currency };
  }
  return { amount, category: guessCategory(words) ?? "Прочее", currency, note: words || undefined };
}

// ── Bot ───────────────────────────────────────────────────────────────────

async function answerQuestion(ctx: Context, question: string): Promise<void> {
  await ctx.sendChatAction("typing").catch(() => undefined);
  const answer = await askFinance(question);
  await ctx.reply(answer, Markup.inlineKeyboard([[btn("🤖 Ещё вопрос", "m:ai"), btn("💼 Финансы", "m:fin")]]));
}

/** Exported so the handlers can be exercised with a stubbed Telegram API. */
export function createBot(token: string): Telegraf {
  const b = new Telegraf(token);

  // Strangers get a polite answer with their id instead of silence — silence
  // looks exactly like a broken bot.
  b.use(async (ctx, next) => {
    if (!ctx.from || isAllowed(ctx.from.id)) return next();
    logger.info(`[Telegram] Denied id=${ctx.from.id} (${ctx.from.first_name})`);
    if (ctx.callbackQuery) return ctx.answerCbQuery("Нет доступа");
    if (ctx.message) {
      await ctx.reply(
        `🔒 Это приватный семейный бот.\nТвой id: <code>${ctx.from.id}</code> — передай его владельцу, чтобы он открыл доступ.`,
        { parse_mode: "HTML" },
      );
    }
  });

  const replyMenu = (ctx: Context, text: string) => ctx.reply(text, { parse_mode: "HTML", ...keyboardFor(ctx) });
  const financeOnly = (fn: (ctx: Context) => Promise<unknown>) => (ctx: Context) =>
    canSeeFinance(ctx.from?.id) ? fn(ctx) : ctx.reply("🔒 Финансы видны только семье.");

  b.start((ctx) => {
    clearPending(ctx.from.id);
    return replyMenu(ctx, welcomeText(ctx.from.first_name, canSeeFinance(ctx.from.id)));
  });
  b.help((ctx) => helpScreen(ctx));
  b.command("receipt", (ctx) => replyMenu(ctx, RECEIPT_HOWTO));
  b.command("id", (ctx) => ctx.reply(`Твой Telegram id: <code>${ctx.from.id}</code>`, { parse_mode: "HTML" }));
  for (const [cmd, key] of [["today", "today"], ["week", "week"], ["month", "month"]] as const) {
    b.command(cmd, (ctx) => replyMenu(ctx, REPORTS[key]!()));
  }
  b.command("list", listScreen);
  b.command("undo", (ctx) => replyMenu(ctx, undoLastOf(ctx)));
  b.command("finance", financeOnly(financeHome));
  b.command("upcoming", financeOnly(upcomingScreen));
  b.command("debts", financeOnly(debtsScreen));
  b.command("credits", financeOnly(creditsScreen));
  b.command("plan", financeOnly(planScreen));
  b.command("bills", financeOnly(billsScreen));
  // /backup — the data/ zip now, and every week after; /backup off — stop.
  b.command("backup", financeOnly(async (ctx) => {
    const chatId = String(ctx.chat!.id);
    const arg = ((ctx.message as { text?: string } | undefined)?.text ?? "").replace(/^\/backup(@\S+)?\s*/, "").trim();
    if (/^(off|stop|выкл|стоп|нет)$/i.test(arg)) {
      return ctx.reply(unsubscribe(chatId) ? "💾 Еженедельные копии отключены." : "Ты и не был подписан.");
    }
    try {
      const bk = buildBackup();
      await ctx.replyWithDocument({ source: bk.buffer, filename: bk.filename }, { caption: backupCaption(bk) });
      logBackup(chatId, bk);
    } catch (err) {
      return ctx.reply(`Не получилось собрать копию: ${errMsg(err)}`);
    }
    const isNew = subscribe(chatId);
    return ctx.reply(
      (isNew ? "✅ Подписал: такая копия будет приходить каждое воскресенье в 21:00." : "Ты уже получаешь копию каждое воскресенье в 21:00.") +
        "\nОтключить — /backup off",
    );
  }));
  b.command("ask", financeOnly(async (ctx) => {
    const q = ((ctx.message as { text?: string } | undefined)?.text ?? "").replace(/^\/ask(@\S+)?\s*/, "").trim();
    if (q) return answerQuestion(ctx, q);
    setPending(ctx.from!.id, { kind: "ask" });
    return ctx.reply("🤖 Задай вопрос одним сообщением — про долги, кредиты, план или траты.");
  }));

  function helpScreen(ctx: Context): Promise<unknown> {
    const rows: Rows = [[btn("🧾 Как записать чек", "h:receipt")]];
    if (canSeeFinance(ctx.from?.id) && aiEnabled()) rows.push([btn("🤖 Спросить ИИ", "m:ai")]);
    return ctx.reply(HELP_TEXT, { parse_mode: "HTML", ...keyboardFor(ctx) }).then(() =>
      rows.length ? ctx.reply("Ещё:", Markup.inlineKeyboard(rows)) : undefined,
    );
  }

  // Inline screens of the non-finance sections.
  b.action("m:spend", async (ctx) => { await spendScreen(ctx); await ctx.answerCbQuery(); });
  b.action("m:reports", async (ctx) => { await reportsScreen(ctx); await ctx.answerCbQuery(); });
  b.action("h:receipt", async (ctx) => { await show(ctx, RECEIPT_HOWTO); await ctx.answerCbQuery(); });
  b.action("m:list", async (ctx) => { await listScreen(ctx); await ctx.answerCbQuery(); });
  b.action(/^r:(today|week|month|pweek|pmonth|avg)$/, async (ctx) => {
    await show(ctx, REPORTS[ctx.match[1]!]!(), [back("reports", "⬅️ Отчёты")]);
    await ctx.answerCbQuery();
  });

  // One-tap cash entry from the 💵 screen: ex:<presetId> | ex:undo
  b.action(/^ex:(.+)$/, async (ctx) => {
    if (ctx.match[1] === "undo") {
      await ctx.answerCbQuery(undoLastOf(ctx).replace(/<[^>]+>/g, ""), { show_alert: true });
      return;
    }
    const p = loadExpenses().presets.find((x) => x.id === ctx.match[1]);
    if (!p) return ctx.answerCbQuery("Кнопка устарела — открой «💵 Трата» заново");
    const e = addExpense({
      amount: p.amount, currency: p.currency, category: p.category, date: todayLocal(), presetId: p.id,
      source: "telegram", addedBy: ctx.from.first_name, addedById: ctx.from.id,
    });
    await ctx.answerCbQuery(`✓ ${p.category} ${amountLabel(e.amount)}`);
    await confirmExpense(ctx, e);
  });

  // Undo one specific entry from the button under its confirmation: undo:<expenseId>
  b.action(/^undo:(.+)$/, async (ctx) => {
    const id = ctx.match[1]!;
    const entry = loadExpenses().expenses.find((e) => e.id === id);
    if (!entry || !deleteExpense(id)) return ctx.answerCbQuery("Уже удалено");
    await ctx.editMessageText(`<s>✓ ${describeExpense(entry)}</s> — отменено`, { parse_mode: "HTML" });
    await ctx.answerCbQuery("Отменено");
  });

  b.action(/^mv:([^:]+):([bd]):(.+)$/, async (ctx) => {
    if (!canSeeFinance(ctx.from?.id)) return ctx.answerCbQuery("Финансы видны только семье");
    let text: string;
    try {
      text = moveExpenseToFinance(ctx, ctx.match[1]!, ctx.match[2]!, ctx.match[3]!);
    } catch (err) {
      text = `Не получилось: ${esc(errMsg(err))}`;
    }
    await ctx.editMessageText(text, { parse_mode: "HTML" });
    await ctx.answerCbQuery();
  });

  // Shopping lists: tick sl:<listId>:<rev>:<index>, switch slv:<listId>, create slnew[:…]
  b.action(/^sl:([a-z0-9]+):(\d+):(\d+)$/, async (ctx) => {
    const [, id, rev, idx] = ctx.match;
    try {
      const list = toggleItemAt(id!, Number(rev), Number(idx));
      const v = listView(list, listsByRecency().filter((l) => l.id !== list.id));
      await show(ctx, v.text, v.rows);
      await ctx.answerCbQuery();
    } catch (err) {
      await ctx.answerCbQuery(errMsg(err), { show_alert: true });
    }
  });
  b.action(/^slv:([a-z0-9]+)$/, async (ctx) => {
    const lists = listsByRecency();
    const list = lists.find((l) => l.id === ctx.match[1]);
    if (!list) return ctx.answerCbQuery("Список удалён", { show_alert: true });
    const v = listView(list, lists.filter((l) => l.id !== list.id));
    await show(ctx, v.text, v.rows);
    await ctx.answerCbQuery();
  });
  b.action("slnew", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Из чего собрать список?", Markup.inlineKeyboard(newListRows()));
  });
  b.action(/^slnew:(pw|tw:[1-5]|tm)$/, async (ctx) => {
    try {
      const list = createList(sourceFromCallback(ctx.match[1]!));
      const v = listView(list, listsByRecency().filter((l) => l.id !== list.id));
      await show(ctx, v.text, v.rows);
      await ctx.answerCbQuery("Готово");
    } catch (err) {
      await ctx.answerCbQuery(errMsg(err), { show_alert: true });
    }
  });

  registerFinance(b);
  registerInvest(b);
  registerShopping(b);
  registerPhotoReceipts(b);

  b.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) {
      await ctx.reply("Не знаю такой команды. Всё, что умею, — /help");
      return;
    }

    // Main-menu buttons always win and cancel any pending question.
    const menu: Record<string, () => Promise<unknown>> = {
      [MAIN.spend]: () => spendScreen(ctx),
      [MAIN.receipt]: () => replyMenu(ctx, RECEIPT_HOWTO),
      [MAIN.list]: () => shoppingHome(ctx),
      [MAIN.reports]: () => reportsScreen(ctx),
      [MAIN.finance]: financeOnly(financeHome).bind(null, ctx),
      [MAIN.help]: () => helpScreen(ctx),
    };
    const legacy: Record<string, () => Promise<unknown>> = {
      today: () => replyMenu(ctx, REPORTS.today!()),
      week: () => replyMenu(ctx, REPORTS.week!()),
      month: () => replyMenu(ctx, REPORTS.month!()),
      list: () => listScreen(ctx),
      undo: () => replyMenu(ctx, undoLastOf(ctx)),
      debts: financeOnly(debtsScreen).bind(null, ctx),
      upcoming: financeOnly(upcomingScreen).bind(null, ctx),
    };
    const menuKey = Object.keys(menu).find((k) => text.startsWith(k));
    if (menuKey) {
      clearPending(ctx.from.id);
      await menu[menuKey]!();
      return;
    }
    const legacyKey = Object.keys(LEGACY).find((k) => text.startsWith(k));
    if (legacyKey) {
      clearPending(ctx.from.id);
      await legacy[LEGACY[legacyKey]!]!();
      return;
    }

    // A link is a receipt (or nothing). It must never reach the expense
    // parser below, which would happily log the first number in the URL.
    const link = text.match(/https?:\/\/\S+/i)?.[0];
    if (link) return handleReceiptLink(ctx, link);

    // The answer to a question a screen just asked ("сколько отдал?").
    const pending = takePending(ctx.from.id);
    if (pending) {
      if (pending.kind === "ask") return answerQuestion(ctx, text);
      if (pending.kind === "purchase") {
        const store = storeById(pending.storeId);
        if (store && (await recordPurchase(ctx, store, text))) return;
        setPending(ctx.from.id, pending);
        await ctx.reply("Не разобрал 🤔 Нужны товар и цена: <code>помидоры 2кг 40</code>, <code>молоко 2 шт 36</code>.", { parse_mode: "HTML" });
        return;
      }
      if (await answerFinance(ctx, pending, text)) return;
    }

    // "рынок помидоры 2кг 40" — a purchase with a store, item and price.
    if (await tryStoreLine(ctx, text)) return;

    const store = loadExpenses();
    const { date, backdated } = dateOfMessage(ctx.message.date);
    const who = { addedBy: ctx.from.first_name, addedById: ctx.from.id, source: "telegram" as const };

    // Old keyboard buttons carry their amount, e.g. "☕ Кофе 25".
    const preset = store.presets.find((p) => text.startsWith(p.label));
    let added: CashExpense;
    try {
      if (preset) {
        const amt = parseFloat(text.slice(preset.label.length).replace(",", ".").trim());
        added = addExpense({
          amount: Number.isFinite(amt) && amt > 0 ? amt : preset.amount,
          currency: preset.currency, category: preset.category, date, presetId: preset.id, ...who,
        });
      } else {
        const parsed = parseFreeform(text, store.presets);
        if (!parsed) {
          await replyMenu(ctx,
            "Не понял 🤔 Нажми «💵 Трата» или напиши так: <code>кофе 30</code>, <code>50 такси</code>, <code>200 лей обед</code>.\nЧек — пришли ссылку из QR-кода. Всё остальное — /help");
          return;
        }
        added = addExpense({ ...parsed, date, ...who });
      }
    } catch (err) {
      await ctx.reply(`Не записалось: ${errMsg(err)}`);
      return;
    }
    await confirmExpense(ctx, added, backdated);
  });

  // Without this, Telegraf rethrows any handler error and the polling loop
  // dies with it — the bot goes silent until the next restart.
  b.catch(async (err, ctx) => {
    logger.error(`[Telegram] Handler failed on ${ctx.updateType}`, err);
    await ctx.reply("⚠️ Что-то пошло не так, попробуй ещё раз.").catch(() => undefined);
  });

  return b;
}

/** ☰ menu commands and the texts shown before the user presses Start. */
async function setupProfile(b: Telegraf): Promise<void> {
  const common = [
    { command: "start", description: "🏠 Главное меню" },
    { command: "today", description: "📊 Траты за сегодня" },
    { command: "week", description: "📅 Неделя: итог и сравнение" },
    { command: "month", description: "🗓 Месяц против бюджета" },
    { command: "list", description: "📝 Список покупок" },
    { command: "receipt", description: "🧾 Как записать чек" },
    { command: "undo", description: "↩️ Отменить свою последнюю трату" },
    { command: "help", description: "❓ Как пользоваться" },
  ];
  const finance = [
    { command: "finance", description: "💼 Финансы: долги, кредиты, план" },
    { command: "upcoming", description: "📆 Ближайшие поступления и платежи" },
    { command: "debts", description: "👥 Долги — отметить, что отдал" },
    { command: "plan", description: "🗓 План месяца" },
    { command: "bills", description: "🧾 Регулярные платежи" },
    { command: "invest", description: "📈 Портфель: разложить взнос — /invest 100" },
    { command: "backup", description: "💾 Копия всех данных (и каждую неделю)" },
    ...(aiEnabled() ? [{ command: "ask", description: "🤖 Спросить ИИ про деньги" }] : []),
  ];
  try {
    await b.telegram.setMyCommands(common);
    for (const id of new Set(config.telegram.financeIds)) {
      await b.telegram.setMyCommands([common[0]!, ...finance, ...common.slice(1)], { scope: { type: "chat", chat_id: Number(id) } });
    }
    await b.telegram.setMyShortDescription("Семейные деньги: траты по чекам и наличке, долги, кредиты, план месяца.");
    await b.telegram.setMyDescription(
      "👋 Семейный бот учёта денег.\n\n" +
        "🧾 Пришли ссылку из QR-кода чека — разберу его по позициям.\n" +
        "💵 Наличка — в одно касание или текстом «кофе 30».\n" +
        "📊 Отчёты за неделю и месяц, по понедельникам — итог сам.\n" +
        "💼 Долги, кредиты, поступления и план месяца — с напоминаниями о платежах.\n\n" +
        "Нажми «Запустить», чтобы начать.",
    );
  } catch (err) {
    logger.warn("[Telegram] Could not update bot menu/description", err);
  }
}

/**
 * Long polling with automatic recovery. The common failure is 409 Conflict
 * right after a restart: the previous process's getUpdates is still open on
 * Telegram's side for up to ~50s. Without a retry the bot stays deaf.
 */
function startPolling(token: string, attempt = 0): void {
  const b = createBot(token);
  bot = b;
  b.launch(() => {
    attempt = 0;
    logger.info(`[Telegram] Bot is listening (polling)`);
    void setupProfile(b);
  }).catch((err) => {
    const delay = Math.min(60, 5 * 2 ** attempt);
    logger.error(`[Telegram] Polling stopped — retrying in ${delay}s`, err);
    setTimeout(() => startPolling(token, attempt + 1), delay * 1000);
  });
}

export function getTelegramBot(): Telegraf | null {
  if (!config.telegram.botToken) {
    logger.warn("[Telegram] TELEGRAM_BOT_TOKEN is not set — bot disabled");
    return null;
  }
  if (bot) return bot;

  startPolling(config.telegram.botToken);

  // Release the long poll on shutdown so the next start doesn't hit 409.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      bot?.stop(sig);
      process.exit(0);
    });
  }

  const gate = config.telegram.allowedIds.length > 0
    ? config.telegram.allowedIds.join(", ")
    : config.telegram.chatId || "никто (не задан ни ALLOWED_IDS, ни CHAT_ID)";
  logger.info(`[Telegram] Starting bot. Доступ: ${gate}; финансы видят: ${config.telegram.financeIds.join(", ") || "—"}; ИИ: ${aiEnabled() ? "вкл" : "выкл"}`);
  return bot;
}
