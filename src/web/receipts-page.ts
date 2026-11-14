import { config } from "../config/index.js";
import type {
  Receipt,
  ReceiptStats,
  CategoryStat,
} from "../receipts/index.js";
import type {
  CashExpense,
  CashStats,
  Preset,
} from "../expenses/index.js";
import { CATEGORIES } from "../expenses/index.js";
import type { MonthReport, WeekReport } from "../spending/index.js";
import { rollupCategories } from "../spending/index.js";
import { budgetVerdict, ordinalWeek } from "../spending/index.js";

const fmt = (n: number, d = 0): string =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CAT_COLORS: Record<string, string> = {
  Мясо: "#ff6b6b",
  Молочка: "#64b5f6",
  "Овощи и фрукты": "#4caf82",
  Мороженое: "#ba68c8",
  Сладости: "#f06292",
  Напитки: "#4dd0e1",
  Хлеб: "#ffb74d",
  "Крупы и макароны": "#d4a373",
  Бакалея: "#a1887f",
  Яйца: "#fff176",
  Рыба: "#4fc3f7",
  Алкоголь: "#e57373",
  "Бытовая химия": "#78909c",
  Хозтовары: "#90a4ae",
  Гигиена: "#b0bec5",
  Пакеты: "#607d8b",
  Снеки: "#ffd54f",
  Животные: "#8d6e63",
  "Детское питание": "#f48fb1",
  Аптека: "#4fc3f7",
  "Не разобрано": "#ffc107",
};
const catColor = (c: string): string => CAT_COLORS[c] ?? "#888";

const CASH_COLORS: Record<string, string> = {
  Кофе: "#a1887f",
  Перекус: "#ffb74d",
  "Обед / кафе": "#ff8a65",
  Транспорт: "#4dd0e1",
  "Мелочи без чека": "#90a4ae",
  Аптека: "#4fc3f7",
  Детское: "#f06292",
  Подарки: "#ba68c8",
  Развлечения: "#9575cd",
  Продукты: "#81c784",
  "Дом и быт": "#78909c",
  Прочее: "#888",
};
const cashColor = (c: string): string =>
  CASH_COLORS[c] ?? CAT_COLORS[c] ?? "#888";

function renderQuickAdd(presets: Preset[]): string {
  const today = new Date().toISOString().slice(0, 10);
  const buttons = presets
    .map(
      (p) => `
      <button onclick="cashQuick('${esc(p.id)}')" class="qbtn" title="Добавить сразу">
        <span>${esc(p.label)}</span>
        <span style="opacity:.65;font-weight:600">${fmt(p.amount, p.amount % 1 ? 2 : 0)} ${esc(p.currency)}</span>
      </button>`,
    )
    .join("");

  const cats = CATEGORIES.map(
    (c) => `<option value="${esc(c)}">${esc(c)}</option>`,
  ).join("");

  return `
  <style>
    .qbtn {
      display:flex; flex-direction:column; align-items:center; gap:2px;
      background:#1a1d27; border:1px solid #3a3f4d; color:#e0e0e0;
      border-radius:8px; padding:11px 15px; cursor:pointer; font-size:.92rem;
      transition:all .15s; min-width:104px;
    }
    .qbtn:hover { border-color:#4caf82; background:#222735; color:#fff; }
    .qbtn:active { transform:scale(.96); }
    .cash-field { background:#1a1d27; border:1px solid #3a3f4d; border-radius:6px; color:#fff; padding:8px 11px; font-size:.92rem; }
    .cash-field:focus { outline:none; border-color:#4caf82; }
  </style>
  <div class="section" style="border-color:#ffb74d">
    <h3 style="color:#ffb74d;margin-bottom:4px">💸 Наличные траты</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:14px">
      Кофе, шаурма, такси — всё, что не оставляет чека. Нажми кнопку — запишется сразу с той суммой,
      что показана. Кнопки запоминают последнюю введённую цену.
    </div>

    <div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:16px">${buttons}</div>

    <details>
      <summary style="cursor:pointer;color:#888;font-size:.88rem;margin-bottom:10px">➕ Другая сумма / категория / дата</summary>
      <div style="display:flex;gap:9px;flex-wrap:wrap;align-items:flex-end;margin-top:10px">
        <div>
          <label style="display:block;color:#999;font-size:.75rem;margin-bottom:4px">Сумма</label>
          <input id="cashAmount" type="number" step="0.01" min="0" class="cash-field" style="width:110px"
            onkeydown="if(event.key==='Enter')cashManual()">
        </div>
        <div>
          <label style="display:block;color:#999;font-size:.75rem;margin-bottom:4px">Валюта</label>
          <select id="cashCurrency" class="cash-field">
            <option value="RUP">руб ПМР</option>
            <option value="MDL">лей</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
          </select>
        </div>
        <div>
          <label style="display:block;color:#999;font-size:.75rem;margin-bottom:4px">Категория</label>
          <select id="cashCategory" class="cash-field">${cats}</select>
        </div>
        <div>
          <label style="display:block;color:#999;font-size:.75rem;margin-bottom:4px">Дата</label>
          <input id="cashDate" type="date" value="${today}" class="cash-field">
        </div>
        <div style="flex:1;min-width:150px">
          <label style="display:block;color:#999;font-size:.75rem;margin-bottom:4px">Заметка</label>
          <input id="cashNote" type="text" class="cash-field" style="width:100%" placeholder="необязательно"
            onkeydown="if(event.key==='Enter')cashManual()">
        </div>
        <button onclick="cashManual()" style="padding:9px 18px">Записать</button>
      </div>
    </details>

    <div id="cashMsg" style="margin-top:12px;font-size:.9rem;min-height:20px"></div>
  </div>
  <script>
    var CASH_PRESETS = ${JSON.stringify(presets)};

    async function cashPost(payload, label) {
      var msg = document.getElementById('cashMsg');
      msg.style.color = '#888'; msg.textContent = 'Записываю...';
      try {
        var r = await fetch('/api/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        msg.style.color = '#4caf82';
        msg.innerHTML = '✓ ' + label
          + ' <a href="#" onclick="cashUndo(\\'' + j.expense.id + '\\');return false;" style="color:#ff6b6b;margin-left:10px">отменить</a>';
        window.__cashDirty = true;
        clearTimeout(window.__cashTimer);
        window.__cashTimer = setTimeout(function () {
          if (window.__cashDirty) location.reload();
        }, 2500);
      } catch (e) {
        msg.style.color = '#ff6b6b';
        msg.textContent = 'Ошибка: ' + e.message;
      }
    }

    function cashQuick(id) {
      var p = CASH_PRESETS.filter(function (x) { return x.id === id; })[0];
      if (!p) return;
      cashPost(
        { amount: p.amount, currency: p.currency, category: p.category, presetId: p.id },
        p.label + ' — ' + p.amount + ' ' + p.currency
      );
    }

    function cashManual() {
      var amount = parseFloat(document.getElementById('cashAmount').value);
      if (!(amount > 0)) { document.getElementById('cashAmount').focus(); return; }
      var cur = document.getElementById('cashCurrency').value;
      var cat = document.getElementById('cashCategory').value;
      cashPost(
        {
          amount: amount, currency: cur, category: cat,
          date: document.getElementById('cashDate').value,
          note: document.getElementById('cashNote').value,
        },
        cat + ' — ' + amount + ' ' + cur
      );
      document.getElementById('cashAmount').value = '';
      document.getElementById('cashNote').value = '';
    }

    async function cashUndo(id) {
      window.__cashDirty = false;
      clearTimeout(window.__cashTimer);
      var msg = document.getElementById('cashMsg');
      try {
        var r = await fetch('/api/expenses/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        msg.style.color = '#888'; msg.textContent = 'Отменено';
      } catch (e) {
        msg.style.color = '#ff6b6b'; msg.textContent = 'Не отменилось: ' + e.message;
      }
    }
  </script>`;
}

