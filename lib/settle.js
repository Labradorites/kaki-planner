// Expense splitting and settle-up. Pure functions: no DB, no I/O, so they can be unit tested.
// All the maths is done in integer cents, so balances always sum to exactly zero.

const MAX_AMOUNT = 1e9;   // per expense, in its own currency and after conversion
const MAX_RATE = 1e6;     // 1 unit of foreign currency = at most this many of the event's currency
const EXACT_LIMIT = 16;   // the optimal settle-up is 2^n work; above this many people with a balance, use greedy

const isValidAmount = x => Number.isFinite(x) && x > 0 && x <= MAX_AMOUNT;
const isValidRate = x => Number.isFinite(x) && x > 0 && x <= MAX_RATE;
const toCents = x => Math.round(x * 100);

// Split totalCents equally between ids. Leftover cents go one each to the lowest ids, so the parts add up exactly.
function splitCents(totalCents, ids) {
  const sorted = [...ids].sort((a, b) => a - b);
  const base = Math.floor(totalCents / sorted.length);
  const extra = totalCents - base * sorted.length;
  return new Map(sorted.map((id, i) => [id, base + (i < extra ? 1 : 0)]));
}

// Net balance per member in cents (+ = is owed money).
function balancesInCents(expenses, shareRows, memberIds) {
  const bal = new Map(memberIds.map(id => [id, 0]));
  const sharesBy = new Map();
  for (const s of shareRows) {
    if (!sharesBy.has(s.expense_id)) sharesBy.set(s.expense_id, []);
    sharesBy.get(s.expense_id).push(s.user_id);
  }
  for (const e of expenses) {
    const total = toCents(e.amount * e.rate);
    const who = sharesBy.get(e.id) || [];
    // Rows saved before rates were range-checked can hold Infinity; leave them out rather than poison every balance.
    if (!who.length || !Number.isSafeInteger(total)) continue;
    bal.set(e.paid_by, (bal.get(e.paid_by) || 0) + total);
    for (const [id, part] of splitCents(total, who)) bal.set(id, (bal.get(id) || 0) - part);
  }
  return bal;
}

// Largest debtor pays largest creditor until everyone in the group is square. People with a zero balance are ignored.
// Uses at most n-1 transfers for a group of n people whose balances sum to zero.
function greedy(people) {
  const byAmt = (a, b) => b.amt - a.amt || a.id - b.id;
  const debtors = people.filter(p => p.amt < 0).map(p => ({ id: p.id, amt: -p.amt })).sort(byAmt);
  const creditors = people.filter(p => p.amt > 0).map(p => ({ ...p })).sort(byAmt);
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].amt, creditors[j].amt);
    transfers.push({ from: debtors[i].id, to: creditors[j].id, cents: amt });
    debtors[i].amt -= amt; creditors[j].amt -= amt;
    if (!debtors[i].amt) i++;
    if (!creditors[j].amt) j++;
  }
  return transfers;
}

// Split people into as many groups as possible that each sum to zero. A group of k needs k-1 transfers,
// so the fewest transfers overall is n minus the number of groups. Bitmask DP over subsets.
function zeroSumGroups(people) {
  const n = people.length, full = (1 << n) - 1;
  const sum = new Array(full + 1).fill(0);
  for (let m = 1; m <= full; m++) {
    const low = 31 - Math.clz32(m & -m);
    sum[m] = sum[m & (m - 1)] + people[low].amt;
  }
  // best[m] = most zero-sum groups the people in m can be cut into, when added one at a time; last[m] = who was added last.
  const best = new Int8Array(full + 1), last = new Int8Array(full + 1);
  for (let m = 1; m <= full; m++) {
    let top = -1;
    for (let i = 0; i < n; i++) if (m & (1 << i) && best[m ^ (1 << i)] > top) { top = best[m ^ (1 << i)]; last[m] = i; }
    best[m] = top + (sum[m] === 0 ? 1 : 0);
  }
  // Walk back to recover the order people were added, then cut it wherever the running total is zero.
  const order = [];
  for (let m = full; m; m ^= 1 << last[m]) order.unshift(last[m]);
  const groups = [];
  let group = [], mask = 0;
  for (const i of order) {
    group.push(people[i]); mask |= 1 << i;
    if (sum[mask] === 0) { groups.push(group); group = []; }
  }
  return groups;
}

// Fewest transfers that clear all debts (exact up to EXACT_LIMIT people with a balance, greedy above that).
function transfersFor(bal) {
  const people = [...bal].map(([id, amt]) => ({ id, amt })).filter(p => p.amt !== 0).sort((a, b) => a.id - b.id);
  const groups = people.length <= EXACT_LIMIT ? zeroSumGroups(people) : [people];
  return groups.flatMap(greedy);
}

// Balances (in the event's currency, + = is owed money) and the fewest transfers to settle.
function settle(expenses, shareRows, memberIds) {
  const bal = balancesInCents(expenses, shareRows, memberIds);
  return {
    balances: Object.fromEntries([...bal].map(([id, c]) => [id, c / 100])),
    transfers: transfersFor(bal).map(t => ({ from: t.from, to: t.to, amount: t.cents / 100 })),
  };
}

module.exports = { MAX_AMOUNT, MAX_RATE, EXACT_LIMIT, isValidAmount, isValidRate, toCents, splitCents, transfersFor, settle };
