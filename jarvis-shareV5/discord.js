'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const API = 'https://discord.com/api/v10';

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

function discordConfig(root) {
  loadEnv(root);
  const token = String(process.env.DISCORD_BOT_TOKEN || '').trim();
  return {
    configured: Boolean(token),
    guildId: String(process.env.DISCORD_GUILD_ID || '').trim(),
    message: token
      ? 'Discord messages send as your JARVIS bot, not as your personal Discord user account.'
      : 'Discord is not connected. Create a Discord application bot, invite it to a shared server, then save DISCORD_BOT_TOKEN in the local .env file. JARVIS will not automate your user account.'
  };
}

function contactsPath(root) {
  const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'JARVIS');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'discord-contacts.json');
}

function loadContacts(root) {
  const files = [path.join(root, 'discord-contacts.json'), contactsPath(root)];
  const contacts = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const list = Array.isArray(data) ? data : data.contacts;
      for (const item of list || []) {
        if (item && item.id && (item.name || item.username)) contacts.push({
          name: String(item.name || item.username || ''),
          username: String(item.username || item.name || ''),
          aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
          id: String(item.id)
        });
      }
    } catch {}
  }
  return contacts;
}

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchContacts(root, spoken) {
  const query = normalizeName(spoken);
  if (!query) return { matches: [], query: spoken };
  if (/^\d{16,22}$/.test(String(spoken || '').trim())) {
    return { matches: [{ name: spoken.trim(), username: spoken.trim(), aliases: [], id: spoken.trim() }], query: spoken };
  }
  const matches = [];
  for (const contact of loadContacts(root)) {
    const names = [contact.name, contact.username, ...contact.aliases].map(normalizeName).filter(Boolean);
    if (names.some(name => name === query || name.startsWith(query) || query.startsWith(name))) matches.push(contact);
  }
  const unique = [];
  for (const item of matches) if (!unique.some(other => other.id === item.id)) unique.push(item);
  return { matches: unique, query: spoken };
}

async function discordRequest(token, method, route, body) {
  const response = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'JARVIS-Local/1.0'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { response, data };
}

async function searchGuildMembers(token, guildId, query) {
  if (!guildId || !query) return [];
  const { response, data } = await discordRequest(token, 'GET', `/guilds/${guildId}/members/search?query=${encodeURIComponent(query)}&limit=10`);
  if (!response.ok || !Array.isArray(data)) return [];
  return data.map(member => ({
    name: member.nick || member.user?.global_name || member.user?.username || '',
    username: member.user?.username || '',
    aliases: [member.user?.global_name, member.nick].filter(Boolean),
    id: String(member.user?.id || '')
  })).filter(item => item.id);
}

async function resolveRecipient(root, spoken) {
  const config = discordConfig(root);
  if (!config.configured) return { ok: false, status: 'not-configured', message: config.message };
  const local = matchContacts(root, spoken);
  if (local.matches.length === 1) return { ok: true, recipient: local.matches[0] };
  if (local.matches.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      matches: local.matches,
      message: `I found more than one Discord contact matching ${spoken}: ${local.matches.map(item => item.name || item.username).join(', ')}. Which person?`
    };
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  const guildHits = await searchGuildMembers(token, config.guildId, spoken);
  const unique = [];
  for (const item of guildHits) if (!unique.some(other => other.id === item.id)) unique.push(item);
  if (unique.length === 1) return { ok: true, recipient: unique[0] };
  if (unique.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      matches: unique,
      message: `Several server members match ${spoken}: ${unique.map(item => item.username || item.name).join(', ')}. Tell me the exact username.`
    };
  }
  return { ok: false, status: 'not-found', message: `I couldn't safely identify a Discord user named ${spoken}. Save them in discord-contacts.json with their user ID, or set DISCORD_GUILD_ID so I can search a shared server.` };
}

