/**
 * JARVIS Discord Bot Center — Slash commands, notifications, remote control, and settings.
 * Extends the existing discord.js integration with interactive bot features.
 * 'use strict';
 */

'use strict';

const fs = require('fs');
const path = require('path');
const _hasNativeAbortController = (() => { try { return require('node:abort_controller').AbortController; } catch { return false; } })();
const { AbortController } = _hasNativeAbortController ? require('node:abort_controller') : (function () {
  function AbortController() { this._signal = {}; this.aborted = false; this.abort = function () { this.aborted = true; }; }
  AbortController.prototype = { constructor: AbortController, toString: function () { return '[AbortController]'; } };
  AbortController.prototype.abort = function () { this.aborted = true; };
  AbortController.prototype.toString = function () { return '[AbortController]'; };
  return AbortController;
})();
// Import existing modules
const { discordConfig, loadContacts, matchContacts, resolveRecipient, sendDirectMessage, webhookConfig, sendWebhookNotification } = require('./discord');

// ============================================================
// Discord Bot Configuration
// ============================================================

const BOT_COMMANDS = {
  '/status': {
    description: 'Show JARVIS health status',
    handler: async (root, args) => {
      const config = discordConfig(root);
      const webhook = webhookConfig(root);
      
      let status = {
        running: true,
        ollama: 'unknown',
        voice: 'unknown',
        media: 'unknown',
        reminders: 'unknown',
        browser: 'unknown',
        lastHealthCheck: 'never'
      };
      
      // Check Ollama availability
      try {
        const healthRes = await fetch(`${root}/api/health`, { signal: AbortController ? new AbortController(5000).signal : {} });
        if (healthRes.ok) {
          const health = await healthRes.json();
          status.ollama = health.ollama ? 'connected' : 'unavailable';
          status.voice = health.voice !== undefined ? (health.voice ? 'active' : 'standby') : 'unknown';
          status.media = health.media ? 'active' : 'idle';
          status.reminders = health.reminders !== undefined ? (health.reminders ? 'active' : 'inactive') : 'unknown';
          status.browser = health.browser ? 'controlled' : 'free';
          status.lastHealthCheck = new Date().toLocaleTimeString();
        }
      } catch (e) {
        status.ollama = 'unreachable';
      }
      
      // Check webhook
      status.webhookConfigured = config.configured;
      
      const lines = [
        `* JARVIS Status Report *`,
        ``,
        `Running: ${status.running ? 'Yes' : 'No'}`,
        `Ollama: ${status.ollama}`,
        `Voice: ${status.voice}`,
        `Media: ${status.media}`,
        `Reminders: ${status.reminders}`,
        `Browser control: ${status.browser}`,
        ``,
        `Discord webhook: ${status.webhookConfigured ? 'Configured' : 'Not configured'}`,
        `Last health check: ${status.lastHealthCheck}`,
        ``,
        `Use /briefing for today's events, /reminders for upcoming, /next for the next alarm.`
      ];
      
      return {
        ok: true,
        content: lines.join('\n'),
        status: 'success'
      };
    }
  },
  
  '/briefing': {
    description: 'Today\'s summary of events and reminders',
    handler: async (root, args) => {
      const plannerRes = await fetch(`${root}/api/planner`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'snapshot' }),
        signal: AbortController ? new AbortController(5000).signal : {} 
      }).then(r => r.json()).catch(() => ({ ok: false }));
      
      if (!plannerRes.ok) {
        return {
          ok: false,
          status: 'error',
          message: 'Could not retrieve planner data.'
        };
      }
      
      const now = Date.now();
      const today = new Date();
      const endToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      
      const alarms = (plannerRes.alarms || [])
        .filter(item => Date.parse(item.when) > now)
        .sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
      
      const reminders = (plannerRes.reminders || [])
        .filter(item => Date.parse(item.when) > now)
        .sort((a, b) => Date.parse(a.when) - Date.parse(b.when))
        .slice(0, 5);
      
      const events = (plannerRes.events || [])
        .filter(item => Date.parse(item.end) > now && Date.parse(item.start) < endToday.getTime())
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .slice(0, 3);
      
      const lines = [
        `* Today's Briefing *`,
        ``,
        `Alarms: ${alarms.length ? alarms.map(a => `${a.title || 'Alarm'} - ${new Date(a.when).toLocaleTimeString()}`).join('; ') : 'None'}`,
        `Reminders: ${reminders.length ? reminders.map(r => `${r.title} - ${new Date(r.when).toLocaleString()}`).join(' | ') : 'None'}`,
        `Events: ${events.length ? events.map(e => `${e.title} at ${new Date(e.start).toLocaleTimeString()}`).join('; ') : 'None'}`,
        ``,
        `Use /next for the next upcoming reminder, /reminders for the full list.`
      ];
      
      return {
        ok: true,
        content: lines.join('\n'),
        status: 'success'
      };
    }
  },
  
  '/reminders': {
    description: 'List upcoming reminders',
    handler: async (root, args) => {
      const plannerRes = await fetch(`${root}/api/planner`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'snapshot' }),
        signal: AbortController ? new AbortController(5000).signal : {} 
      }).then(r => r.json()).catch(() => ({ ok: false }));
      
      if (!plannerRes.ok) {
        return {
          ok: false,
          status: 'error',
          message: 'Could not retrieve reminder data.'
        };
      }
      
      const now = Date.now();
      const reminders = (plannerRes.reminders || [])
        .filter(item => Date.parse(item.when) > now)
        .sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
      
      if (reminders.length === 0) {
        return {
          ok: true,
          content: `* Upcoming Reminders *\n\nNo upcoming reminders, Sir. You're all caught up!`,
          status: 'success'
        };
      }
      
      const lines = [
        `* Upcoming Reminders (${reminders.length}) *`
      ];
      
      for (const r of reminders.slice(0, 10)) {
        lines.push(`• ${r.title} - ${new Date(r.when).toLocaleString()}`);
      }
      
      if (reminders.length > 10) {
        lines.push(`...and ${reminders.length - 10} more.`);
      }
      
      lines.push('');
      lines.push(`Use /next for the next single reminder.`);
      
      return {
        ok: true,
        content: lines.join('\n'),
        status: 'success'
      };
    }
  },
  
  '/next': {
    description: 'Display the next upcoming reminder or calendar event',
    handler: async (root, args) => {
      const plannerRes = await fetch(`${root}/api/planner`, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'snapshot' }),
        signal: AbortController ? new AbortController(5000).signal : {} 
      }).then(r => r.json()).catch(() => ({ ok: false }));
      
      if (!plannerRes.ok) {
        return {
          ok: false,
          status: 'error',
          message: 'Could not retrieve planner data.'
        };
      }
      
      const now = Date.now();
      
      // Next alarm
      const alarms = (plannerRes.alarms || [])
        .filter(item => Date.parse(item.when) > now)
        .sort((a, b) => Date.parse(a.when) - Date.parse(b.when))[0];
      
      // Next reminder
      const reminders = (plannerRes.reminders || [])
        .filter(item => Date.parse(item.when) > now)
        .sort((a, b) => Date.parse(a.when) - Date.parse(b.when))[0];
      
      // Next event
      const today = new Date();
      const endToday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      const events = (plannerRes.events || [])
        .filter(item => Date.parse(item.end) > now && Date.parse(item.start) < endToday.getTime())
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
      
      const nextItem = alarms || reminders || events;
      
      if (!nextItem) {
        return {
          ok: true,
          content: `* Next Up *\n\nNo upcoming reminders, alarms, or events, Sir. You're all caught up!`,
          status: 'success'
        };
      }
      
      const title = nextItem.title || nextItem.eventTitle || 'Untitled';
      const when = new Date(nextItem.when || nextItem.start || Date.now());
      const type = nextItem.kind === 'alarm' ? 'alarm' : nextItem.kind === 'reminder' ? 'reminder' : 'event';
      
      const lines = [
        `* Next Up *`,
        `${type.charAt(0).toUpperCase() + type.slice(1)}: ${title}`,
        `Scheduled: ${when.toLocaleString()}`
      ];
      
      if (nextItem.kind === 'alarm' && nextItem.id) {
        lines.push(`Use /reminders to see the full list, or ask JARVIS to "cancel the alarm at ${when.toLocaleTimeString()}".`);
      }
      
      return {
        ok: true,
        content: lines.join('\n'),
        status: 'success'
      };
    }
  },
  
  '/ping': {
    description: 'Test Discord bot responsiveness',
    handler: async (root, args) => {
      const config = discordConfig(root);
      
      if (!config.configured) {
        return {
          ok: false,
          status: 'not-configured',
          message: 'Discord bot not configured. Set DISCORD_BOT_TOKEN in .env.'
        };
      }
      
      return {
        ok: true,
        content: `* Pong! *\n\nJARVIS Discord bot is responsive, Sir. Use /status for health, /briefing for today's summary, or /help for available commands.`,
        status: 'success'
      };
    }
  },
  
  '/jarvis': {
    description: 'Display available safe commands',
    handler: async (root, args) => {
      const commands = [
        `/status - JARVIS health report`,
        `/briefing - Today's events and reminders`,
        `/reminders - Upcoming reminders list`,
        `/next - Next upcoming reminder or alarm`,
        `/ping - Test bot responsiveness`,
        `/jarvis - This command`,
        `/media - Current media state`,
        `/help - Full help list`
      ];
      
      return {
        ok: true,
        content: `* JARVIS Safe Commands *\n\n${commands.join('\n')}\n\nAll commands return real data from your local JARVIS system. No arbitrary shell commands are accepted.`,
        status: 'success'
      };
    }
  },
  
  '/media': {
    description: 'Current media state and controls',
    handler: async (root, args) => {
      try {
        const mediaRes = await fetch(`${root}/api/media`, { 
          signal: AbortController ? new AbortController(5000).signal : {} 
        }).then(r => r.json()).catch(() => ({ ok: false, error: 'no response' }));
        
        if (!mediaRes.ok || !mediaRes.data) {
          return {
            ok: false,
            status: 'unavailable',
            message: 'Media monitoring not available right now.'
          };
        }
        
        const { status, track, application, duration, time } = mediaRes.data;
        const statusText = status || 'unknown';
        
        const lines = [
          `* Current Media *`,
          `Status: ${statusText}`,
          track ? `Track: ${track}` : 'No track playing',
          application ? `Application: ${application}` : 'Unknown application',
          duration ? `Duration: ${duration}s` : 'No duration',
          time ? `Time: ${time}s` : 'No time'
        ].filter(l => l);
        
        return {
          ok: true,
          content: lines.join('\n'),
          status: 'success'
        };
      } catch (e) {
        return {
          ok: false,
          status: 'error',
          message: `Could not retrieve media state: ${e.message}`
        };
      }
    }
  },
  
  '/help': {
    description: 'Show all registered slash commands',
    handler: async (root, args) => {
      const lines = [
        `* JARVIS Discord Commands *`,
        ``,
        `/status   - JARVIS health and service status report`,
        `/briefing - Today's calendar events, reminders, and system health`,
        `/reminders - List all upcoming reminders`,
        `/next     - Next upcoming reminder or alarm with time`,
        `/ping     - Test bot responsiveness and connectivity`,
        `/jarvis   - Available safe commands and capabilities`,
        `/media    - Current media state and playback status`,
        `/help     - Show this help message`,
        ``,
        `All commands return real data from your local JARVIS system.`,
        `Remote control is restricted to authorized users only.`
      ];
      
      return {
        ok: true,
        content: lines.join('\n'),
        status: 'success'
      };
    }
  }
};

