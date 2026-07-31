import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const apiScript = readFileSync(new URL('../static/js/api.js', import.meta.url), 'utf8');
const appScript = readFileSync(new URL('../static/js/app.js', import.meta.url), 'utf8');
const context = {
  console: {
    log() {},
    warn() {},
    error() {},
  },
};
vm.runInNewContext(apiScript, context);

const policy = context.ConfigSyncPolicy;

function createAppContext(localConfig) {
  const storage = new Map();
  if (localConfig) storage.set('lx-local-config', JSON.stringify(localConfig));
  const appContext = {
    console: context.console,
    document: {
      addEventListener() {},
    },
    window: {
      matchMedia() {
        return { addEventListener() {} };
      },
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    setInterval() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
  };
  vm.runInNewContext(apiScript, appContext);
  vm.runInNewContext(appScript, appContext);
  return appContext;
}

test('keeps a complete backend configuration as the source of truth', () => {
  assert.equal(
    policy.shouldRestore(
      { success: true, data: { host: 'http://server', username: 'current' } },
      { host: 'http://server', username: 'stale' },
    ),
    false,
  );
});

test('restores a complete local backup when backend identity is incomplete', () => {
  assert.equal(
    policy.shouldRestore(
      { success: true, data: { host: '', username: '' } },
      { host: 'http://server', username: 'current' },
    ),
    true,
  );
});

test('does not restore when backend configuration cannot be read', () => {
  assert.equal(
    policy.shouldRestore(
      { success: false, error: 'unavailable' },
      { host: 'http://server', username: 'current' },
    ),
    false,
  );
  assert.equal(
    policy.shouldRestore(null, { host: 'http://server', username: 'current' }),
    false,
  );
});

test('does not restore an incomplete or malformed local backup', () => {
  const backend = { success: true, data: { host: '', username: '' } };

  assert.equal(policy.shouldRestore(backend, { host: 'http://server' }), false);
  assert.equal(policy.shouldRestore(backend, { username: 'current' }), false);
  assert.equal(policy.shouldRestore(backend, null), false);
});

test('connection identity ignores whitespace-only values', () => {
  assert.equal(policy.hasConnectionIdentity({ host: '  ', username: 'current' }), false);
  assert.equal(policy.hasConnectionIdentity({ host: 'http://server', username: '  ' }), false);
});

test('keeps a local password only when the connection identity is unchanged', () => {
  const previous = { host: 'http://server', username: 'current', password: 'saved' };

  assert.equal(
    policy.resolveLocalPassword(previous, { host: 'http://server', username: 'current' }, ''),
    'saved',
  );
  assert.equal(
    policy.resolveLocalPassword(previous, { host: 'http://server', username: 'other' }, ''),
    '',
  );
  assert.equal(
    policy.resolveLocalPassword(previous, { host: 'http://server', username: 'other' }, 'new'),
    'new',
  );
});

test('startup does not overwrite a complete backend configuration', async () => {
  const appContext = createAppContext({
    host: 'http://server',
    username: 'stale',
    password: 'stale-password',
  });
  let saveCalls = 0;
  appContext.API.getConfig = async () => ({
    success: true,
    data: { host: 'http://server', username: 'current' },
  });
  appContext.API.saveConfig = async () => {
    saveCalls += 1;
    return { success: true };
  };

  await appContext.App.autoRestoreConfig();

  assert.equal(saveCalls, 0);
});

test('startup restores a local backup only when backend config is incomplete', async () => {
  const appContext = createAppContext({
    host: 'http://server',
    username: 'current',
    password: 'saved-password',
  });
  const savedConfigs = [];
  let testCalls = 0;
  appContext.API.getConfig = async () => ({ success: true, data: { host: '', username: '' } });
  appContext.API.saveConfig = async config => {
    savedConfigs.push(config);
    return { success: true };
  };
  appContext.API.testConnection = async () => {
    testCalls += 1;
    return { success: true };
  };
  appContext.App.showToast = () => {};

  await appContext.App.autoRestoreConfig();

  assert.equal(savedConfigs.length, 1);
  assert.equal(savedConfigs[0].username, 'current');
  assert.equal(testCalls, 1);
});

test('startup skips local restore when backend config read fails', async () => {
  const appContext = createAppContext({
    host: 'http://server',
    username: 'stale',
    password: 'stale-password',
  });
  let saveCalls = 0;
  appContext.API.getConfig = async () => ({ success: false, error: 'unavailable' });
  appContext.API.saveConfig = async () => {
    saveCalls += 1;
    return { success: true };
  };

  await appContext.App.autoRestoreConfig();

  assert.equal(saveCalls, 0);
});
