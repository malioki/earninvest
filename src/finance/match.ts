// "учёба первое полугодие 1663" typed as a spend is really a bill payment, and
// "штраф жены 900 лей" closes a debt. Recorded as cash, they inflate the spending
// report and the bill/debt still shows as open. This finds the obligation a
// spend's text names, so the bot can offer to move it where it belongs.

import type { FinanceData } from "./index.js";
import { billOpen } from "./bills.js";
import { perUsd, remainingNative } from "./actions.js";
import { todayLocal } from "../spending/index.js";

export interface ObligationMatch {
  kind: "bill" | "debt";
  id: string;
  name: string;
  currency: string;
}

// Words that say nothing about *which* obligation: "оплата за учёбу" is about учёба.
const NOISE = ["опла", "плат", "долг", "отда", "верн", "перв", "втор", "меся", "полуг", "для", "это"];

function words(text: string): string[] {
  return (text.toLowerCase().replace(/ё/g, "е").match(/\p{L}{3,}/gu) ?? [])
    .filter((w) => !NOISE.some((n) => w.startsWith(n)));
}

/**
 * Same word up to an inflected ending: "учебу" ~ "учеба", "дану" ~ "дан",
 * "жены" ~ "жена" — but "колбаса" is not "коля" (endings differ by too much).
 */
function sameWord(a: string, b: string): boolean {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p >= Math.max(3, Math.min(a.length, b.length) - 1) && Math.abs(a.length - b.length) <= 2;
}

function overlaps(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => sameWord(x, y)));
}

export function matchObligations(fin: FinanceData, text: string, today = todayLocal()): ObligationMatch[] {
  const said = words(text);
  if (said.length === 0) return [];
  const out: ObligationMatch[] = [];
  for (const b of fin.bills ?? []) {
    if (billOpen(fin, b, today) && overlaps(said, words(b.name))) {
      out.push({ kind: "bill", id: b.id, name: b.name, currency: b.currency });
    }
  }
  for (const d of fin.personalDebts) {
    if (d.id && d.amountUsd > 0 && overlaps(said, words(d.name))) {
      out.push({ kind: "debt", id: d.id, name: d.name, currency: d.currency });
    }
  }
  return out.slice(0, 2);
}

/** A spend amount in the obligation's own currency. */
export function inCurrency(fin: FinanceData, amount: number, from: string, to: string): number {
  if (from === to) return amount;
  return Math.round((amount / perUsd(fin, from)) * perUsd(fin, to) * 100) / 100;
}

/** Pay the whole debt (null) when the spend covers what's left, else a part. */
export function debtPayAmount(fin: FinanceData, debtId: string, amount: number): number | null {
  const d = fin.personalDebts.find((x) => x.id === debtId);
  if (!d) return amount;
  return amount >= remainingNative(d) - 0.01 ? null : amount;
}
