'use strict';

/**
 * Shared helpers: defaults, type guards, coercion and formatting.
 *
 * @module util
 */

/**
 * Defaults for value pruning. This is the single source of truth: the CLI,
 * the library and the policy factory all read it, so `--explain-policy` can
 * never drift from actual behaviour.
 */
const VALUE_DEFAULTS = Object.freeze({
  dropNull: true,
  dropFalse: false,
  dropZero: false,
  dropEmptyString: false,
  dropEmptyArray: false,
  dropEmptyObject: false,
  dropNaN: false,
  keepIdLike: true,
  keepFlags: true,
  keepKeys: Object.freeze([]),
  keepKeyPattern: null,
  keyFilter: null,
});

/**
 * Package defaults. Every option that changes output has an entry here, so the
 * full behavioural surface is visible in one place.
 */
const DEFAULTS = Object.freeze({
  /** Whitespace only. `stringify` produces the smallest valid JSON. */
  format: 'compact',
  ...VALUE_DEFAULTS,
  /**
   * Remove falsy *elements* from arrays. Off by default: it renumbers the
   * array, so `[0, 1, 0, 2]` becomes `[1, 2]` and every index after the first
   * hole changes meaning.
   */
  dropArrayElements: false,
  /** Re-index arrays after elements were removed, producing dense arrays. */
  compactArrays: false,
  /** Maximum container nesting to walk; guards against stack exhaustion. */
  maxDepth: 512,
  /** Sort object keys on output. Adds bytes, buys deterministic output. */
  sortKeys: false,
  /** Alias kept for callers that pass a nested policy object. */
  valuePolicy: VALUE_DEFAULTS,
});

/**
 * True for plain data objects, excluding arrays, class instances, Dates,
 * RegExps and anything with a null prototype.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Coerce a CLI-style option into a RegExp, or null.
 *
 * @param {RegExp|string|null|undefined} value
 * @returns {RegExp|null}
 */
function toRegExp(value) {
  if (value == null || value === '') return null;
  if (value instanceof RegExp) return value;
  return new RegExp(value);
}

/**
 * Read a boolean-ish CLI argument.
 *
 * @param {*} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  throw new TypeError(`not a boolean: ${value}`);
}

/**
 * Human-readable byte size.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Percentage of size removed, never negative and never NaN.
 *
 * @param {number} before
 * @param {number} after
 * @returns {number}
 */
function savedPercent(before, after) {
  if (before <= 0) return 0;
  const pct = ((before - after) / before) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

module.exports = {
  DEFAULTS,
  isPlainObject,
  toRegExp,
  toBool,
  formatBytes,
  savedPercent,
};