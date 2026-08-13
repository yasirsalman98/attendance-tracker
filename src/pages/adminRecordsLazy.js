export function getStudentGroupKey(sessionId, archived = false) {
  return `${archived ? 'archived' : 'active'}:${sessionId}`;
}

export function replaceSessionRecords(currentRecords, sessionId, nextRecords) {
  return [
    ...currentRecords.filter((record) =>
      sessionId === 'unassigned'
        ? Boolean(record.training_session_id)
        : record.training_session_id !== sessionId
    ),
    ...nextRecords,
  ];
}

export function loadStudentsWithCache({ cache, inFlight, key, load }) {
  if (cache.has(key)) {
    return Promise.resolve(cache.get(key));
  }

  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const request = Promise.resolve()
    .then(load)
    .then((records) => {
      cache.set(key, records);
      return records;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

export async function fetchWithTimeout(
  url,
  options,
  { controller, timeoutMs = 15000, fetchImpl = fetch } = {}
) {
  const requestController = controller || new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: requestController.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error('The request timed out. Please try again.', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
