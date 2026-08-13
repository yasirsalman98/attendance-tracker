import { createClient } from '@supabase/supabase-js';

const SETTINGS_ADMIN_EMAIL = 'excourse7233@gmail.com';
const ATTENDANCE_ARCHIVE_RETENTION_DAYS = 30;
const ATTENDANCE_ARCHIVE_SOURCE = 'deleted_student';
const ATTENDANCE_CLASS_ARCHIVE_SOURCE = 'archived_class';
const ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE =
  'Attendance archive requires database migration before it can be used.';
const RECORDS_PAGE_SIZE = 10;
const RESPONSE_VERSION = 'attendance-archive-v3';
const SESSION_SUMMARY_FIELDS = `
  id,
  course_name,
  training_date,
  trainer_name,
  company_name,
  training_location,
  time_started,
  time_stopped,
  course_outline,
  trainer_signature_path,
  owner_user_id,
  created_at,
  expires_at
`;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isSettingsAdminUser(user) {
  return normalizeEmail(user?.email) === SETTINGS_ADMIN_EMAIL;
}

function isMissingArchiveColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    error?.code === 'PGRST202' ||
    message.includes('archive_attendance_class') ||
    message.includes('restore_attendance_class') ||
    message.includes('restore_attendance_student') ||
    message.includes('get_attendance_student_archives') ||
    message.includes('get_attendance_class_archives') ||
    (error?.code === '42703' || message.includes('column')) &&
    (message.includes('archived_at') ||
      message.includes('archived_by') ||
      message.includes('archive_delete_after') ||
      message.includes('archive_source') ||
      message.includes('archive_type') ||
      message.includes('attendance_archive'))
  );
}

function isMissingQuizSessionLinkColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    message.includes('schema cache') &&
    (message.includes('training_session_id') ||
      message.includes('attendance_record_id') ||
      message.includes('completed_at'))
  );
}

function buildArchivePayload(user, archiveSource = ATTENDANCE_ARCHIVE_SOURCE) {
  const archivedAt = new Date();
  const archiveDeleteAfter = new Date(archivedAt);
  archiveDeleteAfter.setDate(
    archiveDeleteAfter.getDate() + ATTENDANCE_ARCHIVE_RETENTION_DAYS
  );

  return {
    archived_at: archivedAt.toISOString(),
    archived_by: user.id,
    archive_delete_after: archiveDeleteAfter.toISOString(),
    archive_source: archiveSource,
    archive_type:
      archiveSource === ATTENDANCE_CLASS_ARCHIVE_SOURCE ? 'class' : 'student',
  };
}

function buildCloseSessionPayload() {
  const closedAt = new Date().toISOString();

  return {
    archived_at: closedAt,
    expires_at: closedAt,
  };
}

function normalizeCompany(value) {
  return String(value || '').trim().toLowerCase();
}

function getAttendanceRecordsCompany(user) {
  const metadata = user?.user_metadata || {};

  if (!metadata.imported_assets?.attendanceRecords) {
    return '';
  }

  return String(metadata.template_designs?.attendanceRecordsCompany || '').trim();
}

function getOwnerAttendanceRecordsCompany(user) {
  return String(
    user?.user_metadata?.template_designs?.attendanceRecordsCompany || ''
  ).trim();
}

async function getSharedAttendanceOwnerIds(adminClient, normalizedCompany) {
  if (!normalizedCompany) return new Set();

  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return new Set(
    (data?.users || [])
      .filter(
        (authUser) =>
          normalizeCompany(getOwnerAttendanceRecordsCompany(authUser)) ===
          normalizedCompany
      )
      .map((authUser) => authUser.id)
  );
}

function sessionMatchesAttendanceAccess(session, user, sharedOwnerIds) {
  if (!session?.owner_user_id || !user?.id) return false;

  return (
    session.owner_user_id === user.id || sharedOwnerIds.has(session.owner_user_id)
  );
}

