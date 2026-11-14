import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { loadFinance } from "../finance/index.js";
import { categorise, loadReceipts } from "../receipts/index.js";
import { addExpense } from "../expenses/index.js";
import type { Currency } from "../expenses/index.js";
import { addDays, collectEntries, daysBetween, monthLabel, summarize, todayLocal } from "../spending/index.js";
import type { SpendEntry } from "../spending/index.js";
import { loadExpenses } from "../expenses/index.js";
import { PRODUCTS, STORES, packSize, productOf, storeById, storeOfMerchant } from "./catalog.js";
import type { Product, Store } from "./catalog.js";

// Prices the family actually paid, per store: from fiscal receipts (ПМР,
// automatic) and from one-line manual entries (market, Moldovan chains).

const PURCHASES_FILE = path.join(config.dataDir, "purchases.json");

export type QtyUnit = "кг" | "л" | "шт" | "уп";

/** A purchase without a parseable receipt: "рынок помидоры 2кг 40". */
export interface ManualPurchase {
  id: string;
  date: string;
  storeId: string;
  item: string;
  qty: number;
  unit: QtyUnit;
  total: number;
  currency: Currency;
  by?: string;
  byId?: number;
  /** The cash expense logged alongside, so spending totals include it. */
  expenseId?: string;
}

export function loadPurchases(): ManualPurchase[] {
  try {
    if (!fs.existsSync(PURCHASES_FILE)) return [];
    return (JSON.parse(fs.readFileSync(PURCHASES_FILE, "utf-8")) as { purchases: ManualPurchase[] }).purchases ?? [];
  } catch (err) {
    logger.error("[Prices] Failed to load purchases", err);
    return [];
  }
}

function savePurchases(purchases: ManualPurchase[]): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(PURCHASES_FILE, JSON.stringify({ purchases }, null, 2), "utf-8");
}

// ── Parsing "помидоры 2кг 40" ─────────────────────────────────────────────

const UNIT_WORD = /^(кг|kg|г|гр|g|л|l|мл|ml|шт|buc)$/i;
const CURRENCY_WORD = /^(лей|леи|mdl|руб\p{L}*|rup|пмр|\$|usd|eur|€|евро)$/iu;

/**
 * Item, quantity and price from what's left after the store name. The price is
 * the last bare number; a number with a unit is the quantity; with two bare
 * numbers the first is a piece count ("молоко 2 36" = 2 шт for 36).
 */
export function parsePurchase(
  text: string,
  defaultCurrency: Currency,
): { item: string; qty: number; unit: QtyUnit; total: number; currency: Currency } | null {
  // Glue "2кг" / "40лей" apart so every token is a word, a number, a unit or a currency.
  const tokens = text
    .replace(/(\d)([\p{L}$€])/gu, "$1 $2")
    .replace(/([$€])(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);

  let currency: Currency = defaultCurrency;
  const nums: { value: number; unit?: string }[] = [];
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\d+(?:[.,]\d+)?$/.test(t)) {
      const next = tokens[i + 1];
      const unit = next && UNIT_WORD.test(next) ? next.toLowerCase() : undefined;
      nums.push({ value: parseFloat(t.replace(",", ".")), unit });
      if (unit) i++;
    } else if (CURRENCY_WORD.test(t)) {
      const l = t.toLowerCase();
      currency = /лей|леи|mdl/.test(l) ? "MDL" : /\$|usd/.test(l) ? "USD" : /eur|€|евро/.test(l) ? "EUR" : "RUP";
    } else {
      words.push(t);
    }
  }
  const priceIdx = nums.map((n) => !n.unit).lastIndexOf(true);
  if (priceIdx < 0 || words.length === 0) return null;
  const total = nums[priceIdx]!.value;
  if (!(total > 0)) return null;

  const others = nums.filter((_, i) => i !== priceIdx);
  const withUnit = others.find((n) => n.unit);
  let qty = 1;
  let unit: QtyUnit = "уп";
  if (withUnit) {
    const u = withUnit.unit!;
    if (u === "г" || u === "гр" || u === "g") { qty = withUnit.value / 1000; unit = "кг"; }
    else if (u === "мл" || u === "ml") { qty = withUnit.value / 1000; unit = "л"; }
    else if (u === "кг" || u === "kg") { qty = withUnit.value; unit = "кг"; }
    else if (u === "л" || u === "l") { qty = withUnit.value; unit = "л"; }
    else { qty = withUnit.value; unit = "шт"; }
  } else if (others[0]) {
    qty = others[0].value;
    unit = "шт";
  }
  return { item: words.join(" "), qty, unit, total, currency };
}

