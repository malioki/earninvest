import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { categorise, loadReceipts } from "../receipts/index.js";
import type { ItemGroup, Receipt } from "../receipts/index.js";
import {
  addDays,
  daysInMonth,
  monthLabel,
  ordinalWeek,
  weekLabel,
  weekOfMonth,
  weekStart,
} from "../spending/index.js";

const SHOPPING_FILE = path.join(config.dataDir, "shopping-lists.json");

/**
 * What a list is built from. Lists remember their source so "regenerate"
 * can rebuild them later, once more receipts have come in.
 */
export type ListSource =
  /** Repeat what was bought in a concrete date range (a week or a month). */
  | { kind: "period"; from: string; to: string }
  /** The usual basket of the n-th week of a month, averaged over all months. */
  | { kind: "typical-week"; n: number }
  /** The usual monthly basket, averaged over all months. */
  | { kind: "typical-month" };

export interface ShoppingItem {
  key: string;
  name: string;
  category: string;
  group: ItemGroup;
  qty: number;
  unit: "шт" | "кг";
  /** Estimated cost in the receipts' currency (PMR roubles). */
  estPrice: number;
  /**
   * Share of comparable periods the item showed up in (1 = every time).
   * Absent for one-period lists, where it would always be 1.
   */
  frequency?: number;
  checked: boolean;
  /** Added by hand — survives regeneration. */
  custom?: boolean;
}

export interface ShoppingList {
  id: string;
  title: string;
  source: ListSource;
  /** Human description of the data the list was built from. */
  basis: string;
  periods: number;
  currency: string;
  items: ShoppingItem[];
  /**
   * Bumped whenever the set of items changes (not on a tick), so a Telegram
   * button rendered for an older version can't tick the wrong row.
   */
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingData {
  lists: ShoppingList[];
}

/** Carrier bags show up on every receipt but nobody puts them on a list. */
const SKIP_CATEGORIES = new Set(["Пакеты"]);

/** Below this share of periods an item is "sometimes", not "usually". */
export const USUAL_FREQUENCY = 0.5;

export function itemKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── Storage ───────────────────────────────────────────────────────────────

export function loadShopping(): ShoppingData {
  try {
    if (!fs.existsSync(SHOPPING_FILE)) return { lists: [] };
    return JSON.parse(fs.readFileSync(SHOPPING_FILE, "utf-8")) as ShoppingData;
  } catch (err) {
    logger.error("[Shopping] Failed to load", err);
    return { lists: [] };
  }
}

export function saveShopping(data: ShoppingData): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(SHOPPING_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error("[Shopping] Failed to save", err);
  }
}

// ── Building ──────────────────────────────────────────────────────────────

interface Bucket {
  /** Week start or "YYYY-MM" — whatever one comparable period is. */
  id: string;
  receipts: Receipt[];
}

function groupBy(receipts: Receipt[], keyOf: (r: Receipt) => string | null): Bucket[] {
  const map = new Map<string, Receipt[]>();
  for (const r of receipts) {
    const k = keyOf(r);
    if (k === null) continue;
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([id, rs]) => ({ id, receipts: rs }));
}

/**
 * Split receipts into comparable periods. Only periods that have receipts
 * count: a week with none almost certainly wasn't logged, and treating it as
 * "bought nothing" would halve every average.
 */
function bucketsFor(source: ListSource, receipts: Receipt[]): Bucket[] {
  switch (source.kind) {
    case "period": {
      const rs = receipts.filter((r) => r.date >= source.from && r.date <= source.to);
      return rs.length > 0 ? [{ id: source.from, receipts: rs }] : [];
    }
    case "typical-week":
      return groupBy(receipts, (r) => {
        const ws = weekStart(r.date);
        return weekOfMonth(ws).n === source.n ? ws : null;
      });
    case "typical-month":
      return groupBy(receipts, (r) => r.date.slice(0, 7));
  }
}

interface Acc {
  name: string;
  category: string;
  group: ItemGroup;
  qtySum: number;
  totalSum: number;
  allWhole: boolean;
  periods: Set<string>;
  /** Date of the receipt `name`/`category` were taken from. */
  seen: string;
}

