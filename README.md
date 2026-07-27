# EarnInvest

A personal finance engine that answers two questions honestly: **when will the debt be gone**, and **where does the money actually go**.

Built for my own situation — several loans at very different rates, income in three currencies, and a suspicion that the grocery budget was fiction. It turned out to be.

---

## What it does

### Debt payoff projection

Simulates every month forward: interest accrues on each open credit, contractual minimums are taken, and whatever is left over is thrown at the head of a priority queue. Personal (interest-free) debts come first — a deliberate choice, since a promise to a person outranks arithmetic — then credits by APR, with smaller balances first when rates are within a percentage point.

The output is a dated plan: which debt closes in which month, how much monthly cash each closure frees, and the total interest actually paid along the way.

That last number matters. Extrapolating today's monthly interest across a year overstates it roughly twofold, because balances fall as you pay. The simulation reports what you will really pay.

### Multi-exchange yield optimiser

Fetches Earn products from Binance, HTX and Bybit, flattens their tiered APY structures into fillable slots, and allocates capital across them — either greedily or spread across the top N products, with per-product and per-exchange concentration caps. Produces a concrete action list: withdraw here, transfer there, subscribe to this.

### Spending and diet analysis

Parses fiscal receipts straight from the QR-code URL on the paper slip — merchant, date, and every line item with quantity and price — then categorises each product by name.

The categorisation is deliberately two-tier: food versus household first, then a food breakdown. The first receipt I ingested was 62% dishwasher tablets and cleaning supplies. Logged as "groceries", it would have poisoned the numbers.

Cash spending that leaves no receipt — coffee, street food, taxis — goes in through one-tap presets that **remember the last amount entered**, so the buttons drift toward real prices instead of the ones I guessed on day one.

### Telegram bot with offline tolerance

Same presets, from a phone. Telegram queues updates for about 24 hours while the server is down and replays them on reconnect, so expenses are dated by **when the message was sent**, not when it was finally processed. Log the coffee on Saturday with the server off, and it lands on Saturday.

Writes are gated by a user-id allowlist — the bot is reachable by anyone who finds it.

---

## Stack

TypeScript · Node.js · Express · Telegraf · node-cron · axios

No database. State lives in JSON files under `data/`, which suits a single-user tool and keeps the whole thing inspectable with a text editor.

## Layout

```
src/
  config/       env-driven configuration
  exchanges/    IExchangeAdapter + Binance / HTX / Bybit / mock
  optimizer/    tiered-APY allocation
  finance/      metrics, allocation advice, payoff simulation
  receipts/     fiscal receipt parser + categorisation rules
  expenses/     cash expenses with learning presets
  telegram/     bot, offline-safe expense logging
  web/          dashboard, finance page, spending page
  scheduler/    cron jobs
```

## Running it

```bash
npm install
cp .env.example .env          # DEMO_MODE=true works without API keys
cp data/finance.example.json data/finance.json
npm run dev
```

Then `localhost:3000` for the Earn dashboard, `/finance` for debt and projections, `/receipts` for spending.

Real data files (`data/*.json`) are gitignored. The example file shows the shape.

---

## Notes

The receipt parser targets one specific fiscal portal (`ofd.apb.online`, Transnistria) and is host-allowlisted on purpose — other portals use different markup and would parse silently wrong, which is worse than failing.

Interest rates in the credit list are **nominal**, not effective. Local lenders quote the effective rate (DAE), which is higher; the payoff maths needs the nominal one. Mixing them overstates interest by around 20%.

Nothing here is financial advice. It is arithmetic on numbers you supply.
