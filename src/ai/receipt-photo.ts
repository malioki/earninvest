import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { logger } from "../utils/logger.js";
import { FALLBACK, MODEL, getClient } from "./client.js";

// Photos of receipts the QR route can't handle — Moldovan chains, whose
// verifier site is closed to scripts. Claude reads the photo into a strict
// schema; the bot then shows the result for a human check before saving.

const ReceiptSchema = z.object({
  isReceipt: z.boolean().describe("false if the photo is not a shop receipt"),
  store: z.string().describe("Chain name if recognisable (Linella, Kaufland, METRO, Casa Europeana, Local, Шериф), else the shop name printed on the receipt"),
  address: z.string().nullable(),
  date: z.string().nullable().describe("YYYY-MM-DD"),
  time: z.string().nullable().describe("HH:MM"),
  // A plain string, normalised below: the SDK can only pass an enum to the API
  // as a hint, and a stray "lei" would otherwise fail validation of the whole receipt.
  currency: z.string().describe("MDL for Moldova (lei), RUP for Transnistria (ПМР roubles)"),
  total: z.number().describe("Receipt grand total (TOTAL / ИТОГО / SUMA)"),
  items: z.array(
    z.object({
      name: z.string().describe("Item name exactly as printed, not translated"),
      qty: z.number().describe("Quantity; for weighed goods the weight in kg"),
      unitPrice: z.number().nullable(),
      total: z.number().describe("Line total; discounts as negative lines"),
    }),
  ),
  unreadable: z.string().nullable().describe("What could not be read, if anything"),
});

export type ReceiptPhoto = z.infer<typeof ReceiptSchema>;

const SYSTEM = `Ты разбираешь фото кассового чека из магазина в Молдове или Приднестровье и возвращаешь данные строго по схеме.

Правила:
- Названия позиций переписывай как на чеке (румынский, русский, сокращения), без перевода и исправлений.
- qty — количество; у весового товара (кг) — вес, дробное число. total — сумма строки после скидки на строку.
- Отдельные строки скидок (Reducere, Discount, Скидка), если они относятся ко всему чеку, — отдельной позицией с отрицательной суммой.
- Не включай в позиции итоги, НДС (TVA), оплату картой/наличными и сдачу.
- currency: MDL, если суммы в леях (Молдова); RUP — рубли ПМР.
- Не выдумывай: если строку или цифру не разобрать, не угадывай — опиши это в unreadable.`;

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export async function readReceiptPhoto(image: Buffer, mediaType: ImageType): Promise<ReceiptPhoto> {
  const response = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    betas: [...FALLBACK.betas],
    output_config: { effort: "medium", format: betaZodOutputFormat(ReceiptSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image.toString("base64") } },
          { type: "text", text: "Разбери этот чек." },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("Не получилось разобрать это фото.");
  if (response.stop_reason === "max_tokens") throw new Error("Чек слишком длинный — сфотографируй частями.");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Не удалось прочитать чек — попробуй фото чётче.");
  const currency = normaliseCurrency(parsed.currency);
  logger.info(`[AI] Receipt photo: ${parsed.store}, ${parsed.items.length} items, ${parsed.total} ${currency} (${response.usage.input_tokens} in / ${response.usage.output_tokens} out)`);
  return { ...parsed, currency };
}

/** "lei", "MDL", "руб", "RUP" … → MDL | RUP | USD | EUR (Moldova by default). */
export function normaliseCurrency(raw: string): string {
  const c = raw.toLowerCase();
  if (/rup|руб|пмр|pmr/.test(c)) return "RUP";
  if (/usd|\$|dol/.test(c)) return "USD";
  if (/eur|€/.test(c)) return "EUR";
  return "MDL";
}
