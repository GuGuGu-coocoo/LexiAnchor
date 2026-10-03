import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
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
const verificationFile = path.join(sourceDirectory, 'launcher-verification.json');
const verificationHistory = path.join(sourceDirectory, 'launcher-verification-history.jsonl');
const require = createRequire(path.join(repositoryRoot, 'package.json'));
const execute = promisify(execFile);
const ownedProfiles = new Set();

const help = `LexiAnchor source-only tools (never package or publish an app)

  node tools/reader-source-smoke.mjs status
  node tools/reader-source-smoke.mjs launch [--pnpm /absolute/path/to/pnpm]
  node tools/reader-source-smoke.mjs launch --verify-launch [--pnpm /absolute/path/to/pnpm]
  node tools/reader-source-smoke.mjs build
  node tools/reader-source-smoke.mjs smoke --entry /absolute/source-test/build-.../

launch: pnpm dev:desktop, persistent independent source-test/profile.
--verify-launch: same dev command, disposable isolated QA profile; opens all three sample books.
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
    if (state.mode === 'verification') {
      const temporaryRoot = await realpath(tmpdir());
      if (
        state.disposableProfile !== true ||
        (state.profile === null
          ? state.status !== 'starting'
          : typeof state.profile !== 'string' ||
            path.dirname(state.profile) !== temporaryRoot ||
            !path.basename(state.profile).startsWith('lexianchor-source-qa-'))
      )
        throw new Error('Source verification lock does not identify a disposable QA session.');
    } else if (state.profile !== path.join(sourceDirectory, 'profile')) {
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
  if (state.mode === 'verification') {
    console.log(
      '源码启动验证正在进行，请等待结束后再双击；不会激活临时 QA 实例。\nSource launch verification is running; wait before launching. The disposable QA app will not be focused.',
    );
    return;
  }
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

async function findSourceChild(
  parentPid,
  electronExecutable,
  profile,
  depth = 0,
  deadline = Date.now() + 2_000,
) {
  if (depth > 5 || Date.now() > deadline || !processExists(parentPid)) {
    return null;
  }
  const children = await command('/usr/bin/pgrep', ['-P', String(parentPid)], {
    timeout: 2_000,
  }).catch(() => '');
  for (const pid of children
    .split('\n')
    .map(Number)
    .filter((value) => value > 0)) {
    if (Date.now() > deadline) return null;
    const argumentsText = await command('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 2_000,
    }).catch(() => '');
    if (
      argumentsText.includes(electronExecutable) &&
      argumentsText.includes(`--user-data-dir=${profile}`)
    ) {
      return pid;
    }
    const nested = await findSourceChild(pid, electronExecutable, profile, depth + 1, deadline);
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
          params: { expression, returnByValue: true, awaitPromise: true },
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

function errorRecord(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: error?.stack,
  };
}

async function writeVerification(record, initial = false) {
  await mkdir(sourceDirectory, { recursive: true });
  // Concurrent blocked attempts have their own IDs. An older active run may
  // append its outcome, but must not replace a newer attempt's latest record.
  const latest = initial
    ? null
    : JSON.parse(await readFile(verificationFile, 'utf8').catch(() => 'null'));
  if (initial || latest?.runId === record.runId)
    await writeFile(verificationFile, `${JSON.stringify(record, null, 2)}\n`);
  if (record.status !== 'starting')
    await appendFile(verificationHistory, `${JSON.stringify(record)}\n`);
}

async function startupEvidence(profile) {
  if (!ownedProfiles.has(profile))
    throw new Error("Startup evidence requires this process's QA profile.");
  const text = await readFile(path.join(profile, 'startup-events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function expectedEpubScriptBlock(details, sandbox) {
  // Keep the exact native denial during this owned EPUB verification in the
  // evidence. Chromium reports either no source or the exact srcdoc document;
  // neither identifies the attempted script. Other sources/stages fail, and
  // no script permission is granted to make the diagnostic disappear.
  return (
    typeof sandbox?.permissions === 'string' &&
    sandbox.permissions.split(/\s+/).includes('allow-same-origin') &&
    !sandbox.permissions.split(/\s+/).includes('allow-scripts') &&
    sandbox.documentUrl === 'about:srcdoc' &&
    details.webContentsId === sandbox.webContentsId &&
    details.at >= sandbox.startedAt &&
    details.at <= sandbox.completedAt &&
    details.message ===
      "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set." &&
    (details.sourceId === '' || details.sourceId === 'about:srcdoc')
  );
}

function rejectedConsole(details, sandbox) {
  if (expectedEpubScriptBlock(details, sandbox)) return false;
  const text = details.message ?? '';
  // Retain Electron's development security warning, but never confuse it with
  // an actual CSP refusal, script failure, or uncaught exception.
  if (
    /refused to (?:apply|load|execute)|violates?.{0,120}(?:style-src|script-src)|\buncaught\b|does not provide an export|failed to fetch dynamically imported module/i.test(
      text,
    )
  )
    return true;
  if (details.level !== 'error') return false;
  return !(
    text.includes('ERR_INTERNET_DISCONNECTED') &&
    details.sourceId?.startsWith('https://en.wiktionary.org/')
  );
}

async function processSignature(pid) {
  return command('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], {
    timeout: 2_000,
  }).catch(() => '');
}

async function rememberOwnedTree(pid, known, deadline = Date.now() + 3_000, depth = 0) {
  if (!processExists(pid)) return;
  if (depth > 8 || known.size >= 64 || Date.now() > deadline)
    throw new Error('Own QA descendant inventory exceeded its bounded limit.');
  const signature = await processSignature(pid);
  if (!signature) {
    if (processExists(pid)) throw new Error(`Cannot identify own QA process ${pid}.`);
    return;
  }
  if (known.has(pid) && known.get(pid) !== signature)
    throw new Error(`Own QA process ${pid} changed identity; it will not be signalled.`);
  known.set(pid, signature);
  const children = await command('/usr/bin/pgrep', ['-P', String(pid)], { timeout: 2_000 }).catch(
    (error) => {
      if (error.code === 1) return ''; // pgrep: no descendants, not an inventory failure.
      throw error;
    },
  );
  for (const descendant of children
    .split('\n')
    .map(Number)
    .filter((value) => value > 0))
    await rememberOwnedTree(descendant, known, deadline, depth + 1);
}

async function stopOwnDevelopment(child, endpoint, electronExecutable, profile, known) {
  const warnings = [];
  const signals = [];
  let quitRequested = false;
  const deadline = Date.now() + 30_000;
  let inventoryComplete = true;
  try {
    // A dead pnpm parent can leave an already identified app descendant alive.
    // Inventory only still-identical known roots, never a globally found PID.
    const deadline = Date.now() + 3_000;
    for (const pid of [...known.keys()]) await rememberOwnedTree(pid, known, deadline);
    if (processExists(child.pid) && !known.has(child.pid))
      throw new Error('Own QA launcher has no recorded process identity.');
  } catch (error) {
    inventoryComplete = false;
    warnings.push(errorRecord(error));
  }
  const stopped = () =>
    !processExists(child.pid) && [...known.keys()].every((pid) => !processExists(pid));
  const waitForExit = async () => {
    for (let attempt = 0; attempt < 30 && Date.now() < deadline && !stopped(); attempt += 1)
      await delay(100);
  };
  const appAlive = [...known].some(
    ([pid, signature]) =>
      processExists(pid) &&
      signature.includes(electronExecutable) &&
      signature.includes(`--user-data-dir=${profile}`),
  );
  if (endpoint && appAlive) {
    try {
      const owner = JSON.parse(
        await inspectEvaluate(
          endpoint,
          "JSON.stringify({pid:process.pid,profile:process.mainModule.require('electron').app.getPath('userData'),sessionProfile:process.mainModule.require('electron').app.getPath('sessionData')})",
        ),
      );
      if (
        !known.has(owner.pid) ||
        (await processSignature(owner.pid)) !== known.get(owner.pid) ||
        owner.profile !== profile ||
        owner.sessionProfile !== profile
      )
        throw new Error(
          'Refusing app.quit for an inspector without own QA process/profile identity.',
        );
      await inspectEvaluate(
        endpoint,
        "setTimeout(()=>process.mainModule.require('electron').app.quit(),0); true",
      );
      quitRequested = true;
    } catch (error) {
      warnings.push(errorRecord(error));
    }
  }
  await waitForExit();
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (stopped() || Date.now() >= deadline) break;
    // Only this launch's recorded descendant identities, never port/global
    // process matches. Recheck identity so a reused PID is not signalled.
    for (const [pid, signature] of [...known].reverse()) {
      if (Date.now() >= deadline) break;
      if (signature && processExists(pid) && (await processSignature(pid)) === signature) {
        try {
          process.kill(pid, signal);
          signals.push({ pid, signal });
        } catch (error) {
          if (error.code !== 'ESRCH') warnings.push(errorRecord(error));
        }
      }
    }
    await waitForExit();
  }
  return {
    exited: inventoryComplete && stopped(),
    warnings,
    quitRequested,
    signals,
    remainingPids: [...known.keys()].filter(processExists),
  };
}

async function bounded(operation, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error(description)), milliseconds);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function verifyDevelopmentLaunch(child, inspectorEndpoint, profile, status, evidence) {
  let endpoint;
  let port;
  let browser;
  let result;
  let primaryError;
  const pageErrors = [];
  const consoleErrors = [];
  const consoleDetails = [];
  const scriptFailures = [];
  Object.assign(evidence, { pageErrors, consoleErrors, consoleDetails, scriptFailures });
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      endpoint = inspectorEndpoint();
      const activePort = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(
        () => '',
      );
      port = Number(activePort.split('\n')[0]);
      if (endpoint && port > 0) break;
      if (!processExists(child.pid)) break;
      await delay(200);
    }
    if (!endpoint || !port)
      throw new Error('Source launch did not expose its own validation endpoints.');
    const expression =
      "JSON.stringify({pid:process.pid,profile:process.mainModule.require('electron').app.getPath('userData'),sessionProfile:process.mainModule.require('electron').app.getPath('sessionData'),version:process.mainModule.require('electron').app.getVersion(),runtime:process.versions,webContentsId:process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.id})";
    const actual = JSON.parse(await inspectEvaluate(endpoint, expression));
    if (
      (await realpath(actual.profile)) !== profile ||
      (await realpath(actual.sessionProfile)) !== profile
    )
      throw new Error('Source launcher did not retain its isolated QA profile.');
    Object.assign(evidence, {
      actualProfile: actual.profile,
      actualPid: actual.pid,
      actualSessionProfile: actual.sessionProfile,
      profileVerified: true,
      actualVersion: actual.version,
      runtime: actual.runtime,
    });
    const { chromium, expect } = await import('@playwright/test');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = browser.contexts()[0]?.pages()[0];
    if (!page) {
      throw new Error('Source app has no renderer page.');
    }
    page.setDefaultTimeout(30_000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
      consoleDetails.push({
        at: new Date().toISOString(),
        webContentsId: actual.webContentsId,
        level: message.type(),
        message: message.text(),
        sourceId: message.location().url,
        lineNumber: message.location().lineNumber,
      });
    });
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'script')
        scriptFailures.push({ url: request.url(), error: request.failure()?.errorText });
    });
    await page
      .context()
      .route('https://en.wiktionary.org/**', (route) => route.abort('internetdisconnected'));
    await page.getByRole('heading', { level: 1 }).waitFor();
    const initialHeading = await page.getByRole('heading', { level: 1 }).textContent();
    const origin = new URL(page.url()).origin;
    if (origin !== 'http://localhost:5173') {
      throw new Error(`Unexpected source origin: ${origin}`);
    }
    const window = await page.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
      deviceScale: globalThis.devicePixelRatio,
    }));
    Object.assign(evidence, { origin, window });
    const openSample = async (title) => {
      await page.getByRole('button', { name: /^(Library|书库|Bibliothèque)$/ }).click();
      const card = page.locator('.book-card').filter({
        has: page.getByRole('heading', { level: 2, name: title, exact: true }),
      });
      await card.getByRole('button').click();
    };
    const epubStartedAt = new Date().toISOString();
    await openSample('Anchored Reading');
    const surface = page.getByTestId('epub-container');
    await expect(surface).toHaveAttribute('aria-busy', 'false');
    await expect(surface.locator(':scope > .epub-container')).toHaveCount(1);
    const frame = surface.locator('iframe').first().contentFrame();
    await expect(frame.getByRole('heading', { name: 'A Quiet Beginning' })).toBeVisible();
    const epubSandbox = {
      startedAt: epubStartedAt,
      webContentsId: actual.webContentsId,
      permissions: await surface.locator('iframe').first().getAttribute('sandbox'),
      documentUrl: await frame.locator('body').evaluate((body) => body.ownerDocument.URL),
      scripts: await frame.locator('body').evaluate((body) =>
        [...body.ownerDocument.scripts].map((script) => ({
          source: script.getAttribute('src'),
          type: script.type,
          devClient:
            script.src.includes('/@vite/client') ||
            (script.textContent ?? '').includes('/@vite/client'),
        })),
      ),
    };
    evidence.epubSandbox = epubSandbox;
    const readBlobStyles = () =>
      frame.locator('body').evaluate((body) =>
        [...body.ownerDocument.styleSheets]
          .filter((sheet) => sheet.href?.startsWith('blob:'))
          .map((sheet) => {
            try {
              return { href: sheet.href, rules: sheet.cssRules.length };
            } catch (error) {
              return { href: sheet.href, error: String(error) };
            }
          }),
      );
    await expect
      .poll(async () => (await readBlobStyles()).some((sheet) => sheet.rules > 0))
      .toBe(true);
    const blobStyles = await readBlobStyles();
    const scroller = surface.locator(':scope > .epub-container');
    const beforeTurn = await scroller.evaluate((element) => element.scrollLeft);
    await frame.locator('body').press('ArrowRight');
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(beforeTurn);
    await frame.locator('body').press('ArrowLeft');
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBeLessThanOrEqual(beforeTurn + 1);
    const selection = await frame
      .locator('p')
      .first()
      .evaluate((paragraph) => {
        const document = paragraph.ownerDocument;
        const walker = document.createTreeWalker(
          paragraph,
          document.defaultView.NodeFilter.SHOW_TEXT,
        );
        let text = walker.nextNode();
        while (text) {
          const match = /[a-zA-Z]{4,}/.exec(text.textContent ?? '');
          if (match) {
            const range = document.createRange();
            range.setStart(text, match.index);
            range.setEnd(text, match.index + match[0].length);
            const selection = document.defaultView.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(
              new document.defaultView.MouseEvent('mouseup', { bubbles: true }),
            );
            return match[0];
          }
          text = walker.nextNode();
        }
        throw new Error('EPUB sample has no selectable test word.');
      });
    await expect(page.locator('.selection-word').first()).toHaveText(selection);
    await page.screenshot({ path: path.join(sourceDirectory, 'development-epub.png') });
    epubSandbox.completedAt = new Date().toISOString();
    await page.getByRole('button', { name: /^(Library|返回书库|Bibliothèque)$/ }).click();
    const fixtures = [
      {
        title: 'Anchored Reading',
        format: 'epub',
        turns: true,
        selection,
        blobStyles,
        epubSandbox,
      },
    ];
    evidence.fixtures = fixtures;
    for (const title of ['Anchored Pages', 'Image-only Sample']) {
      await openSample(title);
      const canvas = page.getByTestId('pdf-container').locator('canvas').first();
      await expect(page.locator('.reader-footer')).toBeVisible();
      await expect
        .poll(() => canvas.evaluate((element) => element.width > 0 && element.height > 0))
        .toBe(true);
      if (title === 'Anchored Pages')
        await expect(page.locator('.pdf-text-layer span').first()).toBeVisible();
      else
        await expect(
          page.getByText(/Image-only page|纯图片页面|Page en image/, { exact: true }),
        ).toBeVisible();
      const dimensions = await canvas.evaluate((element) => ({
        width: element.width,
        height: element.height,
      }));
      if (dimensions.width <= 0 || dimensions.height <= 0)
        throw new Error(`${title} has no rendered PDF canvas.`);
      await expect(page.locator('.reader-error')).toHaveCount(0);
      const beforePage = Number(await page.locator('.reader-footer-page-current').textContent());
      const nextPage = page.getByRole('button', { name: /^(Next|下一页|Suivant)$/ });
      if (await nextPage.isEnabled()) {
        await nextPage.click();
        await expect(page.locator('.reader-footer-page-current')).toHaveText(
          String(beforePage + 1),
        );
      }
      fixtures.push({ title, format: 'pdf', dimensions });
      await page.getByRole('button', { name: /^(Library|返回书库|Bibliothèque)$/ }).click();
    }
    // Only after the unmodified first-launch/sample assertions have passed:
    // exercise the user's actual dev reload, then prove other paths remain
    // blocked. Reload is never used to recover an initial blank renderer.
    const currentUrl = page.url();
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      page.evaluate(() => globalThis.location.reload()),
    ]);
    await expect(page).toHaveURL(currentUrl);
    // App's section is React state, so a real reload returns to Home. Prove
    // that fresh root rendered before deliberately opening Library again.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(initialHeading);
    await page.getByRole('button', { name: /^(Library|书库|Bibliothèque)$/ }).click();
    const libraryHeading = page.getByRole('heading', {
      level: 1,
      name: /^(Your library|你的书库|Votre bibliothèque)$/,
    });
    await expect(libraryHeading).toBeVisible();
    await page.evaluate((target) => {
      globalThis.location.href = target;
    }, `${origin}/blocked-navigation-probe`);
    await delay(300);
    // A native preventDefault leaves CDP's scheduled navigation pending.
    // Check the actual WebContents/document, not Playwright's pending-frame URL.
    const blocked = JSON.parse(
      await inspectEvaluate(
        endpoint,
        `(async()=>{const {BrowserWindow}=process.mainModule.require('electron');const contents=BrowserWindow.getAllWindows()[0].webContents;return JSON.stringify({url:contents.getURL(),document:await contents.executeJavaScript('({url:location.href,heading:document.querySelector("h1")?.innerText,rootLength:document.querySelector("#root")?.innerHTML.length})')});})()`,
      ),
    );
    if (
      blocked.url !== currentUrl ||
      blocked.document.url !== currentUrl ||
      !/^(Your library|你的书库|Votre bibliothèque)$/.test(blocked.document.heading ?? '') ||
      !(blocked.document.rootLength > 0)
    )
      throw new Error(`Different-path navigation was not blocked: ${JSON.stringify(blocked)}`);
    evidence.navigation = {
      sameUrlReload: true,
      differentPathBlocked: true,
      currentUrl,
      blocked,
    };
    const startupEvents = await startupEvidence(profile);
    evidence.startupEvents = startupEvents;
    if (
      !startupEvents.some(
        (event) =>
          event.kind === 'guard-start' && event.pid === actual.pid && event.ready === false,
      ) ||
      !startupEvents.some(
        (event) =>
          event.kind === 'isolation-ready' &&
          event.pid === actual.pid &&
          event.profile === profile &&
          event.sessionProfile === profile,
      ) ||
      !startupEvents.some((event) => event.kind === 'web-contents-created')
    )
      throw new Error('Own QA pre-ready isolation/event hook has no execution evidence.');
    const allConsoleDetails = [
      ...consoleDetails,
      ...startupEvents.filter((event) => event.kind === 'console-message'),
    ];
    const consoleRefusals = allConsoleDetails.filter((details) =>
      rejectedConsole(details, epubSandbox),
    );
    evidence.expectedSandboxBlocks = allConsoleDetails.filter((details) =>
      expectedEpubScriptBlock(details, epubSandbox),
    );
    const startupLoadFailures = startupEvents.filter((event) => event.kind === 'did-fail-load');
    if (
      pageErrors.length ||
      scriptFailures.length ||
      consoleRefusals.length ||
      startupLoadFailures.length
    ) {
      throw new Error(
        `Development sample flow failed: ${JSON.stringify({ pageErrors, scriptFailures, consoleRefusals, startupLoadFailures })}`,
      );
    }
    const finalSource = await sourceStatus();
    evidence.finalSource = finalSource;
    if (['commit', 'dirtyDiffHash', 'lockHash'].some((key) => finalSource[key] !== status[key]))
      throw new Error(
        `Source changed during launch verification; this run is invalid: ${JSON.stringify({ before: status, after: finalSource })}`,
      );
    result = {
      kind: 'source-launcher-verification',
      packaged: false,
      ...status,
      actualProfile: actual.profile,
      actualSessionProfile: actual.sessionProfile,
      profileVerified: true,
      disposableProfile: true,
      actualVersion: actual.version,
      runtime: actual.runtime,
      origin,
      window,
      fixtures,
      pageErrors,
      scriptFailures,
      consoleErrors,
      consoleDetails,
      startupEvents,
      finalSource,
      passed: true,
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    primaryError = error;
    const page = browser?.contexts()[0]?.pages()[0];
    const recordDiagnosticError = (error) => {
      (evidence.diagnosticErrors ??= []).push(errorRecord(error));
    };
    const renderer = page
      ? await bounded(
          page.evaluate(() => ({
            url: globalThis.location.href,
            readyState: globalThis.document.readyState,
            text: globalThis.document.body.innerText.slice(0, 2500),
          })),
          2_000,
          'QA renderer failure diagnostic timed out.',
        ).catch(recordDiagnosticError)
      : undefined;
    evidence.renderer = renderer;
    if (page)
      await bounded(
        page.screenshot({
          path: path.join(sourceDirectory, 'development-failure.png'),
          timeout: 2_000,
        }),
        3_000,
        'QA failure screenshot timed out.',
      ).catch(recordDiagnosticError);
    console.error(
      JSON.stringify(
        {
          kind: 'source-development-failure',
          renderer,
          pageErrors,
          scriptFailures,
          consoleErrors,
          consoleDetails,
        },
        null,
        2,
      ),
    );
  } finally {
    // Browser disconnection failure must not prevent the outer owned-app
    // cleanup, nor replace the original renderer/preflight failure.
    try {
      if (browser) await bounded(browser.close(), 5_000, 'QA browser disconnect timed out.');
    } catch (error) {
      evidence.browserCleanupError = errorRecord(error);
      primaryError ??= error;
      console.error(`Secondary QA browser cleanup failure: ${error.message}`);
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

async function launchDevelopment(pnpmExecutable, verifyLaunch = false) {
  const runId = `${Date.now()}-${process.pid}`;
  const record = {
    kind: 'source-launcher-verification',
    packaged: false,
    runId,
    status: 'starting',
    passed: false,
    error: null,
    startedAt: new Date().toISOString(),
  };
  const state = {
    pid: process.pid,
    devPid: null,
    profile: verifyLaunch ? null : path.join(sourceDirectory, 'profile'),
    mode: verifyLaunch ? 'verification' : 'normal',
    disposableProfile: verifyLaunch,
    runId,
    status: 'starting',
    startedAt: record.startedAt,
  };
  const evidence = {};
  const knownProcesses = new Map();
  const cleanupWarnings = [];
  let electronExecutable;
  let profile;
  let status;
  let lock;
  let ownsLock = false;
  let child;
  let childError;
  let primaryError;
  let result;
  let cleanup;
  let inspectorEndpoint = '';
  const updateLock = async () => {
    const current = JSON.parse(await readFile(launchLock, 'utf8'));
    if (current.pid !== process.pid || current.runId !== runId)
      throw new Error('Source launch lock ownership changed; refusing to overwrite it.');
    await writeFile(launchLock, `${JSON.stringify(state)}\n`);
  };
  try {
    // Clear any old successful "latest" evidence before even dependency or
    // port preflight. Every attempt has an append-only final outcome as well.
    if (verifyLaunch) await writeVerification(record, true);
    electronExecutable = await dependencies();
    status = await sourceStatus();
    Object.assign(record, status);
    await mkdir(sourceDirectory, { recursive: true });
    const running = await existingLauncher();
    if (running) {
      if (verifyLaunch)
        throw new Error('A source test session already exists; validation will not close it.');
      await focusExistingSource(electronExecutable, running);
      return;
    }
    // Both modes exclusively own the same .vite build entry. A normal double
    // click during verification waits; it never focuses disposable QA data.
    try {
      lock = await open(launchLock, 'wx');
      ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await existingLauncher();
      if (current && !verifyLaunch) {
        await focusExistingSource(electronExecutable, current);
        return;
      }
      throw new Error('Another source launcher owns the build entry; please wait.', {
        cause: error,
      });
    }
    await lock.writeFile(`${JSON.stringify(state)}\n`);
    await lock.close();
    profile = verifyLaunch ? await createIsolatedProfile() : state.profile;
    state.profile = profile;
    await updateLock();
    evidence.profile = profile;
    evidence.disposableProfile = verifyLaunch;
    console.log(
      `Version ${status.sourceVersion} · ${status.branch}@${status.commit.slice(0, 12)}${status.dirty ? ' + local changes' : ''}`,
    );
    console.log(`独立数据目录 / Independent profile: ${profile}`);
    console.log('首次空书库是独立源码资料，并非旧版书籍/词卡丢失。不会读取、清除或迁移旧版资料。');
    console.log(
      'An empty first library is a separate source profile, not lost data. Existing app data is untouched.',
    );
    await assertPortAvailable(5173);
    await mkdir(profile, { recursive: true });
    console.log(
      '保留本终端；在阅读器按 ⌘Q 退出 / Keep this terminal open; use ⌘Q in the reader to quit.',
    );
    // Installed Forge 7.11.2 splits at -- and passes the remainder to Electron.
    const args = ['dev:desktop', '--', `--user-data-dir=${profile}`];
    const environment = offlineEnvironment();
    if (verifyLaunch) {
      const isolationEntry = path.join(profile, 'dev-isolation.cjs');
      await writeFile(
        isolationEntry,
        `'use strict';