const newId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Records the purchase and the matching cash expense. */
export function addPurchase(
  store: Store,
  p: { item: string; qty: number; unit: QtyUnit; total: number; currency: Currency },
  who: { by?: string; byId?: number },
  date = todayLocal(),
): ManualPurchase {
  const cat = categorise(p.item);
  const qtyText = p.unit === "уп" ? "" : ` ${+p.qty.toFixed(3)} ${p.unit}`;
  const expense = addExpense({
    amount: p.total,
    currency: p.currency,
    category: cat.group === "other" ? "Мелочи без чека" : cat.category,
    note: `${store.name}: ${p.item}${qtyText}`,
    date,
    source: "telegram",
    addedBy: who.by,
    addedById: who.byId,
  });
  const purchase: ManualPurchase = { id: newId(), date, storeId: store.id, ...p, ...who, expenseId: expense.id };
  const all = loadPurchases();
  all.push(purchase);
  savePurchases(all);
  return purchase;
}

export function deletePurchase(id: string): ManualPurchase | undefined {
  const all = loadPurchases();
  const p = all.find((x) => x.id === id);
  if (!p) return undefined;
  savePurchases(all.filter((x) => x.id !== id));
  return p;
}

// ── Observations ──────────────────────────────────────────────────────────

export interface PriceObs {
  productId: string;
  storeId: string;
  storeName: string;
  date: string;
  /** Price per product base unit (кг / л / шт / 10 шт), in `currency`. */
  unitPrice: number;
  currency: string;
  /** Base units bought — for "how much do we usually buy". */
  qtyBase: number;
  label: string;
  source: "receipt" | "manual";
}

/** How many base units a line represents, or null if it can't be known. */
function baseQty(product: Product, name: string, qty: number, unit?: QtyUnit): number | null {
  const pack = packSize(name);
  switch (product.unit) {
    case "кг":
      if (unit === "кг") return qty;
      if (pack?.unit === "кг") return qty * pack.value;
      // Weighed goods: fractional quantity or "ВЕС" in the name means kilograms.
      if (/вес|весов/i.test(name) || Math.abs(qty - Math.round(qty)) > 1e-6) return qty;
      return null;
    case "л":
      if (unit === "л") return qty;
      if (pack?.unit === "л") return qty * pack.value;
      return null;
    case "шт":
      if (pack?.unit === "шт") return qty * pack.value;
      return unit === "кг" || unit === "л" ? null : qty;
    case "10 шт":
      if (pack?.unit === "шт") return (qty * pack.value) / 10;
      // Eggs are sold by the ten unless the name says otherwise.
      return unit === "шт" ? qty / 10 : qty;
  }
}

export function collectObservations(): PriceObs[] {
  const out: PriceObs[] = [];
  for (const r of loadReceipts().receipts) {
    const store = storeOfMerchant(r.merchant);
    for (const it of r.items) {
      const product = productOf(it.name);
      if (!product) continue;
      const q = baseQty(product, it.name, it.qty);
      if (!q || !(it.total > 0)) continue;
      out.push({
        productId: product.id, storeId: store.id, storeName: store.name, date: r.date,
        unitPrice: it.total / q, currency: r.currency, qtyBase: q, label: it.name, source: "receipt",
      });
    }
  }
  for (const p of loadPurchases()) {
    const product = productOf(p.item);
    const store = storeById(p.storeId);
    if (!product || !store) continue;
    const q = baseQty(product, p.item, p.qty, p.unit);
    if (!q) continue;
    out.push({
      productId: product.id, storeId: store.id, storeName: store.name, date: p.date,
      unitPrice: p.total / q, currency: p.currency, qtyBase: q, label: p.item, source: "manual",
    });
  }
  return out;
}

// ── Comparison ────────────────────────────────────────────────────────────

/** Prices older than this don't count — shelves change. */
const MAX_AGE_DAYS = 90;

export interface StorePrice {
  storeId: string;
  storeName: string;
  where: string;
  /** Latest price, converted to ПМР roubles per base unit. */
  rub: number;
  native: number;
  currency: string;
  date: string;
  trip: boolean;
}

export interface ProductComparison {
  product: Product;
  stores: StorePrice[];
  cheapest: StorePrice;
  /** Where the family buys it most often. */
  usual: StorePrice;
  /** Typical base units bought per month (from history). */
  monthlyQty: number;
  /** ПМР roubles a month saved by buying at the cheapest store instead of the usual one. */
  monthlySavingRub: number;
}

