import type {
  FinanceMetrics,
  CreditWithMetrics,
  AllocationPlan,
} from "../finance/index.js";
import {
  nextPriorityCredit,
  recommendAllocation,
  buildPayoffPlan,
} from "../finance/index.js";
import type { FinanceSnapshot } from "../finance/snapshots.js";

const fmt = (n: number, d = 0): string =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

function trafficLight(metrics: FinanceMetrics): {
  status: "red" | "yellow" | "green";
  text: string;
  detail: string;
} {
  const toxic = metrics.credits.filter((c) => c.aprPct >= 30 && c.balance > 0);
  const normal = metrics.credits.filter(
    (c) => c.aprPct > 0 && c.aprPct < 20 && c.balance > 0,
  );
  if (toxic.length > 0) {
    return {
      status: "red",
      text: "🔴 ГАСИ КРЕДИТЫ",
      detail: `Токсичных кредитов: ${toxic.length}. Каждый день горит $${fmt(metrics.totalDailyInterestUsd, 2)} процентов. Любая инвестиция в это время — потеря денег.`,
    };
  }
  if (normal.length > 0) {
    return {
      status: "yellow",
      text: "🟡 МИКС: гаси норм. кредиты + начинай инвестировать",
      detail: `Остались только кредиты под ≤11%. Можно параллельно начать DCA в ETF и пополнять Earn-портфель.`,
    };
  }
  return {
    status: "green",
    text: "🟢 ИНВЕСТИРУЙ",
    detail: `Все кредиты закрыты. Весь свободный поток — в портфель.`,
  };
}

function renderTrafficLight(metrics: FinanceMetrics): string {
  const tl = trafficLight(metrics);
  const colors = {
    red: {
      bg: "rgba(255, 107, 107, 0.12)",
      border: "#ff6b6b",
      text: "#ff6b6b",
    },
    yellow: {
      bg: "rgba(255, 193, 7, 0.12)",
      border: "#ffc107",
      text: "#ffc107",
    },
    green: {
      bg: "rgba(76, 175, 130, 0.12)",
      border: "#4caf82",
      text: "#4caf82",
    },
  }[tl.status];
  return `
  <div class="section" style="background:${colors.bg};border-color:${colors.border}">
    <div style="font-size:1.4rem;font-weight:700;color:${colors.text};margin-bottom:8px">${tl.text}</div>
    <div style="color:#ccc">${tl.detail}</div>
  </div>`;
}

function renderTopStats(metrics: FinanceMetrics): string {
  return `
  <div class="section">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px">
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">🔥 Кредиты</div>
        <div style="font-size:1.6rem;color:#ff6b6b;font-weight:700">$${fmt(metrics.totalCreditBalanceUsd)}</div>
        <div style="font-size:0.8rem;color:#666">${fmt(metrics.totalCreditBalanceMdl)} MDL<br>+ личные $${fmt(metrics.totalPersonalDebtsUsd)} = <b>$${fmt(metrics.totalCreditBalanceUsd + metrics.totalPersonalDebtsUsd)}</b></div>
      </div>
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">💸 Горит процентов / день</div>
        <div style="font-size:1.6rem;color:#ff6b6b;font-weight:700">$${fmt(metrics.totalDailyInterestUsd, 2)}</div>
        <div style="font-size:0.8rem;color:#666">$${fmt(metrics.totalMonthlyInterestUsd, 0)} / мес</div>
      </div>
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">💵 Свободный поток / мес</div>
        <div style="font-size:1.6rem;color:#4caf82;font-weight:700">$${fmt(metrics.freeCashFlowUsd)}</div>
        <div style="font-size:0.8rem;color:#666">Доход − жизнь − платежи</div>
      </div>
      <div>
        <div style="font-size:0.9rem;color:#999;margin-bottom:6px">🏦 Реально доступно</div>
        <div style="font-size:1.6rem;color:#4caf82;font-weight:700">$${fmt(metrics.freeCashUsd)}</div>
        <div style="font-size:0.8rem;color:#666">Тратимых $${fmt(metrics.spendableAssetsUsd)} − брони $${fmt(metrics.totalEarmarkedUsd)}<br>Активов всего $${fmt(metrics.totalLiquidAssetsUsd)} (с резервами)</div>
      </div>
    </div>
  </div>`;
}

function renderCreditsTable(metrics: FinanceMetrics): string {
  const next = nextPriorityCredit(metrics);
  const rows = metrics.credits
    .sort((a, b) => b.aprPct - a.aprPct)
    .map((c) => {
      const isNext = next?.id === c.id;
      const aprColor =
        c.aprPct >= 30 ? "#ff6b6b" : c.aprPct >= 15 ? "#ffc107" : "#4caf82";
      const months = c.monthsToPayoffMin;
      const payoff =
        months === null
          ? '<span style="color:#ff6b6b">НИКОГДА (платёж < %)</span>'
          : `${months.toFixed(1)} мес`;
      return `
        <tr ${isNext ? 'style="background:rgba(255,107,107,0.08)"' : ""}>
          <td>${isNext ? "🎯 " : ""}<b>${c.name}</b>${c.note ? `<div style="font-size:.75rem;color:#888;margin-top:4px">${c.note}</div>` : ""}</td>
          <td>$${fmt(c.balanceUsd)}<div style="font-size:.75rem;color:#666">${fmt(c.balance)} ${c.currency}</div></td>
          <td style="color:${aprColor};font-weight:700">${c.aprPct.toFixed(2)}%</td>
          <td>$${fmt(c.monthlyPaymentUsd)}<div style="font-size:.75rem;color:#666">${fmt(c.monthlyPayment)} ${c.currency}</div></td>
          <td style="color:#ff6b6b">$${fmt(c.monthlyInterestUsd, 2)}/мес<br><span style="font-size:.75rem">$${fmt(c.dailyInterestUsd, 2)}/день</span></td>
          <td>${payoff}</td>
        </tr>`;
    })
    .join("");
  return `
  <div class="section">
    <h3 style="margin-bottom:12px;color:#ff6b6b">🔥 Кредиты</h3>
    <table>
      <thead>
        <tr>
          <th>Кредитор</th><th>Остаток</th><th>APR</th><th>Платёж/мес</th><th>Горит %</th><th>Закроется при мин. платеже</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot style="border-top:2px solid #ff6b6b;font-weight:700">
        <tr>
          <td>Итого (${metrics.credits.filter((c) => c.balance > 0).length} активных)</td>
          <td>$${fmt(metrics.totalCreditBalanceUsd)}</td>
          <td>—</td>
          <td>$${fmt(metrics.totalMonthlyPaymentUsd)}/мес</td>
          <td style="color:#ff6b6b">$${fmt(metrics.totalMonthlyInterestUsd, 0)}/мес</td>
          <td>—</td>
        </tr>
      </tfoot>
    </table>
    ${next ? `<div style="margin-top:12px;padding:12px;background:rgba(255,107,107,0.1);border-left:3px solid #ff6b6b;border-radius:4px"><b style="color:#ff6b6b">🎯 Следующая цель:</b> ${next.name} — APR ${next.aprPct.toFixed(2)}%, остаток $${fmt(next.balanceUsd)}. Закрытие сэкономит $${fmt(next.monthlyInterestUsd, 0)}/мес процентов.</div>` : ""}
  </div>`;
}

