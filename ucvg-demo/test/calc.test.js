'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { add, subtract } = require('../src/calc.js');

test('add returns the sum of two numbers', () => {
  assert.strictEqual(add(2, 3), 5);
  assert.strictEqual(add(-1, 1), 0);
});

test('subtract returns the difference of two numbers', () => {
  assert.strictEqual(subtract(5, 3), 2);
  assert.strictEqual(subtract(0, 4), -4);
});
