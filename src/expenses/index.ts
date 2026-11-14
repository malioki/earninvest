import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { loadFinance } from "../finance/index.js";

const EXPENSES_FILE = path.join(config.dataDir, "expenses.json");

export type Currency = "RUP" | "MDL" | "USD" | "EUR";

export interface CashExpense {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  amount: number;
  currency: Currency;
  amountUsd: number;
  category: string;
  note?: string;
  createdAt: string;
  source?: "web" | "telegram";
  /** Who logged it — display name, so a couple can tell entries apart. */
  addedBy?: string;
  /** Telegram user id of whoever logged it — lets "undo" touch only your own entries. */
  addedById?: number;
}

/** A one-tap button. `amount` is overwritten with whatever was last entered. */
export interface Preset {
  id: string;
  label: string;
  category: string;
  amount: number;
  currency: Currency;
}

export interface ExpensesData {
  expenses: CashExpense[];
  presets: Preset[];
}

export const CATEGORIES = [
  "Кофе",
  "Перекус",
  "Обед / кафе",
  "Транспорт",
  "Продукты",
  "Мелочи без чека",
  "Аптека",
  "Детское",
  "Дом и быт",
  "Подарки",
  "Развлечения",
  "Прочее",
] as const;

// Keyword → category for free-text spends ("смесь для малыша 403").
// First match wins: medicine before kids (a vitamin for the baby is pharmacy),
// kids before household (wipes for the kindergarten are kids' stuff).
// `\b` is ASCII-only, so Cyrillic word starts use (?<![а-яё]).
const KEYWORDS: { re: RegExp; category: (typeof CATEGORIES)[number] }[] = [
  { re: /аптек|лекарств|таблет|витамин|нурофен|ибуфен|парацет|дюфастон|сироп|капли|мазь|пластыр|бинт|градусник/i, category: "Аптека" },
  { re: /памперс|подгуз|соск|бутылоч|смесь|пюре д|детск|игрушк|танц|карате|секци|кружок|(?<![а-яё])сад(?![а-яё])/i, category: "Детское" },
  { re: /салфетк|крем|шампун|мыло|порошок|средств|губк|туалетн|бумаг|зарядк|кабел|батарейк|лампочк|химия|фери|fairy|шапочк|спонж|мочалк|расч[её]ск|косметик/i, category: "Дом и быт" },
  { re: /завтрак|обед|ужин|кафе|ресторан|столов|ланч|доставк.{0,6}ед/i, category: "Обед / кафе" },
  { re: /коктейл|шаурм|пицц|бургер|хот-?дог|пирожок|снек|чипс|онигири|суши|ролл|сэндвич|выпечк/i, category: "Перекус" },
  { re: /продукт|хлеб|батон|молок|кефир|сыр|яйц|мяс|курин|колбас|овощ|фрукт|картош|печень|какао|чай|сахар|морожен|вода|напит|сок(?![а-яё])|конфет|шоколад/i, category: "Продукты" },
  { re: /подар|цвет/i, category: "Подарки" },
];

/**
 * Family-specific words (a child's name → "Детское") live in data/expense-keywords.json,
 * not in the code: { "Детское": ["имя1", "имя2"] }. Checked at the same priority as the
 * category's built-in words. Read once; a missing file means none.
 */
let personal: Partial<Record<string, RegExp>> | null = null;
function personalKeywords(): Partial<Record<string, RegExp>> {
  if (personal) return personal;
  personal = {};
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.dataDir, "expense-keywords.json"), "utf-8")) as Record<string, string[]>;
    for (const [category, words] of Object.entries(raw)) {
      const clean = words.map((w) => w.trim()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (clean.length) personal[category] = new RegExp(clean.join("|"), "i");
    }
  } catch {
    /* no personal keywords */
  }
  return personal;
}

export function guessCategory(text: string): string | undefined {
  const own = personalKeywords();
  return KEYWORDS.find((k) => k.re.test(text) || own[k.category]?.test(text))?.category;
}

const DEFAULT_PRESETS: Preset[] = [
  { id: "coffee", label: "☕ Кофе", category: "Кофе", amount: 25, currency: "RUP" },
  { id: "shawarma", label: "🌯 Шаурма", category: "Перекус", amount: 70, currency: "RUP" },
  { id: "snack", label: "🍪 Перекус", category: "Перекус", amount: 40, currency: "RUP" },
  { id: "lunch", label: "🍽 Обед", category: "Обед / кафе", amount: 150, currency: "RUP" },
  { id: "taxi", label: "🚕 Такси", category: "Транспорт", amount: 60, currency: "RUP" },
  { id: "small", label: "🛒 Мелочи", category: "Мелочи без чека", amount: 100, currency: "RUP" },
];

