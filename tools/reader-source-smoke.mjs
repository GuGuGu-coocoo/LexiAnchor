import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const desktopDirectory = path.join(repositoryRoot, 'apps', 'desktop');
const sourceDirectory = path.join(repositoryRoot, 'source-test');
const launchLock = path.join(sourceDirectory, 'launcher.lock.json');
const require = createRequire(path.join(repositoryRoot, 'package.json'));
const execute = promisify(execFile);
const ownedProfiles = new Set();

const help = `LexiAnchor source-only tools (never package or publish an app)

  node tools/reader-source-smoke.mjs status
  node tools/reader-source-smoke.mjs launch [--pnpm /absolute/path/to/pnpm] [--verify-launch]
  node tools/reader-source-smoke.mjs build
  node tools/reader-source-smoke.mjs smoke --entry /absolute/source-test/build-.../

launch: pnpm dev:desktop, persistent independent source-test/profile.
build: Vite production JS/assets only, using installed Forge 7.11.2 config rules.
smoke: installed Electron + source bundle + a disposable, isolated QA profile.
No make/package, dependency installation, existing app replacement, or user-profile cleanup.
For restart/gesture QA, set LEXIANCHOR_SOURCE_APP to the build directory and run:
  pnpm exec playwright test tests/e2e/desktop-gesture-restart.spec.ts --workers=1
`;

async function command(commandName, args, options = {}) {
  const result = await execute(commandName, args, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sourceStatus() {
  const [commit, branch, diff, untracked, lock, rootPackage, desktopPackage] = await Promise.all([
    command('git', ['rev-parse', 'HEAD']),
    command('git', ['branch', '--show-current']),
    command('git', ['diff', '--binary', 'HEAD', '--']),
    command('git', ['ls-files', '--others', '--exclude-standard', '-z']),
    readFile(path.join(repositoryRoot, 'pnpm-lock.yaml')),
    readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
    readFile(path.join(desktopDirectory, 'package.json'), 'utf8'),
  ]);
  const diffParts = [Buffer.from(diff)];
  for (const filename of untracked.split('\0').filter(Boolean).sort()) {
    diffParts.push(
      Buffer.from(`\0${filename}\0`),
      await readFile(path.join(repositoryRoot, filename)),
    );
  }
  const rootVersion = JSON.parse(rootPackage).version;
  const sourceVersion = JSON.parse(desktopPackage).version;
  if (rootVersion !== sourceVersion) {
    throw new Error('Root and desktop package versions differ.');
  }
  return {
    commit,
    branch,
    dirty: Boolean(diff || untracked),
    dirtyDiffHash: sha256(Buffer.concat(diffParts)),
    lockHash: sha256(lock),
    sourceVersion,
    node: process.version,
    electron: require('electron/package.json').version,
    forgeVite: require('@electron-forge/plugin-vite/package.json').version,
    host: { platform: process.platform, arch: process.arch },
  };
}

async function dependencies() {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('需要 Node.js 24 / Node.js 24 is required.');
  }
  let electronExecutable;
  try {
    electronExecutable = require('electron');
    await access(electronExecutable);
    require.resolve('@electron-forge/cli/package.json');
    require.resolve('vite');
    require.resolve('playwright');
  } catch {
    throw new Error(
      '本地依赖或 Electron 缺失。请在项目执行 pnpm install，然后重试。\nMissing local dependencies/Electron. Run pnpm install in this repository, then retry.',
    );
  }
  return electronExecutable;
}

function offlineEnvironment() {
  const environment = {
    ...process.env,
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    npm_config_offline: 'true',
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  return environment;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function existingLauncher() {
  // Another double click can observe the exclusively created file before its
  // first JSON write. Wait at most 300 ms without deleting that file.
  for (let attempt = 0; attempt < 7; attempt += 1) {
    try {
      return await readLauncher();
    } catch (error) {
      if (error.cause instanceof SyntaxError && attempt < 6) {
        await delay(50);
        continue;
      }
      throw error;
    }
  }
}

async function readLauncher() {
  try {
    const state = JSON.parse(await readFile(launchLock, 'utf8'));
    if (state.profile !== path.join(sourceDirectory, 'profile')) {
      throw new Error('Source launch lock does not identify the fixed independent profile.');
    }
    if (!processExists(state.pid) && !processExists(state.devPid)) {
      throw new Error(
        '上次源码启动锁仍在，但进程已结束。未自动清理资料或启动第二个进程；请检查 source-test/launcher.lock.json 后移走该锁文件。\nA stale source lock remains. After checking that the source dev process has ended, move source-test/launcher.lock.json aside and retry; do not remove profile/.',
      );
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    // Never assume a partially written or unreadable lock is safe to replace.
    throw new Error(
      `源码启动锁无法读取，未启动第二个进程 / Unreadable source launch lock: ${error.message}`,
      { cause: error },
    );
  }
}

async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () =>
      reject(
        new Error(
          `端口 ${port} 已被占用，未启动备用端口以保护数据接续。\nPort ${port} is busy; not switching origins. Close the conflicting dev server and retry.`,
        ),
      ),
    );
    server.listen(port, () => server.close(resolve));
  });
}

