import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

const FINANCE_FILE = path.join(config.dataDir, "finance.json");

export interface CreditEntry {
  id: string;
  name: string;
  currency: string;
  balance: number;
  monthlyPayment: number;
  aprPct: number;
  priority: number;
  note?: string;
}

export interface PersonalDebt {
  name: string;
  amountUsd: number;
  currency: string;
  originalAmount: number;
  /** Lower number = pay back sooner. */
  priority?: number;
  note?: string;
  /** Agreed deadline, free text in Russian (e.g. "3 августа 2026"). */
  due?: string;
}

export interface OwedToMe {
  name: string;
  amountUsd: number;
  note?: string;
}

export interface LiquidAsset {
  name: string;
  amountUsd: number;
  note?: string;
  earmarkedFor?: string;
  risk?: "low" | "medium" | "high";
  /** Role of this asset. "buffer" = counts toward emergency/earn buffer target. */
  role?: "buffer" | "speculative" | "reserve";
}

export interface Earmark {
  name: string;
  amountUsd: number;
  due?: string;
}

export interface Milestone {
  id: string;
  label: string;
  done: boolean;
}

export interface FinanceData {
  snapshotDate: string;
  mdlPerUsd: number;
  /** Transnistrian rouble per USD — receipts from ПМР shops are priced in it. */
  rubPerUsd?: number;
  monthlyIncomeUsd: number;
  monthlyLifeCostUsd: number;
  passiveIncomeGoalUsdPerMonth: number;
  credits: CreditEntry[];
  personalDebts: PersonalDebt[];
  owedToMe: OwedToMe[];
  liquidAssets: LiquidAsset[];
  earmarks: Earmark[];
  milestones: Milestone[];
}

export interface CreditWithMetrics extends CreditEntry {
  balanceUsd: number;
  monthlyPaymentUsd: number;
  monthlyInterestUsd: number;
  monthlyInterestNative: number;
  dailyInterestUsd: number;
  monthsToPayoffMin: number | null; // months at min payment, null if never
  principalPerMonth: number;
}

export interface FinanceMetrics {
  data: FinanceData;
  credits: CreditWithMetrics[];
  totalCreditBalanceUsd: number;
  totalCreditBalanceMdl: number;
  totalMonthlyPaymentUsd: number;
  totalMonthlyInterestUsd: number;
  totalDailyInterestUsd: number;
  totalPersonalDebtsUsd: number;
  totalOwedToMeUsd: number;
  totalLiquidAssetsUsd: number;
  /** Only assets that can actually be spent — excludes reserve/speculative (cars, etc.) */
  spendableAssetsUsd: number;
  totalEarmarkedUsd: number;
  /** Spendable cash left after earmarks. Never counts non-liquid reserves. */
  freeCashUsd: number;
  freeCashFlowUsd: number; // monthly income - life - credit payments
  passiveGoalCapitalUsd: number; // capital needed at conservative APY for goal
  monthsToGoalAtCurrentSavings: number | null;
}

const DEFAULT: FinanceData = {
  snapshotDate: new Date().toISOString().slice(0, 10),
  mdlPerUsd: 18,
  monthlyIncomeUsd: 0,
  monthlyLifeCostUsd: 0,
  passiveIncomeGoalUsdPerMonth: 300,
  credits: [],
  personalDebts: [],
  owedToMe: [],
  liquidAssets: [],
  earmarks: [],
  milestones: [],
};

export function loadFinance(): FinanceData {
  try {
    if (!fs.existsSync(FINANCE_FILE)) return { ...DEFAULT };
    const raw = fs.readFileSync(FINANCE_FILE, "utf-8");
    return JSON.parse(raw) as FinanceData;
  } catch (err) {
    logger.error("[Finance] Failed to load, using default", err);
    return { ...DEFAULT };
  }
}

export function saveFinance(data: FinanceData): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FINANCE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error("[Finance] Failed to save", err);
  }
}

