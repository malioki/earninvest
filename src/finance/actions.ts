import { loadFinance, saveFinance } from "./index.js";
import type { CreditEntry, CreditOverdue, FinanceData, LedgerEntry, PersonalDebt } from "./index.js";
import { daysBetween, todayLocal } from "../spending/index.js";

// Everything the bot can change in finance.json. Each action loads the file,
// applies one change, appends a ledger entry (with what it replaced, for
// undo) and saves — so the web page and the bot never hold stale copies.

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ── Currency ──────────────────────────────────────────────────────────────

/** Native units per 1 USD for the currencies the family uses. */
export function perUsd(fin: FinanceData, currency: string): number {
  switch (currency) {
    case "USD":
    case "USDT":
      return 1;
    case "MDL":
      return fin.mdlPerUsd || 17.8;
    case "RUP":
      return fin.rubPerUsd || 16.3;
    case "EUR":
      return 1 / (fin.usdPerEur || 1.13);
    default:
      return 1;
  }
}

export const toUsd = (fin: FinanceData, amount: number, currency: string): number =>
  amount / perUsd(fin, currency);

// ── Debts ─────────────────────────────────────────────────────────────────
// Remaining amount: dollar debts keep it in amountUsd (originalAmount stays
// what was borrowed); lei/rouble debts keep it in originalAmount and derive
// amountUsd from the current rate.

const isDollar = (d: PersonalDebt): boolean => d.currency === "USD" || d.currency === "USDT";

export function remainingNative(d: PersonalDebt): number {
  return isDollar(d) ? d.amountUsd : d.originalAmount;
}

function setRemaining(fin: FinanceData, d: PersonalDebt, native: number): void {
  if (isDollar(d)) d.amountUsd = native;
  else {
    d.originalAmount = native;
    d.amountUsd = Math.round(toUsd(fin, native, d.currency) * 100) / 100;
  }
}

/** Gives every debt a stable id (buttons need one). Returns true if any were added. */
export function ensureDebtIds(fin: FinanceData): boolean {
  let changed = false;
  for (const d of fin.personalDebts) {
    if (!d.id) {
      d.id = newId();
      changed = true;
    }
  }
  return changed;
}

/** Debts in payback order, ids guaranteed. */
export function debtsInOrder(): { fin: FinanceData; debts: PersonalDebt[] } {
  const fin = loadFinance();
  if (ensureDebtIds(fin)) saveFinance(fin);
  const debts = fin.personalDebts
    .filter((d) => d.amountUsd > 0)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  return { fin, debts };
}

function mutate<T>(fn: (fin: FinanceData) => T): T {
  const fin = loadFinance();
  ensureDebtIds(fin);
  const result = fn(fin);
  saveFinance(fin);
  return result;
}

function log(fin: FinanceData, e: Omit<LedgerEntry, "id" | "date">): LedgerEntry {
  const entry: LedgerEntry = { id: newId(), date: todayLocal(), ...e };
  (fin.ledger ??= []).push(entry);
  return entry;
}

function findDebt(fin: FinanceData, id: string): PersonalDebt {
  const d = fin.personalDebts.find((x) => x.id === id);
  if (!d) throw new Error("Долг не найден — возможно, уже закрыт");
  return d;
}

/** Paid back `amount` (native currency) or, with null, everything. */
export function payDebt(id: string, amount: number | null, by?: string): { entry: LedgerEntry; closed: boolean; left: number } {
  return mutate((fin) => {
    const d = findDebt(fin, id);
    const before = { ...d };
    const remaining = remainingNative(d);
    const paid = amount === null ? remaining : amount;
    if (!(paid > 0)) throw new Error("Сумма должна быть больше нуля");
    if (paid > remaining + 0.5) {
      throw new Error(`Это больше остатка (${Math.round(remaining)} ${d.currency})`);
    }
    const left = Math.max(0, remaining - paid);
    // Within half a unit counts as closed — rounding, not a debt.
    const closed = left < 0.5;
    if (closed) fin.personalDebts = fin.personalDebts.filter((x) => x.id !== id);
    else setRemaining(fin, d, left);
    const entry = log(fin, {
      kind: closed ? "debt-paid" : "debt-partial",
      ref: id,
      label: d.name,
      amount: paid,
      currency: d.currency,
      by,
      prev: before,
    });
    return { entry, closed, left };
  });
}