async function focusExistingSource(electronExecutable, state) {
  if (!processExists(state.appPid)) {
    console.log(
      '源码测试版正在启动，请稍候再双击 / Source app is still starting; please retry shortly.',
    );
    return;
  }
  console.log(
    '源码测试版已在运行；只激活现有实例 / Source test app is already running; focusing it.',
  );
  const mainEntry = path.join(desktopDirectory, '.vite', 'build', 'main.js');
  try {
    await access(mainEntry);
  } catch {
    console.log('现有进程仍在构建，请稍候 / Existing process is still building; please wait.');
    return;
  }
  await command(electronExecutable, [desktopDirectory, `--user-data-dir=${state.profile}`], {
    env: offlineEnvironment(),
    timeout: 10_000,
  });
}

async function findSourceChild(parentPid, electronExecutable, profile, depth = 0) {
  if (depth > 5 || !processExists(parentPid)) {
    return null;
  }
  const children = await command('/usr/bin/pgrep', ['-P', String(parentPid)]).catch(() => '');
  for (const pid of children
    .split('\n')
    .map(Number)
    .filter((value) => value > 0)) {
    const argumentsText = await command('/bin/ps', ['-p', String(pid), '-o', 'command=']).catch(
      () => '',
    );
    if (
      argumentsText.includes(electronExecutable) &&
      argumentsText.includes(`--user-data-dir=${profile}`)
    ) {
      return pid;
    }
    const nested = await findSourceChild(pid, electronExecutable, profile, depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

export async function inspectEvaluate(endpoint, expression) {
  return new Promise((resolve, reject) => {
    const socket = new globalThis.WebSocket(endpoint);
    const timeout = globalThis.setTimeout(() => {
      socket.close();
      reject(new Error('Source main inspector timed out.'));
    }, 10_000);
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }),
      ),
    );
    socket.addEventListener('error', () => {
      globalThis.clearTimeout(timeout);
      reject(new Error('Source main inspector connection failed.'));
    });
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== 1) {
        return;
      }
      globalThis.clearTimeout(timeout);
      socket.close();
      if (response.error || response.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(response.error ?? response.result.exceptionDetails)));
      } else {
        resolve(response.result.result.value);
      }
    });
  });
}

