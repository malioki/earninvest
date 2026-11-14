# EarnInvest

A personal finance engine that answers two questions honestly: **when will the debt be gone**, and **where does the money actually go**.

Built for my own situation — several loans at very different rates, income in three currencies, and a suspicion that the grocery budget was fiction. It turned out to be. Since October 2026 it runs as a Telegram bot and web app that my family uses every day.

---

## What it does

### Debt payoff projection

Simulates every month forward: interest accrues on each open credit, contractual minimums are taken, and whatever is left over is thrown at the head of a priority queue. Personal (interest-free) debts come first — a deliberate choice, since a promise to a person outranks arithmetic — then credits by APR, with smaller balances first when rates are within a percentage point.

The output is a dated plan: which debt closes in which month, how much monthly cash each closure frees, and the total interest actually paid along the way.

That last number matters. Extrapolating today's monthly interest across a year overstates it roughly twofold, because balances fall as you pay. The simulation reports what you will really pay.

### Spending and diet analysis

Parses fiscal receipts straight from the QR-code URL on the paper slip — merchant, date, and every line item with quantity and price — then categorises each product by name. Two fiscal portals are supported: Transnistria (`ofd.apb.online`) and Moldova (`mev.sfs.md`). A receipt without a usable QR can be sent as a photo; an LLM reads it, and nothing is saved until a person confirms what it read.

The categorisation is deliberately two-tier: food versus household first, then a food breakdown. The first receipt I ingested was 62% dishwasher tablets and cleaning supplies. Logged as "groceries", it would have poisoned the numbers.

Cash spending that leaves no receipt — coffee, street food, taxis — goes in through one-tap presets that **remember the last amount entered**, so the buttons drift toward real prices instead of the ones I guessed on day one.

### Telegram bot with offline tolerance

Same presets, from a phone. Telegram queues updates for about 24 hours while the server is down and replays them on reconnect, so expenses are dated by **when the message was sent**, not when it was finally processed. Log the coffee on Saturday with the server off, and it lands on Saturday.

Writes are gated by a user-id allowlist — the bot is reachable by anyone who finds it — and debts, credits and the payment calendar are visible only to a narrower finance list.

### Reminders and digests

A scheduler that only speaks when there is something to say: the evening before a credit payment is due (a missed one costs a week of penalties and a credit-bureau mark), a weekly and a monthly spending digest against the budget, official FX rates from the Moldovan and Transnistrian central banks, and a weekly zip of `data/` sent to Telegram — the copy that lives off the machine, since the data is not in git.

### Portfolio contributions

`/invest 100` splits a contribution across target weights, sending each cell its shortfall first, so the portfolio rebalances through new money instead of sales. Small amounts for the broker wait in an "envelope" and go out once they reach a threshold or on a quarterly date, so a transfer fee never eats a $50 contribution. Reminders on the 15th, on the quarterly transfer day and a week before the yearly review; every contribution can be undone, and an old undo button cannot remove a newer one.

### Multi-exchange yield optimiser

A separate process (`npm run dev:earn`). Fetches Earn products from Binance, HTX and Bybit, flattens their tiered APY structures into fillable slots, and allocates capital across them — either greedily or spread across the top N products, with per-product and per-exchange concentration caps. Produces a concrete action list: withdraw here, transfer there, subscribe to this.

---

## Stack

TypeScript · Node.js · Express · Telegraf · node-cron · axios · Anthropic SDK (receipt photos) · Docker

No database. State lives in JSON files under `data/`, which suits a family-sized tool and keeps the whole thing inspectable with a text editor.

## Layout

```
src/
  config/       env-driven configuration
  telegram/     bot: expenses, receipts, finance screens, /invest
  web/          finance, spending, shopping and Earn pages
  finance/      metrics, allocation advice, payoff simulation, bills, FX rates
  receipts/     fiscal receipt parser + categorisation rules
  expenses/     cash expenses with learning presets
  portfolio/    target weights, contribution split, envelope, reminders
  scheduler/    cron jobs
  backup/       weekly data/ archive
  ai/           receipt photos and questions (optional)
  exchanges/    IExchangeAdapter + Binance / HTX / Bybit / mock
  optimizer/    tiered-APY allocation
```

## Running it

```bash
npm install
cp .env.example .env                               # DEMO_MODE=true works without API keys
cp data/finance.example.json data/finance.json
cp data/portfolio.example.json data/portfolio.json # optional: /invest
npm run dev
```

Then `localhost:3000/finance` for debt and projections, `/receipts` for spending. The Earn dashboard is its own process on the next port.

Or in Docker, restarting with the machine:

```bash
docker compose up -d --build
```

Real data files (`data/*.json`) are gitignored; the `*.example.json` files show the shape. Household-specific words for categorisation (a child's name → kids' spending) go in `data/expense-keywords.json`, outside the code — see `data/expense-keywords.example.json`.

---

## Notes

The receipt parser is host-allowlisted on purpose — other portals use different markup and would parse silently wrong, which is worse than failing.

Interest rates in the credit list are **nominal**, not effective. Local lenders quote the effective rate (DAE), which is higher; the payoff maths needs the nominal one. Mixing them overstates interest by around 20%.

Nothing here is financial advice. It is arithmetic on numbers you supply.
