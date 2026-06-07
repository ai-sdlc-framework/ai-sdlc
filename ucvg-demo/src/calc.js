'use strict';

/**
 * Tiny pure-function module exercised by the UCVG demo differential test.
 * Zero dependencies so the sandbox can run `node --test` fully offline.
 */

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

module.exports = { add, subtract };
