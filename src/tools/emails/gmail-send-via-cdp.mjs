#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const chromeRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalEnv(name, fallback = '') {
  return process.env[name]?.trim() || fallback;
}

function readArgValue(flag) {
  const prefix = `${flag}=`;
  const valueArg = process.argv.find((arg) => arg.startsWith(prefix));
  if (!valueArg) return null;
  return valueArg.slice(prefix.length).trim();
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCsvEmails(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8').trim();
  const lines = raw.split(/\r?\n/);

  if (lines.length < 2) {
    throw new Error(`CSV has no recipient rows: ${csvPath}`);
  }

  const rows = lines.slice(1);
  const emails = [];

  for (const row of rows) {
    const match = row.match(/"([^"]*)","([^"]*)"/);
    if (!match) continue;
    const email = match[2].trim();
    if (email) emails.push(email);
  }

  return emails;
}

function buildComposeUrl({ to, cc, bcc, subject, body }) {
  const params = new URLSearchParams();
  params.set('view', 'cm');
  params.set('fs', '1');
  params.set('tf', '1');

  if (to) params.set('to', to);
  if (cc) params.set('cc', cc);
  if (bcc) params.set('bcc', bcc);
  if (subject) params.set('su', subject);
  if (body) params.set('body', body);

  return `https://mail.google.com/mail/?${params.toString()}`;
}

function resolveChromeBinary() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('Could not find the Google Chrome binary.');
}

function getChromeProfileName() {
  const override = readArgValue('--profile') || readOptionalEnv('OUTREACH_GMAIL_PROFILE');
  if (override) return override;

  const localStatePath = path.join(chromeRoot, 'Local State');
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  return localState?.profile?.last_used || 'Default';
}

function shouldSkipCopy(copyPath) {
  const normalized = copyPath.replaceAll('\\', '/');
  const skipFragments = [
    '/Cache/',
    '/Code Cache/',
    '/GPUCache/',
    '/GrShaderCache/',
    '/ShaderCache/',
    '/Crashpad/',
    '/Service Worker/CacheStorage/',
    '/Service Worker/ScriptCache/',
    '/Media Cache/',
  ];

  return skipFragments.some((fragment) => normalized.includes(fragment));
}

function cloneChromeProfile(profileName) {
  const tempUserDataDir = path.join(os.tmpdir(), `codex-gmail-${Date.now()}`);
  fs.mkdirSync(tempUserDataDir, { recursive: true });

  const localStateSource = path.join(chromeRoot, 'Local State');
  const localStateDest = path.join(tempUserDataDir, 'Local State');
  fs.copyFileSync(localStateSource, localStateDest);

  const sourceProfileDir = path.join(chromeRoot, profileName);
  const destProfileDir = path.join(tempUserDataDir, profileName);

  fs.cpSync(sourceProfileDir, destProfileDir, {
    recursive: true,
    filter: (src) => !shouldSkipCopy(src),
  });

  return tempUserDataDir;
}

function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) return reject(closeError);
        if (!port) return reject(new Error('Failed to allocate a local debugging port.'));
        resolve(port);
      });
    });
  });
}

function launchChrome({ chromeBinary, userDataDir, profileName, port, url }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileName}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--new-window',
    url,
  ];

  const child = spawn(chromeBinary, args, {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

async function waitForComposeTab(port, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tabs = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const composeTab = tabs.find((tab) => {
        return (
          tab.type === 'page' &&
          typeof tab.url === 'string' &&
          tab.url.startsWith('https://mail.google.com/mail') &&
          typeof tab.webSocketDebuggerUrl === 'string'
        );
      });

      if (composeTab) return composeTab;
    } catch (error) {
      // Chrome may still be starting up.
    }

    await sleep(1000);
  }

  throw new Error('Timed out waiting for the Gmail compose tab.');
}

class CdpClient {
  constructor(webSocketUrl) {
    if (typeof WebSocket !== 'function') {
      throw new Error('This Node runtime does not expose WebSocket.');
    }

    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.webSocketUrl);

      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('message', (event) => {
        const payload = JSON.parse(event.data.toString());

        if (payload.id && this.pending.has(payload.id)) {
          const { resolve: resolvePending, reject: rejectPending } = this.pending.get(payload.id);
          this.pending.delete(payload.id);

          if (payload.error) {
            rejectPending(new Error(payload.error.message || 'CDP request failed.'));
            return;
          }

          resolvePending(payload.result);
        }
      });
      this.ws.addEventListener('error', (error) => reject(error));
      this.ws.addEventListener('close', () => {
        for (const pending of this.pending.values()) {
          pending.reject(new Error('CDP connection closed.'));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });

    return result.result?.value;
  }

