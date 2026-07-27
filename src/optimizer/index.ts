import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import {
  EarnProduct,
  AllocationSlot,
  Position,
  ExchangeId,
  OptimizationResult,
  RebalanceAction,
  HighApyProduct,
} from "../types/index.js";
import { fmt } from "../utils/crypto.js";

interface Slot {
  product: EarnProduct;
  tier: { minAmount: number; maxAmount: number | null; apy: number };
  capacity: number;
}

export function optimize(
  products: EarnProduct[],
  positions: Position[],
  spotBalances: Map<string, number>,
  highApyProducts?: HighApyProduct[],
  prices?: Map<string, number>,
): OptimizationResult {
  const minAmount = config.optimizer.minRebalanceAmount;
  const positionsByExchange = new Map<string, number>();
  let totalInEarn = 0;
  for (const pos of positions) {
    totalInEarn += pos.amount;
    positionsByExchange.set(
      pos.exchange,
      (positionsByExchange.get(pos.exchange) ?? 0) + pos.amount,
    );
  }

  let totalSpot = 0;
  for (const [, bal] of spotBalances) totalSpot += bal;
  const totalCapital = totalInEarn + totalSpot;
  let remaining = totalCapital;

  const slots: Slot[] = [];
  for (const product of products) {
    if (!product.canSubscribe) continue;
    for (const tier of product.tiers) {
      const capacity =
        tier.maxAmount !== null
          ? Math.max(0, tier.maxAmount - tier.minAmount)
          : Infinity;
      if (capacity < minAmount && capacity !== Infinity) continue;
      slots.push({ product, tier, capacity });
    }
  }

  slots.sort((a, b) => {
    if (b.tier.apy !== a.tier.apy) return b.tier.apy - a.tier.apy;
    return Number(b.product.isFlexible) - Number(a.product.isFlexible);
  });

  const allocation: AllocationSlot[] = [];
  let weightedApyNumerator = 0;

  if (config.optimizer.activeStrategy === "diversified") {
    const div = optimizeDiversified(slots, totalCapital, minAmount);
    for (const slot of div) {
      allocation.push(slot);
      weightedApyNumerator += slot.amount * slot.apy;
    }
  } else {
    // Greedy: fill slots from highest APY
    for (const slot of slots) {
      if (remaining < minAmount) break;
      const fill =
        slot.capacity === Infinity
          ? remaining
          : Math.min(remaining, slot.capacity);
      if (fill < minAmount) continue;

      allocation.push({
        exchange: slot.product.exchange,
        productId: slot.product.productId,
        productName: slot.product.name,
        asset: slot.product.asset,
        amount: fill,
        apy: slot.tier.apy,
        tiers: slot.product.tiers,
      });
      weightedApyNumerator += fill * slot.tier.apy;
      remaining -= fill;
    }
  }

  const optimalWeightedApy =
    totalCapital > 0 ? weightedApyNumerator / totalCapital : 0;

  let currentApyNumerator = 0;
  const currentAllocation: AllocationSlot[] = [];
  for (const pos of positions) {
    const prod = products.find(
      (p) => p.exchange === pos.exchange && p.productId === pos.productId,
    );
    const apy = prod ? getEffectiveApy(prod, pos.amount) : 0;
    currentApyNumerator += pos.amount * apy;
    currentAllocation.push({
      exchange: pos.exchange,
      productId: pos.productId,
      productName: pos.productName,
      asset: pos.asset,
      amount: pos.amount,
      apy,
    });
  }
  const currentWeightedApy =
    totalCapital > 0 ? currentApyNumerator / totalCapital : 0;

  const actions: RebalanceAction[] = [];
  const currentMap = new Map<string, number>();
  for (const pos of positions) {
    currentMap.set(`${pos.exchange}:${pos.productId}`, pos.amount);
  }

  const optimalMap = new Map<
    string,
    {
      totalAmount: number;
      weightedApySum: number;
      productName: string;
      asset: string;
      exchange: ExchangeId;
      productId: string;
      tierSlots: { amount: number; apy: number }[];
    }
  >();
  for (const slot of allocation) {
    const key = `${slot.exchange}:${slot.productId}`;
    const existing = optimalMap.get(key);
    if (existing) {
      existing.totalAmount += slot.amount;
      existing.weightedApySum += slot.amount * slot.apy;
      existing.tierSlots.push({ amount: slot.amount, apy: slot.apy });
    } else {
      optimalMap.set(key, {
        totalAmount: slot.amount,
        weightedApySum: slot.amount * slot.apy,
        productName: slot.productName,
        asset: slot.asset,
        exchange: slot.exchange,
        productId: slot.productId,
        tierSlots: [{ amount: slot.amount, apy: slot.apy }],
      });
    }
  }

  let priority = 1;

  for (const [key, currentAmount] of currentMap) {
    const [exchange, productId] = key.split(":") as [string, string];
    const optEntry = optimalMap.get(key);
    const optimalAmount = optEntry?.totalAmount ?? 0;
    const diff = currentAmount - optimalAmount;
    if (diff >= minAmount) {
      const pos = positions.find(
        (p) => p.exchange === exchange && p.productId === productId,
      )!;
      const asset = optEntry?.asset ?? pos?.asset ?? "USDT";
      actions.push({
        priority: priority++,
        type: "WITHDRAW",
        exchange: exchange as ExchangeId,
        productId,
        productName: pos?.productName ?? productId,
        asset,
        amount: Math.round(diff * 100) / 100,
        note: `Redeem ${fmt(diff)} ${asset} from ${exchange.toUpperCase()} Earn → spot wallet`,
      });
    }
  }

  for (const [key, entry] of optimalMap) {
    const currentAmount = currentMap.get(key) ?? 0;
    const diff = entry.totalAmount - currentAmount;
    if (diff >= minAmount) {
      const blendedApy =
        entry.totalAmount > 0 ? entry.weightedApySum / entry.totalAmount : 0;
      let note: string;
      if (entry.tierSlots.length > 1) {
        const breakdown = entry.tierSlots
          .map((t) => `${fmt(t.amount)} @ ${fmt(t.apy * 100, 2)}%`)
          .join(" + ");
        note = `Subscribe ${fmt(diff)} ${entry.asset} to "${entry.productName}" (blended ${fmt(blendedApy * 100, 2)}% APY: ${breakdown})`;
      } else {
        note = `Subscribe ${fmt(diff)} ${entry.asset} to "${entry.productName}" @ ${fmt(blendedApy * 100, 2)}% APY`;
      }
      actions.push({
        priority: priority++,
        type: "DEPOSIT",
        exchange: entry.exchange,
        productId: entry.productId,
        productName: entry.productName,
        asset: entry.asset,
        amount: Math.round(diff * 100) / 100,
        note,
      });
    }
  }

  const withdrawByExchange = new Map<string, number>();
  for (const a of actions.filter((a) => a.type === "WITHDRAW")) {
    withdrawByExchange.set(
      a.exchange,
      (withdrawByExchange.get(a.exchange) ?? 0) + a.amount,
    );
  }
  const depositByExchange = new Map<string, number>();
  for (const a of actions.filter((a) => a.type === "DEPOSIT")) {
    depositByExchange.set(
      a.exchange,
      (depositByExchange.get(a.exchange) ?? 0) + a.amount,
    );
  }

  for (const [fromEx, withdrawAmt] of withdrawByExchange) {
    for (const [toEx, depositAmt] of depositByExchange) {
      if (fromEx === toEx) continue;
      if (withdrawAmt >= minAmount && depositAmt >= minAmount) {
        const sendAmt = Math.min(withdrawAmt, depositAmt);
        actions.push({
          priority: priority++,
          type: "SEND",
          exchange: fromEx as ExchangeId,
          productId: "",
          productName: "",
          asset: "USDT",
          amount: sendAmt,
          note: `Transfer ${fmt(sendAmt)} USDT from ${fromEx.toUpperCase()} to ${toEx.toUpperCase()}`,
        });
        withdrawByExchange.set(fromEx, withdrawAmt - sendAmt);
        depositByExchange.set(toEx, depositAmt - sendAmt);
      }
    }
  }

  const volatileCapital = 0;
  const volatileAllocation: AllocationSlot[] = [];
  const volatileCandidates: any[] = [];
  const estimatedAnnualGain = weightedApyNumerator;

  return {
    totalCapital,
    availableCapital: totalSpot,
    currentWeightedApy,
    optimalWeightedApy,
    optimalAllocation: allocation,
    currentAllocation,
    actions,
    estimatedAnnualGain,
    timestamp: new Date().toISOString(),
    exchangeBalances: [],
    volatileCandidates,
    volatileAllocation,
    volatileCapital,
    strategies: [],
  };
}

