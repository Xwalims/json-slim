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
      const out = [];
      for (let index = 0; index < node.length; index += 1) {
        const item = node[index];
        const childPath = `${path}/${index}`;

        // Array slots are positional: removing one renumbers everything
        // after it, so it is an explicit opt-in (dropArrayElements) rather
        // than something the default null rule reaches for. Decided on the
        // ORIGINAL element, before any pruning shifts indices.
        if (dropArrayElements && policy.shouldDrop(item, '', { inArray: true, allowArrayElement: true })) {
          note(childPath, item, 'array-element');
          continue;
        }

        const res = visit(item, childPath, '', depth + 1, true);
        if (res.kept) out.push(res.value);
      }

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
        if (res.kept) out[k] = res.value;
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
    for (const k of Object.keys(value).sort()) sorted[k] = value[k];
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