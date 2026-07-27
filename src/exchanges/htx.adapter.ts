/**
 * HTX (Huobi) REST adapter — Earn endpoints.
 *
 * Docs: https://www.htx.com/en-us/opend/newApiPages/?name=earn
 *
 * Required API key permissions: "Read" + "Trade"
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

export class HtxAdapter implements IExchangeAdapter {
  readonly exchangeId = "htx";
  private readonly base = config.htx.baseUrl;
  private readonly host = "api.huobi.pro";
  private spotAccountId: string = config.htx.accountId;

  /** HTX signature — canonical query-string + HMAC-SHA256 + Base64 */
  private sign(
    method: "GET" | "POST",
    path: string,
    params: Record<string, string>,
  ): string {
    const sorted = Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(params[k]!)}`)
      .join("&");

    const payload = [method, this.host, path, sorted].join("\n");
    const sig = hmacSha256(config.htx.apiSecret, payload);
    return Buffer.from(sig, "hex").toString("base64");
  }

  private buildUrl(path: string, extra: Record<string, string> = {}): string {
    const params: Record<string, string> = {
      AccessKeyId: config.htx.apiKey,
      SignatureMethod: "HmacSHA256",
      SignatureVersion: "2",
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, ""),
      ...extra,
    };
    const signature = this.sign("GET", path, params);
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${this.base}${path}?${qs}&Signature=${encodeURIComponent(signature)}`;
  }

  async getEarnProducts(assets?: string[]): Promise<EarnProduct[]> {
    const targetAssets = assets ?? ["USDT"];
    const allProducts: EarnProduct[] = [];

    for (let i = 0; i < targetAssets.length; i++) {
      const assetName = targetAssets[i]!;
      if (i > 0) await new Promise((r) => setTimeout(r, 2_500));
      try {
        const url = this.buildUrl("/v1/earn/project/queryEarnProjectList", {
          currency: assetName.toLowerCase(),
          pageNum: "1",
          pageSize: "100",
        });
        const res = await axios.get(url, { timeout: 10_000 });
        logger.info(
          `[HTX] getEarnProducts(${assetName}): code=${res.data?.code} total=${res.data?.data?.total ?? "?"} items=${res.data?.data?.items?.length ?? 0}`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: any[] = res.data?.data?.items ?? [];

        for (const p of items) {
          if (p.currency?.toUpperCase() !== assetName.toUpperCase()) continue;

          const perkLimit = parseFloat(p.marketPerkUpLimit ?? "0");
          const perkApy = parseFloat(String(p.marketPerkApy ?? "0"));
          const baseApy = parseFloat(
            String(p.marketTimeApy ?? p.viewYearRate ?? "0"),
          );

          let tiers: {
            minAmount: number;
            maxAmount: number | null;
            apy: number;
          }[];

          if (perkLimit > 0 && perkApy > baseApy) {
            tiers = [
              { minAmount: 0, maxAmount: perkLimit, apy: perkApy },
              { minAmount: perkLimit, maxAmount: null, apy: baseApy },
            ];
          } else if (Array.isArray(p.tieredRates) && p.tieredRates.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            tiers = p.tieredRates.map((t: any) => ({
              minAmount: parseFloat(t.amountStart ?? "0"),
              maxAmount: t.amountEnd ? parseFloat(t.amountEnd) : null,
              apy: parseFloat(t.rate ?? "0"),
            }));
          } else {
            tiers = [
              {
                minAmount: 0,
                maxAmount: null,
                apy: parseFloat(p.viewYearRate ?? "0"),
              },
            ];
          }

          logger.info(
            `[HTX] ${assetName}/${p.projectId} tiers: ${JSON.stringify(tiers)}`,
          );

          allProducts.push({
            exchange: "htx" as const,
            productId: String(p.projectId),
            name: `HTX ${assetName} Earn ${p.projectId}`,
            asset: assetName.toUpperCase(),
            tiers,
            isFlexible: p.type === 0,
            lockDays: 0,
            canSubscribe:
              p.projectStatus === undefined || p.projectStatus === 1,
            minSubscription: parseFloat(p.startAmount ?? "1"),
          });
        }
      } catch (err) {
        logger.error(`[HTX] getEarnProducts(${assetName}) failed`, err);
      }
    }
    return allProducts;
  }

  async getPositions(assets?: string[]): Promise<Position[]> {
    const targetAssets = assets ?? ["USDT"];
    const allPositions: Position[] = [];

    for (let i = 0; i < targetAssets.length; i++) {
      const assetName = targetAssets[i]!;
      if (i > 0) await new Promise((r) => setTimeout(r, 2_500));
      try {
        const url = this.buildUrl("/v1/earn/order/user/assets/list", {
          projectType: "0",
          currency: assetName.toLowerCase(),
          pageNum: "1",
          pageSize: "100",
        });
        const res = await axios.get(url, { timeout: 10_000 });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: any[] = res.data?.data?.items ?? [];

        for (const p of items) {
          if (p.currency?.toUpperCase() !== assetName.toUpperCase()) continue;
          allPositions.push({
            exchange: "htx" as const,
            productId: String(p.projectId),
            productName: `HTX ${assetName} Earn ${p.projectId}`,
            asset: assetName.toUpperCase(),
            amount: parseFloat(p.totalAmount ?? "0"),
            estimatedDailyIncome: parseFloat(p.yesterdayIncome ?? "0"),
          });
        }
      } catch (err) {
        logger.error(`[HTX] getPositions(${assetName}) failed`, err);
      }
    }
    return allPositions;
  }

  async getSpotBalances(assets?: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      // Auto-detect spot account ID if not set or on first failure
      if (!this.spotAccountId) {
        await this.detectSpotAccountId();
      }

      const url = this.buildUrl(
        `/v1/account/accounts/${this.spotAccountId}/balance`,
      );
      const res = await axios.get(url, { timeout: 10_000 });
      const status = res.data?.status;

      // If account ID is wrong, try auto-detect and retry once
      if (
        status === "error" &&
        res.data?.["err-code"]?.includes("inexistent")
      ) {
        logger.warn(
          `[HTX] Account ${this.spotAccountId} not found, auto-detecting...`,
        );
        await this.detectSpotAccountId();
        const retryUrl = this.buildUrl(
          `/v1/account/accounts/${this.spotAccountId}/balance`,
        );
        const retryRes = await axios.get(retryUrl, { timeout: 10_000 });
        return this.parseSpotBalances(retryRes.data, assets);
      }

      return this.parseSpotBalances(res.data, assets);
    } catch (err) {
      logger.error("[HTX] getSpotBalances failed", err);
    }
    for (const a of assets ?? ["USDT"]) {
      if (!result.has(a.toUpperCase())) result.set(a.toUpperCase(), 0);
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseSpotBalances(data: any, assets?: string[]): Map<string, number> {
    const result = new Map<string, number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = data?.data?.list ?? [];
    const targetSet = new Set((assets ?? ["USDT"]).map((a) => a.toLowerCase()));
    const found: Record<string, number> = {};
    for (const b of list) {
      if (b.type === "trade" && targetSet.has(b.currency)) {
        const bal = parseFloat(b.balance ?? "0");
        found[b.currency.toUpperCase()] = bal;
        result.set(b.currency.toUpperCase(), bal);
      }
    }
    logger.info(
      `[HTX] getSpotBalances: status=${data?.status} acctId=${this.spotAccountId} found=${JSON.stringify(found)}`,
    );
    for (const a of assets ?? ["USDT"]) {
      if (!result.has(a.toUpperCase())) result.set(a.toUpperCase(), 0);
    }
    return result;
  }

  private async detectSpotAccountId(): Promise<void> {
    try {
      const url = this.buildUrl("/v1/account/accounts");
      const res = await axios.get(url, { timeout: 10_000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const accounts: any[] = res.data?.data ?? [];
      const spot = accounts.find(
        (a) => a.type === "spot" && a.state === "working",
      );
      if (spot) {
        this.spotAccountId = String(spot.id);
        logger.info(
          `[HTX] Auto-detected spot account ID: ${this.spotAccountId}`,
        );
      } else {
        logger.warn(
          `[HTX] No working spot account found. Accounts: ${JSON.stringify(accounts)}`,
        );
      }
    } catch (err) {
      logger.error("[HTX] Failed to detect spot account ID", err);
    }
  }

  async getPrices(assets: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const res = await axios.get(`${this.base}/market/tickers`, {
        timeout: 10_000,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tickers: any[] = res.data?.data ?? [];
      const wanted = new Set(assets.map((a) => a.toLowerCase()));
      for (const t of tickers) {
        const symbol = (t.symbol ?? "").toLowerCase();
        for (const asset of wanted) {
          if (symbol === `${asset}usdt` && asset !== "usdt") {
            result.set(asset.toUpperCase(), parseFloat(t.close ?? "0"));
          }
        }
      }
    } catch (err) {
      logger.error("[HTX] getPrices failed", err);
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
    const pageSize = 100;

    try {
      while (true) {
        const url = this.buildUrl("/v1/earn/project/queryEarnProjectList", {
          pageNum: String(page),
          pageSize: String(pageSize),
        });
        let res = await axios.get(url, { timeout: 15_000 });

        // Retry on rate limit (429)
        if (res.data?.code === 429) {
          logger.info(
            `[HTX] scanHighApy page ${page}: rate limited, retrying in 3s...`,
          );
          await new Promise((r) => setTimeout(r, 3_000));
          const retryUrl = this.buildUrl(
            "/v1/earn/project/queryEarnProjectList",
            {
              pageNum: String(page),
              pageSize: String(pageSize),
            },
          );
          res = await axios.get(retryUrl, { timeout: 15_000 });
        }

        logger.info(
          `[HTX] scanHighApy page ${page}: code=${res.data?.code} total=${res.data?.data?.total ?? "?"} items=${res.data?.data?.items?.length ?? 0}`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: any[] = res.data?.data?.items ?? [];
        if (items.length === 0) break;

        for (const p of items) {
          const apy = parseFloat(p.viewYearRate ?? "0");
          if (apy >= minApy) {
            results.push({
              exchange: "htx",
              productId: String(p.projectId),
              asset: (p.currency ?? "?").toUpperCase(),
              apy,
              minAmount: parseFloat(p.startAmount ?? "0"),
              isFlexible: p.type === 0,
            });
          }
        }

        const total = res.data?.data?.total ?? 0;
        if (page * pageSize >= total) break;
        page++;
        // Delay between pages to avoid HTX rate limits
        await new Promise((r) => setTimeout(r, 1_500));
      }

      logger.info(
        `[HTX] scanHighApy: found ${results.length} products with APY >= ${(minApy * 100).toFixed(1)}%`,
      );
    } catch (err) {
      logger.error("[HTX] scanHighApyProducts failed", err);
    }

    return results;
  }
}
