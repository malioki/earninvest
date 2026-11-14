import cron from "node-cron";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { loadState, saveState } from "../state/index.js";
import { optimize } from "../optimizer/index.js";
import { sendMessage } from "../telegram/send.js";
import {
  formatOptimizationReport,
  formatHighApyReport,
  formatVolatileAlert,
} from "../telegram/earn-reports.js";
import type { IExchangeAdapter } from "../exchanges/IExchangeAdapter.js";

export function startEarnScheduler(adapters: IExchangeAdapter[]): {
  runCheck: () => Promise<void>;
} {
  const stablecoins = config.optimizer.stablecoinAssets;

  // ── Check & optimize ─────────────────────────────────────────────────────
  const runCheck = async () => {
    logger.info("[Scheduler] Starting optimization run");
    try {
      // ── Fetch products for stablecoins + major coins for broader distribution ──
      const assetsForProducts = [
        ...new Set([...stablecoins, ...config.majorCoins]),
      ];

      const [productsArrays, positionsArrays, balanceMaps] = await Promise.all([
        Promise.all(adapters.map((a) => a.getEarnProducts(assetsForProducts))),
        Promise.all(adapters.map((a) => a.getPositions(stablecoins))),
        Promise.all(
          adapters.map((a) =>
            a
              .getSpotBalances(stablecoins)
              .then(
                (bals) => [a.exchangeId, bals] as [string, Map<string, number>],
              ),
          ),
        ),
      ]);

      const allProducts = productsArrays.flat();
      const allPositions = positionsArrays.flat();

      // Flatten per-exchange balances into exchangeId → total stablecoin balance
      const spotBalances = new Map<string, number>();
      for (const [exchangeId, bals] of balanceMaps) {
        let total = 0;
        for (const [, amount] of bals) total += amount;
        spotBalances.set(exchangeId, total);
      }

      // ── High-APY scan across all coins ──────────────────────────────────
      // Delay to avoid HTX rate limits (429) after optimization calls
      await new Promise((r) => setTimeout(r, 3_000));

      const minApy = config.optimizer.highApyThreshold;
      const highApyArrays = await Promise.all(
        adapters.map((a) => a.scanHighApyProducts(minApy)),
      );
      const highApyProducts = highApyArrays
        .flat()
        .sort((a, b) => b.apy - a.apy);

      // Fetch prices for volatile candidate analysis
      let allPrices = new Map<string, number>();
      if (config.volatile.enabled && highApyProducts.length > 0) {
        const volatileAssets = [
          ...new Set(highApyProducts.map((p) => p.asset.toUpperCase())),
        ];
        try {
          const priceMaps = await Promise.all(
            adapters.map((a) => a.getPrices(volatileAssets)),
          );
          // Merge — prefer first non-zero price
          for (const pm of priceMaps) {
            for (const [asset, price] of pm) {
              if (price > 0 && !allPrices.has(asset)) {
                allPrices.set(asset, price);
              }
            }
          }
        } catch (err) {
          logger.error("[Scheduler] Price fetch failed", err);
        }
      }

      const result = optimize(
        allProducts,
        allPositions,
        spotBalances,
        highApyProducts,
        allPrices,
      );

      const state = loadState();
      state.lastOptimization = result;
      state.lastUpdated = new Date().toISOString();

      const prevCount = state.highApyProducts?.length ?? 0;
      state.highApyProducts = highApyProducts;
      saveState(state);

      logger.info(
        `[Scheduler] Done. APY: ${(result.currentWeightedApy * 100).toFixed(2)}% → ${(result.optimalWeightedApy * 100).toFixed(2)}% | ` +
          `Actions: ${result.actions.length} | Stablecoins: ${stablecoins.join(",")} | ` +
          `Volatile candidates: ${result.volatileCandidates.length}`,
      );

      // Log per-exchange balances
      for (const eb of result.exchangeBalances) {
        const total = eb.spotBalance + eb.earnBalance;
        if (total > 0.01) {
          logger.info(
            `[Scheduler]   ${eb.exchange.toUpperCase()}: spot=${eb.spotBalance.toFixed(2)} earn=${eb.earnBalance.toFixed(2)} total=${total.toFixed(2)}`,
          );
        }
      }

      // Notify if idle funds on spot or profitable rebalance exists
      const idleSpot = result.exchangeBalances.reduce(
        (s, eb) => s + eb.spotBalance,
        0,
      );
      const shouldNotify =
        (result.estimatedAnnualGain >= config.optimizer.notifyThresholdUsd &&
          result.actions.length > 0) ||
        idleSpot >= config.optimizer.minRebalanceAmount;

      if (shouldNotify) {
        await sendMessage(formatOptimizationReport(result));
      }

      // Notify about new high-APY products
      if (highApyProducts.length > 0 && highApyProducts.length !== prevCount) {
        await sendMessage(formatHighApyReport(highApyProducts, minApy));
      }
    } catch (err) {
      logger.error("[Scheduler] Run failed", err);
    }
  };

  // ── Price monitor for volatile positions ────────────────────────────────
  const runPriceCheck = async () => {
    const state = loadState();
    const active = state.volatilePositions.filter((p) => p.status === "active");
    if (active.length === 0) return;

    const assets = [...new Set(active.map((p) => p.asset))];
    try {
      const priceMaps = await Promise.all(
        adapters.map((a) => a.getPrices(assets)),
      );
      const prices = new Map<string, number>();
      for (const pm of priceMaps) {
        for (const [asset, price] of pm) {
          if (price > 0 && !prices.has(asset)) prices.set(asset, price);
        }
      }

      let stateChanged = false;
      for (const pos of active) {
        const currentPrice = prices.get(pos.asset);
        if (!currentPrice) continue;
        pos.currentPrice = currentPrice;

        if (currentPrice <= pos.stopLossPrice) {
          pos.status = "stop-loss-triggered";
          stateChanged = true;
          logger.info(
            `[PriceMonitor] STOP-LOSS triggered for ${pos.asset}: ${currentPrice} <= ${pos.stopLossPrice}`,
          );
          await sendMessage(formatVolatileAlert(pos, currentPrice));
        }
      }

      if (stateChanged) saveState(state);
    } catch (err) {
      logger.error("[PriceMonitor] Check failed", err);
    }
  };

  // ── Daily report ─────────────────────────────────────────────────────────
  const runDailyReport = async () => {
    const state = loadState();
    if (!state.lastOptimization) return;
    await sendMessage(formatOptimizationReport(state.lastOptimization));
  };

  cron.schedule(config.scheduler.checkCron, runCheck);
  cron.schedule(config.scheduler.reportCron, runDailyReport);

  if (config.volatile.enabled) {
    cron.schedule(config.volatile.priceCheckCron, runPriceCheck);
    logger.info(
      `[Scheduler] Volatile price monitor: "${config.volatile.priceCheckCron}"`,
    );
  }

  logger.info(
    `[Scheduler] Check: "${config.scheduler.checkCron}", Report: "${config.scheduler.reportCron}" | Stablecoins: ${stablecoins.join(",")}`,
  );

  // Run immediately on startup
  runCheck();

  return { runCheck };
}