function renderAssetsAndDebts(metrics: FinanceMetrics): string {
  const d = metrics.data;

  const liqRows = d.liquidAssets
    .map(
      (a, i) => `<tr data-section="liquidAssets" data-idx="${i}">
      <td><b>${escapeHtml(a.name)}</b>${a.note ? `<div style="font-size:.75rem;color:#888">${escapeHtml(a.note)}</div>` : ""}</td>
      <td class="green">$${fmt(a.amountUsd)}</td>
      <td>${a.earmarkedFor ? `<span style="color:#ffc107">📌 ${escapeHtml(a.earmarkedFor)}</span>` : ""}${a.risk === "high" ? '<span style="color:#ff6b6b">⚠️ высокий риск</span>' : ""}</td>
      <td class="ad-act"><button onclick="adEdit('liquidAssets',${i})" title="Редактировать">✏️</button><button onclick="adDel('liquidAssets',${i})" title="Удалить">🗑️</button></td>
    </tr>`,
    )
    .join("");

  const earmRows = d.earmarks
    .map(
      (e, i) => `<tr data-section="earmarks" data-idx="${i}">
      <td>${escapeHtml(e.name)}</td>
      <td style="color:#ffc107">$${fmt(e.amountUsd)}</td>
      <td style="color:#888">${escapeHtml(e.due ?? "")}</td>
      <td class="ad-act"><button onclick="adEdit('earmarks',${i})" title="Редактировать">✏️</button><button onclick="adDel('earmarks',${i})" title="Удалить">🗑️</button></td>
    </tr>`,
    )
    .join("");

  const persRows = d.personalDebts
    .map(
      (p, i) => `<tr data-section="personalDebts" data-idx="${i}">
      <td>${escapeHtml(p.name)}</td>
      <td style="color:#ff6b6b">$${fmt(p.amountUsd)}</td>
      <td style="color:#888">${p.originalAmount} ${escapeHtml(p.currency)}</td>
      <td class="ad-act"><button onclick="adEdit('personalDebts',${i})" title="Редактировать">✏️</button><button onclick="adDel('personalDebts',${i})" title="Удалить">🗑️</button></td>
    </tr>`,
    )
    .join("");

  const owedRows = d.owedToMe
    .map(
      (o, i) => `<tr data-section="owedToMe" data-idx="${i}">
      <td>${escapeHtml(o.name)}</td>
      <td class="green">$${fmt(o.amountUsd)}</td>
      <td style="color:#888">${escapeHtml(o.note ?? "")}</td>
      <td class="ad-act"><button onclick="adEdit('owedToMe',${i})" title="Редактировать">✏️</button><button onclick="adDel('owedToMe',${i})" title="Удалить">🗑️</button></td>
    </tr>`,
    )
    .join("");

  const fdJson = JSON.stringify({
    liquidAssets: d.liquidAssets,
    earmarks: d.earmarks,
    personalDebts: d.personalDebts,
    owedToMe: d.owedToMe,
  }).replace(/<\/script>/gi, "<\\/script>");

  return `
  <style>
    .ad-act button { background:none;border:none;cursor:pointer;font-size:1rem;padding:2px 4px;opacity:.6;transition:opacity .15s }
    .ad-act button:hover { opacity:1 }
    .ad-add { margin-top:8px;background:none;border:1px dashed #3a3f4d;color:#888;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:.9rem;width:100%;transition:all .2s }
    .ad-add:hover { border-color:#4caf82;color:#4caf82 }
    #ad-overlay { display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;align-items:center;justify-content:center }
    #ad-overlay.open { display:flex }
    #ad-box { background:#252836;border-radius:10px;padding:28px;min-width:360px;max-width:520px;width:90%;box-shadow:0 8px 40px rgba(0,0,0,.5) }
    #ad-box h3 { margin-bottom:20px;color:#4caf82 }
    .ad-field { margin-bottom:14px }
    .ad-field label { display:block;font-size:.85rem;color:#999;margin-bottom:5px }
    .ad-field input,.ad-field select { width:100%;background:#1a1d27;border:1px solid #3a3f4d;border-radius:6px;color:#fff;padding:9px 12px;font-size:.95rem }
    .ad-field input:focus,.ad-field select:focus { outline:none;border-color:#4caf82 }
    .ad-field select option { background:#252836 }
    #ad-btns { display:flex;gap:10px;margin-top:20px }
    #ad-btns button { flex:1;padding:10px;border-radius:6px;font-size:.95rem;cursor:pointer;border:none;font-weight:600 }
    #ad-save { background:#4caf82;color:#000 }
    #ad-cancel { background:#3a3f4d;color:#ccc }
    #ad-err { color:#ff6b6b;font-size:.85rem;margin-top:8px;display:none }
  </style>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:20px">
    <div class="section">
      <h3 style="margin-bottom:12px;color:#4caf82">💰 Ликвидные активы ($${fmt(metrics.totalLiquidAssetsUsd)})</h3>
      <table><thead><tr><th>Актив</th><th>Сумма</th><th>Назначение</th><th></th></tr></thead><tbody>${liqRows}</tbody></table>
      <button class="ad-add" onclick="adAdd('liquidAssets')">+ Добавить актив</button>
    </div>
    <div class="section">
      <h3 style="margin-bottom:12px;color:#ffc107">📌 Брони / earmarks ($${fmt(metrics.totalEarmarkedUsd)})</h3>
      <table><thead><tr><th>Цель</th><th>Сумма</th><th>Срок</th><th></th></tr></thead><tbody>${earmRows}</tbody></table>
      <button class="ad-add" onclick="adAdd('earmarks')">+ Добавить бронь</button>
    </div>
    <div class="section">
      <h3 style="margin-bottom:12px;color:#ff6b6b">👥 Личные долги ($${fmt(metrics.totalPersonalDebtsUsd)})</h3>
      <table><thead><tr><th>Кому</th><th>$</th><th>Оригинал</th><th></th></tr></thead><tbody>${persRows}</tbody></table>
      <button class="ad-add" onclick="adAdd('personalDebts')">+ Добавить долг</button>
    </div>
    <div class="section">
      <h3 style="margin-bottom:12px;color:#4caf82">💵 Должны мне ($${fmt(metrics.totalOwedToMeUsd)})</h3>
      <table><thead><tr><th>Кто</th><th>$</th><th>Детали</th><th></th></tr></thead><tbody>${owedRows}</tbody></table>
      <button class="ad-add" onclick="adAdd('owedToMe')">+ Добавить запись</button>
    </div>
  </div>

  <!-- Edit modal -->
  <div id="ad-overlay">
    <div id="ad-box">
      <h3 id="ad-title">Редактировать</h3>
      <div id="ad-form"></div>
      <div id="ad-err"></div>
      <div id="ad-btns">
        <button id="ad-save" onclick="adSave()">💾 Сохранить</button>
        <button id="ad-cancel" onclick="adClose()">Отмена</button>
      </div>
    </div>
  </div>

  <script>
  window.__fd = ${fdJson};

  const adCfg = {
    liquidAssets: {
      label: 'Ликвидный актив',
      fields: [
        { key:'name', label:'Название', type:'text', required:true },
        { key:'amountUsd', label:'Сумма ($)', type:'number', required:true },
        { key:'note', label:'Заметка', type:'text' },
        { key:'role', label:'Роль', type:'select', opts:['','buffer','speculative','reserve'], labels:['(нет)','buffer — буфер','speculative — спекуляции','reserve — резерв'] },
        { key:'risk', label:'Риск', type:'select', opts:['','low','medium','high'], labels:['(не задан)','low','medium','high ⚠️'] },
        { key:'earmarkedFor', label:'Назначение (earmark)', type:'text' },
      ]
    },
    earmarks: {
      label: 'Бронь / earmark',
      fields: [
        { key:'name', label:'Цель', type:'text', required:true },
        { key:'amountUsd', label:'Сумма ($)', type:'number', required:true },
        { key:'due', label:'Срок (текст)', type:'text' },
      ]
    },
    personalDebts: {
      label: 'Личный долг',
      fields: [
        { key:'name', label:'Кому', type:'text', required:true },
        { key:'amountUsd', label:'Сумма (USD эквивалент)', type:'number', required:true },
        { key:'originalAmount', label:'Оригинальная сумма', type:'number', required:true },
        { key:'currency', label:'Валюта (USD/EUR/MDL)', type:'text', required:true },
      ]
    },
    owedToMe: {
      label: 'Должны мне',
      fields: [
        { key:'name', label:'Кто', type:'text', required:true },
        { key:'amountUsd', label:'Сумма ($)', type:'number', required:true },
        { key:'note', label:'Детали', type:'text' },
      ]
    },
  };

  let adState = null;

  function adEsc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function adOpen(section, row) {
    const cfg = adCfg[section];
    document.getElementById('ad-title').textContent = (adState.isNew ? 'Добавить: ' : 'Редактировать: ') + cfg.label;
    const form = document.getElementById('ad-form');
    form.innerHTML = cfg.fields.map(f => {
      const val = row[f.key] ?? '';
      let inp;
      if (f.type === 'select') {
        const opts = f.opts.map((o, i) => '<option value="' + adEsc(o) + '"' + (o === String(val) ? ' selected' : '') + '>' + adEsc(f.labels[i]) + '</option>').join('');
        inp = '<select name="' + f.key + '" style="width:100%">' + opts + '</select>';
      } else {
        inp = '<input type="' + f.type + '" name="' + f.key + '" value="' + adEsc(val) + '"'
          + (f.required ? ' required' : '')
          + (f.type === 'number' ? ' step="any" min="0"' : '')
          + '>';
      }
      return '<div class="ad-field"><label>' + adEsc(f.label) + (f.required ? ' <span style="color:#ff6b6b">*</span>' : '') + '</label>' + inp + '</div>';
    }).join('');
    const err = document.getElementById('ad-err');
    err.style.display = 'none'; err.textContent = '';
    document.getElementById('ad-overlay').classList.add('open');
    form.querySelector('input, select')?.focus();
  }

  function adEdit(section, idx) {
    adState = { section, idx, isNew: false };
    adOpen(section, window.__fd[section][idx]);
  }

  function adAdd(section) {
    adState = { section, idx: -1, isNew: true };
    adOpen(section, {});
  }

  function adClose() {
    document.getElementById('ad-overlay').classList.remove('open');
    adState = null;
  }

  document.getElementById('ad-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('ad-overlay')) adClose();
  });

  async function adSave() {
    const cfg = adCfg[adState.section];
    const form = document.getElementById('ad-form');
    const obj = {};
    for (const f of cfg.fields) {
      const el = form.querySelector('[name="' + f.key + '"]');
      if (!el) continue;
      let val = el.value.trim();
      if (f.type === 'number') {
        if (val === '') { if (f.required) { el.focus(); return; } continue; }
        obj[f.key] = parseFloat(val);
      } else {
        if (val === '') { if (f.required) { el.focus(); return; } continue; }
        if (val !== '') obj[f.key] = val;
      }
    }
    const arr = [...window.__fd[adState.section]];
    if (adState.isNew) arr.push(obj);
    else arr[adState.idx] = { ...arr[adState.idx], ...obj };

    const btn = document.getElementById('ad-save');
    btn.disabled = true; btn.textContent = '...';
    try {
      const r = await fetch('/api/finance/section', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: adState.section, data: arr }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      location.reload();
    } catch(e) {
      const err = document.getElementById('ad-err');
      err.textContent = 'Ошибка: ' + e; err.style.display = 'block';
      btn.disabled = false; btn.textContent = '💾 Сохранить';
    }
  }

  async function adDel(section, idx) {
    const row = window.__fd[section][idx];
    const label = row.name || row.label || ('строка ' + idx);
    if (!confirm('Удалить «' + label + '»?')) return;
    const arr = window.__fd[section].filter((_, i) => i !== idx);
    try {
      const r = await fetch('/api/finance/section', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, data: arr }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      location.reload();
    } catch(e) {
      alert('Ошибка: ' + e);
    }
  }
  </script>`;
}

