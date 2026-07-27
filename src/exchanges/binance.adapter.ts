/**
 * Binance REST adapter — Earn (Simple Earn) endpoints.
 *
 * Docs: https://developers.binance.com/docs/simple_earn/Introduction
 *
 * Required API key permissions: "Read" + "Spot & Margin Trading"
 * (to later support subscribe/redeem via API).
 */
import axios from "axios";
import { config } from "../config/index.js";
import {
  isStablecoin,
  type EarnProduct,
  type HighApyProduct,
  type Position,
} from "../types/index.js";
import type { IExchangeAdapter } from "./IExchangeAdapter.js";
import { hmacSha256 } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";

export class BinanceAdapter implements IExchangeAdapter {
  readonly exchangeId = "binance";
  private readonly base = config.binance.baseUrl;
  private timeOffset = 0; // Time offset in ms between local and Binance server

  /** Get server time from Binance and calculate offset once */
  private async getServerTimeOffset(): Promise<number> {
    if (this.timeOffset !== 0) return this.timeOffset; // Already calculated
    try {
      const res = await axios.get(`${this.base}/api/v3/time`, {
        timeout: 5_000,
      });
      const serverTime = res.data?.serverTime ?? 0;
      this.timeOffset = serverTime - Date.now();
      logger.info(`[Binance] Time offset calculated: ${this.timeOffset}ms`);
    } catch (e) {
      logger.warn(`[Binance] Failed to get server time, using local time`);
      this.timeOffset = 0;
    }
    return this.timeOffset;
  }

  /** Get current timestamp with server offset applied */
  private async getTimestamp(): Promise<number> {
    await this.getServerTimeOffset();
    return Date.now() + this.timeOffset;
  }

  private sign(params: Record<string, string | number>): string {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const sig = hmacSha256(config.binance.apiSecret, query);
    return `${query}&signature=${sig}`;
  }

  private get headers() {
    return { "X-MBX-APIKEY": config.binance.apiKey };
  }

  async getEarnProducts(assets?: string[]): Promise<EarnProduct[]> {
    const targetAssets = assets ?? ["USDT"];
    const allProducts: EarnProduct[] = [];

    for (const assetName of targetAssets) {
      try {
        const timestamp = await this.getTimestamp();
        const params = { asset: assetName, timestamp, size: 100 };
        const qs = this.sign(params);
        const res = await axios.get(
          `${this.base}/sapi/v1/simple-earn/flexible/list?${qs}`,
          { headers: this.headers, timeout: 10_000 },
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any[] = res.data?.rows ?? [];
        logger.info(
          `[Binance] getEarnProducts(${assetName}): total=${res.data?.total} rows=${rows.length}`,
        );

        for (const r of rows) {
          const baseApy = parseFloat(r.latestAnnualPercentageRate ?? "0");
          const tierObj: Record<string, string> | undefined =
            r.tierAnnualPercentageRate;
          const tiers: {
            minAmount: number;
            maxAmount: number | null;
            apy: number;
          }[] = [];

          if (tierObj && typeof tierObj === "object") {
            const parsed: {
              min: number;
              max: number | null;
              apy: number;
            }[] = [];
            for (const [key, rate] of Object.entries(tierObj)) {
              const match = key.match(/^(\d+)-(\d+)/);
              if (match) {
                parsed.push({
                  min: parseFloat(match[1]!),
                  max: parseFloat(match[2]!),
                  apy: parseFloat(rate),
                });
              }
            }
            parsed.sort((a, b) => a.min - b.min);

            if (parsed.length > 0) {
              for (const p of parsed) {
                tiers.push({
                  minAmount: p.min,
                  maxAmount: p.max,
                  apy: p.apy + baseApy, // bonus tier + base real-time APR
                });
              }
              const lastTier = parsed[parsed.length - 1]!;
              tiers.push({
                minAmount: lastTier.max!,
                maxAmount: null,
                apy: baseApy,
              });
            }
          }

          if (tiers.length === 0) {
            tiers.push({ minAmount: 0, maxAmount: null, apy: baseApy });
          }

          allProducts.push({
            exchange: "binance" as const,
            productId: r.productId,
            name: r.productId,
            asset: assetName,
            tiers,
            isFlexible: true,
            lockDays: 0,
            canSubscribe: r.status === "PURCHASING",
            minSubscription: parseFloat(r.minPurchaseAmount ?? "0.1"),
          });
        }
      } catch (err) {
        logger.error(`[Binance] getEarnProducts(${assetName}) failed`, err);
      }
    }
    return allProducts;
  }

  async getPositions(assets?: string[]): Promise<Position[]> {
    const targetAssets = assets ?? ["USDT"];
    const allPositions: Position[] = [];

    for (const assetName of targetAssets) {
      try {
        const timestamp = await this.getTimestamp();
        const params = {
          asset: assetName,
          timestamp,
          size: 100,
        };
        const qs = this.sign(params);
        const res = await axios.get(
          `${this.base}/sapi/v1/simple-earn/flexible/position?${qs}`,
          { headers: this.headers, timeout: 10_000 },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const r of (res.data?.rows ?? []) as any[]) {
          allPositions.push({
            exchange: "binance" as const,
            productId: r.productId,
            productName: r.productId,
            asset: assetName,
            amount: parseFloat(r.totalAmount ?? "0"),
            estimatedDailyIncome: parseFloat(r.yesterdayRealTimeRewards ?? "0"),
          });
        }
      } catch (err) {
        logger.error(`[Binance] getPositions(${assetName}) failed`, err);
      }
    }
    return allPositions;
  }

  async getSpotBalances(assets?: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const timestamp = await this.getTimestamp();
      const params = { timestamp };
      const qs = this.sign(params);
      const res = await axios.get(`${this.base}/api/v3/account?${qs}`, {
        headers: this.headers,
        timeout: 10_000,
      });
      const targetSet = new Set(
        (assets ?? ["USDT"]).map((a) => a.toUpperCase()),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const b of (res.data?.balances ?? []) as any[]) {
        const sym = (b.asset ?? "").toUpperCase();
        if (targetSet.has(sym)) {
          result.set(sym, parseFloat(b.free ?? "0"));
        }
      }
    } catch (err) {
      logger.error("[Binance] getSpotBalances failed", err);
    }
    for (const a of assets ?? ["USDT"]) {
      if (!result.has(a.toUpperCase())) result.set(a.toUpperCase(), 0);
    }
    return result;
  }