function renderAddBox(): string {
  return `
  <div class="section" style="border-color:#4caf82">
    <h3 style="color:#4caf82;margin-bottom:4px">🧾 Добавить чек</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:12px">
      Вставь ссылку с фискального чека (QR-код на чеке ведёт именно туда). Позиции разберутся автоматически.
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <input id="rcUrl" type="url" placeholder="https://ofd.apb.online/Ofd/check?..."
        style="flex:1;min-width:280px;background:#1a1d27;border:2px solid #4caf82;border-radius:6px;color:#fff;padding:10px 13px;font-size:.95rem"
        onkeydown="if(event.key==='Enter')rcAdd()">
      <button onclick="rcAdd()" id="rcBtn" style="padding:10px 22px">Разобрать</button>
    </div>
    <div id="rcMsg" style="margin-top:10px;font-size:.9rem"></div>
  </div>
  <script>
    async function rcAdd() {
      var input = document.getElementById('rcUrl');
      var btn = document.getElementById('rcBtn');
      var msg = document.getElementById('rcMsg');
      var url = input.value.trim();
      if (!url) { input.focus(); return; }
      btn.disabled = true; btn.textContent = '...';
      msg.style.color = '#888'; msg.textContent = 'Загружаю чек...';
      try {
        var r = await fetch('/api/receipts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: url }),
        });
        var j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        msg.style.color = '#4caf82';
        msg.textContent = (j.duplicate ? 'Чек обновлён: ' : 'Добавлено: ')
          + j.receipt.merchant + ' — ' + j.receipt.items.length + ' позиций';
        input.value = '';
        setTimeout(function () { location.reload(); }, 700);
      } catch (e) {
        msg.style.color = '#ff6b6b';
        msg.textContent = 'Ошибка: ' + e.message;
        btn.disabled = false; btn.textContent = 'Разобрать';
      }
    }
  </script>`;
}

function renderEmpty(): string {
  return `
  <div class="section" style="text-align:center;padding:40px 20px;color:#888">
    <div style="font-size:2.4rem;margin-bottom:10px">🧾</div>
    <div style="font-size:1.05rem;margin-bottom:6px">Чеков пока нет</div>
    <div style="font-size:.9rem">
      Вставь первую ссылку выше. Через пару месяцев накопится картина того,
      куда реально уходят деньги на продукты — и что семья на самом деле ест.
    </div>
  </div>`;
}

