import express from "express";
import { config } from "../config/index.js";
import { loadState, saveState } from "../state/index.js";
import { logger } from "../utils/logger.js";
import { fmt } from "../utils/crypto.js";
import {
  loadFinance,
  computeMetrics,
  recommendAllocation,
} from "../finance/index.js";
import { renderFinancePage } from "./finance-page.js";
import { renderReceiptsPage } from "./receipts-page.js";
import {
  loadReceipts,
  saveReceipts,
  addReceiptFromUrl,
  computeReceiptStats,
} from "../receipts/index.js";
import {
  loadExpenses,
  addExpense,
  deleteExpense,
  computeCashStats,
} from "../expenses/index.js";
import type { Currency } from "../expenses/index.js";
import { loadSnapshots, takeSnapshot } from "../finance/snapshots.js";
import { saveFinance } from "../finance/index.js";
import { isStablecoin } from "../types/index.js";
import type {
  OptimizationResult,
  RebalanceAction,
  HighApyProduct,
  StrategyScenario,
  StrategyId,
} from "../types/index.js";

export function startWebServer(onRefresh?: () => Promise<void>): void {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  app.get("/", (_req, res) => {
    const state = loadState();
    const result = state.lastOptimization;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderDashboard(
        result,
        state.lastUpdated,
        state.highApyProducts ?? [],
        state.activeStrategy ?? "conservative",
      ),
    );
  });

  app.get("/api/state", (_req, res) => {
    res.json(loadState());
  });

  app.get("/finance", (_req, res) => {
    const data = loadFinance();
    const metrics = computeMetrics(data);
    const snapshots = loadSnapshots();
    // Seed the capital calculator with the best stablecoin APY we actually see
    // on an exchange right now, rather than a made-up number.
    const bestStableApyPct =
      (loadState().highApyProducts ?? [])
        .filter((p) => isStablecoin(p.asset))
        .reduce((best, p) => Math.max(best, p.apy), 0) * 100;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderFinancePage(metrics, snapshots, bestStableApyPct));
  });

  app.get("/api/finance", (_req, res) => {
    const data = loadFinance();
    res.json(computeMetrics(data));
  });

  app.get("/api/finance/snapshots", (_req, res) => {
    res.json(loadSnapshots());
  });

  app.post("/api/finance/snapshot", (_req, res) => {
    const snap = takeSnapshot();
    res.json(snap);
  });

  app.patch("/api/finance/section", (req, res) => {
    const ALLOWED = new Set([
      "liquidAssets",
      "earmarks",
      "personalDebts",
      "owedToMe",
    ]);
    const { section, data } = (req.body ?? {}) as {
      section?: string;
      data?: unknown;
    };
    if (!section || !ALLOWED.has(section)) {
      res.status(400).json({ error: "invalid section" });
      return;
    }
    if (!Array.isArray(data)) {
      res.status(400).json({ error: "data must be array" });
      return;
    }
    const finance = loadFinance();
    (finance as unknown as Record<string, unknown>)[section] = data;
    finance.snapshotDate = new Date().toISOString().slice(0, 10);
    saveFinance(finance);
    res.json({ ok: true });
  });

  app.post("/api/finance/milestones/:id/toggle", (req, res) => {
    const id = req.params.id;
    const data = loadFinance();
    const m = data.milestones.find((x) => x.id === id);
    if (!m) {
      res.status(404).json({ error: "milestone not found" });
      return;
    }
    const desired =
      typeof req.body?.done === "boolean" ? req.body.done : !m.done;
    m.done = desired;
    saveFinance(data);
    res.json({ id: m.id, done: m.done });
  });

  app.get("/api/finance/recommend", (req, res) => {
    const data = loadFinance();
    const metrics = computeMetrics(data);
    const amount = parseFloat(String(req.query.amount ?? ""));
    const safeAmount =
      Number.isFinite(amount) && amount >= 0 ? amount : metrics.freeCashUsd;
    const plan = recommendAllocation(metrics, safeAmount);
    res.json(plan);
  });

  app.get("/receipts", (_req, res) => {
    const store = loadReceipts();
    const cash = loadExpenses();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderReceiptsPage(
        store.receipts,
        computeReceiptStats(store),
        cash.expenses,
        computeCashStats(cash),
        cash.presets,
        loadFinance().monthlyLifeCostUsd,
      ),
    );
  });

  app.get("/api/expenses", (_req, res) => {
    const cash = loadExpenses();
    res.json({ ...cash, stats: computeCashStats(cash) });
  });

  app.post("/api/expenses", (req, res) => {
    const b = req.body ?? {};
    const amount = Number(b.amount);
    const currency = String(b.currency ?? "RUP") as Currency;
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "Сумма должна быть числом больше нуля" });
      return;
    }
    if (!["RUP", "MDL", "USD", "EUR"].includes(currency)) {
      res.status(400).json({ error: `Неизвестная валюта: ${currency}` });
      return;
    }
    try {
      const expense = addExpense({
        amount,
        currency,
        category: String(b.category ?? "Прочее"),
        date: typeof b.date === "string" ? b.date : undefined,
        note: typeof b.note === "string" ? b.note : undefined,
        presetId: typeof b.presetId === "string" ? b.presetId : undefined,
      });
      res.json({ ok: true, expense });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/api/expenses/:id", (req, res) => {
    if (!deleteExpense(req.params.id)) {
      res.status(404).json({ error: "Запись не найдена" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/api/receipts", (_req, res) => {
    const store = loadReceipts();
    res.json({ ...store, stats: computeReceiptStats(store) });
  });

  app.post("/api/receipts", async (req, res) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ error: "Нужна ссылка на чек" });
      return;
    }
    try {
      const { receipt, duplicate } = await addReceiptFromUrl(url);
      logger.info(
        `[Receipts] ${duplicate ? "Updated" : "Added"} ${receipt.merchant} ${receipt.date}: ` +
          `${receipt.items.length} items, ${receipt.total} ${receipt.currency}`,
      );
      res.json({ ok: true, duplicate, receipt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("[Receipts] Add failed", err);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/receipts/:id", (req, res) => {
    const store = loadReceipts();
    const before = store.receipts.length;
    store.receipts = store.receipts.filter((r) => r.id !== req.params.id);
    if (store.receipts.length === before) {
      res.status(404).json({ error: "Чек не найден" });
      return;
    }
    saveReceipts(store);
    res.json({ ok: true });
  });

  app.get("/api/high-apy", (_req, res) => {
    const state = loadState();
    res.json(state.highApyProducts ?? []);
  });

  app.post("/api/apply-strategy", (req, res) => {
    const validIds = new Set<StrategyId>([
      "conservative",
      "moderate",
      "aggressive",
    ]);
    const id = req.body?.id as string;
    if (!id || !validIds.has(id as StrategyId)) {
      res.status(400).json({ error: "Invalid strategy id" });
      return;
    }
    const state = loadState();
    state.activeStrategy = id as StrategyId;
    saveState(state);
    logger.info(`[Web] Strategy changed to: ${id}`);
    res.json({ ok: true, activeStrategy: id });
  });

  let refreshing = false;
  app.post("/api/refresh", async (_req, res) => {
    if (!onRefresh) {
      res.status(503).json({ error: "Refresh not available" });
      return;
    }
    if (refreshing) {
      res.status(429).json({ error: "Refresh already in progress" });
      return;
    }
    refreshing = true;
    try {
      logger.info("[Web] Manual refresh triggered");
      await onRefresh();
      res.json({ ok: true });
    } catch (err) {
      logger.error("[Web] Manual refresh failed", err);
      res.status(500).json({ error: "Refresh failed" });
    } finally {
      refreshing = false;
    }
  });

  app.listen(config.web.port, () => {
    logger.info(
      `[Web] Dashboard running at http://localhost:${config.web.port}`,
    );
  });
}

