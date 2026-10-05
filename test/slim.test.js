'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { slim, stringify, minify, escapePointer, DepthLimitError } = require('../src/slim.js');
const { DEFAULTS, isPlainObject, toBool, formatBytes, savedPercent } = require('../src/util.js');

test('default policy drops null and nothing else', () => {
  const doc = { a: null, b: 0, c: false, d: '', e: [], f: {}, g: 'x' };
  assert.equal(stringify(slim(doc).value), '{"b":0,"c":false,"d":"","e":[],"f":{},"g":"x"}');
});

test('null at the document root is dropped', () => {
  assert.equal(slim(null).value, null);
  assert.equal(stringify(slim({ only: null }).value), '{}');
});

test('dropFalse removes false but keeps true', () => {
  assert.equal(stringify(slim({ a: false, b: true }, { dropFalse: true }).value), '{"b":true}');
});

test('dropZero removes 0 and -0 but keeps other numbers', () => {
  // Asserted on the value, not on serialised text: JSON has no representation
  // for -0, so `stringify` would hide the difference.
  const out = slim({ z: 0, n: -0, p: 1, f: 0.5 }, { dropZero: true });
  assert.equal(out.value.p, 1);
  assert.equal(out.value.f, 0.5);
  assert.equal('z' in out.value, false);
  assert.equal('n' in out.value, false);
  assert.equal(out.removals.length, 2);
});

test('dropEmptyString removes only the empty string', () => {
  assert.equal(stringify(slim({ a: '', b: ' ' }, { dropEmptyString: true }).value), '{"b":" "}');
});

test('dropNaN removes NaN only when enabled', () => {
  assert.equal(slim({ a: NaN }).removals.length, 0);
  assert.equal(slim({ a: NaN }, { dropNaN: true }).removals.length, 1);
});

test('empty containers survive by default even when empty from birth', () => {
  assert.equal(stringify(slim({ a: [], b: {} }).value), '{"a":[],"b":{}}');
});

test('dropEmptyArray removes an array that is empty from birth', () => {
  assert.equal(stringify(slim({ a: [] }, { dropEmptyArray: true }).value), '{}');
});

test('dropEmptyObject removes an object that is empty from birth', () => {
  assert.equal(stringify(slim({ a: {} }, { dropEmptyObject: true }).value), '{}');
});

test('the empty rules drop already-empty containers, and say so', () => {
  // Regression guard for a documentation lie, not a behaviour change.
  //
  // The CLI usage text, the README table and --explain-policy all used to
  // promise these flags "only drop containers that BECAME empty". They never
  // did: the container is judged after pruning, with no record of whether it
  // was already empty beforehand. So `{"b": {}}` loses `b` even when nothing
  // was pruned. The behaviour is deliberate and pinned by the two tests above;
  // what was wrong was every description of it, so those now describe what
  // happens and this test keeps them honest.
  assert.equal(stringify(slim({ b: {} }, { dropEmptyObject: true }).value), '{}');
  assert.equal(stringify(slim({ b: [] }, { dropEmptyArray: true }).value), '{}');

  // "Already empty" and "emptied here" are genuinely indistinguishable, and
  // both are removed -- pinning that the rule is not conditional on origin.
  assert.equal(
    stringify(slim({ was: {}, now: { a: null } }, { dropEmptyObject: true }).value),
    '{}',
  );

  // Protected names apply even to an empty container, because shouldDrop
  // consults the keep-lists before it looks at the value.
  assert.equal(
    stringify(slim({ id: {} }, { dropEmptyObject: true }).value),
    '{"id":{}}',
  );
  assert.equal(
    stringify(slim({ filters: {}, other: {} },
      { dropEmptyObject: true, keepKeys: ['filters'] }).value),
    '{"filters":{}}',
  );

  // And an empty container in an ARRAY SLOT is still never dropped, in either
  // mode, because removing it would renumber the array.
  assert.equal(
    stringify(slim({ list: [{}, {}] },
      { dropEmptyObject: true, dropEmptyArray: true }).value),
    '{"list":[{},{}]}',
  );
});

test('a container emptied by pruning is dropped too', () => {
  // The whole point: pruning happens before the container is judged. An
  // array slot holding null is protected by default (it is positional), so
  // the array is emptied via dropArrayElements first.
  assert.equal(stringify(slim({ a: [null] }, { dropArrayElements: true, dropEmptyArray: true }).value), '{}');
  assert.equal(stringify(slim({ a: { b: null } }, { dropEmptyObject: true }).value), '{}');
});

test('a container is NOT dropped when only its children were pruned but flags are off', () => {
  assert.equal(stringify(slim({ a: { b: null } }).value), '{"a":{}}');
});

