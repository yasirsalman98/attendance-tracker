import {
  HISTORICAL_CLASS_FIXTURE_SESSIONS,
  HISTORICAL_CLASS_FIXTURE_STUDENTS,
} from './historicalClassFixtures.js';

const submissions = new Map();
const READ_RESPONSE_VERSION = 'historical-class-read-v1';
const RETIRED_LOCAL_CLASSES_STORAGE_KEY = 'excourse-private-historical-classes-v1';
const LOCAL_CLASSES_STORAGE_KEY = 'excourse-private-historical-classes-v2';

function isPrivateLocalBrowser() {
  const hostname = globalThis.location?.hostname;
  return !hostname || ['localhost', '127.0.0.1'].includes(hostname);
}

if (isPrivateLocalBrowser()) {
  try {
    globalThis.localStorage?.removeItem(RETIRED_LOCAL_CLASSES_STORAGE_KEY);
  } catch {
    // Browser privacy settings may disable storage; there is no persisted test to remove.
  }
}

function getHistoricalClassUrl() {
  if (['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    return 'http://localhost:3001/.netlify/functions/historical-class';
  }
  return '/.netlify/functions/historical-class';
}

async function readJson(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Unable to load attendance records.');
  if (data?.responseVersion !== READ_RESPONSE_VERSION) {
    throw new Error('The historical-class read endpoint is not available. Restart the local server.');
  }
  return data;
}

export async function searchHistoricalSourceClasses({ accessToken, search = '', page = 1 } = {}) {
  const query = new URLSearchParams({ view: 'sources', search, page: String(page) });
  const response = await fetch(`${getHistoricalClassUrl()}?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return readJson(response);
}

export async function loadHistoricalSourceStudents(sessionId, accessToken) {
  const query = new URLSearchParams({ view: 'students', sessionId });
  const response = await fetch(`${getHistoricalClassUrl()}?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await readJson(response);
  return data.students;
}

export async function createHistoricalClass({ accessToken, payload }) {
  const response = await fetch(getHistoricalClassUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Unable to create historical class.');
  return data;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readStoredClasses() {
  if (!isPrivateLocalBrowser()) return [];
  try {
    const value = globalThis.localStorage?.getItem(LOCAL_CLASSES_STORAGE_KEY);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredClasses(classes) {
  if (!isPrivateLocalBrowser()) return;
  try {
    globalThis.localStorage?.setItem(LOCAL_CLASSES_STORAGE_KEY, JSON.stringify(classes));
  } catch {
    // The in-memory fallback supports isolated tests when browser storage is unavailable.
  }
}

export function getLocalHistoricalClasses() {
  return clone(readStoredClasses().map(({ idempotency_key: ignoredKey, ...item }) => {
    void ignoredKey;
    return item;
  }));
}

export function getLocalHistoricalClass(sessionId) {
  return getLocalHistoricalClasses().find((item) => item.id === sessionId) || null;
}

export function getLocalHistoricalStudentArchives() {
  return getLocalHistoricalClasses().flatMap((item) =>
    (item.local_archived_students || []).map((archived) => ({
      ...archived.student,
      id: `${item.id}:archived:${archived.source_attendance_id}`,
      source_attendance_id: archived.source_attendance_id,
      training_session_id: item.id,
      archived_at: archived.archived_at,
      archive_delete_after: archived.archive_delete_after,
      archive_type: 'student',
      is_local_historical_test: true,
      training_sessions: item,
    }))
  );
}

export function archiveLocalHistoricalStudent(sessionId, sourceAttendanceId) {
  const classes = readStoredClasses();
  const nextClasses = classes.map((item) => {
    if (item.id !== sessionId) return item;
    const selectedIds = (item.selected_source_attendance_ids || [])
      .filter((id) => id !== sourceAttendanceId);
    const archivedAt = new Date();
    const deleteAfter = new Date(archivedAt);
    deleteAfter.setDate(deleteAfter.getDate() + 30);
    const sourceStudent = (item.source_students || [])
      .find((student) => student.source_attendance_id === sourceAttendanceId) || {};
    return {
      ...item,
      selected_source_attendance_ids: selectedIds,
      student_count: selectedIds.length,
      local_archived_students: [
        ...(item.local_archived_students || []),
        {
          source_attendance_id: sourceAttendanceId,
          student: sourceStudent,
          archived_at: archivedAt.toISOString(),
          archive_delete_after: deleteAfter.toISOString(),
        },
      ],
    };
  });
  writeStoredClasses(nextClasses);
}

export function restoreLocalHistoricalStudent(sessionId, sourceAttendanceId) {
  const classes = readStoredClasses();
  const nextClasses = classes.map((item) => {
    if (item.id !== sessionId) return item;
    const archivedStudents = (item.local_archived_students || [])
      .filter((entry) => entry.source_attendance_id !== sourceAttendanceId);
    const selectedIds = new Set(item.selected_source_attendance_ids || []);
    selectedIds.add(sourceAttendanceId);
    return {
      ...item,
      selected_source_attendance_ids: [...selectedIds],
      local_archived_students: archivedStudents,
      student_count: selectedIds.size,
    };
  });
  writeStoredClasses(nextClasses);
}

export async function searchHistoricalSourceFixtures({ search = '', page = 1, pageSize = 1 } = {}) {
  await Promise.resolve();
  const needle = String(search).trim().toLowerCase();
  const matches = HISTORICAL_CLASS_FIXTURE_SESSIONS.filter((session) =>
    [
      session.course_name,
      session.training_date,
      session.trainer_name,
      session.company_name,
      session.training_location,
    ].some((value) => String(value || '').toLowerCase().includes(needle))
  );
  const offset = (page - 1) * pageSize;
  return {
    sessions: clone(matches.slice(offset, offset + pageSize)),
    total: matches.length,
    page,
    pageSize,
  };
}

export async function loadHistoricalSourceStudentsFixture(sessionId) {
  await Promise.resolve();
  const students = HISTORICAL_CLASS_FIXTURE_STUDENTS[sessionId];
  if (!students) throw new Error('The local source-class fixture was not found.');
  return clone(students);
}

export async function createHistoricalClassFixture(draft, { fail = false } = {}) {
  await Promise.resolve();
  if (fail) throw new Error('Simulated local request failure. No class was created.');
  const storedClasses = readStoredClasses();
  const stored = storedClasses.find((item) => item.idempotency_key === draft.idempotency_key);
  if (stored) return { createdAt: stored.created_at, sessionId: stored.id, repeated: true };
  if (submissions.has(draft.idempotency_key)) {
    return { ...clone(submissions.get(draft.idempotency_key)), repeated: true };
  }
  const createdAt = new Date().toISOString();
  const sessionId = `local-historical-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  const storedClass = {
    ...draft.class,
    id: sessionId,
    created_at: createdAt,
    expires_at: null,
    trainer_signature_path: null,
    student_count: draft.students.length,
    is_local_historical_test: true,
    source_session_id: draft.source.session_id,
    selected_source_attendance_ids: [...draft.selected_source_attendance_ids],
    source_students: draft.students.map((student, index) => ({
      ...student,
      source_attendance_id: draft.selected_source_attendance_ids[index],
    })),
    local_archived_students: [],
    idempotency_key: draft.idempotency_key,
  };
  writeStoredClasses([storedClass, ...storedClasses]);
  const result = {
    createdAt,
    sessionId,
    selectedStudentCount: draft.students.length,
    productionWrites: 0,
    storageWrites: 0,
  };
  submissions.set(draft.idempotency_key, result);
  return clone(result);
}

export function resetHistoricalClassFixtureSubmissions() {
  submissions.clear();
}