export function addDebt(name: string, amount: number, currency: string, by?: string): PersonalDebt {
  return mutate((fin) => {
    const priority = Math.max(0, ...fin.personalDebts.map((d) => d.priority ?? 0)) + 1;
    const d: PersonalDebt = {
      id: newId(),
      name,
      currency,
      originalAmount: amount,
      amountUsd: Math.round(toUsd(fin, amount, currency) * 100) / 100,
      priority,
      note: `Добавлен из бота ${todayLocal()}${by ? ` (${by})` : ""}.`,
    };
    fin.personalDebts.push(d);
    log(fin, { kind: "debt-added", ref: d.id!, label: name, amount, currency, by });
    return d;
  });
}

/** Swap with the neighbour above (-1) or below (+1) in the payback queue. */
export function moveDebt(id: string, dir: -1 | 1): void {
  mutate((fin) => {
    const order = fin.personalDebts
      .filter((d) => d.amountUsd > 0)
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
    // Renumber densely first so swaps never collide on equal priorities.
    order.forEach((d, i) => (d.priority = i + 1));
    const i = order.findIndex((d) => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const a = order[i]!;
    const b = order[j]!;
    [a.priority, b.priority] = [b.priority, a.priority];
  });
}

// ── Incomes & credit payments ─────────────────────────────────────────────

export const currentPeriod = (): string => todayLocal().slice(0, 7);

export function recordedIncome(fin: FinanceData, incomeId: string, period: string): LedgerEntry | undefined {
  return fin.ledger?.find((e) => e.kind === "income" && e.ref === incomeId && e.period === period);
}

export function creditPaid(fin: FinanceData, creditId: string, period: string): LedgerEntry | undefined {
  return fin.ledger?.find((e) => e.kind === "credit-payment" && e.ref === creditId && e.period === period);
}

/** `incomeId` from incomeSchedule, or "other" with a free label (a sold PS5…). */
export function recordIncome(
  incomeId: string,
  amount: number,
  currency: string,
  by?: string,
  label?: string,
): LedgerEntry {
  return mutate((fin) => {
    const sched = fin.incomeSchedule?.find((i) => i.id === incomeId);
    if (!sched && incomeId !== "other") throw new Error("Поступление не найдено");
    const period = currentPeriod();
    if (sched && recordedIncome(fin, incomeId, period)) {
      throw new Error(`«${sched.name}» за этот месяц уже отмечено`);
    }
    return log(fin, { kind: "income", ref: incomeId, label: sched?.name ?? label ?? "Поступление", amount, currency, period, by });
  });
}

/**
 * How much of a payment goes to principal. A regular instalment first pays the
 * month's interest on the balance; the rest is principal. A larger sum (missed
 * instalments plus penalty) is split in the same proportion — an estimate, which
 * is why the lender's own figure can be set with setCreditBalance.
 */
export function creditPrincipal(c: CreditEntry, amount: number): number {
  if (c.aprPct <= 0 || c.monthlyPayment <= 0) return Math.min(amount, c.balance);
  const interest = (c.balance * c.aprPct) / 100 / 12;
  const share = Math.max(0, Math.min(1, (c.monthlyPayment - interest) / c.monthlyPayment));
  return Math.min(c.balance, Math.round(amount * share * 100) / 100);
}

function lowerBalance(c: CreditEntry, amount: number): number {
  const before = c.balance;
  c.balance = Math.round((c.balance - creditPrincipal(c, amount)) * 100) / 100;
  return before;
}

export function recordCreditPayment(creditId: string, amount: number, by?: string): LedgerEntry {
  return mutate((fin) => {
    const c = fin.credits.find((x) => x.id === creditId);
    if (!c) throw new Error("Кредит не найден");
    const period = currentPeriod();
    if (creditPaid(fin, creditId, period)) throw new Error(`Платёж «${c.name}» за этот месяц уже отмечен`);
    const prevBalance = lowerBalance(c, amount);
    return log(fin, { kind: "credit-payment", ref: creditId, label: c.name, amount, currency: c.currency, period, by, prevBalance });
  });
}

/** Cash and cards in hand right now — the anchor for "what's left this month". */
export function setCashOnHand(usd: number): void {
  mutate((fin) => {
    fin.cashOnHandUsd = Math.round(usd * 100) / 100;
    fin.cashAsOf = todayLocal();
    // Keep the dashboard's cash line in step.
    const cash = fin.liquidAssets.find((a) => /кэш|cash|карта/i.test(a.name));
    if (cash) {
      cash.amountUsd = fin.cashOnHandUsd;
      cash.note = fin.cashAsOf.split("-").reverse().join(".");
    }
  });
}

/** The lender's own figure (app, statement): replaces the running estimate. */
export function setCreditBalance(creditId: string, balance: number, by?: string): LedgerEntry {
  return mutate((fin) => {
    const c = fin.credits.find((x) => x.id === creditId);
    if (!c) throw new Error("Кредит не найден");
    if (!(balance >= 0)) throw new Error("Остаток не может быть отрицательным");
    const prev = { balanceAsOf: c.balanceAsOf };
    const prevBalance = c.balance;
    c.balance = balance;
    c.balanceAsOf = todayLocal();
    return log(fin, { kind: "credit-balance", ref: creditId, label: `${c.name}: остаток уточнён`, amount: balance, currency: c.currency, by, prev, prevBalance });
  });
}

/** Today's estimate of an overdue balance that grows daily. */
export function overdueNow(o: CreditOverdue, today = todayLocal()): number {
  const days = Math.max(0, daysBetween(o.asOf, today));
  return o.amount + (o.growthPerDay ?? 0) * days;
}

/** Paid `amount` towards the overdue balance, or everything with null. */
export function payOverdue(creditId: string, amount: number | null, by?: string): { entry: LedgerEntry; closed: boolean; left: number } {
  return mutate((fin) => {
    const c = fin.credits.find((x) => x.id === creditId);
    if (!c?.overdue) throw new Error("Просрочки нет");
    const prev = { ...c.overdue };
    const now = overdueNow(c.overdue);
    const paid = amount === null ? now : amount;
    if (!(paid > 0)) throw new Error("Сумма должна быть больше нуля");
    const left = Math.max(0, now - paid);
    const closed = amount === null || left < 1;
    if (closed) delete c.overdue;
    else c.overdue = { ...c.overdue, amount: Math.round(left * 100) / 100, asOf: todayLocal() };
    // Missed instalments carry principal too — paying them lowers the balance.
    const prevBalance = lowerBalance(c, paid);
    const entry = log(fin, { kind: "overdue-paid", ref: creditId, label: `${c.name}: просрочка`, amount: paid, currency: c.currency, by, prev, prevBalance });
    return { entry, closed, left: closed ? 0 : left };
  });
}

// ── Undo ──────────────────────────────────────────────────────────────────

/** Reverts one ledger entry: restores the debt / overdue it changed, or just forgets the mark. */
export function undoEntry(entryId: string): LedgerEntry {
  return mutate((fin) => {
    const idx = fin.ledger?.findIndex((e) => e.id === entryId) ?? -1;
    if (idx < 0) throw new Error("Запись уже отменена");
    const e = fin.ledger![idx]!;
    switch (e.kind) {
      case "debt-paid":
      case "debt-partial": {
        const prev = e.prev as PersonalDebt;
        fin.personalDebts = fin.personalDebts.filter((d) => d.id !== prev.id);
        fin.personalDebts.push(prev);
        break;
      }
      case "debt-added":
        fin.personalDebts = fin.personalDebts.filter((d) => d.id !== e.ref);
        break;
      case "overdue-paid": {
        const c = fin.credits.find((x) => x.id === e.ref);
        if (c) c.overdue = e.prev as CreditOverdue;
        break;
      }
      case "credit-balance": {
        const c = fin.credits.find((x) => x.id === e.ref);
        if (c) c.balanceAsOf = (e.prev as { balanceAsOf?: string } | undefined)?.balanceAsOf;
        break;
      }
      case "income":
      case "credit-payment":
        break;
    }
    // Payments and corrections moved the balance — put it back.
    if (e.prevBalance !== undefined) {
      const c = fin.credits.find((x) => x.id === e.ref);
      if (c) c.balance = e.prevBalance;
    }
    fin.ledger!.splice(idx, 1);
    return e;
  });
}

export function recentLedger(limit = 10): LedgerEntry[] {
  return [...(loadFinance().ledger ?? [])].reverse().slice(0, limit);
}
