import { createClient } from '@supabase/supabase-js';
import {
  isClassArchive,
  isStudentArchive,
  privacySafeErrorCode,
  purgeControls,
} from './attendance-archive-cleanup-core.js';

const STUDENT_FIELDS =
  'id, training_session_id, signature_path, photo_path, archived_at, archive_delete_after, archive_source, archive_type';
const CLASS_FIELDS =
  'id, trainer_signature_path, attendance_archive_type, attendance_archived_at, attendance_archive_delete_after';

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function clientFromEnvironment() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_SECRET ||
    process.env.service_role_secret;

  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function isScheduledInvocation(event) {
  const headers = event.headers || {};
  const hasScheduledPayload = (() => {
    try {
      const payload = JSON.parse(event.body || '{}');
      return Boolean(
        payload.next_run && Number.isFinite(new Date(payload.next_run).getTime())
      );
    } catch {
      return false;
    }
  })();
  return (
    event.type === 'schedule' ||
    headers['x-netlify-event'] === 'schedule' ||
    headers['x-nf-event'] === 'schedule' ||
    hasScheduledPayload
  );
}

function isAuthorizedManualInvocation(event) {
  const expected = process.env.ARCHIVE_CLEANUP_SECRET;
  const provided = String(
    event.headers?.authorization || event.headers?.Authorization || ''
  ).replace(/^Bearer\s+/i, '');
  return Boolean(expected && provided && provided === expected);
}

async function countRows(query) {
  const result = await query;
  if (result.error) throw result.error;
  return result.count || 0;
}

async function findDependencies(client, type, target) {
  if (type === 'student') {
    const attempts = await client
      .from('quiz_attempts')
      .select('id')
      .eq('attendance_record_id', target.id);
    if (attempts.error) throw attempts.error;
    const attemptIds = (attempts.data || []).map((row) => row.id);
    const answerCount = attemptIds.length
      ? await countRows(
          client
            .from('quiz_attempt_answers')
            .select('id', { count: 'exact', head: true })
            .in('quiz_attempt_id', attemptIds)
        )
      : 0;

    return {
      attendanceRecords: 1,
      trainingSessions: 0,
      quizAttempts: attemptIds.length,
      quizAttemptAnswers: answerCount,
      sessionQuizTemplates: 0,
    };
  }

  const attendance = await client
    .from('attendance_records')
    .select('id, signature_path, photo_path')
    .eq('training_session_id', target.id);
  if (attendance.error) throw attendance.error;
  const attendanceIds = (attendance.data || []).map((row) => row.id);
  let attemptsQuery = client.from('quiz_attempts').select('id');
  attemptsQuery = attendanceIds.length
    ? attemptsQuery.or(
        `training_session_id.eq.${target.id},attendance_record_id.in.(${attendanceIds.join(',')})`
      )
    : attemptsQuery.eq('training_session_id', target.id);
  const attempts = await attemptsQuery;
  if (attempts.error) throw attempts.error;
  const templates = await client
    .from('quiz_templates')
    .select('id')
    .eq('training_session_id', target.id);
  if (templates.error) throw templates.error;
  const attemptIds = (attempts.data || []).map((row) => row.id);
  const answerCount = attemptIds.length
    ? await countRows(
        client
          .from('quiz_attempt_answers')
          .select('id', { count: 'exact', head: true })
          .in('quiz_attempt_id', attemptIds)
      )
    : 0;

  return {
    attendanceRecords: attendance.data?.length || 0,
    trainingSessions: 1,
    quizAttempts: attemptIds.length,
    quizAttemptAnswers: answerCount,
    sessionQuizTemplates: templates.data?.length || 0,
    attendance: attendance.data || [],
  };
}

