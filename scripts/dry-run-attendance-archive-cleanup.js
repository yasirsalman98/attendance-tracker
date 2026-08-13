import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import process from 'node:process';

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Supabase service-role configuration is missing.');

const client = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const now = new Date().toISOString();

async function must(query) {
  const result = await query;
  if (result.error) throw result.error;
  return result.data || [];
}

async function objectExists(bucket, path) {
  if (!path) return false;
  const result = await client.storage.from(bucket).download(path);
  if (!result.error) return true;
  if (/not found/i.test(result.error.message || '')) return false;
  throw result.error;
}

async function pathIsShared(bucket, path, excludedRecordIds, excludedSessionIds = []) {
  if (!path) return false;
  const column = bucket === 'attendance-photos' ? 'photo_path' : 'signature_path';
  let recordsQuery = client.from('attendance_records').select('id').eq(column, path);
  if (excludedRecordIds.length) {
    recordsQuery = recordsQuery.not('id', 'in', `(${excludedRecordIds.join(',')})`);
  }
  const records = await must(recordsQuery.limit(1));
  if (records.length) return true;
  if (bucket !== 'signatures') return false;
  let sessionsQuery = client.from('training_sessions').select('id').eq('trainer_signature_path', path);
  if (excludedSessionIds.length) {
    sessionsQuery = sessionsQuery.not('id', 'in', `(${excludedSessionIds.join(',')})`);
  }
  return (await must(sessionsQuery.limit(1))).length > 0;
}

async function dependenciesFor(recordIds, sessionId = null) {
  let attemptsQuery = client.from('quiz_attempts').select('id');
  if (sessionId && recordIds.length) {
    attemptsQuery = attemptsQuery.or(
      `training_session_id.eq.${sessionId},attendance_record_id.in.(${recordIds.join(',')})`
    );
  } else if (sessionId) {
    attemptsQuery = attemptsQuery.eq('training_session_id', sessionId);
  } else {
    attemptsQuery = attemptsQuery.in('attendance_record_id', recordIds);
  }
  const attempts = await must(attemptsQuery);
  const attemptIds = attempts.map((row) => row.id);
  const answers = attemptIds.length
    ? await must(client.from('quiz_attempt_answers').select('id').in('quiz_attempt_id', attemptIds))
    : [];
  const templates = sessionId
    ? await must(client.from('quiz_templates').select('id').eq('training_session_id', sessionId))
    : [];
  return {
    quizAttempts: attempts.length,
    quizAttemptAnswers: answers.length,
    sessionQuizTemplates: templates.length,
  };
}

async function storagePlan(records, session = null) {
  const excludedRecordIds = records.map((row) => row.id);
  const excludedSessionIds = session ? [session.id] : [];
  const candidates = records.flatMap((row) => [
    { bucket: 'signatures', path: row.signature_path },
    { bucket: 'attendance-photos', path: row.photo_path },
  ]).filter((item) => item.path);
  if (session?.trainer_signature_path) {
    candidates.push({ bucket: 'signatures', path: session.trainer_signature_path });
  }
  const unique = Array.from(new Map(candidates.map((item) => [`${item.bucket}:${item.path}`, item])).values());
  return Promise.all(unique.map(async (item) => ({
    ...item,
    exists: await objectExists(item.bucket, item.path),
    sharedProtected: await pathIsShared(
      item.bucket,
      item.path,
      excludedRecordIds,
      excludedSessionIds
    ),
  })));
}

const expiredRows = await must(
  client
    .from('attendance_records')
    .select('id, training_session_id, signature_path, photo_path, archived_at, archive_delete_after, archive_source')
    .not('archived_at', 'is', null)
    .lte('archive_delete_after', now)
);
const students = expiredRows.filter((row) => row.archive_source === 'deleted_student');
const legacyClassRows = expiredRows.filter((row) => row.archive_source === 'archived_class');
const classSessionIds = [...new Set(legacyClassRows.map((row) => row.training_session_id).filter(Boolean))];
const items = [];

for (const student of students) {
  const dependencies = await dependenciesFor([student.id]);
  const storage = await storagePlan([student]);
  items.push({
    archiveType: 'student',
    targetId: student.id,
    deleteAfter: student.archive_delete_after,
    database: { attendanceRecords: 1, trainingSessions: 0, ...dependencies },
    storageRemove: storage.filter((item) => item.exists && !item.sharedProtected),
    storageMissing: storage.filter((item) => !item.exists),
    storageSharedProtected: storage.filter((item) => item.sharedProtected),
  });
}

for (const sessionId of classSessionIds) {
  const sessionRows = legacyClassRows.filter((row) => row.training_session_id === sessionId);
  const sessions = await must(
    client.from('training_sessions').select('id, trainer_signature_path').eq('id', sessionId).limit(1)
  );
  const dependencies = await dependenciesFor(sessionRows.map((row) => row.id), sessionId);
  const storage = await storagePlan(sessionRows, sessions[0] || { id: sessionId });
  items.push({
    archiveType: 'class',
    targetId: sessionId,
    deleteAfter: sessionRows.map((row) => row.archive_delete_after).sort().at(-1),
    database: {
      attendanceRecords: sessionRows.length,
      trainingSessions: sessions.length,
      ...dependencies,
    },
    storageRemove: storage.filter((item) => item.exists && !item.sharedProtected),
    storageMissing: storage.filter((item) => !item.exists),
    storageSharedProtected: storage.filter((item) => item.sharedProtected),
  });
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  mode: 'dry-run',
  purgeEnabled: false,
  studentsEligible: students.map((row) => row.id),
  classesEligible: classSessionIds,
  attendanceRecordsAffected: items.reduce((sum, item) => sum + item.database.attendanceRecords, 0),
  items,
}, null, 2));
