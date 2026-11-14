import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger.js";
import { FALLBACK, MODEL, aiEnabled, getClient } from "./client.js";
import { debtsInOrder, overdueNow, remainingNative, recentLedger } from "../finance/actions.js";
import { upcomingEvents } from "../finance/schedule.js";
import { buildMonthPlan } from "../finance/plan.js";
import { compareStores } from "../prices/index.js";
import { billPaid, billPeriod } from "../finance/bills.js";
import { loadReceipts } from "../receipts/index.js";
import { loadExpenses } from "../expenses/index.js";
import {
  buildMonthReport,
  buildWeekReport,
  collectEntries,
  todayLocal,
  variableBudgetUsd,
  weekStart,
} from "../spending/index.js";

// Free-form questions about the family's money ("сколько останется после
// зарплаты?"), answered by Claude from a snapshot of the app's own data.
// Off unless ANTHROPIC_API_KEY is set; note that the snapshot — debts with
// names, credits, spending — is sent to the Anthropic API with each question.

export { aiEnabled } from "./client.js";

const SYSTEM = `Ты — помощник семьи по личным финансам в Telegram-боте. Семья из 5 человек живёт в Приднестровье (Молдова). Валюты: молдавский лей (MDL), рубль ПМР (RUP), доллар (USD), евро (EUR).

Отвечай на вопрос, опираясь только на данные в <data>. Считай аккуратно, с курсами из данных. Если данных не хватает, скажи, чего именно не хватает, — не выдумывай цифры.

Пиши по-русски, коротко: обычно 3–8 строк, цифры округляй. Это сообщение в Telegram — без таблиц, Markdown и HTML; можно эмодзи и простые списки через «•».

Как устроены данные: personalDebts — личные долги в порядке отдачи (priority 1 = первым). credits — кредиты с ежемесячным платежом и днём платежа; overdueNow — текущая просрочка. incomeSchedule — ожидаемые поступления по дням месяца. monthPlan — расчёт месяца: приход минус кредиты, просрочка и быт, остаток по очереди долгов. ledger — что уже отмечено (отдано, пришло, оплачено). storePrices — цена за кг/л/шт по магазинам в рублях ПМР по последней покупке; Шериф и рынок в ПМР, Linella/Casa Europeana/Local — Молдова, Kaufland и METRO требуют отдельной поездки (needsTrip).`;

