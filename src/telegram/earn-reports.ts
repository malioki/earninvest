import { config } from "../config/index.js";
import { fmt } from "../utils/crypto.js";
import type {
  OptimizationResult,
  HighApyProduct,
  VolatilePosition,
} from "../types/index.js";

// Telegram texts for the crypto Earn optimizer. They only build strings;
// sending goes through ./send.ts so the Earn process never polls the bot.
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
  lines.push("🔍 Детали: " + config.earn.url);

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

  lines.push("🔍 Детали: " + config.earn.url);
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
