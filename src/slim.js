'use strict';

/**
 * Document walker: applies a value policy to a JSON document and reports
 * exactly what was removed.
 *
 * The walker is non-mutating. The input is deep-copied into fresh containers,
 * so a caller can keep using its original object after slimming.
 *
 * @module slim
 */

const { createValuePolicy } = require('./policies.js');
const { DEFAULTS, isPlainObject } = require('./util.js');

/**
 * The one key name that `out[key] = value` cannot write.
 *
 * `__proto__` is not a property of the prototype; it is an ACCESSOR defined on
 * `Object.prototype`. Assigning to it runs the setter, which REPLACES THE
 * PROTOTYPE of the container instead of creating an own key:
 *
 *   const o = {};
 *   o.__proto__ = { polluted: true };   // setter ran; no own property created
 *   Object.keys(o);                     // []
 *   JSON.stringify(o);                  // {}
 *
 * The key is not "stored but hidden" -- it is gone. Nothing downstream can see
 * it: `hasOwnProperty` says no, `Object.entries` skips it, and no removal is
 * reported because the walker never dropped anything. A document containing
 * `{"__proto__":{...},"a":1}` therefore went through slimming and came out with
 * the payload silently deleted AND the rebuilt object's prototype swapped for
 * the payload. `JSON.parse` creates a real own data property for exactly the
 * same bytes, which is the behaviour we owe the caller.
 *
 * `constructor`, `toString`, `valueOf` and `hasOwnProperty` need nothing
 * special: those are ordinary data properties on `Object.prototype`, so plain
 * assignment creates an own property that shadows the inherited one, exactly as
 * `JSON.parse` does.
 */
function setKey(target, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return target;
  }
  target[key] = value;
  return target;
}

/**
 * Raised when the document nests deeper than `maxDepth`.
 */
class DepthLimitError extends RangeError {
  constructor(maxDepth) {
    super(`document nests deeper than maxDepth=${maxDepth}`);
    this.name = 'DepthLimitError';
    this.maxDepth = maxDepth;
  }
}

/**
 * Slim a JSON document.
 *
 * @param {*} document any JSON value.
 * @param {object} [options] see `DEFAULTS` in ./util.js; policy options are
 *   forwarded to {@link createValuePolicy}.
 * @returns {{value: *, removals: Array<object>, stats: object}}
 */
