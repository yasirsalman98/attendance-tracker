import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWithTimeout,
  getStudentGroupKey,
  loadStudentsWithCache,
  replaceSessionRecords,
} from '../src/pages/adminRecordsLazy.js';

test('active and archived student caches cannot collide', () => {
  assert.equal(getStudentGroupKey('class-1'), 'active:class-1');
  assert.equal(getStudentGroupKey('class-1', true), 'archived:class-1');
});

test('duplicate student requests share one in-flight request and reopen from cache', async () => {
  const cache = new Map();
  const inFlight = new Map();
  let requests = 0;
  let resolveRequest;
  const load = () => {
    requests += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };
  const options = { cache, inFlight, key: 'active:class-1', load };
  const first = loadStudentsWithCache(options);
  const duplicate = loadStudentsWithCache(options);

  await Promise.resolve();
  assert.equal(requests, 1);
  resolveRequest([{ id: 'student-1' }]);
  assert.deepEqual(await first, [{ id: 'student-1' }]);
  assert.deepEqual(await duplicate, [{ id: 'student-1' }]);
  assert.deepEqual(await loadStudentsWithCache(options), [{ id: 'student-1' }]);
  assert.equal(requests, 1);
});

test('a failed student request is not cached and can be retried', async () => {
  const cache = new Map();
  const inFlight = new Map();
  let requests = 0;
  const options = {
    cache,
    inFlight,
    key: 'active:class-2',
    load: async () => {
      requests += 1;
      if (requests === 1) throw new Error('temporary failure');
      return [];
    },
  };

  await assert.rejects(loadStudentsWithCache(options), /temporary failure/);
  assert.equal(inFlight.size, 0);
  assert.deepEqual(await loadStudentsWithCache(options), []);
  assert.equal(requests, 2);
  assert.equal(cache.has(options.key), true);
});

test('loaded students replace only their class, including the empty state', () => {
  const current = [
    { id: 'old-a', training_session_id: 'class-a' },
    { id: 'student-b', training_session_id: 'class-b' },
  ];

  assert.deepEqual(replaceSessionRecords(current, 'class-a', []), [
    { id: 'student-b', training_session_id: 'class-b' },
  ]);
  assert.deepEqual(
    replaceSessionRecords(current, 'class-a', [
      { id: 'new-a', training_session_id: 'class-a' },
    ]),
    [
      { id: 'student-b', training_session_id: 'class-b' },
      { id: 'new-a', training_session_id: 'class-a' },
    ]
  );
});

test('duplicate trainer signature paths reuse the same request and cached URL', async () => {
  const cache = new Map();
  const inFlight = new Map();
  let requests = 0;
  const options = {
    cache,
    inFlight,
    key: 'owner/trainer-signatures/shared.png',
    load: async () => {
      requests += 1;
      await Promise.resolve();
      return 'signed-url';
    },
  };

  const [first, second] = await Promise.all([
    loadStudentsWithCache(options),
    loadStudentsWithCache(options),
  ]);
  assert.equal(first, 'signed-url');
  assert.equal(second, 'signed-url');
  assert.equal(await loadStudentsWithCache(options), 'signed-url');
  assert.equal(requests, 1);
});

test('request timeout aborts and always rejects with a useful timeout message', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

  await assert.rejects(
    fetchWithTimeout('/slow', {}, { controller, timeoutMs: 5, fetchImpl }),
    /timed out/i
  );
  assert.equal(controller.signal.aborted, true);
});

test('caller abort remains distinguishable from a timeout', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
  const request = fetchWithTimeout(
    '/abort',
    {},
    { controller, timeoutMs: 1000, fetchImpl }
  );
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});
