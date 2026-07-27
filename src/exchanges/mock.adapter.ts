/**
 * Mock adapter — returns realistic demo data so the optimizer
 * and dashboard can be developed and tested without real API keys.
 */
import type { EarnProduct, HighApyProduct, Position } from "../types/index.js";
import type { IExchangeAdapter } from "./IExchangeAdapter.js";

export class MockBinanceAdapter implements IExchangeAdapter {
  readonly exchangeId = "binance";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getEarnProducts(_assets?: string[]): Promise<EarnProduct[]> {
    return [
      {
        exchange: "binance",
        productId: "BIN-USDT-FLEX-001",
        name: "USDT Flexible Savings (Bonus Tier)",
        asset: "USDT",
        tiers: [
          { minAmount: 0, maxAmount: 200, apy: 0.055 }, // 5.5% bonus tier up to $200
          { minAmount: 200, maxAmount: null, apy: 0.01 }, // 1.0% above $200
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 0.1,
      },
      {
        exchange: "binance",
        productId: "BIN-USDT-30D-001",
        name: "USDT Fixed 30-day",
        asset: "USDT",
        tiers: [
          { minAmount: 0, maxAmount: 500, apy: 0.048 },
          { minAmount: 500, maxAmount: null, apy: 0.012 },
        ],
        isFlexible: false,
        lockDays: 30,
        canSubscribe: true,
        minSubscription: 10,
      },
      // BTC high-APY product
      {
        exchange: "binance",
        productId: "BIN-BTC-FLEX-001",
        name: "BTC Earn Flexible",
        asset: "BTC",
        tiers: [
          { minAmount: 0, maxAmount: 0.5, apy: 0.08 }, // 8% up to 0.5 BTC
          { minAmount: 0.5, maxAmount: null, apy: 0.025 }, // 2.5% above
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 0.001,
      },
      // ETH high-APY product
      {
        exchange: "binance",
        productId: "BIN-ETH-FLEX-001",
        name: "ETH Earn Flexible",
        asset: "ETH",
        tiers: [
          { minAmount: 0, maxAmount: 5, apy: 0.065 }, // 6.5% up to 5 ETH
          { minAmount: 5, maxAmount: null, apy: 0.02 }, // 2% above
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 0.01,
      },
      // SOL high-APY product
      {
        exchange: "binance",
        productId: "BIN-SOL-FLEX-001",
        name: "SOL Earn Flexible",
        asset: "SOL",
        tiers: [
          { minAmount: 0, maxAmount: 100, apy: 0.095 }, // 9.5% up to 100 SOL
          { minAmount: 100, maxAmount: null, apy: 0.03 }, // 3% above
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 0.1,
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPositions(_assets?: string[]): Promise<Position[]> {
    return [
      {
        exchange: "binance",
        productId: "BIN-USDT-FLEX-001",
        productName: "USDT Flexible Savings (Bonus Tier)",
        asset: "USDT",
        amount: 180,
        estimatedDailyIncome: (180 * 0.055) / 365,
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getSpotBalances(_assets?: string[]): Promise<Map<string, number>> {
    return new Map([["USDT", 350]]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPrices(_assets: string[]): Promise<Map<string, number>> {
    return new Map([
      ["USDT", 1],
      ["BTC", 67000],
      ["ETH", 3800],
      ["SOL", 170],
      ["BNB", 680],
    ]);
  }

  async scanHighApyProducts(minApy: number): Promise<HighApyProduct[]> {
    const all = [
      {
        exchange: "binance" as const,
        productId: "BIN-ETH-FLEX",
        asset: "ETH",
        apy: 0.032,
        minAmount: 0.01,
        isFlexible: true,
      },
      {
        exchange: "binance" as const,
        productId: "BIN-SOL-FLEX",
        asset: "SOL",
        apy: 0.068,
        minAmount: 0.1,
        isFlexible: true,
      },
      {
        exchange: "binance" as const,
        productId: "BIN-BNB-FLEX",
        asset: "BNB",
        apy: 0.012,
        minAmount: 0.01,
        isFlexible: true,
      },
    ];
    return all.filter((p) => p.apy >= minApy);
  }
}

export class MockHtxAdapter implements IExchangeAdapter {
  readonly exchangeId = "htx";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getEarnProducts(_assets?: string[]): Promise<EarnProduct[]> {
    return [
      {
        exchange: "htx",
        productId: "HTX-USDT-FLEX-001",
        name: "USDT Flexible Earn (Bonus)",
        asset: "USDT",
        tiers: [
          { minAmount: 0, maxAmount: 500, apy: 0.1 }, // 10% up to $500
          { minAmount: 500, maxAmount: null, apy: 0.01 },
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 1,
      },
      {
        exchange: "htx",
        productId: "HTX-USDT-7D-001",
        name: "USDT 7-day Fixed",
        asset: "USDT",
        tiers: [
          { minAmount: 0, maxAmount: 300, apy: 0.08 },
          { minAmount: 300, maxAmount: null, apy: 0.015 },
        ],
        isFlexible: false,
        lockDays: 7,
        canSubscribe: true,
        minSubscription: 10,
      },
      // BTC high-APY product
      {
        exchange: "htx",
        productId: "HTX-BTC-FLEX-001",
        name: "BTC Earn Flexible",
        asset: "BTC",
        tiers: [
          { minAmount: 0, maxAmount: 1, apy: 0.12 }, // 12% up to 1 BTC
          { minAmount: 1, maxAmount: null, apy: 0.04 }, // 4% above
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 0.001,
      },
      // ETH high-APY product
      {
        exchange: "htx",
        productId: "HTX-ETH-FLEX-001",
        name: "ETH Earn Flexible",
        asset: "ETH",
        tiers: [
          { minAmount: 0, maxAmount: 10, apy: 0.085 }, // 8.5% up to 10 ETH
          { minAmount: 10, maxAmount: null, apy: 0.035 }, // 3.5% above
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 0.01,
      },
      // XRP high-APY product
      {
        exchange: "htx",
        productId: "HTX-XRP-FLEX-001",
        name: "XRP Earn Flexible",
        asset: "XRP",
        tiers: [
          { minAmount: 0, maxAmount: 10000, apy: 0.15 }, // 15% up to 10k XRP (~$25k)
          { minAmount: 10000, maxAmount: null, apy: 0.045 }, // 4.5% above
        ],
        isFlexible: true,
        lockDays: 0,
        canSubscribe: true,
        minSubscription: 1,
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPositions(_assets?: string[]): Promise<Position[]> {
    return [
      {
        exchange: "htx",
        productId: "HTX-USDT-FLEX-001",
        productName: "USDT Flexible Earn (Bonus)",
        asset: "USDT",
        amount: 500,
        estimatedDailyIncome: (500 * 0.1) / 365,
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getSpotBalances(_assets?: string[]): Promise<Map<string, number>> {
    return new Map([["USDT", 120]]);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getPrices(_assets: string[]): Promise<Map<string, number>> {
    return new Map([
      ["USDT", 1],
      ["BTC", 67000],
      ["ETH", 3800],
      ["XRP", 2.5],
      ["SOL", 170],
      ["BNB", 680],
      ["TRX", 0.13],
      ["AAVE", 350],
    ]);
  }

  async scanHighApyProducts(minApy: number): Promise<HighApyProduct[]> {
    const all = [
      {
        exchange: "htx" as const,
        productId: "HTX-TRX-FLEX",
        asset: "TRX",
        apy: 0.045,
        minAmount: 1,
        isFlexible: true,
      },
      {
        exchange: "htx" as const,
        productId: "HTX-AAVE-FLEX",
        asset: "AAVE",
        apy: 0.082,
        minAmount: 0.1,
        isFlexible: true,
      },
    ];
    return all.filter((p) => p.apy >= minApy);
  }
}
