// When a screen asks "сколько отдал?", the user's next text message is the
// answer, not an expense. This remembers what each user was asked — briefly,
// in memory: a restart or ten minutes of silence simply forgets the question.

export type Pending =
  | { kind: "debt-part"; debtId: string }
  | { kind: "debt-new" }
  | { kind: "income"; incomeId: string }
  | { kind: "income-other" }
  | { kind: "credit"; creditId: string }
  | { kind: "overdue"; creditId: string }
  | { kind: "credit-balance"; creditId: string }
  | { kind: "cash" }
  | { kind: "purchase"; storeId: string }
  | { kind: "bill-new" }
  | { kind: "bill-edit"; billId: string }
  | { kind: "bill-pay"; billId: string }
  | { kind: "ask" };

const TTL_MS = 10 * 60_000;
const store = new Map<number, { p: Pending; until: number }>();

export function setPending(userId: number, p: Pending): void {
  store.set(userId, { p, until: Date.now() + TTL_MS });
}

export function takePending(userId: number): Pending | undefined {
  const e = store.get(userId);
  store.delete(userId);
  return e && e.until > Date.now() ? e.p : undefined;
}

export function clearPending(userId: number): void {
  store.delete(userId);
}