export function buildItems(buckets: Bucket[]): ShoppingItem[] {
  const acc = new Map<string, Acc>();
  for (const b of buckets) {
    for (const r of b.receipts) {
      for (const it of r.items) {
        if (SKIP_CATEGORIES.has(it.category)) continue;
        const key = itemKey(it.name);
        const a = acc.get(key) ?? {
          name: it.name,
          category: it.category,
          group: it.group,
          qtySum: 0,
          totalSum: 0,
          allWhole: true,
          periods: new Set<string>(),
          seen: r.date,
        };
        a.qtySum += it.qty;
        a.totalSum += it.total;
        if (Math.abs(it.qty - Math.round(it.qty)) > 1e-6) a.allWhole = false;
        a.periods.add(b.id);
        // Prefer the latest spelling and any manual category fix.
        if (r.date >= a.seen || it.manual) {
          a.name = it.name;
          a.category = it.category;
          a.group = it.group;
          a.seen = r.date;
        }
        acc.set(key, a);
      }
    }
  }

  const items: ShoppingItem[] = [];
  for (const [key, a] of acc) {
    const appearances = a.periods.size;
    // "When we buy it, we buy this much" — averaged over the periods it was
    // bought in, so a rare item isn't shrunk to a fraction of a pack.
    const rawQty = a.qtySum / appearances;
    const qty = a.allWhole
      ? Math.max(1, Math.round(rawQty))
      : Math.max(0.1, Math.round(rawQty * 10) / 10);
    const unitPrice = a.qtySum > 0 ? a.totalSum / a.qtySum : 0;
    items.push({
      key,
      name: a.name,
      category: a.category,
      group: a.group,
      qty,
      unit: a.allWhole ? "шт" : "кг",
      estPrice: Math.round(unitPrice * qty * 100) / 100,
      frequency: buckets.length > 1 ? appearances / buckets.length : undefined,
      checked: false,
    });
  }

  const groupOrder: Record<ItemGroup, number> = { food: 0, household: 1, other: 2 };
  return items.sort(
    (x, y) =>
      groupOrder[x.group] - groupOrder[y.group] ||
      x.category.localeCompare(y.category, "ru") ||
      (y.frequency ?? 1) - (x.frequency ?? 1) ||
      y.estPrice - x.estPrice,
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function isFullWeek(from: string, to: string): boolean {
  return weekStart(from) === from && addDays(from, 6) === to;
}

function isFullMonth(from: string, to: string): boolean {
  const month = from.slice(0, 7);
  return (
    from.endsWith("-01") &&
    to === `${month}-${String(daysInMonth(month)).padStart(2, "0")}`
  );
}

const dmy = (d: string): string => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

export function describeSource(
  source: ListSource,
  buckets: Bucket[],
): { title: string; basis: string } {
  const receiptCount = buckets.reduce((s, b) => s + b.receipts.length, 0);
  const receiptsText = `${receiptCount} ${plural(receiptCount, "чек", "чека", "чеков")}`;
  const single =
    buckets.length === 1
      ? " Пока это один период — по сути копия, а не среднее."
      : "";

  switch (source.kind) {
    case "period": {
      const title = isFullWeek(source.from, source.to)
        ? `Как неделя ${weekLabel(source.from)}`
        : isFullMonth(source.from, source.to)
          ? `Как ${monthLabel(source.from.slice(0, 7))}`
          : `Как ${dmy(source.from)}–${dmy(source.to)}`;
      return { title, basis: `Что купили за период: ${receiptsText}.` };
    }
    case "typical-week": {
      const shown = buckets.slice(0, 4).map((b) => weekLabel(b.id)).join(", ");
      const more = buckets.length > 4 ? ` и ещё ${buckets.length - 4}` : "";
      return {
        title: `Типичная ${ordinalWeek(source.n)} месяца`,
        basis:
          `Среднее по ${buckets.length} ${plural(buckets.length, "неделе", "неделям", "неделям")} ` +
          `(${shown}${more}), ${receiptsText}.${single}`,
      };
    }
    case "typical-month": {
      const shown = buckets.map((b) => monthLabel(b.id)).join(", ");
      return {
        title: "Типичный месяц",
        basis:
          `Среднее по ${buckets.length} ${plural(buckets.length, "месяцу", "месяцам", "месяцам")} ` +
          `(${shown}), ${receiptsText}. Если месяц записан не целиком, корзина занижена.${single}`,
      };
    }
  }
}

function noDataMessage(source: ListSource): string {
  switch (source.kind) {
    case "period":
      return "За этот период нет ни одного чека";
    case "typical-week":
      return `Пока нет чеков ни за одну ${ordinalWeek(source.n)} месяца`;
    case "typical-month":
      return "Пока нет ни одного чека";
  }
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Pure: build a list from receipts without saving it. */
export function generateList(source: ListSource, receipts: Receipt[]): ShoppingList {
  const buckets = bucketsFor(source, receipts);
  if (buckets.length === 0) throw new Error(noDataMessage(source));
  const { title, basis } = describeSource(source, buckets);
  const now = new Date().toISOString();
  return {
    id: newId(),
    title,
    source,
    basis,
    periods: buckets.length,
    currency: buckets[0]!.receipts[0]!.currency,
    items: buildItems(buckets),
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function validateSource(raw: unknown): ListSource {
  const s = (raw ?? {}) as Record<string, unknown>;
  const isDay = (v: unknown): v is string =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (s.kind === "period" && isDay(s.from) && isDay(s.to) && s.from <= s.to) {
    return { kind: "period", from: s.from, to: s.to };
  }
  if (s.kind === "typical-week") {
    const n = Number(s.n);
    if (Number.isInteger(n) && n >= 1 && n <= 5) return { kind: "typical-week", n };
  }
  if (s.kind === "typical-month") return { kind: "typical-month" };
  throw new Error("Непонятно, из чего строить список");
}

// ── Mutations (load → change → save) ──────────────────────────────────────

function mutate<T>(id: string, fn: (list: ShoppingList) => T): { list: ShoppingList; result: T } {
  const store = loadShopping();
  const list = store.lists.find((l) => l.id === id);
  if (!list) throw new Error("Список не найден");
  const result = fn(list);
  list.updatedAt = new Date().toISOString();
  saveShopping(store);
  return { list, result };
}

export function createList(source: ListSource): ShoppingList {
  const list = generateList(source, loadReceipts().receipts);
  const store = loadShopping();
  store.lists.unshift(list);
  saveShopping(store);
  return list;
}

/** Rebuild from the same source with today's receipts. Ticks are reset; hand-added items are kept. */
export function regenerateList(id: string): ShoppingList {
  return mutate(id, (list) => {
    const fresh = generateList(list.source, loadReceipts().receipts);
    const keep = list.items.filter(
      (i) => i.custom && !fresh.items.some((f) => f.key === i.key),
    );
    list.title = fresh.title;
    list.basis = fresh.basis;
    list.periods = fresh.periods;
    list.items = [...fresh.items, ...keep.map((i) => ({ ...i, checked: false }))];
    list.rev++;
  }).list;
}

export function toggleItem(id: string, key: string): ShoppingList {
  return mutate(id, (list) => {
    const item = list.items.find((i) => i.key === key);
    if (!item) throw new Error("Позиция не найдена");
    item.checked = !item.checked;
  }).list;
}

/** Index-based toggle for Telegram buttons; `rev` guards against stale keyboards. */
export function toggleItemAt(id: string, rev: number, index: number): ShoppingList {
  return mutate(id, (list) => {
    if (list.rev !== rev) throw new Error("Список изменился — открой его заново");
    const item = list.items[index];
    if (!item) throw new Error("Позиция не найдена");
    item.checked = !item.checked;
  }).list;
}

export function addCustomItem(id: string, name: string): ShoppingList {
  const clean = name.trim();
  if (!clean) throw new Error("Пустое название");
  return mutate(id, (list) => {
    const key = itemKey(clean);
    if (list.items.some((i) => i.key === key)) throw new Error("Уже есть в списке");
    list.items.push({
      key,
      name: clean,
      ...categorise(clean),
      qty: 1,
      unit: "шт",
      estPrice: 0,
      checked: false,
      custom: true,
    });
    list.rev++;
  }).list;
}

export function removeItem(id: string, key: string): ShoppingList {
  return mutate(id, (list) => {
    const before = list.items.length;
    list.items = list.items.filter((i) => i.key !== key);
    if (list.items.length === before) throw new Error("Позиция не найдена");
    list.rev++;
  }).list;
}

export function deleteList(id: string): boolean {
  const store = loadShopping();
  const before = store.lists.length;
  store.lists = store.lists.filter((l) => l.id !== id);
  if (store.lists.length === before) return false;
  saveShopping(store);
  return true;
}

// ── Helpers for UIs ───────────────────────────────────────────────────────

export function listTotals(list: ShoppingList): { all: number; usual: number; left: number } {
  let all = 0;
  let usual = 0;
  let left = 0;
  for (const i of list.items) {
    all += i.estPrice;
    if ((i.frequency ?? 1) >= USUAL_FREQUENCY) usual += i.estPrice;
    if (!i.checked) left += i.estPrice;
  }
  return { all, usual, left };
}

export function formatQty(i: ShoppingItem): string {
  return i.unit === "шт" ? `${i.qty} шт` : `${i.qty.toFixed(1)} кг`;
}

export function frequencyLabel(i: ShoppingItem, periods: number): string {
  if (i.frequency === undefined) return "";
  return `${Math.round(i.frequency * periods)}/${periods}`;
}

/** Plain-text version for copying into a messenger. */
export function formatListText(list: ShoppingList): string {
  const lines = [`🛒 ${list.title}`];
  let cat = "";
  for (const i of list.items) {
    if (i.category !== cat) {
      cat = i.category;
      lines.push("", `${cat}:`);
    }
    lines.push(`${i.checked ? "✅" : "▫️"} ${i.name} — ${formatQty(i)}`);
  }
  return lines.join("\n");
}

/** Which weeks / months / week-numbers have receipts — for the "create" form. */
export function availablePeriods(receipts: Receipt[]): {
  weeks: { start: string; label: string; count: number }[];
  months: { month: string; label: string; count: number }[];
  weekNs: { n: number; weeks: number }[];
} {
  const weeks = new Map<string, number>();
  const months = new Map<string, number>();
  for (const r of receipts) {
    const ws = weekStart(r.date);
    weeks.set(ws, (weeks.get(ws) ?? 0) + 1);
    const m = r.date.slice(0, 7);
    months.set(m, (months.get(m) ?? 0) + 1);
  }
  const weekNs = [1, 2, 3, 4, 5].map((n) => ({
    n,
    weeks: [...weeks.keys()].filter((ws) => weekOfMonth(ws).n === n).length,
  }));
  return {
    weeks: [...weeks.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([start, count]) => ({ start, label: weekLabel(start), count })),
    months: [...months.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([month, count]) => ({ month, label: monthLabel(month), count })),
    weekNs,
  };
}