test('a null array slot survives by default and keeps its index', () => {
  // [1, null, 2] and [1, 2] are different documents: dropping the slot
  // would renumber index 2. Object keys do not have this problem, which is
  // exactly why dropNull is on by default for keys and off for slots.
  assert.equal(stringify(slim({ i: [1, null, 2] }).value), '{"i":[1,null,2]}');
});

test('array elements are never treated as droppable containers', () => {
  // `[{}]` is a value, not a gap: dropping it would renumber the array.
  const out = slim({ list: [{}, {}] }, { dropEmptyObject: true, dropEmptyArray: true });
  assert.equal(stringify(out.value), '{"list":[{},{}]}');
});

test('dropArrayElements removes falsy elements and renumbers', () => {
  const out = stringify(slim({ i: [0, 1, 0, 2, null] }, { dropArrayElements: true, dropZero: true }).value);
  assert.equal(out, '{"i":[1,2]}');
});

test('dropArrayElements is off by default', () => {
  assert.equal(stringify(slim({ i: [0, null, 1] }).value), '{"i":[0,null,1]}');
});

test('dropArrayElements is a gate on top of the value rules, not a replacement', () => {
  // With the gate open, only values the policy already calls droppable leave:
  // null does (dropNull is on by default), zero does not (dropZero is off).
  assert.equal(stringify(slim({ i: [0, null, 1] }, { dropArrayElements: true }).value), '{"i":[0,1]}');
  // Opening dropNull for keys does not by itself empty an array.
  assert.equal(stringify(slim({ i: [0, null, 1] }).value), '{"i":[0,null,1]}');
});

test('nested nulls are reported with full pointer paths', () => {
  const out = slim({ a: { b: { c: null } } });
  assert.equal(out.removals.length, 1);
  assert.equal(out.removals[0].path, '/a/b/c');
  assert.equal(out.removals[0].reason, 'null');
});

test('pointer keys are escaped per RFC 6901', () => {
  const out = slim({ 'a/b': null, 'c~d': null });
  const paths = out.removals.map((r) => r.path).sort();
  assert.deepEqual(paths, ['/a~1b', '/c~0d']);
});

test('escapePointer handles the documented characters', () => {
  assert.equal(escapePointer('a/b'), 'a~1b');
  assert.equal(escapePointer('a~b'), 'a~0b');
  assert.equal(escapePointer('plain'), 'plain');
});

test('slim does not mutate its input', () => {
  const input = { a: { b: null }, list: [1, 2] };
  const snapshot = JSON.stringify(input);
  slim(input, { dropArrayElements: true, dropEmptyObject: true });
  assert.equal(JSON.stringify(input), snapshot);
});

test('slim returns fresh containers, not shared references', () => {
  const inner = { keep: 1 };
  const out = slim({ inner });
  assert.notEqual(out.value.inner, inner);
  assert.deepEqual(out.value.inner, inner);
});

test('stats counters add up to the removal list', () => {
  const out = slim({ a: null, b: 0, c: '', d: false }, { dropZero: true, dropEmptyString: true, dropFalse: true });
  assert.equal(out.stats.total, out.removals.length);
  assert.equal(out.stats.nulls, 1);
  assert.equal(out.stats.falsy, 1);
  assert.equal(out.stats.other, 2);
});

test('each removal is reported exactly once', () => {
  const out = slim({ tags: [], meta: {} }, { dropEmptyArray: true, dropEmptyObject: true });
  assert.equal(out.removals.length, 2);
  const paths = out.removals.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length);
});

test('deep nesting beyond maxDepth throws DepthLimitError', () => {
  let doc = {};
  const root = doc;
  for (let i = 0; i < 40; i += 1) {
    doc.next = {};
    doc = doc.next;
  }
  assert.throws(() => slim(root, { maxDepth: 10 }), DepthLimitError);
});

test('nesting within maxDepth is fine', () => {
  assert.doesNotThrow(() => slim({ a: { b: { c: 1 } } }, { maxDepth: 10 }));
});

test('stringify compact has no whitespace', () => {
  assert.equal(stringify({ a: 1, b: [1, 2] }, { format: 'compact' }), '{"a":1,"b":[1,2]}');
});

test('stringify pretty uses the requested indent', () => {
  assert.equal(stringify({ a: 1 }, { format: 'pretty', indent: 4 }), '{\n    "a": 1\n}');
});