  async getPrices(assets: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const res = await axios.get(`${this.base}/api/v3/ticker/24hr`, {
        timeout: 10_000,
      });
      const wanted = new Set(assets.map((a) => a.toUpperCase()));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const t of (res.data ?? []) as any[]) {
        const symbol = (t.symbol ?? "").toUpperCase();
        for (const asset of wanted) {
          if (symbol === `${asset}USDT` && asset !== "USDT") {
            result.set(asset, parseFloat(t.lastPrice ?? "0"));
          }
        }
      }
    } catch (err) {
      logger.error("[Binance] getPrices failed", err);
    }
    for (const a of assets) {
      const upper = a.toUpperCase();
      if (!result.has(upper)) {
        result.set(upper, isStablecoin(upper) ? 1 : 0);
      }
    }
    return result;
  }

  async scanHighApyProducts(minApy: number): Promise<HighApyProduct[]> {
    const results: HighApyProduct[] = [];
    let page = 1;
    const size = 100;

    try {
      while (true) {
        const timestamp = await this.getTimestamp();
        const params = { current: page, size, timestamp };
        const qs = this.sign(params);
        const res = await axios.get(
          `${this.base}/sapi/v1/simple-earn/flexible/list?${qs}`,
          { headers: this.headers, timeout: 15_000 },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any[] = res.data?.rows ?? [];
        if (rows.length === 0) break;

        for (const r of rows) {
          const apy = parseFloat(r.latestAnnualPercentageRate ?? "0");
          if (apy >= minApy && r.status === "PURCHASING") {
            results.push({
              exchange: "binance",
              productId: r.productId,
              asset: r.asset ?? r.productId?.replace(/\d+$/, "") ?? "?",
              apy,
              minAmount: parseFloat(r.minPurchaseAmount ?? "0"),
              isFlexible: true,
            });
          }
        }

        const total = res.data?.total ?? 0;
        if (page * size >= total) break;
        page++;
      }

      logger.info(
        `[Binance] scanHighApy: found ${results.length} products with APY >= ${(minApy * 100).toFixed(1)}%`,
      );
    } catch (err) {
      logger.error("[Binance] scanHighApyProducts failed", err);
    }

    return results;
  }
}