async function verifyDevelopmentLaunch(child, inspectorEndpoint, profile, status) {
  let endpoint = inspectorEndpoint();
  let port;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    endpoint = inspectorEndpoint();
    const activePort = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(
      () => '',
    );
    port = Number(activePort.split('\n')[0]);
    if (endpoint && port > 0) {
      break;
    }
    if (!processExists(child.pid)) {
      break;
    }
    await delay(200);
  }
  if (!endpoint || !port) {
    throw new Error('Source launch did not expose its own validation endpoints.');
  }
  const expression =
    "JSON.stringify({profile:process.mainModule.require('electron').app.getPath('userData'),version:process.mainModule.require('electron').app.getVersion(),runtime:process.versions})";
  const actual = JSON.parse(await inspectEvaluate(endpoint, expression));
  if (path.resolve(actual.profile) !== profile) {
    throw new Error('Source launcher did not use its fixed independent profile.');
  }
  const { chromium } = await import('playwright');
  let browser;
  let result;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) {
      throw new Error('Source app has no renderer page.');
    }
    await page.getByRole('heading', { level: 1 }).waitFor();
    const origin = new URL(page.url()).origin;
    if (origin !== 'http://localhost:5173') {
      throw new Error(`Unexpected source origin: ${origin}`);
    }
    const window = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      deviceScale: globalThis.devicePixelRatio,
    }));
    result = {
      kind: 'source-launcher-verification',
      packaged: false,
      ...status,
      actualProfile: actual.profile,
      actualVersion: actual.version,
      runtime: actual.runtime,
      origin,
      window,
      verifiedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(sourceDirectory, 'launcher-verification.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } finally {
    await browser?.close();
    // Endpoint came from our child; the profile above was explicitly verified.
    // A failed renderer check must also quit this validation app, not leave it.
    await inspectEvaluate(
      endpoint,
      "setTimeout(()=>process.mainModule.require('electron').app.quit(),0); true",
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

async function launchDevelopment(pnpmExecutable, verifyLaunch = false) {
  const electronExecutable = await dependencies();
  const status = await sourceStatus();
  const profile = path.join(sourceDirectory, 'profile');
  console.log(
    `Version ${status.sourceVersion} · ${status.branch}@${status.commit.slice(0, 12)}${status.dirty ? ' + local changes' : ''}`,
  );
  console.log(`独立数据目录 / Independent profile: ${profile}`);
  console.log('首次空书库是独立源码资料，并非旧版书籍/词卡丢失。不会读取、清除或迁移旧版资料。');
  console.log(
    'An empty first library is a separate source profile, not lost data. Existing app data is untouched.',
  );
  await mkdir(sourceDirectory, { recursive: true });
  const running = await existingLauncher();
  if (running) {
    if (verifyLaunch) {
      throw new Error('A source test session already exists; validation will not close it.');
    }
    await focusExistingSource(electronExecutable, running);
    return;
  }
  // Exclusive creation prevents simultaneous Finder invocations from rebuilding .vite.
  // Do not unlink another invocation's newly created file to recover a stale lock.
  let lock;
  try {
    lock = await open(launchLock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    const current = await existingLauncher();
    if (current) {
      await focusExistingSource(electronExecutable, current);
      return;
    }
    throw new Error('Another source launcher is finishing; please retry.', { cause: error });
  }
  const state = { pid: process.pid, devPid: null, profile, startedAt: new Date().toISOString() };
  let child;
  let inspectorEndpoint = '';
  try {
    await lock.writeFile(`${JSON.stringify(state)}\n`);
    await lock.close();
    await assertPortAvailable(5173);
    await mkdir(profile, { recursive: true });
    console.log(
      '保留本终端；在阅读器按 ⌘Q 退出 / Keep this terminal open; use ⌘Q in the reader to quit.',
    );
    // Installed Forge 7.11.2 splits at -- and passes the remainder to Electron.
    const args = ['dev:desktop', '--', `--user-data-dir=${profile}`];
    if (verifyLaunch) {
      args.push('--inspect=0', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1');
    }
    child = spawn(pnpmExecutable, args, {
      cwd: repositoryRoot,
      env: offlineEnvironment(),
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      const match = String(chunk).match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) {
        inspectorEndpoint = match[1];
      }
      const ownedErrorPid = String(chunk).match(/\(node:(\d+)\) electron:/);
      if (ownedErrorPid) {
        state.appPid = Number(ownedErrorPid[1]);
      }
    });
    state.devPid = child.pid;
    await writeFile(launchLock, `${JSON.stringify(state)}\n`);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    // Observe only descendants of our pnpm child; never scan or kill user apps.
    for (let attempt = 0; attempt < 100 && processExists(child.pid); attempt += 1) {
      const observedPid = await findSourceChild(child.pid, electronExecutable, profile);
      if (observedPid) {
        state.appPid = observedPid;
      }
      if (state.appPid) {
        await delay(300);
        await writeFile(launchLock, `${JSON.stringify(state)}\n`);
        break;
      }
      await delay(200);
    }
    if (verifyLaunch && (processExists(child.pid) || inspectorEndpoint)) {
      await verifyDevelopmentLaunch(child, () => inspectorEndpoint, profile, status);
    }
    const exitCode = await exited;
    process.exitCode = exitCode;
  } finally {
    await lock.close().catch(() => undefined);
    // If our development child survives terminal closure, retain its ownership lock.
    if (!child || (!processExists(child.pid) && !processExists(state.appPid))) {
      const current = await readFile(launchLock, 'utf8').catch(() => '');
      if (current && JSON.parse(current).pid === process.pid) {
        await rm(launchLock, { force: true });
      }
    }
  }
}

export async function buildSource() {
  await dependencies();
  const before = await sourceStatus();
  await mkdir(sourceDirectory, { recursive: true });
  const output = await mkdtemp(path.join(sourceDirectory, `build-${before.commit.slice(0, 12)}-`));
  // Reuse this repository's installed/pinned Forge Vite config generator only.
  // Do not call Forge hooks, package, make, fuses, signing, or publishers.
  const pluginRoot = path.dirname(require.resolve('@electron-forge/plugin-vite/package.json'));
  if (before.forgeVite !== '7.11.2') {
    throw new Error('Source builder needs review after changing the pinned Forge Vite version.');
  }
  const { createJiti } = require('jiti');
  const forgeConfig = await createJiti(import.meta.url).import(
    path.join(desktopDirectory, 'forge.config.ts'),
    { default: true },
  );
  const vitePlugin = forgeConfig.plugins.find((plugin) => plugin.name === 'vite');
  if (!vitePlugin?.config) {
    throw new Error('Cannot find the repository Vite plugin configuration.');
  }
  const Generator = require(path.join(pluginRoot, 'dist', 'ViteConfig.js')).default;
  const generator = new Generator(vitePlugin.config, desktopDirectory, true);
  const { build } = await import('vite');
  const originalDirectory = process.cwd();
  try {
    process.chdir(desktopDirectory);
    const buildConfigs = await generator.getBuildConfigs();
    const rendererConfigs = await generator.getRendererConfig();
    // Sequential and fresh output, independent from the live launcher's .vite.
    for (const config of [...buildConfigs, ...rendererConfigs]) {
      config.configFile = false;
      config.build.outDir = path.join(
        output,
        path.relative(desktopDirectory, path.resolve(desktopDirectory, config.build.outDir)),
      );
      config.build.emptyOutDir = false;
      config.build.watch = null;
      await build(config);
    }
  } finally {
    process.chdir(originalDirectory);
  }
  const after = await sourceStatus();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(
      `Source changed during build; this output must not be used for verification: ${output}`,
    );
  }
  const packageEntry = {
    name: '@lexianchor/desktop',
    productName: 'LexiAnchor',
    version: before.sourceVersion,
    main: '.vite/build/main.js',
  };
  await writeFile(path.join(output, 'package.json'), `${JSON.stringify(packageEntry, null, 2)}\n`);
  const manifest = {
    kind: 'source-production-bundle',
    packaged: false,
    ...before,
    builtAt: new Date().toISOString(),
    entry: output,
    mainHash: sha256(await readFile(path.join(output, '.vite', 'build', 'main.js'))),
    rendererHash: sha256(
      await readFile(path.join(output, '.vite', 'renderer', 'main_window', 'index.html')),
    ),
  };
  await writeFile(path.join(output, 'source-build.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function createIsolatedProfile() {
  // macOS /var is a /private/var alias. Keep one canonical identity for both
  // ownership checks and Electron's reported userData/sessionData paths.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'lexianchor-source-qa-')));
  ownedProfiles.add(directory);
  return directory;
}

export async function removeIsolatedProfile(directory) {
  if (!ownedProfiles.has(directory)) {
    throw new Error('Refusing to remove a profile not created by this test process.');
  }
  await rm(directory, { recursive: true, force: true });
  ownedProfiles.delete(directory);
}

export async function prepareSourceBootstrap(applicationEntry, profile) {
  if (!ownedProfiles.has(profile)) {
    throw new Error('QA launch requires a profile created by createIsolatedProfile().');
  }
  if ((await realpath(profile)) !== profile) {
    throw new Error('QA profile canonical identity changed.');
  }
  const entry = path.resolve(applicationEntry);
  if (!entry.startsWith(`${sourceDirectory}${path.sep}`)) {
    throw new Error(
      'Use the isolated source-test/build-... entry, not an installed app or live dev bundle.',
    );
  }
  const manifest = JSON.parse(await readFile(path.join(entry, 'source-build.json'), 'utf8'));
  if (manifest.packaged !== false || manifest.kind !== 'source-production-bundle') {
    throw new Error('Expected a source-only production bundle.');
  }
  const mainEntry = path.join(entry, '.vite', 'build', 'main.js');
  const hash = sha256(await readFile(mainEntry));
  if (hash !== manifest.mainHash) {
    throw new Error('Source bundle main entry no longer matches its build record.');
  }
  const bootstrapDirectory = await mkdtemp(path.join(profile, 'source-entry-'));
  // Establish isolation before the real main can acquire a single-instance
  // lock, create any windows, or open SQLite. The CLI switch remains a second
  // protection, but is never the only boundary for this QA-only launch.
  const isolation = `'use strict';
const fs = require('node:fs');
const { app } = require('electron');
const profile = ${JSON.stringify(profile)};
if (app.isReady() || fs.realpathSync(profile) !== profile) {
  throw new Error('QA isolation must be established before Electron is ready.');
}
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (fs.realpathSync(app.getPath('userData')) !== profile ||
    fs.realpathSync(app.getPath('sessionData')) !== profile) {
  throw new Error('QA profile isolation failed before loading source main.');
}
`;
  const bootstrap = `'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { app } = require('electron');
const profile = ${JSON.stringify(profile)};
const sourceMain = ${JSON.stringify(mainEntry)};
if (fs.realpathSync(app.getPath('userData')) !== profile ||
    fs.realpathSync(app.getPath('sessionData')) !== profile) {
  throw new Error('QA isolation changed before loading source main.');
}
if (createHash('sha256').update(fs.readFileSync(sourceMain)).digest('hex') !== ${JSON.stringify(manifest.mainHash)}) {
  throw new Error('Source main changed after QA bootstrap preparation.');
}
require(sourceMain);
`;
  const isolationEntry = path.join(bootstrapDirectory, 'isolation.cjs');
  await writeFile(isolationEntry, isolation);
  await writeFile(path.join(bootstrapDirectory, 'bootstrap.cjs'), bootstrap);
  await writeFile(
    path.join(bootstrapDirectory, 'package.json'),
    `${JSON.stringify({ name: '@lexianchor/desktop', productName: 'LexiAnchor', version: manifest.sourceVersion, main: 'bootstrap.cjs' }, null, 2)}\n`,
  );
  return { bootstrapDirectory, isolationEntry, manifest, profile, mainEntry };
}

export async function launchSourceApp(applicationEntry, profile) {
  const electronExecutable = await dependencies();
  const { bootstrapDirectory, isolationEntry, manifest } = await prepareSourceBootstrap(
    applicationEntry,
    profile,
  );
  const { _electron: electron } = await import('playwright');
  const app = await electron.launch({
    executablePath: electronExecutable,
    // Pinned Electron default_app.asar handles -r via Module._preloadModules
    // before its async package metadata import, so isolation is pre-ready.
    args: ['-r', isolationEntry, bootstrapDirectory, `--user-data-dir=${profile}`],
    env: offlineEnvironment(),
    timeout: 30_000,
  });
  try {
    const actualPaths = await app.evaluate(({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      sessionData: electronApp.getPath('sessionData'),
    }));
    if (
      (await realpath(actualPaths.userData)) !== profile ||
      (await realpath(actualPaths.sessionData)) !== profile
    ) {
      throw new Error(
        `Electron did not retain its isolated QA paths: expected ${profile}, actual ${JSON.stringify(actualPaths)}.`,
      );
    }
    const page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    await page.waitForLoadState('domcontentloaded');
    await page
      .context()
      .route('https://en.wiktionary.org/**', (route) => route.abort('internetdisconnected'));
    return { app, page, profile, build: manifest };
  } catch (error) {
    await stopSourceApp({ app }, 'kill').catch(() => undefined);
    throw error;
  }
}

export async function stopSourceApp(session, mode = 'normal') {
  const child = session.app.process();
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (mode === 'normal') {
    await session.app.close();
    return;
  }
  if (mode !== 'kill') {
    throw new Error(`Unsupported stop mode: ${mode}`);
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

async function main() {
  const [action = '--help', ...args] = process.argv.slice(2);
  if (action === '--help' || action === '-h') {
    console.log(help);
  } else if (action === 'status') {
    await dependencies();
    console.log(JSON.stringify(await sourceStatus(), null, 2));
  } else if (action === 'launch') {
    const pnpmIndex = args.indexOf('--pnpm');
    await launchDevelopment(
      pnpmIndex < 0 ? 'pnpm' : args[pnpmIndex + 1],
      args.includes('--verify-launch'),
    );
  } else if (action === 'build') {
    console.log(JSON.stringify(await buildSource(), null, 2));
  } else if (action === 'smoke') {
    const entryIndex = args.indexOf('--entry');
    if (entryIndex < 0 || !args[entryIndex + 1]) {
      throw new Error('smoke requires --entry <source-test/build-... directory>.');
    }
    const profile = await createIsolatedProfile();
    let session;
    try {
      session = await launchSourceApp(args[entryIndex + 1], profile);
      await session.page.getByRole('heading', { level: 1 }).waitFor();
      const runtime = await session.app.evaluate(() => ({
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        v8: process.versions.v8,
      }));
      const window = await session.page.evaluate(() => ({
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
        deviceScale: globalThis.devicePixelRatio,
      }));
      const result = {
        kind: 'source-only-smoke',
        packaged: false,
        commit: session.build.commit,
        dirtyDiffHash: session.build.dirtyDiffHash,
        runtime,
        window,
        profileVerified: true,
        passed: true,
        at: new Date().toISOString(),
      };
      await stopSourceApp(session);
      session = undefined;
      await writeFile(
        path.join(path.resolve(args[entryIndex + 1]), 'source-smoke.json'),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      console.log(JSON.stringify(result, null, 2));
    } finally {
      if (session) {
        await stopSourceApp(session, 'kill').catch(() => undefined);
      }
      await delay(50);
      await removeIsolatedProfile(profile);
    }
  } else {
    throw new Error(`Unknown source-only action: ${action}\n${help}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