function renderMilestones(metrics: FinanceMetrics): string {
  const total = metrics.data.milestones.length;
  const done = metrics.data.milestones.filter((m) => m.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const items = metrics.data.milestones
    .map(
      (
        m,
      ) => `<div class="ms-row" data-id="${m.id}" style="display:flex;align-items:center;padding:8px 0;border-bottom:1px solid #2a2d37;cursor:pointer;user-select:none" onclick="toggleMilestone(this)">
      <div class="ms-icon" style="font-size:1.4rem;margin-right:12px;width:28px;text-align:center">${m.done ? "✅" : "⬜"}</div>
      <div class="ms-label" style="flex:1;${m.done ? "color:#4caf82;text-decoration:line-through" : "color:#ddd"}">${escapeHtml(m.label)}</div>
    </div>`,
    )
    .join("");
  return `
  <div class="section">
    <h3 style="margin-bottom:12px;color:#4caf82">🎯 Майлстоуны (<span id="ms-done">${done}</span>/<span id="ms-total">${total}</span> = <span id="ms-pct">${pct}</span>%)</h3>
    <div style="background:#1a1d27;border-radius:6px;height:8px;margin-bottom:16px;overflow:hidden">
      <div id="ms-bar" style="height:100%;width:${pct}%;background:linear-gradient(90deg,#4caf82,#66bb6a);transition:width .3s"></div>
    </div>
    ${items}
  </div>
  <script>
    async function toggleMilestone(row) {
      const id = row.dataset.id;
      const icon = row.querySelector('.ms-icon');
      const label = row.querySelector('.ms-label');
      const wasDone = icon.textContent.trim() === '✅';
      // optimistic UI
      icon.textContent = wasDone ? '⬜' : '✅';
      if (wasDone) {
        label.style.color = '#ddd';
        label.style.textDecoration = 'none';
      } else {
        label.style.color = '#4caf82';
        label.style.textDecoration = 'line-through';
      }
      try {
        const r = await fetch('/api/finance/milestones/' + encodeURIComponent(id) + '/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ done: !wasDone }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        recountMilestones();
      } catch (e) {
        // revert on error
        icon.textContent = wasDone ? '✅' : '⬜';
        if (wasDone) {
          label.style.color = '#4caf82';
          label.style.textDecoration = 'line-through';
        } else {
          label.style.color = '#ddd';
          label.style.textDecoration = 'none';
        }
        alert('Не сохранилось: ' + e);
      }
    }
    function recountMilestones() {
      const rows = document.querySelectorAll('.ms-row');
      let done = 0;
      rows.forEach(r => { if (r.querySelector('.ms-icon').textContent.trim() === '✅') done++; });
      const total = rows.length;
      const pct = total ? Math.round(done / total * 100) : 0;
      document.getElementById('ms-done').textContent = done;
      document.getElementById('ms-total').textContent = total;
      document.getElementById('ms-pct').textContent = pct;
      document.getElementById('ms-bar').style.width = pct + '%';
    }
  </script>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderGoal(metrics: FinanceMetrics): string {
  const months = metrics.monthsToGoalAtCurrentSavings;
  const years = months ? months / 12 : null;
  return `
  <div class="section">
    <h3 style="margin-bottom:12px;color:#4caf82">🎯 Цель: $${metrics.data.passiveIncomeGoalUsdPerMonth}/мес пассивного дохода</h3>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
      <div>
        <div style="color:#999;font-size:.85rem">Нужен капитал @ 8% APY</div>
        <div style="font-size:1.5rem;color:#4caf82;font-weight:700">$${fmt(metrics.passiveGoalCapitalUsd)}</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem">При свободном потоке</div>
        <div style="font-size:1.5rem;color:#4caf82;font-weight:700">$${fmt(metrics.freeCashFlowUsd)}/мес</div>
      </div>
      <div>
        <div style="color:#999;font-size:.85rem">Срок (если копить ВСЁ)</div>
        <div style="font-size:1.5rem;color:#4caf82;font-weight:700">${months === null ? "∞" : years!.toFixed(1) + " лет"}</div>
        <div style="font-size:.75rem;color:#888">${months === null ? "" : "= " + months.toFixed(0) + " мес"}</div>
      </div>
    </div>
    <div style="margin-top:16px;padding:12px;background:rgba(76,175,130,0.08);border-left:3px solid #4caf82;border-radius:4px;color:#bbb;font-size:.9rem">
      <b>Реальность:</b> сейчас свободный поток уходит в кредиты. После закрытия токсичных кредитов высвободится ~$${fmt(metrics.credits.filter((c) => c.aprPct >= 30).reduce((s, c) => s + c.monthlyPaymentUsd, 0))}/мес — вот тогда стартует реальное накопление.
    </div>
  </div>`;
}

function renderSummary(metrics: FinanceMetrics): string {
  const plan = buildPayoffPlan(metrics);
  const toxicCount = metrics.credits.filter(
    (c) => c.aprPct >= 30 && c.balance > 0,
  ).length;
  const totalDebtUsd =
    metrics.totalCreditBalanceUsd + metrics.totalPersonalDebtsUsd;
  const staleDays = Math.floor(
    (Date.now() - new Date(metrics.data.snapshotDate).getTime()) / 86_400_000,
  );
  const staleNote =
    staleDays >= 7
      ? ` <span style="color:#ffc107">(${staleDays} дн. назад — пора обновить)</span>`
      : "";

  const goalLine =
    plan.goalLabel && plan.debtFreeLabel
      ? `сначала долги до <b>${plan.debtFreeLabel}</b>, затем ${plan.monthsToGoal} мес накопления → <b class="green">${plan.goalLabel}</b>`
      : "план не строится — свободный поток нулевой";

  return `
  <div class="section" style="background:rgba(76,175,130,0.05);border-color:#3a3f4d">
    <h3 style="color:#4caf82;margin-bottom:12px">📋 Главное за один взгляд</h3>
    <ul style="list-style:none;padding:0;color:#ddd;line-height:2">
      <li>🔥 Всего долгов: <b style="color:#ff6b6b">$${fmt(totalDebtUsd)}</b> — кредиты $${fmt(metrics.totalCreditBalanceUsd)} + личные $${fmt(metrics.totalPersonalDebtsUsd)}</li>
      <li>💸 Процентов по плану погашения: <b style="color:#ff6b6b">$${fmt(plan.totalInterestUsd)}</b> за все ${plan.totalMonths} мес <span style="color:#888">(если платить только минимум — $${fmt(plan.interestIfFrozen12moUsd)} в год)</span></li>
      <li>⚠️ Токсичных кредитов (APR ≥ 30%): <b style="color:#ff6b6b">${toxicCount}</b></li>
      <li>💵 Свободный поток / мес: <b class="green">$${fmt(metrics.freeCashFlowUsd)}</b> ← это твой главный рычаг</li>
      <li>🎯 Цель $${metrics.data.passiveIncomeGoalUsdPerMonth}/мес пассива (капитал $${fmt(metrics.passiveGoalCapitalUsd)}): ${goalLine}</li>
      <li>📅 Снимок данных: <b>${metrics.data.snapshotDate}</b>${staleNote}</li>
    </ul>
  </div>`;
}

function renderRecommendation(metrics: FinanceMetrics): string {
  // Default suggested amount = current free cash (liquid - earmarks)
  const defaultAmount = Math.max(0, Math.round(metrics.freeCashUsd));
  const initialPlan = recommendAllocation(metrics, defaultAmount);
  return `
  <div class="section" style="border-color:#4caf82">
    <h3 style="color:#4caf82;margin-bottom:12px">🧠 Что делать со свободными деньгами?</h3>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
      <label style="color:#ccc">У меня свободно $</label>
      <input id="recAmount" type="number" value="${defaultAmount}" min="0" step="100"
        style="background:#1a1d27;border:2px solid #4caf82;border-radius:6px;color:#fff;padding:10px 14px;font-size:1.1rem;width:160px;font-weight:600"
        oninput="recCalc()" />
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${[100, 500, 1000, 2000, 5000, 10000]
          .map(
            (v) =>
              `<button onclick="document.getElementById('recAmount').value=${v};recCalc()">$${v}</button>`,
          )
          .join("")}
        <button onclick="document.getElementById('recAmount').value=${defaultAmount};recCalc()" style="background:#3a3f4d;color:#fff">↺ свободные</button>
      </div>
    </div>
    <div id="recResult">${renderPlanInner(initialPlan)}</div>
  </div>
  <script>
    async function recCalc() {
      const amount = parseFloat(document.getElementById('recAmount').value) || 0;
      try {
        const r = await fetch('/api/finance/recommend?amount=' + encodeURIComponent(amount));
        const plan = await r.json();
        document.getElementById('recResult').innerHTML = renderPlan(plan);
      } catch (e) {
        document.getElementById('recResult').innerHTML = '<div style="color:#ff6b6b">Ошибка: ' + e + '</div>';
      }
    }
    function fmtN(n, d = 0) {
      return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    function kindIcon(k) {
      return ({
        emergency_buffer: '🛟',
        personal_debt: '👤',
        credit_payoff: '🔥',
        earn_buffer: '🏦',
        earn_invest: '📈',
      })[k] || '•';
    }
    function kindColor(k) {
      return ({
        emergency_buffer: '#ffc107',
        personal_debt: '#64b5f6',
        credit_payoff: '#ff6b6b',
        earn_buffer: '#4caf82',
        earn_invest: '#4caf82',
      })[k] || '#ccc';
    }
    function renderPlan(plan) {
      if (!plan || !plan.steps) return '';
      const allocated = plan.steps.reduce((s, x) => s + x.amountUsd, 0);
      let rows = '';
      for (const s of plan.steps) {
        const pct = allocated > 0 ? (s.amountUsd / allocated * 100) : 0;
        rows += '<div style="margin-bottom:12px;padding:14px;background:#1a1d27;border-left:4px solid ' + kindColor(s.kind) + ';border-radius:6px">'
          + '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">'
          + '<div style="flex:1;min-width:200px"><div style="font-size:1.1rem;font-weight:700;color:' + kindColor(s.kind) + '">' + kindIcon(s.kind) + ' ' + s.target + '</div>'
          + '<div style="color:#aaa;font-size:.85rem;margin-top:4px">' + s.reason + '</div></div>'
          + '<div style="text-align:right">'
          + '<div style="font-size:1.4rem;font-weight:700;color:#fff">$' + fmtN(s.amountUsd) + '</div>'
          + '<div style="font-size:.8rem;color:#888">' + pct.toFixed(0) + '% • экономия $' + fmtN(s.annualSavingsUsd, 0) + '/год</div>'
          + '<div style="font-size:.75rem;color:' + kindColor(s.kind) + ';font-weight:600">эффект: ' + s.expectedReturnPct.toFixed(2) + '%</div>'
          + '</div></div></div>';
      }
      let notes = '';
      if (plan.notes && plan.notes.length > 0) {
        notes = '<div style="margin-top:12px">' + plan.notes.map(n =>
          '<div style="padding:10px;background:rgba(255,193,7,0.08);border-left:3px solid #ffc107;border-radius:4px;color:#ddd;font-size:.9rem;margin-bottom:6px">💡 ' + n + '</div>'
        ).join('') + '</div>';
      }
      const summary = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">'
        + '<div><div style="color:#999;font-size:.8rem">Распределено</div><div style="font-size:1.3rem;color:#4caf82;font-weight:700">$' + fmtN(allocated) + '</div></div>'
        + '<div><div style="color:#999;font-size:.8rem">Экономия / доход за год</div><div style="font-size:1.3rem;color:#4caf82;font-weight:700">$' + fmtN(plan.totalAnnualSavingsUsd, 0) + '</div></div>'
        + '<div><div style="color:#999;font-size:.8rem">Эффективная отдача</div><div style="font-size:1.3rem;color:#4caf82;font-weight:700">' + plan.effectiveReturnPct.toFixed(2) + '%</div></div>'
        + '</div>';
      return summary + rows + notes;
    }
    // Server-side initial render is replaced after first interaction; pre-render via inline JSON for offline-feel
  </script>`;
}

/** Server-side equivalent of client renderPlan, used for initial paint. */
function renderPlanInner(plan: AllocationPlan): string {
  const allocated = plan.steps.reduce((s, x) => s + x.amountUsd, 0);
  const kindIcon: Record<string, string> = {
    emergency_buffer: "🛟",
    personal_debt: "👤",
    credit_payoff: "🔥",
    earn_buffer: "🏦",
    earn_invest: "📈",
  };
  const kindColor: Record<string, string> = {
    emergency_buffer: "#ffc107",
    personal_debt: "#64b5f6",
    credit_payoff: "#ff6b6b",
    earn_buffer: "#4caf82",
    earn_invest: "#4caf82",
  };
  const summary = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
    <div><div style="color:#999;font-size:.8rem">Распределено</div><div style="font-size:1.3rem;color:#4caf82;font-weight:700">$${fmt(allocated)}</div></div>
    <div><div style="color:#999;font-size:.8rem">Экономия / доход за год</div><div style="font-size:1.3rem;color:#4caf82;font-weight:700">$${fmt(plan.totalAnnualSavingsUsd, 0)}</div></div>
    <div><div style="color:#999;font-size:.8rem">Эффективная отдача</div><div style="font-size:1.3rem;color:#4caf82;font-weight:700">${plan.effectiveReturnPct.toFixed(2)}%</div></div>
  </div>`;
  const rows = plan.steps
    .map((s) => {
      const pct = allocated > 0 ? (s.amountUsd / allocated) * 100 : 0;
      const color = kindColor[s.kind] ?? "#ccc";
      return `<div style="margin-bottom:12px;padding:14px;background:#1a1d27;border-left:4px solid ${color};border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
          <div style="flex:1;min-width:200px">
            <div style="font-size:1.1rem;font-weight:700;color:${color}">${kindIcon[s.kind] ?? "•"} ${s.target}</div>
            <div style="color:#aaa;font-size:.85rem;margin-top:4px">${s.reason}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:1.4rem;font-weight:700;color:#fff">$${fmt(s.amountUsd)}</div>
            <div style="font-size:.8rem;color:#888">${pct.toFixed(0)}% • экономия $${fmt(s.annualSavingsUsd, 0)}/год</div>
            <div style="font-size:.75rem;color:${color};font-weight:600">эффект: ${s.expectedReturnPct.toFixed(2)}%</div>
          </div>
        </div>
      </div>`;
    })
    .join("");
  const notes =
    plan.notes.length > 0
      ? `<div style="margin-top:12px">${plan.notes
          .map(
            (n) =>
              `<div style="padding:10px;background:rgba(255,193,7,0.08);border-left:3px solid #ffc107;border-radius:4px;color:#ddd;font-size:.9rem;margin-bottom:6px">💡 ${n}</div>`,
          )
          .join("")}</div>`
      : "";
  return summary + rows + notes;
}

function renderPayoffPlan(metrics: FinanceMetrics): string {
  const plan = buildPayoffPlan(metrics);

  if (plan.phases.length === 0) {
    return `
  <div class="section">
    <h3 style="margin-bottom:12px;color:#4caf82">🗺️ План погашения</h3>
    <div style="color:#888">${
      metrics.freeCashFlowUsd <= 0
        ? "Свободный поток нулевой или отрицательный — план построить нельзя. Сначала нужно увеличить доход или срезать расходы."
        : "Долгов нет. Весь поток свободен."
    }</div>
  </div>`;
  }

  const maxAmount = Math.max(...plan.phases.map((p) => p.amountUsd));

  const rows = plan.phases
    .map((p) => {
      const isPersonal = p.kind === "personal";
      const color = isPersonal ? "#64b5f6" : p.aprPct && p.aprPct >= 30 ? "#ff6b6b" : "#ffc107";
      const barPct = maxAmount > 0 ? (p.amountUsd / maxAmount) * 100 : 0;
      const period =
        p.monthsNeeded <= 1 ? p.endLabel : `${p.startLabel} → ${p.endLabel}`;
      return `
        <tr>
          <td style="color:#666;width:32px">${p.order}</td>
          <td>
            <b style="color:${color}">${isPersonal ? "👤" : "🏦"} ${escapeHtml(p.target)}</b>
            <div style="background:#1a1d27;border-radius:3px;height:4px;margin-top:6px;max-width:220px;overflow:hidden">
              <div style="height:100%;width:${barPct.toFixed(1)}%;background:${color}"></div>
            </div>
          </td>
          <td>$${fmt(p.amountUsd)}</td>
          <td>${p.aprPct === null ? '<span style="color:#666">0%</span>' : `<span style="color:${color};font-weight:700">${p.aprPct.toFixed(2)}%</span>`}</td>
          <td style="white-space:nowrap">${period}</td>
          <td style="color:#888">${p.monthsNeeded} мес</td>
          <td>${p.freesUpUsd > 0 ? `<span class="green">+$${fmt(p.freesUpUsd)}/мес</span>` : "—"}</td>
        </tr>`;
    })
    .join("");

  const goalBlock =
    plan.monthsToGoal !== null && plan.goalLabel
      ? `
    <div style="margin-top:16px;padding:14px;background:rgba(76,175,130,0.08);border-left:3px solid #4caf82;border-radius:4px">
      <div style="color:#4caf82;font-weight:700;margin-bottom:6px">📈 Дальше — EarnOptimizer</div>
      <div style="color:#ccc;font-size:.9rem">
        После закрытия долгов свободный поток вырастет до <b class="green">$${fmt(plan.finalFlowUsd)}/мес</b>
        (сейчас $${fmt(plan.startingFlowUsd)}). Для цели $${metrics.data.passiveIncomeGoalUsdPerMonth}/мес пассива
        нужен капитал <b>$${fmt(plan.goalCapitalUsd)}</b> — это ещё <b>${plan.monthsToGoal} мес</b>,
        то есть примерно <b class="green">${plan.goalLabel}</b>.
      </div>
    </div>`
      : "";

  return `
  <div class="section" style="border-color:#4caf82">
    <h3 style="margin-bottom:4px;color:#4caf82">🗺️ План погашения</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:16px">
      Личные долги идут первыми (сроки учтены), затем кредиты по ставке — при равной ставке первым гасится меньший,
      чтобы его платёж быстрее пошёл в дело.
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:18px">
      <div>
        <div style="color:#999;font-size:.8rem">Без долгов к</div>
        <div style="font-size:1.5rem;color:#4caf82;font-weight:700">${plan.debtFreeLabel}</div>
        <div style="font-size:.75rem;color:#666">${plan.totalMonths} месяцев</div>
      </div>
      <div>
        <div style="color:#999;font-size:.8rem">Поток сейчас → потом</div>
        <div style="font-size:1.5rem;color:#4caf82;font-weight:700">$${fmt(plan.startingFlowUsd)} → $${fmt(plan.finalFlowUsd)}</div>
        <div style="font-size:.75rem;color:#666">освободится $${fmt(plan.finalFlowUsd - plan.startingFlowUsd)}/мес</div>
      </div>
      <div>
        <div style="color:#999;font-size:.8rem">Цель $${metrics.data.passiveIncomeGoalUsdPerMonth}/мес пассива</div>
        <div style="font-size:1.5rem;color:#4caf82;font-weight:700">${plan.goalLabel ?? "—"}</div>
        <div style="font-size:.75rem;color:#666">${plan.monthsToGoal !== null ? `+${plan.monthsToGoal} мес после долгов` : ""}</div>
      </div>
    </div>

    <table>
      <thead>
        <tr><th></th><th>Цель</th><th>Сумма</th><th>APR</th><th>Период</th><th>Займёт</th><th>Освободит</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${goalBlock}
    <div style="margin-top:12px;color:#666;font-size:.8rem">
      Расчёт консервативный: остатки кредитов берутся на сегодня и не уменьшаются на минимальные платежи по пути,
      так что по факту закроется чуть раньше. Подработка $1 000 считается стабильной — если она просядет, сроки растянутся.
    </div>
  </div>`;
}

function renderCapitalGoals(
  metrics: FinanceMetrics,
  liveEarnApyPct: number,
): string {
  const plan = buildPayoffPlan(metrics);
  const now = new Date();
  const cfg = {
    startOffset: plan.totalMonths,
    baseMonth: now.getMonth(),
    baseYear: now.getFullYear(),
    lifeAnnual: Math.round(metrics.data.monthlyLifeCostUsd * 12),
    contribution: Math.round(plan.finalFlowUsd),
    debtFreeLabel: plan.debtFreeLabel ?? "",
  };
  const earnApy = liveEarnApyPct > 0 ? liveEarnApyPct : 8;
  const apySource =
    liveEarnApyPct > 0
      ? `живая ставка с биржи (${earnApy.toFixed(2)}%)`
      : "биржи не отвечают — подставлено 8%";

  return `
  <div class="section" style="border-color:#64b5f6">
    <h3 style="margin-bottom:4px;color:#64b5f6">🧮 Калькулятор капитала</h3>
    <div style="color:#888;font-size:.85rem;margin-bottom:16px">
      Накопление стартует после закрытия долгов${cfg.debtFreeLabel ? ` (${cfg.debtFreeLabel})` : ""}.
      Ставки — <b>твои допущения</b>, а не прогноз: подставь то, во что реально веришь.
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:18px">
      <div>
        <label style="display:block;color:#999;font-size:.8rem;margin-bottom:5px">🎯 Цель, $</label>
        <input id="cgTarget" type="number" value="1000000" min="1000" step="10000" oninput="cgCalc()"
          style="width:100%;background:#1a1d27;border:2px solid #64b5f6;border-radius:6px;color:#fff;padding:9px 12px;font-size:1.05rem;font-weight:600">
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
          ${[100000, 250000, 500000, 1000000]
            .map(
              (v) =>
                `<button onclick="document.getElementById('cgTarget').value=${v};cgCalc()" style="background:#3a3f4d;color:#ccc;padding:4px 9px;font-size:.8rem">$${v / 1000}k</button>`,
            )
            .join("")}
        </div>
      </div>
      <div>
        <label style="display:block;color:#999;font-size:.8rem;margin-bottom:5px">💵 Взнос в месяц, $</label>
        <input id="cgPmt" type="number" value="${cfg.contribution}" min="0" step="100" oninput="cgCalc()"
          style="width:100%;background:#1a1d27;border:2px solid #64b5f6;border-radius:6px;color:#fff;padding:9px 12px;font-size:1.05rem;font-weight:600">
        <div style="color:#666;font-size:.75rem;margin-top:6px">Свободный поток после долгов</div>
      </div>
      <div>
        <label style="display:block;color:#999;font-size:.8rem;margin-bottom:5px">
          📊 Доля в Earn: <span id="cgSplitLabel" style="color:#4caf82;font-weight:700">50%</span>
          <span style="color:#666"> / брокер <span id="cgSplitLabelB">50%</span></span>
        </label>
        <input id="cgSplit" type="range" min="0" max="100" value="50" step="5" oninput="cgCalc()" style="width:100%;accent-color:#64b5f6">
        <div style="display:flex;gap:8px;margin-top:8px">
          <div style="flex:1">
            <div style="color:#4caf82;font-size:.7rem;margin-bottom:3px">Earn, % годовых</div>
            <input id="cgRateEarn" type="number" value="${earnApy.toFixed(2)}" min="0" max="100" step="0.25" oninput="cgCalc()"
              style="width:100%;background:#1a1d27;border:1px solid #3a3f4d;border-radius:5px;color:#fff;padding:6px 9px;font-size:.9rem">
          </div>
          <div style="flex:1">
            <div style="color:#ffc107;font-size:.7rem;margin-bottom:3px">Брокер, % годовых</div>
            <input id="cgRateBroker" type="number" value="7" min="0" max="100" step="0.25" oninput="cgCalc()"
              style="width:100%;background:#1a1d27;border:1px solid #3a3f4d;border-radius:5px;color:#fff;padding:6px 9px;font-size:.9rem">
          </div>
        </div>
        <div style="color:#666;font-size:.7rem;margin-top:5px">Earn: ${apySource}</div>
      </div>
    </div>

    <div id="cgResult"></div>

    <div style="margin-top:18px">
      <div style="color:#999;font-size:.9rem;margin-bottom:8px">📍 Ключевые рубежи при тех же допущениях:</div>
      <div id="cgMilestones"></div>
    </div>

    <div style="margin-top:14px;padding:11px;background:rgba(255,193,7,0.07);border-left:3px solid #ffc107;border-radius:4px;color:#bbb;font-size:.83rem">
      Суммы <b>номинальные</b>. При инфляции 3% миллион через 12 лет — это примерно $700k сегодняшними.
      И ни одна из этих ставок не гарантирована: крипто-доходность гуляет, у площадок есть риск неплатёжеспособности,
      у акций — просадки. Калькулятор считает арифметику, а не обещает результат.
    </div>
  </div>
  <script>
    var CG = ${JSON.stringify(cfg)};
    var CG_M = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

    function cgLabel(offset) {
      var total = CG.baseMonth + offset;
      var y = CG.baseYear + Math.floor(total / 12);
      var m = ((total % 12) + 12) % 12;
      return CG_M[m] + ' ' + y;
    }
    function cgN(n, d) {
      d = d || 0;
      return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    // Solve FV = P0(1+r)^n + PMT((1+r)^n - 1)/r for n
    function cgMonths(target, pmt, annualPct, start) {
      start = start || 0;
      if (target <= start) return 0;
      var r = annualPct / 100 / 12;
      if (pmt <= 0) {
        if (r <= 0 || start <= 0) return null;
        return Math.ceil(Math.log(target / start) / Math.log(1 + r));
      }
      if (r <= 0) return Math.ceil((target - start) / pmt);
      var A = start + pmt / r;
      var B = target + pmt / r;
      if (A <= 0) return null;
      return Math.ceil(Math.log(B / A) / Math.log(1 + r));
    }
    function cgBlended() {
      var w = parseFloat(document.getElementById('cgSplit').value) / 100;
      var re = parseFloat(document.getElementById('cgRateEarn').value) || 0;
      var rb = parseFloat(document.getElementById('cgRateBroker').value) || 0;
      return w * re + (1 - w) * rb;
    }
    function cgCalc() {
      var target = parseFloat(document.getElementById('cgTarget').value) || 0;
      var pmt = parseFloat(document.getElementById('cgPmt').value) || 0;
      var split = parseFloat(document.getElementById('cgSplit').value);
      document.getElementById('cgSplitLabel').textContent = split + '%';
      document.getElementById('cgSplitLabelB').textContent = (100 - split) + '%';

      var rate = cgBlended();
      var n = cgMonths(target, pmt, rate);

      var box = document.getElementById('cgResult');
      if (n === null || target <= 0) {
        box.innerHTML = '<div style="color:#ff6b6b">Недостижимо при текущих вводных.</div>';
        document.getElementById('cgMilestones').innerHTML = '';
        return;
      }

      var contributed = Math.min(pmt * n, target);
      var growth = Math.max(0, target - contributed);
      var cPct = target > 0 ? (contributed / target * 100) : 0;
      var years = (n / 12).toFixed(1);

      box.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-bottom:14px">'
        + '<div><div style="color:#999;font-size:.8rem">Достигнешь</div>'
        + '<div style="font-size:1.7rem;color:#64b5f6;font-weight:700">' + cgLabel(CG.startOffset + n) + '</div>'
        + '<div style="font-size:.75rem;color:#666">' + n + ' мес накопления = ' + years + ' лет</div></div>'
        + '<div><div style="color:#999;font-size:.8rem">Смешанная ставка</div>'
        + '<div style="font-size:1.7rem;color:#4caf82;font-weight:700">' + rate.toFixed(2) + '%</div>'
        + '<div style="font-size:.75rem;color:#666">' + split + '% Earn + ' + (100 - split) + '% брокер</div></div>'
        + '<div><div style="color:#999;font-size:.8rem">Твоих денег</div>'
        + '<div style="font-size:1.7rem;color:#fff;font-weight:700">$' + cgN(contributed) + '</div>'
        + '<div style="font-size:.75rem;color:#666">' + cPct.toFixed(0) + '% от цели</div></div>'
        + '<div><div style="color:#999;font-size:.8rem">Заработали проценты</div>'
        + '<div style="font-size:1.7rem;color:#4caf82;font-weight:700">$' + cgN(growth) + '</div>'
        + '<div style="font-size:.75rem;color:#666">' + (100 - cPct).toFixed(0) + '% от цели</div></div>'
        + '</div>'
        + '<div style="display:flex;height:26px;border-radius:6px;overflow:hidden;font-size:.75rem;font-weight:600">'
        + '<div style="width:' + cPct + '%;background:#3a5a7d;display:flex;align-items:center;justify-content:center;color:#fff">'
        + (cPct > 14 ? 'взносы ' + cPct.toFixed(0) + '%' : '') + '</div>'
        + '<div style="width:' + (100 - cPct) + '%;background:#4caf82;display:flex;align-items:center;justify-content:center;color:#000">'
        + (cPct < 86 ? 'рост ' + (100 - cPct).toFixed(0) + '%' : '') + '</div>'
        + '</div>';

      // Milestones
      var fiCapital = rate > 0 ? CG.lifeAnnual / (rate / 100) : null;
      var rows = [];
      if (fiCapital) {
        rows.push({ label: '🛟 Расходы покрыты пассивом', amount: Math.round(fiCapital),
                    note: '$' + cgN(CG.lifeAnnual) + '/год расходов при ' + rate.toFixed(2) + '%' });
      }
      [100000, 250000, 500000, 1000000].forEach(function (v) {
        rows.push({ label: '💰 $' + cgN(v), amount: v, note: '' });
      });

      var html = '<table><thead><tr><th>Рубеж</th><th>Капитал</th><th>Когда</th><th>Срок</th><th>Твоих / рост</th></tr></thead><tbody>';
      rows.forEach(function (m) {
        var mn = cgMonths(m.amount, pmt, rate);
        if (mn === null) {
          html += '<tr><td>' + m.label + '</td><td>$' + cgN(m.amount) + '</td><td colspan="3" style="color:#ff6b6b">недостижимо</td></tr>';
          return;
        }
        var contr = Math.min(pmt * mn, m.amount);
        var gr = Math.max(0, m.amount - contr);
        html += '<tr>'
          + '<td>' + m.label + (m.note ? '<div style="font-size:.72rem;color:#777">' + m.note + '</div>' : '') + '</td>'
          + '<td>$' + cgN(m.amount) + '</td>'
          + '<td style="color:#64b5f6;font-weight:700">' + cgLabel(CG.startOffset + mn) + '</td>'
          + '<td style="color:#888">' + (mn / 12).toFixed(1) + ' лет</td>'
          + '<td style="font-size:.85rem">$' + cgN(contr) + ' <span style="color:#4caf82">+ $' + cgN(gr) + '</span></td>'
          + '</tr>';
      });
      html += '</tbody></table>';
      document.getElementById('cgMilestones').innerHTML = html;
    }
    cgCalc();
  </script>`;
}

function renderHistory(snapshots: FinanceSnapshot[]): string {
  if (snapshots.length === 0) {
    return `
  <div class="section">
    <h2>📊 История</h2>
    <div style="color:#888">Снэпшотов пока нет. Они снимаются автоматически раз в неделю. <button onclick="takeSnap()" style="margin-left:8px">Снять сейчас</button></div>
  </div>
  <script>
    async function takeSnap() {
      await fetch('/api/finance/snapshot', { method: 'POST' });
      location.reload();
    }
  </script>`;
  }

  const W = 880;
  const H = 280;
  const padL = 60;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const xs = snapshots.map((s) => new Date(s.ts).getTime());
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = Math.max(1, xMax - xMin);

  const series: { key: keyof FinanceSnapshot; color: string; label: string }[] =
    [
      { key: "totalCreditBalanceUsd", color: "#ff6b6b", label: "Долги" },
      { key: "totalLiquidAssetsUsd", color: "#4caf82", label: "Ликвид" },
      { key: "netWorthUsd", color: "#64b5f6", label: "Net worth" },
    ];

  const allValues = snapshots.flatMap((s) =>
    series.map((sr) => Number(s[sr.key])),
  );
  const yMin = Math.min(...allValues, 0);
  const yMax = Math.max(...allValues, 0);
  const ySpan = Math.max(1, yMax - yMin);

  const xPos = (t: number): number => padL + ((t - xMin) / xSpan) * innerW;
  const yPos = (v: number): number =>
    padT + innerH - ((v - yMin) / ySpan) * innerH;

  const yZero = yPos(0);

  // grid lines (5 levels)
  const gridLines: string[] = [];
  const yLabels: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (ySpan * i) / 4;
    const y = yPos(v);
    gridLines.push(
      `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="#2a2e3a" stroke-width="1"/>`,
    );
    yLabels.push(
      `<text x="${padL - 8}" y="${y + 4}" fill="#888" font-size="11" text-anchor="end">$${Math.round(v).toLocaleString("en-US")}</text>`,
    );
  }

  const lines = series
    .map((sr) => {
      const pts = snapshots
        .map(
          (s) => `${xPos(new Date(s.ts).getTime())},${yPos(Number(s[sr.key]))}`,
        )
        .join(" ");
      const dots = snapshots
        .map(
          (s) =>
            `<circle cx="${xPos(new Date(s.ts).getTime())}" cy="${yPos(Number(s[sr.key]))}" r="3" fill="${sr.color}"><title>${s.date}: $${Number(s[sr.key]).toLocaleString("en-US")}</title></circle>`,
        )
        .join("");
      return `<polyline fill="none" stroke="${sr.color}" stroke-width="2" points="${pts}"/>${dots}`;
    })
    .join("");

  // x-axis labels: first, middle, last
  const xLabels: string[] = [];
  const xTickIdx =
    snapshots.length <= 6
      ? snapshots.map((_, i) => i)
      : [
          0,
          Math.floor(snapshots.length / 4),
          Math.floor(snapshots.length / 2),
          Math.floor((3 * snapshots.length) / 4),
          snapshots.length - 1,
        ];
  for (const i of xTickIdx) {
    const s = snapshots[i]!;
    const x = xPos(new Date(s.ts).getTime());
    xLabels.push(
      `<text x="${x}" y="${H - padB + 18}" fill="#888" font-size="11" text-anchor="middle">${s.date.slice(5)}</text>`,
    );
  }

  const legend = series
    .map(
      (sr) =>
        `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;color:#ccc;font-size:.9rem"><span style="width:14px;height:3px;background:${sr.color};display:inline-block"></span>${sr.label}</span>`,
    )
    .join("");

  const last = snapshots[snapshots.length - 1]!;
  const first = snapshots[0]!;
  const debtDelta = last.totalCreditBalanceUsd - first.totalCreditBalanceUsd;
  const liquidDelta = last.totalLiquidAssetsUsd - first.totalLiquidAssetsUsd;
  const netDelta = last.netWorthUsd - first.netWorthUsd;
  const deltaColor = (d: number, lowerIsBetter = false): string => {
    if (Math.abs(d) < 1) return "#888";
    const good = lowerIsBetter ? d < 0 : d > 0;
    return good ? "#4caf82" : "#ff6b6b";
  };
  const sign = (d: number): string => (d >= 0 ? "+" : "");

  return `
  <div class="section">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <h2 style="margin:0">📊 История (${snapshots.length} снэпшот${snapshots.length === 1 ? "" : "ов"})</h2>
      <button onclick="takeSnap()">📸 Снять снэпшот</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px">
      <div>
        <div style="font-size:.8rem;color:#999">Δ долги</div>
        <div style="font-size:1.2rem;font-weight:700;color:${deltaColor(debtDelta, true)}">${sign(debtDelta)}$${Math.round(debtDelta).toLocaleString("en-US")}</div>
      </div>
      <div>
        <div style="font-size:.8rem;color:#999">Δ ликвид</div>
        <div style="font-size:1.2rem;font-weight:700;color:${deltaColor(liquidDelta)}">${sign(liquidDelta)}$${Math.round(liquidDelta).toLocaleString("en-US")}</div>
      </div>
      <div>
        <div style="font-size:.8rem;color:#999">Δ net worth</div>
        <div style="font-size:1.2rem;font-weight:700;color:${deltaColor(netDelta)}">${sign(netDelta)}$${Math.round(netDelta).toLocaleString("en-US")}</div>
      </div>
      <div>
        <div style="font-size:.8rem;color:#999">Период</div>
        <div style="font-size:1rem;color:#ccc">${first.date} → ${last.date}</div>
      </div>
    </div>
    <div style="overflow-x:auto">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;display:block;background:#1a1d27;border-radius:6px">
        ${gridLines.join("")}
        ${yMin < 0 && yMax > 0 ? `<line x1="${padL}" y1="${yZero}" x2="${W - padR}" y2="${yZero}" stroke="#555" stroke-width="1" stroke-dasharray="3,3"/>` : ""}
        ${yLabels.join("")}
        ${xLabels.join("")}
        ${lines}
      </svg>
    </div>
    <div style="margin-top:10px">${legend}</div>
  </div>
  <script>
    async function takeSnap() {
      const btn = event.target;
      btn.disabled = true; btn.textContent = '...';
      try {
        await fetch('/api/finance/snapshot', { method: 'POST' });
        location.reload();
      } catch (e) {
        btn.disabled = false; btn.textContent = '📸 Снять снэпшот';
        alert('Ошибка: ' + e);
      }
    }
  </script>`;
}

export function renderFinancePage(
  metrics: FinanceMetrics,
  snapshots: FinanceSnapshot[] = [],
  liveEarnApyPct = 0,
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>💼 Финансы | EarnOptimizer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1d27 0%, #16191f 100%);
      color: #e0e0e0;
      line-height: 1.6;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding: 20px;
      background: rgba(76, 175, 130, 0.1);
      border: 1px solid #4caf82;
      border-radius: 8px;
    }
    h1 { font-size: 1.8rem; color: #4caf82; }
    nav a {
      color: #4caf82;
      text-decoration: none;
      margin-left: 16px;
      padding: 6px 12px;
      border: 1px solid #4caf82;
      border-radius: 6px;
      font-weight: 600;
      transition: all 0.2s;
    }
    nav a:hover { background: #4caf82; color: #000; }
    nav a.active { background: #4caf82; color: #000; }
    .section {
      background: #252836;
      border: 1px solid #3a3f4d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #1a1d27;
      border-radius: 6px;
      overflow: hidden;
    }
    thead { background: #2a2d37; }
    th, td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid #2a2d37;
      vertical-align: top;
    }
    th {
      color: #4caf82;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 0.8rem;
    }
    tr:hover { background: #2a2d37; }
    .green { color: #4caf82; }
    h3 { font-size: 1.1rem; }
    button {
      background: #4caf82;
      border: none;
      border-radius: 6px;
      color: #000;
      padding: 8px 14px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #66bb6a; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>💼 Финансовая картина</h1>
      <nav>
        <a href="/">📈 Earn</a>
        <a href="/finance" class="active">💼 Финансы</a>
        <a href="/receipts">🧾 Чеки</a>
      </nav>
    </header>
    ${renderSummary(metrics)}
    ${renderTrafficLight(metrics)}
    ${renderTopStats(metrics)}
    ${renderRecommendation(metrics)}
    ${renderPayoffPlan(metrics)}
    ${renderCreditsTable(metrics)}
    ${renderAssetsAndDebts(metrics)}
    ${renderGoal(metrics)}
    ${renderCapitalGoals(metrics, liveEarnApyPct)}
    ${renderHistory(snapshots)}
    ${renderMilestones(metrics)}
    <footer style="text-align:center;margin-top:40px;color:#666;font-size:0.85rem">
      Данные из <code>data/finance.json</code> — обновляй вручную после крупных операций.
    </footer>
  </div>
</body>
</html>`;
}
