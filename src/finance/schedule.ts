import type { FinanceData } from "./index.js";
import { dueAmount } from "./index.js";
import { addDays, daysBetween, daysInMonth } from "../spending/index.js";
import { creditPaid, overdueNow, recordedIncome } from "./actions.js";
import { billPaid, billPeriod, billsDueOn, nextDue } from "./bills.js";

// Upcoming inflows (income schedule) and outflows (credit payments) on the
// family's calendar. Everything recurs monthly by day-of-month; what was
// already marked in the bot (ledger) shows as done.

export interface ScheduleEvent {
  kind: "in" | "out" | "overdue" | "bill";
  /** Income id, credit id or bill id — what the bot's buttons act on. */
  ref: string;
  /** First possible day (YYYY-MM-DD); "" when the date is unknown. */
  from: string;
  /** Last possible day — equals `from` for a fixed date. */
  to: string;
  name: string;
  amount: number;
  currency: string;
  plan?: string;
  /** Already marked in the bot for this month. */
  done?: { amount: number; currency: string };
}

/** Day `day` of `month`, pulled back to the last day in short months (31 → 30 Sep). */
function onDay(month: string, day: number): string {
  const d = Math.min(day, daysInMonth(month));
  return `${month}-${String(d).padStart(2, "0")}`;
}

const nextMonth = (month: string): string => addDays(`${month}-28`, 7).slice(0, 7);

/**
 * The occurrence of a monthly [dayFrom, dayTo] window that hasn't fully passed
 * yet. A window still open today counts as current, not next month's.
 */
function nextWindow(today: string, dayFrom: number, dayTo: number): { from: string; to: string } {
  const month = today.slice(0, 7);
  const to = onDay(month, dayTo);
  if (to >= today) return { from: onDay(month, dayFrom), to };
  const nm = nextMonth(month);
  return { from: onDay(nm, dayFrom), to: onDay(nm, dayTo) };
}

export function upcomingEvents(fin: FinanceData, today: string, horizonDays = 21): ScheduleEvent[] {
  const until = addDays(today, horizonDays);
  const events: ScheduleEvent[] = [];

  for (const i of fin.incomeSchedule ?? []) {
    const w = nextWindow(today, i.dayFrom, i.dayTo);
    if (w.from > until) continue;
    const got = recordedIncome(fin, i.id, w.from.slice(0, 7));
    events.push({
      kind: "in", ref: i.id, ...w, name: i.name, amount: i.amount, currency: i.currency, plan: i.plan,
      done: got ? { amount: got.amount ?? i.amount, currency: got.currency ?? i.currency } : undefined,
    });
  }

  for (const c of fin.credits) {
    if (c.overdue) {
      events.push({ kind: "overdue", ref: c.id, from: today, to: today, name: c.name, amount: overdueNow(c.overdue, today), currency: c.currency });
    }
    if (c.paymentDay === undefined) {
      // Unknown date: still listed, so a payment can't silently fall off the radar.
      const amount = dueAmount(c, today.slice(0, 7));
      if (amount > 0) events.push({ kind: "out", ref: c.id, from: "", to: "", name: c.name, amount, currency: c.currency });
      continue;
    }
    const w = nextWindow(today, c.paymentDay, c.paymentDay);
    if (w.from > until) continue;
    const amount = dueAmount(c, w.from.slice(0, 7));
    if (amount <= 0) continue;
    const paid = creditPaid(fin, c.id, w.from.slice(0, 7));
    events.push({
      kind: "out", ref: c.id, ...w, name: c.name, amount, currency: c.currency,
      done: paid ? { amount: paid.amount ?? amount, currency: c.currency } : undefined,
    });
  }

  // Household payments with a known date; undated ones live in 🧾 Платежи only.
  for (const b of fin.bills ?? []) {
    const due = nextDue(fin, b, today);
    const lastPaid = billPaid(fin, b, billPeriod(b, today));
    if (due && due <= until) {
      events.push({ kind: "bill", ref: b.id, from: due, to: due, name: b.name, amount: b.amount, currency: b.currency });
    } else if (lastPaid && lastPaid.date >= addDays(today, -7) && b.every !== "once") {
      // Paid recently for this period — show it as done so the month reads complete.
      const d = b.day ? billPeriod(b, today).slice(0, 7) + "-" + String(b.day).padStart(2, "0") : lastPaid.date;
      events.push({ kind: "bill", ref: b.id, from: d, to: d, name: b.name, amount: b.amount, currency: b.currency,
        done: { amount: lastPaid.amount ?? b.amount, currency: b.currency } });
    }
  }

  const rank = { overdue: 0, in: 1, out: 2, bill: 2 } as const;
  return events.sort(
    (a, b) =>
      (a.kind === "overdue" ? -1 : 0) - (b.kind === "overdue" ? -1 : 0) ||
      (a.from === "" ? 1 : 0) - (b.from === "" ? 1 : 0) ||
      a.from.localeCompare(b.from) ||
      rank[a.kind] - rank[b.kind],
  );
}

