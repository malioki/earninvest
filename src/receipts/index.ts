import fs from "fs";
import path from "path";
import axios from "axios";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { loadFinance } from "../finance/index.js";

const RECEIPTS_FILE = path.join(config.dataDir, "receipts.json");

/** Fiscal receipt portals we know how to parse: ПМР (APB OFD) and Moldova (SFS MEV). */
const ALLOWED_HOSTS = new Set(["ofd.apb.online", "mev.sfs.md"]);

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

// Each rule lists Russian (Sheriff, ПМР) then Romanian (Linella, Kaufland — the
// Moldovan tax portal prints names as the till does: "BARILLA Paste fainoase").
// Romanian diacritics are often dropped on receipts, hence [aă], [sș], [tț].
// `\b` is ASCII-only, so word edges use (?<!\p{L}) / (?!\p{L}) with the u flag.
const RULES: Rule[] = [
  // — household, checked first: these often contain food-ish words —
  { re: /табл\.|finish|порошок|кондиционер д бел|отбелив|гель д(ля)? посуд|fairy|средство|detergent|gel (de|pentru) (sp[aă]lat|vase)|gel vase|ma[sș]in[aă] (de )?vase|cl[aă]titor|[iî]n[aă]lbitor|domestos|persil|ariel|lenor|frosch/iu, group: "household", category: "Бытовая химия" },
  { re: /пакет.*мус|мешк.*мус|saci (de )?men/iu, group: "household", category: "Хозтовары" },
  { re: /^пакет|пакет\d|(?<!\p{L})pung[aăi]/iu, group: "household", category: "Пакеты" },
  { re: /пергамент|фольга|плёнк|пленк|конт\.|контейнер|щетка|щётка|губк|салфетк.*убор|тряпк|корз\.|корзин|н-р |набор|burete|folie|h[aâ]rtie de copt|pelicul|prosop|lavet|microfibr|(?<!\p{L})bateri/iu, group: "household", category: "Хозтовары" },
  { re: /палочки ват|ват.*диск|шампун|мыло|зубн|прокладк|подгуз|памперс|бритв|дезодор|крем д|s[aă]pun|[sș]ampon|past[aă] de din|h[aâîi]rtie (igienic|wc)|[sș]erve[tț]e|scutec|pampers|huggies|absorbant|deodorant|lo[tț]iune|elastic p[aă]r/iu, group: "household", category: "Гигиена" },
  { re: /корм|whiskas|felix|kitekat|pedigree|lechat|наполнит|hran[aă] (pentru|pisic|c[aâ]ini)|club4paws/iu, group: "other", category: "Животные" },

  // — food —
  // Sheriff receipts abbreviate: "Печ." печенье, "Сыр.пр." плавленый сыр, "Верм.б п" вермишель
  // быстрого приготовления.
  // Baby formula before dairy: "NAN 1 Amestec lactat" is not milk for the table.
  { re: /amestec lactat|(?<!\p{L})nan \d|nutrilon|humana|hipp|детск.{0,6}смес|piure pentru copii/iu, group: "food", category: "Детское питание" },
  // Sauces before vegetables: "Sos de maion cu usturoi" is mayo, not garlic.
  { re: /(?<!\p{L})sos(?!\p{L})|maion|ketchup|pesto|соус|кетчуп|майонез/iu, group: "food", category: "Бакалея" },
  { re: /^мор\.|мороженое|пломбир|эским|[iî]nghe[tț]at/iu, group: "food", category: "Мороженое" },
  // "кола" must start a word: "шоКОЛАд" contains it, and chocolate is not a drink.
  { re: /^нап\.|сок |вода |лимонад|(?<![а-яё])кола|пепси|квас|морс|чай |кофе|(?<!\p{L})suc(?!\p{L})|(?<!\p{L})ap[aă] (mineral|plat)|cafea|(?<!\p{L})ceai|coca.?cola|pepsi|fanta|sprite/iu, group: "food", category: "Напитки" },
  { re: /пиво|вино|водк|коньяк|шампанск|(?<!\p{L})bere(?!\p{L})|(?<!\p{L})vin (ro[sș]u|alb|roz)|vodc[aă]|coniac/iu, group: "food", category: "Алкоголь" },
  { re: /молоко|кефир|йогурт|сметана|творог|(?<![а-яё])сыр(ок|ки)?(?![а-яё])|спред|масло.*сл\.|сл\.масло|ряженк|сливк|lapte|chefir|iaurt|sm[aâ]nt[aâ]n|br[aâ]nz|ca[sș]caval|(?<!\p{L})unt(?!\p{L})|fri[sș]c/iu, group: "food", category: "Молочка" },
  // "KINDER Oua de cioc." is chocolate, not eggs.
  { re: /яйцо|яйца|(?<!\p{L})ou[aă](?!\p{L})(?!.{0,8}cioc)/iu, group: "food", category: "Яйца" },
  { re: /бмк|бекон|ветчин|колбас|сосиск|курин.*филе|свинин|говядин|фарш|мясо|окорок|грудк|карбонад|carne|toc[aă]tur|cipolat|parizer|salam|crenvur|c[aâ]rna[tț]|[sș]unc[aă]|(?<!\p{L})pui(?!\p{L})|g[aă]in[aă]|(?<!\p{L})porc|(?<!\p{L})vit[aă](?!\p{L})|mititei|pateu/iu, group: "food", category: "Мясо" },
  { re: /рыба|селёдк|селедк|скумбр|лосос|форел|креветк|кальмар|консерв.*рыб|pe[sș]te|hering|scrumbi|somon|(?<!\p{L})ton(?!\p{L})|creve[tț]|calmar/iu, group: "food", category: "Рыба" },
  { re: /томат(ы|(?![а-яё-]))|морков|огурц|картоф|лук |капуст|перец|кабач|баклаж|свекл|зелень|укроп|петрушк|щавел|чеснок|салат|яблок|банан|апельсин|груш|виноград|арбуз|дын|ягод|клубник|фрукт|овощ|шампиньон|гриб|(?<!\p{L})mere(?!\p{L})|(?<!\p{L})pere(?!\p{L})|struguri|banan|ro[sș]ii|castrave|cartof|morcov|ceap[aă]|varz[aă]|ardei|vinete|dovlec|usturoi|m[aă]rar|p[aă]trunjel|ciuperc|champignon|l[aă]m[aâ]i|portocal|mandarin|piersic|prune|caise|pepene|fructe|legume|maz[aă]re|porumb(?! pr[aă]jit)|salat[aă]/iu, group: "food", category: "Овощи и фрукты" },
  { re: /хлеб|батон|булк|лаваш|багет|тхк |p[aâ]ine|franzel|lava[sș]|chifl/iu, group: "food", category: "Хлеб" },
  { re: /круп|рис |гречк|макарон|верм\.|вермишел|лапш|мука|овсян|перлов|манк|горох|фасол|чечевиц|paste f[aă]inoase|spaghet|fusilli|penne|capellini|t[aă]i[tț]ei|(?<!\p{L})orez|hri[sș]c|(?<!\p{L})linte|f[aă]in[aă](?!\p{L})|fulgi de ov[aă]z|gri[sș](?!\p{L})|fasole/iu, group: "food", category: "Крупы и макароны" },
  { re: /конфет|шоколад|шок\.|печен|печ\.|пряник|торт|пирожн|вафл|зефир|мармелад|халв|сахар|варень|джем|ciocolat|cioc\.|kinder|bomboan|biscui[tț]|napolitan|pr[aă]jitur|zah[aă]r|(?<!\p{L})gem(?!\p{L})|dulcea[tț]|jeleu/iu, group: "food", category: "Сладости" },
  { re: /чипсы|сухарик|кириешк|снеки|попкорн|орешк|арахис|семечк|chips|semin[tț]e|porumb pr[aă]jit|popcorn|alune|arahide|(?<!\p{L})nuci(?!\p{L})|covrigei/iu, group: "food", category: "Снеки" },
  { re: /томат-паст|соус|кетчуп|майонез|уксус|соль|специ|приправ|лавров|смесь д|дрожж|разрыхл|ванил|масло подсолн|масло раст|консерв|(?<!\p{L})sos(?!\p{L})|ketchup|maion|mu[sș]tar|o[tț]et|(?<!\p{L})sare(?!\p{L})|condiment|(?<!\p{L})ulei|past[aă] de tomate|corni[sș]on|murat|conserv|pesto|drojdie|vanil/iu, group: "food", category: "Бакалея" },
];

