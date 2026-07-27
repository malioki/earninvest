import fs from "fs";
import path from "path";
import axios from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { loadFinance } from "../finance/index.js";

const RECEIPTS_FILE = path.join(config.dataDir, "receipts.json");

/** Fiscal receipt portals we know how to parse. */
const ALLOWED_HOSTS = new Set(["ofd.apb.online"]);

export type ItemGroup = "food" | "household" | "other";

export interface ReceiptItem {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  group: ItemGroup;
  category: string;
  /** Set when a human corrected the auto-assigned category. */
  manual?: boolean;
}

export interface Receipt {
  id: string;
  url: string;
  merchant: string;
  address?: string;
  /** YYYY-MM-DD */
  date: string;
  time?: string;
  currency: string;
  total: number;
  totalUsd: number;
  items: ReceiptItem[];
  /** Item sum disagrees with the total declared in the URL. */
  mismatch?: boolean;
  addedAt: string;
}

export interface ReceiptsData {
  receipts: Receipt[];
}

// ── Categorisation ────────────────────────────────────────────────────────
// Rules are ordered: the first match wins, so put specific patterns above
// generic ones ("масло сл." is dairy, plain "масло" is pantry oil).

interface Rule {
  re: RegExp;
  group: ItemGroup;
  category: string;
}

const RULES: Rule[] = [
  // — household, checked first: these often contain food-ish words —
  { re: /табл\.|finish|порошок|кондиционер д бел|отбелив|гель д(ля)? посуд|fairy|средство/i, group: "household", category: "Бытовая химия" },
  { re: /пакет.*мус|мешк.*мус/i, group: "household", category: "Хозтовары" },
  { re: /^пакет|пакет\d/i, group: "household", category: "Пакеты" },
  { re: /пергамент|фольга|плёнк|пленк|конт\.|контейнер|щетка|щётка|губк|салфетк.*убор|тряпк/i, group: "household", category: "Хозтовары" },
  { re: /палочки ват|ват.*диск|шампун|мыло|зубн|прокладк|подгуз|памперс|бритв|дезодор|крем д/i, group: "household", category: "Гигиена" },

  // — food —
  { re: /^мор\.|мороженое|пломбир|эским/i, group: "food", category: "Мороженое" },
  { re: /^нап\.|сок |вода |лимонад|кола|пепси|квас|морс|чай |кофе/i, group: "food", category: "Напитки" },
  { re: /пиво|вино|водк|коньяк|шампанск/i, group: "food", category: "Алкоголь" },
  { re: /молоко|кефир|йогурт|сметана|творог|^сыр |сыр |спред|масло.*сл\.|сл\.масло|ряженк|сливк/i, group: "food", category: "Молочка" },
  { re: /яйцо|яйца/i, group: "food", category: "Яйца" },
  { re: /бмк|бекон|ветчин|колбас|сосиск|курин.*филе|свинин|говядин|фарш|мясо|окорок|грудк|карбонад/i, group: "food", category: "Мясо" },
  { re: /рыба|селёдк|селедк|скумбр|лосос|форел|креветк|кальмар|консерв.*рыб/i, group: "food", category: "Рыба" },
  { re: /томат(ы|\b)|морков|огурц|картоф|лук |капуст|перец|кабач|баклаж|свекл|зелень|укроп|петрушк|щавел|чеснок|салат|яблок|банан|апельсин|груш|виноград|арбуз|дын|ягод|клубник|фрукт|овощ/i, group: "food", category: "Овощи и фрукты" },
  { re: /хлеб|батон|булк|лаваш|багет|тхк /i, group: "food", category: "Хлеб" },
  { re: /круп|рис |гречк|макарон|мука|овсян|перлов|манк|горох|фасол|чечевиц/i, group: "food", category: "Крупы и макароны" },
  { re: /конфет|шоколад|печен|торт|пирожн|вафл|зефир|мармелад|халв|сахар|варень|джем/i, group: "food", category: "Сладости" },
  { re: /томат-паст|соус|кетчуп|майонез|уксус|соль|специ|приправ|масло подсолн|масло раст|консерв/i, group: "food", category: "Бакалея" },
];

export function categorise(name: string): { group: ItemGroup; category: string } {
  for (const r of RULES) {
    if (r.re.test(name)) return { group: r.group, category: r.category };
  }
  return { group: "other", category: "Не разобрано" };
}

// ── Parsing ───────────────────────────────────────────────────────────────