/** Compact snapshot of everything the bot knows, for the model to reason over. */
export function financeSnapshot(): Record<string, unknown> {
  const today = todayLocal();
  const { fin, debts } = debtsInOrder();
  const entries = collectEntries(loadReceipts(), loadExpenses());
  const week = buildWeekReport(entries, weekStart(today), today);
  const month = buildMonthReport(entries, today.slice(0, 7), today, variableBudgetUsd());
  const plan = buildMonthPlan(fin, today);
  const r = (n: number) => Math.round(n);

  return {
    today,
    rates: { mdlPerUsd: fin.mdlPerUsd, rubPerUsd: fin.rubPerUsd, usdPerEur: fin.usdPerEur, updated: fin.ratesUpdatedAt },
    monthlyIncomeUsd: fin.monthlyIncomeUsd,
    monthlyLifeCostUsd: fin.monthlyLifeCostUsd,
    monthlyVariableBudgetUsd: fin.monthlyVariableBudgetUsd,
    personalDebts: debts.map((d) => ({
      name: d.name, remaining: r(remainingNative(d)), currency: d.currency, usd: r(d.amountUsd), priority: d.priority, note: d.note,
    })),
    credits: fin.credits.map((c) => ({
      name: c.name, balance: r(c.balance), currency: c.currency, monthlyPayment: r(c.monthlyPayment), aprPct: c.aprPct,
      paymentDay: c.paymentDay ?? null, overdueNow: c.overdue ? r(overdueNow(c.overdue, today)) : 0,
    })),
    incomeSchedule: (fin.incomeSchedule ?? []).map((i) => ({
      name: i.name, amount: i.amount, currency: i.currency, days: `${i.dayFrom}-${i.dayTo}`, plan: i.plan,
    })),
    upcoming21days: upcomingEvents(fin, today).map((e) => ({
      kind: e.kind, name: e.name, from: e.from || null, to: e.to || null, amount: r(e.amount), currency: e.currency, done: !!e.done,
    })),
    monthPlan: {
      incomeUsd: r(plan.incomeUsd), creditsUsd: r(plan.creditsUsd), overdueUsd: r(plan.overdueUsd), livingUsd: r(plan.livingUsd),
      alreadyPaidBackUsd: r(plan.paidBackUsd), freeForDebtsUsd: r(plan.freeUsd),
      allocations: plan.allocations.map((a) => ({ name: a.name, payUsd: r(a.payUsd), closes: a.closes })),
    },
    spending: {
      thisWeekUsd: r(week.summary.totalUsd), previousWeekUsd: r(week.previous.totalUsd), averageWeekUsd: week.avgUsd === null ? null : r(week.avgUsd),
      thisMonthUsd: r(month.summary.totalUsd), monthProjectionUsd: month.projectedUsd === null ? null : r(month.projectedUsd),
      topCategoriesThisMonth: month.summary.categories.slice(0, 6).map((c) => ({ category: c.category, usd: r(c.totalUsd) })),
    },
    // Price per kg/l/piece by store, converted to ПМР roubles (latest purchase in each store).
    storePrices: compareStores(today).compared.slice(0, 20).map((c) => ({
      product: c.product.name, unit: c.product.unit, usualStore: c.usual.storeName,
      byStoreRub: c.stores.map((s) => ({ store: s.storeName, rub: Math.round(s.rub * 10) / 10, date: s.date, needsTrip: s.trip })),
      monthlySavingRub: Math.round(c.monthlySavingRub),
    })),
    bills: (fin.bills ?? []).map((b) => ({
      name: b.name, amount: b.amount, currency: b.currency, every: b.every, day: b.day ?? null, dueDate: b.dueDate ?? null,
      includedInLifeCost: !!b.inLifeCost, paidThisPeriod: !!billPaid(fin, b, billPeriod(b, today)),
    })),
    ledgerRecent: recentLedger(15).map((e) => ({ date: e.date, kind: e.kind, label: e.label, amount: e.amount, currency: e.currency })),
  };
}

export async function askFinance(question: string): Promise<string> {
  if (!aiEnabled()) {
    return "🤖 ИИ не подключён: добавь ANTHROPIC_API_KEY в .env и перезапусти приложение.";
  }
  const data = JSON.stringify(financeSnapshot());

  try {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Arithmetic over a few dozen numbers — medium is enough (and the default on this model).
      output_config: { effort: "medium" },
      // If a safety classifier declines, re-run on Anthropic's recommended model instead of failing.
      ...FALLBACK,
      betas: [...FALLBACK.betas],
      system: SYSTEM,
      messages: [{ role: "user", content: `<data>\n${data}\n</data>\n\nВопрос: ${question}` }],
    });

    if (response.stop_reason === "refusal") {
      return "🤖 На этот вопрос ответить не получилось. Попробуй сформулировать иначе.";
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    logger.info(`[AI] Answered (${response.usage.input_tokens} in / ${response.usage.output_tokens} out)`);
    return text || "🤖 Пустой ответ — попробуй ещё раз.";
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return "🤖 Ключ ANTHROPIC_API_KEY не принят — проверь его в .env.";
    }
    if (err instanceof Anthropic.RateLimitError) {
      return "🤖 Слишком много запросов — попробуй через минуту.";
    }
    logger.error("[AI] Request failed", err);
    return "🤖 Не удалось получить ответ — попробуй позже.";
  }
}