function renderStats(s: ReceiptStats): string {
  const days =
    s.firstDate && s.lastDate
      ? Math.max(
          1,
          Math.round(
            (new Date(s.lastDate).getTime() - new Date(s.firstDate).getTime()) /
              86_400_000,
          ) + 1,
        )
      : 1;
  const perMonth = (s.totalUsd / days) * 30;
  const foodShare = s.totalUsd > 0 ? (s.foodUsd / s.totalUsd) * 100 : 0;

  return `
  <div class="section">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:18px">
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">🧾 Собрано</div>
        <div style="font-size:1.6rem;color:#4caf82;font-weight:700">$${fmt(s.totalUsd)}</div>
        <div style="font-size:.75rem;color:#666">${s.receiptCount} чек(ов), ${s.itemCount} позиций</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">📅 Темп в месяц</div>
        ${
          // Extrapolating a month from a couple of days is noise, not a number.
          days >= 14
            ? `<div style="font-size:1.6rem;color:#64b5f6;font-weight:700">$${fmt(perMonth)}</div>
               <div style="font-size:.75rem;color:#666">по ${days} дн. наблюдений</div>`
            : `<div style="font-size:1.6rem;color:#555;font-weight:700">—</div>
               <div style="font-size:.75rem;color:#666">данных за ${days} дн. — нужно от 14</div>`
        }
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">🍽 Из них еда</div>
        <div style="font-size:1.6rem;color:#4caf82;font-weight:700">${fmt(foodShare)}%</div>
        <div style="font-size:.75rem;color:#666">$${fmt(s.foodUsd)} еда · $${fmt(s.householdUsd)} быт</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">🛒 Средний чек</div>
        <div style="font-size:1.6rem;color:#fff;font-weight:700">$${fmt(s.avgReceiptUsd)}</div>
        <div style="font-size:.75rem;color:#666">${s.firstDate ?? ""} → ${s.lastDate ?? ""}</div>
      </div>
    </div>
  </div>`;
}

function renderBar(cats: CategoryStat[], totalUsd: number): string {
  if (totalUsd <= 0) return "";
  const segs = cats
    .filter((c) => c.totalUsd / totalUsd > 0.005)
    .map((c) => {
      const pct = (c.totalUsd / totalUsd) * 100;
      return `<div title="${esc(c.category)}: $${fmt(c.totalUsd, 2)} (${pct.toFixed(1)}%)"
        style="width:${pct}%;background:${catColor(c.category)};display:flex;align-items:center;justify-content:center;font-size:.7rem;color:#111;font-weight:700;overflow:hidden;white-space:nowrap">
        ${pct >= 9 ? esc(c.category) : ""}</div>`;
    })
    .join("");
  return `<div style="display:flex;height:30px;border-radius:6px;overflow:hidden;margin-bottom:12px">${segs}</div>`;
}