function toUsd(amount: number, currency: string, mdlPerUsd: number): number {
  if (currency === "USD") return amount;
  if (currency === "EUR") return amount * 1.08;
  if (currency === "MDL") return amount / mdlPerUsd;
  return amount;
}

export function computeMetrics(
  data: FinanceData,
  passiveAssumedApyPct = 8,
): FinanceMetrics {
  const rate = data.mdlPerUsd;

  const credits: CreditWithMetrics[] = data.credits.map((c) => {
    const balanceUsd = toUsd(c.balance, c.currency, rate);
    const monthlyPaymentUsd = toUsd(c.monthlyPayment, c.currency, rate);
    const monthlyRate = c.aprPct / 100 / 12;
    const monthlyInterestNative = c.balance * monthlyRate;
    const monthlyInterestUsd = toUsd(monthlyInterestNative, c.currency, rate);
    const principalPerMonth = c.monthlyPayment - monthlyInterestNative;
    let monthsToPayoffMin: number | null = null;
    if (principalPerMonth > 0) {
      // n = -ln(1 - r*B/P) / ln(1+r)
      const arg = 1 - (monthlyRate * c.balance) / c.monthlyPayment;
      if (arg > 0)
        monthsToPayoffMin = -Math.log(arg) / Math.log(1 + monthlyRate);
    }
    return {
      ...c,
      balanceUsd,
      monthlyPaymentUsd,
      monthlyInterestUsd,
      monthlyInterestNative,
      dailyInterestUsd: monthlyInterestUsd / 30,
      monthsToPayoffMin,
      principalPerMonth,
    };
  });

  const totalCreditBalanceUsd = credits.reduce((s, c) => s + c.balanceUsd, 0);
  const totalCreditBalanceMdl = data.credits.reduce(
    (s, c) =>
      s +
      (c.currency === "MDL"
        ? c.balance
        : c.balance * (c.currency === "USD" ? rate : rate * 1.08)),
    0,
  );
  const totalMonthlyPaymentUsd = credits.reduce(
    (s, c) => s + c.monthlyPaymentUsd,
    0,
  );
  const totalMonthlyInterestUsd = credits.reduce(
    (s, c) => s + c.monthlyInterestUsd,
    0,
  );
  const totalDailyInterestUsd = totalMonthlyInterestUsd / 30;

  const totalPersonalDebtsUsd = data.personalDebts.reduce(
    (s, d) => s + d.amountUsd,
    0,
  );
  const totalOwedToMeUsd = data.owedToMe.reduce((s, d) => s + d.amountUsd, 0);
  const totalLiquidAssetsUsd = data.liquidAssets.reduce(
    (s, a) => s + a.amountUsd,
    0,
  );
  // A car parked in the driveway is net worth, not money you can hand to a
  // creditor. Only untagged/buffer assets count as spendable.
  const spendableAssetsUsd = data.liquidAssets
    .filter((a) => a.role !== "reserve" && a.role !== "speculative")
    .reduce((s, a) => s + a.amountUsd, 0);
  const totalEarmarkedUsd = data.earmarks.reduce((s, e) => s + e.amountUsd, 0);
  const freeCashUsd = Math.max(0, spendableAssetsUsd - totalEarmarkedUsd);

  const freeCashFlowUsd =
    data.monthlyIncomeUsd - data.monthlyLifeCostUsd - totalMonthlyPaymentUsd;

  const passiveGoalCapitalUsd =
    (data.passiveIncomeGoalUsdPerMonth * 12) / (passiveAssumedApyPct / 100);

  const monthsToGoalAtCurrentSavings =
    freeCashFlowUsd > 0 ? passiveGoalCapitalUsd / freeCashFlowUsd : null;

  return {
    data,
    credits,
    totalCreditBalanceUsd,
    totalCreditBalanceMdl,
    totalMonthlyPaymentUsd,
    totalMonthlyInterestUsd,
    totalDailyInterestUsd,
    totalPersonalDebtsUsd,
    totalOwedToMeUsd,
    totalLiquidAssetsUsd,
    spendableAssetsUsd,
    totalEarmarkedUsd,
    freeCashUsd,
    freeCashFlowUsd,
    passiveGoalCapitalUsd,
    monthsToGoalAtCurrentSavings,
  };
}