  close() {
    this.ws?.close();
  }
}

function buildComposeDiagnosticsExpression() {
  return `
(() => {
  const params = new URL(window.location.href).searchParams;
  const subjectEl = document.querySelector('input[name="subjectbox"]');
  const toEl = document.querySelector('input[aria-label="To recipients"]');
  const ccEl = document.querySelector('input[aria-label="CC recipients"]');
  const bccEl = document.querySelector('input[aria-label="BCC recipients"]');
  const fromEl = document.querySelector('input[name="from"]');
  const isHtmlEl = document.querySelector('input[name="ishtml"]');
  const hiddenBodyEl = document.querySelector('input[name="body"]');
  const textareaBodyEl = document.querySelector('textarea[aria-label="Message Body"]');
  const bodyEl =
    document.querySelector('div[aria-label="Message Body"]') ||
    document.querySelector('div[role="textbox"][g_editable="true"]') ||
    textareaBodyEl;
  const sendButton = Array.from(document.querySelectorAll('div[role="button"], button')).find((element) => {
    const label = [
      element.getAttribute('data-tooltip') || '',
      element.getAttribute('aria-label') || '',
      element.innerText || '',
    ]
      .join(' ')
      .trim();
    return /^send\\b/i.test(label);
  });
  const text = document.body.innerText || '';
  const emailishTexts = Array.from(new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi) || []))).slice(0, 50);

  return {
    href: window.location.href,
    title: document.title,
    queryTo: params.get('to') || '',
    queryCc: params.get('cc') || '',
    queryBccCount: (params.get('bcc') || '').split(',').filter(Boolean).length,
    querySubject: params.get('su') || '',
    toValue: toEl ? toEl.value : '',
    ccValue: ccEl ? ccEl.value : '',
    bccValue: bccEl ? bccEl.value : '',
    fromValue: fromEl ? fromEl.value : '',
    isHtmlValue: isHtmlEl ? isHtmlEl.value : '',
    subjectValue: subjectEl ? subjectEl.value : '',
    bodyFound: !!bodyEl,
    sendButtonFound: !!sendButton,
    bodyPreview: bodyEl ? ((bodyEl.innerText || bodyEl.value || '').slice(0, 240)) : '',
    hiddenBodyLength: hiddenBodyEl ? hiddenBodyEl.value.length : 0,
    textareaBodyLength: textareaBodyEl ? textareaBodyEl.value.length : 0,
    emailishTexts,
  };
})()
`;
}

function buildElementInventoryExpression() {
  return `
(() => {
  const inventory = Array.from(
    document.querySelectorAll('input, textarea, button, div[role="button"], div[role="textbox"], [contenteditable="true"], iframe')
  )
    .slice(0, 80)
    .map((element) => ({
      tag: element.tagName,
      type: element.getAttribute('type') || '',
      name: element.getAttribute('name') || '',
      role: element.getAttribute('role') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      dataTooltip: element.getAttribute('data-tooltip') || '',
      contentEditable: element.getAttribute('contenteditable') || '',
      gEditable: element.getAttribute('g_editable') || '',
      title: element.getAttribute('title') || '',
      src: element.getAttribute('src') || '',
      text: (element.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    }));

  return {
    title: document.title,
    href: window.location.href,
    inventory,
    htmlSnippet: document.documentElement.outerHTML.slice(0, 2500),
  };
})()
`;
}