// Loaded by the own QA loader at Electron's official process 'loaded' event,
// after internal API initialization and before the source main starts.
if (process.versions.electron && process.type === 'browser') {
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const profile = ${JSON.stringify(profile)};
const events = path.join(profile, 'startup-events.jsonl');
const record = (kind, details = {}) => fs.appendFileSync(events, JSON.stringify({ kind, at: new Date().toISOString(), pid: process.pid, ...details }) + '\\n');
record('guard-start', { ready: app.isReady() });
if (app.isReady() || fs.realpathSync(profile) !== profile) throw new Error('Dev QA isolation must be pre-ready.');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
if (fs.realpathSync(app.getPath('userData')) !== profile || fs.realpathSync(app.getPath('sessionData')) !== profile)
  throw new Error('Dev QA isolation failed before source main.');
record('isolation-ready', { profile: app.getPath('userData'), sessionProfile: app.getPath('sessionData') });
app.on('web-contents-created', (_event, contents) => {
  const identify = () => ({ webContentsId: contents.id, url: contents.isDestroyed() ? null : contents.getURL() });
  record('web-contents-created', identify());
  contents.on('console-message', (details) => record('console-message', { ...identify(), level: details.level, message: details.message, sourceId: details.sourceId, lineNumber: details.lineNumber }));
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => record('did-fail-load', { ...identify(), errorCode, errorDescription, validatedURL, isMainFrame }));
  contents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => record('did-frame-finish-load', { ...identify(), isMainFrame, frameProcessId, frameRoutingId }));
  contents.on('will-navigate', (event) => record('will-navigate', { ...identify(), target: event.url }));
});
}
`,
      );
      const loaderEntry = path.join(profile, 'dev-loaded-guard.cjs');
      await writeFile(
        loaderEntry,
        `'use strict';