async function isStoragePathShared(
  client,
  bucket,
  path,
  excludedIds = [],
  excludedSessionIds = []
) {
  if (!path) return false;
  const table = bucket === 'attendance-photos' ? 'attendance_records' : null;
  const column = bucket === 'attendance-photos' ? 'photo_path' : 'signature_path';
  if (table) {
    let query = client.from(table).select('id').eq(column, path);
    if (excludedIds.length) query = query.not('id', 'in', `(${excludedIds.join(',')})`);
    const result = await query.limit(1);
    if (result.error) throw result.error;
    return Boolean(result.data?.length);
  }

  let recordQuery = client.from('attendance_records').select('id').eq('signature_path', path);
  if (excludedIds.length) {
    recordQuery = recordQuery.not('id', 'in', `(${excludedIds.join(',')})`);
  }
  let sessionQuery = client
    .from('training_sessions')
    .select('id')
    .eq('trainer_signature_path', path);
  if (excludedSessionIds.length) {
    sessionQuery = sessionQuery.not('id', 'in', `(${excludedSessionIds.join(',')})`);
  }
  const [records, sessions] = await Promise.all([
    recordQuery.limit(1),
    sessionQuery.limit(1),
  ]);
  if (records.error) throw records.error;
  if (sessions.error) throw sessions.error;
  return Boolean(records.data?.length || sessions.data?.length);
}

async function buildStoragePlan(client, type, target, dependencies) {
  const attendance = type === 'student' ? [target] : dependencies.attendance || [];
  const excludedIds = attendance.map((row) => row.id);
  const candidates = attendance.flatMap((row) => [
    { bucket: 'signatures', path: row.signature_path },
    { bucket: 'attendance-photos', path: row.photo_path },
  ]).filter((item) => item.path);

  if (type === 'class' && target.trainer_signature_path) {
    candidates.push({ bucket: 'signatures', path: target.trainer_signature_path });
  }

  const unique = Array.from(
    new Map(candidates.map((item) => [`${item.bucket}:${item.path}`, item])).values()
  );
  return Promise.all(unique.map(async (item) => ({
    ...item,
    sharedProtected: await isStoragePathShared(
      client,
      item.bucket,
      item.path,
      excludedIds,
      type === 'class' ? [target.id] : []
    ),
  })));
}

async function insertAudit(client, values) {
  const result = await client.from('attendance_archive_cleanup_audit').insert(values);
  if (result.error) console.error('Attendance archive audit write failed:', result.error.code);
}

async function discover(client, now) {
  const [studentResult, classResult] = await Promise.all([
    client
      .from('attendance_records')
      .select(STUDENT_FIELDS)
      .not('archived_at', 'is', null)
      .lte('archive_delete_after', now.toISOString()),
    client
      .from('training_sessions')
      .select(CLASS_FIELDS)
      .eq('attendance_archive_type', 'class')
      .not('attendance_archived_at', 'is', null)
      .lte('attendance_archive_delete_after', now.toISOString()),
  ]);
  if (studentResult.error) throw studentResult.error;
  if (classResult.error) throw classResult.error;
  return {
    students: (studentResult.data || []).filter((row) => isStudentArchive(row, now)),
    classes: (classResult.data || []).filter((row) => isClassArchive(row, now)),
  };
}

async function dryRun(client, eligible, runId) {
  const items = [];
  for (const [type, targets] of [['student', eligible.students], ['class', eligible.classes]]) {
    for (const target of targets) {
      try {
        const dependencies = await findDependencies(client, type, target);
        const storage = await buildStoragePlan(client, type, target, dependencies);
        const counts = {
          ...dependencies,
          attendance: undefined,
        };
        items.push({
          archiveType: type,
          targetId: target.id,
          deleteAfter:
            type === 'student'
              ? target.archive_delete_after
              : target.attendance_archive_delete_after,
          database: counts,
          storage: {
            remove: storage.filter((item) => !item.sharedProtected),
            sharedProtected: storage.filter((item) => item.sharedProtected),
          },
        });
        await insertAudit(client, {
          run_id: runId,
          archive_type: type,
          target_id: target.id,
          outcome: 'dry_run',
          database_counts: counts,
          storage_counts: {
            remove: storage.filter((item) => !item.sharedProtected).length,
            sharedProtected: storage.filter((item) => item.sharedProtected).length,
          },
        });
      } catch (error) {
        items.push({ archiveType: type, targetId: target.id, errorCode: privacySafeErrorCode(error) });
      }
    }
  }
  return items;
}