function buildSetHtmlExpression(subject, html, fromAddress) {
  return `
(() => {
  const subjectEl = document.querySelector('input[name="subjectbox"]');
  const toEl = document.querySelector('input[aria-label="To recipients"]');
  const ccEl = document.querySelector('input[aria-label="CC recipients"]');
  const bccEl = document.querySelector('input[aria-label="BCC recipients"]');
  const textareaBodyEl = document.querySelector('textarea[aria-label="Message Body"]');
  const hiddenBodyEl = document.querySelector('input[name="body"]');
  const isHtmlEl = document.querySelector('input[name="ishtml"]');
  const fromEl = document.querySelector('input[name="from"]');
  const bodyEl =
    document.querySelector('div[aria-label="Message Body"]') ||
    document.querySelector('div[role="textbox"][g_editable="true"]') ||
    textareaBodyEl;

  if (!subjectEl) {
    return { ok: false, error: 'subject field not found' };
  }

  if (!bodyEl) {
    return { ok: false, error: 'message body field not found' };
  }

  subjectEl.focus();
  subjectEl.value = ${JSON.stringify(subject)};
  subjectEl.dispatchEvent(new Event('input', { bubbles: true }));
  subjectEl.dispatchEvent(new Event('change', { bubbles: true }));

  if (fromEl) {
    fromEl.value = ${JSON.stringify(fromAddress)};
    fromEl.dispatchEvent(new Event('input', { bubbles: true }));
    fromEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  bodyEl.focus();

  if (textareaBodyEl) {
    textareaBodyEl.value = ${JSON.stringify(html)};
    textareaBodyEl.dispatchEvent(new Event('input', { bubbles: true }));
    textareaBodyEl.dispatchEvent(new Event('change', { bubbles: true }));
    if (hiddenBodyEl) hiddenBodyEl.value = ${JSON.stringify(html)};
    if (isHtmlEl) isHtmlEl.value = '1';

    return {
      ok: true,
      mode: 'textarea',
      subjectValue: subjectEl.value,
      bodyPreview: textareaBodyEl.value.slice(0, 240),
      bodyHtmlLength: textareaBodyEl.value.length,
      toValue: toEl ? toEl.value : '',
      ccValue: ccEl ? ccEl.value : '',
      bccValue: bccEl ? bccEl.value : '',
      fromValue: fromEl ? fromEl.value : '',
      isHtmlValue: isHtmlEl ? isHtmlEl.value : '',
      hiddenBodyLength: hiddenBodyEl ? hiddenBodyEl.value.length : 0,
    };
  }

  bodyEl.innerHTML = ${JSON.stringify(html)};
  bodyEl.dispatchEvent(new Event('input', { bubbles: true }));

  return {
    ok: true,
    mode: 'rich',
    subjectValue: subjectEl.value,
    bodyPreview: bodyEl.innerText.slice(0, 240),
    bodyHtmlLength: bodyEl.innerHTML.length,
    toValue: toEl ? toEl.value : '',
    ccValue: ccEl ? ccEl.value : '',
    bccValue: bccEl ? bccEl.value : '',
    fromValue: fromEl ? fromEl.value : '',
  };
})()
`;
}

function buildSendExpression() {
  return `
(() => {
  const form = document.querySelector('form');
  const sendButton = Array.from(document.querySelectorAll('div[role="button"], button')).find((element) => {
    const label = [
      element.getAttribute('data-tooltip') || '',
      element.getAttribute('aria-label') || '',
      element.innerText || '',
    ]
      .join(' ')
      .trim();
    return /^send\\b/i.test(label);
  });

  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return { ok: true, mode: 'form-request-submit' };
  }

  if (form) {
    form.submit();
    return { ok: true, mode: 'form-submit' };
  }

  if (!sendButton) {
    return { ok: false, error: 'send button not found' };
  }

  sendButton.click();
  return { ok: true, mode: 'button-click' };
})()
`;
}

function buildPostSendExpression() {
  return `
(() => {
  const text = document.body.innerText || '';
  const subjectEl = document.querySelector('input[name="subjectbox"]');
  const bodyEl =
    document.querySelector('div[aria-label="Message Body"]') ||
    document.querySelector('div[role="textbox"][g_editable="true"]');
  const successIndicators = ['Message sent', 'Undo', 'View message'];

  return {
    title: document.title,
    href: window.location.href,
    composeStillOpen: !!subjectEl && !!bodyEl,
    hasSuccessIndicator: successIndicators.some((indicator) => text.includes(indicator)),
    textPreview: text.slice(0, 320),
  };
})()
`;
}

async function waitForComposeReady(client, expectedSubject, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const diagnostics = await client.evaluate(buildComposeDiagnosticsExpression());
    const ready =
      diagnostics &&
      diagnostics.bodyFound &&
      diagnostics.sendButtonFound &&
      diagnostics.querySubject === expectedSubject;

    if (ready) return diagnostics;
    await sleep(1000);
  }

  throw new Error('Timed out waiting for Gmail compose fields to become ready.');
}

