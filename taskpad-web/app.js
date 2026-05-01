import {
  SyncHttpError,
  buildSavedKeyFailureMessage,
  describeSyncError,
  getSyncStatusMeta,
  isSavedKeyFailure,
  isValidSyncKey,
  normalizeSyncKey,
  readResponseErrorMessage,
  resolveWorkerUrl,
} from './app/sync-core.mjs';

(() => {
  'use strict';

  // ─── Config ──────────────────────────────────────────────────────────────
  let workerUrl = '';

  // ─── Constants ───────────────────────────────────────────────────────────
  const CONFIG_PATH    = 'config.json';
  const CONFIG_LOCAL_PATH = 'config.local.json';
  const STORAGE_KEY    = 'taskpad_v2';
  const SYNC_KEY_STORE = 'taskpad_sync_key';
  const SYNC_META_KEY  = 'taskpad_sync_meta';
  const SYNC_CONFLICT_STORE = 'taskpad_sync_conflict_backup';
  const SWIPE_SHOWN    = 'taskpad_swipe_shown'; // used only on Android/mobile web
  const MUST_CAP       = 3;
  const PRIORITIES     = ['must', 'should', 'could'];

  const SYMBOLS = { must: '★', should: '◆', could: '○' };
  const PRIORITY_NEXT   = { must: 'should', should: 'could', could: 'must' };
  const PRIORITY_LABELS = { must: '★ must', should: '◆ should', could: '○ could' };

  // Quick-route prefixes: typing /must or /m at start of input
  const ROUTE_MAP = {
    '/must': 'must', '/m': 'must',
    '/should': 'should', '/s': 'should',
    '/could': 'could', '/c': 'could',
  };

  const hasTouch  = 'ontouchstart' in window;
  // Tauri detection - must cover all platforms:
  //   macOS/Linux Tauri v2: location.protocol === 'tauri:'
  //   Windows Tauri v2:     location.hostname === 'tauri.localhost' (served via http://)
  //   Both with withGlobalTauri:true: window.__TAURI__ is defined
  const isTauri   = typeof window.__TAURI__ !== 'undefined'
                 || location.protocol === 'tauri:'
                 || location.hostname  === 'tauri.localhost';
  const isAndroid = typeof window.TaskpadAndroid !== 'undefined';
  // isMobile: only true on real mobile browsers - never in Tauri or Android WebView bridge
  const isMobile  = !isTauri && !isAndroid && /Mobi|Android/i.test(navigator.userAgent);

  // ─── State ───────────────────────────────────────────────────────────────
  // { id, text, priority, done, createdAt, doneAt?, order? }
  let state = { tasks: [], nextId: 1, updatedAt: 0 };

  // ─── Sync state ──────────────────────────────────────────────────────────
  let syncKey = null, syncTimer = null, syncInflight = false, syncDirty = false;
  let syncPendingPull = false;
  let syncLastSyncedAt = 0;

  // ─── DOM refs ─────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const bindingEl    = $('binding');
  const headerDate   = $('headerDate');
  const mustFill     = $('mustFill');
  const mustLabel    = $('mustLabel');
  const totalFill    = $('totalFill');
  const totalLabel   = $('totalLabel');
  const swipeHint    = $('swipeHint'); // only shown on Android/mobile web
  const mustCapHint  = $('mustCapHint');
  const addInput     = $('addInput');
  const addPriority  = $('addPriority');
  const addSubmit    = $('addSubmit');
  const clearAllBtn  = $('clearAllBtn');
  const clearDoneBtn = $('clearDoneBtn');
  const syncDot      = $('syncDot');
  const syncLabel    = $('syncLabel');
  const footerHint   = $('footerHint');
  const listArea     = $('listArea');
  const setupScreen  = $('setupScreen');
  const setupError   = $('setupError');
  const setupCreateBtn  = $('setupCreateBtn');
  const setupConnectBtn = $('setupConnectBtn');
  const setupKeyInput   = $('setupKeyInput');
  const keyDisplay      = $('keyDisplay');
  const keyValue        = $('keyValue');
  const keyCopyBtn      = $('keyCopyBtn');
  const appEl           = document.querySelector('.app');
  const confirmOverlay  = $('confirmOverlay');
  const confirmTitle    = $('confirmTitle');
  const confirmMessage  = $('confirmMessage');
  const confirmCancelBtn = $('confirmCancelBtn');
  const confirmOkBtn     = $('confirmOkBtn');

  const progressWrap = $('progressWrap');

  const LISTS        = { must: $('listMust'),        should: $('listShould'),        could: $('listCould') };
  const EMPTIES      = { must: $('emptyMust'),       should: $('emptyShould'),        could: $('emptyCould') };
  const COUNTS       = { must: $('countMust'),       should: $('countShould'),        could: $('countCould') };
  const DONE_SUMS    = { must: $('doneSummaryMust'), should: $('doneSummaryShould'),  could: $('doneSummaryCould') };
  const SECTIONS     = { must: $('sectionMust'),     should: $('sectionShould'),      could: $('sectionCould') };

  // Done-collapsed state per section
  const doneCollapsed = { must: false, should: false, could: false };
  let confirmResolve = null;
  let confirmActiveElement = null;
  let progressSnapshot = null;
  let queuedCelebration = null;
  let celebrationTimer = 0;

  // ─── Persistence ─────────────────────────────────────────────────────────
  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.tasks))
        state = { tasks: p.tasks, nextId: p.nextId ?? 1, updatedAt: p.updatedAt ?? 0 };
      const col = JSON.parse(localStorage.getItem('taskpad_collapsed') ?? 'null');
      if (col) { doneCollapsed.must = !!col.must; doneCollapsed.should = !!col.should; doneCollapsed.could = !!col.could; }
      const syncMeta = JSON.parse(localStorage.getItem(SYNC_META_KEY) ?? 'null');
      if (syncMeta) syncLastSyncedAt = syncMeta.lastSyncedAt ?? 0;
    } catch { /* fresh start */ }
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      localStorage.setItem('taskpad_collapsed', JSON.stringify(doneCollapsed));
      localStorage.setItem(SYNC_META_KEY, JSON.stringify({ lastSyncedAt: syncLastSyncedAt }));
    }
    catch { /* quota */ }
    if (isAndroid) {
      try { window.TaskpadAndroid.onStateChanged(JSON.stringify(state)); } catch {}
    }
  }

  // ─── Sync ────────────────────────────────────────────────────────────────
  // Fallback URL used if config.json is missing or unreadable (e.g. first launch,
  // WebView2 asset fetch failure). Keeps the app functional without config.json.

  async function loadRuntimeConfig() {
    let configuredUrl = '';
    try {
      const localOverride = localStorage.getItem('taskpad_worker_url');
      if (localOverride) configuredUrl = localOverride;
    } catch {}
    if (!configuredUrl && isAndroid) {
      try {
        const androidUrl = window.TaskpadAndroid.getWorkerUrl();
        if (androidUrl) configuredUrl = androidUrl;
      } catch {}
    }
    if (!configuredUrl) {
      for (const configPath of [CONFIG_LOCAL_PATH, CONFIG_PATH]) {
        try {
          const res = await fetch(configPath, { cache: 'no-store' });
          if (!res.ok) continue;
          const config = await res.json();
          if (typeof config.workerUrl === 'string') {
            configuredUrl = config.workerUrl;
            break;
          }
        } catch {}
      }
    }
    // Fall back to the known URL rather than leaving workerUrl empty, which would
    // silently drop the user into local-only mode with no way to enter a sync key.
    workerUrl = resolveWorkerUrl(configuredUrl);
  }

  function syncEnabled() { return !!(workerUrl && syncKey); }

  function setSyncUI(s) {
    const meta = getSyncStatusMeta(s);
    syncDot.className = `sync-dot ${s}`;
    syncLabel.textContent = meta.label;
    syncLabel.title = meta.title;
  }

  async function fetchRemoteState(key = syncKey) {
    const res = await fetch(`${workerUrl}/tasks`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new SyncHttpError(await readResponseErrorMessage(res), res.status);
    return res.json();
  }

  function stashConflictBackup(localSnapshot, remoteSnapshot) {
    try {
      localStorage.setItem(SYNC_CONFLICT_STORE, JSON.stringify({
        savedAt: Date.now(),
        local: localSnapshot,
        remote: remoteSnapshot,
      }));
    } catch {}
  }

  async function pull(opts = {}) {
    const { revealSetupOnSavedKeyError = false } = opts;
    if (!syncEnabled()) return;
    if (syncInflight || syncDirty) {
      syncPendingPull = true;
      if (syncDirty && !syncInflight) push();
      return;
    }
    setSyncUI('syncing');
    try {
      const remote = await fetchRemoteState();
      syncLastSyncedAt = Math.max(syncLastSyncedAt, remote.updatedAt ?? 0);
      if ((remote.updatedAt ?? 0) > (state.updatedAt ?? 0)) {
        state = { tasks: remote.tasks, nextId: remote.nextId, updatedAt: remote.updatedAt };
        saveLocal(); render();
      } else {
        saveLocal();
      }
      setSyncUI('synced');
      return true;
    } catch (err) {
      console.error('Taskpad pull failed:', err);
      setSyncUI('error');
      if (revealSetupOnSavedKeyError && isSavedKeyFailure(err)) {
        resetSetupScreen();
        setupKeyInput.value = syncKey ?? '';
        setupError.textContent = buildSavedKeyFailureMessage(err);
        setupError.style.display = 'block';
        setupScreen.style.display = 'flex';
        setTimeout(() => setupKeyInput.focus(), 80);
      }
      return false;
    }
  }

  async function push() {
    if (!syncEnabled() || syncInflight) return;
    syncInflight = true; setSyncUI('syncing');
    const pushBaseUpdatedAt = syncLastSyncedAt;
    const payloadUpdatedAt = state.updatedAt || Date.now();
    state.updatedAt = payloadUpdatedAt;
    const payload = { tasks: state.tasks, nextId: state.nextId, updatedAt: payloadUpdatedAt };
    try {
      const remoteBeforePush = await fetchRemoteState();
      const remoteUpdatedAt = remoteBeforePush.updatedAt ?? 0;
      if (remoteUpdatedAt > pushBaseUpdatedAt) {
        stashConflictBackup(payload, remoteBeforePush);
        const overwriteRemote = await confirmAction({
          title: 'Sync conflict',
          message: 'This list changed on another device since this tray app last synced. Overwrite the remote list with the copy from this tray app?',
          confirmLabel: 'Overwrite',
          cancelLabel: 'Keep remote',
        });
        if (!overwriteRemote) {
          syncDirty = false;
          syncPendingPull = false;
          syncLastSyncedAt = remoteUpdatedAt;
          state = { tasks: remoteBeforePush.tasks, nextId: remoteBeforePush.nextId, updatedAt: remoteUpdatedAt };
          saveLocal();
          render();
          setSyncUI('synced');
          return;
        }
      }

      const res = await fetch(`${workerUrl}/tasks`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${syncKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
      });
        if (!res.ok) throw new SyncHttpError(await readResponseErrorMessage(res), res.status);
        const pushedUpdatedAt = (await res.json()).updatedAt;
      const changedDuringPush = state.updatedAt !== payloadUpdatedAt;
      state.updatedAt = changedDuringPush ? state.updatedAt : pushedUpdatedAt;
      syncLastSyncedAt = pushedUpdatedAt;
      syncDirty = changedDuringPush;
      saveLocal();
      setSyncUI('synced');
    } catch (err) {
      console.error('Taskpad push failed:', err);
      setSyncUI('error');
    } finally {
      syncInflight = false;
      if (syncDirty) {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(push, 250);
      } else if (syncPendingPull) {
        syncPendingPull = false;
        pull();
      }
    }
  }

  function schedulePush() {
    // Advance updatedAt on every local mutation so pull() never silently
    // overwrites pending local changes with older remote data.
    state.updatedAt = Date.now();
    saveLocal();
    syncDirty = true;
    if (!syncEnabled()) return;
    clearTimeout(syncTimer); syncTimer = setTimeout(push, 800);
  }

  window.addEventListener('online', () => { if (syncDirty) push(); });

  // ─── Setup screen ─────────────────────────────────────────────────────────
  // Keep setup flow in one button state machine: create, show key, dismiss.
  let createDone = false;
  let connectReplaceConfirmed = false;

  function resetSetupScreen() {
    const titleEl = setupCreateBtn.querySelector('.setup-action-title');
    const descEl  = setupCreateBtn.querySelector('.setup-action-desc');
    createDone = false;
    connectReplaceConfirmed = false;
    setupCreateBtn.disabled = false;
    setupConnectBtn.disabled = false;
    setupConnectBtn.textContent = 'Connect existing list';
    if (titleEl) titleEl.textContent = 'New list';
    if (descEl)  descEl.textContent  = 'First time. Create a new list with a sync key.';
    keyDisplay.style.display = 'none';
    setupError.style.display = 'none';
    setupError.textContent = '';
  }

  function openSyncSettings(message = '', key = syncKey ?? '') {
    resetSetupScreen();
    setupKeyInput.value = key;
    if (message) {
      setupError.textContent = message;
      setupError.style.display = 'block';
    }
    setupScreen.style.display = 'flex';
    if (workerUrl) setTimeout(() => setupKeyInput.focus(), 80);
  }

  function closeSetupScreen(status) {
    setupScreen.style.display = 'none';
    setSyncUI(status);
  }

  function closeConfirmDialog(result) {
    if (!confirmResolve) return;
    const resolve = confirmResolve;
    confirmResolve = null;
    confirmOverlay.classList.remove('visible');
    confirmOverlay.setAttribute('aria-hidden', 'true');
    const restoreFocusEl = confirmActiveElement;
    confirmActiveElement = null;
    resolve(result);
    if (restoreFocusEl && typeof restoreFocusEl.focus === 'function') {
      setTimeout(() => restoreFocusEl.focus(), 0);
    }
  }

  function confirmAction({
    title = 'Confirm',
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = true,
  }) {
    if (confirmResolve) closeConfirmDialog(false);
    confirmActiveElement = document.activeElement;
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmCancelBtn.textContent = cancelLabel;
    confirmOkBtn.textContent = confirmLabel;
    confirmOkBtn.classList.toggle('danger', danger);
    confirmOverlay.classList.add('visible');
    confirmOverlay.setAttribute('aria-hidden', 'false');
    return new Promise(resolve => {
      confirmResolve = resolve;
      setTimeout(() => confirmOkBtn.focus(), 0);
    });
  }

  setupCreateBtn.addEventListener('click', async () => {
    if (!workerUrl) { closeSetupScreen('local'); return; }

    // Phase 2: already created - just dismiss
    if (createDone) {
      createDone = false;
      closeSetupScreen('synced');
      return;
    }

    // Phase 1: create new list
    const titleEl = setupCreateBtn.querySelector('.setup-action-title');
    const descEl  = setupCreateBtn.querySelector('.setup-action-desc');
    setupCreateBtn.disabled = true;
    if (titleEl) titleEl.textContent = 'Creating...';
    if (descEl)  descEl.textContent  = 'Connecting to your Worker...';
    setupError.style.display = 'none';
    try {
      const res = await fetch(`${workerUrl}/tasks/init`, { method: 'POST', signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new SyncHttpError(await readResponseErrorMessage(res), res.status);
      const { key } = await res.json();
      syncKey = key; localStorage.setItem(SYNC_KEY_STORE, key);
      keyValue.textContent = key; keyDisplay.style.display = 'block';
      if (titleEl) titleEl.textContent = 'Done';
      if (descEl)  descEl.textContent  = 'Key shown above. Save it, then click here.';
      setupCreateBtn.disabled = false;
      createDone = true; // next click will dismiss
    } catch (err) {
      console.error('Taskpad list creation failed:', err);
      setupError.textContent = describeSyncError(err, 'Could not create a new synced list.');
      setupError.style.display = 'block';
      setupCreateBtn.disabled = false;
      if (titleEl) titleEl.textContent = 'New list';
      if (descEl)  descEl.textContent  = 'First time. Create a new list with a sync key.';
    }
  });

  keyCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(keyValue.textContent);
      keyCopyBtn.textContent = 'copied!';
      setTimeout(() => { keyCopyBtn.textContent = 'copy to clipboard'; }, 2000);
    } catch { keyCopyBtn.textContent = 'select the key text above'; }
  });

  setupConnectBtn.addEventListener('click', async () => {
    const key = normalizeSyncKey(setupKeyInput.value);
    if (!isValidSyncKey(key)) { setupError.textContent = 'Key must be 64 hex characters.'; setupError.style.display = 'block'; return; }
    if (!workerUrl) { setupError.textContent = 'No worker URL configured.'; setupError.style.display = 'block'; return; }
    if (state.tasks.length > 0 && !connectReplaceConfirmed) {
      const ok = await confirmAction({
        title: 'Replace local tasks',
        message: 'Connecting will replace the tasks currently stored in this tray app with the remote list for this key.',
        confirmLabel: 'Connect',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
      connectReplaceConfirmed = true;
    }
    setupConnectBtn.disabled = true; setupConnectBtn.textContent = 'Connecting...';
    setupError.style.display = 'none';
    try {
      const remote = await fetchRemoteState(key);
      syncKey = key; localStorage.setItem(SYNC_KEY_STORE, key);
      state = { tasks: remote.tasks, nextId: remote.nextId, updatedAt: remote.updatedAt ?? 0 };
      syncLastSyncedAt = remote.updatedAt ?? 0;
      saveLocal(); render();
      connectReplaceConfirmed = false;
      closeSetupScreen('synced');
    } catch (err) {
      console.error('Taskpad existing-key connect failed:', err);
      connectReplaceConfirmed = false;
      setupError.textContent = describeSyncError(err, 'Unable to connect this device to that list.');
      setupError.style.display = 'block';
      setupConnectBtn.disabled = false; setupConnectBtn.textContent = 'Connect existing list';
    }
  });

  setupKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') setupConnectBtn.click(); });

  // Local only button
  document.getElementById('setupLocalBtn')?.addEventListener('click', () => {
    resetSetupScreen();
    setupKeyInput.value = '';
    closeSetupScreen('local');
  });

  // Skip link at bottom - same as local only
  document.getElementById('skipSyncBtn')?.addEventListener('click', () => {
    resetSetupScreen();
    setupKeyInput.value = '';
    closeSetupScreen('local');
  });

  // Re-open setup from the footer sync state.
  document.getElementById('syncLabel').addEventListener('click', () => {
    openSyncSettings('', syncKey ?? '');
  });

  // ─── Rendering helpers ────────────────────────────────────────────────────
  confirmCancelBtn.addEventListener('click', () => closeConfirmDialog(false));
  confirmOkBtn.addEventListener('click', () => closeConfirmDialog(true));
  confirmOverlay.addEventListener('click', e => {
    if (e.target === confirmOverlay) closeConfirmDialog(false);
  });
  document.addEventListener('keydown', e => {
    if (!confirmResolve) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeConfirmDialog(false);
      return;
    }
    if (e.key === 'Enter' && document.activeElement !== confirmCancelBtn) {
      e.preventDefault();
      closeConfirmDialog(true);
    }
  }, true);

  function renderBinding() {
    const n = Math.max(Math.floor(window.innerWidth / 26), 6);
    const holes = Array(n).fill('<div class="hole"></div>').join('');
    bindingEl.innerHTML = holes;
    // Also fill the setup screen binding if present
    const sb = document.getElementById('setupBinding');
    if (sb) sb.innerHTML = holes;
  }

  function renderDate() {
    headerDate.textContent = new Date().toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short'
    }).toUpperCase();
  }

  function updateProgress() {
    progressWrap.style.display = state.tasks.length > 0 ? '' : 'none';

    // Must bar
    const musts   = state.tasks.filter(t => t.priority === 'must');
    const mDone   = musts.filter(t => t.done).length;
    const mTotal  = musts.length;
    const mPct    = mTotal === 0 ? 0 : Math.round(mDone / mTotal * 100);
    mustFill.style.width      = mPct + '%';
    mustFill.style.background = (mTotal > 0 && mDone === mTotal)
      ? 'var(--progress)' : '';
    mustLabel.textContent = mTotal === 0 ? '-' : `★ ${mDone}/${mTotal}`;

    // Total bar
    const all     = state.tasks;
    const aDone   = all.filter(t => t.done).length;
    const aTotal  = all.length;
    const aPct    = aTotal === 0 ? 0 : Math.round(aDone / aTotal * 100);
    totalFill.style.width = aPct + '%';
    totalLabel.textContent = aTotal === 0 ? '-' : `all ${aDone}/${aTotal}`;

    const nextSnapshot = {
      mustComplete: mTotal > 0 && mDone === mTotal,
      allComplete: aTotal > 0 && aDone === aTotal,
    };
    if (progressSnapshot) {
      if (nextSnapshot.allComplete && !progressSnapshot.allComplete) {
        queueProgressCelebration('all');
      } else if (nextSnapshot.mustComplete && !progressSnapshot.mustComplete) {
        queueProgressCelebration('must');
      }
    }
    progressSnapshot = nextSnapshot;

    // Update tray tooltip when running in Tauri
    if (isTauri) {
      const mustUndone = state.tasks.filter(t => t.priority === 'must' && !t.done).length;
      const allUndone  = state.tasks.filter(t => !t.done).length;
      let tip;
      if (allUndone === 0 && aTotal > 0) tip = 'Taskpad - all done ✓';
      else if (mustUndone > 0) tip = `Taskpad - ${mustUndone} must${mustUndone > 1 ? 's' : ''} left`;
      else if (allUndone > 0)  tip = `Taskpad - ${allUndone} task${allUndone > 1 ? 's' : ''} left`;
      else                     tip = 'Taskpad';
      window.__TAURI__?.core.invoke('update_tray_tooltip', { tooltip: tip }).catch(() => {});
    }
  }

  function getCelebrationColors(kind) {
    const styles = getComputedStyle(document.documentElement);
    const progress = styles.getPropertyValue('--progress').trim() || '#5a8828';
    const must = styles.getPropertyValue('--must-accent').trim() || progress;
    const should = styles.getPropertyValue('--should-accent').trim() || progress;
    return kind === 'all' ? [progress, must, should] : [must, progress];
  }

  function queueProgressCelebration(kind) {
    queuedCelebration = queuedCelebration === 'all' || kind === 'all' ? 'all' : kind;
    if (celebrationTimer) clearTimeout(celebrationTimer);
    celebrationTimer = setTimeout(() => {
      const pending = queuedCelebration;
      queuedCelebration = null;
      celebrationTimer = 0;
      if (pending) triggerProgressCelebration(pending);
    }, 60);
  }

  function spawnParticleBurst(host, left, top, options) {
    const {
      className,
      colors,
      count,
      distanceMin,
      distanceJitter,
      size,
      lifetime,
    } = options;
    const burst = document.createElement('div');
    burst.className = className;
    burst.style.left = `${left}px`;
    burst.style.top = `${top}px`;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
      const dist = distanceMin + Math.random() * distanceJitter;
      const tx = `translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px)`;
      const particle = document.createElement('span');
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;
      particle.style.background = colors[i % colors.length];
      particle.style.setProperty('--tx', tx);
      particle.style.animationDelay = `${i * 14}ms`;
      burst.appendChild(particle);
    }

    host.appendChild(burst);
    setTimeout(() => burst.remove(), lifetime);
  }

  function triggerProgressCelebration(kind) {
    const className = kind === 'all' ? 'celebrate-all' : 'celebrate-must';
    appEl.classList.remove('celebrate-must', 'celebrate-all');
    progressWrap.classList.remove('celebrate-must', 'celebrate-all');
    void appEl.offsetWidth;
    appEl.classList.add(className);
    progressWrap.classList.add(className);

    const banner = document.createElement('div');
    banner.className = `celebration-banner ${kind}`;
    banner.textContent = kind === 'all' ? 'yeah, you did it' : 'musts handled';
    appEl.appendChild(banner);
    setTimeout(() => banner.remove(), kind === 'all' ? 3200 : 3600);
    setTimeout(() => {
      appEl.classList.remove(className);
      progressWrap.classList.remove(className);
    }, kind === 'all' ? 6100 : 2800);

    const hostRect = appEl.getBoundingClientRect();
    const barRect = (kind === 'all' ? totalFill : mustFill).getBoundingClientRect();
    const left = barRect.left + barRect.width / 2 - hostRect.left;
    const top = barRect.top + barRect.height / 2 - hostRect.top + 10;
    spawnParticleBurst(appEl, left, top, {
      className: 'celebration-burst',
      colors: getCelebrationColors(kind),
      count: kind === 'all' ? 36 : 20,
      distanceMin: kind === 'all' ? 34 : 24,
      distanceJitter: kind === 'all' ? 32 : 18,
      size: kind === 'all' ? 12 : 8,
      lifetime: kind === 'all' ? 2200 : 2400,
    });
    if (kind === 'must') {
      spawnParticleBurst(appEl, hostRect.width * 0.32, top + 18, {
        className: 'celebration-burst',
        colors: getCelebrationColors(kind),
        count: 14,
        distanceMin: 18,
        distanceJitter: 16,
        size: 8,
        lifetime: 2200,
      });
      spawnParticleBurst(appEl, hostRect.width * 0.68, top + 18, {
        className: 'celebration-burst',
        colors: getCelebrationColors(kind),
        count: 14,
        distanceMin: 18,
        distanceJitter: 16,
        size: 8,
        lifetime: 2200,
      });
      return;
    }

    const center = document.createElement('div');
    center.className = 'celebration-center';
    center.innerHTML = `
      <div class="celebration-center-main">DAY COMPLETE</div>
      <div class="celebration-center-sub">everything's done</div>
    `;
    appEl.appendChild(center);
    setTimeout(() => center.remove(), 6200);

    if (kind === 'all') {
      spawnParticleBurst(appEl, hostRect.width / 2, top + 24, {
        className: 'celebration-burst',
        colors: getCelebrationColors(kind),
        count: 28,
        distanceMin: 28,
        distanceJitter: 24,
        size: 10,
        lifetime: 2000,
      });
      spawnParticleBurst(appEl, hostRect.width * 0.28, top + 38, {
        className: 'celebration-burst',
        colors: getCelebrationColors(kind),
        count: 22,
        distanceMin: 24,
        distanceJitter: 18,
        size: 9,
        lifetime: 1900,
      });
      spawnParticleBurst(appEl, hostRect.width * 0.72, top + 38, {
        className: 'celebration-burst',
        colors: getCelebrationColors(kind),
        count: 22,
        distanceMin: 24,
        distanceJitter: 18,
        size: 9,
        lifetime: 1900,
      });
      spawnConfettiRain();
    }
  }

  function spawnConfettiRain() {
    const colors = [
      ...getCelebrationColors('all'),
      '#f4c542',
      '#fdf6ec',
      '#d05030',
    ];
    const rain = document.createElement('div');
    rain.className = 'confetti-rain';
    const pieces = 90;
    for (let i = 0; i < pieces; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      const left = Math.random() * 100;
      const drift = (Math.random() - 0.5) * 180;
      const spin = `${(Math.random() > 0.5 ? 1 : -1) * (540 + Math.random() * 960)}deg`;
      const delay = `${Math.random() * 1.4}s`;
      const duration = `${5.2 + Math.random() * 1.8}s`;
      const width = 7 + Math.random() * 7;
      const height = 12 + Math.random() * 12;
      piece.style.left = `${left}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty('--drift', `${drift}px`);
      piece.style.setProperty('--spin', spin);
      piece.style.setProperty('--fall', duration);
      piece.style.animationDelay = delay;
      piece.style.width = `${width}px`;
      piece.style.height = `${height}px`;
      if (Math.random() > 0.55) {
        piece.style.borderRadius = '999px';
      }
      rain.appendChild(piece);
    }
    appEl.appendChild(rain);
    setTimeout(() => rain.remove(), 6500);
  }

  function updateMustCapHint() {
    const undone = state.tasks.filter(t => t.priority === 'must' && !t.done).length;
    const show = undone >= MUST_CAP;
    mustCapHint.classList.toggle('visible', show);
    if (show) {
      mustCapHint.textContent = `You have ${undone} must${undone > 1 ? 's' : ''}. Be ruthless: what truly can't wait?`;
    }
  }

  function updateClearDone() {
    clearAllBtn.classList.toggle('visible', state.tasks.length > 0);
    clearDoneBtn.classList.toggle('visible', state.tasks.some(t => t.done));
  }

  function setCount(p) {
    const tasks  = state.tasks.filter(t => t.priority === p);
    const undone = tasks.filter(t => !t.done).length;
    const el = COUNTS[p];
    if (undone > 0) { el.textContent = `${undone} left`; el.classList.remove('all-done'); }
    else if (tasks.length > 0) { el.textContent = 'all done ✓'; el.classList.add('all-done'); }
    else { el.textContent = ''; el.classList.remove('all-done'); }
  }

  function updateAllCounts() {
    PRIORITIES.forEach(p => {
      setCount(p);
      const tasks = state.tasks.filter(t => t.priority === p);
      EMPTIES[p].style.display = tasks.length === 0 ? 'block' : 'none';
    });
  }

  // Done collapse: renders the "N done ▾/▴" toggle and hides/shows done items
  function updateDoneCollapse(p) {
    const doneEls = [...LISTS[p].querySelectorAll('.task-item.done:not(.removing)')];
    const summary = DONE_SUMS[p];

    if (doneEls.length === 0) {
      summary.classList.remove('visible');
      return;
    }

    const collapsed = doneCollapsed[p];
    summary.classList.add('visible');
    const action = (isMobile || isAndroid) ? 'tap' : 'click';
    summary.textContent = collapsed
      ? `${doneEls.length} done · ${action} to show`
      : `${doneEls.length} done · ${action} to hide`;

    doneEls.forEach(el => { el.style.display = collapsed ? 'none' : ''; });
  }

  // ─── Build task element ───────────────────────────────────────────────────
  function createTaskEl(task) {
    const li = document.createElement('li');
    li.className = `task-item ${task.priority}${task.done ? ' done' : ''}`;
    li.dataset.id = String(task.id);
    li.classList.toggle('reorderable', !task.done && !isAndroid && !isMobile);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.className = 'task-check';
    checkbox.checked = task.done;
    checkbox.setAttribute('aria-label', task.text);

    const priorityBtn = document.createElement('button');
    priorityBtn.className = 'task-priority-btn';
    priorityBtn.textContent = SYMBOLS[task.priority];
    priorityBtn.title = 'Change priority';
    priorityBtn.setAttribute('aria-label', `Priority: ${task.priority}. Tap to change.`);

    const body = document.createElement('div');
    body.className = 'task-body';
    const span = document.createElement('span');
    span.className = 'task-text'; span.textContent = task.text;
    body.appendChild(span);

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.setAttribute('aria-label', 'Delete task');
    del.textContent = '×';

    li.append(checkbox, priorityBtn, body, del);

    checkbox.addEventListener('change', () => toggleDone(task.id, li, checkbox.checked));
    del.addEventListener('click', e => { e.stopPropagation(); animateRemove(li, task.id); });
    priorityBtn.addEventListener('click', e => { e.stopPropagation(); changePriority(task.id, li, priorityBtn); });

    // Click to edit (desktop) or long-press (mobile)
    let pressTimer = null;
    // Single click on body area starts edit - more natural than dblclick
    body.addEventListener('click', e => {
      if (dragJustFinished) return;
      if (li.classList.contains('done')) return;
      if (e.target.closest('.task-check') || e.target.closest('.task-delete') || e.target.closest('.task-priority-btn') || e.target.closest('.task-edit-input')) return;
      startEdit(task.id, li, span);
    });
    // Block dblclick browser default (text selection) - click is handled above
    span.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); });
    span.addEventListener('touchstart', () => {
      pressTimer = setTimeout(() => startEdit(task.id, li, span), 600);
    }, { passive: true });
    span.addEventListener('touchend', () => clearTimeout(pressTimer));
    span.addEventListener('touchmove', () => clearTimeout(pressTimer), { passive: true });

    // Drag and drop - desktop browsers only (not mobile/Android)
    if (!task.done && !isAndroid && !isMobile) {
      setupDrag(li, task.id);
    }
    // Swipe-to-delete: Android and mobile web browsers
    if (isAndroid || isMobile) setupSwipe(li, task.id);

    return li;
  }

  // Sorted: undone by createdAt asc, done by doneAt asc
  function sortedTasks(priority) {
    const tasks = state.tasks.filter(t => t.priority === priority);
    const key = t => t.order ?? t.createdAt; // order field for new tasks, createdAt for legacy
    return [
      ...tasks.filter(t => !t.done).sort((a, b) => key(a) - key(b)),
      ...tasks.filter(t =>  t.done).sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0)),
    ];
  }

  // Full render - used after pull / state replacement
  function render() {
    for (const p of PRIORITIES) {
      LISTS[p].innerHTML = '';
      sortedTasks(p).forEach(t => LISTS[p].appendChild(createTaskEl(t)));
      updateDoneCollapse(p);
    }
    updateAllCounts();
    updateProgress();
    updateMustCapHint();
    updateClearDone();

    if ((isAndroid || isMobile) && state.tasks.length > 0 && !localStorage.getItem(SWIPE_SHOWN)) {
      swipeHint.style.display = 'block';
      setTimeout(() => { swipeHint.style.display = 'none'; localStorage.setItem(SWIPE_SHOWN, '1'); }, 3000);
    }
  }

  // ─── Mutations ───────────────────────────────────────────────────────────
  function addTask(text, priority) {
    const clean = text.trim();
    if (!clean) return;
    // order: max existing order in this priority + 1, so new tasks go to end
    const existing = state.tasks.filter(t => t.priority === priority && !t.done);
    const maxOrder = existing.length > 0 ? Math.max(...existing.map(t => t.order ?? t.createdAt)) : Date.now();
    const task = { id: state.nextId++, text: clean, priority, done: false, createdAt: Date.now(), order: maxOrder + 100 };
    state.tasks.push(task);
    saveLocal(); schedulePush();

    const el = createTaskEl(task);
    el.classList.add('entering');
    el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });

    const firstDone = LISTS[priority].querySelector('.task-item.done');
    firstDone ? LISTS[priority].insertBefore(el, firstDone) : LISTS[priority].appendChild(el);
    EMPTIES[priority].style.display = 'none';

    setCount(priority);
    updateProgress(); updateMustCapHint(); updateClearDone();

    // Show swipe hint on mobile after first ever task is added
    if ((isAndroid || isMobile) && !localStorage.getItem(SWIPE_SHOWN)) {
      swipeHint.style.display = 'block';
      setTimeout(() => { swipeHint.style.display = 'none'; localStorage.setItem(SWIPE_SHOWN, '1'); }, 3000);
    }
  }

  // ─── Burst particle effect ───────────────────────────────────────────────
  // Read accent colours from CSS tokens so burst matches any theme changes
  function getBurstColor(priority) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(`--${priority}-accent`).trim() || '#666';
  }

  function spawnBurst(li) {
    const checkbox = li.querySelector('.task-check');
    if (!checkbox) return;

    const listArea = li.closest('.list-area');
    if (!listArea) return;
    const rect     = checkbox.getBoundingClientRect();
    const listRect = listArea.getBoundingClientRect();

    const cx = rect.left + rect.width  / 2 - listRect.left;
    const cy = rect.top  + rect.height / 2 - listRect.top + listArea.scrollTop;
    const priority = ['must','should','could'].find(p => li.classList.contains(p)) ?? 'should';
    const color = getBurstColor(priority);
    spawnParticleBurst(listArea, cx, cy, {
      className: 'check-burst',
      colors: [color],
      count: 20,
      distanceMin: 24,
      distanceJitter: 16,
      size: 8,
      lifetime: 1800,
    });
  }

  function toggleDone(id, li, checked) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    task.done = checked; task.doneAt = checked ? Date.now() : undefined;
    saveLocal(); schedulePush();

    li.classList.toggle('done', checked);
    li.classList.toggle('reorderable', !checked && !isAndroid && !isMobile);

    if (checked) {
      li.classList.add('completing');
      li.addEventListener('animationend', () => li.classList.remove('completing'), { once: true });
      spawnBurst(li);
      setTimeout(() => {
        LISTS[task.priority].appendChild(li);
        updateDoneCollapse(task.priority);
      }, 320);
    } else {
      // Re-insert in order among undone items
      const orderKey = t => t.order ?? t.createdAt;
      const siblings = [...LISTS[task.priority].querySelectorAll('.task-item:not(.done)')]
        .filter(el => el !== li);
      const after = siblings.find(el => {
        const sib = state.tasks.find(t => t.id === parseInt(el.dataset.id, 10));
        return sib && orderKey(sib) > orderKey(task);
      });
      const ref = after ?? LISTS[task.priority].querySelector('.task-item.done');
      ref ? LISTS[task.priority].insertBefore(li, ref) : LISTS[task.priority].appendChild(li);
      updateDoneCollapse(task.priority);
    }

    updateAllCounts(); updateProgress(); updateMustCapHint(); updateClearDone();
  }

  // ─── Undo system ─────────────────────────────────────────────────────────
  // Undo is a re-add, not a soft-delete. Task is removed from state immediately
  // (survives panel close, sync, etc). Undo copies the task back in.
  let undoSnapshot = null;  // a copy of the deleted task
  let undoTimer    = null;

  function showUndoToast(task) {
    const toast = document.getElementById('undoToast');
    const msg   = document.getElementById('undoMsg');
    clearTimeout(undoTimer);
    const label = task.text.length > 28 ? task.text.slice(0,28)+'…' : task.text;
    msg.textContent = `"${label}" deleted`;
    toast.classList.add('visible');
    undoTimer = setTimeout(dismissUndoToast, 4000);
  }

  function dismissUndoToast() {
    clearTimeout(undoTimer);
    document.getElementById('undoToast').classList.remove('visible');
    undoSnapshot = null;
  }

  document.getElementById('undoBtn').addEventListener('click', () => {
    if (!undoSnapshot) return;
    const task = { ...undoSnapshot };
    dismissUndoToast();
    state.tasks.push(task);
    if (task.id >= state.nextId) state.nextId = task.id + 1;
    saveLocal(); schedulePush();
    const el = createTaskEl(task);
    el.classList.add('entering');
    el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    if (task.done) {
      LISTS[task.priority].appendChild(el);
      updateDoneCollapse(task.priority);
    } else {
      // Re-insert at correct order position
      const orderKey = t => t.order ?? t.createdAt;
      const siblings = [...LISTS[task.priority].querySelectorAll('.task-item:not(.done)')];
      const after = siblings.find(sib => {
        const sibTask = state.tasks.find(t => t.id === parseInt(sib.dataset.id, 10));
        return sibTask && orderKey(sibTask) > orderKey(task);
      });
      const ref = after ?? LISTS[task.priority].querySelector('.task-item.done');
      ref ? LISTS[task.priority].insertBefore(el, ref) : LISTS[task.priority].appendChild(el);
    }
    EMPTIES[task.priority].style.display = 'none';
    updateAllCounts(); updateProgress(); updateMustCapHint(); updateClearDone();
  });

  function changePriority(id, li, btn) {
    const task = state.tasks.find(t => t.id === id);
    if (!task || task.done) return;
    const newP = PRIORITY_NEXT[task.priority];
    task.priority = newP;

    // Place at end of destination section with correct order value
    const destUndone = state.tasks.filter(t => t.priority === newP && !t.done && t.id !== id);
    const orderKey = t => t.order ?? t.createdAt;
    task.order = destUndone.length > 0
      ? Math.max(...destUndone.map(orderKey)) + 100
      : (task.order ?? task.createdAt);

    saveLocal(); schedulePush();

    btn.textContent = SYMBOLS[newP];
    btn.setAttribute('aria-label', `Priority: ${newP}. Tap to change.`);
    li.classList.remove('must', 'should', 'could'); li.classList.add(newP);

    const firstDone = LISTS[newP].querySelector('.task-item.done');
    firstDone ? LISTS[newP].insertBefore(li, firstDone) : LISTS[newP].appendChild(li);

    PRIORITIES.forEach(p => { setCount(p); EMPTIES[p].style.display = state.tasks.filter(t => t.priority === p).length === 0 ? 'block' : 'none'; });
    updateProgress(); updateMustCapHint();

    // Flash background briefly to confirm priority change
    li.style.transition = 'opacity 0.1s, background 0.1s';
    li.style.opacity = '0.5';
    li.style.background = 'rgba(0,0,0,0.04)';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      li.style.opacity = '1';
      li.style.background = '';
      setTimeout(() => { li.style.transition = ''; li.style.opacity = ''; }, 120);
    }));
  }

  function editTask(id, newText) {
    const task = state.tasks.find(t => t.id === id);
    if (!task || !newText.trim()) return;
    task.text = newText.trim();
    saveLocal(); schedulePush();
  }

  async function clearAllDone() {
    const doneCount = state.tasks.filter(t => t.done).length;
    if (doneCount === 0) return;
    const ok = await confirmAction({
      title: 'Clear done tasks',
      message: doneCount === 1
        ? 'Remove the completed task from this list?'
        : `Remove all ${doneCount} completed tasks from this list?`,
      confirmLabel: 'Clear done',
      cancelLabel: 'Keep them',
    });
    if (!ok) return;
    if (undoSnapshot) dismissUndoToast();

    // Un-collapse all sections first so hidden done items are visible/measurable
    PRIORITIES.forEach(p => {
      if (doneCollapsed[p]) {
        doneCollapsed[p] = false;
        LISTS[p].querySelectorAll('.task-item.done').forEach(el => { el.style.display = ''; });
        updateDoneCollapse(p);
      }
    });

    // Small delay to let the un-collapse paint before measuring heights
    requestAnimationFrame(() => {
      const removing = [...document.querySelectorAll('.task-item.done')];
      if (removing.length === 0) { render(); return; }

      removing.forEach(li => {
        const h = li.getBoundingClientRect().height;
        li.style.height = h + 'px'; li.style.overflow = 'hidden';
        li.style.opacity = '0';
        li.style.transition = 'height 0.22s var(--ease-out), opacity 0.15s, padding-top 0.22s, padding-bottom 0.22s';
        li.getBoundingClientRect(); // force layout
        li.style.height = '0'; li.style.paddingTop = '0'; li.style.paddingBottom = '0';
      });

      // Use a fixed timeout rather than transitionend - more robust if transitions are
      // interrupted (rapid deletes, panel close mid-animation, etc.)
      setTimeout(() => {
        state.tasks = state.tasks.filter(t => !t.done);
        PRIORITIES.forEach(p => { doneCollapsed[p] = false; });
        saveLocal(); schedulePush(); render();
      }, 260);
    });
  }

  async function clearAllTasks() {
    if (state.tasks.length === 0) return;
    const ok = await confirmAction({
      title: 'Clear all tasks',
      message: 'Clear every task from this list? This cannot be undone.',
      confirmLabel: 'Clear all',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    if (undoSnapshot) dismissUndoToast();
    state.tasks = [];
    state.nextId = 1;
    state.updatedAt = Date.now();
    PRIORITIES.forEach(p => { doneCollapsed[p] = false; });
    saveLocal();
    schedulePush();
    render();
  }

  // ─── Edit in place ────────────────────────────────────────────────────────
  function startEdit(id, li, span) {
    if (li.classList.contains('done')) return;
    if (li.querySelector('.task-edit-input')) return; // already editing
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;

    const input = document.createElement('input');
    input.className = 'task-edit-input';
    input.maxLength = 200;
    input.value = task.text;
    span.replaceWith(input);
    input.focus();
    // Place cursor at click position instead of selecting all
    const len = input.value.length;
    input.setSelectionRange(len, len);

    function commit() {
      if (commit.done) return;
      commit.done = true;
      const newText = input.value.trim();
      if (newText && newText !== task.text) editTask(id, newText);
      span.textContent = state.tasks.find(t => t.id === id)?.text ?? task.text;
      input.replaceWith(span);
    }
    commit.done = false;

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { input.value = task.text; commit(); }
    });
    input.addEventListener('blur', commit);
  }

  // ─── Animated remove ──────────────────────────────────────────────────────
  function animateRemove(li, id) {
    // Set undo snapshot immediately so undo works even during the exit animation
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    undoSnapshot = { ...task };
    li.classList.add('removing');
    state.tasks = state.tasks.filter(t => t.id !== id);
    saveLocal(); schedulePush();
    showUndoToast(task);
    updateAllCounts(); updateProgress(); updateMustCapHint(); updateClearDone(); updateDoneCollapse(task.priority);

    const h = li.getBoundingClientRect().height;
    li.style.height = h + 'px'; li.style.overflow = 'hidden'; li.style.opacity = '0';
    li.style.transition = 'height 0.22s var(--ease-out), opacity 0.18s, padding-top 0.22s, padding-bottom 0.22s';
    li.getBoundingClientRect();
    li.style.height = '0'; li.style.paddingTop = '0'; li.style.paddingBottom = '0';
    setTimeout(() => {
      li.remove();
      updateDoneCollapse(task.priority);
      updateClearDone();
    }, 260);
  }

  // ─── Drag and drop ────────────────────────────────────────────────────────
  // Architecture: ONE global pointer system. Global move/up/cancel listeners
  // are attached ONCE in initDrag() - never per task element.
  // Uses MOUSE events, not pointer events.
  //
  // Root cause of all previous failures: pointer events (pointermove/pointerup)
  // are intercepted by WebView2's scroll-gesture engine when the cursor moves
  // inside a scrollable container - even with touch-action:none set on the
  // dragged element. This is a known WebView2/Chromium behaviour that cannot
  // be worked around with CSS or setPointerCapture alone.
  //
  // Mouse events (mousemove/mouseup) on document are NOT subject to scroll
  // interception. They always fire unconditionally in Chromium/WebView2.
  // This is the correct approach for a desktop-only Tauri app.
  //
  // Architecture:
  //   mousedown on task el  → arm drag, record start pos
  //   mousemove on document → once 4px threshold crossed, activate + show indicators
  //   mouseup  on document  → commit drop
  let dragId           = null;
  let dragEl           = null;
  let dragGhostEl      = null;
  let dragStartX       = 0;
  let dragStartY       = 0;
  let dragOffsetX      = 0;
  let dragOffsetY      = 0;
  let dragArmed        = false;  // mousedown fired, waiting for movement threshold
  let dragJustFinished = false;  // suppresses click-to-edit after a successful drop

  function initDrag() {
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup',   onDragUp);
  }

  function createDragGhost(sourceEl) {
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.style.width = `${sourceEl.getBoundingClientRect().width}px`;
    const clone = sourceEl.cloneNode(true);
    clone.classList.remove('dragging', 'drag-placeholder', 'insert-before', 'insert-after');
    ghost.appendChild(clone);
    document.body.appendChild(ghost);
    return ghost;
  }

  function positionDragGhost(clientX, clientY) {
    if (!dragGhostEl) return;
    dragGhostEl.style.transform = `translate3d(${clientX - dragOffsetX}px, ${clientY - dragOffsetY}px, 0) rotate(-1.2deg) scale(1.02)`;
  }

  function destroyDragGhost() {
    dragGhostEl?.remove();
    dragGhostEl = null;
  }

  function autoScrollWhileDragging(clientY) {
    const rect = listArea.getBoundingClientRect();
    const threshold = 52;
    let delta = 0;
    if (clientY < rect.top + threshold) {
      delta = -Math.ceil((rect.top + threshold - clientY) / 10);
    } else if (clientY > rect.bottom - threshold) {
      delta = Math.ceil((clientY - (rect.bottom - threshold)) / 10);
    }
    if (delta !== 0) {
      listArea.scrollTop += Math.max(-18, Math.min(18, delta));
    }
  }

  // Per-task: only a mousedown listener - all tracking is global.
  function setupDrag(el, id) {
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('.task-check, .task-delete, .task-priority-btn, .task-edit-input')) return;
      const rect = el.getBoundingClientRect();
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      dragArmed  = true;
      dragId     = id;
      dragEl     = el;
      // preventDefault stops text selection during drag.
      // Critically: mousedown preventDefault does NOT suppress 'click' in Chromium
      // (unlike pointerdown preventDefault, which does - a previous source of bugs).
      e.preventDefault();
    });
  }

  function onDragMove(e) {
    if (!dragArmed && dragId === null) return;

    // Phase 1: armed, waiting for threshold
    if (dragArmed) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) < 4) return;
      // Threshold crossed - activate drag
      dragArmed = false;
      if (dragEl) {
        dragEl.classList.add('dragging', 'drag-placeholder');
        dragGhostEl = createDragGhost(dragEl);
        positionDragGhost(e.clientX, e.clientY);
      }
      document.body.style.cursor     = 'grabbing';
      document.body.style.userSelect = 'none';
    }

    // Phase 2: actively dragging - update drop indicators
    if (!dragEl || dragId === null) return;
    positionDragGhost(e.clientX, e.clientY);
    autoScrollWhileDragging(e.clientY);
    clearDragIndicators();
    for (const p of PRIORITIES) {
      const rect = SECTIONS[p].getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        SECTIONS[p].classList.add('drop-active');
        const items = [...LISTS[p].querySelectorAll('.task-item:not(.done):not(.dragging):not(.drag-placeholder)')];
        let nearest = null, nearestDist = Infinity;
        items.forEach(item => {
          const ir  = item.getBoundingClientRect();
          const mid = ir.top + ir.height / 2;
          const dist = Math.abs(e.clientY - mid);
          if (dist < nearestDist) { nearestDist = dist; nearest = { item, above: e.clientY < mid }; }
        });
        if (nearest) nearest.item.classList.add(nearest.above ? 'insert-before' : 'insert-after');
        break;
      }
    }
  }

  function onDragUp() {
    // Always restore cursor and selection, regardless of drag state
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';

    // Mouse pressed but never crossed threshold - disarm cleanly, allow click
    if (dragArmed) {
      dragArmed = false;
      dragId    = null;
      dragEl    = null;
      destroyDragGhost();
      return;
    }

    if (dragId === null || !dragEl) return;

    let dropP = null, insertBeforeEl = null, insertAfterEl = null;
    for (const p of PRIORITIES) {
      if (SECTIONS[p].classList.contains('drop-active')) {
        dropP          = p;
        insertBeforeEl = SECTIONS[p].querySelector('.task-item.insert-before');
        insertAfterEl  = SECTIONS[p].querySelector('.task-item.insert-after');
        break;
      }
    }

    const id = dragId;
    dragEl.classList.remove('dragging', 'drag-placeholder');
    destroyDragGhost();
    clearDragIndicators();
    dragId = null; dragEl = null;
    dragJustFinished = true;
    setTimeout(() => { dragJustFinished = false; }, 300);
    if (dropP) commitDrop(dropP, id, insertBeforeEl, insertAfterEl);
  }

  // ── commitDrop ─────────────────────────────────────────────────────────────
  function commitDrop(p, id, insertBeforeEl, insertAfterEl) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    const oldP = task.priority;
    task.priority = p;

    const undoneEls = [...LISTS[p].querySelectorAll('.task-item:not(.done):not(.dragging):not(.drag-placeholder)')];
    const undone = undoneEls
      .map(el => state.tasks.find(t => t.id === parseInt(el.dataset.id, 10)))
      .filter(t => t && t.id !== id);
    const orderKey = t => t.order ?? t.createdAt;

    if (insertBeforeEl) {
      const ref = state.tasks.find(t => t.id === parseInt(insertBeforeEl.dataset.id, 10));
      if (ref) {
        const refIdx = undone.indexOf(ref);
        const prev   = refIdx > 0 ? undone[refIdx - 1] : null;
        task.order   = prev ? (orderKey(prev) + orderKey(ref)) / 2 : orderKey(ref) - 1;
      }
    } else if (insertAfterEl) {
      const ref = state.tasks.find(t => t.id === parseInt(insertAfterEl.dataset.id, 10));
      if (ref) {
        const refIdx = undone.indexOf(ref);
        const next   = refIdx < undone.length - 1 ? undone[refIdx + 1] : null;
        task.order   = next ? (orderKey(ref) + orderKey(next)) / 2 : orderKey(ref) + 1;
      }
    } else if (undone.length > 0) {
      task.order = orderKey(undone[undone.length - 1]) + 1;
    } else {
      task.order = 1;
    }

    // Renormalise if floating point gap gets too dense
    const allUndone = state.tasks.filter(t => t.priority === p && !t.done)
      .sort((a, b) => orderKey(a) - orderKey(b));
    const minGap = allUndone.slice(1).reduce((min, t, i) =>
      Math.min(min, orderKey(t) - orderKey(allUndone[i])), Infinity);
    if (minGap < 0.01) allUndone.forEach((t, i) => { t.order = (i + 1) * 100; });

    saveLocal(); schedulePush();

    if (oldP !== p) {
      PRIORITIES.forEach(pr => {
        setCount(pr);
        EMPTIES[pr].style.display = state.tasks.filter(t => t.priority === pr).length === 0 ? 'block' : 'none';
      });
      updateMustCapHint();
    }
    const sectionsToRender = oldP !== p ? [oldP, p] : [p];
    sectionsToRender.forEach(sp => {
      LISTS[sp].innerHTML = '';
      sortedTasks(sp).forEach(t => LISTS[sp].appendChild(createTaskEl(t)));
      updateDoneCollapse(sp);
    });
    updateProgress(); updateAllCounts();
  }

  function clearDragIndicators() {
    document.querySelectorAll('.insert-before, .insert-after, .drop-active')
      .forEach(el => el.classList.remove('insert-before', 'insert-after', 'drop-active'));
  }

  // ─── Swipe to delete (touch) ──────────────────────────────────────────────
  function setupSwipe(el, id) {
    let startX = 0, startY = 0, dx = 0, axis = null;

    el.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      dx = 0; axis = null; el.style.transition = '';
    }, { passive: true });

    el.addEventListener('touchmove', e => {
      const mx = e.touches[0].clientX - startX;
      const my = e.touches[0].clientY - startY;
      if (axis === null && Math.hypot(mx, my) >= 5)
        axis = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
      if (axis !== 'h') return;
      e.preventDefault();
      dx = Math.min(0, mx);
      el.style.transform = `translateX(${dx}px)`;
    }, { passive: false });

    const onEnd = () => {
      if (axis !== 'h') { axis = null; return; }
      if (Math.abs(dx) >= el.offsetWidth * 0.42) {
        el.style.transition = 'transform 0.2s var(--ease-out)';
        el.style.transform = `translateX(-${el.offsetWidth}px)`;
        setTimeout(() => animateRemove(el, id), 200);
      } else {
        el.style.transition = 'transform 0.25s var(--ease-out)';
        el.style.transform = '';
      }
      axis = null;
    };

    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', () => {
      el.style.transition = 'transform 0.25s var(--ease-out)';
      el.style.transform = ''; axis = null;
    });
  }

  // ─── Done section collapse ────────────────────────────────────────────────
  PRIORITIES.forEach(p => {
    DONE_SUMS[p].addEventListener('click', () => {
      doneCollapsed[p] = !doneCollapsed[p];
      updateDoneCollapse(p);
      // Persist the new collapsed state
      try { localStorage.setItem('taskpad_collapsed', JSON.stringify(doneCollapsed)); } catch {}
    });
  });

  // ─── Add row ──────────────────────────────────────────────────────────────
  let addP = 'must';

  function setAddPriority(p) {
    addP = p;
    addPriority.textContent = PRIORITY_LABELS[p];
    addPriority.dataset.p   = p;
    addSubmit.dataset.p     = p;
  }

  addPriority.addEventListener('click', () => { setAddPriority(PRIORITY_NEXT[addP]); addInput.focus(); });

  addInput.addEventListener('input', () => {
    addSubmit.classList.toggle('visible', addInput.value.trim().length > 0);

    // Live preview of /route prefix - update the priority button as they type
    const val = addInput.value.toLowerCase();
    for (const [prefix, prio] of Object.entries(ROUTE_MAP)) {
      if (val.startsWith(prefix + ' ') || val === prefix) { setAddPriority(prio); return; }
    }
  });

  function submitInput() {
    let text = addInput.value.trim();
    if (!text) return;

    // Parse /route prefix - handles "/must task text" AND just "/must" (sets priority, clears input)
    let priority = addP;
    const lower = text.toLowerCase();
    for (const [prefix, prio] of Object.entries(ROUTE_MAP)) {
      if (lower === prefix) {
        // Bare prefix with no task text - switch priority and clear input, don't add task
        setAddPriority(prio);
        addInput.value = '';
        addSubmit.classList.remove('visible');
        addInput.focus();
        return;
      }
      if (lower.startsWith(prefix + ' ')) {
        priority = prio;
        text = text.slice(prefix.length + 1).trim();
        break;
      }
    }

    if (!text) return;
    addTask(text, priority);
    addInput.value = '';
    addSubmit.classList.remove('visible');
    setAddPriority(priority); // keep priority for rapid-fire adds
    addInput.focus();
  }

  addInput.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); submitInput(); }
    if (e.key === 'Escape') { addInput.blur(); }
  });

  // 1/2/3 priority shortcut when input is focused and empty
  document.addEventListener('keydown', e => {
    if (document.activeElement !== addInput || addInput.value.length > 0) return;
    if (e.key === '1') { e.preventDefault(); setAddPriority('must'); }
    if (e.key === '2') { e.preventDefault(); setAddPriority('should'); }
    if (e.key === '3') { e.preventDefault(); setAddPriority('could'); }
  });

  addSubmit.addEventListener('click', submitInput);
  clearAllBtn.addEventListener('click', () => {
    void clearAllTasks();
  });

  clearDoneBtn.addEventListener('click', () => {
    void clearAllDone();
  });

  // / to focus from anywhere
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== addInput &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      e.preventDefault(); addInput.focus();
    }
  });

  // ─── Platform footer hint ─────────────────────────────────────────────────
  // Swipe hint is only valid on Android. All other contexts get the desktop hint.
  if (isAndroid || isMobile) {
    footerHint.textContent = 'tap text to edit · tap ★ to reprioritise · swipe to delete';
  } else {
    swipeHint.remove();
    footerHint.textContent = '/ focus · click to edit · drag to reorder';
  }

  // ─── Midnight ─────────────────────────────────────────────────────────────
  function scheduleMidnight() {
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
    setTimeout(() => { renderDate(); scheduleMidnight(); }, ms);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  async function init() {
    await loadRuntimeConfig();
    initDrag(); renderBinding(); renderDate(); loadLocal();
    const savedKey = localStorage.getItem(SYNC_KEY_STORE);
    if (workerUrl) {
      if (savedKey) {
        syncKey = savedKey;
        setSyncUI('syncing');
        render();
        await pull({ revealSetupOnSavedKeyError: true });
      }
      else { render(); setupScreen.style.display = 'flex'; }
    } else { setSyncUI('local'); render(); }
    scheduleMidnight();
    if (!isTauri) window.addEventListener('resize', renderBinding);
  }

  void init();
  window.__taskpad = { pull };
})();
