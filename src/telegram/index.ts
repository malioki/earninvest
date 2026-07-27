import { Telegraf, Markup } from "telegraf";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { fmt } from "../utils/crypto.js";
import {
  loadExpenses,
  addExpense,
  deleteExpense,
  CATEGORIES,
} from "../expenses/index.js";
import type { Currency, Preset } from "../expenses/index.js";
import type {
  OptimizationResult,
  HighApyProduct,
  VolatilePosition,
} from "../types/index.js";

let bot: Telegraf | null = null;

/** The bot is publicly reachable, so every write goes through this gate. */
function isAllowed(userId?: number): boolean {
  if (!userId) return false;
  const allowed = config.telegram.allowedIds;
  if (allowed.length > 0) return allowed.includes(String(userId));
  return config.telegram.chatId
    ? String(userId) === config.telegram.chatId
    : false;
}

function presetKeyboard(presets: Preset[]) {
  const labels = presets.map((p) => `${p.label} ${fmt(p.amount, p.amount % 1 ? 2 : 0)}`);
  const rows: string[][] = [];
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));
  rows.push(["📊 Сегодня", "↩️ Отменить"]);
  return Markup.keyboard(rows).resize();
}

/**
 * Telegram queues updates for ~24h while the bot is offline and replays them on
 * reconnect, so the expense must be dated by when the message was *sent*, not
 * when we happened to process it.
 */
export function dateOfMessage(unixSeconds?: number): {
  date: string;
  backdated: boolean;
} {
  const ms = unixSeconds ? unixSeconds * 1000 : Date.now();
  const backdated = Date.now() - ms > 5 * 60_000;
  return { date: new Date(ms).toISOString().slice(0, 10), backdated };
}

/** "кофе 30", "30 кофе", "35" — anything with a number and maybe a word. */
export function parseFreeform(
  text: string,
  presets: Preset[],
): { amount: number; category: string; currency: Currency; note?: string } | null {
  const amountMatch = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1]!.replace(",", "."));
  if (!(amount > 0)) return null;

  const rest = text.replace(amountMatch[0], " ").trim();
  const lower = rest.toLowerCase();

  let currency: Currency = "RUP";
  if (/лей|mdl/i.test(lower)) currency = "MDL";
  else if (/\$|usd|долл/i.test(lower)) currency = "USD";
  else if (/€|eur|евро/i.test(lower)) currency = "EUR";

  const words = lower.replace(/руб|лей|mdl|usd|eur|евро|долл|\$|€/gi, "").trim();

  for (const p of presets) {
    const bare = p.label.replace(/[^\p{L}]/gu, "").toLowerCase();
    if (bare && words.includes(bare.slice(0, 4))) {
      return { amount, category: p.category, currency, note: undefined };
    }
  }
  for (const c of CATEGORIES) {
    if (words && c.toLowerCase().includes(words.split(/\s+/)[0]!)) {
      return { amount, category: c, currency, note: undefined };
    }
  }
  return {
    amount,
    category: "Прочее",
    currency,
    note: words || undefined,
  };
}

function todaySummary(): string {
  const store = loadExpenses();
  const today = new Date().toISOString().slice(0, 10);
  const mine = store.expenses.filter((e) => e.date === today);
  if (mine.length === 0) return "Сегодня трат ещё не записано.";
  const total = mine.reduce((s, e) => s + e.amountUsd, 0);
  const lines = mine.map(
    (e) =>
      `• ${e.category} — ${fmt(e.amount, e.amount % 1 ? 2 : 0)} ${e.currency}` +
      (e.addedBy ? ` <i>(${e.addedBy})</i>` : ""),
  );
  return (
    `📊 <b>Сегодня</b>: ${mine.length} трат на <b>$${fmt(total, 2)}</b>\n` +
    lines.join("\n")
  );
}

