import type { EarnProduct, HighApyProduct, Position } from "../types/index.js";

export interface IExchangeAdapter {
  readonly exchangeId: string;
  /** Fetch available Earn products for specified assets (defaults to USDT if omitted) */
  getEarnProducts(assets?: string[]): Promise<EarnProduct[]>;
  /** Fetch currently held positions for specified assets (defaults to USDT) */
  getPositions(assets?: string[]): Promise<Position[]>;
  /** Spot balances — returns Map<asset, balance> for the requested assets */
  getSpotBalances(assets?: string[]): Promise<Map<string, number>>;
  /** Scan ALL coins and return products with APY >= threshold */
  scanHighApyProducts(minApy: number): Promise<HighApyProduct[]>;
  /** Get current USDT prices for assets (stablecoins return ~1.0) */
  getPrices(assets: string[]): Promise<Map<string, number>>;
}
