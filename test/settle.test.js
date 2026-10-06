// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { settle, splitCents, transfersFor, isValidAmount, isValidRate, EXACT_LIMIT } = require('../lib/settle');

// One expense paid by `paidBy`, split equally between `split`.
let nextId = 1;
function expenses(list) {
  const exp = [], shares = [];
  for (const { amount, rate = 1, paidBy, split } of list) {
    const id = nextId++;
    exp.push({ id, amount, rate, paid_by: paidBy });
    for (const u of split) shares.push({ expense_id: id, user_id: u });
  }
  return [exp, shares];
}
const sumCents = bal => Object.values(bal).reduce((s, b) => s + Math.round(b * 100), 0);
// Apply transfers to balances (in cents) and check everyone ends at zero.
function assertSettles(balCents, transfers) {
  const left = new Map(balCents);
  for (const t of transfers) {
    left.set(t.from, left.get(t.from) + t.cents);
    left.set(t.to, left.get(t.to) - t.cents);
  }
  for (const [id, c] of left) assert.equal(c, 0, `user ${id} still has ${c} cents`);
}
// Fewest transfers by brute force: n minus the most zero-sum groups the balances can be partitioned into.
function bruteMin(amts) {
  const nz = amts.filter(a => a !== 0);
  let best = 0;
  const go = (rest, groups) => {
    if (!rest.length) { best = Math.max(best, groups); return; }
    const [first, ...others] = rest;
    for (let m = 0; m < 1 << others.length; m++) {
      const pick = others.filter((_, i) => m & (1 << i));
      if (first + pick.reduce((s, x) => s + x, 0) === 0) go(others.filter((_, i) => !(m & (1 << i))), groups + 1);
    }
  };
  go(nz, 0);
  return nz.length - best;
}

test('rejects infinite, huge and non-positive rates and amounts', () => {
  for (const bad of [Infinity, Number('1e999'), NaN, 0, -1, 1e6 + 1]) assert.equal(isValidRate(bad), false, String(bad));
  for (const good of [0.0001, 1, 1.35, 1e6]) assert.equal(isValidRate(good), true, String(good));
  for (const bad of [Infinity, NaN, 0, -5, 1e9 + 1]) assert.equal(isValidAmount(bad), false, String(bad));
  assert.equal(isValidAmount(12.5), true);
});

test('an Infinity rate already in the DB does not poison the balances', () => {
  const [exp, shares] = expenses([
    { amount: 10, rate: Infinity, paidBy: 1, split: [1, 2] },
    { amount: 30, paidBy: 2, split: [1, 2] },
  ]);
  const { balances, transfers } = settle(exp, shares, [1, 2]);
  assert.deepEqual(balances, { 1: -15, 2: 15 });
  assert.deepEqual(transfers, [{ from: 1, to: 2, amount: 15 }]);
});

test('100 split three ways: balances sum to exactly zero', () => {
  const [exp, shares] = expenses([{ amount: 100, paidBy: 1, split: [1, 2, 3] }]);
  const { balances, transfers } = settle(exp, shares, [1, 2, 3]);
  assert.equal(sumCents(balances), 0);
  // The extra cent goes to the lowest id, i.e. the payer's own share is 33.34.
  assert.deepEqual(balances, { 1: 66.66, 2: -33.33, 3: -33.33 });
  assert.equal(transfers.reduce((s, t) => s + t.amount, 0).toFixed(2), '66.66');
});

test('splitCents hands out leftover cents by user id, and the parts add up', () => {
  assert.deepEqual([...splitCents(1000, [3, 1, 2])], [[1, 334], [2, 333], [3, 333]]);
  assert.deepEqual([...splitCents(1, [5, 4])], [[4, 1], [5, 0]]);
  for (let total = 0; total < 500; total += 7) {
    const parts = [...splitCents(total, [1, 2, 3, 4, 5, 6, 7]).values()];
    assert.equal(parts.reduce((s, x) => s + x, 0), total);
    assert.ok(Math.max(...parts) - Math.min(...parts) <= 1);
  }
});

test('foreign-currency expenses balance to zero too', () => {
  const [exp, shares] = expenses([
    { amount: 1500, rate: 0.0091, paidBy: 2, split: [1, 2, 3] },
    { amount: 33.33, rate: 1.35, paidBy: 3, split: [1, 2, 3, 4] },
  ]);
  assert.equal(sumCents(settle(exp, shares, [1, 2, 3, 4]).balances), 0);
});

test('settle-up is minimal: +6 +4 -4 -3 -3 needs 3 transfers, not 4', () => {
  const bal = new Map([[1, 600], [2, 400], [3, -400], [4, -300], [5, -300]]);
  const t = transfersFor(bal);
  assertSettles(bal, t);
  assert.equal(t.length, 3);
});

test('settle-up matches the brute-force minimum on random balances', () => {
  let seed = 42;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const n = 2 + rand(8);
    // Small values so zero-sum subgroups actually turn up.
    const amts = Array.from({ length: n - 1 }, () => (rand(9) - 4) * 100);
    amts.push(0 - amts.reduce((s, x) => s + x, 0));
    const bal = new Map(amts.map((a, i) => [i + 1, a]));
    const t = transfersFor(bal);
    assertSettles(bal, t);
    assert.equal(t.length, bruteMin(amts), `balances ${amts}`);
    assert.ok(t.every(x => x.cents > 0));
  }
});

test('above the exact limit it falls back to greedy and still settles', () => {
  const n = EXACT_LIMIT + 4;
  const bal = new Map(Array.from({ length: n }, (_, i) => [i + 1, i < n / 2 ? 100 + i : -(100 + i - n / 2)]));
  const t = transfersFor(bal);
  assertSettles(bal, t);
  assert.ok(t.length <= n - 1);
});

test('nobody owes anything: no transfers', () => {
  assert.deepEqual(settle([], [], [1, 2, 3]), { balances: { 1: 0, 2: 0, 3: 0 }, transfers: [] });
});
