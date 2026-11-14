import "dotenv/config";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { startEarnWebServer } from "./web/earn.js";
import { startEarnScheduler } from "./scheduler/earn.js";
import type { IExchangeAdapter } from "./exchanges/IExchangeAdapter.js";

// Crypto Earn optimizer: exchange adapters, rebalancing scheduler, its own
// dashboard on EARN_PORT. Notifications go out send-only; the Telegram bot
// itself (polling) belongs to the family app — see src/family.ts.

// ── Adapter selection ─────────────────────────────────────────────────────
async function createAdapters(): Promise<IExchangeAdapter[]> {
  if (config.demoMode) {
    logger.info("[Main] Running in DEMO mode — using mock adapters");
    const { MockBinanceAdapter, MockHtxAdapter } =
      await import("./exchanges/mock.adapter.js");
    return [new MockBinanceAdapter(), new MockHtxAdapter()];
  }

  logger.info("[Main] Running in REAL mode — using live API adapters");
  const { BinanceAdapter } = await import("./exchanges/binance.adapter.js");
  const { HtxAdapter } = await import("./exchanges/htx.adapter.js");
  const { BybitAdapter } = await import("./exchanges/bybit.adapter.js");
  const adapters: IExchangeAdapter[] = [new BinanceAdapter(), new HtxAdapter()];
  if (config.bybit.apiKey) {
    adapters.push(new BybitAdapter());
    logger.info("[Main] Bybit adapter enabled (API key found)");
  } else {
    // Still add Bybit for public endpoints (earn products, prices)
    adapters.push(new BybitAdapter());
    logger.info(
      "[Main] Bybit adapter enabled (no API key — public endpoints only)",
    );
  }
  return adapters;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
async function main() {
  logger.info("=== Earn optimizer starting ===");

  const adapters = await createAdapters();

  // Start background scheduler (also runs once immediately)
  const { runCheck } = startEarnScheduler(adapters);

  // Start web dashboard with refresh callback
  startEarnWebServer(runCheck);
}

main().catch((err) => {
  logger.error("[Main] Fatal error", err);
  process.exit(1);
});
