import "dotenv/config";

export const config = {
  demoMode: process.env.DEMO_MODE === "true",

  binance: {
    apiKey: process.env.BINANCE_API_KEY ?? "",
    apiSecret: process.env.BINANCE_API_SECRET ?? "",
    baseUrl: "https://api.binance.com",
  },

  htx: {
    apiKey: process.env.HTX_API_KEY ?? "",
    apiSecret: process.env.HTX_API_SECRET ?? "",
    accountId: process.env.HTX_ACCOUNT_ID ?? "",
    baseUrl: "https://api.huobi.pro",
  },

  bybit: {
    apiKey: process.env.BYBIT_API_KEY ?? "",
    apiSecret: process.env.BYBIT_API_SECRET ?? "",
    baseUrl: "https://api.bybit.com",
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    /**
     * Telegram user ids allowed to log expenses. Anyone else is ignored — the
     * bot is reachable by whoever finds it, so this list is the only gate.
     * Empty list falls back to chatId alone.
     */
    allowedIds: (process.env.TELEGRAM_ALLOWED_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /**
     * Who sees debts and the payment calendar, and gets the family digests and
     * payment reminders. Defaults to everyone in ALLOWED_IDS (the family);
     * set TELEGRAM_FINANCE_IDS to narrow it.
     */
    financeIds: (process.env.TELEGRAM_FINANCE_IDS ?? process.env.TELEGRAM_ALLOWED_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    /** Always get the weekly data/ backup, besides whoever sent /backup. */
    backupIds: (process.env.TELEGRAM_BACKUP_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  scheduler: {
    checkCron: process.env.CHECK_CRON ?? "0 */6 * * *",
    reportCron: process.env.REPORT_CRON ?? "0 9 * * *",
    /** Spending digest for the week that just ended (Mon–Sun). Monday 09:10. */
    weeklySpendingCron: process.env.WEEKLY_SPENDING_CRON ?? "10 9 * * 1",
    /** Last month vs. budget. The 1st, 09:15. */
    monthlySpendingCron: process.env.MONTHLY_SPENDING_CRON ?? "15 9 1 * *",
    /** Evening reminder about tomorrow's credit payments. 19:00 daily. */
    paymentReminderCron: process.env.PAYMENT_REMINDER_CRON ?? "0 19 * * *",
    /** Official FX rates (BNM, PRB) → finance.json. 10:30 daily. */
    ratesCron: process.env.RATES_CRON ?? "30 10 * * *",
    /** Portfolio reminders (15th, quarterly transfer, yearly review). Checked daily at 10:00. */
    portfolioReminderCron: process.env.PORTFOLIO_REMINDER_CRON ?? "0 10 * * *",
    /** data/ zipped to /backup subscribers. Sunday 21:00. */
    backupCron: process.env.BACKUP_CRON ?? "0 21 * * 0",
  },

  optimizer: {
    targetAsset: "USDT",
    /** Stablecoins to scan for earn products (comma-separated via env) */
    stablecoinAssets: (process.env.STABLECOIN_ASSETS ?? "USDT,USDC,FDUSD,USD1")
      .split(",")
      .map((s) => s.trim().toUpperCase()),
    minRebalanceAmount: Number(process.env.MIN_REBALANCE_AMOUNT ?? 20),
    /** Only notify when annual gain from rebalancing exceeds this (USD) */
    notifyThresholdUsd: 5,
    /** Min APY (decimal) to include in the high-APY scan report */
    highApyThreshold: Number(process.env.HIGH_APY_THRESHOLD ?? 0.035),
    /** Active strategy: 'greedy' = all in best, 'diversified' = spread across top-N */
    activeStrategy: (process.env.STRATEGY ?? "diversified") as
      | "greedy"
      | "diversified",
    /** Diversification settings */
    diversification: {
      /** Min number of different products to allocate to */
      minProducts: Number(process.env.DIV_MIN_PRODUCTS ?? 4),
      /** Max % of total capital in a single product */
      maxPerProductPct: Number(process.env.DIV_MAX_PER_PRODUCT ?? 0.4),
      /** Max % of total capital on a single exchange */
      maxPerExchangePct: Number(process.env.DIV_MAX_PER_EXCHANGE ?? 0.6),
      /** Prefer tier distribution: allocate first N slots fully, then next tier */
      preferTierDistribution: true,
    },
  },

  /** Volatile coin earn strategy settings */
  volatile: {
    enabled: process.env.VOLATILE_EARN_ENABLED !== "false",
    /** Max % of total portfolio allocated to volatile coins */
    maxPortfolioPct: Number(process.env.VOLATILE_MAX_PCT ?? 0.1),
    /** Stop-loss threshold — exit if price drops below entry by this % */
    stopLossPct: Number(process.env.VOLATILE_STOP_LOSS ?? 0.005),
    /** Min APY for a volatile coin to qualify */
    minApy: Number(process.env.VOLATILE_MIN_APY ?? 0.1),
    /** Max % of portfolio per single volatile coin */
    maxPerCoinPct: Number(process.env.VOLATILE_MAX_PER_COIN ?? 0.03),
    /** Cron for price monitoring (default: every 15 min) */
    priceCheckCron: process.env.PRICE_CHECK_CRON ?? "*/15 * * * *",
  },

  /** Major coins considered low-risk for moderate strategy */
  majorCoins: (
    process.env.MAJOR_COINS ?? "BTC,ETH,BNB,SOL,XRP,ADA,DOT,AVAX,LINK,MATIC"
  )
    .split(",")
    .map((s) => s.trim().toUpperCase()),

  /** Family app: finances, spending, shopping lists, Telegram bot. */
  web: {
    port: Number(process.env.PORT ?? 3000),
    /** Where the family pages live — the Earn dashboard links back here. */
    url: process.env.FAMILY_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  },

  /**
   * Crypto Earn optimizer — a separate process with its own dashboard.
   * Defaults to the family port + 1 so the two never collide (PORT=3001 in
   * .env would otherwise put both on 3001).
   */
  earn: {
    port: Number(process.env.EARN_PORT ?? Number(process.env.PORT ?? 3000) + 1),
    url:
      process.env.EARN_URL ??
      `http://localhost:${process.env.EARN_PORT ?? Number(process.env.PORT ?? 3000) + 1}`,
  },

  dataDir: "./data",
};
