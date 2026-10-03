import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import { acquireSourceLaunchLock } from './source-launch-lock.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lexianchor-lock-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const normalProfile = path.join(root, 'profile');
  await mkdir(normalProfile);
  const marker = path.join(normalProfile, 'books-cards-presets.sentinel');
  await writeFile(marker, 'untouched');
  const lockPath = path.join(root, 'launcher.lock.json');
  const old = {
    pid: 900_001,
    devPid: 900_002,
    appPid: 900_003,
    mode: 'normal',
    disposableProfile: false,
    profile: normalProfile,
    status: 'running',
    runId: 'old',
  };
  const initialState = { ...old, pid: process.pid, devPid: null, appPid: null, runId: 'new' };
  const alive = new Set([process.pid]);
  let portChecks = 0;
  const options = {
    lockPath,
    normalProfile,
    temporaryRoot: root,
    initialState,
    exists: (pid) => alive.has(pid),
    ensurePortAvailable: () => {
      portChecks += 1;
    },
  };
  return {
    root,
    old,
    options,
    alive,
    marker,
    portChecks: () => portChecks,
    save: (state = old) => writeFile(lockPath, `${JSON.stringify(state)}\n`),
  };
}

test('archives a fully exited lock and acquires without reading or clearing the profile', async (t) => {
  const f = await fixture(t);
  await f.save();
  const raw = await readFile(f.options.lockPath, 'utf8');
  const result = await acquireSourceLaunchLock(f.options);
  assert.equal(result.owned, true);
  assert.equal(await readFile(result.recovered, 'utf8'), raw);
  assert.deepEqual(JSON.parse(await readFile(f.options.lockPath, 'utf8')), f.options.initialState);
  assert.equal(await readFile(f.marker, 'utf8'), 'untouched');
  assert.equal(f.portChecks(), 1);
  assert.equal((await readdir(f.root)).includes('launcher.lock.json.acquiring'), false);
});

for (const key of ['pid', 'devPid', 'appPid'])
  test(`does not recover while the recorded ${key} is still alive`, async (t) => {
    const f = await fixture(t);
    f.alive.add(f.old[key]);
    await f.save();
    const result = await acquireSourceLaunchLock(f.options);
    assert.equal(result.owned, false);
    assert.deepEqual(result.state, f.old);
    assert.equal(f.portChecks(), 0);
    assert.equal((await readdir(f.root)).includes('launcher-lock-history'), false);
  });

test('a busy port leaves the old lock and all profile bytes intact', async (t) => {
  const f = await fixture(t);
  await f.save();
  const raw = await readFile(f.options.lockPath, 'utf8');
  await assert.rejects(
    acquireSourceLaunchLock({
      ...f.options,
      ensurePortAvailable: () => {
        throw new Error('Port 5173 busy');
      },
    }),
    /busy/,
  );
  assert.equal(await readFile(f.options.lockPath, 'utf8'), raw);
  assert.equal(await readFile(f.marker, 'utf8'), 'untouched');
});

test('does not archive a lock changed during recovery checks', async (t) => {
  const f = await fixture(t);
  await f.save();
  const replaced = { ...f.old, runId: 'replacement' };
  await assert.rejects(
    acquireSourceLaunchLock({ ...f.options, ensurePortAvailable: () => f.save(replaced) }),
    /changed/,
  );
  assert.deepEqual(JSON.parse(await readFile(f.options.lockPath, 'utf8')), replaced);
});

test('a recorded process that becomes live during preflight prevents recovery', async (t) => {
  const f = await fixture(t);
  await f.save();
  await assert.rejects(
    acquireSourceLaunchLock({
      ...f.options,
      ensurePortAvailable: () => f.alive.add(f.old.appPid),
    }),
    /changed/,
  );
  assert.deepEqual(JSON.parse(await readFile(f.options.lockPath, 'utf8')), f.old);
});

test('concurrent double launches have one owner and one archive, not a replaced new lock', async (t) => {
  const f = await fixture(t);
  await f.save();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      acquireSourceLaunchLock({
        ...f.options,
        initialState: { ...f.options.initialState, runId: `new-${index}` },
      }),
    ),
  );
  const owners = results.filter((result) => result.owned);
  assert.equal(owners.length, 1);
  assert.equal((await readdir(path.join(f.root, 'launcher-lock-history'))).length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.options.lockPath, 'utf8')), owners[0].state);
  assert.equal(await readFile(f.marker, 'utf8'), 'untouched');
});

for (const change of [
  { mode: 'unknown' },
  { profile: '/unrelated/profile' },
  { pid: 0 },
  { appPid: '900003' },
])
  test(`refuses unsafe lock identity ${JSON.stringify(change)}`, async (t) => {
    const f = await fixture(t);
    await f.save({ ...f.old, ...change });
    const raw = await readFile(f.options.lockPath, 'utf8');
    await assert.rejects(acquireSourceLaunchLock(f.options));
    assert.equal(await readFile(f.options.lockPath, 'utf8'), raw);
    assert.equal(f.portChecks(), 0);
  });

test('a malformed lock stays untouched instead of being guessed stale', async (t) => {
  const f = await fixture(t);
  await writeFile(f.options.lockPath, '{');
  await assert.rejects(acquireSourceLaunchLock(f.options), SyntaxError);
  assert.equal(await readFile(f.options.lockPath, 'utf8'), '{');
});

test('refuses symlink locks without touching their target', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'unrelated.json');
  await writeFile(target, JSON.stringify(f.old));
  await symlink(target, f.options.lockPath);
  await assert.rejects(acquireSourceLaunchLock(f.options), /regular file/);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), f.old);
});