/** Pick the next debt to attack: highest APR among open credits. */
export function nextPriorityCredit(
  metrics: FinanceMetrics,
): CreditWithMetrics | null {
  const open = metrics.credits.filter((c) => c.balance > 0);
  if (open.length === 0) return null;
  return [...open].sort((a, b) => b.aprPct - a.aprPct)[0]!;
}

const RU_MONTHS: Record<string, number> = {
  январь: 0,
  января: 0,
  янв: 0,
  февраль: 1,
  февраля: 1,
  фев: 1,
  март: 2,
  марта: 2,
  мар: 2,
  апрель: 3,
  апреля: 3,
  апр: 3,
  май: 4,
  мая: 4,
  июнь: 5,
  июня: 5,
  июн: 5,
  июль: 6,
  июля: 6,
  июл: 6,
  август: 7,
  августа: 7,
  авг: 7,
  сентябрь: 8,
  сентября: 8,
  сен: 8,
  октябрь: 9,
  октября: 9,
  окт: 9,
  ноябрь: 10,
  ноября: 10,
  ноя: 10,
  декабрь: 11,
  декабря: 11,
  дек: 11,
};

function parseRussianDue(due: string): Date | null {
  const lower = due.toLowerCase().trim();
  const yearMatch = lower.match(/\d{4}/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[0], 10);
  for (const [name, month] of Object.entries(RU_MONTHS)) {
    if (lower.includes(name)) return new Date(year, month, 1);
  }
  return null;
}

export type AllocationKind =
  | "emergency_buffer"
  | "personal_debt"
  | "credit_payoff"
  | "earn_buffer"
  | "earn_invest";

/**
 * Order personal debts: agreed deadlines first (soonest/overdue at the top),
 * then explicit priority, then smallest first so more people get closed out.
 */
function comparePersonalDebts(a: PersonalDebt, b: PersonalDebt): number {
  const da = a.due ? (parseRussianDue(a.due)?.getTime() ?? Infinity) : Infinity;
  const db = b.due ? (parseRussianDue(b.due)?.getTime() ?? Infinity) : Infinity;
  if (da !== db) return da - db;
  const pa = a.priority ?? 999;
  const pb = b.priority ?? 999;
  if (pa !== pb) return pa - pb;
  return a.amountUsd - b.amountUsd;
}

export interface AllocationStep {
  kind: AllocationKind;
  target: string; // e.g. "EarnOptimizer" or "Credit365"
  amountUsd: number;
  reason: string;
  expectedReturnPct: number; // APR equivalent saved or earned
  annualSavingsUsd: number; // $ saved/earned per year for this allocation
}

export interface AllocationPlan {
  inputUsd: number;
  steps: AllocationStep[];
  totalAnnualSavingsUsd: number;
  effectiveReturnPct: number; // weighted return on the allocated cash
  notes: string[];
}

export interface AllocateOptions {
  earnApyPct?: number; // expected APY for stable Earn (default 8)
  emergencyBufferTargetUsd?: number; // override; default = 1 month life cost
  currentEarnBufferUsd?: number; // override; default = sum of low-risk earn liquid assets
  earnBufferTargetUsd?: number; // ideal earn buffer; default = 3 months life cost
}

/**
 * Recommend how to spend a free cash amount across:
 * 1. Emergency buffer (until 1 mo life cost in Earn)
 * 2. Toxic credits (APR > earnApy + margin) — fully paid off in priority order
 * 3. Earn buffer growth (until 3 mo life cost)
 * 4. Remaining low-APR credits (APR > earnApy still wins)
 * 5. Pure Earn investing (the rest)
 */
