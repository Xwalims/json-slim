#!/usr/bin/env node
'use strict';

/**
 * Thin executable wrapper. All logic lives in ../src/cli.js.
 *
 * The exit code from `main` must be propagated explicitly: dropping it here
 * makes every failure path look like success to the shell.
 */

process.exitCode = require('../src/cli.js').main(process.argv.slice(2));