function slim(document, options = {}) {
  const policy = createValuePolicy(options);
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : DEFAULTS.maxDepth;
  const dropArrayElements = options.dropArrayElements ?? DEFAULTS.dropArrayElements;
  // Read the flag that was previously declared in DEFAULTS, listed in --help and
  // documented in the README, but never consulted here -- so `--compact-arrays`
  // was a no-op that behaved exactly like its own default.
  const compactArrays = options.compactArrays ?? DEFAULTS.compactArrays;

  const removals = [];
  const state = { nulls: 0, falsy: 0, emptyContainers: 0, arrayElements: 0, other: 0 };

  /**
   * Record one removal and bump its counter. Every removal goes through here
   * exactly once: the node that is dropped reports itself, never its parent.
   *
   * @param {string} path
   * @param {*} value
   * @param {string} reason
   */
  function note(path, value, reason) {
    removals.push({ path, reason, value: describe(value) });
    if (reason === 'null') state.nulls += 1;
    else if (reason === 'zero' || reason === 'nan') state.falsy += 1;
    else if (reason === 'empty-array' || reason === 'empty-object') state.emptyContainers += 1;
    else if (reason === 'array-element') state.arrayElements += 1;
    else state.other += 1;
  }

  /**
   * @param {*} node current value.
   * @param {string} path JSON Pointer of the current value.
   * @param {string} key owning key ('' for array elements).
   * @param {number} depth
   * @param {boolean} inArray
   * @returns {{kept: boolean, value: *}}
   */
  function visit(node, path, key, depth, inArray) {
    if (depth > maxDepth) throw new DepthLimitError(maxDepth);

    // The document root is the one node that is never pruned: without this,
    // `slim({a:{}}, {dropEmptyObject:true})` would drop the entire document
    // once its only key disappeared, and `slim(0, {dropZero:true})` would
    // turn a scalar document into `null`.
    const prunable = depth > 0;

    // Containers are rebuilt first and judged afterwards: one that started
    // non-empty but became empty is a *result* of pruning, and judging it
    // before the walk would leave dropEmptyArray/dropEmptyObject dead code.
    if (Array.isArray(node)) {
      // Positions, not just values.
      //
      // The output is written BY INDEX, never pushed, because the two decisions
      // this flag expresses both need the index to survive the walk:
      //
      //   default -- a gap the INPUT already had stays a gap. `[1, , 3]` used to
      //     come back as `[1, 3]`: reading index 1 of a holey array yields
      //     `undefined`, `push` copied that `undefined` forward, and the array
      //     was silently densified. The document said index 2 held 3 and the
      //     output says index 1 holds 3 -- positional information destroyed by
      //     an operation that promises to preserve meaning. `JSON.stringify`
      //     renders the hole as `null`, which is what every other JSON
      //     implementation does with it.
      //
      //   --compact-arrays -- close those gaps, i.e. renumber onto a dense array.
      //     This is the opt-in, because renumbering is a real edit: it changes
      //     what every index after a gap means.
      //
      // Elements REMOVED by the policy are renumbered away in both modes, which
      // is the long-documented behaviour of --drop-array-elements ("renumbers
      // the array") and is pinned by the existing suite.
      const out = [];
      // Counters, because the output length is what makes a gap observable and it
      // cannot be read off a cursor: a trailing gap produces no assignment at
      // all, so a cursor would report an array too short to contain it.
      //   gaps      -- input gaps (default keeps them, --compact-arrays closes them)
      //   closed    -- positions that vanished: a removed element, or a child the
      //                walker dropped. These renumber in BOTH modes, which is the
      //                documented behaviour of --drop-array-elements.
      let write = 0;
      let gaps = 0;
      let closed = 0;

      for (let index = 0; index < node.length; index += 1) {
        // `index in node` is the only honest test for a gap. A stored
        // `undefined` VALUE is not a gap and must never be treated as one.
        if (!(index in node)) {
          gaps += 1;
          // Compacting closes the gap: the next element moves up into it.
          if (compactArrays) continue;
          // Preserving it leaves a hole behind at this exact position, and the
          // cursor advances past it so every later element keeps its index.
          write += 1;
          continue;
        }

        const item = node[index];
        const childPath = `${path}/${index}`;

        // Array slots are positional: removing one renumbers everything
        // after it, so it is an explicit opt-in (dropArrayElements) rather
        // than something the default null rule reaches for. Decided on the
        // ORIGINAL element, before any pruning shifts indices.
        if (dropArrayElements && policy.shouldDrop(item, '', { inArray: true, allowArrayElement: true })) {
          note(childPath, item, 'array-element');
          closed += 1;
          continue; // the slot closes up: this is the documented renumbering
        }

        const res = visit(item, childPath, '', depth + 1, true);
        if (!res.kept) {
          closed += 1;
          continue;
        }
        out[write] = res.value;
        write += 1;
      }

      // Every input position is accounted for exactly once: it was written, it
      // was a gap, or it closed. So the length is what is left over.
      out.length = compactArrays ? node.length - gaps - closed : node.length - closed;

      if (prunable && !inArray && policy.shouldDrop(out, key, { inArray: false })) {
        note(path, out, 'empty-array');
        return { kept: false, value: undefined };
      }
      return { kept: true, value: out };
    }

    if (isPlainObject(node)) {
      const out = {};
      for (const k of Object.keys(node)) {
        const res = visit(node[k], `${path}/${escapePointer(k)}`, k, depth + 1, false);
        // setKey, not `out[k] =`: for the one accessor name on Object.prototype
        // plain assignment runs the setter and destroys the key (see above).
        if (res.kept) setKey(out, k, res.value);
      }

      if (prunable && !inArray && policy.shouldDrop(out, key, { inArray: false })) {
        note(path, out, 'empty-object');
        return { kept: false, value: undefined };
      }
      return { kept: true, value: out };
    }

    if (policy.shouldDrop(node, key, { inArray })) {
      note(path, node, classify(node));
      return { kept: false, value: undefined };
    }
    return { kept: true, value: node };
  }

  const result = visit(document, '', '', 0, false);
  const value = result.kept ? result.value : null;

  return {
    value,
    removals,
    stats: { ...state, total: removals.length },
  };
}

/**
 * Compact bytes without changing meaning: parse, prune whitespace, re-emit.
 *
 * This is the "safe" compression -- it never touches values.
 *
 * @param {string} text
 * @param {object} [options]
 * @returns {string}
 */
function minify(text, options = {}) {
  const doc = JSON.parse(text);
  return stringify(doc, { ...options, sortKeys: options.sortKeys ?? false });
}

/**
 * Serialise a value to JSON with the requested layout.
 *
 * @param {*} value
 * @param {object} [options] `format`: 'compact'|'pretty'; `indent`: number;
 *   `sortKeys`: boolean.
 * @returns {string}
 */
function stringify(value, options = {}) {
  const format = options.format ?? DEFAULTS.format;
  const indent = Number.isInteger(options.indent) ? options.indent : 2;
  const replacer = options.sortKeys ? sortReplacer : undefined;
  return JSON.stringify(value, replacer, format === 'pretty' ? indent : 0);
}

/**
 * JSON.stringify replacer that emits object keys in sorted order.
 *
 * @param {string} key
 * @param {*} value
 * @returns {*}
 */
function sortReplacer(key, value) {
  if (isPlainObject(value)) {
    const sorted = {};
    // setKey again: this replacer rebuilds EVERY object in the document, so it
    // was losing `__proto__` on a second, independent path from the walker.
    for (const k of Object.keys(value).sort()) setKey(sorted, k, value[k]);
    return sorted;
  }
  return value;
}

/**
 * RFC 6901 pointer escaping.
 *
 * @param {string} key
 * @returns {string}
 */
function escapePointer(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Classify a scalar value for the removal report.
 *
 * @param {*} value
 * @returns {string}
 */
function classify(value) {
  if (value === null) return 'null';
  if (value === false) return 'false';
  if (value === '') return 'empty-string';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === 0) return 'zero';
  }
  return 'value';
}

/**
 * Short, JSON-safe rendering of a removed value.
 *
 * @param {*} value
 * @returns {*}
 */
function describe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

module.exports = {
  slim,
  minify,
  stringify,
  sortReplacer,
  escapePointer,
  DepthLimitError,
};