export function recommendAllocation(
  metrics: FinanceMetrics,
  freeCashUsd: number,
  opts: AllocateOptions = {},
): AllocationPlan {
  const earnApy = opts.earnApyPct ?? 8;
  const monthlyLife = metrics.data.monthlyLifeCostUsd;
  const emergencyTarget =
    opts.emergencyBufferTargetUsd ?? Math.max(monthlyLife, 0);
  const earnBufferTarget =
    opts.earnBufferTargetUsd ?? Math.max(monthlyLife * 3, 0);

  // Determine current earn buffer: prefer explicit override, else sum assets explicitly tagged role:"buffer".
  // Fallback to legacy regex name match for backwards-compat.
  const currentEarnBuffer =
    opts.currentEarnBufferUsd ??
    (() => {
      const tagged = metrics.data.liquidAssets.filter(
        (a) => a.role === "buffer",
      );
      if (tagged.length > 0) return tagged.reduce((s, a) => s + a.amountUsd, 0);
      return metrics.data.liquidAssets
        .filter(
          (a) => a.risk !== "high" && /earn|usdc|usdt|stable/i.test(a.name),
        )
        .reduce((s, a) => s + a.amountUsd, 0);
    })();

  const steps: AllocationStep[] = [];
  const notes: string[] = [];
  let remaining = Math.max(0, freeCashUsd);

  // ── Near-term earmark check ───────────────────────────────────────────────
  // Liquid cash = only assets that are genuinely spendable (not speculative cars, not already earmarked)
  const today = new Date();
  const sixtyDaysOut = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const nearTermEarmarks = metrics.data.earmarks.filter((e) => {
    if (!e.due) return false;
    const d = parseRussianDue(e.due);
    return d !== null && d <= sixtyDaysOut;
  });
  const nearTermEarmarksUsd = nearTermEarmarks.reduce(
    (s, e) => s + e.amountUsd,
    0,
  );
  const liquidCashUsd = metrics.data.liquidAssets
    .filter(
      (a) =>
        a.role !== "speculative" && a.role !== "reserve" && a.risk !== "high",
    )
    .reduce((s, a) => s + a.amountUsd, 0);
  const cashCrunchGap = Math.max(0, nearTermEarmarksUsd - liquidCashUsd);
  if (cashCrunchGap > 0) {
    notes.push(
      `🚨 СТОП: в ближайшие 60 дней забронировано $${nearTermEarmarksUsd.toFixed(0)} (${nearTermEarmarks.map((e) => e.name).join(", ")}), а ликвидного кэша только $${liquidCashUsd.toFixed(0)}. Дефицит $${cashCrunchGap.toFixed(0)}. Сначала закрой дефицит — забери долги, не трать на кредиты досрочно.`,
    );
    // Cap remaining to avoid false "pay off credits" recommendations during crunch
    remaining = 0;
  }

  // 1. Emergency buffer if missing
  const emergencyGap = Math.max(0, emergencyTarget - currentEarnBuffer);
  if (emergencyGap > 0 && remaining > 0) {
    const take = Math.min(remaining, emergencyGap);
    steps.push({
      kind: "emergency_buffer",
      target: "EarnOptimizer (буфер на 1 мес жизни)",
      amountUsd: take,
      reason: `Подушка безопасности: $${monthlyLife.toFixed(0)}/мес × 1 = $${emergencyTarget.toFixed(0)}. Сейчас в Earn только $${currentEarnBuffer.toFixed(0)}.`,
      expectedReturnPct: earnApy,
      annualSavingsUsd: take * (earnApy / 100),
    });
    remaining -= take;
  }

  // 2. Personal debts. Interest-free, so they never win on arithmetic — but the
  // owner ranks them above credits, and some carry agreed deadlines.
  const personalSorted = metrics.data.personalDebts
    .filter((p) => p.amountUsd > 0)
    .sort(comparePersonalDebts);

  for (const p of personalSorted) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, p.amountUsd);
    const dueDate = p.due ? parseRussianDue(p.due) : null;
    const overdue = dueDate !== null && dueDate < today;
    const reason = overdue
      ? `⚠️ Срок прошёл (${p.due}). Процентов не даёт, но обещание есть обещание.`
      : p.due
        ? `Срок: ${p.due}. Беспроцентный, но с договорённостью — идёт впереди кредитов.`
        : `Беспроцентный долг человеку. Приоритет владельца: люди раньше банков.`;
    steps.push({
      kind: "personal_debt",
      target: p.name,
      amountUsd: take,
      reason,
      expectedReturnPct: 0,
      annualSavingsUsd: 0,
    });
    remaining -= take;
  }

  // 3 + 5. Credits sorted by APR desc; pay off any APR > earnApy + 2 (margin)
  const sortedCredits = [...metrics.credits]
    .filter((c) => c.balance > 0)
    .sort((a, b) => b.aprPct - a.aprPct);

  const toxicMargin = 2; // pay off credits whose APR exceeds earn by at least this margin

  // First: toxic (APR >= 30) — always pay off
  for (const c of sortedCredits) {
    if (remaining <= 0) break;
    if (c.aprPct < 30) continue;
    const take = Math.min(remaining, c.balanceUsd);
    steps.push({
      kind: "credit_payoff",
      target: c.name,
      amountUsd: take,
      reason: `🔴 Токсичный кредит (APR ${c.aprPct.toFixed(2)}%). Каждый $1 экономит $${(c.aprPct / 100).toFixed(2)}/год процентов.`,
      expectedReturnPct: c.aprPct,
      annualSavingsUsd: take * (c.aprPct / 100),
    });
    remaining -= take;
  }

  // 3. Top up earn buffer to 3 months
  const bufferAlready = steps
    .filter((s) => s.kind === "emergency_buffer")
    .reduce((sum, s) => sum + s.amountUsd, 0);
  const projectedBuffer = currentEarnBuffer + bufferAlready;
  const bufferGap = Math.max(0, earnBufferTarget - projectedBuffer);
  if (bufferGap > 0 && remaining > 0) {
    const take = Math.min(remaining, bufferGap);
    steps.push({
      kind: "earn_buffer",
      target: "EarnOptimizer (буфер до 3 мес жизни)",
      amountUsd: take,
      reason: `Доращивание подушки до $${earnBufferTarget.toFixed(0)} (3 мес расходов).`,
      expectedReturnPct: earnApy,
      annualSavingsUsd: take * (earnApy / 100),
    });
    remaining -= take;
  }

  // 4. Normal credits (APR > earn + margin)
  for (const c of sortedCredits) {
    if (remaining <= 0) break;
    if (c.aprPct >= 30) continue; // already handled
    if (c.aprPct <= earnApy + toxicMargin) continue;
    const take = Math.min(remaining, c.balanceUsd);
    steps.push({
      kind: "credit_payoff",
      target: c.name,
      amountUsd: take,
      reason: `Кредит APR ${c.aprPct.toFixed(2)}% > Earn ${earnApy}%. Гарантированная экономия > доходности Earn.`,
      expectedReturnPct: c.aprPct,
      annualSavingsUsd: take * (c.aprPct / 100),
    });
    remaining -= take;
  }

  // 5. Remainder → Earn investing
  if (remaining > 0) {
    steps.push({
      kind: "earn_invest",
      target: "EarnOptimizer (рост портфеля)",
      amountUsd: remaining,
      reason: `Все токсичные/невыгодные кредиты учтены. Остаток в Earn под ~${earnApy}% APY.`,
      expectedReturnPct: earnApy,
      annualSavingsUsd: remaining * (earnApy / 100),
    });
    remaining = 0;
  }

  // Notes
  const personalAllocated = steps
    .filter((s) => s.kind === "personal_debt")
    .reduce((sum, s) => sum + s.amountUsd, 0);
  if (personalAllocated > 0) {
    notes.push(
      `Личные долги показаны с отдачей 0% — это не ошибка. Беспроцентный долг ничего не экономит, ты просто закрываешь обязательство. Из-за этого «эффективная отдача» ниже, чем была бы при чистом гашении кредитов.`,
    );
  }

  const remainingNormalCredits = sortedCredits.filter(
    (c) => c.aprPct > 0 && c.aprPct <= earnApy + toxicMargin,
  );
  if (remainingNormalCredits.length > 0) {
    notes.push(
      `Кредиты с APR ≤ ${(earnApy + toxicMargin).toFixed(0)}% (${remainingNormalCredits.map((c) => c.name).join(", ")}) — НЕ гасить досрочно. Лучше эти деньги в Earn @ ${earnApy}%.`,
    );
  }
  if (
    metrics.totalEarmarkedUsd > 0 &&
    freeCashUsd + metrics.totalEarmarkedUsd > metrics.totalLiquidAssetsUsd
  ) {
    notes.push(
      `⚠️ Не забудь: у тебя $${metrics.totalEarmarkedUsd.toFixed(0)} забронировано (Tesla, доставка). Не трать их.`,
    );
  }

  const totalAnnualSavingsUsd = steps.reduce(
    (s, x) => s + x.annualSavingsUsd,
    0,
  );
  const allocated = steps.reduce((s, x) => s + x.amountUsd, 0);
  const effectiveReturnPct =
    allocated > 0 ? (totalAnnualSavingsUsd / allocated) * 100 : 0;

  return {
    inputUsd: freeCashUsd,
    steps,
    totalAnnualSavingsUsd,
    effectiveReturnPct,
    notes,
  };
}

