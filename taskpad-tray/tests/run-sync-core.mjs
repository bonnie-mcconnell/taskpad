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

async function main() {
  assert.equal(resolveWorkerUrl(' https://example.com/// '), 'https://example.com');
  assert.equal(resolveWorkerUrl(''), WORKER_URL_FALLBACK);

  assert.equal(
    normalizeSyncKey('  ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789  '),
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  );

  assert.equal(isValidSyncKey('a'.repeat(64)), true);
  assert.equal(isValidSyncKey('A'.repeat(64)), true);
  assert.equal(isValidSyncKey('g'.repeat(64)), false);
  assert.equal(isValidSyncKey('a'.repeat(63)), false);

  assert.equal(
    describeSyncError(new SyncHttpError('Key not found - call /tasks/init first', 404), 'fallback'),
    'Key not found - call /tasks/init first',
  );
  assert.equal(
    describeSyncError(new SyncHttpError('', 403), 'fallback'),
    'That sync key is not allowed for this list.',
  );

  assert.equal(isSavedKeyFailure(new SyncHttpError('missing', 404)), true);
  assert.equal(isSavedKeyFailure(new SyncHttpError('denied', 403)), true);
  assert.equal(isSavedKeyFailure(new SyncHttpError('server error', 500)), false);

  assert.deepEqual(getSyncStatusMeta('synced'), {
    label: 'synced',
    title: 'Click to change sync settings',
  });

  assert.equal(
    buildSavedKeyFailureMessage(new SyncHttpError('Key not found - call /tasks/init first', 404)),
    'Saved sync key failed: Key not found - call /tasks/init first',
  );

  const jsonResponse = new Response(JSON.stringify({ error: 'Key not found' }), {
    status: 404,
    statusText: 'Not Found',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(await readResponseErrorMessage(jsonResponse), 'Key not found');

  const emptyResponse = new Response('', {
    status: 503,
    statusText: 'Service Unavailable',
  });
  assert.equal(await readResponseErrorMessage(emptyResponse), '503 Service Unavailable');

  console.log('sync-core tests passed');
}

await main();