function renderDashboard(
  result: OptimizationResult | null,
  lastUpdated: string | null,
  highApyProducts: HighApyProduct[],
  activeStrategy: StrategyId,
): string {
  const demo = config.demoMode
    ? '<span class="badge demo">DEMO MODE</span>'
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EarnOptimizer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1d27 0%, #16191f 100%);
      color: #e0e0e0;
      line-height: 1.6;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding: 20px;
      background: rgba(76, 175, 130, 0.1);
      border: 1px solid #4caf82;
      border-radius: 8px;
    }
    h1 {
      font-size: 2.2rem;
      color: #4caf82;
      font-weight: 700;
    }
    .badge {
      display: inline-block;
      padding: 6px 12px;
      background: #ff6b6b;
      border-radius: 4px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .section {
      background: #252836;
      border: 1px solid #3a3f4d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #1a1d27;
      border-radius: 6px;
      overflow: hidden;
    }
    thead {
      background: #2a2d37;
    }
    th, td {
      padding: 12px 16px;
      text-align: left;
      border-bottom: 1px solid #3a3f4d;
    }
    th {
      color: #4caf82;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 0.9rem;
    }
    tr:hover {
      background: #2a2d37;
    }
    .green {
      color: #4caf82;
    }
    .muted {
      color: #888;
    }
    input[type="number"] {
      background: #252836;
      border: 2px solid #4caf82;
      border-radius: 8px;
      color: #fff;
      padding: 12px 16px;
      font-size: 1.2rem;
      width: 100%;
      max-width: 350px;
      font-weight: 600;
    }
    input[type="number"]:focus {
      outline: none;
      border-color: #66bb6a;
      box-shadow: 0 0 8px rgba(76, 175, 130, 0.3);
    }
    button {
      background: #4caf82;
      border: none;
      border-radius: 6px;
      color: #000;
      padding: 8px 14px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #66bb6a;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div><h1>💼 EarnOptimizer</h1></div>
      <div style="display:flex;align-items:center;gap:12px">
        ${demo}
        <a href="/" style="color:#4caf82;text-decoration:none;padding:6px 12px;border:1px solid #4caf82;border-radius:6px;font-weight:600;background:#4caf82;color:#000">📈 Earn</a>
        <a href="/finance" style="color:#4caf82;text-decoration:none;padding:6px 12px;border:1px solid #4caf82;border-radius:6px;font-weight:600">💼 Финансы</a>
        <a href="/receipts" style="color:#4caf82;text-decoration:none;padding:6px 12px;border:1px solid #4caf82;border-radius:6px;font-weight:600">🧾 Чеки</a>
      </div>
    </header>
    ${renderMainStats(result)}
    ${renderAllocationTable(result)}
    ${renderScalingCalculator(result)}
    <footer style="text-align:center;margin-top:40px;color:#666;font-size:0.9rem">
      ${lastUpdated ? `Last updated: ${lastUpdated}` : "Never updated"}
    </footer>
  </div>
</body>
</html>`;
}

function renderMainStats(result: OptimizationResult | null): string {
  if (!result) {
    return '<div class="section muted">Waiting for first optimization run...</div>';
  }
  return `
  <div class="section">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px">
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">💰 Total Capital</div>
        <div style="font-size:1.8rem;color:#4caf82;font-weight:700">${fmt(result.totalCapital)}</div>
        <div style="font-size:0.8rem;color:#666">Earn: ${fmt(result.totalCapital - result.availableCapital)} | Spot: ${fmt(result.availableCapital)}</div>
      </div>
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">📈 Current APY</div>
        <div style="font-size:1.8rem;color:#4caf82;font-weight:700">${fmt(result.currentWeightedApy * 100, 2)}%</div>
        <div style="font-size:0.8rem;color:#666">Weighted across positions</div>
      </div>
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">🚀 Conservative APY</div>
        <div style="font-size:1.8rem;color:#4caf82;font-weight:700">${fmt(result.optimalWeightedApy * 100, 2)}%</div>
        <div style="font-size:0.8rem;color:#666">Stablecoins only</div>
      </div>
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">💵 Annual Gain</div>
        <div style="font-size:1.8rem;color:#4caf82;font-weight:700">${fmt(result.estimatedAnnualGain)}</div>
        <div style="font-size:0.8rem;color:#666">At optimal allocation</div>
      </div>
    </div>
  </div>`;
}

function renderAllocationTable(result: OptimizationResult | null): string {
  if (!result?.optimalAllocation?.length) {
    return '<div class="section muted">No allocation data</div>';
  }
  const rows = result.optimalAllocation
    .map((slot) => {
      const annual = slot.amount * slot.apy;
      return `
        <tr>
          <td>${slot.exchange.toUpperCase()}</td>
          <td><b>${slot.asset}</b></td>
          <td>${slot.productName}</td>
          <td>${fmt(slot.amount)}</td>
          <td class="green">${fmt(slot.apy * 100, 2)}%</td>
          <td>${fmt(annual / 365, 2)}</td>
          <td>${fmt(annual / 12, 2)}</td>
          <td>${fmt(annual, 2)}</td>
        </tr>`;
    })
    .join("");
  const totalAnnual = result.optimalAllocation.reduce(
    (sum, s) => sum + s.amount * s.apy,
    0,
  );
  return `
  <div class="section">
    <h3 style="margin-bottom:12px;color:#4caf82">Optimal Allocation</h3>
    <table>
      <thead>
        <tr><th>Биржа</th><th>Актив</th><th>Продукт</th><th>Сумма</th><th>APY</th><th>Доход/день</th><th>Доход/мес</th><th>Доход/год</th></tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot style="border-top:2px solid #4caf82;font-weight:700">
        <tr><td colspan="3">Итого</td><td>${fmt(result.totalCapital)}</td><td class="green">${fmt((totalAnnual / result.totalCapital) * 100, 2)}%</td><td>${fmt(totalAnnual / 365, 2)}</td><td>${fmt(totalAnnual / 12, 2)}</td><td>${fmt(totalAnnual, 2)}</td></tr>
      </tfoot>
    </table>
  </div>`;
}

function renderScalingCalculator(result: OptimizationResult | null): string {
  if (!result?.optimalAllocation?.length) {
    return '<div class="section muted">No data for calculator</div>';
  }

  const slotsData = result.optimalAllocation.map((s) => ({
    name: s.productName,
    asset: s.asset ?? "USDT",
    exchange: s.exchange.toUpperCase(),
    apy: s.apy,
    baseAmount: s.amount,
    baseTotalCapital: result.totalCapital,
    tiers: s.tiers || [],
  }));

  return `
  <div class="section">
    <div style="margin-bottom:20px">
      <label style="font-size:1.1rem;color:#4caf82;font-weight:600;display:block;margin-bottom:10px">💰 Рассчитать доход для любой суммы:</label>
      <input id="calcInput" type="number" value="${Math.round(result.totalCapital)}" min="100" step="100"
        oninput="calcScale()" placeholder="Введите сумму в USDT"/>
      <div style="font-size:.85rem;color:#888;margin-top:6px">Система автоматически распределит капитал по лучшим предложениям</div>
    </div>
    <div style="margin-bottom:16px">
      <div style="color:#999;font-size:.9rem;margin-bottom:8px">📌 Популярные суммы:</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${[1000, 2000, 5000, 10000, 20000, 50000, 100000]
        .map(
          (v) =>
            `<button onclick="document.getElementById('calcInput').value=${v};calcScale()">${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}</button>`,
        )
        .join("")}
      </div>
    </div>
    <div id="calcResult"></div>
    <div id="calcGoal" style="margin-top:16px"></div>
  </div>
  <script>
    const _slots = ${JSON.stringify(slotsData)};
    const _hasSplitProducts = (() => {
      const seen = new Set();
      for (const s of _slots) {
        const key = s.exchange + '|' + s.asset + '|' + s.name;
        if (seen.has(key)) return true;
        seen.add(key);
      }
      return false;
    })();
    function calcIncomeWithTiers(amount, tiers) {
      if (!tiers || tiers.length === 0) return amount * 0.04;
      let income = 0, remaining = amount;
      for (const tier of tiers) {
        if (remaining <= 0) break;
        const tierSize = tier.maxAmount === null ? remaining : Math.max(0, Math.min(tier.maxAmount - tier.minAmount, remaining));
        if (tierSize <= 0) continue;
        income += tierSize * tier.apy;
        remaining -= tierSize;
      }
      return income;
    }
    function annualForSlot(sl, cap) {
      if (_hasSplitProducts) return cap * sl.apy;
      if (sl.tiers && sl.tiers.length > 0) {
        let annual = 0;
        let amt = cap;
        for (const tier of sl.tiers) {
          if (amt <= 0) break;
          const sz = tier.maxAmount === null ? amt : Math.max(0, Math.min(tier.maxAmount - tier.minAmount, amt));
          if (sz <= 0) continue;
          annual += sz * tier.apy;
          amt -= sz;
        }
        return annual;
      }
      return cap * sl.apy;
    }
    function calcScale() {
      const capital = parseFloat(document.getElementById('calcInput').value) || 0;
      if (capital <= 0) { document.getElementById('calcResult').innerHTML = ''; document.getElementById('calcGoal').innerHTML = ''; return; }

      const amounts = optimalAllocate(capital);
      let apyNum = 0;
      const rows = [];
      for (let i = 0; i < _slots.length; i++) {
        const cap = amounts[i];
        if (cap < 0.01) continue;
        const sl = _slots[i];
        const annual = annualForSlot(sl, cap);
        const effectiveApy = cap > 0 ? annual / cap : sl.apy;
        apyNum += annual;
        rows.push('<tr><td>'+sl.exchange+'</td><td><b>'+sl.asset+'</b></td><td>'+sl.name+'</td><td>'+f(cap,2)+'</td><td class="green">'+f(effectiveApy*100,2)+'%</td><td>'+f(annual/365,2)+'</td><td>'+f(annual/12,2)+'</td><td>'+f(annual,2)+'</td></tr>');
      }

      const totalApy = capital > 0 ? apyNum / capital : 0;
      const tfoot = '<tfoot style="border-top:2px solid #4caf82;font-weight:700"><tr><td colspan="3">Итого</td><td>'+f(capital)+'</td><td class="green">'+f(totalApy*100,2)+'%</td><td>'+f(apyNum/365,2)+'</td><td>'+f(apyNum/12,2)+'</td><td>'+f(apyNum,2)+'</td></tr></tfoot>';
      document.getElementById('calcResult').innerHTML =
        '<table><thead><tr><th>Биржа</th><th>Актив</th><th>Продукт</th><th>Сумма</th><th>APY</th><th>Доход/день</th><th>Доход/мес</th><th>Доход/год</th></tr></thead><tbody>'+rows.join('')+'</tbody>'+tfoot+'</table>';
      const targets = [500, 1000, 1500, 2000, 3000, 5000];
      let goalHtml = '<div style="margin-top:8px"><div style="font-size:.9rem;color:#aaa;margin-bottom:8px">💰 Сколько нужно капитала для пассивного дохода:</div>';
      goalHtml += '<table><thead><tr><th>Цель / мес</th><th>Цель / год</th><th>Нужен капитал</th><th>APY при этом</th><th>Доход / день</th></tr></thead><tbody>';
      for (const monthlyGoal of targets) {
        const yearlyGoal = monthlyGoal * 12;
        const needed = findCapital(yearlyGoal);
        const nApy = calcApy(needed);
        goalHtml += '<tr><td><b>\$'+f(monthlyGoal)+'</b></td><td>\$'+f(yearlyGoal)+'</td><td class="green"><b>\$'+f(needed)+'</b></td><td>'+f(nApy*100,2)+'%</td><td>\$'+f(yearlyGoal/365,2)+'</td></tr>';
      }
      goalHtml += '</tbody></table></div>';
      document.getElementById('calcGoal').innerHTML = goalHtml;
    }
    // Smart allocation: fill bonus tiers first (sorted by APY desc), then diversify remainder across base tiers
    function optimalAllocate(capital) {
      const amounts = new Array(_slots.length).fill(0);
      // Build flat list of bonus tiers (bounded) and base tiers (unbounded)
      const bonuses = [];   // {slotIdx, size, apy}
      const baseTiers = []; // {slotIdx, apy}
      for (let i = 0; i < _slots.length; i++) {
        const sl = _slots[i];
        const tiers = (sl.tiers && sl.tiers.length > 0) ? sl.tiers : [{minAmount:0, maxAmount:null, apy:sl.apy}];
        let baseApy = sl.apy;
        for (const t of tiers) {
          if (t.maxAmount === null) baseApy = t.apy;
        }
        for (const t of tiers) {
          if (t.maxAmount === null) {
            baseTiers.push({slotIdx: i, apy: t.apy});
          } else if (t.apy > baseApy) {
            // Only treat as bonus if APY is actually higher than base tier
            const size = t.maxAmount - t.minAmount;
            if (size > 0) bonuses.push({slotIdx: i, size, apy: t.apy});
          }
        }
      }
      // Greedy fill bonus tiers by APY desc
      bonuses.sort((a, b) => b.apy - a.apy);
      let remaining = capital;
      for (const b of bonuses) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, b.size);
        amounts[b.slotIdx] += take;
        remaining -= take;
      }
      // Distribute remainder across base tiers — diversified weighted by APY
      // Use APY-weighted distribution so higher APY products get more, but all participate
      if (remaining > 0 && baseTiers.length > 0) {
        // Filter out near-zero APY base tiers (they'd just waste capital)
        const useful = baseTiers.filter(t => t.apy > 0.005); // > 0.5% APY
        const list = useful.length > 0 ? useful : baseTiers;
        // APY-weighted with floor: each gets minimum 5%, rest by APY weight
        const minSharePct = 0.05;
        const minShare = remaining * minSharePct;
        const reservedFloor = minShare * list.length;
        const weightedPool = Math.max(0, remaining - reservedFloor);
        const totalApy = list.reduce((s, t) => s + t.apy, 0);
        for (const t of list) {
          const weighted = totalApy > 0 ? weightedPool * (t.apy / totalApy) : weightedPool / list.length;
          amounts[t.slotIdx] += minShare + weighted;
        }
      }
      return amounts;
    }
    function calcApy(cap) {
      if (cap <= 0) return 0;
      const amounts = optimalAllocate(cap);
      let apyN = 0;
      for (let i = 0; i < _slots.length; i++) {
        if (amounts[i] < 0.01) continue;
        apyN += annualForSlot(_slots[i], amounts[i]);
      }
      return apyN / cap;
    }
    function findCapital(yearlyGoal) {
      if (yearlyGoal <= 0) return 0;
      // Binary search: find capital needed for yearlyGoal annual income
      let lo = 0, hi = yearlyGoal / 0.01; // assume at worst 1% APY, need 100x goal in capital
      for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        const apy = calcApy(mid);
        const earn = mid * apy;
        if (earn < yearlyGoal) lo = mid;
        else hi = mid;
      }
      return Math.ceil(hi / 100) * 100;
    }
    function f(n, d) { d = d ?? 0; return n.toLocaleString('ru-RU', {minimumFractionDigits:d, maximumFractionDigits:d}); }
    calcScale();
  </script>`;
}
