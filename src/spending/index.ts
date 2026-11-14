import { loadFinance } from "../finance/index.js";
import { loadReceipts } from "../receipts/index.js";
import type { ItemGroup, ReceiptsData } from "../receipts/index.js";
import { loadExpenses } from "../expenses/index.js";
import type { ExpensesData } from "../expenses/index.js";

// ── Calendar ──────────────────────────────────────────────────────────────
// Dates are "YYYY-MM-DD" strings throughout. Arithmetic runs in UTC so the
// server's timezone can never shift a day across a boundary.

const DAY_MS = 86_400_000;

function toUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** Today on the family's calendar (server-local), not UTC's. */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday of the Mon–Sun week containing `day`. */
export function weekStart(day: string): string {
  const ms = toUtc(day);
  const mondayOffset = (new Date(ms).getUTCDay() + 6) % 7;
  return fromUtc(ms - mondayOffset * DAY_MS);
}

/**
 * A Mon–Sun week often straddles two months. It belongs to the month holding
 * its Thursday (the ISO-8601 rule), so every week has exactly one home month
 * and a month has 4 or 5 weeks.
 */
export function weekOfMonth(start: string): { month: string; n: number } {
  const thursday = addDays(start, 3);
  return {
    month: thursday.slice(0, 7),
    n: Math.ceil(Number(thursday.slice(8, 10)) / 7),
  };
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

const MONTH_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTH_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTH_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

const monthIdx = (day: string): number => Number(day.slice(5, 7)) - 1;
const dayNum = (day: string): number => Number(day.slice(8, 10));

/** "22–28 сен", or "29 сен – 5 окт" when the week crosses a month. */
export function weekLabel(start: string): string {
  const end = addDays(start, 6);
  if (start.slice(0, 7) === end.slice(0, 7)) {
    return `${dayNum(start)}–${dayNum(end)} ${MONTH_SHORT[monthIdx(end)]}`;
  }
  return `${dayNum(start)} ${MONTH_SHORT[monthIdx(start)]} – ${dayNum(end)} ${MONTH_SHORT[monthIdx(end)]}`;
}

export function ordinalWeek(n: number): string {
  return `${n}-я неделя`;
}

/** "4-я неделя сентября" */
export function weekOfMonthLabel(start: string): string {
  const { month, n } = weekOfMonth(start);
  return `${ordinalWeek(n)} ${MONTH_GEN[Number(month.slice(5, 7)) - 1]}`;
}

/** "Сентябрь 2026" */
export function monthLabel(month: string): string {
  return `${MONTH_NOM[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

// ── Unified spending ──────────────────────────────────────────────────────
// Receipts carry line items; cash entries are a single amount. Both are
// flattened into one stream so a week or month can be totalled in one pass.

export type SpendGroup = ItemGroup | "cash";

export interface SpendEntry {
  date: string;
  usd: number;
  group: SpendGroup;
  category: string;
  source: "receipt" | "cash";
  /** Receipt id or cash-expense id — lets a period count receipts, not lines. */
  refId: string;
  /** What it was: the receipt line, or the note typed with a cash spend. */
  label?: string;
}

/** Cash spends that are groceries or household goods count toward those lines too. */
const CASH_GROUP: Record<string, ItemGroup> = { Продукты: "food", "Дом и быт": "household" };

export function collectEntries(
  receipts: ReceiptsData,
  cash: ExpensesData,
): SpendEntry[] {
  const out: SpendEntry[] = [];
  for (const r of receipts.receipts) {
    const k = r.total > 0 ? r.totalUsd / r.total : 1 / 16.3;
    for (const item of r.items) {
      out.push({
        date: r.date,
        usd: item.total * k,
        group: item.group,
        category: item.category,
        source: "receipt",
        refId: r.id,
        label: item.name,
      });
    }
  }
  for (const e of cash.expenses) {
    out.push({
      date: e.date,
      usd: e.amountUsd,
      group: CASH_GROUP[e.category] ?? "cash",
      category: e.category,
      source: "cash",
      refId: e.id,
      label: e.note,
    });
  }
  return out;
}

export interface CategoryTotal {
  category: string;
  group: SpendGroup;
  totalUsd: number;
  share: number;
}

export interface PeriodSummary {
  from: string;
  to: string;
  totalUsd: number;
  foodUsd: number;
  householdUsd: number;
  otherUsd: number;
  cashUsd: number;
  receiptCount: number;
  cashCount: number;
  /** Distinct days with at least one entry. */
  activeDays: number;
  categories: CategoryTotal[];
}

export function summarize(
  entries: SpendEntry[],
  from: string,
  to: string,
): PeriodSummary {
  const s: PeriodSummary = {
    from,
    to,
    totalUsd: 0,
    foodUsd: 0,
    householdUsd: 0,
    otherUsd: 0,
    cashUsd: 0,
    receiptCount: 0,
    cashCount: 0,
    activeDays: 0,
    categories: [],
  };
  const receiptIds = new Set<string>();
  const days = new Set<string>();
  const byCat = new Map<string, CategoryTotal>();

  for (const e of entries) {
    if (e.date < from || e.date > to) continue;
    s.totalUsd += e.usd;
    days.add(e.date);
    if (e.source === "receipt") receiptIds.add(e.refId);
    else s.cashCount++;

    if (e.source === "cash") s.cashUsd += e.usd;
    if (e.group === "food") s.foodUsd += e.usd;
    else if (e.group === "household") s.householdUsd += e.usd;
    else s.otherUsd += e.usd;

    const c = byCat.get(e.category) ?? {
      category: e.category,
      group: e.group,
      totalUsd: 0,
      share: 0,
    };
    c.totalUsd += e.usd;
    byCat.set(e.category, c);
  }

  s.receiptCount = receiptIds.size;
  s.activeDays = days.size;
  s.categories = [...byCat.values()]
    .map((c) => ({ ...c, share: s.totalUsd > 0 ? c.totalUsd / s.totalUsd : 0 }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
  return s;
}

// ── Детское by kind ───────────────────────────────────────────────────────
// Kids' spending is the biggest bucket and mixes one-offs (clothes) with what
// recurs every month (formula, nappies). Split by what the note / line says.
// First match wins: wipes "салфетки в сад" are wipes, not kindergarten.

const KIDS_KINDS: { kind: string; re: RegExp }[] = [
  { kind: "Смесь и питание", re: /смес|nan(?!\p{L})|nutrilon|hipp|humana|пюре|кашк|каша|amestec/iu },
  { kind: "Подгузники", re: /памперс|подгуз|pampers|huggies|scutec/iu },
  { kind: "Соски и бутылочки", re: /соск|бутылоч|пустыш|tetin|biberon/iu },
  { kind: "Салфетки и гигиена", re: /салфет|присып|крем|шампун|мыл|servet/iu },
  { kind: "Одежда и обувь", re: /одежд|кофт|штан|носк|колгот|шапк|куртк|ботин|обув|сандал|комбинез|боди|пижам|haine/iu },
  { kind: "Кружки и секции", re: /танц|карате|секци|кружок|тренир|бассейн/iu },
  { kind: "Сад и школа", re: /(?<!\p{L})сад(а|у|ом|е|ик\p{L}*)?(?!\p{L})|школ|учеб|тетрад|канц|фото/iu },
  { kind: "Игрушки", re: /игрушк|конструктор|кукл|lego/iu },
];

export interface KidsKind {
  kind: string;
  totalUsd: number;
  items: { date: string; label: string; usd: number }[];
}

export function kidsKind(label: string, category: string): string {
  if (category === "Детское питание") return "Смесь и питание";
  return KIDS_KINDS.find((k) => k.re.test(label))?.kind ?? "Другое";
}

export function kidsBreakdown(entries: SpendEntry[], from: string, to: string): KidsKind[] {
  const by = new Map<string, KidsKind>();
  for (const e of entries) {
    if (e.date < from || e.date > to || rollupOf(e) !== "Детское") continue;
    const label = e.label?.trim() || "без описания";
    const kind = kidsKind(label, e.category);
    const k = by.get(kind) ?? { kind, totalUsd: 0, items: [] };
    k.totalUsd += e.usd;
    k.items.push({ date: e.date, label, usd: e.usd });
    by.set(kind, k);
  }
  return [...by.values()]
    .map((k) => ({ ...k, items: k.items.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => (a.kind === "Другое" ? 1 : 0) - (b.kind === "Другое" ? 1 : 0) || b.totalUsd - a.totalUsd);
}

// Receipts split food into ~15 categories (Молочка, Бакалея, Мясо…) — right
// for the diet table, but a month view needs the few buckets a family thinks in.
export function rollupOf(c: { category: string; group: string }): string {
  if (c.category === "Детское питание") return "Детское";
  if (c.category === "Аптека") return "Аптека";
  if (c.group === "food" || c.category === "Продукты") return "Продукты";
  if (c.group === "household" || c.category === "Дом и быт") return "Хозтовары и химия";
  if (["Кофе", "Перекус", "Обед / кафе"].includes(c.category)) return "Кафе и перекусы";
  return c.category;
}

export function rollupCategories(cats: PeriodSummary["categories"], total: number): { category: string; totalUsd: number; share: number; parts: { category: string; totalUsd: number }[] }[] {
  const by = new Map<string, { category: string; totalUsd: number; share: number; parts: { category: string; totalUsd: number }[] }>();
  for (const c of cats) {
    const key = rollupOf(c);
    const r = by.get(key) ?? { category: key, totalUsd: 0, share: 0, parts: [] };
    r.totalUsd += c.totalUsd;
    r.parts.push({ category: c.category, totalUsd: c.totalUsd });
    by.set(key, r);
  }
  return [...by.values()]
    .map((r) => ({ ...r, share: total > 0 ? r.totalUsd / total : 0, parts: r.parts.sort((a, b) => b.totalUsd - a.totalUsd) }))
    .sort((a, b) => b.totalUsd - a.totalUsd);
}


// ── Week ──────────────────────────────────────────────────────────────────

/** How far back to look for a "normal week" baseline. */
const BASELINE_WEEKS = 8;

export interface WeekReport {
  start: string;
  end: string;
  label: string;
  ofMonthLabel: string;
  summary: PeriodSummary;
  previous: PeriodSummary;
  /**
   * Average of earlier weeks that have any data. Empty weeks are skipped: a
   * family of five never spends nothing, so an empty week means nothing was
   * logged, and averaging it in would drag the baseline toward zero.
   */
  avgUsd: number | null;
  avgWeeks: number;
  isCurrent: boolean;
  /** 1–7: how much of the week has happened. */
  daysElapsed: number;
  /** This week and the BASELINE_WEEKS before it, oldest first. */
  history: { start: string; label: string; totalUsd: number }[];
}

export function buildWeekReport(
  entries: SpendEntry[],
  start: string,
  today: string,
): WeekReport {
  const end = addDays(start, 6);
  const isCurrent = today >= start && today <= end;

  const history: WeekReport["history"] = [];
  for (let i = BASELINE_WEEKS; i >= 0; i--) {
    const ws = addDays(start, -7 * i);
    history.push({
      start: ws,
      label: weekLabel(ws),
      totalUsd: summarize(entries, ws, addDays(ws, 6)).totalUsd,
    });
  }
  const earlier = history
    .slice(0, -1)
    .map((h) => h.totalUsd)
    .filter((t) => t > 0);

  return {
    history,
    start,
    end,
    label: weekLabel(start),
    ofMonthLabel: weekOfMonthLabel(start),
    summary: summarize(entries, start, end),
    previous: summarize(entries, addDays(start, -7), addDays(start, -1)),
    avgUsd:
      earlier.length > 0
        ? earlier.reduce((a, b) => a + b, 0) / earlier.length
        : null,
    avgWeeks: earlier.length,
    isCurrent,
    daysElapsed: isCurrent ? daysBetween(start, today) + 1 : 7,
  };
}

// ── Month ─────────────────────────────────────────────────────────────────

export interface MonthReport {
  month: string;
  label: string;
  summary: PeriodSummary;
  budgetUsd: number;
  daysInMonth: number;
  daysElapsed: number;
  isCurrent: boolean;
  /** Full-month estimate for the running month; the actual total for a past one. */
  projectedUsd: number | null;
  /** The month before, whole — for "vs last month" per category. */
  previous: PeriodSummary;
  /** The Mon–Sun weeks this month owns (see weekOfMonth), with their totals. */
  weeks: { n: number; start: string; label: string; totalUsd: number }[];
  /** The Детское bucket split by kind — one big sum says nothing. */
  kids: KidsKind[];
}

/** Before this many days of a month, a projection is mostly noise. */
const MIN_DAYS_FOR_PROJECTION = 7;

export function buildMonthReport(
  entries: SpendEntry[],
  month: string,
  today: string,
  budgetUsd: number,
): MonthReport {
  const dim = daysInMonth(month);
  const from = `${month}-01`;
  const to = `${month}-${String(dim).padStart(2, "0")}`;
  const isCurrent = today.slice(0, 7) === month;
  const daysElapsed = isCurrent ? dayNum(today) : dim;
  const summary = summarize(entries, from, to);

  const weeks: MonthReport["weeks"] = [];
  for (let ws = weekStart(addDays(from, -6)); ws <= to; ws = addDays(ws, 7)) {
    const wm = weekOfMonth(ws);
    if (wm.month !== month) continue;
    weeks.push({
      n: wm.n,
      start: ws,
      label: weekLabel(ws),
      totalUsd: summarize(entries, ws, addDays(ws, 6)).totalUsd,
    });
  }

  const pm = addDays(from, -1).slice(0, 7);
  const previous = summarize(entries, `${pm}-01`, addDays(from, -1));

  return {
    month,
    label: monthLabel(month),
    summary,
    previous,
    budgetUsd,
    daysInMonth: dim,
    daysElapsed,
    isCurrent,
    projectedUsd: !isCurrent
      ? summary.totalUsd
      : daysElapsed >= MIN_DAYS_FOR_PROJECTION
        ? (summary.totalUsd / daysElapsed) * dim
        : null,
    weeks,
    kids: kidsBreakdown(entries, from, to),
  };
}

/**
 * The budget the tracker can be held against: the variable part of living
 * costs. Falls back to the full life cost only when it was never configured.
 */
export function variableBudgetUsd(): number {
  const fin = loadFinance();
  return fin.monthlyVariableBudgetUsd ?? fin.monthlyLifeCostUsd;
}

export function rubPerUsd(): number {
  return loadFinance().rubPerUsd || 16.3;
}

// ── Telegram text ─────────────────────────────────────────────────────────

const money = (n: number, d = 0): string =>
  n.toLocaleString("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d });

const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function delta(current: number, base: number): string {
  if (base <= 0) return "";
  // Rounded first so float noise on equal sums can't print "−0%".
  const pct = Math.round(((current - base) / base) * 100);
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${money(Math.abs(pct))}%`;
}

function topCategories(s: PeriodSummary, limit: number): string {
  return s.categories
    .filter((c) => c.totalUsd >= 0.5)
    .slice(0, limit)
    .map((c) => `• ${escHtml(c.category)} — $${money(c.totalUsd)}`)
    .join("\n");
}

/** Shared verdict for "tracked spending vs. variable budget". */
export function budgetVerdict(
  spentUsd: number,
  budgetUsd: number,
): { tone: "ok" | "over" | "under"; text: string } {
  if (budgetUsd <= 0) return { tone: "ok", text: "" };
  const diff = spentUsd - budgetUsd;
  const pct = (diff / budgetUsd) * 100;
  if (Math.abs(pct) <= 10) {
    return { tone: "ok", text: `в рамках бюджета (${pct >= 0 ? "+" : "−"}${money(Math.abs(pct))}%)` };
  }
  if (diff > 0) {
    return { tone: "over", text: `перерасход $${money(diff)} (+${money(pct)}%)` };
  }
  return { tone: "under", text: `ниже бюджета на $${money(-diff)} — если всё записывалось` };
}

export function formatWeekReport(
  r: WeekReport,
  month: MonthReport | null,
  rub: number,
): string {
  const s = r.summary;
  const head = `📅 <b>Неделя ${r.label}</b> · ${r.ofMonthLabel}`;

  if (s.totalUsd === 0) {
    return (
      `${head}\n\n📭 ${r.isCurrent ? "Пока" : "За неделю"} ничего не записано.\n` +
      `Без записей сводка пустая. На кассе: камера на QR чека → ссылку сюда, ` +
      `наличку — кнопками.`
    );
  }

  const lines = [head, ""];
  lines.push(
    `Потрачено: <b>$${money(s.totalUsd)}</b> (~${money(s.totalUsd * rub)} руб ПМР)` +
      (r.isCurrent ? ` · за ${r.daysElapsed} дн. из 7` : ""),
  );
  lines.push(
    `🧾 Чеки: $${money(s.totalUsd - s.cashUsd)} (${s.receiptCount} шт)  ·  ` +
      `💸 Наличка: $${money(s.cashUsd)} (${s.cashCount})`,
  );
  const parts = [
    s.foodUsd > 0 ? `🍽 Еда $${money(s.foodUsd)}` : "",
    s.householdUsd > 0 ? `🧴 Хозтовары и химия $${money(s.householdUsd)}` : "",
  ].filter(Boolean);
  if (parts.length > 0) lines.push(parts.join("  ·  "));
  lines.push("", topCategories(s, 6));

  const cmp: string[] = [];
  if (r.previous.totalUsd > 0) {
    cmp.push(`Прошлая неделя: $${money(r.previous.totalUsd)} → ${delta(s.totalUsd, r.previous.totalUsd)}`);
  }
  if (r.avgUsd !== null && r.avgWeeks >= 2) {
    cmp.push(`Обычная неделя (среднее за ${r.avgWeeks}): $${money(r.avgUsd)} → ${delta(s.totalUsd, r.avgUsd)}`);
  }
  if (cmp.length > 0) {
    if (r.isCurrent) cmp.push("<i>неделя ещё идёт — сравнение неполное</i>");
    lines.push("", ...cmp);
  }

  if (month) {
    const used = month.budgetUsd > 0 ? (month.summary.totalUsd / month.budgetUsd) * 100 : 0;
    lines.push(
      "",
      `🗓 ${month.label}: $${money(month.summary.totalUsd)} из $${money(month.budgetUsd)} (${money(used)}%)` +
        (month.isCurrent ? `, прошло ${month.daysElapsed} из ${month.daysInMonth} дн.` : ""),
    );
  }
  return lines.join("\n");
}

// ── Ready-made digests (bot commands + scheduler) ─────────────────────────

function liveEntries(): SpendEntry[] {
  return collectEntries(loadReceipts(), loadExpenses());
}

/** The running week so far, plus where the month stands. */
export function currentWeekDigest(today = todayLocal()): string {
  const entries = liveEntries();
  return formatWeekReport(
    buildWeekReport(entries, weekStart(today), today),
    buildMonthReport(entries, today.slice(0, 7), today, variableBudgetUsd()),
    rubPerUsd(),
  );
}

/** The last complete Mon–Sun week — sent on Monday mornings. */
export function previousWeekDigest(today = todayLocal()): string {
  const entries = liveEntries();
  const start = addDays(weekStart(today), -7);
  return formatWeekReport(
    buildWeekReport(entries, start, today),
    buildMonthReport(entries, weekOfMonth(start).month, today, variableBudgetUsd()),
    rubPerUsd(),
  );
}

export function monthDigest(month: string, today = todayLocal()): string {
  return formatMonthReport(
    buildMonthReport(liveEntries(), month, today, variableBudgetUsd()),
    rubPerUsd(),
  );
}

export function previousMonth(today = todayLocal()): string {
  return addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
}

export function formatMonthReport(m: MonthReport, rub: number): string {
  const s = m.summary;
  const head = `🗓 <b>${m.isCurrent ? "Месяц" : "Итог"}: ${m.label}</b>`;
  if (s.totalUsd === 0) {
    return `${head}\n\n📭 За месяц ничего не записано — сравнивать с бюджетом не с чем.`;
  }

  const lines = [head, ""];
  lines.push(`Записано: <b>$${money(s.totalUsd)}</b> (~${money(s.totalUsd * rub)} руб ПМР) за ${s.activeDays} дн. с записями`);

  const basis = m.isCurrent ? m.projectedUsd : s.totalUsd;
  if (basis !== null && m.budgetUsd > 0) {
    const v = budgetVerdict(basis, m.budgetUsd);
    const icon = v.tone === "over" ? "⚠️" : v.tone === "ok" ? "✓" : "↘️";
    lines.push(
      m.isCurrent
        ? `Темп на месяц: ~$${money(basis)} при бюджете $${money(m.budgetUsd)} → ${icon} ${v.text}`
        : `Бюджет $${money(m.budgetUsd)} → ${icon} ${v.text}`,
    );
  } else if (m.isCurrent) {
    lines.push(`<i>Прогноз на месяц появится после ${MIN_DAYS_FOR_PROJECTION}-го числа.</i>`);
  }

  lines.push(
    `🧾 Чеки $${money(s.totalUsd - s.cashUsd)} (${s.receiptCount} шт) · 💸 Наличка $${money(s.cashUsd)}`,
    `🍽 Еда $${money(s.foodUsd)} · 🧴 Хоз $${money(s.householdUsd)}`,
    "",
    rollupCategories(s.categories, s.totalUsd)
      .filter((c) => c.totalUsd >= 0.5)
      .slice(0, 8)
      .map((c) => `• ${escHtml(c.category)} — $${money(c.totalUsd)}`)
      .join("\n"),
  );

  const weeks = m.weeks.filter((w) => w.totalUsd > 0);
  if (weeks.length > 0) {
    lines.push("", "По неделям:");
    for (const w of m.weeks) {
      lines.push(`  ${ordinalWeek(w.n)} (${w.label}): ${w.totalUsd > 0 ? "$" + money(w.totalUsd) : "—"}`);
    }
  }

  if (s.activeDays < 7) {
    lines.push("", `<i>⚠️ Записи только за ${s.activeDays} дн. — итог, скорее всего, неполный.</i>`);
  }
  return lines.join("\n");
}