function toRub(amount: number, currency: string): number {
  const fin = loadFinance();
  const rubPerUsd = fin.rubPerUsd || 16.1;
  switch (currency) {
    case "RUP": return amount;
    case "MDL": return (amount / (fin.mdlPerUsd || 17.8)) * rubPerUsd;
    case "USD": return amount * rubPerUsd;
    case "EUR": return amount * (fin.usdPerEur || 1.13) * rubPerUsd;
    default: return amount;
  }
}

export function compareStores(today = todayLocal()): { compared: ProductComparison[]; single: { product: Product; store: string }[] } {
  const since = addDays(today, -MAX_AGE_DAYS);
  const obs = collectObservations();
  const byProduct = new Map<string, PriceObs[]>();
  for (const o of obs) byProduct.set(o.productId, [...(byProduct.get(o.productId) ?? []), o]);

  const compared: ProductComparison[] = [];
  const single: { product: Product; store: string }[] = [];
  for (const [productId, list] of byProduct) {
    const product = PRODUCTS.find((p) => p.id === productId)!;
    const recent = list.filter((o) => o.date >= since);
    const latest = new Map<string, PriceObs>();
    const count = new Map<string, number>();
    for (const o of recent) {
      count.set(o.storeId, (count.get(o.storeId) ?? 0) + 1);
      const prev = latest.get(o.storeId);
      if (!prev || o.date >= prev.date) latest.set(o.storeId, o);
    }
    const stores: StorePrice[] = [...latest.values()]
      .map((o) => ({
        storeId: o.storeId, storeName: o.storeName, where: (storeById(o.storeId) ?? storeOfMerchant(o.storeName)).where,
        rub: toRub(o.unitPrice, o.currency), native: o.unitPrice,
        currency: o.currency, date: o.date, trip: !!storeById(o.storeId)?.trip,
      }))
      .sort((a, b) => a.rub - b.rub);
    if (stores.length === 0) continue;
    if (stores.length === 1) {
      single.push({ product, store: stores[0]!.storeName });
      continue;
    }
    const usualId = [...count.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const usual = stores.find((s) => s.storeId === usualId)!;
    const cheapest = stores[0]!;
    // Monthly quantity: everything bought over the observed span, scaled to 30 days.
    const dates = list.map((o) => o.date).sort();
    const spanDays = Math.max(30, daysBetween(dates[0]!, today) + 1);
    const monthlyQty = (list.reduce((s, o) => s + o.qtyBase, 0) / spanDays) * 30;
    compared.push({
      product, stores, cheapest, usual, monthlyQty,
      monthlySavingRub: Math.max(0, (usual.rub - cheapest.rub) * monthlyQty),
    });
  }
  compared.sort((a, b) => b.monthlySavingRub - a.monthlySavingRub);
  return { compared, single };
}

// ── Text ──────────────────────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n: number): string => (n >= 100 ? Math.round(n).toLocaleString("ru-RU") : n.toFixed(1).replace(".", ","));
const cur = (c: string): string => (c === "MDL" ? "лей" : c === "RUP" ? "руб" : c === "USD" ? "$" : c);

export function formatComparison(today = todayLocal()): string {
  const { compared, single } = compareStores(today);
  const lines = ["🏪 <b>Где дешевле</b>", "<i>Цена за кг / л / шт по последней покупке в каждом магазине, всё в рублях ПМР.</i>", ""];

  if (compared.length === 0) {
    lines.push(
      "Пока сравнивать не с чем: нужны покупки одного товара хотя бы в двух магазинах.",
      "",
      "Как набрать данные:",
      "• Шериф и магазины ПМР — присылай ссылку из QR чека;",
      "• рынок, Linella, Kaufland… — пиши одной строкой: <code>рынок помидоры 2кг 40</code>, <code>Linella молоко 2 шт 36 лей</code>.",
    );
  } else {
    let totalSaving = 0;
    for (const c of compared.slice(0, 15)) {
      const best = c.cheapest;
      const others = c.stores.slice(1).map((s) => `${esc(s.storeName)} ${r1(s.rub)}`).join(" · ");
      const diffPct = ((c.stores.at(-1)!.rub - best.rub) / c.stores.at(-1)!.rub) * 100;
      lines.push(
        `<b>${esc(c.product.name)}</b> (за ${c.product.unit}): 🏆 ${esc(best.storeName)} ${r1(best.rub)}` +
          (best.currency !== "RUP" ? ` <i>(${r1(best.native)} ${cur(best.currency)})</i>` : "") +
          ` · ${others}` + (diffPct >= 3 ? ` — до ${Math.round(diffPct)}% разница` : " — почти одинаково"),
      );
      if (c.usual.storeId !== best.storeId && c.monthlySavingRub >= 5) {
        lines.push(`   💡 обычно берёте ${esc(c.usual.where)} — ${esc(best.where)} выйдет ~${r1(c.monthlySavingRub)} руб/мес дешевле` +
          (best.trip ? " (если всё равно едете туда)" : ""));
        totalSaving += c.monthlySavingRub;
      }
    }
    if (totalSaving > 0) {
      lines.push("", `💰 <b>Если брать каждое там, где дешевле: ~${r1(totalSaving)} руб в месяц</b> (~${r1(totalSaving / (loadFinance().rubPerUsd || 16.1))} $).`);
    }
    if (compared.some((c) => c.cheapest.trip)) {
      lines.push("<i>Kaufland и METRO — отдельная поездка: выгодно, только если экономия больше дороги.</i>");
    }
  }
  if (single.length > 0) {
    lines.push("", `<i>Пока только в одном магазине: ${single.slice(0, 10).map((s) => `${esc(s.product.name)} (${esc(s.store)})`).join(", ")}${single.length > 10 ? "…" : ""}</i>`);
  }
  if (compared.some((c) => c.stores.some((s) => s.currency === "MDL"))) {
    lines.push("<i>Лей → руб ПМР по официальному кросс-курсу; в обменнике будет ~0,90 за лей, чуть хуже.</i>");
  }
  return lines.join("\n");
}

/** Short tip for a shopping-list item: where it's cheapest (if known in 2+ stores). */
export function cheapestFor(itemName: string, comparisons = compareStores().compared): string | undefined {
  const product = productOf(itemName);
  const c = product && comparisons.find((x) => x.product.id === product.id);
  return c ? c.cheapest.storeName : undefined;
}

// ── Monthly averages ──────────────────────────────────────────────────────

/** A month counts as "complete enough" with at least this many days of entries. */
const MIN_ACTIVE_DAYS = 10;

export function formatMonthlyAverages(today = todayLocal()): string {
  const entries: SpendEntry[] = collectEntries(loadReceipts(), loadExpenses());
  const months = [...new Set(entries.map((e) => e.date.slice(0, 7)))].sort();
  const current = today.slice(0, 7);
  const full = months
    .filter((m) => m !== current)
    .map((m) => ({ m, s: summarize(entries, `${m}-01`, `${m}-31`) }))
    .filter((x) => x.s.activeDays >= MIN_ACTIVE_DAYS);

  const lines = ["📈 <b>В среднем за месяц</b>", ""];
  if (full.length === 0) {
    lines.push(
      `Пока нет ни одного полностью записанного месяца (нужно хотя бы ${MIN_ACTIVE_DAYS} дней с записями).`,
      "Записывайте чеки и наличку — через месяц здесь будет средняя сумма и по категориям.",
    );
    return lines.join("\n");
  }
  const avg = full.reduce((s, x) => s + x.s.totalUsd, 0) / full.length;
  const rub = loadFinance().rubPerUsd || 16.1;
  lines.push(`По ${full.length} мес.: <b>~$${Math.round(avg)}</b> (~${Math.round(avg * rub).toLocaleString("ru-RU")} руб ПМР) в месяц`, "");

  const byCat = new Map<string, number>();
  for (const x of full) for (const c of x.s.categories) byCat.set(c.category, (byCat.get(c.category) ?? 0) + c.totalUsd);
  for (const [cat, total] of [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    lines.push(`• ${esc(cat)} — ~$${Math.round(total / full.length)}`);
  }
  lines.push("", "По месяцам:");
  for (const x of full) lines.push(`  ${monthLabel(x.m)}: $${Math.round(x.s.totalUsd)}`);
  if (full.length >= 2) {
    const last = full.at(-1)!.s.totalUsd;
    const prev = full.at(-2)!.s.totalUsd;
    const pct = Math.round(((last - prev) / prev) * 100);
    lines.push("", pct > 3 ? `↗️ Последний месяц дороже предыдущего на ${pct}%` : pct < -3 ? `↘️ Последний месяц дешевле предыдущего на ${-pct}%` : "➡️ Траты стабильны");
  }
  const budget = loadFinance().monthlyVariableBudgetUsd;
  if (budget) lines.push(`Бюджет на переменные траты: $${budget} → в среднем ${avg > budget ? "перерасход" : "в рамках"} (${Math.round((avg / budget) * 100)}%)`);
  return lines.join("\n");
}

export { STORES };
