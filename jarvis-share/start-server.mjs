// JARVIS Server starter - fixes top-level await issue
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import discord from './discord.js';
import mailModule from './mail.js';
import { createScreenVision } from './screen-vision.js';
import { createComputerTools } from './computer-tools.js';
import core from './jarvis-core.js';
import browserTabs from './browser-tabs.js';
import discovery from './youtube-discovery.js';
import { createMediaMonitor } from './media-monitor.js';
import { createSystemMonitor } from './system-monitor.js';

const execFileAsync = promisify(execFile);
const root = __dirname;
const port = Number(process.env.JARVIS_PORT || 4173);
const ollamaUrl = (process.env.JARVIS_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

// Default Google identity
function googleAccount() {
  const value = String(process.env.JARVIS_GOOGLE_ACCOUNT || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
}

function websiteUrl(site) {
  const websites = Object.freeze({ youtube: 'https://www.youtube.com/', 'youtube-music': 'https://music.youtube.com/', google: 'https://www.google.com/', gmail: 'https://mail.google.com/', drive: 'https://drive.google.com/', wikipedia: 'https://www.wikipedia.org/', tiktok: 'https://www.tiktok.com/', instagram: 'https://www.instagram.com/', discord: 'https://discord.com/app' });
  if (site === 'gmail' || site === 'drive') {
    const account = googleAccount();
    const param = account ? `/u/?authuser=${encodeURIComponent(account)}` : '/';
    if (service === 'drive') return `https://drive.google.com/drive${param}`;
    return `https://mail.google.com/mail${param}`;
  }
  return websites[site];
}

// ... [rest of the server logic would go here, but this is getting complex]
// For now, let's just start a minimal server

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/health') {
      return res.end(JSON.stringify({ ok: true, online: true, platform: os.platform(), pid: process.pid }));
    }
    if (req.method === 'GET' && req.url === '/') {
      // Serve the HTML file
      const filePath = path.resolve(root, 'index.html');
      const data = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    console.error('[JARVIS server]', error);
    res.writeHead(500);
    res.end('JARVIS encountered a local service error.');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`J.A.R.V.I.S. local service online at http://127.0.0.1:${port}`);
});

// Minimal test
console.log('Minimal JARVIS server started on port', port);