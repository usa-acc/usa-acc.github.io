#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

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

function encodeField(value) {
  return encodeURIComponent(value).replace(/%20/g, '+');
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

function openInChrome(url, browserApp) {
  const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedBrowser = browserApp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `
tell application "${escapedBrowser}"
  activate
  if (count of windows) = 0 then make new window
  tell window 1
    make new tab with properties {URL:"${escapedUrl}"}
    set active tab index to (count of tabs)
  end tell
end tell
`;

  const result = spawnSync('osascript', ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'osascript failed');
  }
}

function readArgValue(flag) {
  const prefix = `${flag}=`;
  const valueArg = process.argv.find((arg) => arg.startsWith(prefix));
  if (!valueArg) return null;
  return valueArg.slice(prefix.length).trim();
}

function main() {
  const shouldOpen = process.argv.includes('--open');
  const selfTestMode = process.argv.includes('--self-test');
  const csvOverride = readArgValue('--bcc-csv');
  const bodyFileOverride = readArgValue('--body-file');
  const toOverride = readArgValue('--to');
  const ccOverride = readArgValue('--cc');
  const bccOverride = readArgValue('--bcc');
  const subjectOverride = readArgValue('--subject');

  const bodyPath = path.resolve(
    repoRoot,
    bodyFileOverride || readRequiredEnv('OUTREACH_BODY_FILE')
  );

  const to = selfTestMode ? readRequiredEnv('OUTREACH_TO') : toOverride || readRequiredEnv('OUTREACH_TO');
  const cc = selfTestMode ? '' : ccOverride ?? readOptionalEnv('OUTREACH_CC');
  const from = readRequiredEnv('OUTREACH_FROM');
  const subject = subjectOverride || readRequiredEnv('OUTREACH_SUBJECT');
  const browserApp = readOptionalEnv('OUTREACH_BROWSER_APP', 'Google Chrome');
  const bccEmails = selfTestMode
    ? []
    : bccOverride
      ? bccOverride
          .split(',')
          .map((email) => email.trim())
          .filter(Boolean)
      : readCsvEmails(path.resolve(repoRoot, csvOverride || readRequiredEnv('OUTREACH_BCC_CSV')));
  const body = fs.readFileSync(bodyPath, 'utf8').trim();
  const composeUrl = buildComposeUrl({
    to,
    cc,
    bcc: bccEmails.join(','),
    subject,
    body,
  });

  console.log(`Mode: ${selfTestMode ? 'self-test' : 'outreach'}`);
  console.log(`From alias requested: ${from}`);
  console.log(`To: ${to}`);
  console.log(`Cc: ${cc || '(none)'}`);
  console.log(`Bcc recipient count: ${bccEmails.length}`);
  console.log(`Subject: ${subject}`);
  console.log('');
  console.log(composeUrl);

  if (shouldOpen) {
    openInChrome(composeUrl, browserApp);
    console.log('');
    console.log(`Opened Gmail compose in ${browserApp}.`);
    console.log(
      'Gmail controls To/Cc/Bcc/Subject/Body from the compose URL, but the From alias still depends on the alias configured in Gmail.'
    );
  }
}

main();
