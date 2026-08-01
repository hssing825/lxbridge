import assert from 'node:assert/strict';
import test from 'node:test';
import { FailureClassifier } from '../src/lxserver/failure-classification.ts';

test('only explicit block-ip text enters platform cooldown', () => {
  const blocked = FailureClassifier.classify('upstream returned block ip', 500);
  assert.equal(blocked.category, 'platform_block');
  assert.equal(blocked.action, 'cooldown');
  assert.equal(blocked.isHighConfidence, true);

  const blockedIp = FailureClassifier.classify('blocked ip', 500);
  assert.equal(blockedIp.category, 'platform_block');
  assert.equal(blockedIp.action, 'cooldown');

  const ipBlocked = FailureClassifier.classify('ip blocked', 500);
  assert.equal(ipBlocked.category, 'platform_block');
  assert.equal(ipBlocked.action, 'cooldown');

  const ipIsBlocked = FailureClassifier.classify('ip is blocked', 500);
  assert.equal(ipIsBlocked.category, 'platform_block');
  assert.equal(ipIsBlocked.action, 'cooldown');

  const nounIpBlock = FailureClassifier.classify('IP Block 198.51.100.0/24', 500);
  assert.notEqual(nounIpBlock.category, 'platform_block');
  assert.equal(nounIpBlock.action, 'record');

  const genericServerError = FailureClassifier.classify('internal server error', 500);
  assert.equal(genericServerError.category, 'unknown');
  assert.equal(genericServerError.action, 'record');

  const genericForbidden = FailureClassifier.classify('forbidden', 403);
  assert.equal(genericForbidden.category, 'unknown');
  assert.equal(genericForbidden.action, 'record');
});

test('explicit authentication and required configuration failures stop fallback', () => {
  const unauthorized = FailureClassifier.classify('request rejected', 401);
  assert.equal(unauthorized.category, 'auth_config');
  assert.equal(unauthorized.action, 'stop');
  assert.equal(unauthorized.shouldStop, true);

  const expired = FailureClassifier.classify('token expired', 403);
  assert.equal(expired.category, 'auth_config');
  assert.equal(expired.action, 'stop');

  const wrappedExpired = FailureClassifier.classify('{"success":false,"message":"token expired"}', 200);
  assert.equal(wrappedExpired.category, 'auth_config');
  assert.equal(wrappedExpired.action, 'stop');

  const missingHost = FailureClassifier.classify('LXServer 地址未配置');
  assert.equal(missingHost.category, 'auth_config');
  assert.equal(missingHost.action, 'stop');
});

test('generic forbidden or upstream unauthorized text must not stop parsing', () => {
  const unauthorizedBody = FailureClassifier.classify('unauthorized', 403);
  assert.notEqual(unauthorizedBody.category, 'auth_config');
  assert.equal(unauthorizedBody.action, 'record');
  assert.equal(unauthorizedBody.shouldStop, false);

  const upstreamUnauthorized = FailureClassifier.classify('{"success":false,"message":"unauthorized"}', 500);
  assert.equal(upstreamUnauthorized.action, 'record');
  assert.equal(upstreamUnauthorized.shouldStop, false);

  const http401StillStops = FailureClassifier.classify('request rejected', 401);
  assert.equal(http401StillStops.category, 'auth_config');
  assert.equal(http401StillStops.action, 'stop');
});

test('invalid URLs skip only the current candidate', () => {
  const explicit = FailureClassifier.classify('abnormal url');
  assert.equal(explicit.category, 'invalid_url');
  assert.equal(explicit.action, 'skip');
  assert.equal(explicit.shouldStop, false);

  const hinted = FailureClassifier.classify('', 0, 'invalid_url');
  assert.equal(hinted.category, 'invalid_url');
  assert.equal(hinted.action, 'skip');

  const genericBadRequest = FailureClassifier.classify('bad request', 400);
  assert.equal(genericBadRequest.category, 'unknown');
});

test('timeout, network and no-result failures are record-only', () => {
  const timeout = FailureClassifier.classify('timed out while waiting');
  assert.equal(timeout.category, 'timeout');
  assert.equal(timeout.action, 'record');
  assert.equal(timeout.isHighConfidence, false);

  const network = FailureClassifier.classify('fetch failed: connection refused');
  assert.equal(network.category, 'network');
  assert.equal(network.action, 'record');
  assert.equal(network.isHighConfidence, false);

  const noResult = FailureClassifier.classify('候选均不可用');
  assert.equal(noResult.category, 'no_result');
  assert.equal(noResult.action, 'record');
});

test('ambiguous text remains unknown and never changes flow', () => {
  const classification = FailureClassifier.classify('an error happened');
  assert.equal(classification.category, 'unknown');
  assert.equal(classification.action, 'record');
  assert.equal(classification.isHighConfidence, false);
  assert.equal(classification.shouldStop, false);
});

test('safe results contain classification metadata but no original failure text', () => {
  const original = FailureClassifier.classify('token expired: secret-value', 403);
  const safe = FailureClassifier.buildSafeClassificationResult(original);
  const serialized = JSON.stringify(safe);

  assert.equal(safe.category, 'auth_config');
  assert.equal(safe.failureReason, '认证或必要配置错误');
  assert.doesNotMatch(serialized, /secret-value|token expired/i);
  assert.equal('originalFailureText' in safe, false);
});
