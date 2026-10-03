import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function validate(state, normalProfile, temporaryRoot) {
  if (
    !state ||
    !Number.isInteger(state.pid) ||
    state.pid <= 0 ||
    typeof state.runId !== 'string' ||
    !state.runId ||
    !['starting', 'running', 'failed'].includes(state.status) ||
    [state.devPid, state.appPid].some((pid) => pid != null && (!Number.isInteger(pid) || pid <= 0))
  )
    throw new Error('Unreadable source launch lock identity; refusing recovery.');
  if (state.mode === 'verification') {
    if (
      state.disposableProfile !== true ||
      (state.profile === null
        ? state.status !== 'starting'
        : typeof state.profile !== 'string' ||
          path.dirname(state.profile) !== temporaryRoot ||
          !path.basename(state.profile).startsWith('lexianchor-source-qa-'))
    )
      throw new Error('Source verification lock does not identify a disposable QA session.');
  } else if (
    state.mode !== 'normal' ||
    state.disposableProfile !== false ||
    state.profile !== normalProfile
  )
    throw new Error('Source launch lock does not identify the fixed independent profile.');
}

// All launcher acquisition/recovery goes through the same short-lived guard.
// In particular, no new launcher can create a replacement between a stale
// lock's final identity check and its archive rename. Never touch a profile.
export async function acquireSourceLaunchLock({
  lockPath,
  normalProfile,
  temporaryRoot,
  initialState,
  ensurePortAvailable,
  exists = processExists,
}) {
  validate(initialState, normalProfile, temporaryRoot);
  const guardPath = `${lockPath}.acquiring`;
  let guard;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      guard = await open(guardPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 39)
        throw new Error('Another source launcher is acquiring its lock; please retry.', {
          cause: error,
        });
      await delay(50);
    }
  }
  const guardIdentity = await guard.stat();
  try {
    let raw;
    let state;
    let identity;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        identity = await lstat(lockPath);
        if (!identity.isFile() || identity.isSymbolicLink())
          throw new Error('Source launch lock is not a regular file; refusing recovery.');
        raw = await readFile(lockPath, 'utf8');
        state = JSON.parse(raw);
        validate(state, normalProfile, temporaryRoot);
        break;
      } catch (error) {
        if (error.code === 'ENOENT') break;
        if (error instanceof SyntaxError && attempt < 6) {
          await delay(50);
          continue;
        }
        throw error;
      }
    }
    let recovered;
    if (state) {
      const alive = () => [state.pid, state.devPid, state.appPid].filter(Boolean).some(exists);
      if (alive()) return { owned: false, state };
      await ensurePortAvailable();
      const current = await lstat(lockPath);
      if (
        current.ino !== identity.ino ||
        current.dev !== identity.dev ||
        (await readFile(lockPath, 'utf8')) !== raw ||
        alive()
      )
        throw new Error('Source launch lock changed; refusing recovery.');
      const archiveDirectory = path.join(path.dirname(lockPath), 'launcher-lock-history');
      await mkdir(archiveDirectory, { recursive: true });
      recovered = path.join(archiveDirectory, `${Date.now()}-${randomUUID()}.json`);
      await rename(lockPath, recovered);
    }
    const lock = await open(lockPath, 'wx');
    try {
      await lock.writeFile(`${JSON.stringify(initialState)}\n`);
    } finally {
      await lock.close();
    }
    return { owned: true, state: initialState, recovered };
  } finally {
    await guard.close();
    const current = await lstat(guardPath);
    if (current.ino === guardIdentity.ino && current.dev === guardIdentity.dev)
      await unlink(guardPath);
  }
}
