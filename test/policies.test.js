'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createValuePolicy, describePolicy, DEFAULT_KEEP_KEYS } = require('../src/policies.js');

test('the default policy drops null on keys only', () => {
  const p = createValuePolicy();
  assert.equal(p.shouldDrop(null, 'a', {}), true);
  assert.equal(p.shouldDrop(null, '', { inArray: true }), false);
  assert.equal(p.shouldDrop(null, '', { inArray: true, allowArrayElement: true }), true);
});

test('the policy object is frozen so callers cannot mutate shared state', () => {
  const p = createValuePolicy();
  assert.equal(Object.isFrozen(p), true);
  assert.throws(() => { 'use strict'; p.shouldDrop = () => true; }, TypeError);
});

test('describePolicy covers every value class', () => {
  const rows = describePolicy(createValuePolicy());
  const values = rows.map((r) => r.value);
  for (const v of ['null', 'false', '0', '""', '[]', '{}', 'NaN']) {
    assert.ok(values.includes(v), `missing ${v}`);
  }
  assert.ok(rows.every((r) => typeof r.why === 'string' && r.why.length > 0));
});

test('only null is enabled by default', () => {
  const rows = describePolicy(createValuePolicy());
  const enabled = rows.filter((r) => r.enabled).map((r) => r.value);
  assert.deepEqual(enabled, ['null']);
});

test('keepIdLike protects every default id-like name', () => {
  const p = createValuePolicy();
  for (const key of DEFAULT_KEEP_KEYS) {
    assert.equal(p.shouldDrop(null, key, {}), false, `${key} should be protected`);
  }
});

test('keepFlags protects the three flag prefixes', () => {
  const p = createValuePolicy({ dropFalse: true, dropZero: true, dropEmptyString: true });
  assert.equal(p.shouldDrop(false, 'is_admin', {}), false);
  assert.equal(p.shouldDrop(false, 'hasKey', {}), false);
  assert.equal(p.shouldDrop(false, 'can_edit', {}), false);
  assert.equal(p.shouldDrop(false, 'plain_flag', {}), true);
});

test('flag detection is case sensitive on purpose', () => {
  // `is` lowercase alone must not match: `island` is a normal key.
  const p = createValuePolicy({ dropFalse: true });
  assert.equal(p.shouldDrop(false, 'island', {}), true);
});

test('keyFilter vetoes everything outside the pattern', () => {
  const p = createValuePolicy({ keyFilter: /^tmp_/ });
  assert.equal(p.shouldDrop(null, 'tmp_a', {}), true);
  assert.equal(p.shouldDrop(null, 'real_a', {}), false);
});

test('keyFilter does not veto array slots, which have no key', () => {
  const p = createValuePolicy({ keyFilter: /^tmp_/ });
  assert.equal(p.shouldDrop(null, '', { inArray: true, allowArrayElement: true }), true);
});

test('NaN is only droppable when asked', () => {
  assert.equal(createValuePolicy().shouldDrop(NaN, 'a', {}), false);
  assert.equal(createValuePolicy({ dropNaN: true }).shouldDrop(NaN, 'a', {}), true);
});

test('-0 is droppable by the zero rule', () => {
  assert.equal(createValuePolicy({ dropZero: true }).shouldDrop(-0, 'a', {}), true);
});

test('a positive number is never droppable', () => {
  const p = createValuePolicy({ dropZero: true, dropNaN: true });
  assert.equal(p.shouldDrop(1, 'a', {}), false);
  assert.equal(p.shouldDrop(-1, 'a', {}), false);
});

test('non-empty containers are never droppable by the empty rules', () => {
  const p = createValuePolicy({ dropEmptyArray: true, dropEmptyObject: true });
  assert.equal(p.shouldDrop([1], 'a', {}), false);
  assert.equal(p.shouldDrop({ b: 1 }, 'a', {}), false);
});

test('an empty container held as an array slot is never droppable', () => {
  const p = createValuePolicy({ dropEmptyArray: true, dropEmptyObject: true });
  assert.equal(p.shouldDrop({}, '', { inArray: true, allowArrayElement: true }), false);
});

test('keepKeys extends the protected set', () => {
  const p = createValuePolicy({ keepKeys: ['retries', 'timeout'] });
  assert.equal(p.shouldDrop(0, 'retries', {}), false);
  assert.equal(p.shouldDrop(null, 'timeout', {}), false);
  assert.equal(p.shouldDrop(null, 'other', {}), true);
});

test('keepKeyPattern accepts a string and a RegExp identically', () => {
  const fromString = createValuePolicy({ keepKeyPattern: '^x_' });
  const fromRegExp = createValuePolicy({ keepKeyPattern: /^x_/ });
  assert.equal(fromString.shouldDrop(null, 'x_a', {}), false);
  assert.equal(fromRegExp.shouldDrop(null, 'x_a', {}), false);
});

test('an empty keepKeyPattern is treated as absent', () => {
  assert.equal(createValuePolicy({ keepKeyPattern: '' }).keepPattern, null);
});

test('options are readable from the frozen policy', () => {
  const p = createValuePolicy({ dropZero: true });
  assert.equal(p.options.dropZero, true);
  assert.equal(p.options.dropNull, true);
  assert.equal(Object.isFrozen(p.options), true);
});