async function removeDatabaseScope(client, type, target, dependencies) {
  if (type === 'student') {
    const recheck = await client.from('attendance_records').select(STUDENT_FIELDS).eq('id', target.id).maybeSingle();
    if (recheck.error) throw recheck.error;
    if (!isStudentArchive(recheck.data)) return false;
    const attempts = await client.from('quiz_attempts').delete().eq('attendance_record_id', target.id);
    if (attempts.error) throw attempts.error;
    const record = await client.from('attendance_records').delete().eq('id', target.id).eq('archive_type', 'student');
    if (record.error) throw record.error;
    return true;
  }

  const recheck = await client.from('training_sessions').select(CLASS_FIELDS).eq('id', target.id).maybeSingle();
  if (recheck.error) throw recheck.error;
  if (!isClassArchive(recheck.data)) return false;
  const attendanceIds = (dependencies.attendance || []).map((row) => row.id);
  if (attendanceIds.length) {
    const linkedAttempts = await client
      .from('quiz_attempts')
      .delete()
      .in('attendance_record_id', attendanceIds);
    if (linkedAttempts.error) throw linkedAttempts.error;
  }
  const sessionAttempts = await client
    .from('quiz_attempts')
    .delete()
    .eq('training_session_id', target.id);
  if (sessionAttempts.error) throw sessionAttempts.error;
  for (const [table, column] of [
    ['quiz_templates', 'training_session_id'],
    ['attendance_records', 'training_session_id'],
  ]) {
    const result = await client.from(table).delete().eq(column, target.id);
    if (result.error) throw result.error;
  }
  const session = await client.from('training_sessions').delete().eq('id', target.id).eq('attendance_archive_type', 'class');
  if (session.error) throw session.error;
  void dependencies;
  return true;
}

async function removeStoragePlan(client, plan) {
  let removed = 0;
  let sharedProtected = 0;
  for (const item of plan) {
    if (item.sharedProtected) {
      sharedProtected += 1;
      continue;
    }
    const stillShared = await isStoragePathShared(client, item.bucket, item.path);
    if (stillShared) {
      sharedProtected += 1;
      continue;
    }
    const result = await client.storage.from(item.bucket).remove([item.path]);
    if (result.error && !/not found/i.test(result.error.message || '')) throw result.error;
    removed += 1;
  }
  return { removed, sharedProtected };
}

