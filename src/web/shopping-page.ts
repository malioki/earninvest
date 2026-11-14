import { config } from "../config/index.js";
import type { ShoppingList, availablePeriods } from "../shopping/index.js";
import {
  USUAL_FREQUENCY,
  formatListText,
  formatQty,
  frequencyLabel,
  listTotals,
} from "../shopping/index.js";
import { addDays, daysInMonth, ordinalWeek } from "../spending/index.js";

type Periods = ReturnType<typeof availablePeriods>;

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

const dm = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

function renderCreate(p: Periods, currentN: number): string {
  if (p.weeks.length === 0) {
    return `
    <div class="section">
      <h3 style="color:#4caf82;margin-bottom:6px">➕ Новый список</h3>
      <div style="color:#888;font-size:.9rem">
        Списки собираются из чеков — по позициям, которые реально покупали. Чеков пока нет.
        Самый быстрый способ: на кассе навести камеру на QR чека и переслать ссылку боту в Telegram.
      </div>
    </div>`;
  }

  const periodOptions = [
    ...p.weeks.map(
      (w) =>
        `<option value="${w.start}|${addDays(w.start, 6)}">Неделя ${esc(w.label)} · ${w.count} чек.</option>`,
    ),
    ...p.months.map(
      (m) =>
        `<option value="${m.month}-01|${m.month}-${String(daysInMonth(m.month)).padStart(2, "0")}">${esc(m.label)} целиком · ${m.count} чек.</option>`,
    ),
  ].join("");

  const weekNOptions = p.weekNs
    .map(
      (w) =>
        `<option value="${w.n}" ${w.weeks === 0 ? "disabled" : ""} ${w.n === currentN ? "selected" : ""}>` +
        `${ordinalWeek(w.n)}${w.n === currentN ? " (сейчас)" : ""} · ${w.weeks === 0 ? "нет данных" : `по ${w.weeks} нед.`}</option>`,
    )
    .join("");

  const card = (title: string, hint: string, control: string) => `
    <div style="background:#1a1d27;border:1px solid #2f3341;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px">
      <div style="font-weight:700">${title}</div>
      <div style="color:#888;font-size:.85rem;flex:1">${hint}</div>
      ${control}
    </div>`;

  return `
  <div class="section">
    <h3 style="color:#4caf82;margin-bottom:12px">➕ Новый список</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
      ${card(
        "🔁 Повторить период",
        "Всё, что купили за конкретную неделю или месяц, — как чек-лист.",
        `<select id="sl-period">${periodOptions}</select>
         <button onclick="slCreatePeriod()">Собрать</button>`,
      )}
      ${card(
        "📆 Типичная неделя месяца",
        "Что обычно берёте в N-ю неделю: в начале месяца (детские, invoice) корзина другая, чем в конце.",
        `<select id="sl-weekn">${weekNOptions}</select>
         <button onclick="slCreateWeekN()">Собрать</button>`,
      )}
      ${card(
        "🗓 Типичный месяц",
        `Средняя месячная корзина по ${p.months.length} мес. Пометка «иногда» — то, что брали не каждый месяц.`,
        `<button onclick="slCreate({kind:'typical-month'})">Собрать</button>`,
      )}
    </div>
  </div>`;
}

