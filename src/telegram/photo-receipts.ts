import axios from "axios";
import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { logger } from "../utils/logger.js";
import { aiEnabled } from "../ai/client.js";
import { readReceiptPhoto } from "../ai/receipt-photo.js";
import type { ImageType, ReceiptPhoto } from "../ai/receipt-photo.js";
import { saveReceiptFromPhoto } from "../receipts/index.js";
import { todayLocal } from "../spending/index.js";
import { btn, errMsg, esc, show } from "./ui.js";

// Receipt photo → Claude → preview → "✅ Сохранить". Meant for Moldovan
// chains (no machine-readable QR for us), works for any readable receipt.

/** The API takes images up to 5 MB. */
const MAX_BYTES = 5 * 1024 * 1024;
const DRAFT_TTL_MS = 30 * 60_000;
const SUPPORTED: Record<string, ImageType> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

/** Swappable in tests: Telegram download and the AI call. */
export const photoDeps = {
  async download(ctx: Context, fileId: string): Promise<Buffer> {
    const link = await ctx.telegram.getFileLink(fileId);
    const res = await axios.get<ArrayBuffer>(link.toString(), { responseType: "arraybuffer", timeout: 30_000 });
    return Buffer.from(res.data);
  },
  read: readReceiptPhoto,
};

const drafts = new Map<string, { photo: ReceiptPhoto; userId: number; until: number }>();

const money = (n: number): string => n.toFixed(2).replace(".", ",");
const cur = (c: string): string => (c === "MDL" ? "лей" : c === "RUP" ? "руб" : c);

function preview(p: ReceiptPhoto): string {
  const itemSum = p.items.reduce((s, i) => s + i.total, 0);
  const lines = [
    "🧾 <b>Распознал чек — проверь</b>",
    `${esc(p.store)} · ${p.date ? `${p.date.slice(8, 10)}.${p.date.slice(5, 7)}.${p.date.slice(0, 4)}` : "дата не видна — поставлю сегодня"}${p.time ? " " + esc(p.time) : ""}`,
    "",
  ];
  for (const i of p.items.slice(0, 40)) {
    const qty = Math.abs(i.qty - Math.round(i.qty)) > 1e-6 ? `${i.qty} кг` : `${i.qty} ×`;
    lines.push(`• ${esc(i.name)} — ${i.qty === 1 ? "" : `${qty} `}${money(i.total)}`);
  }
  if (p.items.length > 40) lines.push(`…и ещё ${p.items.length - 40} поз.`);
  lines.push("", `<b>Итого: ${money(p.total)} ${cur(p.currency)}</b>`);
  lines.push(
    Math.abs(itemSum - p.total) <= 0.05
      ? "✓ Сумма позиций сходится с итогом"
      : `⚠️ Сумма позиций ${money(itemSum)} не сходится с итогом — что-то прочиталось неверно. Можно сохранить как есть или переснять.`,
  );
  if (p.unreadable) lines.push(`⚠️ Не разобрал: ${esc(p.unreadable)}`);
  return lines.join("\n");
}

async function handleImage(ctx: Context, fileId: string, mime: string, size?: number): Promise<void> {
  if (!aiEnabled()) {
    await ctx.reply(
      "📷 Фото чеков распознаёт ИИ, а он пока не подключён: нужен ANTHROPIC_API_KEY в .env.\n" +
        "Пока можно записать покупку строкой: <code>Linella молоко 2 шт 36 лей</code>",
      { parse_mode: "HTML" },
    );
    return;
  }
  const mediaType = SUPPORTED[mime];
  if (!mediaType) {
    await ctx.reply("Этот формат не прочитаю — пришли фото как обычное изображение (JPG/PNG).");
    return;
  }
  if (size && size > MAX_BYTES) {
    await ctx.reply("Файл больше 5 МБ — пришли его как обычное фото, не файлом.");
    return;
  }
  await ctx.sendChatAction("typing").catch(() => undefined);
  try {
    const image = await photoDeps.download(ctx, fileId);
    if (image.length > MAX_BYTES) {
      await ctx.reply("Фото больше 5 МБ — пришли его как обычное фото, не файлом.");
      return;
    }
    const photo = await photoDeps.read(image, mediaType);
    if (!photo.isReceipt || photo.items.length === 0) {
      await ctx.reply("Это не похоже на чек 🤔 Сфотографируй чек целиком, ровно и при хорошем свете.");
      return;
    }
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    drafts.set(id, { photo, userId: ctx.from!.id, until: Date.now() + DRAFT_TTL_MS });
    await show(ctx, preview(photo), [[btn("✅ Сохранить", `rcok:${id}`), btn("❌ Отмена", `rcno:${id}`)]]);
  } catch (err) {
    logger.error("[Telegram] Receipt photo failed", err);
    await ctx.reply(`Не смог разобрать фото: ${errMsg(err)}`);
  }
}

export function registerPhotoReceipts(b: Telegraf): void {
  b.on(message("photo"), (ctx) => {
    // Telegram sends several sizes; the last is the largest.
    const best = ctx.message.photo.at(-1)!;
    return handleImage(ctx, best.file_id, "image/jpeg", best.file_size);
  });
  // Sent "as a file" — uncompressed, better for small receipt print.
  b.on(message("document"), (ctx) => {
    const d = ctx.message.document;
    if (!d.mime_type?.startsWith("image/")) return ctx.reply("Пришли фото чека — файлы другого типа я не читаю.");
    return handleImage(ctx, d.file_id, d.mime_type, d.file_size);
  });

  b.action(/^rcok:(.+)$/, async (ctx) => {
    const d = drafts.get(ctx.match[1]!);
    if (!d || d.until < Date.now()) return ctx.answerCbQuery("Черновик устарел — пришли фото ещё раз", { show_alert: true });
    drafts.delete(ctx.match[1]!);
    const p = d.photo;
    const { receipt, duplicate } = saveReceiptFromPhoto({
      store: p.store, address: p.address, date: p.date ?? todayLocal(), time: p.time,
      currency: p.currency, total: p.total, items: p.items,
    });
    logger.info(`[Telegram] Photo receipt ${duplicate ? "updated" : "saved"} by ${ctx.from.first_name}: ${receipt.merchant} ${receipt.total} ${receipt.currency}`);
    await show(ctx,
      `🧾 <b>Чек ${duplicate ? "обновлён" : "сохранён"}</b>: ${esc(receipt.merchant)}, ${money(receipt.total)} ${cur(receipt.currency)} · ${receipt.items.length} поз.\n` +
        "<i>Попал в траты и в сравнение цен.</i>",
      [[btn("🏪 Где дешевле", "m:cheaper")]]);
    await ctx.answerCbQuery("Сохранено");
  });

  b.action(/^rcno:(.+)$/, async (ctx) => {
    drafts.delete(ctx.match[1]!);
    await show(ctx, "❌ Не сохранил. Можно переснять чек и прислать ещё раз.");
    await ctx.answerCbQuery();
  });
}
