import express from "express";
import { config } from "../config/index.js";
import { loadState } from "../state/index.js";
import { logger } from "../utils/logger.js";
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
import {
  buildMonthReport,
  buildWeekReport,
  collectEntries,
  rubPerUsd,
  todayLocal,
  variableBudgetUsd,
  weekOfMonth,
  weekStart,
} from "../spending/index.js";
import {
  addCustomItem,
  availablePeriods,
  createList,
  deleteList,
  loadShopping,
  regenerateList,
  removeItem,
  toggleItem,
  validateSource,
} from "../shopping/index.js";
import { renderShoppingPage } from "./shopping-page.js";
import { loadSnapshots, takeSnapshot } from "../finance/snapshots.js";
import { saveFinance } from "../finance/index.js";
import { isStablecoin } from "../types/index.js";

export function startWebServer(): void {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // The Earn dashboard is a separate app (npm run dev:earn); this one opens on finances.
  app.get("/", (_req, res) => res.redirect("/finance"));

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
    const entries = collectEntries(store, cash);
    const today = todayLocal();
    const budget = variableBudgetUsd();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderReceiptsPage(
        store.receipts,
        computeReceiptStats(store),
        cash.expenses,
        computeCashStats(cash),
        cash.presets,
        budget,
        buildWeekReport(entries, weekStart(today), today),
        buildMonthReport(entries, today.slice(0, 7), today, budget),
        rubPerUsd(),
      ),
    );
  });

  // ── Shopping lists ──────────────────────────────────────────────────────

  app.get("/shopping", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      renderShoppingPage(
        loadShopping().lists,
        availablePeriods(loadReceipts().receipts),
        weekOfMonth(weekStart(todayLocal())).n,
      ),
    );
  });

  app.get("/api/shopping", (_req, res) => {
    res.json(loadShopping());
  });

  /** Wraps a list mutation: 400 with the human-readable message on failure. */
  const shoppingAction =
    (fn: (req: express.Request) => unknown) =>
    (req: express.Request, res: express.Response) => {
      try {
        res.json({ ok: true, list: fn(req) });
      } catch (err) {
        res
          .status(400)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    };
  const bodyStr = (req: express.Request, field: string): string =>
    typeof req.body?.[field] === "string" ? req.body[field] : "";

  app.post(
    "/api/shopping",
    shoppingAction((req) => createList(validateSource(req.body?.source))),
  );
  app.post(
    "/api/shopping/:id/regenerate",
    shoppingAction((req) => regenerateList(String(req.params.id))),
  );
  app.post(
    "/api/shopping/:id/toggle",
    shoppingAction((req) => toggleItem(String(req.params.id), bodyStr(req, "key"))),
  );
  app.post(
    "/api/shopping/:id/items",
    shoppingAction((req) => addCustomItem(String(req.params.id), bodyStr(req, "name"))),
  );
  app.post(
    "/api/shopping/:id/remove",
    shoppingAction((req) => removeItem(String(req.params.id), bodyStr(req, "key"))),
  );
  app.delete("/api/shopping/:id", (req, res) => {
    if (!deleteList(req.params.id)) {
      res.status(404).json({ error: "Список не найден" });
      return;
    }
    res.json({ ok: true });
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

  app.listen(config.web.port, () => {
    logger.info(`[Web] Family app running at ${config.web.url}`);
  });
}
