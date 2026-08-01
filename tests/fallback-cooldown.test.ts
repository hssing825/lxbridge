import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePlatformCooldowns,
  recordSourceCooldown,
} from '../src/config/platform-cooldown.ts';
import { selectRunnableFallbackBatch } from '../src/lxserver/fallback-batch.ts';
import { simulateFallbackV22 } from '../src/lxserver/fallback-simulation.ts';

test('legacy global cooldown is removed while active source cooldowns are kept', () => {
  const now = Date.now();
  const result = normalizePlatformCooldowns({
    __global__: { blockedAt: now - 1000, expiresAt: now + 60000 },
    kg: { blockedAt: now - 1000, expiresAt: now + 60000 },
    expired: { blockedAt: now - 60000, expiresAt: now - 1 },
  }, now);

  assert.equal(result.changed, true);
  assert.deepEqual(Object.keys(result.cooldowns), ['kg']);
});

test('blocking multiple sources records only source-level cooldowns', () => {
  const now = Date.now();
  const first = recordSourceCooldown({}, 'kg', now, 15 * 60 * 1000);
  const second = recordSourceCooldown(first, 'tx', now + 100, 15 * 60 * 1000);

  assert.ok(second.kg);
  assert.ok(second.tx);
  assert.equal('__global__' in second, false);
});

test('source cooldowns do not prevent an available third source from running', async () => {
  const usedCandidates = new Set<string>();
  const blockedPlatforms = new Set<string>();
  const batch = [
    { song: { source: 'kg', id: '1' }, quality: '320k' },
    { song: { source: 'tx', id: '2' }, quality: '320k' },
    { song: { source: 'wy', id: '3' }, quality: '320k' },
  ];

  const selected = await selectRunnableFallbackBatch({
    batch,
    maxConcurrent: 2,
    usedCandidates,
    blockedPlatforms,
    getCooldownRemaining: async source => source === 'kg' || source === 'tx' ? 60000 : 0,
  });

  assert.deepEqual(selected.runnable.map(item => item.song.source), ['wy']);
  assert.deepEqual(selected.skippedCooldowns.map(item => item.source), ['kg', 'tx']);
  assert.deepEqual(Array.from(blockedPlatforms), ['kg', 'tx']);
  assert.equal(usedCandidates.has('wy:3:320k'), true);
});

test('legacy global-block simulation now keeps trying other sources', () => {
  const result = simulateFallbackV22('global_block');

  assert.equal(result.success, true);
  assert.equal(result.attempts, 4);
  assert.equal(result.failureReason, undefined);
  assert.ok(result.fallbackSteps.some(step => step.includes('继续下一批')));
  assert.ok(result.fallbackSteps.some(step => step.includes('wy/320k')));
});