test('stringify can sort keys deterministically', () => {
  const a = stringify({ b: 1, a: 2, c: 3 }, { sortKeys: true });
  const b = stringify({ c: 3, a: 2, b: 1 }, { sortKeys: true });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test('minify removes whitespace without touching values', () => {
  const out = minify('{ "a" : 1 , "b" : [ 1 , 2 ] , "z" : 0 }');
  assert.equal(out, '{"a":1,"b":[1,2],"z":0}');
});

test('minify leaves empty containers alone', () => {
  assert.equal(minify('{"a":[],"b":{},"c":null}'), '{"a":[],"b":{},"c":null}');
});

test('scalars pass through unchanged', () => {
  assert.equal(slim(42).value, 42);
  assert.equal(slim('text').value, 'text');
  assert.equal(slim(true).value, true);
});

test('arrays at the root are walked', () => {
  // Root-level array: its slots are positional too, so null survives unless
  // dropArrayElements says otherwise.
  assert.equal(stringify(slim([null, 1, null]).value), '[null,1,null]');
  assert.equal(stringify(slim([null, 1, null], { dropArrayElements: true }).value), '[1]');
});

test('keepIdLike protects id-like keys from every rule', () => {
  const doc = { id: null, uuid: '', _id: 0, version: false, etag: '' };
  const out = slim(doc, { dropFalse: true, dropZero: true, dropEmptyString: true });
  assert.equal(out.removals.length, 0);
});

test('keepFlags protects is_/has_/can_ style keys', () => {
  const out = slim({ is_admin: false, has_key: '', can_edit: 0 }, { dropFalse: true, dropEmptyString: true, dropZero: true });
  assert.equal(out.removals.length, 0);
});

test('keepIdLike can be turned off', () => {
  const out = slim({ id: null }, { keepIdLike: false });
  assert.equal(out.removals.length, 1);
});

test('keepFlags can be turned off', () => {
  const out = slim({ is_admin: false }, { keepFlags: false, dropFalse: true });
  assert.equal(out.removals.length, 1);
});

test('keepKeys protects extra key names', () => {
  const out = slim({ retries: 0, timeout: 0 }, { keepKeys: ['retries'], dropZero: true });
  assert.equal(stringify(out.value), '{"retries":0}');
});

test('keepKeyPattern protects matching keys', () => {
  const out = slim({ user_email: null, note: null }, { keepKeyPattern: '^user_' });
  assert.equal(stringify(out.value), '{"user_email":null}');
});

test('keepKeyPattern accepts a RegExp as well as a string', () => {
  const out = slim({ a_x: null }, { keepKeyPattern: /^a_/ });
  assert.equal(stringify(out.value), '{"a_x":null}');
});

test('keyFilter restricts pruning to matching keys', () => {
  const out = slim({ tmp_a: null, tmp_b: null, keep: null }, { keyFilter: '^tmp_' });
  assert.equal(stringify(out.value), '{"keep":null}');
});

test('keyFilter restricts pruning to matching keys, arrays included', () => {
  // keyFilter guards by key name; array slots have no key, so the filter
  // does not apply to them -- and null slots are positional anyway.
  const out = slim({ list: [null, null] }, { keyFilter: '^nope$' });
  assert.equal(stringify(out.value), '{"list":[null,null]}');
});

test('DEFAULTS advertises null-only pruning', () => {
  assert.equal(DEFAULTS.dropNull, true);
  assert.equal(DEFAULTS.dropFalse, false);
  assert.equal(DEFAULTS.dropZero, false);
  assert.equal(DEFAULTS.dropArrayElements, false);
  assert.equal(DEFAULTS.keepIdLike, true);
});

test('isPlainObject distinguishes data objects from other objects', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(/x/), false);
});

test('toBool accepts the usual CLI spellings', () => {
  assert.equal(toBool('true'), true);
  assert.equal(toBool('YES'), true);
  assert.equal(toBool('on'), true);
  assert.equal(toBool('0'), false);
  assert.equal(toBool('off'), false);
  assert.equal(toBool(undefined, true), true);
  assert.throws(() => toBool('maybe'), TypeError);
});

test('formatBytes is readable across magnitudes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MiB');
});

test('savedPercent never goes negative or above 100', () => {
  assert.equal(savedPercent(100, 50), 50);
  assert.equal(savedPercent(100, 150), 0);
  assert.equal(savedPercent(0, 10), 0);
});

test('a large realistic document shrinks measurably', () => {
  const doc = {
    id: 'x1',
    retries: 0,
    cached: false,
    label: '',
    tags: [],
    meta: {},
    missing: null,
    count: 12,
    name: 'kept',
    flags: { debug: false, verbose: false },
  };
  const before = Buffer.byteLength(JSON.stringify(doc));
  const out = slim(doc, { dropFalse: true, dropZero: true, dropEmptyArray: true, dropEmptyObject: true });
  const after = Buffer.byteLength(JSON.stringify(out.value));
  assert.ok(after < before, `${after} should be < ${before}`);
  assert.equal(out.value.count, 12);
  assert.equal(out.value.name, 'kept');
  assert.equal(out.value.id, 'x1');
});