'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { slim, stringify, minify, sortReplacer } = require('../src/slim.js');

// ---------------------------------------------------------------------------
// Bug 1: a key literally named `__proto__` is silently destroyed.
//
// `__proto__` is not a property of the prototype; it is an ACCESSOR defined on
// Object.prototype. `out[k] = value` for that one name runs the setter, which
// REPLACES THE PROTOTYPE of the freshly built container instead of creating an
// own key. The key is not "hidden" -- it is gone: Object.keys() omits it,
// JSON.stringify() emits nothing for it, and no removal is ever reported.
//
// The oracle is V8's own JSON.parse, which creates a real own data property
// for exactly the same bytes.
// ---------------------------------------------------------------------------

test('a key named __proto__ survives slimming as data', () => {
  const input = '{"__proto__":{"polluted":true},"safe":1}';
  const doc = JSON.parse(input);              // ground truth: a real own key
  assert.ok(Object.prototype.hasOwnProperty.call(doc, '__proto__'));

  const out = slim(doc);

  assert.ok(
    Object.prototype.hasOwnProperty.call(out.value, '__proto__'),
    'the __proto__ key must be an own property of the result'
  );
  assert.deepEqual(stringify(out.value), '{"__proto__":{"polluted":true},"safe":1}');
});

test('slimming __proto__ does not re-prototype the object it builds', () => {
  const out = slim(JSON.parse('{"__proto__":{"polluted":true},"safe":1}'));
  assert.equal(
    Object.getPrototypeOf(out.value),
    Object.prototype,
    'the rebuilt container must keep the ordinary prototype'
  );
  // The pollution payload must not be reachable as an inherited property.
  assert.equal(out.value.polluted, undefined);
});

test('a primitive __proto__ value is kept too, not dropped by the setter', () => {
  // `o.__proto__ = 42` runs the setter with a primitive, which the setter
  // IGNORES entirely -- so the key vanishes just as silently.
  const out = slim(JSON.parse('{"__proto__":42,"a":1}'));
  assert.equal(stringify(out.value), '{"__proto__":42,"a":1}');
});

test('__proto__ nested at depth is preserved', () => {
  const out = slim(JSON.parse('{"outer":{"__proto__":{"deep":true}}}'));
  assert.equal(stringify(out.value), '{"outer":{"__proto__":{"deep":true}}}');
});

test('a __proto__ key holding a null value is still reported and removed', () => {
  // dropNull is on by default, so this key IS dropped -- but it must be dropped
  // by the policy (and reported), not swallowed by the setter.
  const out = slim(JSON.parse('{"__proto__":null,"a":1}'));
  assert.deepEqual(stringify(out.value), '{"a":1}');
  assert.deepEqual(out.removals, [{ path: '/__proto__', reason: 'null', value: null }]);
});

test('--sort-keys keeps __proto__ (sortReplacer rebuilds every object)', () => {
  const input = '{"__proto__":{"polluted":true},"b":2,"a":1}';
  const out = minify(input, { sortKeys: true });
  assert.equal(out, '{"__proto__":{"polluted":true},"a":1,"b":2}');
});

test('sortReplacer alone keeps __proto__', () => {
  const doc = JSON.parse('{"__proto__":{"x":1},"k":2}');
  assert.equal(JSON.stringify(doc, sortReplacer), '{"__proto__":{"x":1},"k":2}');
});

test('__proto__ inside an array element object survives', () => {
  const out = slim(JSON.parse('{"arr":[{"__proto__":{"z":1}}]}'));
  assert.equal(stringify(out.value), '{"arr":[{"__proto__":{"z":1}}]}');
});

