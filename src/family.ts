import "dotenv/config";
import { logger } from "./utils/logger.js";
import { startWebServer } from "./web/index.js";
import { getTelegramBot } from "./telegram/index.js";
import { startFamilyScheduler } from "./scheduler/family.js";

// Family app: finances, spending tracker, shopping lists and the Telegram bot.
// No exchange is ever contacted here, so the bot is up within a second of
// start and a broken API key on some exchange can't drown the log.
// The crypto Earn optimizer is a separate process: npm run dev:earn.

function main() {
  logger.info("=== Family finance app starting ===");
  getTelegramBot();
  startWebServer();
  startFamilyScheduler();
}

try {
  main();
} catch (err) {
  logger.error("[Main] Fatal error", err);
  process.exit(1);
}
