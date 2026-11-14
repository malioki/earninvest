import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import type { Currency } from "../expenses/index.js";

// Shared building blocks of the bot UI: the bottom menu, inline-screen
// rendering, text helpers and amount parsing.

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── Access ────────────────────────────────────────────────────────────────

/** The bot is publicly reachable, so every write goes through this gate. */
export function isAllowed(userId?: number): boolean {
  if (!userId) return false;
  const allowed = config.telegram.allowedIds;
  if (allowed.length > 0) return allowed.includes(String(userId));
  return config.telegram.chatId ? String(userId) === config.telegram.chatId : false;
}

/** Debts, credits, plan and AI: TELEGRAM_FINANCE_IDS (defaults to the whole family). */
export function canSeeFinance(userId?: number): boolean {
  return !!userId && config.telegram.financeIds.includes(String(userId));
}

// ── Bottom menu ───────────────────────────────────────────────────────────
// Six entry points; everything else lives one level down in inline screens,
// so the keyboard stays small and only holds what's used every day.

export const MAIN = {
  spend: "💵 Трата",
  receipt: "🧾 Чек",
  list: "📝 Покупки",
  reports: "📊 Отчёты",
  finance: "💼 Финансы",
  help: "❓ Помощь",
} as const;

/** Labels of the previous flat keyboard — still understood until people press /start. */
export const LEGACY: Record<string, string> = {
  "📊 Сегодня": "today",
  "📅 Неделя": "week",
  "🗓 Месяц": "month",
  "📝 Список": "list",
  "↩️ Отменить": "undo",
  "💼 Долги": "debts",
  "📆 Ближайшее": "upcoming",
};

export function mainKeyboard(finance: boolean) {
  return Markup.keyboard([
    [MAIN.spend, MAIN.receipt, MAIN.list],
    finance ? [MAIN.reports, MAIN.finance, MAIN.help] : [MAIN.reports, MAIN.help],
  ])
    .resize()
    .persistent()
    .placeholder("кофе 30 · 50 такси · ссылка на чек");
}

export const keyboardFor = (ctx: Context) => mainKeyboard(canSeeFinance(ctx.from?.id));

// ── Inline screens ────────────────────────────────────────────────────────

export type Rows = InlineKeyboardButton[][];
export const btn = (text: string, data: string) => Markup.button.callback(text, data);
export const back = (to: string, label = "⬅️ Назад") => [btn(label, `m:${to}`)];

/**
 * Show a screen: edit the message the button sits on (keeps the chat tidy),
 * or send a new one when it's a fresh command or the message is too old to edit.
 */
export async function show(ctx: Context, text: string, rows: Rows = []): Promise<void> {
  const extra = { parse_mode: "HTML" as const, ...Markup.inlineKeyboard(rows) };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (err) {
      // "message is not modified" is harmless; anything else → fall back to a new message.
      if (/not modified/i.test(errMsg(err))) return;
      logger.warn("[Telegram] edit failed, sending a new message", err);
    }
  }
  await ctx.reply(text, extra);
}

// ── Amounts ───────────────────────────────────────────────────────────────

export function currencyOf(text: string): Currency | undefined {
  const t = text.toLowerCase();
  if (/лей|леи|mdl/.test(t)) return "MDL";
  if (/\$|usd|долл|бакс/.test(t)) return "USD";
  if (/€|eur|евро/.test(t)) return "EUR";
  if (/руб|rup|пмр/.test(t)) return "RUP";
  return undefined;
}

/** "7000", "7 000", "1 150$", "200 лей" → number + currency if named. */
export function parseAmount(text: string): { amount: number; currency?: Currency; rest: string } | null {
  // A number not glued to a word ("PS5" is a name, not 5), with spaces only as
  // thousands separators ("7 000", "12 000") — so "PS5 4000" is 4000, not 54000.
  const m = text.match(/(?<![\p{L}\d])(\d{1,3}(?:[  ]\d{3})+|\d+)(?:[.,]\d+)?/u);
  if (!m) return null;
  const amount = parseFloat(m[0].replace(/[  ]/g, "").replace(",", "."));
  if (!(amount > 0)) return null;
  // \b is ASCII-only in JS, so word edges are spelled out with \p{L}.
  const rest = text
    .replace(m[0], " ")
    .replace(/\$|€|(?<!\p{L})(лей|леи|mdl|usd|долл\p{L}*|бакс\p{L}*|eur|евро|руб\p{L}*|rup|пмр)(?!\p{L})/giu, " ")
    .replace(/\s+/g, " ")
    // "Петя 500 руб." leaves a stray dot behind — names don't end in punctuation.
    .replace(/^[\s.,;:!-]+|[\s.,;:!-]+$/g, "")
    .trim();
  return { amount, currency: currencyOf(text), rest };
}

export const unitOf = (currency: string): string =>
  currency === "MDL" ? "лей" : currency === "RUP" ? "руб ПМР" : currency === "USD" || currency === "USDT" ? "долларах" : currency;