function renderCategoryTable(
  cats: CategoryStat[],
  title: string,
  totalUsd: number,
  note: string,
): string {
  if (cats.length === 0) return "";
  const rows = cats
    .map((c) => {
      const pct = c.share * 100;
      return `
      <tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${catColor(c.category)};margin-right:8px"></span>${esc(c.category)}</td>
        <td>$${fmt(c.totalUsd, 2)}</td>
        <td style="width:38%">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:#1a1d27;border-radius:3px;height:7px;overflow:hidden">
              <div style="height:100%;width:${pct.toFixed(1)}%;background:${catColor(c.category)}"></div>
            </div>
            <span style="color:#888;font-size:.85rem;min-width:44px">${pct.toFixed(1)}%</span>
          </div>
        </td>
        <td style="color:#888">${c.itemCount}</td>
      </tr>`;
    })
    .join("");
  return `
  <div class="section">
    <h3 style="color:#4caf82;margin-bottom:4px">${title}</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:12px">${note}</div>
    ${renderBar(cats, totalUsd)}
    <table>
      <thead><tr><th>Категория</th><th>Сумма</th><th>Доля</th><th>Позиций</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderMonths(s: ReceiptStats): string {
  if (s.months.length === 0) return "";
  const rows = s.months
    .map(
      (m) => `
      <tr>
        <td><b>${m.month}</b></td>
        <td>$${fmt(m.totalUsd, 2)}</td>
        <td class="green">$${fmt(m.foodUsd, 2)}</td>
        <td style="color:#90a4ae">$${fmt(m.householdUsd, 2)}</td>
        <td style="color:#ffc107">$${fmt(m.otherUsd, 2)}</td>
        <td style="color:#888">${m.receiptCount}</td>
      </tr>`,
    )
    .join("");
  return `
  <div class="section">
    <h3 style="color:#4caf82;margin-bottom:12px">📅 По месяцам</h3>
    <table>
      <thead><tr><th>Месяц</th><th>Всего</th><th>Еда</th><th>Быт</th><th>Не разобрано</th><th>Чеков</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderTopItems(s: ReceiptStats): string {
  if (s.topItems.length === 0) return "";
  const rows = s.topItems
    .map(
      (t, i) => `
      <tr>
        <td style="color:#666;width:28px">${i + 1}</td>
        <td>${esc(t.name)}</td>
        <td>$${fmt(t.totalUsd, 2)}</td>
        <td style="color:#888">${t.count}×</td>
      </tr>`,
    )
    .join("");
  return `
  <div class="section">
    <h3 style="color:#4caf82;margin-bottom:12px">🏆 Самые дорогие позиции</h3>
    <table>
      <thead><tr><th></th><th>Товар</th><th>Потрачено</th><th>Раз</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderUncategorised(s: ReceiptStats): string {
  if (s.uncategorised.length === 0) return "";
  const rows = s.uncategorised
    .slice(0, 25)
    .map(
      (u) =>
        `<li style="padding:3px 0">${esc(u.name)} <span style="color:#888">— $${fmt(u.totalUsd, 2)}</span></li>`,
    )
    .join("");
  return `
  <div class="section" style="border-color:#ffc107">
    <h3 style="color:#ffc107;margin-bottom:4px">⚠️ Не разобрано (${s.uncategorised.length})</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:10px">
      Эти позиции не подошли ни под одно правило — они не попали ни в «еду», ни в «быт»,
      так что проценты выше слегка занижены. Скажи мне, куда их отнести, и я допишу правила.
    </div>
    <ul style="list-style:none;padding:0;color:#ddd;font-size:.9rem;columns:2;column-gap:24px">${rows}</ul>
  </div>`;
}

function renderReceiptList(receipts: Receipt[]): string {
  if (receipts.length === 0) return "";
  const rows = receipts
    .slice(0, 40)
    .map((r, i) => {
      const items = r.items
        .map(
          (it) => `
          <tr>
            <td>${esc(it.name)}</td>
            <td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${catColor(it.category)};margin-right:6px"></span><span style="color:#999;font-size:.85rem">${esc(it.category)}</span></td>
            <td style="color:#888">${it.qty % 1 === 0 ? it.qty : it.qty.toFixed(3)} × ${fmt(it.unitPrice, 2)}</td>
            <td>${fmt(it.total, 2)}</td>
          </tr>`,
        )
        .join("");
      return `
      <div style="border:1px solid #3a3f4d;border-radius:6px;margin-bottom:10px;overflow:hidden">
        <div onclick="rcToggle(${i})" style="padding:12px 14px;background:#1a1d27;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <b>${esc(r.merchant)}</b>
            ${r.mismatch ? '<span style="color:#ff6b6b;font-size:.8rem;margin-left:8px">⚠️ сумма не сходится</span>' : ""}
            <div style="color:#888;font-size:.8rem">${r.date}${r.time ? " " + r.time : ""} · ${r.items.length} позиций${r.address ? " · " + esc(r.address) : ""}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:1.15rem;font-weight:700;color:#4caf82">$${fmt(r.totalUsd, 2)}</div>
            <div style="color:#666;font-size:.8rem">${fmt(r.total, 2)} ${r.currency}</div>
          </div>
        </div>
        <div id="rc-${i}" style="display:none;padding:10px 14px;background:#252836">
          <table><tbody>${items}</tbody></table>
        </div>
      </div>`;
    })
    .join("");
  return `
  <div class="section">
    <h3 style="color:#4caf82;margin-bottom:12px">🧾 Чеки (${receipts.length})</h3>
    ${rows}
  </div>
  <script>
    function rcToggle(i) {
      var el = document.getElementById('rc-' + i);
      el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }
  </script>`;
}

function renderOverview(
  rs: ReceiptStats,
  cs: CashStats,
  lifeCostUsd: number,
): string {
  const dates = [rs.firstDate, cs.firstDate].filter(Boolean).sort();
  const lastDates = [rs.lastDate, cs.lastDate].filter(Boolean).sort();
  const first = dates[0];
  const last = lastDates[lastDates.length - 1];
  if (!first || !last) return "";

  const days = Math.max(
    1,
    Math.round(
      (new Date(last).getTime() - new Date(first).getTime()) / 86_400_000,
    ) + 1,
  );
  const totalUsd = rs.totalUsd + cs.totalUsd;
  const perMonth = (totalUsd / days) * 30;
  const cashShare = totalUsd > 0 ? (cs.totalUsd / totalUsd) * 100 : 0;
  const enough = days >= 14;

  const verdict = !enough
    ? `<div style="color:#888;font-size:.9rem">
         Пока собрано ${days} дн. данных — для сравнения с бюджетом нужно хотя бы 14,
         иначе одна крупная закупка перекосит всю картину.
       </div>`
    : (() => {
        const diff = perMonth - lifeCostUsd;
        const pct = lifeCostUsd > 0 ? (diff / lifeCostUsd) * 100 : 0;
        if (Math.abs(pct) < 12) {
          return `<div style="color:#4caf82;font-size:.9rem">
            ✓ Реальные траты ($${fmt(perMonth)}/мес) сходятся с бюджетом в трекере ($${fmt(lifeCostUsd)}/мес).
            Расхождение ${pct >= 0 ? "+" : ""}${fmt(pct)}% — в пределах нормы.
          </div>`;
        }
        if (diff > 0) {
          return `<div style="color:#ff6b6b;font-size:.9rem">
            ⚠️ Тратишь на $${fmt(diff)}/мес больше, чем заложено в трекере
            ($${fmt(perMonth)} против $${fmt(lifeCostUsd)}). Свободный поток и все сроки в плане
            завышены — стоит поднять <code>monthlyVariableBudgetUsd</code> и вместе с ним <code>monthlyLifeCostUsd</code>.
          </div>`;
        }
        return `<div style="color:#64b5f6;font-size:.9rem">
          Реальные траты ($${fmt(perMonth)}/мес) ниже заложенных ($${fmt(lifeCostUsd)}).
          Учти, что часть расходов может просто не попадать в чеки.
        </div>`;
      })();

  return `
  <div class="section" style="border-color:#4caf82">
    <h3 style="color:#4caf82;margin-bottom:12px">📊 Общая картина трат</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:18px;margin-bottom:14px">
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">Всего собрано</div>
        <div style="font-size:1.6rem;color:#4caf82;font-weight:700">$${fmt(totalUsd)}</div>
        <div style="font-size:.75rem;color:#666">за ${days} дн.</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">🧾 По чекам</div>
        <div style="font-size:1.6rem;color:#64b5f6;font-weight:700">$${fmt(rs.totalUsd)}</div>
        <div style="font-size:.75rem;color:#666">${rs.receiptCount} чек(ов)</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">💸 Наличкой</div>
        <div style="font-size:1.6rem;color:#ffb74d;font-weight:700">$${fmt(cs.totalUsd)}</div>
        <div style="font-size:.75rem;color:#666">${cs.count} записей · ${fmt(cashShare)}% всех трат</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">Темп в месяц</div>
        <div style="font-size:1.6rem;color:${enough ? "#fff" : "#555"};font-weight:700">${enough ? "$" + fmt(perMonth) : "—"}</div>
        <div style="font-size:.75rem;color:#666">переменная часть быта — $${fmt(lifeCostUsd)}</div>
      </div>
    </div>
    <div style="padding:11px;background:rgba(255,255,255,0.03);border-radius:6px">${verdict}</div>
  </div>`;
}

function deltaHtml(current: number, base: number): string {
  if (base <= 0) return `<span style="color:#666">—</span>`;
  // Rounded first so float noise on equal sums can't print "−0%".
  const pct = Math.round(((current - base) / base) * 100);
  // More spending is the bad direction here.
  const color = Math.abs(pct) < 5 ? "#888" : pct > 0 ? "#ff6b6b" : "#4caf82";
  return `<span style="color:${color}">${pct >= 0 ? "+" : "−"}${fmt(Math.abs(pct))}%</span>`;
}

function renderWeek(r: WeekReport, rub: number): string {
  const s = r.summary;
  const head = `
    <h3 style="color:#4fc3f7;margin-bottom:2px">📅 Неделя ${esc(r.label)}</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:14px">
      ${esc(r.ofMonthLabel)}${r.isCurrent ? ` · идёт ${r.daysElapsed}-й день из 7 — сравнения неполные` : ""}
    </div>`;

  const maxHist = Math.max(...r.history.map((h) => h.totalUsd), 1);
  const histBars = r.history
    .map((h) => {
      const isThis = h.start === r.start;
      const pct = (h.totalUsd / maxHist) * 100;
      return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0" title="${esc(h.label)}: $${fmt(h.totalUsd, 2)}">
        <div style="font-size:.7rem;color:#888">${h.totalUsd > 0 ? "$" + fmt(h.totalUsd) : ""}</div>
        <div style="width:100%;height:70px;display:flex;align-items:flex-end">
          <div style="width:100%;height:${h.totalUsd > 0 ? Math.max(pct, 3).toFixed(1) : 0}%;background:${isThis ? "#4fc3f7" : "#3a5a70"};border-radius:3px 3px 0 0"></div>
        </div>
        <div style="font-size:.65rem;color:${isThis ? "#4fc3f7" : "#666"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">${esc(h.label)}</div>
      </div>`;
    })
    .join("");
  const history = `
    <div style="margin-top:16px">
      <div style="color:#999;font-size:.85rem;margin-bottom:6px">Последние ${r.history.length} недель
        <span style="color:#666">· пустая неделя = ничего не записано, а не «ничего не потратили»</span></div>
      <div style="display:flex;gap:6px;align-items:flex-end">${histBars}</div>
    </div>`;

  if (s.totalUsd === 0) {
    return `
    <div class="section" style="border-color:#4fc3f7">
      ${head}
      <div style="color:#888;font-size:.9rem">
        📭 ${r.isCurrent ? "Пока" : "За эту неделю"} ничего не записано. Быстрее всего — на кассе:
        камера на QR чека → ссылку боту в Telegram. Наличку — кнопками в боте.
      </div>
      ${history}
    </div>`;
  }

  const prevByCat = new Map(r.previous.categories.map((c) => [c.category, c.totalUsd]));
  const catRows = s.categories
    .slice(0, 10)
    .map((c) => {
      const prev = prevByCat.get(c.category) ?? 0;
      return `
      <tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${cashColor(c.category)};margin-right:8px"></span>${esc(c.category)}</td>
        <td>$${fmt(c.totalUsd, 2)}</td>
        <td style="color:#888">${prev > 0 ? "$" + fmt(prev, 2) : "—"}</td>
        <td>${prev > 0 ? deltaHtml(c.totalUsd, prev) : `<span style="color:#666">новое</span>`}</td>
      </tr>`;
    })
    .join("");

  const stat = (label: string, value: string, sub: string, color = "#fff") => `
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">${label}</div>
        <div style="font-size:1.5rem;color:${color};font-weight:700">${value}</div>
        <div style="font-size:.75rem;color:#666">${sub}</div>
      </div>`;

  return `
  <div class="section" style="border-color:#4fc3f7">
    ${head}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px;margin-bottom:16px">
      ${stat("Потрачено", "$" + fmt(s.totalUsd), `~${fmt(s.totalUsd * rub)} руб ПМР`, "#4fc3f7")}
      ${stat("Прошлая неделя", r.previous.totalUsd > 0 ? "$" + fmt(r.previous.totalUsd) : "—", r.previous.totalUsd > 0 ? `разница ${deltaHtml(s.totalUsd, r.previous.totalUsd)}` : "нет записей")}
      ${stat("Обычная неделя", r.avgUsd !== null ? "$" + fmt(r.avgUsd) : "—", r.avgUsd !== null ? `среднее за ${r.avgWeeks} нед. · ${deltaHtml(s.totalUsd, r.avgUsd)}` : "мало истории")}
      ${stat("Состав", `$${fmt(s.foodUsd)} / $${fmt(s.householdUsd)} / $${fmt(s.otherUsd)}`, `еда / хоз / остальное · ${s.receiptCount} чек. · ${s.cashCount} зап.`)}
    </div>
    <table>
      <thead><tr><th>Категория</th><th>Эта неделя</th><th>Прошлая</th><th>Разница</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>
    ${history}
  </div>`;
}