function optimizeDiversified(
  slots: Slot[],
  totalCapital: number,
  minAmount: number,
): AllocationSlot[] {
  const { minProducts, maxPerProductPct, maxPerExchangePct } =
    config.optimizer.diversification;
  const allocation: AllocationSlot[] = [];

  // Group by product to track concentration
  const byProduct = new Map<string, number>();
  const byExchange = new Map<string, number>();

  // Strategy: distribute equally among top-N products by APY, then use leftovers
  const uniqueProducts = new Map<string, Slot>(); // product key -> best tier slot
  for (const slot of slots) {
    const pkey = `${slot.product.exchange}:${slot.product.productId}`;
    if (!uniqueProducts.has(pkey)) {
      uniqueProducts.set(pkey, slot);
    }
  }

  const topProducts = Array.from(uniqueProducts.values()).slice(
    0,
    Math.max(minProducts, Math.ceil(totalCapital / minAmount / 2)),
  );

  if (topProducts.length > 0) {
    // Distribute capital equally among top products
    const perProduct = Math.floor(totalCapital / topProducts.length);
    const remainder = totalCapital % topProducts.length;

    let remaining = totalCapital;
    let idx = 0;

    for (const topSlot of topProducts) {
      const allocAmount = perProduct + (idx < remainder ? 1 : 0);
      if (allocAmount < minAmount) {
        idx++;
        continue;
      }

      // Find best tier for this amount in this product
      const bestTier = topSlot.product.tiers.reduce((prev, curr) => {
        if (
          allocAmount >= curr.minAmount &&
          (curr.maxAmount === null || allocAmount <= curr.maxAmount)
        ) {
          return curr.apy > prev.apy ? curr : prev;
        }
        return prev;
      }, topSlot.product.tiers[0]);

      allocation.push({
        exchange: topSlot.product.exchange,
        productId: topSlot.product.productId,
        productName: topSlot.product.name,
        asset: topSlot.product.asset,
        amount: allocAmount,
        apy: bestTier.apy,
        tiers: topSlot.product.tiers,
      });

      const pkey = `${topSlot.product.exchange}:${topSlot.product.productId}`;
      byProduct.set(pkey, allocAmount);
      byExchange.set(topSlot.product.exchange, allocAmount);
      remaining -= allocAmount;
      idx++;
    }
  }

  return allocation;
}

function getEffectiveApy(product: EarnProduct, amount: number): number {
  for (const tier of product.tiers) {
    if (
      amount >= tier.minAmount &&
      (tier.maxAmount === null || amount <= tier.maxAmount)
    ) {
      return tier.apy;
    }
  }
  return product.tiers[product.tiers.length - 1]?.apy ?? 0;
}
