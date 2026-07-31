import assert from 'node:assert/strict';
import test from 'node:test';
import * as customSources from '../src/lxserver/custom-sources.ts';

test('exports only the response extraction helper', () => {
  assert.deepEqual(Object.keys(customSources), ['extractCustomSources']);
});

test('extracts supported response wrappers', () => {
  assert.deepEqual(customSources.extractCustomSources([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(customSources.extractCustomSources({ data: [{ id: 'b' }] }), [{ id: 'b' }]);
  assert.deepEqual(customSources.extractCustomSources({ list: [{ id: 'c' }] }), [{ id: 'c' }]);
});

test('extracts the first array from an alternate response wrapper', () => {
  assert.deepEqual(
    customSources.extractCustomSources({ success: true, sources: [{ id: 'd' }] }),
    [{ id: 'd' }],
  );
});

test('returns an empty list for invalid responses', () => {
  assert.deepEqual(customSources.extractCustomSources(null), []);
  assert.deepEqual(customSources.extractCustomSources({ data: null }), []);
  assert.deepEqual(customSources.extractCustomSources('invalid'), []);
});
