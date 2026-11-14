import type { Context, Telegraf } from "telegraf";
import { logger } from "../utils/logger.js";
import { drifts, investAdvice, load, nextQuarterDay, nextReview, rebalance, recordContribution, save, total, undoLast, type Portfolio } from "../portfolio/index.js";
import { btn, canSeeFinance, esc } from "./ui.js";

/**
 * /invest 100 — how a contribution splits across the portfolio's cells, whether the IBKR part
 * waits in the envelope or can go to IBKR now; "✅ Записать" records it. /invest alone — where
 * the portfolio stands. Rules and numbers live in src/portfolio; data in data/portfolio.json.
 */

const usd = (x: number) => `$${x.toFixed(2).replace(/\.00$/, "")}`;
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const today = () => new Date().toISOString().slice(0, 10);

/** What to do with each cell's share — the action a person takes, not just the amount. */
function action(p: Portfolio, key: string, sendNow: boolean): string {
  if (p.ibkrCells.includes(key)) return sendNow ? "в IBKR" : "в конверт (Earn USDC)";
  if (key === "btc") return "купить на Binance";
  return "в Earn USDC";
}

export function adviceText(p: Portfolio, amount: number, day = today()): string {
  const a = investAdvice(p, amount, day);
  const lines = [`📈 <b>Взнос ${usd(amount)}</b> — по портфелю «${esc(p.model)}»`, ""];
  for (const [k, v] of Object.entries(a.split)) {
    if (v < 0.005) continue;
    lines.push(`• ${esc(p.cells[k]!.label)}: <b>${usd(v)}</b> → ${action(p, k, a.sendNow)}`);
  }
  lines.push("");
  if (a.sendNow) {
    const fromEnvelope = p.envelope > 0 ? ` (${usd(a.ibkrPart)} сейчас + ${usd(p.envelope)} из конверта)` : "";
    lines.push(
      a.why === "amount"
        ? `✅ <b>Конверт не нужен:</b> на IBKR сразу ${usd(a.pending)}${fromEnvelope} — этого хватает, чтобы перевод не съедал комиссию.`
        : `📅 <b>Квартальный перевод:</b> отправь в IBKR ${usd(a.pending)}${fromEnvelope}.`,
      "Перевод: IBKR → Deposit → Fund with Stablecoin → сеть Solana или Base; купить целые паи, остаток — долларами на счёте.",
    );
  } else {
    lines.push(`✉️ <b>Конверт для IBKR:</b> станет ${usd(a.pending)} — переводить, когда наберётся ${usd(p.ibkrDirectMin)} или ${ru(a.nextQuarter)}, что раньше.`);
  }
  return lines.join("\n");
}

export function statusText(p: Portfolio, day = today()): string {
  const t = total(p);
  const lines = [`📈 <b>Портфель «${esc(p.model)}»</b> — ${usd(t)}`];
  if (t === 0) lines.push("", "Пока пусто. Напиши <code>/invest 100</code> — покажу, куда разложить взнос.");
  else {
    lines.push("");
    for (const d of drifts(p)) {
      const off = d.offPp >= 0 ? `+${d.offPp.toFixed(1)}` : d.offPp.toFixed(1);
      lines.push(`• ${esc(d.label)}: ${usd(p.cells[d.key]!.value)} — ${(d.share * 100).toFixed(1)}% из ${(d.target * 100).toFixed(0)}% (${off} п.п.)${Math.abs(d.offPp) > p.bandPp ? " ⚠️" : ""}`);
    }
  }
  const r = rebalance(p, day);
  lines.push(
    "",
    `✉️ В конверте для IBKR: ${usd(p.envelope)} · квартальный перевод ${ru(nextQuarterDay(day))}`,
    `🔁 Годовой пересмотр: ${ru(nextReview(p, day))}${t > 0 && r.due ? ` · <b>выровнять сейчас</b> (${esc(r.reason)})` : ""}`,
    "",
    "Взнос — <code>/invest 100</code>",
  );
  return lines.join("\n");
}

function parseAmount(text: string): number | null {
  const m = /(\d+(?:[.,]\d{1,2})?)/.exec(text.replace(/^\/invest(@\S+)?/, ""));
  const n = m ? Number(m[1]!.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : null;
}

export function registerInvest(b: Telegraf): void {
  const loadOrExplain = async (ctx: Context): Promise<Portfolio | null> => {
    try {
      return load();
    } catch {
      await ctx.reply("Портфель не настроен: нет файла data/portfolio.json.");
      return null;
    }
  };

  b.command("invest", async (ctx) => {
    if (!canSeeFinance(ctx.from?.id)) return ctx.reply("🔒 Финансы видны только семье.");
    const p = await loadOrExplain(ctx);
    if (!p) return;
    const amount = parseAmount((ctx.message as { text?: string }).text ?? "");
    if (amount === null) {
      const last = p.contributions[p.contributions.length - 1];
      return ctx.reply(statusText(p), {
        parse_mode: "HTML",
        ...(last ? { reply_markup: { inline_keyboard: [[btn(`↩️ Отменить последний взнос (${usd(last.amount)}, ${ru(last.date)})`, `inv:undo:${p.contributions.length}`)]] } } : {}),
      });
    }
    return ctx.reply(adviceText(p, amount), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[btn("✅ Записать взнос", `inv:rec:${amount}`), btn("✖️ Не записывать", "inv:no")]] },
    });
  });

  b.action(/^inv:rec:(\d+(?:\.\d{1,2})?)$/, async (ctx) => {
    if (!canSeeFinance(ctx.from?.id)) return ctx.answerCbQuery("Финансы видны только семье");
    const p = load();
    const amount = Number(ctx.match[1]);
    const a = recordContribution(p, amount, today(), ctx.from?.first_name);
    save(p);
    logger.info(`[Telegram] Portfolio contribution $${amount} by ${ctx.from?.first_name}; envelope ${p.envelope}`);
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    await ctx.answerCbQuery("Записано");
    return ctx.reply(
      `✅ Записал взнос ${usd(amount)}.` +
        (a.sendNow ? ` Конверт обнулён — не забудь перевести ${usd(a.pending)} в IBKR.` : ` В конверте для IBKR: ${usd(p.envelope)}.`),
      { reply_markup: { inline_keyboard: [[btn("↩️ Отменить этот взнос", `inv:undo:${p.contributions.length}`)]] } },
    );
  });

  // The count in the button pins which contribution it was made for: an old button cannot
  // take back a newer one.
  b.action(/^inv:undo:(\d+)$/, async (ctx) => {
    if (!canSeeFinance(ctx.from?.id)) return ctx.answerCbQuery("Финансы видны только семье");
    const p = load();
    const c = undoLast(p, Number(ctx.match[1]));
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    if (!c) {
      await ctx.answerCbQuery("Уже отменён или после него записан другой");
      return ctx.reply("Этот взнос уже отменён, или после него записан более новый. Отменить можно только последний — через /invest.");
    }
    save(p);
    logger.info(`[Telegram] Portfolio contribution $${c.amount} of ${c.date} undone by ${ctx.from?.first_name}; envelope ${p.envelope}`);
    await ctx.answerCbQuery("Отменено");
    return ctx.reply(`↩️ Отменил взнос ${usd(c.amount)} от ${ru(c.date)}. В конверте для IBKR снова ${usd(p.envelope)}.`);
  });

  b.action("inv:no", async (ctx) => {
    await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    return ctx.answerCbQuery("Не записываю");
  });
}
