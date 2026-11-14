// Stores the family shops at, and the products worth comparing between them.
// Chains name the same thing differently ("МОЛОКО 2,5% 0,9Л" at Шериф,
// "Lapte 2,5% 1L" at Linella), so items are mapped to a common product and
// compared per kilogram / litre / piece, never per package.

export type Side = "pmr" | "md";

export interface Store {
  id: string;
  name: string;
  /** What the store prices in by default. */
  currency: "RUP" | "MDL";
  side: Side;
  /** Matches receipt merchant names and the first word of a manual entry. */
  match: RegExp;
  /** Needs a separate trip (Chișinău hypermarkets) — savings must beat the trip. */
  trip?: boolean;
  /** "в Шерифе", "на рынке" — for sentences. */
  where: string;
}

export const STORES: Store[] = [
  { id: "sheriff", name: "Шериф", currency: "RUP", side: "pmr", match: /шериф|sheriff/i, where: "в Шерифе" },
  { id: "market", name: "Рынок", currency: "RUP", side: "pmr", match: /^(рынок|рынке|базар|piata|piața)/i, where: "на рынке" },
  { id: "linella", name: "Linella", currency: "MDL", side: "md", match: /linella|линелл?а/i, where: "в Linella" },
  { id: "casa", name: "Casa Europeana", currency: "MDL", side: "md", match: /casa|каса/i, where: "в Casa Europeana" },
  { id: "local", name: "Local", currency: "MDL", side: "md", match: /^(local|локал)/i, where: "в Local" },
  { id: "kaufland", name: "Kaufland", currency: "MDL", side: "md", match: /kaufland|кауфл[ая]нд/i, trip: true, where: "в Kaufland" },
  { id: "metro", name: "METRO", currency: "MDL", side: "md", match: /^(metro|метро)/i, trip: true, where: "в METRO" },
];

export function storeById(id: string): Store | undefined {
  return STORES.find((s) => s.id === id);
}

