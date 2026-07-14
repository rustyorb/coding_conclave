import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshScheduler } from '../public/refresh-scheduler.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('event bursts trigger a refresh without postponing it until the burst stops', async () => {
  let refreshes = 0;
  const scheduler = createRefreshScheduler(async () => { refreshes += 1; }, { delay: 10 });

  scheduler.schedule();
  await wait(4);
  scheduler.schedule();
  await wait(4);
  scheduler.schedule();
  await wait(8);

  assert.equal(refreshes, 1);
  scheduler.cancel();
});

test('an event received during a refresh schedules one follow-up refresh', async () => {
  let release;
  let refreshes = 0;
  const firstRefresh = new Promise((resolve) => { release = resolve; });
  const scheduler = createRefreshScheduler(async () => {
    refreshes += 1;
    if (refreshes === 1) await firstRefresh;
  }, { delay: 5 });

  scheduler.schedule();
  await wait(8);
  scheduler.schedule();
  scheduler.schedule();
  release();
  await wait(12);

  assert.equal(refreshes, 2);
  scheduler.cancel();
});
