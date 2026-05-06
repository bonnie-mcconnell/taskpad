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
import {
  applyDropOrdering,
  moveWithinPriority,
} from './app/ordering-core.mjs';

(() => {
  'use strict';

  // Config
  let workerUrl = '';

  // Constants
  const CONFIG_PATH    = 'config.json';
  const CONFIG_LOCAL_PATH = 'config.local.json';
  const STORAGE_KEY    = 'taskpad_v2';
  const SYNC_KEY_STORE = 'taskpad_sync_key';
  const SYNC_META_KEY  = 'taskpad_sync_meta';
  const SYNC_CONFLICT_STORE = 'taskpad_sync_conflict_backup';
  const SWIPE_SHOWN    = 'taskpad_swipe_shown'; // used only on Android/mobile web
  const MUST_CAP       = 3;
  const PRIORITIES     = ['must', 'should', 'could'];
  const TOUCH_MOVE_CANCEL_PX = 10;
  const TOUCH_EDIT_DOUBLE_TAP_MS = 320;
  const SWIPE_AXIS_THRESHOLD_PX = 12;
  const SWIPE_HORIZONTAL_DOMINANCE = 1.45;
  const SWIPE_DELETE_RATIO = 0.55;
  const PERF_ENABLED = localStorage.getItem('taskpad_perf') === '1';

  const LOCALE_KEY = 'taskpad_locale';
  const STRINGS = {
    en: {
      connectExistingList: 'Connect existing list',
      pasteSyncKey: 'Paste your 64-character sync key',
      localOnly: 'Local only',
      skipForNow: 'skip for now',
      setupNewListTitle: 'New list',
      setupNewListDesc: 'First time. Create a new list with a sync key.',
      creating: 'Creating...',
      connecting: 'Connecting...',
      done: 'Done',
      keySaved: 'Key shown above. Save it, then click here.',
      copyToClipboard: 'copy to clipboard',
      copied: 'copied!',
      selectKeyText: 'select the key text above',
      confirm: 'Confirm',
      cancel: 'Cancel',
      overwrite: 'Overwrite',
      keepRemote: 'Keep remote',
      connect: 'Connect',
      replaceLocalTasksTitle: 'Replace local tasks',
      replaceLocalTasksMessage: 'Connecting will replace the tasks currently stored in this app with the remote list for this key.',
      keyMustBe64Hex: 'Key must be 64 hex characters.',
      noWorkerConfigured: 'No worker URL configured.',
      createListError: 'Could not create a new synced list.',
      connectListError: 'Unable to connect this device to that list.',
      clearDone: 'clear done',
      clearDoneTitle: 'Clear done',
      clearDoneMessage: 'Clear all completed tasks from this list?',
      clearDoneLabel: 'Clear done',
      keepThem: 'Keep them',
      clearAll: 'clear all',
      clearAllTitle: 'Clear all tasks',
      clearAllMessage: 'Clear every task from this list? This cannot be undone.',
      clearAllLabel: 'Clear all',
      changePriority: 'Change priority',
      deleteTask: 'Delete task',
      priorityAria: 'Priority: {priority}. Tap to change.',
      priorityMust: '★ must',
      priorityShould: '◆ should',
      priorityCould: '○ could',
      mustBarLabel: '★ {done}/{total}',
      allBarLabel: 'all {done}/{total}',
      allDone: 'all done ✓',
      doneCountShow: '{count} done · {action} to show',
      doneCountHide: '{count} done · {action} to hide',
      tap: 'tap',
      click: 'click',
      footerTouch: 'double tap to edit · swipe left to delete',
      footerDesktop: '/ focus · click to edit · drag to reorder',
      swipeHint: '← swipe left to delete',
      emptyMust: 'What has to happen today?',
      emptyShould: 'What would be good to do?',
      emptyCould: 'What could you do if time allows?',
      mustCapHint: 'You have {count} must{plural}. Be ruthless: what truly cannot wait?',
      taskpadAllDoneTitle: 'Taskpad - all done ✓',
      taskpadMustsLeftTitle: 'Taskpad - {count} must{plural} left',
      taskpadTasksLeftTitle: 'Taskpad - {count} task{plural} left',
      taskpadDefaultTitle: 'Taskpad',
      syncConflictTitle: 'Sync conflict',
      syncConflictMessage: 'This list changed on another device since this app last synced. Overwrite the remote list with the copy from this app?',
      celebrationDone: 'yeah, you did it',
      celebrationMust: 'musts handled',
      dayComplete: 'DAY COMPLETE',
      everythingDone: "everything's done",
      movedUp: '{text} moved up',
      movedDown: '{text} moved down',
      sectionPriority: '{priority} priority',
      selectTheKeyTextAbove: 'select the key text above',
    },
  };

  function normalizeLocale(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw.startsWith('en')) return 'en';
    return 'en';
  }

  let locale = 'en';
  try {
    locale = normalizeLocale(localStorage.getItem(LOCALE_KEY) || navigator.language);
  } catch {
    locale = normalizeLocale(navigator.language);
  }

  function t(key, vars = {}) {
    const table = STRINGS[locale] || STRINGS.en;
    const template = table[key] ?? STRINGS.en[key] ?? key;
    return String(template).replace(/\{(\w+)\}/g, (_, name) => `${vars[name] ?? ''}`);
  }

  function setLocale(nextLocale) {
    locale = normalizeLocale(nextLocale);
    try { localStorage.setItem(LOCALE_KEY, locale); } catch {}
    try { document.documentElement.lang = locale; } catch {}
  }

  const SYMBOLS = { must: '★', should: '◆', could: '○' };
  const PRIORITY_NEXT   = { must: 'should', should: 'could', could: 'must' };
  const PRIORITY_LABELS = { must: t('priorityMust'), should: t('priorityShould'), could: t('priorityCould') };

  function withPerfMark(name, fn) {
    if (!PERF_ENABLED) return fn();
    const t0 = performance.now();
    const out = fn();
    const dt = performance.now() - t0;
    if (dt > 8) console.debug(`[perf] ${name}: ${dt.toFixed(2)}ms`);
    return out;
  }

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
  const isTouchApp = isAndroid || isMobile;

  // State
  // { id, text, priority, done, createdAt, doneAt?, order? }
  let state = { tasks: [], nextId: 1, updatedAt: 0 };

  // Sync state
  let syncKey = null, syncTimer = null, syncInflight = false, syncDirty = false;
  let syncPendingPull = false;
  let syncLastSyncedAt = 0;

  // DOM refs
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
  const setupLocalBtn   = document.getElementById('setupLocalBtn');
  const setupConnectLabel = document.querySelector('.setup-connect-label');
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

  // Accessibility: announce helper
  const A11Y_LIVE = $('a11yLive');
  function announce(msg) { if (!A11Y_LIVE) return; A11Y_LIVE.textContent = ''; setTimeout(() => { A11Y_LIVE.textContent = msg; }, 50); }

  // Done-collapsed state per section
  const doneCollapsed = { must: false, should: false, could: false };
  let confirmResolve = null;
  let confirmActiveElement = null;
  let progressSnapshot = null;
  let queuedCelebration = null;
  let celebrationTimer = 0;

  function applyLocalizedChrome() {
    try { document.documentElement.lang = locale; } catch {}
    const titleEl = setupCreateBtn.querySelector('.setup-action-title');
    const descEl = setupCreateBtn.querySelector('.setup-action-desc');
    if (setupConnectLabel) setupConnectLabel.textContent = t('pasteSyncKey');
    if (setupLocalBtn) setupLocalBtn.textContent = t('localOnly');
    setupConnectBtn.textContent = t('connectExistingList');
    if (titleEl) titleEl.textContent = t('setupNewListTitle');
    if (descEl) descEl.textContent = t('setupNewListDesc');
    if (keyCopyBtn) keyCopyBtn.textContent = t('copyToClipboard');
    if (clearAllBtn) clearAllBtn.textContent = t('clearAll');
    if (clearDoneBtn) clearDoneBtn.textContent = t('clearDone');
    if (confirmTitle) confirmTitle.textContent = t('confirm');
    if (confirmCancelBtn) confirmCancelBtn.textContent = t('cancel');
    if (confirmOkBtn) confirmOkBtn.textContent = t('confirm');
    if (swipeHint) swipeHint.textContent = t('swipeHint');
    if (footerHint) footerHint.textContent = isTouchApp ? t('footerTouch') : t('footerDesktop');
    EMPTIES.must.textContent = t('emptyMust');
    EMPTIES.should.textContent = t('emptyShould');
    EMPTIES.could.textContent = t('emptyCould');
    PRIORITIES.forEach(p => {
      try { SECTIONS[p]?.setAttribute('aria-label', t('sectionPriority', { priority: p })); } catch {}
    });
  }

  function setSetupCreatePhase(phase) {
    const titleEl = setupCreateBtn.querySelector('.setup-action-title');
    const descEl = setupCreateBtn.querySelector('.setup-action-desc');
    if (!titleEl || !descEl) return;
    if (phase === 'creating') {
      titleEl.textContent = t('creating');
      descEl.textContent = t('connecting');
      return;
    }
    if (phase === 'done') {
      titleEl.textContent = t('done');
      descEl.textContent = t('keySaved');
      return;
    }
    titleEl.textContent = t('setupNewListTitle');
    descEl.textContent = t('setupNewListDesc');
  }

  // Persistence
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

  // Sync
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

  // Setup screen
  // Keep setup flow in one button state machine: create, show key, dismiss.
  let createDone = false;
  let connectReplaceConfirmed = false;

  function resetSetupScreen() {
    createDone = false;
    connectReplaceConfirmed = false;
    setupCreateBtn.disabled = false;
    setupConnectBtn.disabled = false;
    setupConnectBtn.textContent = t('connectExistingList');
    setSetupCreatePhase('idle');
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
    title = t('confirm'),
    message,
    confirmLabel = t('confirm'),
    cancelLabel = t('cancel'),
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
    setupCreateBtn.disabled = true;
    setSetupCreatePhase('creating');
    setupError.style.display = 'none';
    try {
      const res = await fetch(`${workerUrl}/tasks/init`, { method: 'POST', signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new SyncHttpError(await readResponseErrorMessage(res), res.status);
      const { key } = await res.json();
      syncKey = key; localStorage.setItem(SYNC_KEY_STORE, key);
      keyValue.textContent = key; keyDisplay.style.display = 'block';
      setSetupCreatePhase('done');
      setupCreateBtn.disabled = false;
      createDone = true; // next click will dismiss
    } catch (err) {
      console.error('Taskpad list creation failed:', err);
      setupError.textContent = describeSyncError(err, t('createListError'));
      setupError.style.display = 'block';
      setupCreateBtn.disabled = false;
      setSetupCreatePhase('idle');
    }
  });

  keyCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(keyValue.textContent);
      keyCopyBtn.textContent = t('copied');
      setTimeout(() => { keyCopyBtn.textContent = t('copyToClipboard'); }, 2000);
    } catch { keyCopyBtn.textContent = t('selectKeyText'); }
  });

  setupConnectBtn.addEventListener('click', async () => {
    const key = normalizeSyncKey(setupKeyInput.value);
    if (!isValidSyncKey(key)) { setupError.textContent = t('keyMustBe64Hex'); setupError.style.display = 'block'; return; }
    if (!workerUrl) { setupError.textContent = t('noWorkerConfigured'); setupError.style.display = 'block'; return; }
    if (state.tasks.length > 0 && !connectReplaceConfirmed) {
      const ok = await confirmAction({
        title: t('replaceLocalTasksTitle'),
        message: t('replaceLocalTasksMessage'),
        confirmLabel: t('connect'),
        cancelLabel: t('cancel'),
      });
      if (!ok) return;
      connectReplaceConfirmed = true;
    }
    setupConnectBtn.disabled = true; setupConnectBtn.textContent = t('connecting');
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
      setupError.textContent = describeSyncError(err, t('connectListError'));
      setupError.style.display = 'block';
      setupConnectBtn.disabled = false; setupConnectBtn.textContent = t('connectExistingList');
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

  // Rendering helpers
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
    headerDate.textContent = new Date().toLocaleDateString(locale, {
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
    mustLabel.textContent = mTotal === 0 ? '-' : t('mustBarLabel', { done: mDone, total: mTotal });

    // Total bar
    const all     = state.tasks;
    const aDone   = all.filter(t => t.done).length;
    const aTotal  = all.length;
    const aPct    = aTotal === 0 ? 0 : Math.round(aDone / aTotal * 100);
    totalFill.style.width = aPct + '%';
    totalLabel.textContent = aTotal === 0 ? '-' : t('allBarLabel', { done: aDone, total: aTotal });

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
      const mustPlural = mustUndone === 1 ? '' : 's';
      const taskPlural = allUndone === 1 ? '' : 's';
      if (allUndone === 0 && aTotal > 0) tip = t('taskpadAllDoneTitle');
      else if (mustUndone > 0) tip = t('taskpadMustsLeftTitle', { count: mustUndone, plural: mustPlural });
      else if (allUndone > 0)  tip = t('taskpadTasksLeftTitle', { count: allUndone, plural: taskPlural });
      else                     tip = t('taskpadDefaultTitle');
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
    banner.textContent = kind === 'all' ? t('celebrationDone') : t('celebrationMust');
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
      <div class="celebration-center-main">${t('dayComplete')}</div>
      <div class="celebration-center-sub">${t('everythingDone')}</div>
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
      mustCapHint.textContent = t('mustCapHint', { count: undone, plural: undone === 1 ? '' : 's' });
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
    else if (tasks.length > 0) { el.textContent = t('allDone'); el.classList.add('all-done'); }
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
    const action = (isMobile || isAndroid) ? t('tap') : t('click');
    summary.textContent = collapsed
      ? t('doneCountShow', { count: doneEls.length, action })
      : t('doneCountHide', { count: doneEls.length, action });

    doneEls.forEach(el => { el.style.display = collapsed ? 'none' : ''; });
  }

  // Build task element
  function createTaskEl(task) {
    const li = document.createElement('li');
    li.className = `task-item ${task.priority}${task.done ? ' done' : ''}`;
    li.dataset.id = String(task.id);
    li.classList.toggle('reorderable', !task.done && !isTouchApp);
    // Accessibility
    li.tabIndex = 0;
    li.setAttribute('role', 'listitem');
    li.setAttribute('aria-grabbed', 'false');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.className = 'task-check';
    checkbox.checked = task.done;
    checkbox.setAttribute('aria-label', task.text);

    const priorityBtn = document.createElement('button');
    priorityBtn.className = 'task-priority-btn';
    priorityBtn.textContent = SYMBOLS[task.priority];
    priorityBtn.title = t('changePriority');
    priorityBtn.setAttribute('aria-label', t('priorityAria', { priority: task.priority }));

    const body = document.createElement('div');
    body.className = 'task-body';
    const span = document.createElement('span');
    span.className = 'task-text'; span.textContent = task.text;
    body.appendChild(span);

    const del = document.createElement('button');
    del.className = 'task-delete';
    del.setAttribute('aria-label', t('deleteTask'));
    del.textContent = '×';

    li.append(checkbox, priorityBtn, body, del);

    checkbox.addEventListener('change', () => toggleDone(task.id, li, checkbox.checked));
    del.addEventListener('click', e => { e.stopPropagation(); animateRemove(li, task.id); });
    priorityBtn.addEventListener('click', e => { e.stopPropagation(); changePriority(task.id, li, priorityBtn); });

    // Desktop edits on click. Touch devices use double-tap so normal taps do not
    // open the keyboard while scrolling or changing priority.
    let editTapAt = 0;
    let editTouchStartX = 0, editTouchStartY = 0, editTouchMoved = false;
    body.addEventListener('click', e => {
      if (isTouchApp) return;
      if (dragJustFinished) return;
      if (li.classList.contains('done')) return;
      if (e.target.closest('.task-check') || e.target.closest('.task-delete') || e.target.closest('.task-priority-btn') || e.target.closest('.task-edit-input')) return;
      startEdit(task.id, li, span);
    });
    li.addEventListener('keydown', e => {
      if ((e.altKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        moveTaskWithinPriority(task.id, dir);
        announce(dir === -1 ? t('movedUp', { text: task.text }) : t('movedDown', { text: task.text }));
        setTimeout(() => { try { li.focus(); } catch(e) {} }, 40);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); document.getElementById('undoBtn')?.click(); }
    });
    span.addEventListener('dblclick', e => { e.preventDefault(); e.stopPropagation(); if (!isTouchApp) startEdit(task.id, li, span); });
    body.addEventListener('touchstart', e => {
      if (!isTouchApp) return;
      if (e.touches.length !== 1) return;
      editTouchStartX = e.touches[0].clientX;
      editTouchStartY = e.touches[0].clientY;
      editTouchMoved = false;
    }, { passive: true });
    body.addEventListener('touchmove', e => {
      if (!isTouchApp) return;
      const t = e.touches[0];
      if (!t) return;
      editTouchMoved ||= Math.hypot(t.clientX - editTouchStartX, t.clientY - editTouchStartY) > TOUCH_MOVE_CANCEL_PX;
    }, { passive: true });
    body.addEventListener('touchend', e => {
      if (!isTouchApp) return;
      if (dragJustFinished || editTouchMoved || li.classList.contains('done')) return;
      if (e.target.closest('.task-check') || e.target.closest('.task-delete') || e.target.closest('.task-priority-btn') || e.target.closest('.task-edit-input')) return;
      const now = Date.now();
      if (now - editTapAt < TOUCH_EDIT_DOUBLE_TAP_MS) {
        e.preventDefault();
        startEdit(task.id, li, span);
        editTapAt = 0;
      } else {
        editTapAt = now;
      }
    });

    // Drag and drop uses mouse events for desktop reordering.
    if (!task.done && !isTouchApp) {
      setupDrag(li, task.id);
    }
    // Swipe-to-delete: Android/mobile only, with thresholds that avoid scroll clashes.
    if (isTouchApp) setupSwipe(li, task.id);

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
    withPerfMark('render', () => {
      for (const p of PRIORITIES) {
        LISTS[p].innerHTML = '';
        sortedTasks(p).forEach(t => LISTS[p].appendChild(createTaskEl(t)));
        updateDoneCollapse(p);
      }
      updateAllCounts();
      updateProgress();
      updateMustCapHint();
      updateClearDone();
    });

    if ((isAndroid || isMobile) && state.tasks.length > 0 && !localStorage.getItem(SWIPE_SHOWN)) {
      swipeHint.style.display = 'block';
      setTimeout(() => { swipeHint.style.display = 'none'; localStorage.setItem(SWIPE_SHOWN, '1'); }, 3000);
    }
  }

  // Mutations
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

  // Burst particle effect
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
    li.classList.toggle('reorderable', !checked && !isTouchApp);

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

  // Undo system
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

  function moveTaskWithinPriority(id, direction) {
    const task = state.tasks.find(t => t.id === id);
    if (!task || task.done) return;

    const result = moveWithinPriority(state.tasks, id, direction);
    if (!result.moved) return;

    saveLocal();
    schedulePush();

    LISTS[task.priority].innerHTML = '';
    sortedTasks(task.priority).forEach(t => LISTS[task.priority].appendChild(createTaskEl(t)));
    updateDoneCollapse(task.priority);
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

  // Edit in place
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

  // Animated remove
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

  // Drag and drop
  // Mouse events are used here because pointer events are unreliable in the
  // embedded WebView when dragging inside scrollable content.
  let dragId           = null;
  let dragEl           = null;
  let dragGhostEl      = null;
  let dragStartX       = 0;
  let dragStartY       = 0;
  let dragOffsetX      = 0;
  let dragOffsetY      = 0;
  let dragLastX        = 0;
  let dragLastY        = 0;
  let dragDropPriority = null;
  let dragArmed        = false;  // mousedown fired, waiting for movement threshold
  let dragJustFinished = false;  // suppresses click-to-edit after a successful drop
  let dragMoveRafQueued = false;
  let dragMoveNextX = 0;
  let dragMoveNextY = 0;

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

  function resolveDropTarget(clientX, clientY) {
    let dropP = null;
    const hit = document.elementFromPoint(clientX, clientY)?.closest?.('.section-block');
    if (hit) dropP = PRIORITIES.find(p => SECTIONS[p] === hit) ?? null;

    if (!dropP) {
      let closest = null, closestDistance = Infinity;
      for (const p of PRIORITIES) {
        const rect = SECTIONS[p].getBoundingClientRect();
        if (clientY >= rect.top - 28 && clientY <= rect.bottom + 28) {
          dropP = p;
          break;
        }
        const distance = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = p;
        }
      }
      dropP ??= closest;
    }

    if (!dropP) return { dropP: null, insertBeforeEl: null, insertAfterEl: null };

    const items = [...LISTS[dropP].querySelectorAll('.task-item:not(.done):not(.dragging):not(.drag-placeholder)')];
    let nearest = null, nearestDist = Infinity;
    items.forEach(item => {
      const rect = item.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - mid);
      if (dist < nearestDist) {
        nearest = { item, above: clientY < mid };
        nearestDist = dist;
      }
    });

    return {
      dropP,
      insertBeforeEl: nearest?.above ? nearest.item : null,
      insertAfterEl: nearest && !nearest.above ? nearest.item : null,
    };
  }

  function activateDrag(clientX, clientY) {
    dragLastX = clientX;
    dragLastY = clientY;
    dragArmed = false;
    if (dragEl) {
      dragEl.classList.add('dragging', 'drag-placeholder');
      dragGhostEl = createDragGhost(dragEl);
      positionDragGhost(clientX, clientY);
    }
    document.body.style.cursor     = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  function moveDragPlaceholder(dropP, insertBeforeEl, insertAfterEl) {
    if (!dragEl || !dropP) return;
    const list = LISTS[dropP];
    if (insertBeforeEl) {
      list.insertBefore(dragEl, insertBeforeEl);
    } else if (insertAfterEl) {
      list.insertBefore(dragEl, insertAfterEl.nextSibling);
    } else {
      const firstDone = list.querySelector('.task-item.done');
      firstDone ? list.insertBefore(dragEl, firstDone) : list.appendChild(dragEl);
    }
    dragDropPriority = dropP;
  }

  function getPlaceholderDropTarget() {
    if (!dragEl) return { dropP: null, insertBeforeEl: null, insertAfterEl: null };
    const list = dragEl.parentElement;
    const dropP = PRIORITIES.find(p => LISTS[p] === list) ?? dragDropPriority;
    if (!dropP) return { dropP: null, insertBeforeEl: null, insertAfterEl: null };

    const prev = dragEl.previousElementSibling;
    const next = dragEl.nextElementSibling;
    return {
      dropP,
      insertBeforeEl: next?.matches?.('.task-item:not(.done)') ? next : null,
      insertAfterEl: prev?.matches?.('.task-item:not(.done)') ? prev : null,
    };
  }

  function updateDragPosition(clientX, clientY) {
    if (!dragEl || dragId === null) return;
    dragLastX = clientX;
    dragLastY = clientY;
    positionDragGhost(clientX, clientY);
    autoScrollWhileDragging(clientY);
    clearDragIndicators();
    const { dropP, insertBeforeEl, insertAfterEl } = resolveDropTarget(clientX, clientY);
    if (!dropP) return;
    moveDragPlaceholder(dropP, insertBeforeEl, insertAfterEl);
    SECTIONS[dropP].classList.add('drop-active');
  }

  function queueDragPosition(clientX, clientY) {
    dragMoveNextX = clientX;
    dragMoveNextY = clientY;
    if (dragMoveRafQueued) return;
    dragMoveRafQueued = true;
    requestAnimationFrame(() => {
      dragMoveRafQueued = false;
      updateDragPosition(dragMoveNextX, dragMoveNextY);
    });
  }

  function onDragMove(e) {
    if (!dragArmed && dragId === null) return;

    // Phase 1: armed, waiting for threshold
    if (dragArmed) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.hypot(dx, dy) < 4) return;
      activateDrag(e.clientX, e.clientY);
    }

    queueDragPosition(e.clientX, e.clientY);
  }

  function finishDrag() {
    // Always restore cursor and selection, regardless of drag state
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    listArea.style.touchAction = '';

    // Mouse pressed but never crossed threshold - disarm cleanly, allow click
    if (dragArmed) {
      dragArmed = false;
      dragId    = null;
      dragEl    = null;
      dragDropPriority = null;
      destroyDragGhost();
      clearDragIndicators();
      return;
    }

    if (dragId === null || !dragEl) {
      dragDropPriority = null;
      destroyDragGhost();
      clearDragIndicators();
      return;
    }

    let { dropP, insertBeforeEl, insertAfterEl } = getPlaceholderDropTarget();
    if (!dropP) {
      ({ dropP, insertBeforeEl, insertAfterEl } = resolveDropTarget(dragLastX, dragLastY));
    }
    if (!dropP) {
      for (const p of PRIORITIES) {
        if (SECTIONS[p].classList.contains('drop-active')) {
          dropP          = p;
          insertBeforeEl = SECTIONS[p].querySelector('.task-item.insert-before');
          insertAfterEl  = SECTIONS[p].querySelector('.task-item.insert-after');
          break;
        }
      }
    }

    const id = dragId;
    dragEl.classList.remove('dragging', 'drag-placeholder');
    destroyDragGhost();
    clearDragIndicators();
    dragId = null; dragEl = null; dragDropPriority = null;
    dragJustFinished = true;
    setTimeout(() => { dragJustFinished = false; }, 420);
    if (dropP) commitDrop(dropP, id, insertBeforeEl, insertAfterEl);
  }

  function onDragUp() {
    finishDrag();
  }

  // commitDrop
  function commitDrop(p, id, insertBeforeEl, insertAfterEl) {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    const oldP = task.priority;
    const insertBeforeId = insertBeforeEl ? parseInt(insertBeforeEl.dataset.id, 10) : null;
    const insertAfterId = insertAfterEl ? parseInt(insertAfterEl.dataset.id, 10) : null;
    withPerfMark('drop-ordering', () => applyDropOrdering(state.tasks, p, id, insertBeforeId, insertAfterId));

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

  // Swipe to delete (touch)
  function setupSwipe(el, id) {
    let startX = 0, startY = 0, dx = 0, axis = null;
    const vibrate = pattern => {
      try { if (navigator?.vibrate) navigator.vibrate(pattern); } catch (e) { /* noop */ }
    };

    el.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      dx = 0; axis = null; el.style.transition = '';
      el.classList.add('touch-primed');
    }, { passive: true });

    el.addEventListener('touchmove', e => {
      const mx = e.touches[0].clientX - startX;
      const my = e.touches[0].clientY - startY;
      if (axis === null && Math.hypot(mx, my) >= SWIPE_AXIS_THRESHOLD_PX)
        axis = Math.abs(mx) > Math.abs(my) * SWIPE_HORIZONTAL_DOMINANCE ? 'h' : 'v';
      if (axis !== 'h') return;
      e.preventDefault();
      dx = Math.min(0, mx);
      el.style.transform = `translateX(${dx}px)`;
    }, { passive: false });

    const onEnd = () => {
      if (axis !== 'h') { axis = null; el.classList.remove('touch-primed'); return; }
      if (Math.abs(dx) >= el.offsetWidth * SWIPE_DELETE_RATIO) {
        vibrate(10);
        el.style.transition = 'transform 0.2s var(--ease-out)';
        el.style.transform = `translateX(-${el.offsetWidth}px)`;
        setTimeout(() => animateRemove(el, id), 200);
      } else {
        el.style.transition = 'transform 0.25s var(--ease-out)';
        el.style.transform = '';
      }
      el.classList.remove('touch-primed');
      axis = null;
    };

    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', () => {
      el.style.transition = 'transform 0.25s var(--ease-out)';
      el.style.transform = ''; axis = null;
      el.classList.remove('touch-primed');
    });
  }

  // Done section collapse
  PRIORITIES.forEach(p => {
    DONE_SUMS[p].addEventListener('click', () => {
      doneCollapsed[p] = !doneCollapsed[p];
      updateDoneCollapse(p);
      // Persist the new collapsed state
      try { localStorage.setItem('taskpad_collapsed', JSON.stringify(doneCollapsed)); } catch {}
    });
  });

  // Add row
  let addP = 'must';

  function setAddPriority(p) {
    addP = p;
    addPriority.textContent = PRIORITY_LABELS[p];
    addPriority.dataset.p   = p;
    addSubmit.dataset.p     = p;
  }

  addPriority.addEventListener('click', () => {
    setAddPriority(PRIORITY_NEXT[addP]);
    if (!isTouchApp) addInput.focus();
  });

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
        if (isTouchApp) addInput.blur();
        else addInput.focus();
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
    if (isTouchApp) addInput.blur();
    else addInput.focus();
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

  // Platform footer hint
  // Swipe hint is only valid on Android. All other contexts get the desktop hint.
  if (isAndroid) {
    footerHint.textContent = t('footerTouch');
  } else {
    swipeHint.remove();
    footerHint.textContent = t('footerDesktop');
  }

  // Midnight
  function scheduleMidnight() {
    const now = new Date();
    const ms = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
    setTimeout(() => { renderDate(); scheduleMidnight(); }, ms);
  }

  // Init
  async function init() {
    await loadRuntimeConfig();
    initDrag(); renderBinding(); renderDate(); loadLocal();
    applyLocalizedChrome();
    window.TaskpadLocale = {
      get: () => locale,
      set: value => {
        setLocale(value);
        applyLocalizedChrome();
        renderDate();
      },
    };
    // Accessibility: expose list roles and section labels
    PRIORITIES.forEach(p => {
      try { LISTS[p]?.setAttribute('role', 'list'); } catch(e) {}
      try { SECTIONS[p]?.setAttribute('aria-label', t('sectionPriority', { priority: p })); } catch(e) {}
    });
    // Header undo helper
    const hUndo = document.getElementById('headerUndoBtn');
    if (hUndo) { hUndo.style.display = ''; hUndo.addEventListener('click', () => document.getElementById('undoBtn')?.click()); }
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { const b = document.getElementById('undoBtn'); if (b) { e.preventDefault(); b.click(); } } });
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