function renderMonth(m: MonthReport, rub: number): string {
  const s = m.summary;
  const basis = m.isCurrent ? m.projectedUsd : s.totalUsd;
  const v = basis !== null ? budgetVerdict(basis, m.budgetUsd) : null;
  const vColor = !v ? "#888" : v.tone === "over" ? "#ff6b6b" : v.tone === "ok" ? "#4caf82" : "#64b5f6";
  const usedPct = m.budgetUsd > 0 ? (s.totalUsd / m.budgetUsd) * 100 : 0;
  const elapsedPct = (m.daysElapsed / m.daysInMonth) * 100;

  const weekRows = m.weeks
    .map(
      (w) => `
      <tr>
        <td>${ordinalWeek(w.n)}</td>
        <td style="color:#888">${esc(w.label)}</td>
        <td>${w.totalUsd > 0 ? "$" + fmt(w.totalUsd, 2) : `<span style="color:#666">—</span>`}</td>
      </tr>`,
    )
    .join("");

  return `
  <div class="section" style="border-color:#ba68c8">
    <h3 style="color:#ba68c8;margin-bottom:2px">🗓 ${esc(m.label)}${m.isCurrent ? "" : " — итог"}</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:14px">
      Сравниваю с переменной частью быта ($${fmt(m.budgetUsd)}/мес) — аренда, коммуналка и телефоны в чеки не попадают.
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px;margin-bottom:14px">
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">Записано</div>
        <div style="font-size:1.5rem;color:#ba68c8;font-weight:700">$${fmt(s.totalUsd)}</div>
        <div style="font-size:.75rem;color:#666">~${fmt(s.totalUsd * rub)} руб · ${s.activeDays} дн. с записями</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">${m.isCurrent ? "Темп на месяц" : "Итог месяца"}</div>
        <div style="font-size:1.5rem;color:#fff;font-weight:700">${basis !== null ? "$" + fmt(basis) : "—"}</div>
        <div style="font-size:.75rem;color:#666">${m.isCurrent ? (basis !== null ? `по ${m.daysElapsed} дн. из ${m.daysInMonth}` : "прогноз — с 7-го числа") : `${m.daysInMonth} дн.`}</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem;margin-bottom:5px">Бюджет</div>
        <div style="font-size:1.5rem;color:#fff;font-weight:700">$${fmt(m.budgetUsd)}</div>
        <div style="font-size:.75rem;color:${vColor}">${v ? esc(v.text) : "—"}</div>
      </div>
    </div>
    <div style="position:relative;background:#1a1d27;border-radius:4px;height:12px;overflow:hidden;margin-bottom:4px">
      <div style="height:100%;width:${Math.min(usedPct, 100).toFixed(1)}%;background:${usedPct > 100 ? "#ff6b6b" : "#ba68c8"}"></div>
      ${m.isCurrent ? `<div title="Прошло ${fmt(elapsedPct)}% месяца" style="position:absolute;top:0;bottom:0;left:${elapsedPct.toFixed(1)}%;width:2px;background:#fff"></div>` : ""}
    </div>
    <div style="font-size:.75rem;color:#666;margin-bottom:14px">
      Потрачено ${fmt(usedPct)}% бюджета${m.isCurrent ? ` · белая черта — прошло ${fmt(elapsedPct)}% месяца` : ""}
    </div>
    ${s.activeDays > 0 && s.activeDays < 7 ? `<div style="color:#ffc107;font-size:.85rem;margin-bottom:12px">⚠️ Записи только за ${s.activeDays} дн. — итог, скорее всего, неполный.</div>` : ""}
    ${renderMonthCategories(m)}
    <table>
      <thead><tr><th>Неделя месяца</th><th>Даты</th><th>Потрачено</th></tr></thead>
      <tbody>${weekRows}</tbody>
    </table>
  </div>`;
}