export function getTelegramBot(): Telegraf | null {
  if (!config.telegram.botToken) return null;
  if (bot) return bot;

  bot = new Telegraf(config.telegram.botToken);

  bot.command("status", (ctx) => {
    ctx.reply(
      "🤖 EarnOptimizer: запущен.\n" +
        `Порт: ${config.web.port}\n` +
        `Режим: ${config.demoMode ? "DEMO" : "REAL"}\n` +
        `Твой Telegram id: ${ctx.from?.id ?? "?"}`,
    );
  });

  bot.command("id", (ctx) =>
    ctx.reply(
      `Твой Telegram id: <code>${ctx.from?.id}</code>\n` +
        `Добавь его в TELEGRAM_ALLOWED_IDS, чтобы записывать траты.`,
      { parse_mode: "HTML" },
    ),
  );

  bot.start((ctx) => {
    if (!isAllowed(ctx.from?.id)) {
      ctx.reply(
        `Привет! Записывать траты тебе пока нельзя.\n` +
          `Твой id: ${ctx.from?.id} — попроси добавить его в список разрешённых.`,
      );
      return;
    }
    ctx.reply(
      "💸 <b>Учёт наличных трат</b>\n\n" +
        "Жми кнопку — запишется сразу. Нужна другая сумма — пиши текстом:\n" +
        "<code>кофе 30</code> · <code>50 такси</code> · <code>200 лей обед</code>\n\n" +
        "Работает и когда сервер выключен: Telegram придержит нажатия до суток " +
        "и всё запишется задним числом, когда сервер включится.",
      { parse_mode: "HTML", ...presetKeyboard(loadExpenses().presets) },
    );
  });

  bot.command("today", (ctx) => {
    if (!isAllowed(ctx.from?.id)) return;
    ctx.reply(todaySummary(), { parse_mode: "HTML" });
  });

  bot.command("undo", (ctx) => {
    if (!isAllowed(ctx.from?.id)) return;
    const store = loadExpenses();
    const last = [...store.expenses].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    if (!last) {
      ctx.reply("Нечего отменять.");
      return;
    }
    deleteExpense(last.id);
    ctx.reply(
      `↩️ Удалено: ${last.category} — ${fmt(last.amount, last.amount % 1 ? 2 : 0)} ${last.currency}`,
    );
  });

  bot.on("text", (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    if (!isAllowed(ctx.from?.id)) {
      logger.info(
        `[Telegram] Ignored message from unauthorised id=${ctx.from?.id}`,
      );
      return;
    }

    if (text.startsWith("📊")) {
      ctx.reply(todaySummary(), { parse_mode: "HTML" });
      return;
    }
    if (text.startsWith("↩️")) {
      const store = loadExpenses();
      const last = [...store.expenses].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )[0];
      if (!last) {
        ctx.reply("Нечего отменять.");
        return;
      }
      deleteExpense(last.id);
      ctx.reply(
        `↩️ Удалено: ${last.category} — ${fmt(last.amount, last.amount % 1 ? 2 : 0)} ${last.currency}`,
      );
      return;
    }

    const store = loadExpenses();
    const { date, backdated } = dateOfMessage(ctx.message.date);
    const who = ctx.from?.first_name ?? String(ctx.from?.id ?? "");

    // Button press: the label carries its amount, e.g. "☕ Кофе 25".
    const preset = store.presets.find((p) => text.startsWith(p.label));
    let added;
    try {
      if (preset) {
        const amt = parseFloat(
          text.slice(preset.label.length).replace(",", ".").trim(),
        );
        added = addExpense({
          amount: Number.isFinite(amt) && amt > 0 ? amt : preset.amount,
          currency: preset.currency,
          category: preset.category,
          date,
          presetId: preset.id,
          source: "telegram",
          addedBy: who,
        });
      } else {
        const parsed = parseFreeform(text, store.presets);
        if (!parsed) {
          ctx.reply(
            "Не понял. Жми кнопку или пиши так: <code>кофе 30</code>, <code>50 такси</code>, <code>200 лей обед</code>",
            { parse_mode: "HTML" },
          );
          return;
        }
        added = addExpense({ ...parsed, date, source: "telegram", addedBy: who });
      }
    } catch (err) {
      ctx.reply(`Не записалось: ${err instanceof Error ? err.message : err}`);
      return;
    }

    ctx.reply(
      `✓ ${added.category} — <b>${fmt(added.amount, added.amount % 1 ? 2 : 0)} ${added.currency}</b> ($${fmt(added.amountUsd, 2)})` +
        (backdated ? `\n<i>записано задним числом за ${added.date}</i>` : "") +
        `\n/undo — отменить`,
      { parse_mode: "HTML", ...presetKeyboard(loadExpenses().presets) },
    );
  });

  bot
    .launch()
    .catch((err) => logger.error("[Telegram] launch failed", err));

  const gate =
    config.telegram.allowedIds.length > 0
      ? config.telegram.allowedIds.join(", ")
      : config.telegram.chatId || "никто (не задан ни ALLOWED_IDS, ни CHAT_ID)";
  logger.info(`[Telegram] Bot started. Записывать траты разрешено: ${gate}`);

  return bot;
}