/** Unpaid credit payments and bills due exactly on `day` — for the evening-before reminder. */
export function paymentsDueOn(fin: FinanceData, day: string): ScheduleEvent[] {
  const month = day.slice(0, 7);
  const bills: ScheduleEvent[] = billsDueOn(fin, day).map((b) => ({
    kind: "bill" as const, ref: b.id, from: day, to: day, name: b.name, amount: b.amount, currency: b.currency,
  }));
  return [...fin.credits
    .filter(
      (c) =>
        c.paymentDay !== undefined &&
        dueAmount(c, month) > 0 &&
        onDay(month, c.paymentDay) === day &&
        !creditPaid(fin, c.id, month),
    )
    .map((c) => ({
      kind: "out" as const,
      ref: c.id,
      from: day,
      to: day,
      name: c.name,
      amount: dueAmount(c, month),
      currency: c.currency,
    })), ...bills];
}

// ── Text ──────────────────────────────────────────────────────────────────

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export const dm = (d: string): string => `${Number(d.slice(8, 10))} ${MONTH_SHORT[Number(d.slice(5, 7)) - 1]}`;

function when(e: ScheduleEvent): string {
  if (!e.from) return "дата ?";
  if (e.from === e.to) return dm(e.from);
  return e.from.slice(5, 7) === e.to.slice(5, 7)
    ? `${Number(e.from.slice(8, 10))}–${dm(e.to)}`
    : `${dm(e.from)} – ${dm(e.to)}`;
}

export function moneyText(amount: number, currency: string): string {
  const n = Math.round(amount).toLocaleString("ru-RU");
  switch (currency) {
    case "MDL": return `${n} лей`;
    case "RUP": return `${n} руб ПМР`;
    case "USD":
    case "USDT": return `$${n}`;
    case "EUR": return `${n} €`;
    default: return `${n} ${currency}`;
  }
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function relative(e: ScheduleEvent, today: string): string {
  if (!e.from || e.done) return "";
  if (e.from <= today && today <= e.to) return " · <b>сейчас</b>";
  const d = daysBetween(today, e.from);
  if (d === 1) return " · <b>завтра</b>";
  return d > 0 ? ` · через ${d} дн.` : "";
}

export function formatUpcoming(events: ScheduleEvent[], today: string, horizonDays = 21): string {
  const lines = [`📆 <b>Ближайшие ${horizonDays} дней</b>`, ""];
  for (const e of events) {
    if (e.kind === "overdue") {
      lines.push(`🔴 <b>${esc(e.name)}</b>: просрочка ~${moneyText(e.amount, e.currency)} на сегодня — гасить первым`);
      continue;
    }
    const icon = e.done ? "✅" : e.kind === "in" ? "📥" : e.kind === "bill" ? "🧾" : "📤";
    const amount = e.done
      ? `${moneyText(e.done.amount, e.done.currency)} ${e.kind === "in" ? "пришло" : "оплачено"}`
      : moneyText(e.amount, e.currency);
    lines.push(`${icon} <b>${when(e)}</b> — ${esc(e.name)}: ${amount}${relative(e, today)}`);
    if (e.plan && !e.done) lines.push(`      → ${esc(e.plan)}`);
  }
  if (events.some((e) => !e.from && e.kind === "out")) {
    lines.push("", "<i>«дата ?» — день платежа не указан (поле paymentDay в finance.json).</i>");
  }
  const pending = events.filter((e) => !e.done && e.kind !== "overdue");
  if (pending.length > 0) lines.push("", "<i>Пришли деньги или оплатил — отметь кнопкой ниже.</i>");
  return lines.join("\n");
}

export function formatReminder(due: ScheduleEvent[]): string {
  return [
    due.length === 1 ? "⏰ <b>Завтра платёж</b>" : "⏰ <b>Завтра платежи</b>",
    ...due.map((e) => `📤 ${esc(e.name)} — ${moneyText(e.amount, e.currency)}`),
    "",
    "<i>Проверь, что на карте хватает денег. Оплатил — отметь в 💼 Финансы → 📆 Ближайшее или 🧾 Платежи.</i>",
  ].join("\n");
}
