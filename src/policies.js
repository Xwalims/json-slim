'use strict';

/**
 * Value policies: decides whether a value is "redundant" and may be dropped.
 *
 * The central design rule of this package: removing a value is a *semantic*
 * edit, not a formatting one. `{"retries": 0}` and `{}` mean different things
 * to every consumer, so which value classes may be pruned is never guessed --
 * it is an explicit, inspectable policy object.
 *
 * @module policies
 */

const { DEFAULTS, isPlainObject, toRegExp } = require('./util.js');

/** Names treated as identifier-like, whose emptiness is usually meaningful. */
const DEFAULT_KEEP_KEYS = Object.freeze([
  'id',
  '_id',
  'uuid',
  'guid',
  'key',
  'pk',
  'slug',
  'hash',
  'checksum',
  'version',
  'rev',
  'etag',
]);

/** Names treated as permission- or flag-like, where `false` is real data. */
const DEFAULT_KEEP_KEY_PATTERN = /^(is|has|can|should|allow|enable|require)[_A-Z]/;

/**
 * Build a value policy from options.
 *
 * The default policy drops `null` only. Every other value class is opt-in,
 * because each one can carry meaning that the caller cares about.
 *
 * @param {object} [options]
 * @param {boolean} [options.dropNull=true] drop `null` values.
 * @param {boolean} [options.dropFalse=false] drop `false` booleans.
 * @param {boolean} [options.dropZero=false] drop numeric zero (`0` and `-0`).
 * @param {boolean} [options.dropEmptyString=false] drop `''`.
 * @param {boolean} [options.dropEmptyArray=false] drop arrays that became empty.
 * @param {boolean} [options.dropEmptyObject=false] drop objects that became empty.
 * @param {boolean} [options.keepIdLike=true] never drop these keys, whatever
 *   their value. An empty `id` is usually a bug signal, not redundancy.
 * @param {boolean} [options.keepFlags=true] never drop `is_*`/`has_*`/`can_*`
 *   style keys, where `false` is the meaningful answer.
 * @param {string[]} [options.keepKeys] extra key names to protect.
 * @param {RegExp|string} [options.keepKeyPattern] extra key pattern to protect.
 * @param {boolean} [options.dropNaN=false] drop `NaN` numbers.
 * @returns {object} frozen policy with a `shouldDrop` predicate.
 */
function createValuePolicy(options = {}) {
  const opts = { ...DEFAULTS.valuePolicy, ...options };

  const keepNames = new Set([...DEFAULT_KEEP_KEYS, ...(opts.keepKeys || [])]);
  const keepPattern = toRegExp(opts.keepKeyPattern);
  const flagPattern = toRegExp(DEFAULT_KEEP_KEY_PATTERN);
  const keyFilter = toRegExp(opts.keyFilter);

  /**
   * @param {*} value the value under consideration.
   * @param {string} key the object key holding it ('' for array elements).
   * @param {{inArray?: boolean, allowArrayElement?: boolean}} [ctx]
   *   `inArray` means "this is an array element", which is a positional slot;
   *   `allowArrayElement` is the opt-in that permits removing such slots.
   * @returns {boolean} true when the value may be removed.
   */
  function shouldDrop(value, key, ctx = {}) {
    if (keyFilter && key !== '' && !keyFilter.test(key)) return false;

    if (opts.keepIdLike && keepNames.has(key)) return false;
    if (opts.keepFlags && flagPattern.test(key)) return false;
    if (keepPattern && key !== '' && keepPattern.test(key)) return false;

    // Inside an array every slot is *positional*: [1, null, 2] and [1, 2]
    // address different things, and dropping a slot renumbers everything
    // after it. Object keys are different -- a null key and an absent key
    // are interchangeable, which is why dropNull can be on by default there.
    // Array slots therefore need the explicit opt-in, tracked by ctx.
    const positional = ctx.inArray === true && ctx.allowArrayElement !== true;

    if (value === null) return opts.dropNull !== false && !positional;
    if (value === false) return Boolean(opts.dropFalse) && !positional;
    if (value === '') return Boolean(opts.dropEmptyString) && !positional;
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return Boolean(opts.dropNaN) && !positional;
      if (Object.is(value, -0) || value === 0) return Boolean(opts.dropZero) && !positional;
      return false;
    }
    // Empty containers are only droppable when their class is enabled, and
    // never for an array element: `[{}]` is a value, not a gap.
    if (Array.isArray(value)) {
      return !ctx.inArray && value.length === 0 && Boolean(opts.dropEmptyArray);
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      return keys.length === 0 && !ctx.inArray && Boolean(opts.dropEmptyObject);
    }
    return false;
  }

  return Object.freeze({
    shouldDrop,
    keepNames,
    keepPattern: keepPattern || null,
    flagPattern,
    keyFilter,
    options: Object.freeze({ ...opts }),
  });
}

/**
 * Describe a policy as a plain object, for `--explain` output.
 *
 * @param {object} policy as returned by {@link createValuePolicy}.
 * @returns {object[]} one row per value class.
 */
function describePolicy(policy) {
  const o = policy.options;
  const rows = [
    ['null', o.dropNull !== false, 'dropped by default: absence and explicit null are interchangeable in practice'],
    ['false', Boolean(o.dropFalse), 'opt-in: false is a real answer for flags and permissions'],
    ['0', Boolean(o.dropZero), 'opt-in: zero is a real count, offset or state'],
    ['""', Boolean(o.dropEmptyString), 'opt-in: empty string may be a deliberate value'],
    ['[]', Boolean(o.dropEmptyArray), 'opt-in: only drops containers that became empty'],
    ['{}', Boolean(o.dropEmptyObject), 'opt-in: only drops objects that became empty'],
    ['NaN', Boolean(o.dropNaN), 'opt-in: NaN is not valid JSON and may be a data bug'],
  ];
  return rows.map(([value, enabled, why]) => ({ value, enabled, why }));
}

module.exports = {
  createValuePolicy,
  describePolicy,
  DEFAULT_KEEP_KEYS,
  DEFAULT_KEEP_KEY_PATTERN,
};