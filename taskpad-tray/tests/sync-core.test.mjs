import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SyncHttpError,
  WORKER_URL_FALLBACK,
  buildSavedKeyFailureMessage,
  describeSyncError,
  getSyncStatusMeta,
  isSavedKeyFailure,
  isValidSyncKey,
  normalizeSyncKey,
  readResponseErrorMessage,
  resolveWorkerUrl,
} from '../src/app/sync-core.mjs';

test('WORKER_URL_FALLBACK is empty - no shared default endpoint', () => {
  assert.equal(WORKER_URL_FALLBACK, '');
});

test('resolveWorkerUrl trims and removes trailing slashes', () => {
  assert.equal(resolveWorkerUrl(' https://example.com/// '), 'https://example.com');
});

test('resolveWorkerUrl returns empty string when no URL is configured', () => {
  assert.equal(resolveWorkerUrl(''), '');
  assert.equal(resolveWorkerUrl('  '), '');
});

test('normalizeSyncKey lowercases and trims input', () => {
  assert.equal(
    normalizeSyncKey('  ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  '),
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  );
});

test('isValidSyncKey accepts only 64-char hex keys', () => {
  assert.equal(isValidSyncKey('a'.repeat(64)), true);
  assert.equal(isValidSyncKey('A'.repeat(64)), true);
  assert.equal(isValidSyncKey('g'.repeat(64)), false);
  assert.equal(isValidSyncKey('a'.repeat(63)), false);
  assert.equal(isValidSyncKey('a'.repeat(65)), false);
});

test('describeSyncError preserves useful HTTP error messages', () => {
  assert.equal(
    describeSyncError(new SyncHttpError('Key not found - call /tasks/init first', 404), 'fallback'),
    'Key not found - call /tasks/init first',
  );
  assert.equal(
    describeSyncError(new SyncHttpError('', 403), 'fallback'),
    'That sync key is not allowed for this list.',
  );
});

test('describeSyncError handles timeout and network errors', () => {
  const timeout = Object.assign(new Error(), { name: 'TimeoutError' });
  assert.equal(
    describeSyncError(timeout, 'fallback'),
    'The sync server took too long to respond.',
  );
  assert.equal(
    describeSyncError(new TypeError('Failed to fetch'), 'fallback'),
    'Could not reach the sync server. Check your internet connection.',
  );
});

test('isSavedKeyFailure only flags auth/not-found failures', () => {
  assert.equal(isSavedKeyFailure(new SyncHttpError('missing', 404)), true);
  assert.equal(isSavedKeyFailure(new SyncHttpError('denied', 403)), true);
  assert.equal(isSavedKeyFailure(new SyncHttpError('denied', 401)), true);
  assert.equal(isSavedKeyFailure(new SyncHttpError('server error', 500)), false);
  assert.equal(isSavedKeyFailure(new Error('network')), false);
});

test('getSyncStatusMeta returns correct copy for known statuses', () => {
  assert.deepEqual(getSyncStatusMeta('synced'), {
    label: 'synced',
    title: 'Click to change sync settings',
  });
  assert.deepEqual(getSyncStatusMeta('local'), {
    label: 'local',
    title: 'Click to configure sync',
  });
  assert.deepEqual(getSyncStatusMeta('error'), {
    label: 'sync error',
    title: 'Sync failed. Click to check your sync settings.',
  });
});

test('getSyncStatusMeta returns passthrough label for unknown status', () => {
  const result = getSyncStatusMeta('some-unknown-state');
  assert.equal(result.label, 'some-unknown-state');
  assert.equal(result.title, 'Click to configure sync');
});

test('buildSavedKeyFailureMessage wraps the rendered sync error', () => {
  const message = buildSavedKeyFailureMessage(new SyncHttpError('Key not found - call /tasks/init first', 404));
  assert.equal(message, 'Saved sync key failed: Key not found - call /tasks/init first');
});

test('readResponseErrorMessage prefers JSON error bodies', async () => {
  const response = new Response(JSON.stringify({ error: 'Key not found' }), {
    status: 404,
    statusText: 'Not Found',
    headers: { 'Content-Type': 'application/json' },
  });

  assert.equal(await readResponseErrorMessage(response), 'Key not found');
});

test('readResponseErrorMessage accepts JSON message field as fallback', async () => {
  const response = new Response(JSON.stringify({ message: 'Rate limited' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });

  assert.equal(await readResponseErrorMessage(response), 'Rate limited');
});

test('readResponseErrorMessage falls back to status text', async () => {
  const response = new Response('', {
    status: 503,
    statusText: 'Service Unavailable',
  });

  assert.equal(await readResponseErrorMessage(response), '503 Service Unavailable');
});

test('readResponseErrorMessage falls back to plain text body', async () => {
  const response = new Response('Worker crashed', {
    status: 500,
    statusText: '',
  });

  assert.equal(await readResponseErrorMessage(response), 'Worker crashed');
});