test('constructor / prototype / toString keep working (no over-escaping)', () => {
  // Only __proto__ is an accessor. These three are ordinary data properties on
  // Object.prototype, so plain assignment already shadows them like JSON.parse.
  // A fix that special-cased every Object.prototype name would be wrong.
  for (const name of ['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
    const input = JSON.stringify({ [name]: 7 });
    assert.equal(stringify(slim(JSON.parse(input)).value), input, name);
  }
});

// ---------------------------------------------------------------------------
// Bug 2: --compact-arrays is documented, parsed and defaulted, but never read.
//
// The flag reached src/slim.js as an option and was then ignored, so it and its
// own default behaved identically and the help text "after dropping elements,
// remove the holes left behind" described nothing.
//
// What it governs is a gap the INPUT already had, not what pruning removed:
// elements REMOVED by the policy are renumbered away in both modes (that is the
// long-documented "renumbers the array", pinned by the existing suite), but a
// gap the document arrived with is a different thing.
//
// The bug: `push` cannot represent a gap. Reading index i of a holey array
// yields `undefined`, so `[1, , 3]` was densified into `[1, 3]` -- the document
// said index 2 held 3, the output says index 1 holds 3. The default now keeps
// the gap (JSON.stringify renders a hole as `null`, as every JSON
// implementation does), and --compact-arrays is the explicit request to close
// it, which is what its name says.
// ---------------------------------------------------------------------------

/** An array with a genuine hole at index 1 (not an explicit undefined value). */
function holey() {
  const a = [1, , 3];
  a.length = 3;
  return a;
}

test('a hole the input had is preserved by default', () => {
  const doc = { a: holey() };
  assert.deepEqual(Object.keys(doc.a), ['0', '2'], 'the fixture really has a hole');

  const out = slim(doc, { compactArrays: false });

  assert.equal(out.value.a.length, 3, 'the length must not shrink');
  assert.deepEqual(Object.keys(out.value.a), ['0', '2'], 'index 1 is still a hole');
  assert.equal(1 in out.value.a, false);
  assert.equal(out.value.a[0], 1);
  assert.equal(out.value.a[2], 3);
});

test('--compact-arrays closes the holes the input had', () => {
  const out = slim({ a: holey() }, { compactArrays: true });
  assert.equal(out.value.a.length, 2);
  assert.deepEqual(Object.keys(out.value.a), ['0', '1']);
  assert.equal(out.value.a[1], 3);
});

test('a preserved hole renders as null in the output text', () => {
  // Ground truth from V8: JSON.stringify renders a hole as `null`. The default
  // therefore emits the same TEXT as the input, while the VALUE keeps the gap.
  const out = slim({ a: holey() }, { compactArrays: false });
  assert.equal(JSON.stringify(out.value), '{"a":[1,null,3]}');
  assert.equal(1 in out.value.a, false, 'but the value keeps a real hole');
  // And the flag changes the text, which is how a user can see it did something.
  assert.equal(JSON.stringify(slim({ a: holey() }, { compactArrays: true }).value), '{"a":[1,3]}');
});

test('a stored undefined value is not mistaken for a hole', () => {
  // `1 in a` is the only honest test. An explicit `undefined` element is a value
  // the document really had, and must be neither dropped nor counted as a gap.
  const a = [];
  a.length = 3;
  a[0] = 1;
  a[1] = undefined;   // a VALUE, not a gap
  a[2] = 3;
  const out = slim({ a }, { compactArrays: false });
  assert.equal(out.value.a.length, 3);
  assert.deepEqual(Object.keys(out.value.a), ['0', '1', '2'], 'no key may go missing');
  assert.equal(1 in out.value.a, true);
  assert.equal(out.value.a[1], undefined);
});

test('a trailing hole is preserved too', () => {
  const a = [1, 2, 3];
  a.length = 4;      // trailing gap
  const out = slim({ a }, { compactArrays: false });
  assert.equal(out.value.a.length, 4, 'length must reflect the input');
  assert.deepEqual(Object.keys(out.value.a), ['0', '1', '2']);
  assert.equal(3 in out.value.a, false);
  // Compacting removes it: the gap is exactly what the flag closes.
  assert.equal(slim({ a }, { compactArrays: true }).value.a.length, 3);
});

test('an all-hole array is preserved as all holes', () => {
  const a = new Array(3);   // length 3, no own index at all
  const out = slim({ a }, { compactArrays: false });
  assert.equal(out.value.a.length, 3);
  assert.deepEqual(Object.keys(out.value.a), []);
  assert.equal(slim({ a }, { compactArrays: true }).value.a.length, 0);
});

test('holes survive at every depth, not just the root', () => {
  const out = slim({ l1: { l2: { l3: holey() } } }, { compactArrays: false });
  assert.deepEqual(Object.keys(out.value.l1.l2.l3), ['0', '2']);
  assert.equal(1 in out.value.l1.l2.l3, false);
});

test('an input hole and a dropped element are both handled, at the right indices', () => {
  // `[1, , null, 3]`: one gap the input had, one element the policy removes.
  // The removal is reported at its ORIGINAL index; the gap survives at the
  // position it had; and the element AFTER the removal renumbers up by one, past
  // the gap. Those are two different rules meeting on one array, which is
  // exactly the case the old `push`-only code got wrong.
  const a = [1, , null, 3];
  a.length = 4;
  const out = slim({ a }, { dropArrayElements: true, compactArrays: false });
  assert.deepEqual(out.removals.map((r) => r.path), ['/a/2']);
  assert.equal(out.value.a.length, 3);
  assert.deepEqual(Object.keys(out.value.a), ['0', '2']);
  assert.equal(1 in out.value.a, false, 'the input gap survived at index 1');
  assert.equal(out.value.a[0], 1);
  assert.equal(out.value.a[2], 3, 'and 3 moved up from index 3 to index 2');

  // Compacting additionally closes the gap, so the array becomes dense.
  const packed = slim({ a }, { dropArrayElements: true, compactArrays: true });
  assert.equal(packed.value.a.length, 2);
  assert.deepEqual(Object.keys(packed.value.a), ['0', '1']);
  assert.equal(packed.value.a[1], 3);
});

test('renumbering dropped elements is unchanged -- the documented behaviour stands', () => {
  // Restated so a future change to the array branch cannot quietly alter it.
  assert.equal(stringify(slim({ i: [0, 1, 0, 2, null] }, { dropArrayElements: true, dropZero: true }).value), '{"i":[1,2]}');
  assert.equal(stringify(slim({ i: [0, null, 1] }).value), '{"i":[0,null,1]}');
  assert.equal(stringify(slim({ i: [0, null, 1] }, { dropArrayElements: true }).value), '{"i":[0,1]}');
  assert.equal(stringify(slim([null, 1, null], { dropArrayElements: true }).value), '[1]');
});

test('--explain pointers stay correct whether or not holes are closed', () => {
  const doc = JSON.parse('{"a":[1,null,2]}');
  for (const compactArrays of [false, true]) {
    const out = slim(doc, { dropArrayElements: true, compactArrays });
    assert.deepEqual(
      out.removals.filter((r) => r.reason === 'array-element').map((r) => r.path),
      ['/a/1'],
      `compactArrays=${compactArrays}`
    );
    assert.equal(out.stats.arrayElements, 1);
    assert.equal(JSON.stringify(out.value), '{"a":[1,2]}', `compactArrays=${compactArrays}`);
  }
});

test('an empty array stays empty in both modes', () => {
  assert.equal(stringify(slim({ a: [], b: [1] }, { compactArrays: true }).value), '{"a":[],"b":[1]}');
  assert.equal(stringify(slim({ a: [], b: [1] }, { compactArrays: false }).value), '{"a":[],"b":[1]}');
});