function num(raw: string): number {
  return parseFloat(raw.replace(/\s/g, "").replace(",", ".")) || 0;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#171;|&laquo;/g, "«")
    .replace(/&#187;|&raquo;/g, "»")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function spanValues(block: string, cls: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`receipt-value-${cls}[^>]*>([\\s\\S]*?)</span>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(textOf(m[1]!));
  return out;
}

/**
 * Parse an APB fiscal receipt page.
 *
 * The markup gives every line three numbered spans: 1030 = name (prefixed with
 * its position on the receipt), 1023 = quantity, 1079 = unit price, 1043 = line
 * total. Numbers use a comma as the decimal separator.
 */
export function parseReceiptHtml(
  html: string,
  url: string,
): Omit<Receipt, "totalUsd" | "addedAt"> {
  const body = html.replace(
    /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,
    "",
  );

  const params = new URL(url).searchParams;
  const fiscalCode = params.get("fiscal_code") ?? "";
  const tsRaw = params.get("timestamp") ?? "";
  const declaredTotal = Number(params.get("amount") ?? 0) / 100;

  // "26.07.2026 16:12:08"
  const tsMatch = tsRaw.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2}:\d{2}:\d{2})?/);
  const date = tsMatch
    ? `${tsMatch[3]}-${tsMatch[2]}-${tsMatch[1]}`
    : new Date().toISOString().slice(0, 10);
  const time = tsMatch?.[4];

  const subtitle = body.match(
    /class="receipt-subtitle"[^>]*>([\s\S]*?)<\/span>/i,
  );
  const merchant = subtitle ? textOf(subtitle[1]!) : "Неизвестный магазин";

  const addrMatch = body.match(
    /receipt-company-name[\s\S]{0,600}?text-align: center;"[^>]*>([\s\S]*?)<\/div>/i,
  );
  const address = addrMatch ? textOf(addrMatch[1]!) : undefined;

  const blocks = body.split(/<div class="item">/).slice(1);
  const items: ReceiptItem[] = [];
  for (const b of blocks) {
    const names = spanValues(b, "1030");
    if (names.length === 0) continue;
    const name = names[0]!.replace(/^\d+\s+/, "").trim();
    if (!name) continue;
    const qty = num(spanValues(b, "1023")[0] ?? "0");
    const unitPrice = num(spanValues(b, "1079")[0] ?? "0");
    const total = num(spanValues(b, "1043")[0] ?? "0");
    items.push({ name, qty, unitPrice, total, ...categorise(name) });
  }

  const itemSum = items.reduce((s, i) => s + i.total, 0);
  const total = declaredTotal > 0 ? declaredTotal : itemSum;

  return {
    id: `${fiscalCode}-${date}-${time ?? ""}`,
    url,
    merchant,
    address,
    date,
    time,
    // The APB portal serves Transnistrian receipts, priced in PMR roubles.
    currency: "RUP",
    total,
    items,
    mismatch: Math.abs(itemSum - total) > 0.05,
  };
}

// ── Fetch + store ─────────────────────────────────────────────────────────

function rateFor(currency: string): number {
  const fin = loadFinance();
  if (currency === "MDL") return fin.mdlPerUsd || 17.82;
  if (currency === "USD") return 1;
  return fin.rubPerUsd || 16.3;
}

export function loadReceipts(): ReceiptsData {
  try {
    if (!fs.existsSync(RECEIPTS_FILE)) return { receipts: [] };
    return JSON.parse(fs.readFileSync(RECEIPTS_FILE, "utf-8")) as ReceiptsData;
  } catch (err) {
    logger.error("[Receipts] Failed to load", err);
    return { receipts: [] };
  }
}

export function saveReceipts(data: ReceiptsData): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.error("[Receipts] Failed to save", err);
  }
}

