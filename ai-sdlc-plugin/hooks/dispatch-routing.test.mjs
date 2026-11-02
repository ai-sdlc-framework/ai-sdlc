// AISDLC-1095: the dispatch module forwards only routings the reconciler reports as new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRoutingLines, tick, newDispatchState } from './hierarchy/dispatch.ts';

const json = (o) => JSON.stringify(o);

test('newRoutingLines returns nothing for empty or non-JSON stdout', () => {
  assert.deepEqual(newRoutingLines(''), []);
  assert.deepEqual(newRoutingLines('route-to-planner in prose'), []);
});

test('newRoutingLines reports acted routings with and without a note', () => {
  const out = json({
    acted: [
      { pr: 7, action: 'route-to-planner', note: 'semantic conflict' },
      { pr: 8, action: 'route-to-planner' },
    ],
  });
  assert.deepEqual(newRoutingLines(out), ['#7 semantic conflict', '#8']);
});

test('newRoutingLines reports a routed entry and ignores unrelated actions', () => {
  assert.deepEqual(
    newRoutingLines(json({ routed: { action: 'route-to-planner', text: 'PR 9 stuck' } })),
    ['PR 9 stuck'],
  );
  assert.deepEqual(newRoutingLines(json({ acted: [{ pr: 1, action: 'rebase' }] })), []);
});

test('newRoutingLines reads the JSON after a leading log line', () => {
  const out = `reconciling...\n${json({ acted: [{ pr: 3, action: 'route-to-planner' }] })}\n`;
  assert.deepEqual(newRoutingLines(out), ['#3']);
});

function ports(reconcileStdout) {
  const sent = [];
  const p = {
    runProcess: async ({ args }) => {
      const sub = args[1];
      if (sub === 'tick') return { exitCode: 0, stdout: json({ blockers: [] }) };
      if (sub === 'reconcile') return { exitCode: 0, stdout: reconcileStdout };
      return { exitCode: 0, stdout: json({ rows: [] }) };
    },
    send: async (a) => void sent.push(a),
    storeSet: async () => {},
    log: async () => {},
    uiOpen: async () => {},
  };
  return { p, sent };
}

test('tick does not message the planner when route-to-planner appears only in prose', async () => {
  const { p, sent } = ports('skipped route-to-planner (already routed)');
  await tick(p, newDispatchState());
  assert.equal(sent.length, 0);
});

test('tick sends the planner exactly one line per new routing', async () => {
  const { p, sent } = ports(json({ acted: [{ pr: 5, action: 'route-to-planner', note: 'x' }] }));
  await tick(p, newDispatchState());
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /#5 x/);
});