function renderList(list: ShoppingList): string {
  const t = listTotals(list);
  const done = list.items.filter((i) => i.checked).length;
  const hasFreq = list.items.some((i) => i.frequency !== undefined);

  let cat = "";
  const rows = list.items
    .map((i) => {
      const header =
        i.category !== cat
          ? `<div class="sl-cat">${esc((cat = i.category))}</div>`
          : "";
      const rare = (i.frequency ?? 1) < USUAL_FREQUENCY;
      const freq = frequencyLabel(i, list.periods);
      return `${header}
      <div class="sl-item${i.checked ? " checked" : ""}" data-list="${esc(list.id)}" data-key="${esc(i.key)}">
        <span class="sl-box"></span>
        <span class="sl-name">${esc(i.name)}${i.custom ? ' <span class="sl-tag">своё</span>' : ""}</span>
        ${freq ? `<span class="sl-tag" style="color:${rare ? "#888" : "#4caf82"}" title="Покупали в ${freq} периодов">${freq}${rare ? " · иногда" : ""}</span>` : ""}
        <span class="sl-qty">${formatQty(i)}</span>
        <span class="sl-price">${i.estPrice > 0 ? "≈" + fmt(i.estPrice) : ""}</span>
        <button class="sl-del" data-action="remove" title="Убрать из списка">✕</button>
      </div>`;
    })
    .join("");

  return `
  <div class="section sl-list" id="list-${esc(list.id)}">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
      <div style="min-width:0">
        <h3 style="color:#4caf82">🛒 ${esc(list.title)}</h3>
        <div style="color:#888;font-size:.85rem">${esc(list.basis)}</div>
        <div style="color:#666;font-size:.75rem">создан ${dm(list.createdAt)}${list.updatedAt.slice(0, 10) !== list.createdAt.slice(0, 10) ? ` · изменён ${dm(list.updatedAt)}` : ""}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
        <button class="ghost" onclick="slRegen('${esc(list.id)}')" title="Собрать заново по свежим чекам. Галочки сбросятся, свои позиции останутся.">🔄 Пересоздать</button>
        <button class="ghost" onclick="slCopy('${esc(list.id)}')">📋 Скопировать</button>
        <button class="ghost" onclick="slDelete('${esc(list.id)}')">🗑</button>
      </div>
    </div>
    <div style="color:#bbb;font-size:.9rem;margin-bottom:10px">
      Отмечено <b class="sl-done">${done}</b> из ${list.items.length}
      · всего ≈ ${fmt(t.all)} руб${hasFreq && t.usual < t.all - 0.5 ? ` (без «иногда» ≈ ${fmt(t.usual)})` : ""}
    </div>
    <div>${rows}</div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <input id="add-${esc(list.id)}" placeholder="Добавить своё: хлеб, батарейки…" onkeydown="if(event.key==='Enter')slAdd('${esc(list.id)}')">
      <button onclick="slAdd('${esc(list.id)}')">+ Добавить</button>
    </div>
    <textarea id="txt-${esc(list.id)}" style="position:absolute;left:-9999px" readonly>${esc(formatListText(list))}</textarea>
  </div>`;
}

export function renderShoppingPage(
  lists: ShoppingList[],
  periods: Periods,
  currentWeekN: number,
): string {
  const listsHtml =
    lists.length > 0
      ? lists.map(renderList).join("")
      : periods.weeks.length > 0
        ? `<div class="section" style="color:#888">Списков пока нет — собери первый выше.</div>`
        : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>🛒 Списки | EarnOptimizer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1d27 0%, #16191f 100%);
      color: #e0e0e0; line-height: 1.5; min-height: 100vh; padding: 20px;
    }
    .container { max-width: 1000px; margin: 0 auto; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 24px; padding: 20px;
      background: rgba(76, 175, 130, 0.1);
      border: 1px solid #4caf82; border-radius: 8px; flex-wrap: wrap; gap: 12px;
    }
    h1 { font-size: 1.8rem; color: #4caf82; }
    h3 { font-size: 1.1rem; }
    nav a {
      color: #4caf82; text-decoration: none; margin-left: 12px; padding: 6px 12px;
      border: 1px solid #4caf82; border-radius: 6px; font-weight: 600; transition: all .2s;
      display: inline-block;
    }
    nav a:hover, nav a.active { background: #4caf82; color: #000; }
    .section {
      background: #252836; border: 1px solid #3a3f4d; border-radius: 8px;
      padding: 20px; margin-bottom: 20px; position: relative;
    }
    button {
      background: #4caf82; border: none; border-radius: 6px; color: #000;
      padding: 8px 14px; font-size: .9rem; font-weight: 600; cursor: pointer; transition: background .2s;
    }
    button:hover { background: #66bb6a; }
    button.ghost { background: none; border: 1px solid #3a3f4d; color: #bbb; }
    button.ghost:hover { border-color: #4caf82; color: #4caf82; }
    select, input {
      background: #252836; border: 1px solid #3a3f4d; border-radius: 6px; color: #e0e0e0;
      padding: 8px 10px; font-size: .9rem; width: 100%;
    }
    .sl-cat { color: #4caf82; font-size: .78rem; font-weight: 700; text-transform: uppercase; margin: 14px 0 4px; }
    .sl-item {
      display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 6px;
      cursor: pointer; user-select: none; border-bottom: 1px solid #2a2d37;
    }
    .sl-item:hover { background: #2a2d37; }
    .sl-box { flex: none; width: 20px; height: 20px; border: 2px solid #4caf82; border-radius: 4px; }
    .sl-item.checked .sl-box { background: #4caf82; }
    .sl-item.checked .sl-box::after { content: "✓"; color: #000; font-weight: 700; display: block; text-align: center; line-height: 16px; }
    .sl-item.checked .sl-name { text-decoration: line-through; color: #666; }
    .sl-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .sl-qty { color: #bbb; white-space: nowrap; }
    .sl-price { color: #888; font-size: .85rem; min-width: 52px; text-align: right; white-space: nowrap; }
    .sl-tag { font-size: .75rem; color: #888; white-space: nowrap; }
    .sl-del { background: none; color: #666; padding: 2px 6px; font-size: .9rem; }
    .sl-del:hover { background: none; color: #ff6b6b; }
    @media (max-width: 600px) { .sl-price { display: none; } nav a { margin: 4px 4px 0 0; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🛒 Списки покупок</h1>
      <nav>
        <a href="${config.earn.url}" title="Крипто-оптимизатор — отдельное приложение (npm run dev:earn)">📈 Earn</a>
        <a href="/finance">💼 Финансы</a>
        <a href="/receipts">🧾 Траты</a>
        <a href="/shopping" class="active">🛒 Списки</a>
      </nav>
    </header>
    ${renderCreate(periods, currentWeekN)}
    ${listsHtml}
    <footer style="text-align:center;margin-top:40px;color:#666;font-size:.85rem">
      В магазине удобнее через бота: кнопка «🛒 Список» или /list. Данные — в <code>data/shopping-lists.json</code>.
    </footer>
  </div>
  <script>
    async function api(method, url, body) {
      var r = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      var j = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    }
    async function slCreate(source) {
      try { await api('POST', '/api/shopping', { source: source }); location.reload(); }
      catch (e) { alert(e.message); }
    }
    function slCreatePeriod() {
      var v = document.getElementById('sl-period').value.split('|');
      slCreate({ kind: 'period', from: v[0], to: v[1] });
    }
    function slCreateWeekN() {
      slCreate({ kind: 'typical-week', n: Number(document.getElementById('sl-weekn').value) });
    }
    async function slRegen(id) {
      if (!confirm('Собрать список заново по свежим чекам? Галочки сбросятся, свои позиции останутся.')) return;
      try { await api('POST', '/api/shopping/' + id + '/regenerate'); location.reload(); }
      catch (e) { alert(e.message); }
    }
    async function slDelete(id) {
      if (!confirm('Удалить список?')) return;
      try { await api('DELETE', '/api/shopping/' + id); location.reload(); }
      catch (e) { alert(e.message); }
    }
    async function slAdd(id) {
      var input = document.getElementById('add-' + id);
      if (!input.value.trim()) return;
      try { await api('POST', '/api/shopping/' + id + '/items', { name: input.value }); location.reload(); }
      catch (e) { alert(e.message); }
    }
    function slCopy(id) {
      var ta = document.getElementById('txt-' + id);
      var done = function () { alert('Скопировано — можно вставить в мессенджер.'); };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
      } else { ta.select(); document.execCommand('copy'); done(); }
    }
    function updateDone(listEl) {
      listEl.querySelector('.sl-done').textContent = listEl.querySelectorAll('.sl-item.checked').length;
    }
    // One delegated handler: keys are arbitrary product names, so they travel
    // in data attributes rather than being spliced into inline JS.
    document.addEventListener('click', async function (ev) {
      var row = ev.target.closest('.sl-item');
      if (!row) return;
      var id = row.dataset.list, key = row.dataset.key;
      if (ev.target.closest('[data-action="remove"]')) {
        try { await api('POST', '/api/shopping/' + id + '/remove', { key: key }); location.reload(); }
        catch (e) { alert(e.message); }
        return;
      }
      row.classList.toggle('checked');
      updateDone(row.closest('.sl-list'));
      try { await api('POST', '/api/shopping/' + id + '/toggle', { key: key }); }
      catch (e) { row.classList.toggle('checked'); updateDone(row.closest('.sl-list')); alert(e.message); }
    });
  </script>
</body>
</html>`;
}