export async function addReceiptFromUrl(
  url: string,
): Promise<{ receipt: Receipt; duplicate: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Не похоже на ссылку");
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Умею разбирать только: ${[...ALLOWED_HOSTS].join(", ")}. Пришёл ${parsed.hostname}`,
    );
  }

  const res = await axios.get<string>(url, {
    timeout: 15_000,
    responseType: "text",
    headers: { "User-Agent": "Mozilla/5.0 EarnOptimizer" },
  });

  const base = parseReceiptHtml(res.data, url);
  if (base.items.length === 0) {
    throw new Error("В чеке не найдено ни одной позиции — формат изменился?");
  }

  const receipt: Receipt = {
    ...base,
    totalUsd: base.total / rateFor(base.currency),
    addedAt: new Date().toISOString(),
  };

  const store = loadReceipts();
  const idx = store.receipts.findIndex((r) => r.id === receipt.id);
  const duplicate = idx >= 0;
  if (duplicate) {
    // Keep any manual category corrections the user already made.
    const old = store.receipts[idx]!;
    for (const item of receipt.items) {
      const prev = old.items.find((o) => o.name === item.name && o.manual);
      if (prev) {
        item.group = prev.group;
        item.category = prev.category;
        item.manual = true;
      }
    }
    store.receipts[idx] = receipt;
  } else {
    store.receipts.push(receipt);
  }
  store.receipts.sort((a, b) => b.date.localeCompare(a.date));
  saveReceipts(store);

  return { receipt, duplicate };
}

// ── Aggregation ───────────────────────────────────────────────────────────

export interface CategoryStat {
  category: string;
  group: ItemGroup;
  totalUsd: number;
  share: number;
  itemCount: number;
}

export interface MonthStat {
  month: string;
  totalUsd: number;
  foodUsd: number;
  householdUsd: number;
  otherUsd: number;
  receiptCount: number;
}

export interface ReceiptStats {
  receiptCount: number;
  itemCount: number;
  totalUsd: number;
  foodUsd: number;
  householdUsd: number;
  otherUsd: number;
  avgReceiptUsd: number;
  months: MonthStat[];
  categories: CategoryStat[];
  foodCategories: CategoryStat[];
  topItems: { name: string; totalUsd: number; count: number }[];
  uncategorised: { name: string; totalUsd: number }[];
  firstDate: string | null;
  lastDate: string | null;
}

export function computeReceiptStats(data: ReceiptsData): ReceiptStats {
  const receipts = data.receipts;
  const rate = (r: Receipt): number =>
    r.total > 0 ? r.totalUsd / r.total : 1 / 16.3;

  let totalUsd = 0;
  let foodUsd = 0;
  let householdUsd = 0;
  let otherUsd = 0;
  let itemCount = 0;

  const byCategory = new Map<string, CategoryStat>();
  const byMonth = new Map<string, MonthStat>();
  const byItem = new Map<string, { totalUsd: number; count: number }>();
  const unknown = new Map<string, number>();

  for (const r of receipts) {
    const k = rate(r);
    const month = r.date.slice(0, 7);
    const m = byMonth.get(month) ?? {
      month,
      totalUsd: 0,
      foodUsd: 0,
      householdUsd: 0,
      otherUsd: 0,
      receiptCount: 0,
    };
    m.receiptCount++;

    for (const item of r.items) {
      const usd = item.total * k;
      itemCount++;
      totalUsd += usd;
      m.totalUsd += usd;
      if (item.group === "food") {
        foodUsd += usd;
        m.foodUsd += usd;
      } else if (item.group === "household") {
        householdUsd += usd;
        m.householdUsd += usd;
      } else {
        otherUsd += usd;
        m.otherUsd += usd;
        unknown.set(item.name, (unknown.get(item.name) ?? 0) + usd);
      }

      const c = byCategory.get(item.category) ?? {
        category: item.category,
        group: item.group,
        totalUsd: 0,
        share: 0,
        itemCount: 0,
      };
      c.totalUsd += usd;
      c.itemCount++;
      byCategory.set(item.category, c);

      const it = byItem.get(item.name) ?? { totalUsd: 0, count: 0 };
      it.totalUsd += usd;
      it.count++;
      byItem.set(item.name, it);
    }
    byMonth.set(month, m);
  }

  const categories = [...byCategory.values()]
    .map((c) => ({ ...c, share: totalUsd > 0 ? c.totalUsd / totalUsd : 0 }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const foodCategories = categories
    .filter((c) => c.group === "food")
    .map((c) => ({ ...c, share: foodUsd > 0 ? c.totalUsd / foodUsd : 0 }))
    .sort((a, b) => b.totalUsd - a.totalUsd);

  const dates = receipts.map((r) => r.date).sort();

  return {
    receiptCount: receipts.length,
    itemCount,
    totalUsd,
    foodUsd,
    householdUsd,
    otherUsd,
    avgReceiptUsd: receipts.length > 0 ? totalUsd / receipts.length : 0,
    months: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    categories,
    foodCategories,
    topItems: [...byItem.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.totalUsd - a.totalUsd)
      .slice(0, 15),
    uncategorised: [...unknown.entries()]
      .map(([name, totalUsd]) => ({ name, totalUsd }))
      .sort((a, b) => b.totalUsd - a.totalUsd),
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}