async function sendDirectMessage(root, recipientId, content) {
  const config = discordConfig(root);
  if (!config.configured) return { ok: false, status: 'not-configured', message: config.message };
  const text = String(content || '').trim();
  if (!text) return { ok: false, status: 'incomplete', message: 'The Discord message is empty. I have not sent anything.' };
  if (!/^\d{16,22}$/.test(String(recipientId || ''))) return { ok: false, status: 'not-found', message: 'That Discord user ID is not valid. Nothing was sent.' };
  const token = process.env.DISCORD_BOT_TOKEN;
  try {
    const channel = await discordRequest(token, 'POST', '/users/@me/channels', { recipient_id: String(recipientId) });
    if (channel.response.status === 401 || channel.response.status === 403) {
      return { ok: false, status: 'auth', message: 'Discord authentication failed or the bot is missing permission. Nothing was sent.' };
    }
    if (!channel.response.ok || !channel.data.id) {
      const detail = channel.data.message || `HTTP ${channel.response.status}`;
      if (channel.response.status === 429) return { ok: false, status: 'rate-limit', message: 'Discord rate-limited the bot. Nothing was sent. Try again in a moment.' };
      return { ok: false, status: 'failed', message: `Discord message failed. I haven't sent anything. ${detail}` };
    }
    const sent = await discordRequest(token, 'POST', `/channels/${channel.data.id}/messages`, { content: text.slice(0, 2000) });
    if (sent.response.status === 401 || sent.response.status === 403) {
      return { ok: false, status: 'auth', message: 'Discord rejected the send. The bot may be blocked from DMs or missing access. Nothing was confirmed sent.' };
    }
    if (!sent.response.ok || !sent.data.id) {
      if (sent.response.status === 429) return { ok: false, status: 'rate-limit', message: 'Discord rate-limited the bot. Nothing was sent.' };
      return { ok: false, status: 'failed', message: `Discord message failed. I haven't sent anything. ${sent.data.message || `HTTP ${sent.response.status}`}` };
    }
    return { ok: true, status: 'sent', id: sent.data.id, message: 'Sent.' };
  } catch (error) {
    return { ok: false, status: 'network', message: `Discord is unavailable. I haven't sent anything. ${error.message}` };
  }
}

// Reminder-notification channel (separate from bot DMs). The webhook URL is
// treated as a secret: it is read from the environment at send time, used
// only as the fetch target, and NEVER returned, logged, or included in any
// message. Mentions are restricted to the single configured user ID.
function webhookConfig(root) {
  loadEnv(root);
  const url = String(process.env.JARVIS_DISCORD_WEBHOOK_URL || '').trim();
  const mentionId = String(process.env.JARVIS_DISCORD_MENTION_ID || '').trim();
  const validUrl = /^https:\/\/(?:ptb\.|canary\.)?discord\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(url);
  const validMention = /^\d{16,22}$/.test(mentionId);
  return {
    configured: validUrl,
    hasMention: validMention,
    mentionId: validMention ? mentionId : '',
    message: validUrl
      ? (validMention ? 'Discord reminder notifications send to the configured channel with an account mention.' : 'Discord reminder notifications send to the configured channel. Set JARVIS_DISCORD_MENTION_ID for an account mention.')
      : 'Discord notifications are not configured. Set JARVIS_DISCORD_WEBHOOK_URL in the local .env file (rotate any previously exposed URL first; never reuse it).'
  };
}

async function sendWebhookNotification(root, text, opts = {}) {
  const config = webhookConfig(root);
  if (!config.configured) return { ok: false, status: 'not-configured', message: config.message };
  const clean = String(text || '').trim().slice(0, 1800);
  if (!clean) return { ok: false, status: 'incomplete', message: 'The notification text is empty. Nothing was sent.' };
  const safe = clean.replace(/@(everyone|here)/gi, '@ $1');
  const content = (config.hasMention ? `<@${config.mentionId}> ` : '') + safe;
  const url = String(process.env.JARVIS_DISCORD_WEBHOOK_URL || '').trim();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'JARVIS-Local/1.0' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [], users: config.hasMention ? [config.mentionId] : [] } }),
      signal: AbortSignal.timeout(opts.timeoutMs || 20000)
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, status: 'auth', message: 'Discord rejected the webhook URL (invalid or revoked). Nothing was sent. Set a fresh JARVIS_DISCORD_WEBHOOK_URL.' };
    }
    if (response.status === 429) return { ok: false, status: 'rate-limit', message: 'Discord rate-limited notifications. Will retry later.' };
    if (!response.ok) return { ok: false, status: 'failed', message: `Discord notification failed (HTTP ${response.status}). Will retry later.` };
    return { ok: true, status: 'sent', message: 'Notification delivered.' };
  } catch (error) {
    return { ok: false, status: 'network', message: `Discord is unreachable (${error.message}). Will retry later.` };
  }
}

module.exports = { discordConfig, loadContacts, matchContacts, resolveRecipient, sendDirectMessage, webhookConfig, sendWebhookNotification };
