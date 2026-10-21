import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';

const modulePath = new URL('../src/subscriptions/store.js', import.meta.url);

async function importStore() {
  return import(modulePath.href);
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(os.tmpdir() + '/follow-store-test-');
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function pathJoin(...parts) {
  return parts.join(os.platform === 'win32' ? '\\' : '/');
}

test('follow / unfollow / list / followersOf basic flow', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });

    await store.follow('chat:1', 'market:abc');
    await store.follow('chat:1', 'squad:m1');
    await store.follow('chat:2', 'market:abc');

    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc', 'squad:m1']);
    assert.deepStrictEqual(await store.list('chat:2'), ['market:abc']);
    assert.deepStrictEqual(await store.followersOf('market:abc'), ['chat:1', 'chat:2']);
    assert.deepStrictEqual(await store.followersOf('squad:m1'), ['chat:1']);

    await store.unfollow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['squad:m1']);
    assert.deepStrictEqual(await store.followersOf('market:abc'), ['chat:2']);
  });
});

test('persistence across instances', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const a = createFollowStore({ filePath });
    await a.follow('chat:1', 'market:abc');
    await a.follow('chat:1', 'squad:m1');

    const b = createFollowStore({ filePath });
    assert.deepStrictEqual(await b.list('chat:1'), ['market:abc', 'squad:m1']);
    assert.deepStrictEqual(await b.followersOf('market:abc'), ['chat:1']);

    const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    assert.strictEqual(typeof raw.version, 'number');
  });
});

test('follow is idempotent', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    await store.follow('chat:1', 'market:abc');
    await store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc']);
  });
});

test('rejects malformed refs', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const bad = ['', 'market:', 'market: ', 'foo', 'foo:bar', 'market:a:b', 'squad:', 'MARKET:abc', 'market:abc '];
    for (const ref of bad) {
      await assert.rejects(() => store.follow('chat:1', ref), undefined, `ref ${JSON.stringify(ref)} should be rejected`);
    }
    assert.deepStrictEqual(await store.list('chat:1'), []);
  });
});

test('enforces per-chat cap', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxFollowsPerChat: 2,
    });
    await store.follow('chat:1', 'market:a1');
    await store.follow('chat:1', 'market:a2');
    await assert.rejects(() => store.follow('chat:1', 'market:a3'));
    assert.deepStrictEqual(await store.list('chat:1'), ['market:a1', 'market:a2']);
    // Other chats unaffected.
    await store.follow('chat:2', 'market:a1');
    assert.deepStrictEqual(await store.list('chat:2'), ['market:a1']);
  });
});

test('enforces total cap', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxTotalEntries: 3,
    });
    await store.follow('chat:1', 'market:a1');
    await store.follow('chat:1', 'market:a2');
    await store.follow('chat:2', 'market:a3');
    await assert.rejects(() => store.follow('chat:2', 'market:a4'));
    // Idempotent re-follow of existing entry is allowed even at cap.
    await store.follow('chat:1', 'market:a1');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:a1', 'market:a2']);
    assert.deepStrictEqual(await store.list('chat:2'), ['market:a3']);
  });
});

test('quarantines corrupt file and starts fresh', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    await fs.promises.writeFile(filePath, '{ not json ::', 'utf8');

    const store = createFollowStore({ filePath });
    assert.deepStrictEqual(await store.list('chat:1'), []);
    await store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc']);

    const files = await fs.promises.readdir(dir);
    const quarantined = files.filter((f) => f !== 'follows.json' && f.includes('follows.json'));
    assert.ok(quarantined.length >= 1, 'corrupt file should be quarantined');
  });
});

test('quarantines wrong shape file', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    await fs.promises.writeFile(filePath, JSON.stringify({ version: 1, follows: 'not-an-array' }), 'utf8');

    const store = createFollowStore({ filePath });
    assert.deepStrictEqual(await store.list('chat:1'), []);
    await store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc']);
  });
});

test('writes atomically via temp + rename', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const store = createFollowStore({ filePath });
    await store.follow('chat:1', 'market:abc');
    const files = await fs.promises.readdir(dir);
    assert.deepStrictEqual(files, ['follows.json']);
  });
});