export async function sendMessage(text: string): Promise<void> {
  if (!config.telegram.botToken || !config.telegram.chatId) return;
  try {
    const b = getTelegramBot()!;
    await b.telegram.sendMessage(config.telegram.chatId, text, {
      parse_mode: "HTML",
    });
  } catch (err) {
    logger.error("[Telegram] sendMessage failed", err);
  }
}

export function formatOptimizationReport(result: OptimizationResult): string {
  const lines: string[] = [];

  lines.push("📊 <b>EarnOptimizer — Отчёт</b>");
  lines.push(`🕒 ${new Date(result.timestamp).toLocaleString("ru-RU")}`);
  lines.push("");
  lines.push(`💰 <b>Весь капитал:</b> ${fmt(result.totalCapital)} USDT`);

  if (result.exchangeBalances?.length) {
    for (const eb of result.exchangeBalances) {
      const total = eb.spotBalance + eb.earnBalance;
      if (total < 0.01) continue;
      const name = eb.exchange.toUpperCase();
      lines.push(
        `  ${name}: спот ${fmt(eb.spotBalance)} | earn ${fmt(eb.earnBalance)} | итого ${fmt(total)}`,
      );
    }
  }

  lines.push(
    `📈 <b>Текущий APY:</b>  ${fmt(result.currentWeightedApy * 100, 2)}%`,
  );
  lines.push(
    `🎯 <b>Оптимальный APY:</b> ${fmt(result.optimalWeightedApy * 100, 2)}%`,
  );

  // Daily / monthly / annual earnings breakdown
  const currentAnnual = result.totalCapital * result.currentWeightedApy;
  const optimalAnnual = result.totalCapital * result.optimalWeightedApy;
  lines.push("");
  lines.push(
    `💵 <b>Текущий доход:</b> ${fmt(currentAnnual / 365, 2)}/день · ${fmt(currentAnnual / 12, 2)}/мес · ${fmt(currentAnnual, 2)}/год`,
  );
  lines.push(
    `🎯 <b>Оптимальный доход:</b> ${fmt(optimalAnnual / 365, 2)}/день · ${fmt(optimalAnnual / 12, 2)}/мес · ${fmt(optimalAnnual, 2)}/год`,
  );

  if (result.estimatedAnnualGain > 0.01) {
    lines.push(
      `📈 <b>Прибавка:</b> +${fmt(result.estimatedAnnualGain / 365, 2)}/день · +${fmt(result.estimatedAnnualGain / 12, 2)}/мес · +${fmt(result.estimatedAnnualGain, 2)}/год`,
    );
  }

  if (result.actions.length > 0) {
    lines.push("");
    lines.push("📋 <b>Нужные действия:</b>");
    for (const a of result.actions) {
      const icon =
        a.type === "WITHDRAW" ? "⬇️" : a.type === "SEND" ? "↔️" : "⬆️";
      lines.push(`${icon} ${a.note}`);
    }
  } else {
    lines.push("");
    lines.push("✅ Балансировка не требуется");
  }

  // Warn about idle funds on spot
  const idleSpot = (result.exchangeBalances ?? [])
    .filter((eb) => eb.spotBalance >= 1)
    .map((eb) => `${eb.exchange.toUpperCase()}: ${fmt(eb.spotBalance)} USDT`);
  if (idleSpot.length) {
    lines.push("");
    lines.push(`⚠️ <b>Свободные USDT на споте:</b> ${idleSpot.join(", ")}`);
    lines.push("    Они не приносят доход — переведите в Earn!");
  }

  // Strategy comparison
  if (result.strategies?.length > 0) {
    lines.push("");
    lines.push("📋 <b>Стратегии:</b>");
    for (const s of result.strategies) {
      lines.push(
        `  ${s.name}: <b>${fmt(s.weightedApy * 100, 2)}%</b> APY · ${fmt(s.dailyEarn, 2)}/день · ${fmt(s.monthlyEarn, 2)}/мес · риск: ${s.riskLevel}`,
      );
    }
  }

  // Volatile candidates summary
  if (result.volatileCandidates?.length > 0) {
    lines.push("");
    lines.push(
      `🎲 <b>Volatile Earn кандидаты:</b> ${result.volatileCandidates.length} монет`,
    );
    if (result.volatileCapital > 0) {
      lines.push(
        `  Бюджет: ${fmt(result.volatileCapital)} USDT (${fmt((result.volatileCapital / result.totalCapital) * 100, 1)}% портфеля)`,
      );
    }
    for (const vc of result.volatileCandidates.slice(0, 5)) {
      const daily = vc.dailyApy * 100;
      lines.push(
        `  ${vc.asset}: APY <b>${fmt(vc.apy * 100, 1)}%</b> (${fmt(daily, 3)}%/день) · безубыток за ${fmt(vc.daysToBreakeven, 1)} дн · риск ${vc.riskScore}/100`,
      );
    }
    if (result.volatileCandidates.length > 5) {
      lines.push(
        `  ... и ещё ${result.volatileCandidates.length - 5} кандидатов`,
      );
    }
  }

  lines.push("");
  lines.push("🔍 Детали: http://localhost:" + config.web.port);

  return lines.join("\n");
}