/** A receipt's merchant ("Шериф-28") → known store, or an ad-hoc one named after it. */
export function storeOfMerchant(merchant: string): Store {
  const known = STORES.find((s) => s.match.test(merchant));
  if (known) return known;
  const name = merchant.replace(/["«»]/g, "").trim() || "Магазин";
  return { id: `m:${name.toLowerCase()}`, name, currency: "RUP", side: "pmr", match: /$^/, where: `в «${name}»` };
}

/** "рынок помидоры 2кг 40" → the store and what's left. */
export function storePrefix(text: string): { store: Store; rest: string } | null {
  const [first, ...rest] = text.trim().split(/\s+/);
  if (!first) return null;
  const store = STORES.find((s) => s.match.test(first));
  // "Casa Europeana ..." — swallow the second word of a two-word name too.
  if (store?.id === "casa" && /^europ/i.test(rest[0] ?? "")) rest.shift();
  return store ? { store, rest: rest.join(" ") } : null;
}

// ── Products ──────────────────────────────────────────────────────────────

export type BaseUnit = "кг" | "л" | "шт" | "10 шт";

export interface Product {
  id: string;
  name: string;
  unit: BaseUnit;
  /** Russian, Romanian and receipt-abbreviation spellings. Order matters: first match wins. */
  match: RegExp;
}

/**
 * The everyday basket. Specific patterns above generic ones. Whole-word
 * checks use (?<!\p{L}) / (?!\p{L}) because \b is ASCII-only in JS and never
 * fires inside Cyrillic.
 */
export const PRODUCTS: Product[] = [
  { id: "eggs", name: "Яйца", unit: "10 шт", match: /яйц|(?<!\p{L})ou[aă](?!\p{L})(?!.{0,8}cioc)/iu },
  { id: "kefir", name: "Кефир", unit: "л", match: /кефир|chefir/iu },
  { id: "smetana", name: "Сметана", unit: "кг", match: /сметан|sm[aâ]nt[aâ]n/iu },
  { id: "tvorog", name: "Творог", unit: "кг", match: /творог|br[aâ]nz[aă] de vaci/iu },
  { id: "butter", name: "Масло сливочное", unit: "кг", match: /масло.{0,6}сл|сл\.?\s*масло|(?<!\p{L})unt(?!\p{L})/iu },
  { id: "milk", name: "Молоко", unit: "л", match: /молоко|^мол\.|lapte/iu },
  { id: "cheese", name: "Сыр твёрдый", unit: "кг", match: /(?<!\p{L})сыр(?!\p{L})|ca[sș]caval/iu },
  { id: "chicken-fillet", name: "Куриное филе", unit: "кг", match: /кур.{0,10}филе|филе.{0,6}кур|(piept|file) de pui/iu },
  { id: "chicken", name: "Курица (тушка, окорочка)", unit: "кг", match: /окороч|тушка|цыпл|курин|курица|(?<!\p{L})pui(?!\p{L})/iu },
  { id: "pork", name: "Свинина", unit: "кг", match: /свинин|(?<!\p{L})porc/iu },
  { id: "beef", name: "Говядина", unit: "кг", match: /говядин|(?<!\p{L})vit[aă](?!\p{L})/iu },
  { id: "mince", name: "Фарш", unit: "кг", match: /фарш|carne tocat/iu },
  { id: "sausage", name: "Колбаса", unit: "кг", match: /колбас|(?<!\p{L})salam/iu },
  { id: "wieners", name: "Сосиски", unit: "кг", match: /сосиск|crenvur/iu },
  { id: "potato", name: "Картофель", unit: "кг", match: /картоф|картошк|cartof/iu },
  { id: "onion", name: "Лук", unit: "кг", match: /(?<!\p{L})лук(?!\p{L})|(?<!\p{L})ceap[aă]/iu },
  { id: "carrot", name: "Морковь", unit: "кг", match: /морков|morcov/iu },
  { id: "tomato", name: "Помидоры", unit: "кг", match: /помидор|томат(?!.{0,4}паст)|(?<!mere )ro[sș]ii/iu },
  { id: "cucumber", name: "Огурцы", unit: "кг", match: /огур|castrave/iu },
  { id: "cabbage", name: "Капуста", unit: "кг", match: /капуст|(?<!\p{L})varz[aă]/iu },
  { id: "apple", name: "Яблоки", unit: "кг", match: /яблок|(?<!\p{L})mere(?!\p{L})/iu },
  { id: "banana", name: "Бананы", unit: "кг", match: /банан|banan/iu },
  { id: "bread", name: "Хлеб", unit: "шт", match: /хлеб|батон|p[aâ]ine/iu },
  { id: "buckwheat", name: "Гречка", unit: "кг", match: /греч|hri[sș]c/iu },
  { id: "rice", name: "Рис", unit: "кг", match: /(?<!\p{L})рис(?!\p{L})|(?<!\p{L})orez/iu },
  { id: "pasta", name: "Макароны", unit: "кг", match: /макарон|спагет|paste f[aă]inoase|spaghet/iu },
  { id: "flour", name: "Мука", unit: "кг", match: /(?<!\p{L})мука|(?<!\p{L})f[aă]in[aă]/iu },
  { id: "sugar", name: "Сахар", unit: "кг", match: /сахар(?!.{0,3}пудр)|zah[aă]r/iu },
  { id: "oil", name: "Масло подсолнечное", unit: "л", match: /масло.{0,8}(подс|раст)|(?<!\p{L})ulei(?!.{0,12}(olive|m[aă]slin))/iu },
  { id: "diapers", name: "Подгузники", unit: "шт", match: /подгуз|памперс|pampers|scutec|huggies/iu },
  { id: "toilet-paper", name: "Туалетная бумага", unit: "шт", match: /туал.{0,6}бум|h[aâ]rtie igienic/iu },
  { id: "dishwasher-tabs", name: "Таблетки для ПММ", unit: "шт", match: /табл.{0,15}(finish|пмм|посуд)|finish(?!.{0,12}\d+\s*ml)/iu },
  { id: "laundry", name: "Стиральный порошок", unit: "кг", match: /порошок|detergent(?! ?caps)/iu },
];

/** Package size from a product name: "0,9Л", "900Г", "10ШТ", "1.5 kg", "50шт". */
export function packSize(name: string): { value: number; unit: "кг" | "л" | "шт" } | null {
  const m = name.match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|г|гр|g|л|l|мл|ml|шт|buc|pcs)(?![\p{L}])/iu);
  if (!m) return null;
  const v = parseFloat(m[1]!.replace(",", "."));
  const u = m[2]!.toLowerCase();
  if (!(v > 0)) return null;
  if (u === "кг" || u === "kg") return { value: v, unit: "кг" };
  if (u === "г" || u === "гр" || u === "g") return { value: v / 1000, unit: "кг" };
  if (u === "л" || u === "l") return { value: v, unit: "л" };
  if (u === "мл" || u === "ml") return { value: v / 1000, unit: "л" };
  return { value: v, unit: "шт" };
}

export function productOf(name: string): Product | undefined {
  return PRODUCTS.find((p) => p.match.test(name));
}
