import { loadFinance, saveFinance } from "./index.js";
import type { Bill, FinanceData, LedgerEntry } from "./index.js";
import { addDays, daysInMonth, todayLocal } from "../spending/index.js";

// Household payments — trainings, utilities, rent, tuition. Each has a period
// ("2026-10" monthly, "2026" yearly, "once"); paying one records a ledger
// entry for that period, which is what the calendar, reminders and the month
// plan check.

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function onDay(month: string, day: number): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

/** The period a payment on `date` settles. */
export function billPeriod(b: Bill, date: string): string {
  if (b.every === "month") return date.slice(0, 7);
  if (b.every === "year") return date.slice(0, 4);
  return "once";
}

export function billPaid(fin: FinanceData, b: Bill, period: string): LedgerEntry | undefined {
  return fin.ledger?.find((e) => e.kind === "bill-paid" && e.ref === b.id && e.period === period);
}

/**
 * The next date this bill is due that hasn't been paid, or undefined when the
 * day isn't known. A bill already paid for the current period jumps to the next.
 */
export function nextDue(fin: FinanceData, b: Bill, today = todayLocal()): string | undefined {
  if (b.every === "once") return billPaid(fin, b, "once") ? undefined : b.dueDate;
  if (!b.day) return undefined;
  if (b.every === "month") {
    let month = today.slice(0, 7);
    for (let i = 0; i < 3; i++) {
      if (!billPaid(fin, b, month)) return onDay(month, b.day);
      month = addDays(`${month}-28`, 7).slice(0, 7);
    }
    return undefined;
  }
  if (!b.month) return undefined;
  let year = Number(today.slice(0, 4));
  for (let i = 0; i < 2; i++, year++) {
    if (!billPaid(fin, b, String(year))) return onDay(`${year}-${String(b.month).padStart(2, "0")}`, b.day);
  }
  return undefined;
}

/** Is it still to be paid in the current period? (One-offs: until paid.) */
export function billOpen(fin: FinanceData, b: Bill, today = todayLocal()): boolean {
  if (b.every === "year" && b.month && String(b.month).padStart(2, "0") !== today.slice(5, 7)) return false;
  return !billPaid(fin, b, billPeriod(b, today));
}

/** Unpaid bills due exactly on `day` — for the evening-before reminder. */
export function billsDueOn(fin: FinanceData, day: string): Bill[] {
  return (fin.bills ?? []).filter((b) => nextDue(fin, b, day) === day);
}

// ── Mutations ─────────────────────────────────────────────────────────────

function mutate<T>(fn: (fin: FinanceData) => T): T {
  const fin = loadFinance();
  const r = fn(fin);
  saveFinance(fin);
  return r;
}

export function findBill(fin: FinanceData, id: string): Bill {
  const b = fin.bills?.find((x) => x.id === id);
  if (!b) throw new Error("Платёж не найден — возможно, удалён");
  return b;
}

export function payBill(id: string, amount: number, by?: string, today = todayLocal()): LedgerEntry {
  return mutate((fin) => {
    const b = findBill(fin, id);
    const period = billPeriod(b, today);
    if (billPaid(fin, b, period)) throw new Error(`«${b.name}» за этот период уже отмечен`);
    const entry: LedgerEntry = {
      id: newId(), date: today, kind: "bill-paid", ref: b.id, label: b.name, amount, currency: b.currency, period, by,
    };
    (fin.ledger ??= []).push(entry);
    return entry;
  });
}

export function addBill(input: Omit<Bill, "id">): Bill {
  return mutate((fin) => {
    const b: Bill = { id: newId(), ...input };
    (fin.bills ??= []).push(b);
    return b;
  });
}

/** Replace what the user re-typed, keep id (and so the payment history). */
export function updateBill(id: string, input: Omit<Bill, "id">): Bill {
  return mutate((fin) => {
    const b = findBill(fin, id);
    const keepLifeCost = b.inLifeCost;
    Object.keys(b).forEach((k) => k !== "id" && delete (b as unknown as Record<string, unknown>)[k]);
    Object.assign(b, input, { inLifeCost: input.inLifeCost ?? keepLifeCost });
    return b;
  });
}

