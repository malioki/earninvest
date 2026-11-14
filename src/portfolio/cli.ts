import { DATA_FILE, drifts, load, nextReview, rebalance, recordContribution, save, splitContribution, total, undoLast } from "./index";

/**
 * npm run portfolio                      — current shares against targets, next review
 * npm run portfolio -- plan 100          — how to split a contribution (nothing saved)
 * npm run portfolio -- record 100        — record a contribution split by the rule
 * npm run portfolio -- value stocks 1234 — set a cell's current value (from IBKR / exchange)
 * npm run portfolio -- rebalance         — is a rebalance due, and which trades restore targets
 */

const usd = (x: number) => `$${x.toFixed(2)}`;
const today = new Date().toISOString().slice(0, 10);
const [cmd, a, b] = process.argv.slice(2);
const p = load();

function status() {
  console.log(`Портфель «${p.model}» · всего ${usd(total(p))} · старт ${p.start} · следующий годовой пересмотр ${nextReview(p, today)}`);
  if (total(p) === 0) {
    console.log("  Пока пусто — первый взнос разложится ровно по целевым долям: npm run portfolio -- plan <сумма>");
    return;
  }
  for (const d of drifts(p)) {
    const flag = Math.abs(d.offPp) > p.bandPp ? "  ← вне коридора" : "";
    console.log(`  ${d.label.padEnd(44)} ${usd(p.cells[d.key]!.value).padStart(12)}  ${(d.share * 100).toFixed(1).padStart(5)}% из ${(d.target * 100).toFixed(0)}%  (${d.offPp >= 0 ? "+" : ""}${d.offPp.toFixed(1)} п.п.)${flag}`);
  }
}

function plan(amount: number, persist: boolean) {
  const split = splitContribution(p, amount);
  console.log(`${persist ? "Записан взнос" : "Взнос"} ${usd(amount)} — куда направить:`);
  for (const [k, v] of Object.entries(split)) if (v >= 0.005) console.log(`  ${p.cells[k]!.label.padEnd(44)} ${usd(v)}`);
  if (persist) {
    const a = recordContribution(p, amount, today);
    save(p);
    console.log(a.sendNow ? `  → в IBKR сразу ${usd(a.pending)} (конверт обнулён)` : `  → конверт для IBKR: ${usd(p.envelope)}`);
  }
}

if (!cmd) status();
else if (cmd === "plan" || cmd === "record") plan(Number(a), cmd === "record");
else if (cmd === "value") {
  if (!a || !p.cells[a]) throw new Error(`нет ячейки "${a}"; есть: ${Object.keys(p.cells).join(", ")}`);
  p.cells[a]!.value = Number(b);
  save(p);
  status();
} else if (cmd === "undo") {
  const c = undoLast(p);
  if (!c) console.log("Взносов нет — отменять нечего.");
  else {
    save(p);
    console.log(`Отменён взнос ${usd(c.amount)} от ${c.date}; в конверте для IBKR ${usd(p.envelope)}.`);
  }
} else if (cmd === "rebalance") {
  const r = rebalance(p, today);
  console.log(r.due ? `Выравнивание нужно: ${r.reason}` : `Выравнивание не нужно (коридор ±${p.bandPp} п.п., годовой пересмотр ${nextReview(p, today)})`);
  for (const t of r.trades) console.log(`  ${t.amount > 0 ? "докупить" : "продать "} ${t.label.padEnd(44)} ${usd(Math.abs(t.amount))}`);
} else throw new Error(`неизвестная команда "${cmd}"; файл ${DATA_FILE}`);