function recordMatchesAttendanceAccess(record, user, sharedOwnerIds) {
  return sessionMatchesAttendanceAccess(
    record?.training_sessions,
    user,
    sharedOwnerIds
  );
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function logDiagnostic(requestId, stage, details = {}) {
  console.log(
    'Attendance records diagnostic:',
    JSON.stringify({ requestId, stage, ...details })
  );
}

function getSupabaseClient(key, accessToken = '') {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

  if (!supabaseUrl || !key) {
    return null;
  }

  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
  });
}

async function addSignedUrl(client, bucketName, filePath) {
  if (!filePath) return '';

  const { data, error } = await client.storage
    .from(bucketName)
    .createSignedUrl(filePath, 300);

  if (error) {
    console.error('Attendance storage signed URL error:', {
      bucket: bucketName,
      code: error.code || null,
      message: error.message || 'Storage request failed.',
    });
    return '';
  }

  return data?.signedUrl || '';
}

export async function handler(event) {
  const requestId =
    event.headers?.['x-nf-request-id'] ||
    event.headers?.['X-Nf-Request-Id'] ||
    globalThis.crypto?.randomUUID?.() ||
    `attendance-${Date.now()}`;

  if (!['GET', 'DELETE', 'PATCH'].includes(event.httpMethod)) {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_SECRET ||
    process.env.service_role_secret;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!accessToken) {
    return jsonResponse(401, { error: 'Login required.' });
  }

  const authClient = getSupabaseClient(anonKey);
  const adminClient = getSupabaseClient(
    serviceRoleKey || anonKey,
    serviceRoleKey ? '' : accessToken
  );

  if (!authClient || !adminClient) {
    return jsonResponse(500, { error: 'Supabase environment variables are missing.' });
  }

  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);

  if (userError || !userData?.user) {
    return jsonResponse(401, { error: 'Login required.' });
  }

  const isSettingsAdmin = isSettingsAdminUser(userData.user);
  const attendanceRecordsCompany = getAttendanceRecordsCompany(userData.user);
  const normalizedAttendanceRecordsCompany = normalizeCompany(attendanceRecordsCompany);
  const sharedAttendanceOwnerIds = serviceRoleKey
    ? await getSharedAttendanceOwnerIds(
        adminClient,
        normalizedAttendanceRecordsCompany
      )
    : new Set();
  const canManageAssignedAttendanceRecords = Boolean(
    normalizedAttendanceRecordsCompany
  );

  if (event.httpMethod === 'DELETE') {
    const body = JSON.parse(event.body || '{}');
    const recordId = String(body.recordId || '').trim();

    if (!recordId) {
      return jsonResponse(400, { error: 'Attendance record id is required.' });
    }

    const { data: record, error: recordError } = await adminClient
      .from('attendance_records')
      .select('*, training_sessions (*)')
      .eq('id', recordId)
      .maybeSingle();

    if (isMissingArchiveColumn(recordError)) {
      return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
    }

    if (recordError) {
      console.error('Attendance record archive lookup error:', recordError);
      return jsonResponse(500, { error: recordError.message || 'Unable to archive record.' });
    }

    if (!record) {
      return jsonResponse(404, { error: 'Attendance record was not found.' });
    }

    const canManageThisRecord = recordMatchesAttendanceAccess(
      record,
      userData.user,
      sharedAttendanceOwnerIds
    );

    if (!isSettingsAdmin && !canManageThisRecord) {
      return jsonResponse(403, { error: 'You do not have access to archive this record.' });
    }

    const { data: archivedRows, error: archiveRecordError } = await adminClient
      .from('attendance_records')
      .update(buildArchivePayload(userData.user))
      .eq('id', record.id)
      .is('archived_at', null)
      .select('id');

    if (isMissingArchiveColumn(archiveRecordError)) {
      return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
    }

    if (archiveRecordError) {
      console.error('Attendance record archive error:', archiveRecordError);
      return jsonResponse(500, {
        error: archiveRecordError.message || 'Unable to archive record.',
      });
    }

    if (!Array.isArray(archivedRows) || archivedRows.length === 0) {
      return jsonResponse(404, {
        error: 'No attendance record was archived. Refresh and try again.',
      });
    }

    return jsonResponse(200, {
      success: true,
      archivedIds: archivedRows.map((row) => row.id),
    });
  }

  if (event.httpMethod === 'PATCH') {
    const body = JSON.parse(event.body || '{}');
    const recordId = String(body.recordId || '').trim();
    const sessionId = String(body.sessionId || '').trim();
    const action = String(body.action || '').trim();

    if (!['restore', 'archive_class', 'restore_class', 'close_session'].includes(action)) {
      return jsonResponse(400, { error: 'Invalid attendance record action.' });
    }

    if (action === 'close_session') {
      if (!sessionId) {
        return jsonResponse(400, { error: 'Training session id is required.' });
      }

      const { data: session, error: sessionError } = await adminClient
        .from('training_sessions')
        .select('*')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionError) {
        console.error('Training session close lookup error:', sessionError);
        return jsonResponse(500, {
          error: sessionError.message || 'Unable to find training session.',
        });
      }

      if (!session) {
        return jsonResponse(404, { error: 'Training session was not found.' });
      }

      const canManageThisSession = sessionMatchesAttendanceAccess(
        session,
        userData.user,
        sharedAttendanceOwnerIds
      );

      if (!isSettingsAdmin && !canManageThisSession) {
        return jsonResponse(403, {
          error: 'You do not have access to delete this training session.',
        });
      }

      let closeResult = await adminClient
        .from('training_sessions')
        .update(buildCloseSessionPayload())
        .eq('id', sessionId)
        .select('id');

      if (isMissingArchiveColumn(closeResult.error)) {
        const closedAt = new Date().toISOString();
        closeResult = await adminClient
          .from('training_sessions')
          .update({ expires_at: closedAt })
          .eq('id', sessionId)
          .select('id');
      }

      if (closeResult.error) {
        console.error('Training session close error:', closeResult.error);
        return jsonResponse(500, {
          error: closeResult.error.message || 'Unable to delete training session.',
        });
      }

      if (!Array.isArray(closeResult.data) || closeResult.data.length === 0) {
        return jsonResponse(404, {
          error: 'No session was deleted. Refresh the page and try again.',
        });
      }

      return jsonResponse(200, { success: true, closedSessionId: sessionId });
    }

    if (!isSettingsAdmin) {
      return jsonResponse(403, {
        error: 'Only the admin account can manage archived attendance records.',
      });
    }

    if (action === 'archive_class') {
      if (!sessionId) {
        return jsonResponse(400, { error: 'Training session id is required.' });
      }

      const sessionResponse = await adminClient
        .from('training_sessions')
        .select('id, owner_user_id')
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionResponse.error) {
        return jsonResponse(500, { error: 'Unable to find training session.' });
      }

      if (!sessionResponse.data) {
        return jsonResponse(404, { error: 'Training session was not found.' });
      }

      const { data: archiveResult, error: archiveClassError } = await adminClient
        .rpc('archive_attendance_class', {
          p_session_id: sessionId,
          p_archived_by: userData.user.id,
        });

      if (isMissingArchiveColumn(archiveClassError)) {
        return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
      }

      if (archiveClassError) {
        console.error('Attendance class archive error:', archiveClassError);
        return jsonResponse(500, {
          error: archiveClassError.message || 'Unable to archive class.',
        });
      }

      const result = archiveResult?.[0] || {};

      return jsonResponse(200, {
        success: true,
        archivedCount: Number(result.archived_count) || 0,
        archivedAt: result.archived_at || null,
        deleteAfter: result.delete_after || null,
      });
    }

    if (action === 'restore_class') {
      if (!sessionId) {
        return jsonResponse(400, { error: 'Training session id is required.' });
      }

      const { data: restoredCount, error: restoreClassError } = await adminClient
        .rpc('restore_attendance_class', { p_session_id: sessionId });

      if (isMissingArchiveColumn(restoreClassError)) {
        return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
      }

      if (restoreClassError) {
        console.error('Attendance class restore error:', restoreClassError);
        return jsonResponse(500, {
          error: restoreClassError.message || 'Unable to restore class.',
        });
      }

      if (!Number.isFinite(Number(restoredCount)) || Number(restoredCount) < 0) {
        return jsonResponse(409, { error: 'No archived class was restored.' });
      }

      return jsonResponse(200, {
        success: true,
        restoredCount: Number(restoredCount),
      });
    }

    if (!recordId) {
      return jsonResponse(400, { error: 'Attendance record id is required.' });
    }

    const { data: record, error: recordError } = await adminClient
      .from('attendance_records')
      .select('*, training_sessions (*)')
      .eq('id', recordId)
      .maybeSingle();

    if (isMissingArchiveColumn(recordError)) {
      return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
    }

    if (recordError) {
      console.error('Attendance record restore lookup error:', recordError);
      return jsonResponse(500, { error: recordError.message || 'Unable to restore record.' });
    }

    if (!record) {
      return jsonResponse(404, { error: 'Attendance record was not found.' });
    }

    const canManageThisRecord = recordMatchesAttendanceAccess(
      record,
      userData.user,
      sharedAttendanceOwnerIds
    );

    if (!isSettingsAdmin && !canManageThisRecord) {
      return jsonResponse(403, { error: 'You do not have access to restore this record.' });
    }

    const { data: restored, error: restoreError } = await adminClient
      .rpc('restore_attendance_student', { p_record_id: record.id });

    if (isMissingArchiveColumn(restoreError)) {
      return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
    }

    if (restoreError) {
      console.error('Attendance record restore error:', restoreError);
      return jsonResponse(500, {
        error: restoreError.message || 'Unable to restore record.',
      });
    }

    if (restored !== true) {
      return jsonResponse(404, {
        error: 'No student archive was restored. Refresh and try again.',
      });
    }

    return jsonResponse(200, {
      success: true,
      restoredIds: [record.id],
    });
  }

  const query = event.queryStringParameters || {};
  const view = String(query.view || 'summaries').trim().toLowerCase();
  const archiveMode = String(query.archived || '').toLowerCase() === 'true';

  if (view === 'trainer-signature') {
    const sessionId = String(query.sessionId || '').trim();

    if (!sessionId) {
      return jsonResponse(400, { error: 'Training session id is required.' });
    }

    const sessionResponse = await adminClient
      .from('training_sessions')
      .select('id, owner_user_id, trainer_signature_path')
      .eq('id', sessionId)
      .maybeSingle();

    if (sessionResponse.error) {
      console.error('Trainer signature session lookup error:', sessionResponse.error);
      logDiagnostic(requestId, 'trainer_signature_session_lookup_failed');
      return jsonResponse(500, { error: 'Unable to load trainer signature.' });
    }

    const session = sessionResponse.data;

    if (!session) {
      return jsonResponse(404, { error: 'Training session was not found.' });
    }

    if (
      !isSettingsAdmin &&
      !sessionMatchesAttendanceAccess(session, userData.user, sharedAttendanceOwnerIds)
    ) {
      return jsonResponse(403, { error: 'You do not have access to this class.' });
    }

    if (!session.trainer_signature_path) {
      logDiagnostic(requestId, 'trainer_signature_complete', {
        durationMs: 0,
        signedUrlCount: 0,
      });
      return jsonResponse(200, {
        signatureUrl: '',
        responseVersion: RESPONSE_VERSION,
      });
    }

    const storageStartedAt = Date.now();
    let signatureUrl;

    try {
      signatureUrl = await addSignedUrl(
        adminClient,
        'signatures',
        session.trainer_signature_path
      );
    } catch (error) {
      console.error('Trainer signature storage request failed:', error);
      logDiagnostic(requestId, 'trainer_signature_storage_failed', {
        durationMs: Date.now() - storageStartedAt,
      });
      return jsonResponse(502, { error: 'Trainer signature is unavailable.' });
    }

    logDiagnostic(requestId, 'trainer_signature_complete', {
      durationMs: Date.now() - storageStartedAt,
      signedUrlCount: signatureUrl ? 1 : 0,
      failedCount: signatureUrl ? 0 : 1,
    });

    if (!signatureUrl) {
      return jsonResponse(502, { error: 'Trainer signature is unavailable.' });
    }

    return jsonResponse(200, {
      signatureUrl,
      responseVersion: RESPONSE_VERSION,
    });
  }

  if (view === 'students') {
    const sessionId = String(query.sessionId || '').trim();
    const requestedArchiveType = String(query.archiveType || '').trim();

    if (!sessionId) {
      return jsonResponse(400, { error: 'Training session id is required.' });
    }

    let session = null;

    if (sessionId !== 'unassigned') {
      const sessionResponse = await adminClient
        .from('training_sessions')
        .select(SESSION_SUMMARY_FIELDS)
        .eq('id', sessionId)
        .maybeSingle();

      if (sessionResponse.error) {
        console.error('Attendance student session lookup error:', sessionResponse.error);
        return jsonResponse(500, {
          error: sessionResponse.error.message || 'Unable to load students.',
        });
      }

      session = sessionResponse.data;

      if (!session) {
        return jsonResponse(404, { error: 'Training session was not found.' });
      }

      if (
        !isSettingsAdmin &&
        !sessionMatchesAttendanceAccess(session, userData.user, sharedAttendanceOwnerIds)
      ) {
        return jsonResponse(403, { error: 'You do not have access to this class.' });
      }
    } else if (!isSettingsAdmin) {
      return jsonResponse(403, { error: 'You do not have access to these records.' });
    }

    const studentQueryStartedAt = Date.now();
    let recordsQuery = adminClient
      .from('attendance_records')
      .select('*')
      .order('signed_at', { ascending: false });

    recordsQuery = sessionId === 'unassigned'
      ? recordsQuery.is('training_session_id', null)
      : recordsQuery.eq('training_session_id', sessionId);
    recordsQuery = archiveMode
      ? recordsQuery.not('archived_at', 'is', null)
      : recordsQuery.is('archived_at', null);
    if (archiveMode && requestedArchiveType === 'class') {
      recordsQuery = recordsQuery.eq('archive_type', 'class');
    }

    let recordsResponse = await recordsQuery;

    if (isMissingArchiveColumn(recordsResponse.error) && !archiveMode) {
      let fallbackRecordsQuery = adminClient
        .from('attendance_records')
        .select('*')
        .order('signed_at', { ascending: false });
      fallbackRecordsQuery = sessionId === 'unassigned'
        ? fallbackRecordsQuery.is('training_session_id', null)
        : fallbackRecordsQuery.eq('training_session_id', sessionId);
      recordsResponse = await fallbackRecordsQuery;
    }

    if (recordsResponse.error) {
      console.error('Attendance students load error:', recordsResponse.error);
      logDiagnostic(requestId, 'student_query_failed', {
        durationMs: Date.now() - studentQueryStartedAt,
      });
      return jsonResponse(500, {
        error: 'Unable to load students.',
      });
    }

    logDiagnostic(requestId, 'student_query_complete', {
      durationMs: Date.now() - studentQueryStartedAt,
      studentCount: recordsResponse.data?.length || 0,
      archived: archiveMode,
    });

    let quizAttempts = [];

    if (!archiveMode && sessionId !== 'unassigned') {
      const selectAttempts = (includeArchiveField) => adminClient
        .from('quiz_attempts')
        .select(`
          id, student_name, student_email, training_session_id,
          attendance_record_id, completed_at, submitted_at,
          quiz_templates (${includeArchiveField ? 'id, archived_at' : 'id'})
        `)
        .eq('training_session_id', sessionId);
      let attemptsResponse = await selectAttempts(true);

      if (isMissingArchiveColumn(attemptsResponse.error)) {
        attemptsResponse = await selectAttempts(false);
      }

      if (!isMissingQuizSessionLinkColumn(attemptsResponse.error)) {
        if (attemptsResponse.error) {
          console.error('Linked quiz attempts load error:', attemptsResponse.error);
          logDiagnostic(requestId, 'student_quiz_query_failed', {
            code: attemptsResponse.error.code || null,
          });
        } else {
          quizAttempts = (attemptsResponse.data || []).filter(
            (attempt) => !attempt.quiz_templates?.archived_at
          );
        }
      }
    }

    const storageStartedAt = Date.now();
    let storageRequestCount = 0;
    let storageSuccessCount = 0;
    const signAsset = async (bucketName, path) => {
      if (!path) return '';
      storageRequestCount += 1;
      const signedUrl = await addSignedUrl(adminClient, bucketName, path);
      if (signedUrl) storageSuccessCount += 1;
      return signedUrl;
    };
    let records;

    try {
      records = await Promise.all((recordsResponse.data || []).map(async (record) => ({
        ...record,
        signature_url:
          record.signature_url ||
          (await signAsset('signatures', record.signature_path)),
        photo_url:
          record.photo_url ||
          (await signAsset('attendance-photos', record.photo_path)),
        training_sessions: session,
      })));
    } catch (error) {
      console.error('Student storage signed URL stage failed:', error);
      logDiagnostic(requestId, 'student_storage_failed', {
        durationMs: Date.now() - storageStartedAt,
        signedUrlRequestCount: storageRequestCount,
      });
      return jsonResponse(502, { error: 'Unable to load student media.' });
    }

    logDiagnostic(requestId, 'student_storage_complete', {
      durationMs: Date.now() - storageStartedAt,
      signedUrlRequestCount: storageRequestCount,
      signedUrlSuccessCount: storageSuccessCount,
    });

    return jsonResponse(200, {
      records,
      quizAttempts,
      responseVersion: RESPONSE_VERSION,
    });
  }

  const requestedPage = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requestedArchivePage = Math.max(
    1,
    Number.parseInt(query.archivePage, 10) || 1
  );
  const scope = ['active', 'archived'].includes(query.scope) ? query.scope : 'all';
  const accessibleOwnerIds = [
    ...new Set([userData.user.id, ...sharedAttendanceOwnerIds]),
  ];

  const selectSessionSummaries = async (mode, page) => {
    const from = (page - 1) * RECORDS_PAGE_SIZE;
    const rpcStartedAt = Date.now();
    const rpcResponse = await adminClient.rpc(
      'get_attendance_session_summaries',
      {
        p_owner_ids: isSettingsAdmin ? null : accessibleOwnerIds,
        p_archived: mode === 'archived',
        p_offset: from,
        p_limit: RECORDS_PAGE_SIZE,
      }
    );
    let rawSessions;
    let totalCount;
    const source = 'rpc';

    if (!rpcResponse.error) {
      rawSessions = (rpcResponse.data || []).map((row) => ({
        ...row.summary,
        student_count: row.student_count || 0,
      }));
      totalCount = rpcResponse.data?.[0]?.total_count || 0;
    } else {
      logDiagnostic(requestId, 'summary_rpc_failed', {
        durationMs: Date.now() - rpcStartedAt,
        mode,
        code: rpcResponse.error.code || null,
      });
      return rpcResponse;
    }

    if (mode === 'archived') {
      const sessionsMissingArchiveDate = rawSessions.filter(
        (session) => session?.id && !session.archived_at
      );

      if (sessionsMissingArchiveDate.length > 0) {
        const archiveDateStartedAt = Date.now();
        const archiveDates = await Promise.all(
          sessionsMissingArchiveDate.map(async (session) => {
            const response = await adminClient
              .from('attendance_records')
              .select('archived_at')
              .eq('training_session_id', session.id)
              .not('archived_at', 'is', null)
              .order('archived_at', { ascending: false })
              .limit(1)
              .maybeSingle();

            if (response.error) {
              console.error('Attendance archive date lookup error:', response.error);
              return [session.id, null];
            }

            return [session.id, response.data?.archived_at || null];
          })
        );
        const archiveDatesBySessionId = new Map(archiveDates);

        rawSessions = rawSessions.map((session) => ({
          ...session,
          archived_at:
            session.archived_at || archiveDatesBySessionId.get(session.id) || null,
        }));

        logDiagnostic(requestId, 'archive_date_lookup_complete', {
          durationMs: Date.now() - archiveDateStartedAt,
          classCount: sessionsMissingArchiveDate.length,
        });
      }
    }

    const sessions = rawSessions.map((session) => {
      const {
        attendance_records: ignoredCountRelation,
        trainer_signature_url: ignoredTrainerSignatureUrl,
        ...classFields
      } = session;
      void ignoredCountRelation;
      void ignoredTrainerSignatureUrl;

      return classFields;
    });

    logDiagnostic(requestId, 'summary_query_complete', {
      durationMs: Date.now() - rpcStartedAt,
      mode,
      source,
      returnedCount: sessions.length,
      totalCount,
      signedUrlRequestCount: 0,
    });

    return {
      data: sessions,
      count: totalCount,
      error: null,
      hasMore: from + sessions.length < totalCount,
      source,
    };
  };

  const selectArchiveSummaries = async (archiveType, page) => {
    const from = (page - 1) * RECORDS_PAGE_SIZE;
    const functionName = archiveType === 'student'
      ? 'get_attendance_student_archives'
      : 'get_attendance_class_archives';
    const response = await adminClient.rpc(functionName, {
      p_owner_ids: isSettingsAdmin ? null : accessibleOwnerIds,
      p_offset: from,
      p_limit: RECORDS_PAGE_SIZE,
    });

    if (response.error) return response;

    const data = (response.data || []).map((row) => ({
      ...row.summary,
      ...(archiveType === 'class'
        ? { student_count: Number(row.student_count) || 0 }
        : {}),
    }));
    const count = Number(response.data?.[0]?.total_count) || 0;

    return {
      data,
      count,
      hasMore: from + data.length < count,
      error: null,
      source: 'rpc',
    };
  };

  let archiveColumnsAvailable = true;
  const emptySummaryResponse = { data: [], count: 0, hasMore: false, error: null };
  const [activeResponse, studentArchiveResponse, classArchiveResponse] = await Promise.all([
    scope !== 'archived'
      ? selectSessionSummaries('active', requestedPage)
      : Promise.resolve(emptySummaryResponse),
    scope !== 'active' && isSettingsAdmin && archiveColumnsAvailable
      ? selectArchiveSummaries('student', requestedArchivePage)
      : Promise.resolve(emptySummaryResponse),
    scope !== 'active' && isSettingsAdmin && archiveColumnsAvailable
      ? selectArchiveSummaries('class', requestedArchivePage)
      : Promise.resolve(emptySummaryResponse),
  ]);

  if (activeResponse.error) {
    console.error('Attendance class summaries load error:', activeResponse.error);
    return jsonResponse(500, {
      error: 'Unable to load attendance records.',
    });
  }

  const archiveError = studentArchiveResponse.error || classArchiveResponse.error;
  if (archiveError) {
    if (isMissingArchiveColumn(archiveError)) {
      archiveColumnsAvailable = false;
      studentArchiveResponse.data = [];
      studentArchiveResponse.count = 0;
      studentArchiveResponse.hasMore = false;
      classArchiveResponse.data = [];
      classArchiveResponse.count = 0;
      classArchiveResponse.hasMore = false;
    } else {
      console.error('Attendance archive summaries load error:', archiveError);
      return jsonResponse(500, { error: 'Unable to load archived records.' });
    }
  }

  return jsonResponse(200, {
    records: [],
    archivedRecords: [],
    sessions: activeResponse.data || [],
    archivedSessions: classArchiveResponse.data || [],
    studentArchives: studentArchiveResponse.data || [],
    classArchives: classArchiveResponse.data || [],
    page: requestedPage,
    archivePage: requestedArchivePage,
    pageSize: RECORDS_PAGE_SIZE,
    hasMoreRecords: Boolean(activeResponse.hasMore),
    hasMoreArchivedRecords: Boolean(
      studentArchiveResponse.hasMore || classArchiveResponse.hasMore
    ),
    hasMoreStudentArchives: Boolean(studentArchiveResponse.hasMore),
    hasMoreClassArchives: Boolean(classArchiveResponse.hasMore),
    totalClassCount: activeResponse.count || 0,
    totalArchivedStudentCount: studentArchiveResponse.count || 0,
    totalArchivedClassCount: classArchiveResponse.count || 0,
    canManageAttendanceRecords: canManageAssignedAttendanceRecords,
    archiveColumnsAvailable,
    attendanceRecordsCompany,
    email: userData.user.email || '',
    responseVersion: RESPONSE_VERSION,
    summarySource: {
      active: activeResponse.source || null,
      archivedStudents: studentArchiveResponse.source || null,
      archivedClasses: classArchiveResponse.source || null,
    },
  });
}