// ── Multi-month payoff projection ─────────────────────────────────────────

export interface PayoffPhase {
  order: number;
  kind: "personal" | "credit";
  target: string;
  amountUsd: number;
  aprPct: number | null;
  monthsNeeded: number;
  startLabel: string;
  endLabel: string;
  /** Monthly payment that stops once this is closed. 0 for personal debts. */
  freesUpUsd: number;
}

export interface PayoffPlan {
  phases: PayoffPhase[];
  debtFreeLabel: string | null;
  totalMonths: number;
  startingFlowUsd: number;
  finalFlowUsd: number;
  /** Interest actually paid across the whole plan, with balances declining. */
  totalInterestUsd: number;
  /** Interest over the next 12 months if balances never moved — the naive figure. */
  interestIfFrozen12moUsd: number;
  goalCapitalUsd: number;
  monthsToGoal: number | null;
  goalLabel: string | null;
}

const RU_MONTH_SHORT = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];

function monthLabel(base: Date, offset: number): string {
  const d = new Date(base.getFullYear(), base.getMonth() + offset, 1);
  return `${RU_MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Project month by month how the debts get cleared, then how long the freed-up
 * flow takes to reach the passive-income goal.
 *
 * Order: personal debts first (owner's priority, deadlines respected), then
 * credits by APR. Credits within the same whole percent are cleared smallest
 * first, so the freed payment starts working sooner.
 *
 * Every open credit accrues interest and takes its contractual minimum each
 * simulated month; whatever is left over is thrown at the head of the queue.
 * That makes the reported interest total the amount actually paid under this
 * plan, not a naive "current interest × 12".
 */
export function buildPayoffPlan(
  metrics: FinanceMetrics,
  opts: { startCashUsd?: number; from?: Date } = {},
): PayoffPlan {
  const base = opts.from ?? new Date();
  let carry = Math.max(0, opts.startCashUsd ?? metrics.freeCashUsd);
  // Income minus living costs. The contractual minimums are taken back out
  // inside the loop, so they are not double-counted here.
  const baseFlow = metrics.freeCashFlowUsd + metrics.totalMonthlyPaymentUsd;
  const startingFlowUsd = metrics.freeCashFlowUsd;

  interface SimCredit {
    balance: number;
    aprPct: number;
    minPayment: number;
    closed: boolean;
  }

  const simCredits: SimCredit[] = [];

  interface QueueItem {
    kind: "personal" | "credit";
    name: string;
    initialAmount: number;
    remaining: number;
    aprPct: number | null;
    freesUpUsd: number;
    credit: SimCredit | null;
    startMonth: number | null;
  }

  const queue: QueueItem[] = metrics.data.personalDebts
    .filter((p) => p.amountUsd > 0)
    .sort(comparePersonalDebts)
    .map((p) => ({
      kind: "personal" as const,
      name: p.name,
      initialAmount: p.amountUsd,
      remaining: p.amountUsd,
      aprPct: null,
      freesUpUsd: 0,
      credit: null,
      startMonth: null,
    }));

  for (const c of metrics.credits
    .filter((c) => c.balance > 0)
    .sort((a, b) => {
      const ra = Math.round(a.aprPct);
      const rb = Math.round(b.aprPct);
      if (ra !== rb) return rb - ra;
      return a.balanceUsd - b.balanceUsd;
    })) {
    const sim: SimCredit = {
      balance: c.balanceUsd,
      aprPct: c.aprPct,
      minPayment: c.monthlyPaymentUsd,
      closed: false,
    };
    simCredits.push(sim);
    queue.push({
      kind: "credit",
      name: c.name,
      initialAmount: c.balanceUsd,
      remaining: c.balanceUsd,
      aprPct: c.aprPct,
      freesUpUsd: c.monthlyPaymentUsd,
      credit: sim,
      startMonth: null,
    });
  }

  const phases: PayoffPhase[] = [];
  let month = 0;
  let totalInterestUsd = 0;
  let qi = 0;

  // Months are 1-based inside the loop; label offset 0 is the current month.
  const closePhase = (t: QueueItem, endMonth: number): void => {
    const start = t.startMonth ?? endMonth;
    phases.push({
      order: phases.length + 1,
      kind: t.kind,
      target: t.name,
      amountUsd: t.initialAmount,
      aprPct: t.aprPct,
      monthsNeeded: endMonth - start + 1,
      startLabel: monthLabel(base, start - 1),
      endLabel: monthLabel(base, endMonth - 1),
      freesUpUsd: t.freesUpUsd,
    });
  };

  if (baseFlow > 0) {
    while (qi < queue.length && month < 240) {
      month++;
      let minTotal = 0;
      for (const c of simCredits) {
        if (c.closed) continue;
        const interest = c.balance * (c.aprPct / 100 / 12);
        totalInterestUsd += interest;
        c.balance += interest;
        const pay = Math.min(c.minPayment, c.balance);
        c.balance -= pay;
        minTotal += pay;
        if (c.balance <= 0.01) c.closed = true;
      }

      let extra = baseFlow - minTotal + carry;
      carry = 0;

      while (extra > 0.01 && qi < queue.length) {
        const t = queue[qi]!;
        if (t.startMonth === null) t.startMonth = month;

        if (t.kind === "credit" && t.credit) {
          if (t.credit.closed) {
            closePhase(t, month);
            qi++;
            continue;
          }
          const pay = Math.min(extra, t.credit.balance);
          t.credit.balance -= pay;
          extra -= pay;
          if (t.credit.balance <= 0.01) {
            t.credit.closed = true;
            closePhase(t, month);
            qi++;
          } else break;
        } else {
          const pay = Math.min(extra, t.remaining);
          t.remaining -= pay;
          extra -= pay;
          if (t.remaining <= 0.01) {
            closePhase(t, month);
            qi++;
          } else break;
        }
      }
      carry = Math.max(0, extra);
    }
  }

  const goalCapitalUsd = metrics.passiveGoalCapitalUsd;
  const monthsToGoal =
    baseFlow > 0
      ? Math.ceil(Math.max(0, goalCapitalUsd - carry) / baseFlow)
      : null;

  return {
    phases,
    debtFreeLabel: phases.length > 0 ? monthLabel(base, month - 1) : null,
    totalMonths: month,
    startingFlowUsd,
    finalFlowUsd: baseFlow,
    totalInterestUsd,
    interestIfFrozen12moUsd: metrics.totalMonthlyInterestUsd * 12,
    goalCapitalUsd,
    monthsToGoal,
    goalLabel:
      monthsToGoal !== null ? monthLabel(base, month - 1 + monthsToGoal) : null,
  };
}