// NODE_OPTIONS also runs in Forge's Node parents. No Electron API or argv
// mutation here; wait for its official internal-initialization event.
if (process.versions.electron && process.type === 'browser') {
  const fs = require('node:fs');
  const profile = ${JSON.stringify(profile)};
  if (fs.realpathSync(profile) !== profile) throw new Error('QA guard-loader profile changed.');
  fs.appendFileSync(${JSON.stringify(path.join(profile, 'startup-events.jsonl'))}, JSON.stringify({ kind: 'guard-hook-installed', at: new Date().toISOString(), pid: process.pid }) + '\\n');
  process.once('loaded', () => require(${JSON.stringify(isolationEntry)}));
}
`,
      );
      // Use only this own QA preloader, not inherited Node options. Whether
      // process 'loaded' is actually pre-ready must be proved by same-
      // PID guard-start/isolation-ready records, never inferred from setup.
      // Ordinary launch and production bootstrap remain unchanged.
      environment.NODE_OPTIONS = `--require=${JSON.stringify(loaderEntry)}`;
      args.push('--inspect=0', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1');
    }
    child = spawn(pnpmExecutable, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    // Attach before the first await: a spawn error must not escape as an
    // unhandled event or leave validation waiting on an impossible endpoint.
    const exited = new Promise((resolve) => {
      child.once('error', (error) => {
        childError = error;
        resolve(1);
      });
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      const match = String(chunk).match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
      if (match) {
        inspectorEndpoint = match[1];
      }
    });
    state.devPid = child.pid;
    if (verifyLaunch && processExists(child.pid))
      await rememberOwnedTree(child.pid, knownProcesses);
    await updateLock();
    // Observe only descendants of our pnpm child; never scan or kill user apps.
    for (let attempt = 0; attempt < 100 && processExists(child.pid); attempt += 1) {
      const observedPid = await findSourceChild(child.pid, electronExecutable, profile);
      if (observedPid) {
        state.appPid = observedPid;
        // Keep the discovered own app identity even if its pnpm parent exits
        // before the next awaited lock write or cleanup inventory.
        if (verifyLaunch) await rememberOwnedTree(observedPid, knownProcesses);
      }
      if (state.appPid) {
        await delay(300);
        if (verifyLaunch) await rememberOwnedTree(child.pid, knownProcesses);
        state.status = 'running';
        await updateLock();
        break;
      }
      await delay(200);
    }
    if (childError) throw childError;
    if (verifyLaunch) {
      result = await verifyDevelopmentLaunch(
        child,
        () => inspectorEndpoint,
        profile,
        status,
        evidence,
      );
    } else {
      // Ordinary development deliberately stays attached until the user's
      // app exits. Only disposable verification has a bounded own-app stop.
      process.exitCode = await exited;
      if (childError) throw childError;
    }
  } catch (error) {
    primaryError = error;
  } finally {
    await lock?.close().catch(() => undefined);
    if (verifyLaunch && child) {
      try {
        cleanup = await stopOwnDevelopment(
          child,
          inspectorEndpoint,
          electronExecutable,
          profile,
          knownProcesses,
        );
        cleanupWarnings.push(...cleanup.warnings);
        if (!cleanup.exited) {
          const error = new Error(
            `Own QA exit was not confirmed; profile and lock retained: ${JSON.stringify(cleanup.remainingPids)}`,
          );
          cleanupWarnings.push(errorRecord(error));
          primaryError ??= error;
        }
      } catch (error) {
        cleanupWarnings.push(errorRecord(error));
        primaryError ??= error;
      }
    }
    if (verifyLaunch && profile) {
      try {
        evidence.startupEvents = await startupEvidence(profile);
        const consoleRefusals = evidence.startupEvents
          .filter((event) => event.kind === 'console-message')
          .filter((details) => rejectedConsole(details, evidence.epubSandbox));
        const startupLoadFailures = evidence.startupEvents.filter(
          (event) => event.kind === 'did-fail-load',
        );
        if (result && (consoleRefusals.length || startupLoadFailures.length))
          primaryError ??= new Error(
            `QA startup event log contains failures: ${JSON.stringify({ consoleRefusals, startupLoadFailures })}`,
          );
      } catch (error) {
        cleanupWarnings.push(errorRecord(error));
        if (result) primaryError ??= error;
      }
    }
    const stopped =
      !child ||
      (verifyLaunch
        ? cleanup?.exited === true
        : !processExists(child.pid) && !processExists(state.appPid));
    if (ownsLock && stopped) {
      // Never remove an active profile, a replaced lock, or ordinary data.
      try {
        if (verifyLaunch && profile) {
          await removeIsolatedProfile(profile);
          evidence.profileRemoved = true;
        }
        const current = JSON.parse(await readFile(launchLock, 'utf8'));
        if (current.pid !== process.pid || current.runId !== runId) {
          const error = new Error('Own QA lock was replaced; refusing to remove it.');
          cleanupWarnings.push(errorRecord(error));
          primaryError ??= error;
        } else await rm(launchLock, { force: true });
      } catch (error) {
        cleanupWarnings.push(errorRecord(error));
        primaryError ??= error;
      }
    } else if (ownsLock && verifyLaunch) {
      state.status = 'failed';
      state.error = errorRecord(primaryError ?? new Error('Own QA process is still running.'));
      await updateLock().catch((error) => cleanupWarnings.push(errorRecord(error)));
    }
    if (verifyLaunch) {
      // Recheck after shutdown too, so evidence never certifies a different
      // HMR/source revision than the one captured before launch.
      if (status) {
        try {
          const finalSource = await sourceStatus();
          evidence.finalSource = finalSource;
          if (
            ['commit', 'dirtyDiffHash', 'lockHash'].some((key) => finalSource[key] !== status[key])
          ) {
            const error = new Error(
              'Source changed during launch verification; this run is invalid.',
            );
            cleanupWarnings.push(errorRecord(error));
            primaryError ??= error;
          }
        } catch (error) {
          cleanupWarnings.push(errorRecord(error));
          primaryError ??= error;
        }
      }
      Object.assign(record, result, evidence, {
        status: result && !primaryError ? 'passed' : 'failed',
        passed: Boolean(result && !primaryError),
        error: primaryError ? errorRecord(primaryError) : null,
        cleanup,
        cleanupWarnings,
        completedAt: new Date().toISOString(),
      });
      try {
        await writeVerification(record);
      } catch (error) {
        primaryError ??= error;
        record.status = 'failed';
        record.passed = false;
        record.error = errorRecord(primaryError);
        console.error(`Verification evidence write failed: ${error.message}`);
      }
      console.log(JSON.stringify(record, null, 2));
    }
  }
  if (primaryError) throw primaryError;
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
