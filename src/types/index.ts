export type ExchangeId = "binance" | "htx" | "bybit";

/** Stablecoins are treated as ~$1 fungible within an exchange */
export const STABLECOIN_SET = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "DAI",
  "BUSD",
  "USD1",
]);
export function isStablecoin(asset: string): boolean {
  return STABLECOIN_SET.has(asset.toUpperCase());
}

/** One APY tier inside a product */
export interface EarnTier {
  minAmount: number;
  maxAmount: number | null; // null = unlimited
  apy: number; // decimal: 0.08 = 8 %
}

/** An Earn product fetched from an exchange */
export interface EarnProduct {
  exchange: ExchangeId;
  productId: string;
  name: string;
  asset: string;
  tiers: EarnTier[]; // sorted by minAmount asc
  isFlexible: boolean; // can redeem any time
  lockDays: number; // 0 for flexible
  canSubscribe: boolean;
  minSubscription: number;
}

/** A currently held position */
export interface Position {
  exchange: ExchangeId;
  productId: string;
  productName: string;
  asset: string;
  amount: number;
  estimatedDailyIncome?: number;
}

/** One slot in the optimal allocation plan */

export interface AllocationSlot {
  exchange: ExchangeId;
  productId: string;
  productName: string;
  asset: string;
  amount: number;
  apy: number; // weighted effective APY for this amount
  tiers?: EarnTier[]; // optional: full tier structure for calculator
}
/** An action the user should take to reach the optimal allocation */
export interface RebalanceAction {
  priority: number;
  /** WITHDRAW = pull from Earn to spot; DEPOSIT = put spot into Earn;
   *  SEND = cross-exchange transfer; CONVERT = swap stablecoins;
   *  SELL = sell volatile coin back to stablecoin */
  type: "WITHDRAW" | "DEPOSIT" | "SEND" | "CONVERT" | "SELL";
  exchange: ExchangeId;
  productId: string;
  productName: string;
  asset: string;
  amount: number;
  note: string;
}

/** Full result of one optimization run */
export interface OptimizationResult {
  totalCapital: number;
  availableCapital: number;
  currentWeightedApy: number;
  optimalWeightedApy: number;
  optimalAllocation: AllocationSlot[];
  /** Current real positions mapped to allocation format with APY */
  currentAllocation: AllocationSlot[];
  actions: RebalanceAction[];
  estimatedAnnualGain: number; // USDT
  timestamp: string; // ISO string
  /** Per-exchange breakdown: spot + earn balances */
  exchangeBalances: ExchangeBalance[];
  /** Volatile coin candidates analyzed this run */
  volatileCandidates: VolatileCandidate[];
  /** Volatile allocation (separate from stable) */
  volatileAllocation: AllocationSlot[];
  /** Total capital allocated to volatile coins (USDT) */
  volatileCapital: number;
  /** Strategy comparison scenarios */
  strategies: StrategyScenario[];
}

export interface ExchangeBalance {
  exchange: ExchangeId;
  spotBalance: number;
  earnBalance: number;
  positions: Position[];
}

/** Persisted app state */
export interface AppState {
  lastOptimization: OptimizationResult | null;
  lastUpdated: string | null;
  earningsHistory: EarningsRecord[];
  /** High-APY products across all coins */
  highApyProducts: HighApyProduct[];
  /** Active volatile earn positions with price tracking */
  volatilePositions: VolatilePosition[];
  /** Currently active strategy */
  activeStrategy: StrategyId;
}

export interface EarningsRecord {
  date: string; // YYYY-MM-DD
  totalEarned: number;
  byExchange: Record<ExchangeId, number>;
}

/** A high-APY product discovered during the all-coin scan */
export interface HighApyProduct {
  exchange: ExchangeId;
  productId: string;
  asset: string;
  apy: number; // decimal: 0.10 = 10%
  minAmount: number;
  isFlexible: boolean;
}

/** Volatile coin position being tracked */
export interface VolatilePosition {
  exchange: ExchangeId;
  productId: string;
  asset: string;
  amountCoins: number;
  amountUsd: number; // USDT value at entry
  entryPrice: number; // USDT price when entered
  currentPrice: number; // latest price
  apy: number;
  entryDate: string; // ISO
  stopLossPrice: number;
  status: "active" | "stop-loss-triggered" | "exited";
}

/** Analyzed volatile coin earn opportunity */
export interface VolatileCandidate {
  exchange: ExchangeId;
  productId: string;
  asset: string;
  apy: number;
  price: number; // current USDT price
  change24h: number; // 24h change decimal (-0.05 = -5%)
  dailyApy: number; // daily APY return decimal
  daysToBreakeven: number; // days of APY needed to cover stop-loss
  riskScore: number; // 0-100, higher = riskier
  maxAllocation: number; // max suggested USDT
  isFlexible: boolean;
}

// ── Strategy scenarios ──────────────────────────────────────────────────

export type StrategyId = "conservative" | "moderate" | "aggressive";

export interface StrategyScenario {
  id: StrategyId;
  name: string;
  description: string;
  allocation: AllocationSlot[];
  totalCapital: number;
  weightedApy: number;
  dailyEarn: number;
  monthlyEarn: number;
  annualEarn: number;
  riskLevel: string; // "Нулевой", "Низкий", "Высокий"
}
