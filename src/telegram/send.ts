import { Telegram } from "telegraf";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

let client: Telegram | null = null;

/**
 * Send-only client. Both apps notify the same chat, but only the family app
 * polls for updates: two processes long-polling one bot token make Telegram
 * kick one of them off with 409 Conflict, and the bot goes deaf.
 */
async function sendTo(chatId: string, text: string): Promise<void> {
  if (!config.telegram.botToken) return;
  try {
    client ??= new Telegram(config.telegram.botToken);
    await client.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (err) {
    logger.error(`[Telegram] sendMessage to ${chatId} failed`, err);
  }
}

/** A file (the data/ backup). Throws, so a failed backup is noticed, not swallowed. */
export async function sendDocumentTo(chatId: string, data: Buffer, filename: string, caption?: string): Promise<void> {
  if (!config.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  client ??= new Telegram(config.telegram.botToken);
  await client.sendDocument(chatId, { source: data, filename }, caption ? { caption } : {});
  logger.info(`[Telegram] Sent ${filename} (${data.length} B) to ${chatId}`);
}

/** To TELEGRAM_CHAT_ID — Earn optimizer reports. */
export async function sendMessage(text: string): Promise<void> {
  if (config.telegram.chatId) await sendTo(config.telegram.chatId, text);
}

/** To everyone in TELEGRAM_FINANCE_IDS — family digests and payment reminders. */
export async function sendToFamily(text: string): Promise<void> {
  for (const id of new Set(config.telegram.financeIds)) await sendTo(id, text);
}