export function categorise(name: string): { group: ItemGroup; category: string } {
  for (const r of RULES) {
    if (r.re.test(name)) return { group: r.group, category: r.category };
  }
  return { group: "other", category: "Не разобрано" };
}

/** The shop can decide: a pharmacy's lines are medicine and care, whatever their names say. */
export function categoriseIn(name: string, merchant: string): { group: ItemGroup; category: string } {
  if (/farmaci|аптек/i.test(merchant)) return { group: "household", category: "Аптека" };
  return categorise(name);
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

// ── Moldova: mev.sfs.md receipt verifier ──────────────────────────────────

/** Legal entity on the receipt → the shop people know. */
const MD_BRANDS: [RegExp, string][] = [
  [/moldretail/i, "Linella"],
  [/kaufland/i, "Kaufland"],
  [/metro cash/i, "METRO"],
];

/**
 * The verifier is a Livewire page: the receipt arrives server-rendered as JSON
 * in the component's wire:initial-data — the till's lines as printed:
 *   "MOLDRETAIL GROUP S.R.L.", "COD FISCAL: …", "<address>", …,
 *   ["BANANE, Ecuador, kg", "1.144 x 32.99"], ["", "37.74 A"],   ← item, then its total
 *   ["TOTAL", "1595.96"], ["DATA 10.10.2026", "ORA 13:57:49"], ["BON FISCAL", "№: 0228"]
 * Some tills skip the per-item total line; then it's qty × price.
 */
export function parseSfsReceipt(html: string, url: string): Omit<Receipt, "totalUsd" | "addedAt"> {
  const attr = html.match(/wire:initial-data="([^"]*receipt\.index-component[^"]*)"/)?.[1];
  if (!attr) throw new Error("Страница проверки чека изменилась — не нашёл данные чека");
  const data = JSON.parse(decodeEntities(attr))?.serverMemo?.data;
  const lines: (string | string[])[] | undefined = data?.receipt;
  if (!data?.receiptStatus || !Array.isArray(lines) || lines.length === 0) {
    throw new Error("Налоговая не нашла этот чек — проверь ссылку");
  }

  // Double-width print comes through as a caret before every letter: ^S^.^A^. → S.A.
  const header = lines
    .filter((l): l is string => typeof l === "string" && !/^`+$/.test(l))
    .map((l) => l.replace(/\^/g, ""));
  const legal = header[0]?.trim() ?? "Магазин";
  const address = header.find((l) => /^(or\.|mun\.|s\.|str\.)/i.test(l.trim()))?.trim();

  const items: ReceiptItem[] = [];
  let total = 0;
  let date = "";
  let time: string | undefined;
  let inItems = true;
  for (const l of lines) {
    if (!Array.isArray(l)) continue;
    const [a = "", b = ""] = l.map((x) => String(x).replace(/\^/g, "").trim());
    if (/^TOTAL$/i.test(a)) { total = num(b); inItems = false; continue; }
    const d = a.match(/DATA\s+(\d{2})\.(\d{2})\.(\d{4})/i);
    if (d) { date = `${d[3]}-${d[2]}-${d[1]}`; time = b.match(/\d{2}:\d{2}:\d{2}/)?.[0]; continue; }
    if (!inItems) continue;
    const qp = b.match(/^(-?\d+(?:\.\d+)?)\s*x\s*(-?\d+(?:\.\d+)?)/i);
    if (a && qp) {
      const qty = num(qp[1]!);
      const unitPrice = num(qp[2]!);
      items.push({ name: a, qty, unitPrice, total: Math.round(qty * unitPrice * 100) / 100, ...categorise(a) });
    } else if (!a && items.length > 0 && /^-?\d+(?:\.\d+)?/.test(b)) {
      items[items.length - 1]!.total = num(b);   // the till's own line total
    } else if (a && items.length > 0 && /^-\d/.test(b)) {
      items[items.length - 1]!.total += num(b);  // a discount line
    }
  }
  if (!date) throw new Error("В чеке нет даты — формат изменился?");

  // Name the shop, not the company: "Linella (MOLDRETAIL GROUP S.R.L.)".
  const brand = MD_BRANDS.find(([re]) => re.test(legal))?.[1]
    ?? (items.some((i) => /casa europeana/i.test(i.name)) ? "Casa Europeana" : undefined);
  const merchant = brand ? `${brand} (${legal})` : legal;

  for (const i of items) Object.assign(i, categoriseIn(i.name, merchant));

  let itemSum = items.reduce((s, i) => s + i.total, 0);
  if (!(total > 0)) total = itemSum;
  // A loyalty-card discount can come off the TOTAL with no line of its own
  // (Casa Europeana: 1 470.50 of goods, TOTAL 1 398.85). Spread it over the
  // lines so categories add up to what was actually paid.
  if (itemSum > total && itemSum - total <= itemSum * 0.2) {
    const k = total / itemSum;
    for (const i of items) i.total = Math.round(i.total * k * 100) / 100;
    itemSum = items.reduce((s, i) => s + i.total, 0);
  }
  const code = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  return {
    id: `sfs-${code}`,
    url,
    merchant,
    address,
    date,
    time,
    currency: "MDL",
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
  if (currency === "EUR") return 1 / (fin.usdPerEur || 1.13);
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

  const base = parsed.hostname === "mev.sfs.md" ? parseSfsReceipt(res.data, url) : parseReceiptHtml(res.data, url);
  if (base.items.length === 0) {
    throw new Error("В чеке не найдено ни одной позиции — формат изменился?");
  }

  const receipt: Receipt = {
    ...base,
    totalUsd: base.total / rateFor(base.currency),
    addedAt: new Date().toISOString(),
  };
  return { receipt, duplicate: upsertReceipt(receipt) };
}

/** A receipt read from a photo (Moldovan chains): confirmed by a human before this is called. */
export interface PhotoReceiptInput {
  store: string;
  address?: string | null;
  date: string;
  time?: string | null;
  currency: string;
  total: number;
  items: { name: string; qty: number; total: number }[];
}

export function saveReceiptFromPhoto(input: PhotoReceiptInput): { receipt: Receipt; duplicate: boolean } {
  const items: ReceiptItem[] = input.items.map((i) => ({
    name: i.name,
    qty: i.qty,
    unitPrice: i.qty ? Math.round((i.total / i.qty) * 100) / 100 : i.total,
    total: i.total,
    ...categoriseIn(i.name, input.store),
  }));
  const itemSum = items.reduce((s, i) => s + i.total, 0);
  const slug = input.store.toLowerCase().replace(/[^\p{L}\d]+/gu, "-");
  const receipt: Receipt = {
    // Same shop + time + total = same receipt, so a re-sent photo updates instead of duplicating.
    id: `photo-${slug}-${input.date}-${input.time ?? ""}-${Math.round(input.total * 100)}`,
    url: "photo",
    merchant: input.store,
    address: input.address ?? undefined,
    date: input.date,
    time: input.time ?? undefined,
    currency: input.currency,
    total: input.total,
    totalUsd: input.total / rateFor(input.currency),
    items,
    mismatch: Math.abs(itemSum - input.total) > 0.05,
    addedAt: new Date().toISOString(),
  };
  return { receipt, duplicate: upsertReceipt(receipt) };
}

/** Insert or replace by id, keeping any categories a human corrected. Returns true if it existed. */
function upsertReceipt(receipt: Receipt): boolean {
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
  return duplicate;
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
