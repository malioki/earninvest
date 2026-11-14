import axios from "axios";
import { loadFinance, saveFinance } from "./index.js";
import type { FinanceData } from "./index.js";
import { logger } from "../utils/logger.js";
import { todayLocal } from "../spending/index.js";

// Official daily rates: BNM (Moldova) for MDL, PRB (Transnistria) for the ПМР
// rouble. Banks sell a little off these (MAIB bought USD at 17.37 when BNM
// said ~17.8), but for valuing debts the official rate is the honest yardstick.

export interface Rates {
  /** MDL per 1 USD / EUR — BNM. */
  mdlPerUsd?: number;
  mdlPerEur?: number;
  /** ПМР roubles per 1 USD / MDL — PRB. */
  rubPerUsd?: number;
  rubPerMdl?: number;
}

const ddmmyyyy = (d: string): string => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

/** Exported for tests. */
export function parseBnm(xml: string): Pick<Rates, "mdlPerUsd" | "mdlPerEur"> {
  const value = (code: string): number | undefined => {
    const m = xml.match(new RegExp(`<CharCode>${code}</CharCode>[\\s\\S]*?<Nominal>(\\d+)</Nominal>[\\s\\S]*?<Value>([\\d.]+)</Value>`));
    return m ? Number(m[2]) / Number(m[1]) : undefined;
  };
  return { mdlPerUsd: value("USD"), mdlPerEur: value("EUR") };
}

/** Exported for tests. PRB publishes an HTML table: <h12>USD</h12> … <h12>16.1000</h12>. */
export function parsePrb(html: string): Pick<Rates, "rubPerUsd" | "rubPerMdl"> {
  const value = (code: string): number | undefined => {
    const m = html.match(new RegExp(`<h12[^>]*>${code}</h12>\\s*</td>\\s*<td[^>]*>\\s*<h12[^>]*>([\\d.]+)</h12>`));
    return m ? Number(m[1]) : undefined;
  };
  return { rubPerUsd: value("USD"), rubPerMdl: value("MDL") };
}

async function fetchText(url: string): Promise<string> {
  const res = await axios.get<string>(url, { timeout: 15_000, responseType: "text" });
  return res.data;
}

export async function fetchRates(day = todayLocal()): Promise<Rates> {
  const [bnm, prb] = await Promise.allSettled([
    fetchText(`https://www.bnm.md/en/official_exchange_rates?get_xml=1&date=${ddmmyyyy(day)}`).then(parseBnm),
    fetchText("https://www.cbpmr.net/kursval.php").then(parsePrb),
  ]);
  if (bnm.status === "rejected") logger.warn("[Rates] BNM unavailable", bnm.reason);
  if (prb.status === "rejected") logger.warn("[Rates] PRB unavailable", prb.reason);
  return {
    ...(bnm.status === "fulfilled" ? bnm.value : {}),
    ...(prb.status === "fulfilled" ? prb.value : {}),
  };
}

const sane = (v: number | undefined, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > lo && v < hi;

/**
 * Writes fresh rates into finance.json and re-derives every amountUsd that
 * depends on them (lei/rouble/euro debts) — previously a manual chore that
 * was easy to forget. Rates outside a plausible band are ignored.
 */
export function applyRates(fin: FinanceData, r: Rates, source: string): string[] {
  const changed: string[] = [];
  if (sane(r.mdlPerUsd, 10, 40)) {
    fin.mdlPerUsd = Math.round(r.mdlPerUsd * 10000) / 10000;
    changed.push(`USD ${fin.mdlPerUsd} лей`);
    if (sane(r.mdlPerEur, 10, 45)) {
      fin.usdPerEur = Math.round((r.mdlPerEur / r.mdlPerUsd) * 10000) / 10000;
      changed.push(`EUR ${r.mdlPerEur.toFixed(4)} лей`);
    }
  }
  if (sane(r.rubPerUsd, 5, 40)) {
    fin.rubPerUsd = r.rubPerUsd;
    changed.push(`USD ${r.rubPerUsd} руб ПМР`);
  }
  if (changed.length === 0) return changed;

  for (const d of fin.personalDebts) {
    if (d.currency === "USD" || d.currency === "USDT") continue;
    const per = d.currency === "MDL" ? fin.mdlPerUsd : d.currency === "RUP" ? fin.rubPerUsd : d.currency === "EUR" && fin.usdPerEur ? 1 / fin.usdPerEur : undefined;
    if (per) d.amountUsd = Math.round((d.originalAmount / per) * 100) / 100;
  }
  // Local "YYYY-MM-DD HH:MM", so "updated today?" compares on the family's calendar.
  const now = new Date();
  fin.ratesUpdatedAt = `${todayLocal()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  fin.ratesSource = source;
  return changed;
}

export async function updateRates(): Promise<string[]> {
  const r = await fetchRates();
  const fin = loadFinance();
  const changed = applyRates(fin, r, "BNM + PRB (официальные)");
  if (changed.length > 0) {
    saveFinance(fin);
    logger.info(`[Rates] Updated: ${changed.join(", ")}`);
  }
  return changed;
}

/** At startup: refresh only if the last update wasn't today. */
export async function updateRatesIfStale(): Promise<void> {
  const last = loadFinance().ratesUpdatedAt?.slice(0, 10);
  if (last === todayLocal()) return;
  try {
    await updateRates();
  } catch (err) {
    logger.warn("[Rates] Update failed", err);
  }
}