export function deleteBill(id: string): Bill {
  return mutate((fin) => {
    const b = findBill(fin, id);
    fin.bills = (fin.bills ?? []).filter((x) => x.id !== id);
    return b;
  });
}

// ── "Карате 600 руб 5" ────────────────────────────────────────────────────

/**
 * One line → a bill:
 *   «Карате 600 руб 5»            monthly, 600 руб, on the 5th
 *   «Интернет 225 руб»            monthly, day unknown
 *   «Сад фонд 500 руб до 20.12»   one-off with a deadline
 *   «Фото 400 руб разово»         one-off, no deadline
 *   «Страховка 1200 лей ежегодно 15.03»  yearly
 * Currency: руб (default), лей, $, €.
 */
export function parseBillText(text: string, today = todayLocal()): Omit<Bill, "id"> | null {
  let t = ` ${text.trim()} `;
  let every: Bill["every"] = "month";
  let day: number | undefined;
  let month: number | undefined;
  let dueDate: string | undefined;

  const date = (d: string, m: string, y?: string): string => {
    let year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : Number(today.slice(0, 4));
    let iso = `${year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (!y && iso < today) iso = `${++year}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return iso;
  };

  const yearly = t.match(/(?<!\p{L})(ежегодно|раз в год|каждый год)(?!\p{L})\s*(\d{1,2})[./](\d{1,2})/iu);
  const until = t.match(/(?<!\p{L})до\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/iu);
  if (yearly) {
    every = "year"; day = Number(yearly[2]); month = Number(yearly[3]);
    t = t.replace(yearly[0], " ");
  } else if (until) {
    every = "once"; dueDate = date(until[1]!, until[2]!, until[3]);
    t = t.replace(until[0], " ");
  } else if (/(?<!\p{L})(разово|раз|однократно|один раз)(?!\p{L})/iu.test(t)) {
    every = "once";
    t = t.replace(/(?<!\p{L})(разово|раз|однократно|один раз)(?!\p{L})/iu, " ");
  }
  t = t.replace(/(?<!\p{L})(ежемесячно|каждый месяц|в месяц|числа|число|кажд\p{L}*)(?!\p{L})/giu, " ");

  let currency = "RUP";
  if (/(?<!\p{L})(лей|леи|mdl)(?!\p{L})/iu.test(t)) currency = "MDL";
  else if (/\$|(?<!\p{L})(usd|долл\p{L}*)(?!\p{L})/iu.test(t)) currency = "USD";
  else if (/€|(?<!\p{L})(eur|евро)(?!\p{L})/iu.test(t)) currency = "EUR";
  // The amount is the number right before a currency word; otherwise the largest number.
  const withCur = t.match(/(\d+(?:[.,]\d+)?)\s*(?=руб|р(?!\p{L})|лей|леи|mdl|\$|usd|долл|€|eur|евро)/iu);
  const nums = [...t.matchAll(/(?<![\p{L}\d.,])(\d+(?:[.,]\d+)?)(?![\d])/gu)].map((m) => ({ raw: m[0], v: parseFloat(m[1]!.replace(",", ".")) }));
  if (nums.length === 0) return null;
  const amountRaw = withCur ? withCur[1]! : nums.reduce((a, b) => (b.v > a.v ? b : a)).raw;
  const amount = parseFloat(amountRaw.replace(",", "."));
  if (!(amount > 0)) return null;
  if (every === "month") {
    const dayNum = nums.find((n) => n.raw !== amountRaw && Number.isInteger(n.v) && n.v >= 1 && n.v <= 31);
    if (dayNum) day = dayNum.v;
  }
  const name = t
    .replace(/\d+(?:[.,]\d+)?/g, " ")
    .replace(/\$|€|(?<!\p{L})(руб\p{L}*|р|лей|леи|mdl|usd|долл\p{L}*|eur|евро)(?!\p{L})/giu, " ")
    .replace(/[\s.,;:!-]+/g, " ")
    .trim();
  if (!name) return null;
  return {
    name: name[0]!.toUpperCase() + name.slice(1), amount, currency, every,
    ...(day ? { day } : {}), ...(month ? { month } : {}), ...(dueDate ? { dueDate } : {}),
  };
}
