import type { Context, Telegraf } from "telegraf";
import { deleteExpense } from "../expenses/index.js";
import { STORES, storeById, storePrefix } from "../prices/catalog.js";
import type { Store } from "../prices/catalog.js";
import { addPurchase, deletePurchase, formatComparison, parsePurchase } from "../prices/index.js";
import { loadShopping } from "../shopping/index.js";
import { setPending } from "./pending.js";
import { back, btn, errMsg, esc, show } from "./ui.js";
import type { Rows } from "./ui.js";

// 📝 Покупки: the shopping list, "where is it cheaper", and purchases that
// come without a readable receipt (market, Moldovan chains).

export function shoppingHome(ctx: Context): Promise<void> {
  const latest = [...loadShopping().lists].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const rows: Rows = [
    [btn(latest ? `📋 Список: ${latest.title.slice(0, 30)}` : "📋 Собрать список покупок", "m:list")],
    [btn("🏪 Где дешевле", "m:cheaper")],
    [btn("✍️ Покупка без чека (рынок, Linella…)", "m:purchase")],
  ];
  return show(
    ctx,
    "📝 <b>Покупки</b>\n\nЧеки Шерифа и других магазинов ПМР бот читает сам — пришли ссылку из QR. " +
      "Рынок и молдавские магазины записывай строкой: <code>рынок помидоры 2кг 40</code>, <code>Linella молоко 2 шт 36 лей</code> — " +
      "так бот узнаёт цены и подскажет, где что дешевле.",
    rows,
  );
}

function pickStore(ctx: Context): Promise<void> {
  const rows: Rows = [];
  for (let i = 0; i < STORES.length; i += 2) {
    rows.push(STORES.slice(i, i + 2).map((s) => btn(`${s.side === "pmr" ? "🟥" : "🟦"} ${s.name}`, `pst:${s.id}`)));
  }
  rows.push(back("shop", "⬅️ Покупки"));
  return show(ctx, "✍️ <b>Где купили?</b>\n🟥 ПМР (рубли) · 🟦 Молдова (леи)", rows);
}

/** Records a manual purchase and confirms with an undo button. */
export async function recordPurchase(ctx: Context, store: Store, text: string): Promise<boolean> {
  const p = parsePurchase(text, store.currency);
  if (!p) return false;
  const purchase = addPurchase(store, p, { by: ctx.from?.first_name, byId: ctx.from?.id });
  const qty = p.unit === "уп" ? "" : ` · ${+p.qty.toFixed(3)} ${p.unit}`;
  const per = p.unit !== "уп" && p.qty > 0 ? ` (${(p.total / p.qty).toFixed(2).replace(".", ",")} за ${p.unit === "шт" ? "шт" : p.unit})` : "";
  const cur = p.currency === "MDL" ? "лей" : p.currency === "RUP" ? "руб" : p.currency;
  await ctx.reply(
    `✓ <b>${esc(store.name)}</b>: ${esc(p.item)}${qty} — ${p.total} ${cur}${per}\n<i>Записал и трату, и цену для сравнения.</i>`,
    { parse_mode: "HTML", reply_markup: { inline_keyboard: [[btn("↩️ Отменить", `pdel:${purchase.id}`), btn("🏪 Где дешевле", "m:cheaper")]] } },
  );
  return true;
}

/** "рынок помидоры 2кг 40" typed anywhere. */
export async function tryStoreLine(ctx: Context, text: string): Promise<boolean> {
  const sp = storePrefix(text);
  if (!sp || !sp.rest) return false;
  return recordPurchase(ctx, sp.store, sp.rest);
}

export function registerShopping(b: Telegraf): void {
  const wrap = (fn: (ctx: Context & { match: RegExpExecArray }) => Promise<unknown>) =>
    async (ctx: Context & { match: RegExpExecArray }) => {
      try {
        await fn(ctx);
        await ctx.answerCbQuery().catch(() => undefined);
      } catch (err) {
        await ctx.answerCbQuery(errMsg(err), { show_alert: true }).catch(() => undefined);
      }
    };

  b.action("m:shop", wrap(shoppingHome));
  b.action("m:cheaper", wrap((ctx) => show(ctx, formatComparison(), [back("shop", "⬅️ Покупки")])));
  b.action("m:purchase", wrap(pickStore));
  b.action(/^pst:(.+)$/, wrap((ctx) => {
    const store = storeById(ctx.match[1]!);
    if (!store) throw new Error("Магазин не найден");
    setPending(ctx.from!.id, { kind: "purchase", storeId: store.id });
    const cur = store.currency === "MDL" ? "лей" : "руб";
    return show(
      ctx,
      `✍️ <b>${esc(store.name)}</b> — что купили?\nТовар, количество и цена (в ${cur}, если не указано иное):\n` +
        "<code>помидоры 2кг 40</code> · <code>молоко 2 шт 36</code> · <code>яйца 10 шт 30</code> · <code>сыр 300г 45</code>\n\n<i>Напиши сообщением.</i>",
      [[btn("✖️ Отмена", "m:shop")]],
    );
  }));
  b.action(/^pdel:(.+)$/, wrap(async (ctx) => {
    const p = deletePurchase(ctx.match[1]!);
    if (!p) throw new Error("Уже удалено");
    if (p.expenseId) deleteExpense(p.expenseId);
    await show(ctx, `<s>✓ ${esc(p.item)} — ${p.total}</s> — отменено`);
  }));
}