async function purge(client, eligible, runId) {
  const results = [];
  const staleBefore = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const staleReset = await client
    .from('attendance_archive_cleanup_queue')
    .update({ status: 'retry', locked_at: null, updated_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('locked_at', staleBefore);
  if (staleReset.error) throw staleReset.error;
  const retryQueue = await client
    .from('attendance_archive_cleanup_queue')
    .select('*')
    .in('status', ['retry', 'partial_failed'])
    .order('updated_at', { ascending: true });
  if (retryQueue.error) throw retryQueue.error;

  // If database removal succeeded but Storage failed, the archived database
  // target no longer exists. Resume the captured Storage plan independently.
  for (const item of retryQueue.data || []) {
    const table = item.archive_type === 'student' ? 'attendance_records' : 'training_sessions';
    const target = await client.from(table).select('id').eq('id', item.target_id).maybeSingle();
    if (target.error || target.data || !Array.isArray(item.storage_plan)) continue;
    const claimed = await client.from('attendance_archive_cleanup_queue').update({
      status: 'processing', run_id: runId, locked_at: new Date().toISOString(),
      attempts: (item.attempts || 0) + 1, updated_at: new Date().toISOString(),
    }).eq('id', item.id).in('status', ['retry', 'partial_failed']).select('*').maybeSingle();
    if (!claimed.data) continue;
    try {
      const storageCounts = await removeStoragePlan(client, item.storage_plan);
      await client.from('attendance_archive_cleanup_queue').update({ status: 'completed', locked_at: null, last_error_code: null }).eq('id', item.id);
      await insertAudit(client, { run_id: runId, queue_id: item.id, archive_type: item.archive_type, target_id: item.target_id, outcome: 'retried', storage_counts: storageCounts });
      results.push({ archiveType: item.archive_type, targetId: item.target_id, outcome: 'retried' });
    } catch (error) {
      const errorCode = privacySafeErrorCode(error);
      await client.from('attendance_archive_cleanup_queue').update({ status: 'partial_failed', locked_at: null, last_error_code: errorCode }).eq('id', item.id);
      results.push({ archiveType: item.archive_type, targetId: item.target_id, outcome: 'partial_failed', errorCode });
    }
  }

  for (const [type, targets] of [['student', eligible.students], ['class', eligible.classes]]) {
    for (const target of targets) {
      const deleteAfter = type === 'student'
        ? target.archive_delete_after
        : target.attendance_archive_delete_after;
      let queued = await client
        .from('attendance_archive_cleanup_queue')
        .select('*')
        .eq('archive_type', type)
        .eq('target_id', target.id)
        .maybeSingle();
      if (!queued.error && !queued.data) {
        queued = await client.from('attendance_archive_cleanup_queue').insert({
          archive_type: type,
          target_id: target.id,
          delete_after: deleteAfter,
        }).select('*').single();
      }
      if (queued.error) {
        results.push({ archiveType: type, targetId: target.id, outcome: 'partial_failed', errorCode: privacySafeErrorCode(queued.error) });
        continue;
      }
      const claimed = await client.from('attendance_archive_cleanup_queue').update({
        status: 'processing', run_id: runId, locked_at: new Date().toISOString(),
        attempts: (queued.data.attempts || 0) + 1, updated_at: new Date().toISOString(),
      }).eq('id', queued.data.id).in('status', ['pending', 'retry', 'partial_failed']).select('*').maybeSingle();
      if (claimed.error || !claimed.data) {
        results.push({ archiveType: type, targetId: target.id, outcome: 'skipped' });
        continue;
      }
      try {
        const dependencies = await findDependencies(client, type, target);
        const plan = await buildStoragePlan(client, type, target, dependencies);
        await client.from('attendance_archive_cleanup_queue').update({ storage_plan: plan }).eq('id', claimed.data.id);
        const removedScope = await removeDatabaseScope(client, type, target, dependencies);
        if (!removedScope) {
          await client.from('attendance_archive_cleanup_queue').update({ status: 'skipped', locked_at: null }).eq('id', claimed.data.id);
          results.push({ archiveType: type, targetId: target.id, outcome: 'skipped' });
          continue;
        }
        const storageCounts = await removeStoragePlan(client, plan);
        await client.from('attendance_archive_cleanup_queue').update({ status: 'completed', locked_at: null, last_error_code: null }).eq('id', claimed.data.id);
        await insertAudit(client, { run_id: runId, queue_id: claimed.data.id, archive_type: type, target_id: target.id, outcome: 'success', database_counts: dependencies, storage_counts: storageCounts });
        results.push({ archiveType: type, targetId: target.id, outcome: 'success' });
      } catch (error) {
        const errorCode = privacySafeErrorCode(error);
        await client.from('attendance_archive_cleanup_queue').update({ status: 'partial_failed', locked_at: null, last_error_code: errorCode }).eq('id', claimed.data.id);
        await insertAudit(client, { run_id: runId, queue_id: claimed.data.id, archive_type: type, target_id: target.id, outcome: 'partial_failed', error_code: errorCode });
        results.push({ archiveType: type, targetId: target.id, outcome: 'partial_failed', errorCode });
      }
    }
  }
  return results;
}

export async function handler(event) {
  const scheduled = isScheduledInvocation(event);
  if (!scheduled && event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }
  if (!scheduled && !isAuthorizedManualInvocation(event)) {
    return response(401, { error: 'Unauthorized.' });
  }
  const client = clientFromEnvironment();
  if (!client) return response(500, { error: 'Cleanup configuration is incomplete.' });

  const runId = globalThis.crypto?.randomUUID?.() || `cleanup-${Date.now()}`;
  const controls = purgeControls();
  try {
    const eligible = await discover(client, new Date());
    const items = controls.enabled
      ? await purge(client, eligible, runId)
      : await dryRun(client, eligible, runId);
    return response(200, {
      runId,
      mode: controls.enabled ? 'purge' : 'dry-run',
      purgeRequested: controls.requested,
      backupVerified: controls.backupVerified,
      studentCount: eligible.students.length,
      classCount: eligible.classes.length,
      items,
    });
  } catch (error) {
    console.error('Attendance archive cleanup failed:', privacySafeErrorCode(error));
    return response(500, { error: 'Attendance archive cleanup failed.', errorCode: privacySafeErrorCode(error) });
  }
}
