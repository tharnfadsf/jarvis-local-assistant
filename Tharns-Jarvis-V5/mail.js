'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const os = require('os');

function loadEnv(root) {
  // JARVIS_ENV_FILE isolates automated tests from the user's real .env file.
  const envPath = process.env.JARVIS_ENV_FILE || path.join(root, '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch {}
}

function mailConfig(root) {
  loadEnv(root);
  const user = String(process.env.JARVIS_SMTP_USER || process.env.JARVIS_EMAIL_USER || '').trim();
  const pass = String(process.env.JARVIS_SMTP_PASS || process.env.JARVIS_EMAIL_PASS || '').trim();
  const host = String(process.env.JARVIS_SMTP_HOST || (user.endsWith('@gmail.com') ? 'smtp.gmail.com' : '')).trim();
  const port = Number(process.env.JARVIS_SMTP_PORT || (host === 'smtp.gmail.com' ? 587 : 587));
  const from = String(process.env.JARVIS_EMAIL_FROM || user).trim();
  const imapHost = String(process.env.JARVIS_IMAP_HOST || (host === 'smtp.gmail.com' ? 'imap.gmail.com' : '')).trim();
  const imapPort = Number(process.env.JARVIS_IMAP_PORT || 993);
  const defaultAccount = String(process.env.JARVIS_GOOGLE_ACCOUNT || '').trim();
  const configured = Boolean(host && user && pass);
  return {
    configured,
    defaultAccount: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(defaultAccount) ? defaultAccount : null,
    canSend: configured,
    canRead: Boolean(imapHost && user && pass),
    host,
    port,
    user,
    from,
    imapHost,
    imapPort,
    secure: port === 465,
    message: configured
      ? 'Email sending uses SMTP with the saved account. Inbox listing uses IMAP when configured.'
      : 'No email account is connected. Add JARVIS_SMTP_HOST, JARVIS_SMTP_USER, and JARVIS_SMTP_PASS to the local .env file. For Gmail, use an App Password, not your normal password.'
  };
}

function validAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function draftsPath(root) {
  const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'JARVIS');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'mail-drafts.json');
}

function readDrafts(root) {
  try { return JSON.parse(fs.readFileSync(draftsPath(root), 'utf8')); } catch { return []; }
}

function saveDraft(root, draft) {
  const list = readDrafts(root);
  const item = {
    id: `draft-${Date.now()}`,
    to: String(draft.to || '').trim(),
    subject: String(draft.subject || '').trim(),
    body: String(draft.body || '').trim(),
    savedAt: new Date().toISOString()
  };
  list.unshift(item);
  fs.writeFileSync(draftsPath(root), JSON.stringify(list.slice(0, 30), null, 2));
  return item;
}

function rewriteDraft(draft, style) {
  const next = { to: draft.to || '', subject: draft.subject || '', body: draft.body || '' };
  const mode = String(style || '').toLowerCase();
  if (mode === 'subject') {
    next.subject = next.subject.replace(/^(re:\s*)+/i, '').trim() || 'Follow-up';
    return next;
  }
  if (mode === 'short' || mode === 'shorter') {
    const sentences = next.body.split(/(?<=[.!?])\s+/).filter(Boolean);
    next.body = sentences.slice(0, 2).join(' ');
    next.subject = next.subject.replace(/\s+/g, ' ').slice(0, 80);
    return next;
  }
  if (mode === 'friendly' || mode === 'casual') {
    next.body = next.body
      .replace(/^Dear [^,\n]+,/i, 'Hi,')
      .replace(/\nSincerely,[\s\S]*$/i, '\nThanks,\n');
    if (!/^hi\b/i.test(next.body)) next.body = `Hi,\n\n${next.body}`;
    return next;
  }
  next.body = next.body
    .replace(/^Hi,?\s*/i, 'Dear Teacher,\n\n')
    .replace(/\nThanks,?\s*$/i, '\nThank you for your time and understanding.\n\nSincerely,');
  if (!/dear /i.test(next.body)) next.body = `Dear Teacher,\n\n${next.body}`;
  if (!/sincerely/i.test(next.body)) next.body += '\n\nSincerely,';
  return next;
}

function encodeSubject(subject) {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function smtpRead(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r\n/);
      if (lines.length < 2) return;
      const complete = buf.match(/(?:^|\n)(\d{3})[ \-].*(?:\n\d{3} .*)*$/);
      const last = buf.trim().split(/\r\n/).filter(Boolean).pop() || '';
      if (/^\d{3} /.test(last) && buf.endsWith('\n')) {
        socket.off('data', onData);
        resolve({ code: Number(last.slice(0, 3)), text: buf });
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.setTimeout(25000, () => reject(new Error('The mail server timed out.')));
  });
}

