// Puppeteer smoke tests for the USACC site, run with `node --test puppeteer/`.
//
// Mirrors the Playwright setup in ../playwright.config.ts: when
// USACC_E2E_BASE_URL is set the tests run against that URL (e.g. the live
// GitHub Pages deployment); otherwise an Astro dev server is spawned on a
// dedicated port and shut down when the suite finishes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer';

const testsDir = dirname(dirname(fileURLToPath(import.meta.url)));

const port = Number(process.env.USACC_E2E_PUPPETEER_PORT ?? 4331);
const externalBaseUrl = process.env.USACC_E2E_BASE_URL;
const baseUrl = (externalBaseUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');

/** @type {import('node:child_process').ChildProcess | undefined} */
let server;
/** @type {import('puppeteer').Browser} */
let browser;
/** @type {import('puppeteer').Page} */
let page;
/** @type {import('puppeteer').HTTPResponse | null} */
let homeResponse = null;

async function waitForServer(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`unexpected status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`Dev server at ${url} did not become ready: ${lastError}`);
}

before(async () => {
  if (!externalBaseUrl) {
    server = spawn(
      'pnpm',
      ['--dir', '..', 'dev', '--host', '127.0.0.1', '--port', String(port)],
      {
        cwd: testsDir,
        stdio: 'ignore',
        detached: true,
      },
    );
    await waitForServer(`${baseUrl}/`);
  }

  browser = await puppeteer.launch({
    // GitHub ubuntu-24 runners restrict unprivileged user namespaces (AppArmor),
    // which breaks Chrome's sandbox; disable it in CI only.
    args: process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });
  page = await browser.newPage();
  homeResponse = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2' });
});

after(async () => {
  await browser?.close();
  if (server?.pid) {
    // The pnpm wrapper spawns astro as a child; kill the whole process group.
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
});

test('home page loads with an ok response', () => {
  assert.ok(homeResponse, 'expected a navigation response for the home page');
  assert.ok(homeResponse.ok(), `expected 2xx status, got ${homeResponse.status()}`);
});

test('home page has a non-empty title', async () => {
  const title = await page.title();
  assert.ok(title.trim().length > 0, 'expected document title to be non-empty');
});

test('home page links to the MDP and POMDP modeling pages', async () => {
  const hrefs = await page.$$eval('a[href]', (anchors) =>
    anchors.map((anchor) => anchor.getAttribute('href')),
  );
  assert.ok(hrefs.includes('/modeling/mdp/'), 'expected a link to /modeling/mdp/');
  assert.ok(hrefs.includes('/modeling/pomdp/'), 'expected a link to /modeling/pomdp/');
});

test('home page body text does not contain "undefined"', async () => {
  const bodyText = await page.evaluate(() => document.body.innerText);
  assert.ok(
    !bodyText.includes('undefined'),
    'expected rendered body text to not contain "undefined"',
  );
});
