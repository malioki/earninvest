import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";

/**
 * Portfolio tracker: target shares per cell, current values, where the next contribution
 * goes, and when and how to rebalance. Pure arithmetic over data/portfolio.json (personal,
 * not in git). Values are entered by hand from IBKR / the exchange; nothing here trades.
 */

export type Cell = { label: string; target: number; value: number };
export type Portfolio = {
  model: string;
  /** Start date (YYYY-MM-DD); the yearly review falls on its anniversary. */
  start: string;
  /** A cell more than this many percentage points off target triggers a rebalance. */
  bandPp: number;
  cells: Record<string, Cell>;
  contributions: Array<{ date: string; amount: number; split: Record<string, number>; envelopeBefore?: number; by?: string }>;
  /** Cells bought at IBKR; their part of small contributions waits in an "envelope". */
  ibkrCells: string[];
  /** Envelope + this contribution's IBKR part at or above this → send to IBKR now. */
  ibkrDirectMin: number;
  /** Money set aside for IBKR, not yet sent (held in Earn USDC). */
  envelope: number;
};

export const DATA_FILE = path.resolve(config.dataDir, "portfolio.json");

export function load(file = DATA_FILE): Portfolio {
  const p = JSON.parse(fs.readFileSync(file, "utf-8")) as Portfolio;
  p.ibkrCells ??= ["stocks", "bonds"];
  p.ibkrDirectMin ??= 250;
  p.envelope ??= 0;
  return p;
}

export function save(p: Portfolio, file = DATA_FILE): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(p, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

export const total = (p: Portfolio) => Object.values(p.cells).reduce((a, c) => a + c.value, 0);

/**
 * Split a contribution so the portfolio moves toward its targets without selling: each cell
 * gets its shortfall against the target after the contribution, in proportion; whatever is
 * left once every shortfall is met follows the targets. From an empty portfolio this is
 * exactly the target shares.
 */
export function splitContribution(p: Portfolio, amount: number): Record<string, number> {
  const after = total(p) + amount;
  const gaps = Object.fromEntries(Object.entries(p.cells).map(([k, c]) => [k, Math.max(0, after * c.target - c.value)]));
  const gapSum = Object.values(gaps).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (gapSum >= amount) {
    for (const k of Object.keys(p.cells)) out[k] = (amount * gaps[k]!) / gapSum;
  } else {
    const rest = amount - gapSum;
    for (const [k, c] of Object.entries(p.cells)) out[k] = gaps[k]! + rest * c.target;
  }
  return out;
}

export type Drift = { key: string; label: string; share: number; target: number; offPp: number };

export function drifts(p: Portfolio): Drift[] {
  const t = total(p);
  return Object.entries(p.cells).map(([key, c]) => {
    const share = t > 0 ? c.value / t : 0;
    return { key, label: c.label, share, target: c.target, offPp: (share - c.target) * 100 };
  });
}

/** Next yearly review: the start date's anniversary on or after `today`. */
export function nextReview(p: Portfolio, today: string): string {
  const [y, m, d] = p.start.split("-").map(Number) as [number, number, number];
  const todayY = Number(today.slice(0, 4));
  for (let year = Math.max(y + 1, todayY); ; year++) {
    const iso = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso >= today) return iso;
  }
}

/** Whether to rebalance now, and the trades that restore every target. */
export function rebalance(p: Portfolio, today: string) {
  const t = total(p);
  const ds = drifts(p);
  const outOfBand = ds.filter((d) => Math.abs(d.offPp) > p.bandPp);
  // The yearly review is due during the week after each anniversary of the start.
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const anniversary = nextReview(p, weekAgo);
  const yearly = p.contributions.length > 0 && anniversary <= today;
  const trades = Object.entries(p.cells).map(([key, c]) => ({ key, label: c.label, amount: t * c.target - c.value })).filter((x) => Math.abs(x.amount) >= 0.005 * t);
  return { due: outOfBand.length > 0 || yearly, reason: outOfBand.length ? `вне коридора ±${p.bandPp} п.п.: ${outOfBand.map((d) => d.label).join(", ")}` : yearly ? "годовой пересмотр" : "", trades };
}

/** The quarterly IBKR days: 15 Feb, May, Aug, Nov. The next one on or after `today`. */
export function nextQuarterDay(today: string): string {
  const y = Number(today.slice(0, 4));
  for (const year of [y, y + 1]) {
    for (const m of [2, 5, 8, 11]) {
      const iso = `${year}-${String(m).padStart(2, "0")}-15`;
      if (iso >= today) return iso;
    }
  }
  return `${y + 1}-02-15`;
}

export type InvestAdvice = {
  split: Record<string, number>;
  /** This contribution's part for IBKR cells. */
  ibkrPart: number;
  /** Envelope after adding this part. */
  pending: number;
  /** Enough to send to IBKR now (by amount or because the quarterly day has come). */
  sendNow: boolean;
  why: "amount" | "quarter" | "";
  nextQuarter: string;
};

export function investAdvice(p: Portfolio, amount: number, today: string): InvestAdvice {
  const split = splitContribution(p, amount);
  const ibkrPart = p.ibkrCells.reduce((a, k) => a + (split[k] ?? 0), 0);
  const pending = p.envelope + ibkrPart;
  const byAmount = pending >= p.ibkrDirectMin;
  // From the 15th of a quarter month to its end, an envelope that already holds money goes out;
  // a first contribution on that day just starts the envelope.
  const month = Number(today.slice(5, 7));
  const byQuarter = !byAmount && p.envelope > 0 && [2, 5, 8, 11].includes(month) && Number(today.slice(8, 10)) >= 15;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const nextQuarter = byQuarter ? today : nextQuarterDay(tomorrow);
  return { split, ibkrPart, pending, sendNow: byAmount || byQuarter, why: byAmount ? "amount" : byQuarter ? "quarter" : "", nextQuarter };
}

/** Record a contribution split by the rule; the IBKR part goes to the envelope or out with it. */
export function recordContribution(p: Portfolio, amount: number, today: string, by?: string): InvestAdvice {
  const a = investAdvice(p, amount, today);
  for (const [k, v] of Object.entries(a.split)) p.cells[k]!.value += v;
  p.contributions.push({
    date: today,
    amount,
    split: Object.fromEntries(Object.entries(a.split).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    envelopeBefore: p.envelope,
    ...(by ? { by } : {}),
  });
  p.envelope = a.sendNow ? 0 : Math.round(a.pending * 100) / 100;
  return a;
}

/**
 * Take back the last recorded contribution: its split comes off the cells and the envelope
 * returns to what it was. With `expectedCount`, only if that contribution is still the last
 * one — so an old "undo" button cannot remove a newer contribution.
 */
export function undoLast(p: Portfolio, expectedCount?: number): Portfolio["contributions"][number] | null {
  if (!p.contributions.length) return null;
  if (expectedCount !== undefined && p.contributions.length !== expectedCount) return null;
  const c = p.contributions.pop()!;
  for (const [k, v] of Object.entries(c.split)) {
    const cell = p.cells[k];
    if (cell) cell.value = Math.max(0, Math.round((cell.value - v) * 100) / 100);
  }
  if (c.envelopeBefore !== undefined) p.envelope = c.envelopeBefore;
  return c;
}
