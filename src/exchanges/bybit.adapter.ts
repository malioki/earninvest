/**
 * Bybit REST adapter — Earn (Flexible Saving) endpoints.
 *
 * V5 API docs:
 *   Products (public): GET /v5/earn/product
 *   Positions (auth):  GET /v5/earn/position
 *   Balances (auth):   GET /v5/asset/transfer/query-account-coins-balance
 *   Tickers (public):  GET /v5/market/tickers
 *
 * Auth: headers X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-SIGN, X-BAPI-RECV-WINDOW
 * Signature: HMAC-SHA256(timestamp + apiKey + recvWindow + queryString)  (GET)
 */
import axios from "axios";
import { config } from "../config/index.js";
import {
  isStablecoin,
  type EarnProduct,
  type EarnTier,
  type HighApyProduct,
  type Position,
} from "../types/index.js";
import type { IExchangeAdapter } from "./IExchangeAdapter.js";
import { hmacSha256 } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";

const RECV_WINDOW = "5000";

export class BybitAdapter implements IExchangeAdapter {
  readonly exchangeId = "bybit";
  private readonly base = config.bybit.baseUrl;

  // ── Auth helpers ────────────────────────────────────────────────────────
  private signGet(queryString: string): {
    headers: Record<string, string>;
    qs: string;
  } {
    const ts = Date.now().toString();
    const pre = ts + config.bybit.apiKey + RECV_WINDOW + queryString;
    const sig = hmacSha256(config.bybit.apiSecret, pre);
    return {
      headers: {
        "X-BAPI-API-KEY": config.bybit.apiKey,
        "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-SIGN": sig,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      },
      qs: queryString,
    };
  }

  private get hasKeys(): boolean {
    return !!(config.bybit.apiKey && config.bybit.apiSecret);
  }

  // ── Public helpers ──────────────────────────────────────────────────────
  private buildQuery(params: Record<string, string | number>): string {
    return Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
  }

  // ── getEarnProducts ─────────────────────────────────────────────────────
  async getEarnProducts(assets?: string[]): Promise<EarnProduct[]> {
    const targetAssets = assets ?? ["USDT"];
    const allProducts: EarnProduct[] = [];

    for (const coin of targetAssets) {
      try {
        const qs = this.buildQuery({
          coin: coin.toUpperCase(),
          category: "FlexibleSaving",
        });
        const res = await axios.get(`${this.base}/v5/earn/product?${qs}`, {
          timeout: 10_000,
        });

        if (res.data?.retCode !== 0) {
          logger.warn(
            `[Bybit] getEarnProducts(${coin}): retCode=${res.data?.retCode} msg=${res.data?.retMsg}`,
          );
          continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: any[] = res.data?.result?.list ?? [];
        logger.info(
          `[Bybit] getEarnProducts(${coin}): ${list.length} products`,
        );

        for (const p of list) {
          if (p.status !== "Available") continue;

          const tiers: EarnTier[] = [];

          if (p.hasTieredApr && Array.isArray(p.tierAprDetails)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const t of p.tierAprDetails as any[]) {
              const minAmt = parseFloat(t.min ?? "0");
              const maxRaw = t.max ?? "-1";
              const maxAmt = maxRaw === "-1" ? null : parseFloat(maxRaw);
              const aprStr: string = t.estimateApr ?? "0";
              const apy = parseFloat(aprStr.replace("%", "")) / 100;
              tiers.push({ minAmount: minAmt, maxAmount: maxAmt, apy });
            }
          }

          // Fallback: single tier from top-level estimateApr
          if (tiers.length === 0) {
            const aprStr: string = p.estimateApr ?? "0";
            const apy = parseFloat(aprStr.replace("%", "")) / 100;
            tiers.push({ minAmount: 0, maxAmount: null, apy });
          }

          // Sort tiers by minAmount
          tiers.sort((a, b) => a.minAmount - b.minAmount);

          allProducts.push({
            exchange: "bybit",
            productId: `bybit-flex-${coin.toUpperCase()}-${p.productId}`,
            name: `Bybit Flex ${coin.toUpperCase()}`,
            asset: coin.toUpperCase(),
            tiers,
            isFlexible: true,
            lockDays: 0,
            canSubscribe: p.status === "Available",
            minSubscription: parseFloat(p.minStakeAmount ?? "1"),
          });
        }
      } catch (err) {
        logger.error(`[Bybit] getEarnProducts(${coin}) failed`, err);
      }
    }
    return allProducts;
  }

  // ── getPositions ────────────────────────────────────────────────────────
  async getPositions(assets?: string[]): Promise<Position[]> {
    if (!this.hasKeys) return [];

    const positions: Position[] = [];
    try {
      const qs = this.buildQuery({ category: "FlexibleSaving" });
      const signed = this.signGet(qs);
      const res = await axios.get(
        `${this.base}/v5/earn/position?${signed.qs}`,
        { headers: signed.headers, timeout: 10_000 },
      );

      if (res.data?.retCode !== 0) {
        logger.warn(
          `[Bybit] getPositions: retCode=${res.data?.retCode} msg=${res.data?.retMsg}`,
        );
        return [];
      }

      const targetSet = new Set(
        (assets ?? ["USDT"]).map((a) => a.toUpperCase()),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (res.data?.result?.list ?? []) as any[]) {
        const coin = (p.coin ?? "").toUpperCase();
        if (!targetSet.has(coin)) continue;

        const amount = parseFloat(p.totalAmount ?? p.stakeAmount ?? "0");
        if (amount <= 0) continue;

        positions.push({
          exchange: "bybit",
          productId: `bybit-flex-${coin}-${p.productId ?? "1"}`,
          productName: `Bybit Flex ${coin}`,
          asset: coin,
          amount,
          estimatedDailyIncome: parseFloat(p.estimatedYield ?? "0"),
        });
      }
    } catch (err) {
      logger.error("[Bybit] getPositions failed", err);
    }
    return positions;
  }

