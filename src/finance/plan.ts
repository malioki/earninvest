import type { FinanceData } from "./index.js";
import { dueAmount } from "./index.js";
import { creditPaid, overdueNow, recordedIncome, remainingNative, toUsd } from "./actions.js";
import { daysBetween, daysInMonth, monthLabel } from "../spending/index.js";
import { billPaid, billPeriod } from "./bills.js";
import { moneyText } from "./schedule.js";

// The month at a glance: what comes in, what must go out (credits, overdue,
// living), and what that leaves for personal debts — allocated in payback
// order, the way the October plan was worked out by hand.

export interface PlanLine {
  name: string;
  usd: number;
  native: string;
  done: boolean;
}

export interface DebtAllocation {
  name: string;
  payUsd: number;
  remainingUsd: number;
  closes: boolean;
  native: string;
}

export interface MonthPlan {
  month: string;
  incomes: PlanLine[];
  incomeUsd: number;
  credits: PlanLine[];
  creditsUsd: number;
  overdue: PlanLine[];
  overdueUsd: number;
  /** Household bills not already inside the living cost (tuition, one-offs…). */
  bills: PlanLine[];
  billsUsd: number;
  livingUsd: number;
  /** Personal debts already paid back this month (from the ledger). */
  paidBackUsd: number;
  /** Overdue balances paid off this month. */
  overduePaidUsd: number;
  freeUsd: number;
  /** Anchored on the cash in hand; when present it, not freeUsd, is shared out. */
  rest: RestOfMonth | null;
  allocations: DebtAllocation[];
  leftoverUsd: number;
}