function smtpWrite(socket, line) {
  socket.write(`${line}\r\n`);
}

async function smtpCommand(socket, line, ok) {
  if (line !== null) smtpWrite(socket, line);
  const reply = await smtpRead(socket);
  const allowed = Array.isArray(ok) ? ok : [ok];
  if (!allowed.includes(reply.code)) {
    const error = new Error(`Mail server replied ${reply.code}.`);
    error.smtp = reply.text.split(/\r\n/).filter(Boolean).pop();
    throw error;
  }
  return reply;
}

function startSocket(config) {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
      : net.connect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setEncoding('utf8');
    socket.once('error', reject);
  });
}

function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.setEncoding('utf8');
    secure.once('error', reject);
  });
}

async function sendMail(root, draft) {
  const config = mailConfig(root);
  if (!config.canSend) return { ok: false, status: 'not-configured', message: config.message };
  const to = String(draft.to || '').trim();
  const subject = String(draft.subject || '').trim();
  const body = String(draft.body || '').trim();
  if (!validAddress(to)) return { ok: false, status: 'invalid-recipient', message: 'That recipient does not look like an email address.' };
  if (!subject || !body) return { ok: false, status: 'incomplete', message: 'The draft still needs a subject and a message body.' };
  let socket;
  try {
    socket = await startSocket(config);
    await smtpCommand(socket, null, 220);
    await smtpCommand(socket, `EHLO jarvis.local`, 250);
    if (!config.secure) {
      await smtpCommand(socket, 'STARTTLS', 220);
      socket = await upgradeTls(socket, config.host);
      await smtpCommand(socket, `EHLO jarvis.local`, 250);
    }
    await smtpCommand(socket, 'AUTH LOGIN', 334);
    await smtpCommand(socket, Buffer.from(config.user).toString('base64'), 334);
    await smtpCommand(socket, Buffer.from(process.env.JARVIS_SMTP_PASS || process.env.JARVIS_EMAIL_PASS).toString('base64'), 235);
    await smtpCommand(socket, `MAIL FROM:<${config.from}>`, 250);
    await smtpCommand(socket, `RCPT TO:<${to}>`, [250, 251]);
    await smtpCommand(socket, 'DATA', 354);
    const payload = [
      `From: ${config.from}`,
      `To: ${to}`,
      `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body.replace(/^\./gm, '..')
    ].join('\r\n');
    smtpWrite(socket, `${payload}\r\n.`);
    const done = await smtpRead(socket);
    if (done.code !== 250) return { ok: false, status: 'provider-rejected', message: `The mail server did not accept the message (${done.code}). Nothing was confirmed sent.` };
    smtpWrite(socket, 'QUIT');
    return { ok: true, status: 'sent', message: `Sent. The mail server accepted the message to ${to}.` };
  } catch (error) {
    const text = String(error.smtp || error.message || '');
    if (/535|534|authentication/i.test(text)) return { ok: false, status: 'auth', message: 'Email authentication failed or expired. Update the app password in .env. Nothing was sent.' };
    if (/ECONNREFUSED|ENOTFOUND|timed out|ETIMEDOUT/i.test(error.message || '')) return { ok: false, status: 'network', message: 'I could not reach the mail server. Check the network and SMTP host. Nothing was sent.' };
    return { ok: false, status: 'failed', message: `Email send failed. I have not sent anything. ${error.message}` };
  } finally {
    try { socket?.end(); } catch {}
  }
}

function imapRead(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = chunk => {
      buf += chunk.toString('utf8');
      if (/\n[aA]\d+ (OK|NO|BAD)[^\n]*\n?$/.test(buf) || /\n\* BYE /.test(buf)) {
        socket.off('data', onData);
        resolve(buf);
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.setTimeout(25000, () => reject(new Error('The inbox server timed out.')));
  });
}

// Bounded preview of one message (first 1500 bytes, headers excluded).
// PEEK keeps the message unread; failures yield '' so listing still works.
async function fetchSnippet(command, seq) {
  try {
    const reply = await command(4, `FETCH ${seq} (BODY.PEEK[TEXT]<0.1500>)`);
    const at = reply.search(/BODY\[TEXT\]<\d+>\s*\{\d+\}\r\n/i);
    if (at < 0) return '';
    const start = reply.indexOf('\r\n', at) + 2;
    const len = Number((reply.slice(at).match(/\{(\d+)\}/) || [])[1] || 0);
    let text = reply.slice(start, start + Math.min(len, 1500));
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
    text = text.replace(/<[^>]{0,200}>/g, ' ').replace(/&(amp|lt|gt|quot|nbsp|#39);/gi, m => entities[m.toLowerCase()] || ' ');
    return text.replace(/\s+/g, ' ').trim().slice(0, 1200);
  } catch { return ''; }
}

async function listLatest(root, limit = 5) {
  const config = mailConfig(root);
  if (!config.canRead) return { ok: false, status: 'not-configured', message: 'Inbox reading is not configured. Add JARVIS_IMAP_HOST (imap.gmail.com for Gmail) plus the same user and app password.' };
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const secure = tls.connect({ host: config.imapHost, port: config.imapPort, servername: config.imapHost }, () => resolve(secure));
      secure.setEncoding('utf8');
      secure.once('error', reject);
    });
    const tag = (n) => `A${n}`;
    const command = async (n, line) => {
      socket.write(`${tag(n)} ${line}\r\n`);
      const reply = await imapRead(socket);
      if (/\nA\d+ (NO|BAD)/.test(reply)) {
        const err = new Error(reply.trim().split(/\r\n/).pop());
        err.imap = reply;
        throw err;
      }
      return reply;
    };
    await imapRead(socket);
    await command(1, `LOGIN "${config.user.replaceAll('"', '\\"')}" "${String(process.env.JARVIS_SMTP_PASS || process.env.JARVIS_EMAIL_PASS).replaceAll('"', '\\"')}"`);
    const selected = await command(2, 'EXAMINE INBOX');
    const exists = Number((selected.match(/\* (\d+) EXISTS/i) || [])[1] || 0);
    if (!exists) {
      socket.write('A9 LOGOUT\r\n');
      return { ok: true, emails: [], message: 'The inbox is empty.' };
    }
    const start = Math.max(1, exists - (limit - 1));
    const fetched = await command(3, `FETCH ${start}:${exists} (ENVELOPE)`);
    const emails = [];
    const envelopeRe = /\* \d+ FETCH \(ENVELOPE \(([\s\S]*?)\)\)/g;
    // Fallback parse of From/Subject lines in IMAP envelope strings. The
    // first quoted string is the date (absent when NIL); the subject follows.
    const looksDate = value => /(\d{1,2}\s+\w{3}\s+\d{4}|GMT|[+-]\d{4}\s*$)/.test(value || '');
    const blocks = fetched.split(/\* \d+ FETCH /).slice(1);
    for (const block of blocks.reverse()) {
      const seq = Number((block.match(/^(\d+)/) || [])[1] || 0);
      const strings = [...block.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(item => item[1].replace(/\\"/g, '"'));
      let date = '', rest = strings;
      if (strings.length && looksDate(strings[0])) { date = strings[0].slice(0, 80); rest = strings.slice(1); }
      const subject = rest[0] || '(no subject)';
      const from = rest.find(item => item.includes('@')) || rest[7] || 'unknown sender';
      const snippet = seq ? await fetchSnippet(command, seq) : '';
      emails.push({ from, subject, date, snippet });
      if (emails.length >= limit) break;
    }
    socket.write('A9 LOGOUT\r\n');
    if (!emails.length) return { ok: true, emails: [], message: 'I reached the inbox but could not parse message headers.' };
    const lines = emails.map((item, index) => `${index + 1}. ${item.from}: ${item.subject}${item.date ? ` (${item.date})` : ''}`).join(' ');
    return { ok: true, emails, message: `Latest emails: ${lines}` };
  } catch (error) {
    if (/AUTHENTICATIONFAILED|invalid credentials|NO LOGIN/i.test(String(error.imap || error.message))) {
      return { ok: false, status: 'auth', message: 'Inbox login failed. The app password may be expired. I did not change any mail.' };
    }
    return { ok: false, status: 'failed', message: `I could not read the inbox. ${error.message}` };
  } finally {
    try { socket?.end(); } catch {}
  }
}

function mailtoUrl(draft) {
  const to = encodeURIComponent(String(draft.to || '').trim()).replace(/%40/g, '@');
  const subject = encodeURIComponent(String(draft.subject || ''));
  const body = encodeURIComponent(String(draft.body || ''));
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

module.exports = { mailConfig, validAddress, saveDraft, readDrafts, rewriteDraft, sendMail, listLatest, mailtoUrl };
