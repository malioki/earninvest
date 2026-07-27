import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import {
  loadFinance,
  computeMetrics,
  type FinanceMetrics,
} from "./index.js";

const SNAPSHOTS_FILE = path.join(config.dataDir, "finance-snapshots.json");

export interface FinanceSnapshot {
  /** ISO date string (YYYY-MM-DDTHH:mm:ss). */
  ts: string;
  /** Plain date for daily de-duplication. */
  date: string;
  totalCreditBalanceUsd: number;
  totalMonthlyInterestUsd: number;
  totalLiquidAssetsUsd: number;
  freeCashUsd: number;
  totalEarmarkedUsd: number;
  /** Sum of EarnOptimizer amounts (assets with role:"buffer"). */
  earnBufferUsd: number;
  /** Sum of high-risk speculative assets. */
  speculativeUsd: number;
  /** Sum of personal debts owed to others. */
  personalDebtsUsd: number;
  netWorthUsd: number; // liquid + owedToMe - credits - personal debts
  passiveIncomeGoalUsdPerMonth: number;
}

interface SnapshotsFile {
  snapshots: FinanceSnapshot[];
}

function loadFile(): SnapshotsFile {
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return { snapshots: [] };
    const raw = fs.readFileSync(SNAPSHOTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as SnapshotsFile;
    return { snapshots: parsed.snapshots ?? [] };
  } catch (err) {
    logger.error("[Snapshots] Failed to load, starting empty", err);
    return { snapshots: [] };
  }
}

function saveFile(file: SnapshotsFile): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(file, null, 2), "utf-8");
  } catch (err) {
    logger.error("[Snapshots] Failed to save", err);
  }
}

export function loadSnapshots(): FinanceSnapshot[] {
  return loadFile().snapshots;
}

function buildSnapshot(metrics: FinanceMetrics): FinanceSnapshot {
  const now = new Date();
  const buffer = metrics.data.liquidAssets
    .filter((a) => a.role === "buffer")
    .reduce((s, a) => s + a.amountUsd, 0);
  const speculative = metrics.data.liquidAssets
    .filter((a) => a.role === "speculative" || a.risk === "high")
    .reduce((s, a) => s + a.amountUsd, 0);
  const netWorth =
    metrics.totalLiquidAssetsUsd +
    metrics.totalOwedToMeUsd -
    metrics.totalCreditBalanceUsd -
    metrics.totalPersonalDebtsUsd;
  return {
    ts: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    totalCreditBalanceUsd: round(metrics.totalCreditBalanceUsd),
    totalMonthlyInterestUsd: round(metrics.totalMonthlyInterestUsd, 2),
    totalLiquidAssetsUsd: round(metrics.totalLiquidAssetsUsd),
    freeCashUsd: round(metrics.freeCashUsd),
    totalEarmarkedUsd: round(metrics.totalEarmarkedUsd),
    earnBufferUsd: round(buffer),
    speculativeUsd: round(speculative),
    personalDebtsUsd: round(metrics.totalPersonalDebtsUsd),
    netWorthUsd: round(netWorth),
    passiveIncomeGoalUsdPerMonth: metrics.data.passiveIncomeGoalUsdPerMonth,
  };
}

function round(n: number, d = 0): number {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

/**
 * Take a snapshot. Replaces same-day snapshot if it exists (so we always
 * reflect latest state for that day).
 */
export function takeSnapshot(): FinanceSnapshot {
  const data = loadFinance();
  const metrics = computeMetrics(data);
  const snap = buildSnapshot(metrics);
  const file = loadFile();
  const idx = file.snapshots.findIndex((s) => s.date === snap.date);
  if (idx >= 0) file.snapshots[idx] = snap;
  else file.snapshots.push(snap);
  file.snapshots.sort((a, b) => a.ts.localeCompare(b.ts));
  saveFile(file);
  logger.info(
    `[Snapshots] Saved ${snap.date}: debt=$${snap.totalCreditBalanceUsd}, liquid=$${snap.totalLiquidAssetsUsd}, net=$${snap.netWorthUsd}`,
  );
  return snap;
}

/**
 * Take snapshot only if last one is older than minDays.
 * Used by the scheduler — runs daily but only writes weekly.
 */
export function takeSnapshotIfDue(minDays = 7): FinanceSnapshot | null {
  const snaps = loadSnapshots();
  if (snaps.length === 0) return takeSnapshot();
  const last = snaps[snaps.length - 1]!;
  const lastTs = new Date(last.ts).getTime();
  const now = Date.now();
  const days = (now - lastTs) / (1000 * 60 * 60 * 24);
  if (days >= minDays) return takeSnapshot();
  return null;
}
