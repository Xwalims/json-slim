'use strict';

/**
 * `json-slim`: shrink JSON documents without silently destroying meaning.
 *
 * @example
 * const { slim } = require('json-slim');
 * slim({ a: 1, b: null, c: { retries: 0 } });
 * // -> value: { a: 1, c: { retries: 0 } }
 *
 * @module json-slim
 */

const { slim, minify, stringify, sortReplacer, escapePointer, DepthLimitError } = require('./slim.js');
const { createValuePolicy, describePolicy, DEFAULT_KEEP_KEYS, DEFAULT_KEEP_KEY_PATTERN } = require('./policies.js');
const { DEFAULTS, isPlainObject, formatBytes, savedPercent } = require('./util.js');

module.exports = {
  // core
  slim,
  minify,
  stringify,
  // policy
  createValuePolicy,
  describePolicy,
  DEFAULT_KEEP_KEYS,
  DEFAULT_KEEP_KEY_PATTERN,
  // helpers
  sortReplacer,
  escapePointer,
  formatBytes,
  savedPercent,
  isPlainObject,
  DEFAULTS,
  // errors
  DepthLimitError,
};