export function loadExpenses(): ExpensesData {
  try {
    if (!fs.existsSync(EXPENSES_FILE)) {
      return { expenses: [], presets: [...DEFAULT_PRESETS] };
    }
    const data = JSON.parse(
      fs.readFileSync(EXPENSES_FILE, "utf-8"),
    ) as Partial<ExpensesData>;
    return {
      expenses: data.expenses ?? [],
      presets:
        data.presets && data.presets.length > 0
          ? data.presets
          : [...DEFAULT_PRESETS],
    };
  } catch (err) {
    logger.error("[Expenses] Failed to load", err);
    return { expenses: [], presets: [...DEFAULT_PRESETS] };
  }
}

export function saveExpenses(data: ExpensesData): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(EXPENSES_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error("[Expenses] Failed to save", err);
  }
}

export function rateFor(currency: Currency): number {
  const fin = loadFinance();
  switch (currency) {
    case "USD":
      return 1;
    case "EUR":
      return 1 / 1.1447;
    case "MDL":
      return fin.mdlPerUsd || 17.82;
    case "RUP":
    default:
      return fin.rubPerUsd || 16.3;
  }
}

export function addExpense(input: {
  amount: number;
  currency: Currency;
  category: string;
  date?: string;
  note?: string;
  presetId?: string;
  source?: "web" | "telegram";
  addedBy?: string;
  addedById?: number;
}): CashExpense {
  if (!(input.amount > 0)) throw new Error("Сумма должна быть больше нуля");

  const store = loadExpenses();
  const date = input.date || new Date().toISOString().slice(0, 10);
  const expense: CashExpense = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date,
    amount: input.amount,
    currency: input.currency,
    amountUsd: input.amount / rateFor(input.currency),
    category: input.category || "Прочее",
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
    source: input.source ?? "web",
    addedBy: input.addedBy,
    addedById: input.addedById,
  };
  store.expenses.push(expense);
  store.expenses.sort((a, b) => b.date.localeCompare(a.date));

  // Buttons drift toward whatever the thing actually costs now.
  if (input.presetId) {
    const p = store.presets.find((x) => x.id === input.presetId);
    if (p) {
      p.amount = input.amount;
      p.currency = input.currency;
    }
  }

  saveExpenses(store);
  return expense;
}

export function deleteExpense(id: string): boolean {
  const store = loadExpenses();
  const before = store.expenses.length;
  store.expenses = store.expenses.filter((e) => e.id !== id);
  if (store.expenses.length === before) return false;
  saveExpenses(store);
  return true;
}

// ── Stats ─────────────────────────────────────────────────────────────────

export interface CashCategoryStat {
  category: string;
  totalUsd: number;
  share: number;
  count: number;
}

export interface CashStats {
  count: number;
  totalUsd: number;
  categories: CashCategoryStat[];
  byMonth: Map<string, number>;
  firstDate: string | null;
  lastDate: string | null;
  /** Average per day across the observed window. */
  perDayUsd: number;
}

export function computeCashStats(data: ExpensesData): CashStats {
  const byCat = new Map<string, CashCategoryStat>();
  const byMonth = new Map<string, number>();
  let totalUsd = 0;

  for (const e of data.expenses) {
    totalUsd += e.amountUsd;
    const c = byCat.get(e.category) ?? {
      category: e.category,
      totalUsd: 0,
      share: 0,
      count: 0,
    };
    c.totalUsd += e.amountUsd;
    c.count++;
    byCat.set(e.category, c);

    const m = e.date.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + e.amountUsd);
  }

  const dates = data.expenses.map((e) => e.date).sort();
  const first = dates[0] ?? null;
  const last = dates[dates.length - 1] ?? null;
  const days =
    first && last
      ? Math.max(
          1,
          Math.round(
            (new Date(last).getTime() - new Date(first).getTime()) / 86_400_000,
          ) + 1,
        )
      : 1;

  return {
    count: data.expenses.length,
    totalUsd,
    categories: [...byCat.values()]
      .map((c) => ({ ...c, share: totalUsd > 0 ? c.totalUsd / totalUsd : 0 }))
      .sort((a, b) => b.totalUsd - a.totalUsd),
    byMonth,
    firstDate: first,
    lastDate: last,
    perDayUsd: totalUsd / days,
  };
}