async function main() {
  const shouldSend = hasFlag('--send');
  const selfTestMode = hasFlag('--self-test');
  const closeBrowser = hasFlag('--close-browser');
  const verbose = hasFlag('--verbose') || !shouldSend;

  const profileName = getChromeProfileName();
  const from = readRequiredEnv('OUTREACH_FROM');
  const to = selfTestMode ? readRequiredEnv('OUTREACH_TO') : readArgValue('--to') || readRequiredEnv('OUTREACH_TO');
  const cc = selfTestMode ? '' : readArgValue('--cc') ?? readOptionalEnv('OUTREACH_CC');
  const subject = readArgValue('--subject') || readRequiredEnv('OUTREACH_SUBJECT');
  const bodyPath = path.resolve(repoRoot, readRequiredEnv('OUTREACH_BODY_FILE'));
  const htmlBodyPath = path.resolve(
    repoRoot,
    readArgValue('--html-body-file') || readRequiredEnv('OUTREACH_HTML_BODY_FILE')
  );
  const bccCsvPath = path.resolve(repoRoot, readRequiredEnv('OUTREACH_BCC_CSV'));
  const bccEmails = selfTestMode ? [] : readCsvEmails(bccCsvPath);

  const textBody = fs.readFileSync(bodyPath, 'utf8').trim();
  const htmlBody = fs.readFileSync(htmlBodyPath, 'utf8').trim();
  const composeUrl = buildComposeUrl({
    to,
    cc,
    bcc: bccEmails.join(','),
    subject,
    body: textBody,
  });

  const port = await getOpenPort();
  const chromeBinary = resolveChromeBinary();
  const tempUserDataDir = cloneChromeProfile(profileName);

  console.log(`Mode: ${selfTestMode ? 'self-test' : 'outreach'}`);
  console.log(`From alias requested: ${from}`);
  console.log(`To: ${to}`);
  console.log(`Cc: ${cc || '(none)'}`);
  console.log(`Bcc recipient count: ${bccEmails.length}`);
  console.log(`Subject: ${subject}`);
  console.log(`Chrome profile: ${profileName}`);
  console.log(`Debug port: ${port}`);
  console.log(`Temp user data dir: ${tempUserDataDir}`);

  launchChrome({
    chromeBinary,
    userDataDir: tempUserDataDir,
    profileName,
    port,
    url: composeUrl,
  });

  const composeTab = await waitForComposeTab(port, 90000);
  console.log(`Compose tab title: ${composeTab.title}`);

  const client = new CdpClient(composeTab.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  const initialDiagnostics = await waitForComposeReady(client, subject, 90000);
  if (verbose) {
    console.log(`Initial diagnostics: ${JSON.stringify(initialDiagnostics)}`);
  }
  console.log(`Query Bcc count in Gmail tab: ${initialDiagnostics.queryBccCount}`);
  console.log(`Visible email-like strings: ${initialDiagnostics.emailishTexts.join(', ')}`);

  if (verbose) {
    const elementInventory = await client.evaluate(buildElementInventoryExpression());
    console.log(`Element inventory: ${JSON.stringify(elementInventory)}`);
  }

  const htmlResult = await client.evaluate(buildSetHtmlExpression(subject, htmlBody, from));
  if (!htmlResult?.ok) {
    console.log(`HTML body result: ${JSON.stringify(htmlResult)}`);
    throw new Error(htmlResult?.error || 'Failed to set the HTML email body.');
  }

  console.log(
    `HTML body applied. To value: ${htmlResult.toValue || '(blank)'}. Cc value: ${htmlResult.ccValue || '(blank)'}. Bcc length: ${htmlResult.bccValue ? htmlResult.bccValue.split(',').filter(Boolean).length : 0}. From value: ${htmlResult.fromValue || '(blank)'}. Preview: ${htmlResult.bodyPreview}`
  );

  if (!shouldSend) {
    console.log('Inspect-only run complete. No email was sent.');
    client.close();
    return;
  }

  const sendResult = await client.evaluate(buildSendExpression());
  if (!sendResult?.ok) {
    throw new Error(sendResult?.error || 'Failed to trigger the Gmail send action.');
  }

  await sleep(4000);
  const postSend = await client.evaluate(buildPostSendExpression());

  console.log(`Post-send compose still open: ${postSend.composeStillOpen}`);
  console.log(`Post-send success indicator: ${postSend.hasSuccessIndicator}`);
  console.log(`Post-send title: ${postSend.title}`);

  if (!postSend.hasSuccessIndicator && postSend.composeStillOpen) {
    console.log(`Post-send text preview: ${postSend.textPreview}`);
    throw new Error('The Gmail compose stayed open and no success indicator was detected.');
  }

  if (closeBrowser) {
    try {
      await client.send('Browser.close');
    } catch (error) {
      // If the browser is already closing, we can ignore the CDP error.
    }
  }

  client.close();
  console.log('Email send flow completed.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
