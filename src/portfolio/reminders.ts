import { drifts, nextQuarterDay, nextReview, rebalance, total, type Portfolio } from "./index.js";

/**
 * The portfolio's proactive reminders, checked once a day. A message only on days that ask
 * for something: the 15th (contribution day; on 15 Feb/May/Aug/Nov also the IBKR transfer),
 * a week before the yearly review, and the review day itself. Null on every other day.
 */

const usd = (x: number) => `$${x.toFixed(2).replace(/\.00$/, "")}`;
const ru = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function portfolioReminder(p: Portfolio, today: string): string | null {
  const parts: string[] = [];
  const day = Number(today.slice(8, 10));
  const month = Number(today.slice(5, 7));
  const review = nextReview(p, today);
  const isReviewDay = p.contributions.length > 0 && review === today;

  if (day === 15) {
    parts.push("📈 <b>15-е — день взноса.</b> Напиши <code>/invest</code> и сумму: покажу, куда сколько, потом «✅ Записать».");
    if ([2, 5, 8, 11].includes(month) && p.envelope > 0) {
      parts.push(
        `✉️ <b>Квартальный перевод:</b> в конверте ${usd(p.envelope)} — отправь в IBKR (Deposit → Fund with Stablecoin → Solana или Base), купи целые паи. ` +
          "Если сегодня записываешь взнос, его часть для IBKR бот добавит к этой сумме.",
      );
    } else if (p.envelope > 0) {
      parts.push(`✉️ В конверте для IBKR ${usd(p.envelope)} — перевод ${ru(nextQuarterDay(shift(today, 1)))} или когда наберётся ${usd(p.ibkrDirectMin)}.`);
    }
    const off = total(p) > 0 ? drifts(p).filter((d) => Math.abs(d.offPp) > p.bandPp) : [];
    if (off.length && !isReviewDay) {
      parts.push(`⚠️ Вне коридора ±${p.bandPp} п.п.: ${off.map((d) => `${d.label} (${d.offPp > 0 ? "+" : ""}${d.offPp.toFixed(1)})`).join(", ")} — <code>/invest</code> покажет, что выровнять.`);
    }
  }

  if (p.contributions.length > 0 && shift(review, -7) === today) {
    parts.push(
      `🔁 <b>Через неделю, ${ru(review)}, — годовой пересмотр.</b> До него выпиши текущую стоимость каждой ячейки (IBKR, Earn, BTC), ` +
        "чтобы трекер считал по реальным суммам, а не по взносам.",
    );
  }

  if (isReviewDay) {
    const r = rebalance(p, today);
    const trades = r.trades.map((t) => `• ${t.amount > 0 ? "докупить" : "продать"} ${t.label}: ${usd(Math.abs(t.amount))}`);
    parts.push(
      `🔁 <b>Сегодня годовой пересмотр.</b> ` +
        (trades.length ? `Чтобы вернуть целевые доли:\n${trades.join("\n")}` : "Все ячейки в целевых долях — ничего делать не нужно.") +
        "\nЗаодно: сегодня же оценка H10b — решаем, переходит ли «тренд» из кеша в стратегию.",
    );
  }

  return parts.length ? parts.join("\n\n") : null;
}