  // ── getSpotBalances ─────────────────────────────────────────────────────
  async getSpotBalances(assets?: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const targetAssets = (assets ?? ["USDT"]).map((a) => a.toUpperCase());

    // Initialize all to 0
    for (const a of targetAssets) result.set(a, 0);

    if (!this.hasKeys) return result;

    try {
      // Try UNIFIED account first (Bybit unified account holds spot funds)
      const coinParam = targetAssets.join(",");
      const qs = this.buildQuery({
        accountType: "UNIFIED",
        coin: coinParam,
      });
      const signed = this.signGet(qs);
      const res = await axios.get(
        `${this.base}/v5/asset/transfer/query-account-coins-balance?${signed.qs}`,
        { headers: signed.headers, timeout: 10_000 },
      );

      if (res.data?.retCode === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const b of (res.data?.result?.balance ?? []) as any[]) {
          const coin = (b.coin ?? "").toUpperCase();
          if (targetAssets.includes(coin)) {
            result.set(coin, parseFloat(b.walletBalance ?? "0"));
          }
        }
      } else {
        // Fallback to FUND account type
        const qsFund = this.buildQuery({
          accountType: "FUND",
          coin: coinParam,
        });
        const signedFund = this.signGet(qsFund);
        const resFund = await axios.get(
          `${this.base}/v5/asset/transfer/query-account-coins-balance?${signedFund.qs}`,
          { headers: signedFund.headers, timeout: 10_000 },
        );

        if (resFund.data?.retCode === 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const b of (resFund.data?.result?.balance ?? []) as any[]) {
            const coin = (b.coin ?? "").toUpperCase();
            if (targetAssets.includes(coin)) {
              result.set(coin, parseFloat(b.walletBalance ?? "0"));
            }
          }
        } else {
          logger.warn(
            `[Bybit] getSpotBalances: retCode=${resFund.data?.retCode} msg=${resFund.data?.retMsg}`,
          );
        }
      }
    } catch (err) {
      logger.error("[Bybit] getSpotBalances failed", err);
    }

    return result;
  }

  // ── getPrices ───────────────────────────────────────────────────────────
  async getPrices(assets: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const wanted = new Set(assets.map((a) => a.toUpperCase()));

    try {
      const res = await axios.get(
        `${this.base}/v5/market/tickers?category=spot`,
        { timeout: 10_000 },
      );

      if (res.data?.retCode === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const t of (res.data?.result?.list ?? []) as any[]) {
          const symbol = (t.symbol ?? "").toUpperCase();
          for (const asset of wanted) {
            if (symbol === `${asset}USDT` && asset !== "USDT") {
              result.set(asset, parseFloat(t.lastPrice ?? "0"));
            }
          }
        }
      }
    } catch (err) {
      logger.error("[Bybit] getPrices failed", err);
    }

    // Fill missing: stablecoins = 1, others = 0
    for (const a of assets) {
      const upper = a.toUpperCase();
      if (!result.has(upper)) {
        result.set(upper, isStablecoin(upper) ? 1 : 0);
      }
    }
    return result;
  }

  // ── scanHighApyProducts ─────────────────────────────────────────────────
  async scanHighApyProducts(minApy: number): Promise<HighApyProduct[]> {
    const results: HighApyProduct[] = [];

    // Bybit earn product endpoint requires a specific coin, so we scan popular coins
    const coinsToScan = [
      "USDT",
      "USDC",
      "BTC",
      "ETH",
      "SOL",
      "BNB",
      "XRP",
      "ADA",
      "DOT",
      "AVAX",
      "LINK",
      "MATIC",
      "DOGE",
      "SHIB",
      "SUI",
      "APT",
      "ARB",
      "OP",
      "TIA",
      "SEI",
    ];

    for (const coin of coinsToScan) {
      try {
        const qs = this.buildQuery({
          coin: coin.toUpperCase(),
          category: "FlexibleSaving",
        });
        const res = await axios.get(`${this.base}/v5/earn/product?${qs}`, {
          timeout: 10_000,
        });

        if (res.data?.retCode !== 0) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const p of (res.data?.result?.list ?? []) as any[]) {
          if (p.status !== "Available") continue;

          // Use the best tier APR (first tier is usually the bonus)
          let bestApy = 0;
          if (p.hasTieredApr && Array.isArray(p.tierAprDetails)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const t of p.tierAprDetails as any[]) {
              const aprStr: string = t.estimateApr ?? "0";
              const apy = parseFloat(aprStr.replace("%", "")) / 100;
              if (apy > bestApy) bestApy = apy;
            }
          } else {
            const aprStr: string = p.estimateApr ?? "0";
            bestApy = parseFloat(aprStr.replace("%", "")) / 100;
          }

          if (bestApy >= minApy) {
            results.push({
              exchange: "bybit",
              productId: `bybit-flex-${coin.toUpperCase()}-${p.productId}`,
              asset: coin.toUpperCase(),
              apy: bestApy,
              minAmount: parseFloat(p.minStakeAmount ?? "0"),
              isFlexible: true,
            });
          }
        }

        // Light rate-limit courtesy delay
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        logger.error(`[Bybit] scanHighApy(${coin}) failed`, err);
      }
    }

    logger.info(
      `[Bybit] scanHighApyProducts: found ${results.length} products with APY >= ${(minApy * 100).toFixed(1)}%`,
    );
    return results;
  }
}