export function buildMonthPlan(fin: FinanceData, today: string): MonthPlan {
  const month = today.slice(0, 7);

  const incomes: PlanLine[] = (fin.incomeSchedule ?? []).map((i) => {
    const got = recordedIncome(fin, i.id, month);
    const amount = got?.amount ?? i.amount;
    const currency = got?.currency ?? i.currency;
    return { name: i.name, usd: toUsd(fin, amount, currency), native: moneyText(amount, currency), done: !!got };
  });
  // One-off inflows recorded this month (a sale, a gift) count too.
  for (const e of fin.ledger ?? []) {
    if (e.kind === "income" && e.ref === "other" && e.period === month && e.amount && e.currency) {
      incomes.push({ name: e.label, usd: toUsd(fin, e.amount, e.currency), native: moneyText(e.amount, e.currency), done: true });
    }
  }

  const credits: PlanLine[] = fin.credits
    .filter((c) => dueAmount(c, month) > 0 || creditPaid(fin, c.id, month))
    .map((c) => {
      const paid = creditPaid(fin, c.id, month);
      const amount = paid?.amount ?? dueAmount(c, month);
      return { name: c.name, usd: toUsd(fin, amount, c.currency), native: moneyText(amount, c.currency), done: !!paid };
    });

  // An overdue balance keeps growing because the *current* instalment accrues
  // into it — that part is already in this month's payment. Only the missed
  // payment itself (the figure at the date it was missed) is extra.
  const overdue: PlanLine[] = fin.credits
    .filter((c) => c.overdue)
    .map((c) => {
      const o = c.overdue!;
      const missed = o.since && o.growthPerDay
        ? Math.max(0, o.amount - o.growthPerDay * Math.max(0, daysBetween(o.since, o.asOf)))
        : o.amount;
      return { name: c.name, usd: toUsd(fin, missed, c.currency), native: moneyText(missed, c.currency), done: false };
    });

  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const bills: PlanLine[] = (fin.bills ?? [])
    .filter((b) => !b.inLifeCost)
    .filter((b) => {
      const paid = billPaid(fin, b, billPeriod(b, today));
      if (b.every === "month") return true;
      if (b.every === "year") return String(b.month ?? 0).padStart(2, "0") === month.slice(5, 7);
      return paid ? paid.date.startsWith(month) : !b.dueDate || b.dueDate <= monthEnd;
    })
    .map((b) => {
      const paid = billPaid(fin, b, billPeriod(b, today));
      const amount = paid?.amount ?? b.amount;
      return { name: b.name, usd: toUsd(fin, amount, b.currency), native: moneyText(amount, b.currency), done: !!paid };
    });

  const paidThisMonth = (kinds: string[]) =>
    (fin.ledger ?? [])
      .filter((e) => kinds.includes(e.kind) && e.date.startsWith(month) && e.amount && e.currency)
      .reduce((s, e) => s + toUsd(fin, e.amount!, e.currency!), 0);
  const paidBackUsd = paidThisMonth(["debt-paid", "debt-partial"]);
  // Overdue already paid off this month came out of this month's income too.
  const overduePaidUsd = paidThisMonth(["overdue-paid"]);

  const sum = (xs: PlanLine[]) => xs.reduce((s, x) => s + x.usd, 0);
  const incomeUsd = sum(incomes);
  const creditsUsd = sum(credits);
  const overdueUsd = sum(overdue);
  const billsUsd = sum(bills);
  const livingUsd = fin.monthlyLifeCostUsd;
  const freeUsd = incomeUsd - creditsUsd - overdueUsd - overduePaidUsd - billsUsd - livingUsd - paidBackUsd;

  const rest = restOfMonth(fin, today);
  let left = Math.max(0, rest ? rest.freeUsd : freeUsd);
  const allocations: DebtAllocation[] = [];
  const debts = [...fin.personalDebts]
    .filter((d) => d.amountUsd > 0)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  for (const d of debts) {
    if (left <= 0) break;
    const pay = Math.min(left, d.amountUsd);
    left -= pay;
    allocations.push({
      name: d.name,
      payUsd: pay,
      remainingUsd: d.amountUsd,
      closes: pay >= d.amountUsd - 0.5,
      native: moneyText(remainingNative(d), d.currency),
    });
  }

  return { month, incomes, incomeUsd, credits, creditsUsd, overdue, overdueUsd, bills, billsUsd, livingUsd, paidBackUsd, overduePaidUsd, freeUsd, rest, allocations, leftoverUsd: left };
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("ru-RU")}`;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatMonthPlan(p: MonthPlan, fin: FinanceData): string {
  const mark = (done: boolean) => (done ? "✅" : "▫️");
  const lines = [`🗓 <b>План: ${monthLabel(p.month)}</b>`, ""];

  lines.push(`📥 <b>Приход ~${usd(p.incomeUsd)}</b>`);
  for (const i of p.incomes) lines.push(`   ${mark(i.done)} ${esc(i.name)} — ${i.native}`);

  lines.push("", `📤 <b>Кредиты ~${usd(p.creditsUsd)}</b> (оплачено ${p.credits.filter((c) => c.done).length} из ${p.credits.length})`);
  if (p.overdueUsd > 0) {
    for (const o of p.overdue) lines.push(`🔴 Просрочка ${esc(o.name)} — ещё ~${o.native} сверх платежа`);
  }
  if (p.bills.length > 0) {
    lines.push(`🧾 Платежи ~${usd(p.billsUsd)} (оплачено ${p.bills.filter((b) => b.done).length} из ${p.bills.length}): ${p.bills.map((b) => `${mark(b.done)} ${esc(b.name)} ${b.native}`).join(", ")}`);
  }
  if (p.overduePaidUsd > 0) lines.push(`✅ Просрочки уже погашено в этом месяце ~${usd(p.overduePaidUsd)}`);
  lines.push(`🏠 Быт ~${usd(p.livingUsd)}`);
  if (p.paidBackUsd > 0) lines.push(`👥 Уже отдано долгов в этом месяце ~${usd(p.paidBackUsd)}`);

  const free = p.rest ? p.rest.freeUsd : p.freeUsd;
  lines.push("", "━━━━━━━━━━");
  if (p.rest) {
    const r = p.rest;
    const moved = Math.abs(r.movedUsd) >= 1 ? ` ${r.movedUsd > 0 ? "+" : "−"} отмечено после ${usd(Math.abs(r.movedUsd))}` : "";
    lines.push(
      `💰 <b>Остаётся на долги по факту: ~${usd(free)}</b>`,
      `<i>на руках ${usd(r.cashUsd)} (${r.asOf.slice(8, 10)}.${r.asOf.slice(5, 7)})${moved} + придёт ${usd(r.incomingUsd)} − кредиты ${usd(r.creditsUsd)} − просрочки ${usd(r.overdueUsd)} − платежи ${usd(r.billsUsd)} − жизнь ${r.daysLeft} дн. ${usd(r.livingUsd)}</i>`,
      `<i>По расписанию вышло бы ~${usd(p.freeUsd)} — разница ушла на то, что не записано в боте.</i>`,
    );
  } else {
    lines.push(`💰 <b>Остаётся на долги: ~${usd(free)}</b>`, "<i>Укажи, сколько на руках (💵 На руках), — посчитаю по факту.</i>");
  }
  if (free <= 0) {
    lines.push("", `⚠️ Не хватает ~${usd(-free)}: в этом месяце долги гасить не из чего.`);
    return lines.join("\n");
  }

  const closes = p.allocations.filter((a) => a.closes);
  const partial = p.allocations.find((a) => !a.closes);
  if (closes.length > 0) {
    lines.push("", `✅ <b>Закрываем:</b> ${closes.map((a) => `${esc(a.name)} (${a.native})`).join(", ")}`);
  }
  if (partial) {
    lines.push(`🔸 <b>Частично:</b> ${esc(partial.name)} — ${usd(partial.payUsd)} из ${usd(partial.remainingUsd)}`);
  }
  const allocated = new Set(p.allocations.map((a) => a.name));
  const later = fin.personalDebts
    .filter((d) => d.amountUsd > 0 && !allocated.has(d.name))
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  if (later.length > 0) lines.push(`⏭ Дальше: ${later.map((d) => esc(d.name)).join(", ")}`);
  if (p.leftoverUsd > 1) lines.push(`🎉 Все долги закрываются, ещё остаётся ~${usd(p.leftoverUsd)}`);

  lines.push("", "<i>Прикидка по курсам на сегодня. Приход отмечай кнопкой «📥 Пришло», тогда план считается по факту.</i>");
  return lines.join("\n");
}

// ── What's really left this month ─────────────────────────────────────────
// The month plan above works from the schedule, so it can't see money that
// went out unrecorded (cash, cards, the odd purchase) — mid-October it showed
// ~$1 800 free when the family had ~$500. Anchored on the cash in hand, the
// rest of the month is simple arithmetic.

export interface RestOfMonth {
  asOf: string;
  cashUsd: number;
  /** Ledger since cashAsOf: money in (+) and payments out (−). */
  movedUsd: number;
  incomingUsd: number;
  creditsUsd: number;
  overdueUsd: number;
  billsUsd: number;
  livingUsd: number;
  daysLeft: number;
  freeUsd: number;
}

const OUTFLOWS = new Set(["credit-payment", "overdue-paid", "bill-paid", "debt-paid", "debt-partial"]);

/** null when the cash figure is missing or from another month — then there's no anchor. */
export function restOfMonth(fin: FinanceData, today: string): RestOfMonth | null {
  const month = today.slice(0, 7);
  const asOf = fin.cashAsOf;
  if (fin.cashOnHandUsd === undefined || !asOf || asOf.slice(0, 7) !== month) return null;

  // The cash figure already reflects everything up to its own day.
  let movedUsd = 0;
  for (const e of fin.ledger ?? []) {
    if (e.date <= asOf || !e.amount || !e.currency) continue;
    if (e.kind === "income") movedUsd += toUsd(fin, e.amount, e.currency);
    else if (OUTFLOWS.has(e.kind)) movedUsd -= toUsd(fin, e.amount, e.currency);
  }

  const incomingUsd = (fin.incomeSchedule ?? [])
    .filter((i) => !recordedIncome(fin, i.id, month))
    .reduce((s, i) => s + toUsd(fin, i.amount, i.currency), 0);
  const creditsUsd = fin.credits
    .filter((c) => !creditPaid(fin, c.id, month))
    .reduce((s, c) => s + toUsd(fin, dueAmount(c, month), c.currency), 0);
  const overdueUsd = fin.credits
    .filter((c) => c.overdue)
    .reduce((s, c) => s + toUsd(fin, overdueNow(c.overdue!, today), c.currency), 0);

  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const billsUsd = (fin.bills ?? [])
    .filter((b) => !billPaid(fin, b, billPeriod(b, today)))
    .filter((b) => {
      if (b.every === "month") return true;
      if (b.every === "year") return String(b.month ?? 0).padStart(2, "0") === month.slice(5, 7);
      return !b.dueDate || b.dueDate <= monthEnd;
    })
    .reduce((s, b) => s + toUsd(fin, b.amount, b.currency), 0);

  // Food, household, kids — at the variable budget, for the days the cash
  // figure hasn't lived through yet. Fixed bills are counted above.
  const daysLeft = Math.max(0, daysBetween(asOf, monthEnd));
  const livingUsd = ((fin.monthlyVariableBudgetUsd ?? fin.monthlyLifeCostUsd) * daysLeft) / daysInMonth(month);

  const freeUsd = fin.cashOnHandUsd + movedUsd + incomingUsd - creditsUsd - overdueUsd - billsUsd - livingUsd;
  return { asOf, cashUsd: fin.cashOnHandUsd, movedUsd, incomingUsd, creditsUsd, overdueUsd, billsUsd, livingUsd, daysLeft, freeUsd };
}
