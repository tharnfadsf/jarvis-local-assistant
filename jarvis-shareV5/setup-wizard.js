// =====================================================================
// JARVIS Share — in-app setup wizard front end (2026-10-28).
// Isolated module: it renders ONE overlay section appended to <body> and
// never touches the main dashboard code. Talks only to /api/setup/*.
//
// Steps: 1 Welcome & platform · 2 AI provider · 3 Credentials (masked,
// Test Connection) · 4 Local AI (Ollama) · 5 Voice · 6 Integrations
// (permission-aware) · 7 Save & finish. Setup is resumable: the closing
// state lives server-side in /api/setup/status -> setupState.
//
// Secrets: typed key fields stay type=password with a show/hide toggle,
// are remembered in page memory ONLY while the step is open, and are sent
// neverlogged, never displayed. Every network call is made only when the
// user clicks Test, Save or Finish — never on typing.
// =====================================================================
'use strict';

(function setupWizardModule() {
  const state = {
    status: null,          // GET /api/setup/status payload
    step: 1,               // 1..7
    provider: 'local',
    fields: {              // values for THIS step only (never persisted on page)
      apiKey: '', baseUrl: '', model: '',
      fishApiKey: '', fishVoiceId: ''
    },
    providerStatus: null,
    notice: '',
    noticeLevel: 'ok',     // ok | error | warn
    busy: false,
    micDevices: [],
    micDeviceId: '',
    ttsProvider: 'fish',   // fish | local
    integrations: { tabControl: 'auto' }
  };

  // ---------- tiny helpers ----------
  const $ = (sel, el) => (el || document).querySelector(sel);
  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function post(route, body) {
    const res = await fetch(route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(process.env && process.env.JARVIS_SETUP_TIMEOUT || 40000)
    });
    const data = await res.json().catch(() => ({}));
    return data;
  }

  function showNotice(message, level) {
    state.notice = String(message || '');
    state.noticeLevel = level || 'ok';
    const box = $('#swNotice');
    if (box) {
      box.textContent = state.notice;
      box.dataset.level = state.noticeLevel;
      box.style.display = state.notice ? 'block' : 'none';
    }
  }

  function setBusy(value) {
    state.busy = value;
    const next = $('#swNext'), test = $('#swTest'), save = $('#swSave');
    [next, test, save].forEach(el => { if (el) el.disabled = value; });
    $('#swOverlay')?.classList.toggle('busy', value);
  }

  // ---------- overlay creation ----------
  function ensureOverlay() {
    if ($('#swOverlay')) return;
    const section = document.createElement('section');
    section.id = 'swOverlay';
    section.setAttribute('role', 'dialog');
    section.setAttribute('aria-label', 'JARVIS setup');
    section.innerHTML = `
      <div class="sw-panel card">
        <div class="cardhead"><span id="swHead">JARVIS SETUP</span><span id="swStepCap">STEP 1 / 7</span>
          <button class="chip" id="swClose" type="button" title="Continue using JARVIS; you can reopen setup later">SKIP</button></div>
        <div class="sw-progress"><div class="sw-progress-fill" id="swProgress"></div></div>
        <div class="sw-body" id="swBody"></div>
        <div class="sw-status" id="swNotice" style="display:none"></div>
        <div class="sw-actions">
          <button class="chip" id="swBack" type="button">BACK</button>
          <button class="chip primary" id="swNext" type="button">NEXT</button>
          <button class="chip" id="swTest" type="button" style="display:none">TEST CONNECTION</button>
          <button class="chip" id="swSave" type="button" style="display:none">SAVE ONLY</button>
          <button class="chip primary" id="swFinish" type="button" style="display:none">FINISH SETUP</button>
        </div>
      </div>`;
    document.body.appendChild(section);

    $('#swClose').addEventListener('click', () => closeOverlay(true));
    $('#swBack').addEventListener('click', () => { if (!state.busy && state.step > 1) { state.step -= 1; render(); } });
    $('#swNext').addEventListener('click', () => onNext());
    $('#swTest').addEventListener('click', () => onTest());
    $('#swSave').addEventListener('click', () => onSave(false));
    $('#swFinish').addEventListener('click', () => onSave(true));
    render();
  }

  function closeOverlay(skipped) {
    const o = $('#swOverlay');
    if (o) o.remove();
    // A skipped wizard saves progress so reopen starts where the user left off.
    if (skipped && state.status) {
      post('/api/setup/save', { step: state.step }).catch(() => {});
    }
  }

  // ---------- rendering per step ----------
  function render() {
    const body = $('#swBody');
    if (!body) return;
    $('#swStepCap').textContent = `STEP ${state.step} / 7`;
    $('#swProgress').style.width = `${Math.round((state.step / 7) * 100)}%`;
    $('#swBack').style.visibility = state.step > 1 ? 'visible' : 'hidden';
    const makers = { 1: stepWelcome, 2: stepProvider, 3: stepCredentials, 4: stepLocalAi, 5: stepVoice, 6: stepIntegrations, 7: stepFinish };
    (makers[state.step] || stepWelcome)(body);
    showNotice(state.notice, state.noticeLevel); // restore last notice when re-rendering
  }

  function stepWelcome(body) {
    const s = state.status || {};
    const p = s.platform || {};
    const os = p.isArchLinux ? `Arch Linux (${esc(p.arch)})` : `${esc(p.os || 'Unrecognized OS')} ${esc(p.osVersion || '')} (${esc(p.arch || '?')})`;
    const store = s.credentialStore || {};
    const full = (s.features || []).filter(f => f.status === 'full').length;
    const total = (s.features || []).length;
    body.innerHTML = `
      <h3 class="sw-title">Welcome to J.A.R.V.I.S.</h3>
      <p class="sw-copy">A few steps to connect the assistant to the AI you choose. Your keys stay on this computer${store.ok ? ` (encrypted via ${esc(store.backend)})` : ''}.</p>
      <div class="sw-grid">
        <span class="k">DETECTED SYSTEM</span><span class="v">${os}</span>
        <span class="k">APP RUNNING AS</span><span class="v">Node ${esc(p.node || '')} on ${esc(p.host || '')}</span>
        <span class="k">CREDENTIAL STORE</span><span class="v ${store.ok ? 'ok' : 'bad'}">${store.ok ? `${esc(store.backend)} (encrypted)` : 'Not available — see step 3'}</span>
        <span class="k">PLATFORM FEATURES</span><span class="v">${full}/${total} fully supported here</span>
      </div>
      <p class="sw-copy sw-small">Choose an AI provider next; two of them are free-tier external services and one is fully local (Ollama). Nothing is sent anywhere until you save or test it.</p>`;
    $('#swNext').textContent = 'NEXT';
    $('#swTest').style.display = 'none';
    $('#swSave').style.display = 'none';
    $('#swFinish').style.display = 'none';
    $('#swNext').disabled = false;
  }

  function stepProvider(body) {
    const providers = (state.status && state.status.providers) || [];
    body.innerHTML = `
      <h3 class="sw-title">Choose your AI provider</h3>
      <p class="sw-copy">Only providers this build actually supports are listed.</p>
      <div class="sw-choices">${providers.map(pr => `
        <label class="sw-choice ${state.provider === pr.id ? 'on' : ''}">
          <input type="radio" name="swProvider" value="${esc(pr.id)}" ${state.provider === pr.id ? 'checked' : ''}>
          <span><b>${esc(pr.label)}</b><small>${esc(pr.note)}</small></span>
        </label>`).join('')}</div>`;
    body.querySelectorAll('input[name="swProvider"]').forEach(radio => radio.addEventListener('change', () => {
      state.provider = radio.value;
      render();
    }));
    $('#swNext').textContent = 'NEXT';
    $('#swTest').style.display = 'none';
    $('#swSave').style.display = 'none';
    $('#swFinish').style.display = 'none';
    $('#swNext').disabled = false;
  }

  function stepCredentials(body) {
    const providerId = state.provider;
    const d = state.fields;
    const configured = (state.status && state.status.secretsConfigured) || {};
    if (providerId === 'local') {
      const ollama = (state.status && state.status.ollama) || {};
      body.innerHTML = `
        <h3 class="sw-title">Local AI needs no keys</h3>
        <p class="sw-copy">Everything talks to the Ollama app on this machine; nothing leaves the device. ${ollama.ok ? `Ollama is reachable (${esc(String(ollama.models && ollama.models.length || 0))} model(s) available).` : 'Ollama is not reachable at the moment — you can still finish setup and start it later.'}</p>`;
      $('#swNext').disabled = false;
      $('#swTest').style.display = 'none';
      $('#swSave').style.display = 'none';
      $('#swFinish').style.display = 'none';
      return;
    }
    const secretKey = providerId === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENROUTER_API_KEY';
    const modelField = providerId === 'opencode' ? 'glm-5.3-flash-free' : 'nvidia/nemotron-3.5-super-vl:free';
    body.innerHTML = `
      <h3 class="sw-title">Connect ${esc(providerId === 'opencode' ? 'OpenCode Zen' : 'OpenRouter')}</h3>
      <p class="sw-copy">${esc(secretKey)} ${configured[secretKey] ? 'is already saved' : 'is needed'}. External service: your messages are processed on their servers and free-tier usage may change. Create the key on the provider's own website.</p>
      <label class="sw-field">API key
        <span class="sw-keyrow"><input id="swApiKey" type="password" autocomplete="off" placeholder="${configured[secretKey] ? '•••• saved •••• (type to replace)' : ''}" value="">
        <button class="chip" id="swShow" type="button">SHOW</button></span>
      </label>
      <label class="sw-field">Model <input id="swModel" type="text" value="" placeholder="${esc(modelField)}" autocomplete="off"></label>
      ${configured[secretKey] ? '<p class="sw-copy sw-small">Leave the key blank to keep the saved one. Press TEST or NEXT to verify with the value you typed.</p>' : ''}`;
    const keyInput = $('#swApiKey');
    $('#swShow').addEventListener('click', () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      $('#swShow').textContent = hidden ? 'HIDE' : 'SHOW';
    });
    keyInput.addEventListener('input', () => { 
      state.fields.apiKey = keyInput.value.trim(); 
      state.actions = state.actions || {}; // in-place, no logging
    });
    const saveNow = () => { 
      state.providerKey = { keyName: secretKey, value: (keyInput.value || '').trim() }; 
      state.providerModel = ($('#swModel') && $('#swModel').value.trim()) || modelField;
    };
    keyInput.onblur = saveNow;
    $('#swModel').addEventListener('input', () => saveNow());
    // Bleeding-edge: keep the panel alive at every keystroke (no posting).
    keyInput.oninput = saveNow;
    $('#swTest').style.display = 'inline-block';
    $('#swSave').style.display = 'inline-block';
    $('#swFinish').style.display = 'none';
    $('#swNext').disabled = false;
  }

  function stepLocalAi(body) {
    const ollama = (state.status && state.status.ollama) || {};
    const models = (ollama.models || []);
    const hasSmall = models.some(m => /qwen|llama|phi|gemma|deepseek/i.test(String(m)));
    body.innerHTML = `
      <h3 class="sw-title">Local AI (Ollama)</h3>
      ${ollama.ok
        ? `<div class="sw-grid"><span class="k">OLLAMA</span><span class="v ok">Reachable at ${esc(ollama.endpoint || '')}</span>
           <span class="k">MODELS</span><span class="v">${models.length ? esc(models.join(', ')) : 'None yet'}</span></div>
           <div class="sw-actions sw-actions-left"><button class="chip" id="swPull" type="button">INSTALL qwen3:1.7b (about 1.4 GB)</button>
           <span class="sw-small">Only pull it if Local AI stays your main provider; external-API users can skip this.</span></div>`
        : `<div class="sw-grid"><span class="k">OLLAMA</span><span class="v bad">Not reachable</span></div>
           <p class="sw-copy">Install Ollama from <b>ollama.com</b>, start the app, then press RECHECK. JARVIS never pulls a model without explicit permission.</p>
           <div class="sw-actions sw-actions-left"><button class="chip" id="swRecheck" type="button">RECHECK</button><button class="chip" id="swSkipLocal" type="button">CONTINUE WITH EXTERNAL API</button></div>`}`;
    const pull = $('#swPull');
    if (pull) pull.addEventListener('click', async () => {
      setBusy(true);
      showNotice('Pulling qwen3:1.7b, ~1.4 GB. This can take several minutes; do not close the app.', 'warn');
      try {
        const result = await post('/api/setup/ollama/install', { model: 'qwen3:1.7b' });
        showNotice(result.ok ? 'Model installed. It now appears in the model list in AI Core.' : result.message, result.ok ? 'ok' : 'error');
      } catch (error) { showNotice(`Pull failed: ${error.message}`, 'error'); }
      setBusy(false);
      await refreshStatus(); render();
    });
    const recheck = $('#swRecheck');
    if (recheck) recheck.addEventListener('click', async () => {
      await refreshStatus(); render();
    });
    const skip = $('#swSkipLocal');
    if (skip) skip.addEventListener('click', () => { state.provider = 'opencode'; render(); });
    $('#swNext').disabled = false;
    $('#swTest').style.display = 'none';
    $('#swSave').style.display = 'none';
    $('#swFinish').style.display = 'none';
  }

  function stepVoice(body) {
    const configuredFish = (state.status && state.status.secretsConfigured && state.status.secretsConfigured.FISH_API_KEY) || false;
    const asr = (state.status && state.status.asr) || {};
    body.innerHTML = `
      <h3 class="sw-title">Voice & speech</h3>
      <div class="sw-grid">
        <span class="k">MICROPHONE</span><span class="v"><select id="swMic"><option value="">Default system microphone</option></select></span>
        <span class="k">SPEECH OUTPUT</span><span class="v">
          <select id="swTts"><option value="fish">Fish Audio cloud voice ${configuredFish ? '(configured)' : '(key needed)'}</option><option value="local">Local voice (no cloud, ${navigator.platform && navigator.platform.startsWith('Win') ? 'Windows' : 'platform voice'})</option></select></span>
        <span class="k">FISH API KEY</span><span class="v"><span class="sw-keyrow"><input id="swFishKey" type="password" autocomplete="off" placeholder="${configuredFish ? '•••• saved ••••' : ''}"><button class="chip" id="swFishShow" type="button">SHOW</button></span></span>
        <span class="k">FISH VOICE ID</span><span class="v"><input id="swFishVoice" type="text" autocomplete="off" placeholder="your own voice ID (optional)"></span>
      </div>
      <p class="sw-copy sw-small">${esc(asr.note || '')}</p>
      <p class="sw-copy sw-small">The configured voice is kept separate from the AI model. Fish Audio is a cloud service — the text JARVIS speaks is processed on Fish servers.</p>`;
    const micSelect = $('#swMic');
    navigator.mediaDevices && navigator.mediaDevices.enumerateDevices().then(devices => {
      for (const dev of devices.filter(d => d.kind === 'audioinput')) {
        const opt = document.createElement('option');
        opt.value = dev.deviceId; opt.textContent = dev.label || 'Microphone';
        micSelect.appendChild(opt);
      }
    }).catch(() => {});
    const keyInput = $('#swFishKey');
    $('#swFishShow').addEventListener('click', () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      $('#swFishShow').textContent = hidden ? 'HIDE' : 'SHOW';
    });
    $('#swTts').addEventListener('change', () => { state.ttsProvider = $('#swTts').value; });
    $('#swTts').value = state.ttsProvider;
    // double binding (#swTts above) is intentional: first sets the value chosen
    // earlier in the wizard, second keeps it live if the user changes it again.
    micSelect.addEventListener('change', () => { state.micDeviceId = micSelect.value; });
    keyInput.addEventListener('input', () => { state.fields.fishApiKey = keyInput.value.trim(); });
    keyInput.oninput = () => { state.fields.fishApiKey = keyInput.value.trim(); };
    $('#swFishVoice').addEventListener('input', () => { state.fields.fishVoiceId = $('#swFishVoice').value.trim(); });
    $('#swNext').disabled = false;
    $('#swTest').style.display = 'none';
    $('#swSave').style.display = 'inline-block';
    $('#swFinish').style.display = 'none';
  }

  function stepIntegrations(body) {
    const features = (state.status && state.status.features) || [];
    const rows = features.map(f => `
      <div class="sw-feature ${esc(f.status)}">
        <b>${esc(f.label)}</b>
        <span class="sw-plate ${esc(f.status)}">${esc(String(f.status).toUpperCase())}</span>
        <small class="sw-note">${esc(f.note)}</small>
      </div>`).join('');
    body.innerHTML = `
      <h3 class="sw-title">Optional integrations</h3>
      <p class="sw-copy">What this build can really do on your ${esc((state.status.platform || {}).os)} system:</p>
      ${rows}
      <label class="sw-field sw-check"><input type="checkbox" id="swTabs" ${state.integrations.tabControl === 'auto' ? 'checked' : ''}> Connect browser tab control automatically at startup (opens a controlled Chrome window when needed; your normal tabs stay untouched)</label>`;
    $('#swTabs').addEventListener('change', () => { state.integrations.tabControl = $('#swTabs').checked ? 'auto' : 'off'; });
    $('#swNext').disabled = false;
    $('#swTest').style.display = 'none';
    $('#swSave').style.display = 'none';
    $('#swFinish').style.display = 'none';
  }

  function stepFinish(body) {
    const s = state.status || {};
    const store = s.credentialStore || {};
    body.innerHTML = `
      <h3 class="sw-title">Ready to save</h3>
      <div class="sw-grid">
        <span class="k">PROVIDER</span><span class="v">${esc(state.provider === 'local' ? 'Local AI (Ollama)' : state.provider === 'opencode' ? 'OpenCode Zen' : 'OpenRouter')}</span>
        <span class="k">CREDENTIAL STORE</span><span class="v ${store.ok ? 'ok' : 'bad'}">${esc(store.message || '')}</span>
        <span class="k">VOICE</span><span class="v">${esc(state.ttsProvider === 'fish' ? 'Fish Audio cloud voice' : 'Local platform voice')}</span>
        <span class="k">TAB CONTROL</span><span class="v">${esc(state.integrations.tabControl === 'auto' ? 'Connect automatically' : 'Off until enabled')}</span>
      </div>
      <p class="sw-copy">FINISH SETUP saves everything above (keys go into the encrypted OS store). You can reopen this setup any time from the SET button in the top bar.</p>`;
    $('#swNext').textContent = 'DONE';
    $('#swNext').style.display = 'none';
    $('#swTest').style.display = 'none';
    $('#swSave').style.display = 'none';
    $('#swFinish').style.display = 'inline-block';
    $('#swFinish').disabled = false;
  }

  // ---------- actions ----------
  async function onNext() {
    if (state.busy) return;
    if (state.step === 3 && state.provider !== 'local') {
      const keyInput = $('#swApiKey');
      if (!keyInput) return;
      const value = keyInput.value.trim();
      if (!value) { showNotice('Type the API key first (or go Back and choose Local AI).', 'error'); return; }
      const saved = await post('/api/setup/save', { step: 3, provider: state.provider, secrets: pickSecretsForStep3() });
      if (!saved.ok) { showNotice(saved.message || 'Could not save the key.', 'error'); return; }
      state.fields.apiKey = '';
    }
    if (state.step === 7) { showNotice('Use FINISH SETUP to save and close the wizard.', 'warn'); return; }
    state.step = Math.min(7, state.step + 1);
    if (state.step === 3) showNotice(''); // clear old notices before typing
    render();
  }

  function pickSecretsForStep3() {
    const out = {};
    const keyInput = $('#swApiKey');
    const value = keyInput && typeof keyInput.value === 'string' ? keyInput.value.trim() : '';
    if (value && state.provider !== 'local') out[state.provider === 'opencode' ? 'OPENCODE_API_KEY' : 'OPENROUTER_API_KEY'] = value;
    const modelInput = $('#swModel');
    if (modelInput && modelInput.value.trim()) out[state.provider === 'opencode' ? 'OPENCODE_MODEL' : 'OPENROUTER_MODEL'] = modelInput.value.trim();
    return out;
  }

  async function onTest() {
    if (state.busy) return;
    if (state.step !== 3 || state.provider === 'local') return;
    const keyInput = $('#swApiKey');
    const value = keyInput && keyInput.value ? keyInput.value.trim() : '';
    if (!value) { showNotice('Type the key you want to test first.', 'error'); return; }
    const modelInput = $('#swModel');
    setBusy(true);
    showNotice('Testing — this one-time request goes only to the provider you chose…', 'warn');
    try {
      const result = await post('/api/setup/test', { provider: state.provider, apiKey: value, model: (modelInput && modelInput.value.trim()) || undefined });
      showNotice(result.message || (result.ok ? 'Connection succeeded.' : 'The endpoint did not answer clearly.'), result.ok ? 'ok' : 'error');
    } catch (error) {
      showNotice(`Test failed: ${error.message}. Check your network and the key, then retry.`, 'error');
    }
    setBusy(false);
  }

  async function onSave(finish) {
    if (state.busy) return;
    let payload = null;
    if (state.step === 5) {
      const fishKey = $('#swFishKey'), fishVoice = $('#swFishVoice');
      const secrets = {};
      if (fishKey && fishKey.value.trim()) secrets.FISH_API_KEY = fishKey.value.trim();
      if (fishVoice && fishVoice.value.trim()) secrets.FISH_REFERENCE_ID = fishVoice.value.trim();
      payload = { step: 5, secrets, options: { ttsProvider: state.ttsProvider, micDeviceId: state.micDeviceId } };
    } else if (state.step === 6) {
      payload = { step: 6, env: { JARVIS_TAB_CONTROL: state.integrations.tabControl }, options: { integrations: state.integrations } };
    } else if (state.step === 3 && state.provider === 'local') {
      payload = { step: 3, provider: 'local' };
    }
    if (!payload) return;
    setBusy(true);
    try {
      const result = await post('/api/setup/save', payload);
      if (!result.ok) { showNotice(result.message || 'Could not save that step.', 'error'); setBusy(false); return; }
      if (fishVoiceMissing(payload)) showNotice('Voice settings saved.', 'ok', true);
    } catch (error) {
      showNotice(`Saving failed: ${error.message}`, 'error');
      setBusy(false);
      return;
    }
    setBusy(false);
    if (state.step === 5) { showNotice('Voice settings saved.', 'ok'); return; }
    state.step = Math.min(7, state.step + 1);
    render();
  }

  function fishVoiceMissing() { return false; }

  async function onFinish() {
    if (state.busy) return;
    setBusy(true);
    try {
      const result = await post('/api/setup/finish', { clearWizard: true });
      showNotice(result.message || 'Setup finished.', 'ok');
      setTimeout(() => closeOverlay(false), 600);
    } catch (error) {
      showNotice(`Finishing failed: ${error.message}`, 'error');
      setBusy(false);
    }
  }

  async function refreshStatus() {
    try { state.status = await (await fetch('/api/setup/status')).json(); } catch { state.status = null; }
    const s = state.status || {};
    state.provider = (s.setupState && s.setupState.provider) || state.provider;
    if (s.setupState && s.setupState.step) state.step = Math.max(1, Math.min(7, Number(s.setupState.step)));
    const opts = (s.setupState && s.setupState.options) || {};
    if (opts.integrations) state.integrations = { ...state.integrations, ...opts.integrations };
    if (opts.ttsProvider) state.ttsProvider = opts.ttsProvider;
  }

  // Finish action is bound when the overlay exists and the step allows it.
  document.addEventListener('click', (event) => {
    if (event.target && event.target.id === 'swFinish') onFinish();
  });

  // ---------- startup behavior ----------
  async function start() {
    await refreshStatus();
    const s = state.status || {};
    const done = s.setupState && s.setupState.completedAt;
    const dismissed = s.setupState && s.setupState.dismissed;
    if (!done && !dismissed) {
      ensureOverlay();       // first run: open automatically at the saved step
    }
    addReopenButton();
  }

  function addReopenButton() {
    const bar = document.querySelector('.top-actions');
    if (!bar || $('#swReopenBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'swReopenBtn';
    btn.textContent = '⚙ SETUP';
    btn.title = 'Reopen or recheck the JARVIS setup wizard';
    btn.addEventListener('click', () => { if (!$('#swOverlay')) { ensureOverlay(); } });
    bar.insertBefore(btn, bar.firstChild);
  }

  window.JARVIS_SETUP_WIZARD = { start, open: ensureOverlay, state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();