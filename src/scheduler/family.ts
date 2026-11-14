import fs from "node:fs";
import cron from "node-cron";
import { DATA_FILE as PORTFOLIO_FILE, load as loadPortfolio } from "../portfolio/index.js";
import { portfolioReminder } from "../portfolio/reminders.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { loadFinance } from "../finance/index.js";
import { takeSnapshotIfDue } from "../finance/snapshots.js";
import { formatReminder, paymentsDueOn } from "../finance/schedule.js";
import { updateRates, updateRatesIfStale } from "../finance/rates.js";
import {
  addDays,
  previousWeekDigest,
  monthDigest,
  previousMonth,
  todayLocal,
} from "../spending/index.js";
import { sendDocumentTo, sendToFamily } from "../telegram/send.js";
import { backupCaption, backupRecipients, buildBackup, markSent } from "../backup/index.js";

/** Jobs of the family app — none of them touch an exchange. */
export function startFamilyScheduler(): void {
  const snapshot = (label: string) => {
    try {
      const snap = takeSnapshotIfDue(7);
      if (snap) logger.info(`[Scheduler] Weekly finance snapshot taken: ${snap.date}`);
    } catch (err) {
      logger.error(`[Scheduler] ${label} snapshot failed`, err);
    }
  };

  // Daily check that triggers a finance snapshot if the last one is ≥ 7 days old.
  cron.schedule("0 8 * * *", () => snapshot("Daily"));

  // Sent even when nothing was logged: the "empty week" message is the nudge
  // that keeps the tracker alive.
  cron.schedule(config.scheduler.weeklySpendingCron, async () => {
    try {
      await sendToFamily(previousWeekDigest());
    } catch (err) {
      logger.error("[Scheduler] Weekly spending digest failed", err);
    }
  });
  cron.schedule(config.scheduler.monthlySpendingCron, async () => {
    try {
      await sendToFamily(monthDigest(previousMonth()));
    } catch (err) {
      logger.error("[Scheduler] Monthly spending digest failed", err);
    }
  });

  // The evening before a credit payment — one missed payment costs a week of
  // penalties and a credit-bureau warning.
  cron.schedule(config.scheduler.paymentReminderCron, async () => {
    try {
      const due = paymentsDueOn(loadFinance(), addDays(todayLocal(), 1));
      if (due.length > 0) await sendToFamily(formatReminder(due));
    } catch (err) {
      logger.error("[Scheduler] Payment reminder failed", err);
    }
  });

  // BNM publishes the day's rates in the morning; PRB likewise.
  cron.schedule(config.scheduler.ratesCron, async () => {
    try {
      await updateRates();
    } catch (err) {
      logger.warn("[Scheduler] Rates update failed", err);
    }
  });
  void updateRatesIfStale();

  // Portfolio: the 15th (contribution, quarterly IBKR transfer), a week before the yearly
  // review, the review day. Silent on other days and when no portfolio is set up.
  cron.schedule(config.scheduler.portfolioReminderCron, async () => {
    try {
      if (!fs.existsSync(PORTFOLIO_FILE)) return;
      const text = portfolioReminder(loadPortfolio(), todayLocal());
      if (text) await sendToFamily(text);
    } catch (err) {
      logger.error("[Scheduler] Portfolio reminder failed", err);
    }
  });

  // data/ isn't in git — a weekly zip in Telegram is the off-machine copy.
  cron.schedule(config.scheduler.backupCron, async () => {
    try {
      const to = backupRecipients();
      if (to.length === 0) return;
      const b = buildBackup();
      for (const id of to) await sendDocumentTo(id, b.buffer, b.filename, backupCaption(b));
      markSent();
    } catch (err) {
      logger.error("[Scheduler] Backup failed", err);
    }
  });

  logger.info(
    `[Scheduler] Digests: weekly "${config.scheduler.weeklySpendingCron}", monthly "${config.scheduler.monthlySpendingCron}"; ` +
      `payment reminders "${config.scheduler.paymentReminderCron}" → ${config.telegram.financeIds.length} recipient(s)`,
  );

  snapshot("Initial");
}
