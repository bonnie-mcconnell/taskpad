import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDropOrdering,
  moveWithinPriority,
  orderValue,
  renormalizePriority,
  sortedUndoneInPriority,
} from '../src/app/ordering-core.mjs';

function makeTasks() {
  return [
    { id: 1, text: 'A', priority: 'must', done: false, createdAt: 1, order: 100 },
    { id: 2, text: 'B', priority: 'must', done: false, createdAt: 2, order: 200 },
    { id: 3, text: 'C', priority: 'must', done: false, createdAt: 3, order: 300 },
    { id: 4, text: 'D', priority: 'should', done: false, createdAt: 4, order: 100 },
    { id: 5, text: 'E', priority: 'must', done: true, createdAt: 5, order: 400 },
  ];
}

test('orderValue uses order first, createdAt fallback', () => {
  assert.equal(orderValue({ order: 50, createdAt: 10 }), 50);
  assert.equal(orderValue({ createdAt: 10 }), 10);
});

test('sortedUndoneInPriority excludes done and optional id', () => {
  const tasks = makeTasks();
  const all = sortedUndoneInPriority(tasks, 'must').map(t => t.id);
  assert.deepEqual(all, [1, 2, 3]);

  const excluded = sortedUndoneInPriority(tasks, 'must', 2).map(t => t.id);
  assert.deepEqual(excluded, [1, 3]);
});

test('moveWithinPriority swaps order with adjacent task', () => {
  const tasks = makeTasks();
  const result = moveWithinPriority(tasks, 2, -1);
  assert.equal(result.moved, true);

  const ordered = sortedUndoneInPriority(tasks, 'must').map(t => t.id);
  assert.deepEqual(ordered, [2, 1, 3]);
});

test('moveWithinPriority rejects boundary moves', () => {
  const tasks = makeTasks();
  const result = moveWithinPriority(tasks, 1, -1);
  assert.equal(result.moved, false);
});

test('applyDropOrdering inserts before target in same priority', () => {
  const tasks = makeTasks();
  const result = applyDropOrdering(tasks, 'must', 3, 1, null);
  assert.equal(result.moved, true);

  const ordered = sortedUndoneInPriority(tasks, 'must').map(t => t.id);
  assert.deepEqual(ordered, [3, 1, 2]);
});

test('applyDropOrdering moves task across priority and appends when no refs', () => {
  const tasks = makeTasks();
  const result = applyDropOrdering(tasks, 'should', 1, null, null);
  assert.equal(result.moved, true);
  assert.equal(result.oldPriority, 'must');
  assert.equal(result.newPriority, 'should');

  const shouldIds = sortedUndoneInPriority(tasks, 'should').map(t => t.id);
  assert.deepEqual(shouldIds, [4, 1]);
});

test('applyDropOrdering falls back to append if stale ref ids are provided', () => {
  const tasks = makeTasks();
  applyDropOrdering(tasks, 'must', 1, 999, null);
  const ordered = sortedUndoneInPriority(tasks, 'must').map(t => t.id);
  assert.deepEqual(ordered, [2, 3, 1]);
});

test('renormalizePriority compacts tiny order gaps', () => {
  const tasks = [
    { id: 1, text: 'A', priority: 'must', done: false, createdAt: 1, order: 1 },
    { id: 2, text: 'B', priority: 'must', done: false, createdAt: 2, order: 1.001 },
    { id: 3, text: 'C', priority: 'must', done: false, createdAt: 3, order: 1.002 },
  ];

  const changed = renormalizePriority(tasks, 'must');
  assert.equal(changed, true);
  assert.deepEqual(tasks.map(t => t.order), [100, 200, 300]);
});