/** "2026-10-14" → "14.10". */
const dayMonth = (d: string): string => `${d.slice(8, 10)}.${d.slice(5, 7)}`;

// Colours of the month-chart buckets (see rollupCategories); plain categories keep theirs.
const ROLLUP_COLORS: Record<string, string> = {
  Продукты: "#81c784",
  "Хозтовары и химия": "#90a4ae",
  "Кафе и перекусы": "#ffb74d",
};

const bucketColor = (c: string): string => ROLLUP_COLORS[c] ?? cashColor(c);

/** Where the month's money went: chequed items and cash together, vs the month before. */
function renderMonthCategories(m: MonthReport): string {
  const s = m.summary;
  const cats = rollupCategories(s.categories, s.totalUsd).filter((c) => c.totalUsd >= 0.5);
  if (cats.length === 0) return "";
  const prevByCat = new Map(rollupCategories(m.previous.categories, m.previous.totalUsd).map((c) => [c.category, c.totalUsd]));
  const hasPrev = m.previous.totalUsd > 0;
  const max = cats[0]!.totalUsd;

  // One stacked strip: the big categories in colour, the tail as one grey block.
  const TOP = 8;
  const top = cats.slice(0, TOP);
  const restUsd = cats.slice(TOP).reduce((a, c) => a + c.totalUsd, 0);
  const seg = (label: string, usd: number, color: string) => {
    const pct = (usd / s.totalUsd) * 100;
    return `<div title="${esc(label)}: $${fmt(usd, 2)} (${fmt(pct)}%)" style="width:${pct.toFixed(2)}%;background:${color};display:flex;align-items:center;justify-content:center;font-size:.7rem;color:#111;font-weight:700;overflow:hidden;white-space:nowrap">${pct >= 8 ? esc(label) : ""}</div>`;
  };
  const strip = `
    <div style="display:flex;height:26px;border-radius:5px;overflow:hidden;margin-bottom:12px;background:#1a1d27">
      ${top.map((c) => seg(c.category, c.totalUsd, bucketColor(c.category))).join("")}
      ${restUsd > 0 ? seg(`Остальное (${cats.length - TOP})`, restUsd, "#555") : ""}
    </div>`;

  const row = (c: (typeof cats)[number]) => {
    const prev = prevByCat.get(c.category) ?? 0;
    const dot = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${bucketColor(c.category)};margin-right:8px"></span>`;
    // A bucket made of several categories opens to show them: Продукты → Мясо, Молочка…
    // Детское opens by kind instead, each with its purchases.
    const parts = c.parts.filter((p) => p.totalUsd >= 0.5);
    const line = (label: string, usd: number, strong = false) =>
      `<div style="display:flex;justify-content:space-between;gap:12px;max-width:340px${strong ? ";color:#ddd" : ""}"><span>${label}</span><span>$${fmt(usd, 2)}</span></div>`;
    const kids = c.category === "Детское" && m.kids.length > 0
      ? m.kids.map((k) => `
          <div style="margin-bottom:6px">
            ${line(esc(k.kind), k.totalUsd, true)}
            ${k.items.map((i) => `<div style="display:flex;justify-content:space-between;gap:12px;max-width:340px;padding-left:12px;color:#888;font-size:.75rem"><span>${dayMonth(i.date)} · ${esc(i.label)}</span><span>$${fmt(i.usd, 2)}</span></div>`).join("")}
          </div>`).join("")
      : "";
    const name = kids || parts.length > 1 || (parts.length === 1 && parts[0]!.category !== c.category)
      ? `<details><summary style="cursor:pointer">${dot}${esc(c.category)}</summary>
          <div style="margin:6px 0 2px 18px;font-size:.8rem;color:#aaa;line-height:1.7">
            ${kids || parts.map((p) => line(esc(p.category), p.totalUsd)).join("")}
          </div></details>`
      : `${dot}${esc(c.category)}`;
    return `
      <tr>
        <td>${name}</td>
        <td style="vertical-align:top">$${fmt(c.totalUsd, 2)}</td>
        <td style="width:34%;vertical-align:top">
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
            <div style="flex:1;background:#1a1d27;border-radius:3px;height:8px;overflow:hidden">
              <div style="height:100%;width:${((c.totalUsd / max) * 100).toFixed(1)}%;background:${bucketColor(c.category)}"></div>
            </div>
            <span style="color:#888;font-size:.8rem;min-width:42px;text-align:right">${fmt(c.share * 100, 1)}%</span>
          </div>
        </td>
        ${hasPrev ? `<td style="color:#888;vertical-align:top">${prev > 0 ? "$" + fmt(prev, 2) : "—"}</td>` : ""}
      </tr>`;
  };
  const head = `<thead><tr><th>Категория <span style="text-transform:none;font-weight:400;color:#666">(нажми — подробно)</span></th><th>${m.isCurrent ? "Этот месяц" : "За месяц"}</th><th>Доля</th>${hasPrev ? "<th>Прошлый</th>" : ""}</tr></thead>`;
  const SHOWN = 12;
  const more = cats.length > SHOWN
    ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:#ba68c8;font-size:.85rem">Ещё ${cats.length - SHOWN} категорий</summary>
        <table style="margin-top:6px">${head}<tbody>${cats.slice(SHOWN).map(row).join("")}</tbody></table></details>`
    : "";
  return `
    <div style="margin-bottom:18px">
      <div style="color:#999;font-size:.85rem;margin-bottom:6px">По категориям — чеки и наличка вместе</div>
      ${strip}
      <table>${head}<tbody>${cats.slice(0, SHOWN).map(row).join("")}</tbody></table>
      ${more}
    </div>`;
}

function renderCashBreakdown(cs: CashStats): string {
  if (cs.categories.length === 0) return "";
  const rows = cs.categories
    .map((c) => {
      const pct = c.share * 100;
      return `
      <tr>
        <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${cashColor(c.category)};margin-right:8px"></span>${esc(c.category)}</td>
        <td>$${fmt(c.totalUsd, 2)}</td>
        <td style="width:38%">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:#1a1d27;border-radius:3px;height:7px;overflow:hidden">
              <div style="height:100%;width:${pct.toFixed(1)}%;background:${cashColor(c.category)}"></div>
            </div>
            <span style="color:#888;font-size:.85rem;min-width:44px">${pct.toFixed(1)}%</span>
          </div>
        </td>
        <td style="color:#888">${c.count}</td>
      </tr>`;
    })
    .join("");
  return `
  <div class="section">
    <h3 style="color:#ffb74d;margin-bottom:4px">💸 Наличка по категориям</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:12px">
      В среднем $${fmt(cs.perDayUsd, 2)}/день — это $${fmt(cs.perDayUsd * 30)}/мес, если темп сохранится.
    </div>
    <table>
      <thead><tr><th>Категория</th><th>Сумма</th><th>Доля</th><th>Раз</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderCashList(expenses: CashExpense[]): string {
  if (expenses.length === 0) return "";
  const rows = expenses
    .slice(0, 60)
    .map(
      (e) => `
      <tr>
        <td style="color:#888;white-space:nowrap">${e.date}</td>
        <td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${cashColor(e.category)};margin-right:6px"></span>${esc(e.category)}</td>
        <td>${fmt(e.amount, e.amount % 1 ? 2 : 0)} <span style="color:#666">${esc(e.currency)}</span></td>
        <td class="green">$${fmt(e.amountUsd, 2)}</td>
        <td style="color:#888">
          ${e.source === "telegram" ? '<span title="Внесено через Telegram">✈️</span> ' : ""}${e.addedBy ? `<span style="color:#64b5f6">${esc(e.addedBy)}</span> ` : ""}${e.note ? esc(e.note) : ""}
        </td>
        <td><button onclick="cashDel('${esc(e.id)}')" style="background:none;border:none;color:#666;cursor:pointer;font-size:.95rem;padding:2px 5px">🗑</button></td>
      </tr>`,
    )
    .join("");
  return `
  <div class="section">
    <h3 style="color:#ffb74d;margin-bottom:12px">💸 Записи (${expenses.length})</h3>
    <table>
      <thead><tr><th>Дата</th><th>Категория</th><th>Сумма</th><th>USD</th><th>Заметка</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <script>
    async function cashDel(id) {
      if (!confirm('Удалить запись?')) return;
      try {
        var r = await fetch('/api/expenses/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        location.reload();
      } catch (e) { alert('Ошибка: ' + e); }
    }
  </script>`;
}

export function renderReceiptsPage(
  receipts: Receipt[],
  stats: ReceiptStats,
  expenses: CashExpense[] = [],
  cashStats: CashStats = {
    count: 0,
    totalUsd: 0,
    categories: [],
    byMonth: new Map(),
    firstDate: null,
    lastDate: null,
    perDayUsd: 0,
  },
  presets: Preset[] = [],
  budgetUsd = 0,
  week: WeekReport | null = null,
  month: MonthReport | null = null,
  rub = 16.3,
): string {
  const nothing = receipts.length === 0 && expenses.length === 0;
  const body = nothing
    ? renderEmpty()
    : `
    ${week ? renderWeek(week, rub) : ""}
    ${month ? renderMonth(month, rub) : ""}
    ${renderOverview(stats, cashStats, budgetUsd)}
    ${renderCashBreakdown(cashStats)}
    ${receipts.length > 0 ? renderStats(stats) : ""}
    ${renderCategoryTable(stats.foodCategories, "🍽 Рацион семьи", stats.foodUsd, "Доли внутри продуктовых трат — что семья реально ест, в деньгах.")}
    ${renderCategoryTable(stats.categories, "📦 Все категории (по чекам)", stats.totalUsd, "Включая бытовую химию и хозтовары — они часто съедают больше, чем кажется.")}
    ${renderMonths(stats)}
    ${renderTopItems(stats)}
    ${renderUncategorised(stats)}
    ${renderCashList(expenses)}
    ${renderReceiptList(receipts)}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🧾 Траты | EarnOptimizer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1d27 0%, #16191f 100%);
      color: #e0e0e0; line-height: 1.6; min-height: 100vh; padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 24px; padding: 20px;
      background: rgba(76, 175, 130, 0.1);
      border: 1px solid #4caf82; border-radius: 8px; flex-wrap: wrap; gap: 12px;
    }
    h1 { font-size: 1.8rem; color: #4caf82; }
    nav a {
      color: #4caf82; text-decoration: none; margin-left: 12px; padding: 6px 12px;
      border: 1px solid #4caf82; border-radius: 6px; font-weight: 600; transition: all .2s;
      display: inline-block;
    }
    nav a:hover, nav a.active { background: #4caf82; color: #000; }
    .section {
      background: #252836; border: 1px solid #3a3f4d; border-radius: 8px;
      padding: 20px; margin-bottom: 20px;
    }
    table { width: 100%; border-collapse: collapse; background: #1a1d27; border-radius: 6px; overflow: hidden; }
    thead { background: #2a2d37; }
    th, td { padding: 9px 13px; text-align: left; border-bottom: 1px solid #2a2d37; vertical-align: middle; }
    th { color: #4caf82; font-weight: 700; text-transform: uppercase; font-size: .78rem; }
    tr:hover { background: #2a2d37; }
    .green { color: #4caf82; }
    h3 { font-size: 1.1rem; }
    button {
      background: #4caf82; border: none; border-radius: 6px; color: #000;
      padding: 8px 14px; font-size: .9rem; font-weight: 600; cursor: pointer; transition: background .2s;
    }
    button:hover { background: #66bb6a; }
    button:disabled { background: #3a3f4d; color: #888; cursor: default; }
    @media (max-width: 700px) {
      ul[style*="columns"] { columns: 1 !important; }
      body { padding: 10px; }
      .section { padding: 14px; }
      th, td { padding: 7px 7px; }
    }
    /* Wide tables scroll inside their own card instead of stretching the page on a phone. */
    .section { overflow-x: auto; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🧾 Траты и рацион</h1>
      <nav>
        <a href="${config.earn.url}" title="Крипто-оптимизатор — отдельное приложение (npm run dev:earn)">📈 Earn</a>
        <a href="/finance">💼 Финансы</a>
        <a href="/receipts" class="active">🧾 Траты</a>
        <a href="/shopping">🛒 Списки</a>
      </nav>
    </header>
    ${renderQuickAdd(presets)}
    ${renderAddBox()}
    ${body}
    <footer style="text-align:center;margin-top:40px;color:#666;font-size:.85rem">
      Данные в <code>data/receipts.json</code>. Категории проставляются по названию товара — правила в <code>src/receipts/index.ts</code>.
    </footer>
  </div>
</body>
</html>`;
}