export function formatHighApyReport(
  products: HighApyProduct[],
  minApy: number,
): string {
  const lines: string[] = [];
  const pct = (minApy * 100).toFixed(0);

  lines.push(`🔥 <b>Earn-продукты с APY ≥ ${pct}%</b>`);
  lines.push(`Найдено: ${products.length}`);
  lines.push("");

  // Group by exchange
  const byExchange = new Map<string, HighApyProduct[]>();
  for (const p of products) {
    const list = byExchange.get(p.exchange) ?? [];
    list.push(p);
    byExchange.set(p.exchange, list);
  }

  for (const [exchange, prods] of byExchange) {
    lines.push(`<b>${exchange.toUpperCase()}</b> (${prods.length}):`);
    // Show top 15 per exchange
    for (const p of prods.slice(0, 15)) {
      const tag = p.isFlexible ? "flex" : "lock";
      lines.push(
        `  ${p.asset}: <b>${fmt(p.apy * 100, 2)}%</b> [${tag}] min ${fmt(p.minAmount)}`,
      );
    }
    if (prods.length > 15) {
      lines.push(`  ... и ещё ${prods.length - 15}`);
    }
    lines.push("");
  }

  lines.push("🔍 Детали: http://localhost:" + config.web.port);
  return lines.join("\n");
}

export function formatVolatileAlert(
  pos: VolatilePosition,
  currentPrice: number,
): string {
  const priceDrop = ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
  const lines: string[] = [];
  lines.push(`🚨 <b>STOP-LOSS: ${pos.asset}</b>`);
  lines.push(
    `Цена: ${fmt(currentPrice, 4)} USDT (−${fmt(priceDrop, 2)}% от входа ${fmt(pos.entryPrice, 4)})`,
  );
  lines.push(
    `Сумма: ${fmt(pos.amountCoins, 4)} ${pos.asset} (~${fmt(pos.amountUsd)} USDT)`,
  );
  lines.push(
    `Биржа: ${pos.exchange.toUpperCase()} · APY: ${fmt(pos.apy * 100, 1)}%`,
  );
  lines.push(`⚠️ Рекомендация: выйти из Earn и продать ${pos.asset}`);
  return lines.join("\n");
}
