export const WORKER_URL_FALLBACK = 'https://taskpad-sync.taskpad-sync.workers.dev';

export class SyncHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SyncHttpError';
    this.status = status;
  }
}

export function resolveWorkerUrl(configuredUrl) {
  return (configuredUrl || WORKER_URL_FALLBACK).trim().replace(/\/+$/, '');
}

export async function readResponseErrorMessage(response) {
  let raw = '';
  try {
    raw = await response.text();
  } catch {}

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim();
      if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    } catch {}

    const text = raw.trim();
    if (text) return text;
  }

  return `${response.status} ${response.statusText || 'Request failed'}`.trim();
}

export function describeSyncError(error, fallback) {
  if (error instanceof SyncHttpError) {
    if (error.status === 404) return error.message || 'That sync key was not found.';
    if (error.status === 401 || error.status === 403) {
      return error.message || 'That sync key is not allowed for this list.';
    }
    return error.message || fallback;
  }

  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'The sync server took too long to respond.';
  }

  if (error instanceof TypeError) {
    return 'Could not reach the sync server. Check your internet connection.';
  }

  return fallback;
}

export function isSavedKeyFailure(error) {
  return error instanceof SyncHttpError && [401, 403, 404].includes(error.status);
}

export function normalizeSyncKey(value) {
  return value.trim().toLowerCase();
}

export function isValidSyncKey(value) {
  return /^[a-f0-9]{64}$/.test(normalizeSyncKey(value));
}

export function getSyncStatusMeta(status) {
  return {
    local: {
      label: 'local',
      title: 'Click to configure sync',
    },
    syncing: {
      label: 'syncing...',
      title: 'Syncing with your remote list',
    },
    synced: {
      label: 'synced',
      title: 'Click to change sync settings',
    },
    error: {
      label: 'sync error',
      title: 'Sync failed. Click to check your sync settings.',
    },
    conflict: {
      label: 'sync conflict',
      title: 'Another device changed the list. Click to review sync settings.',
    },
  }[status] ?? {
    label: status,
    title: 'Click to configure sync',
  };
}

export function buildSavedKeyFailureMessage(error) {
  return `Saved sync key failed: ${describeSyncError(error, 'Unable to load the remote list.')}`;
}