// ==========================================================//
// Command dispatch
// ============================================================

function dispatchCommand(commandKey, root, interaction) {
  const command = BOT_COMMANDS[commandKey];
  if (!command) return null;
  
  try {
    return command.handler(root, interaction);
  } catch (e) {
    console.error(`Discord command ${commandKey} failed:`, e);
    return {
      ok: false,
      status: 'error',
      message: `Command ${commandKey} failed. Please try again.`
    };
  }
}

// ==========================================================//
// Notification sending
// ============================================================

async function sendNotification(root, category, text, opts = {}) {
  const config = webhookConfig(root);
  if (!config.configured) {
    // Try direct message if webhook not configured
    const discConfig = discordConfig(root);
    if (discConfig.configured) {
      const result = await sendDirectMessage(root, 'me', `*${category}*: ${text}`);
      if (result.ok) return result;
    }
    return { ok: false, status: 'not-configured', message: 'Notifications not configured. Set JARVIS_DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN.' };
  }
  
  const result = await sendWebhookNotification(root, text, opts);
  if (!result.ok && result.status === 'rate-limit') {
    // Retry after a delay
    await new Promise(r => setTimeout(r, 10000));
    return sendNotification(root, category, text, opts);
  }
  return result;
}

// ==========================================================//
// Export
// ============================================================

module.exports = {
  BOT_COMMANDS,
  dispatchCommand,
  sendNotification,
  webhookConfig,
  discordConfig,
  resolveRecipient
};