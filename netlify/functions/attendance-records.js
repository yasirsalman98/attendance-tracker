import { createClient } from '@supabase/supabase-js';

const SETTINGS_ADMIN_EMAIL = 'excourse7233@gmail.com';
const ATTENDANCE_ARCHIVE_RETENTION_DAYS = 30;
const ATTENDANCE_ARCHIVE_SOURCE = 'deleted_student';
const ATTENDANCE_CLASS_ARCHIVE_SOURCE = 'archived_class';
const ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE =
  'Attendance archive requires database migration before it can be used.';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isSettingsAdminUser(user) {
  return normalizeEmail(user?.email) === SETTINGS_ADMIN_EMAIL;
}

function isMissingArchiveColumn(error) {
  const message = String(error?.message || '').toLowerCase();

  return (
    (error?.code === '42703' || message.includes('column')) &&
    (message.includes('archived_at') ||
      message.includes('archived_by') ||
      message.includes('archive_delete_after') ||
      message.includes('archive_source'))
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
    console.error(`Signed URL error for ${bucketName}/${filePath}:`, error);
    return '';
  }

  return data?.signedUrl || '';
}

async function removeStorageFiles(client, bucketName, paths) {
  // DATA SAFETY: removes signature/photo storage objects. Keep scoped to an
  // approved user action and prefer soft-delete/archive behavior for new work.
  const cleanPaths = [...new Set((paths || []).filter(Boolean))];

  if (cleanPaths.length === 0) return;

  const { error } = await client.storage.from(bucketName).remove(cleanPaths);

  if (error) {
    console.error(`Storage delete error for ${bucketName}:`, error);
  }
}

export async function handler(event) {
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

    if (!['restore', 'archive_class', 'restore_class'].includes(action)) {
      return jsonResponse(400, { error: 'Invalid attendance record action.' });
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

      const { data: archivedRows, error: archiveClassError } = await adminClient
        .from('attendance_records')
        .update(buildArchivePayload(userData.user, ATTENDANCE_CLASS_ARCHIVE_SOURCE))
        .eq('training_session_id', sessionId)
        .is('archived_at', null)
        .select('id');

      if (isMissingArchiveColumn(archiveClassError)) {
        return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
      }

      if (archiveClassError) {
        console.error('Attendance class archive error:', archiveClassError);
        return jsonResponse(500, {
          error: archiveClassError.message || 'Unable to archive class.',
        });
      }

      if (!Array.isArray(archivedRows) || archivedRows.length === 0) {
        return jsonResponse(409, { error: 'No active students to archive.' });
      }

      return jsonResponse(200, {
        success: true,
        archivedCount: archivedRows.length,
        archivedIds: archivedRows.map((row) => row.id),
      });
    }

    if (action === 'restore_class') {
      if (!sessionId) {
        return jsonResponse(400, { error: 'Training session id is required.' });
      }

      const { data: restoredRows, error: restoreClassError } = await adminClient
        .from('attendance_records')
        .update({
          archived_at: null,
          archived_by: null,
          archive_delete_after: null,
          archive_source: null,
        })
        .eq('training_session_id', sessionId)
        .not('archived_at', 'is', null)
        .select('id');

      if (isMissingArchiveColumn(restoreClassError)) {
        return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
      }

      if (restoreClassError) {
        console.error('Attendance class restore error:', restoreClassError);
        return jsonResponse(500, {
          error: restoreClassError.message || 'Unable to restore class.',
        });
      }

      if (!Array.isArray(restoredRows) || restoredRows.length === 0) {
        return jsonResponse(409, { error: 'No archived students to restore.' });
      }

      return jsonResponse(200, {
        success: true,
        restoredCount: restoredRows.length,
        restoredIds: restoredRows.map((row) => row.id),
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

    const { data: restoredRows, error: restoreError } = await adminClient
      .from('attendance_records')
      .update({
        archived_at: null,
        archived_by: null,
        archive_delete_after: null,
        archive_source: null,
      })
      .eq('id', record.id)
      .not('archived_at', 'is', null)
      .select('id');

    if (isMissingArchiveColumn(restoreError)) {
      return jsonResponse(409, { error: ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE });
    }

    if (restoreError) {
      console.error('Attendance record restore error:', restoreError);
      return jsonResponse(500, {
        error: restoreError.message || 'Unable to restore record.',
      });
    }

    if (!Array.isArray(restoredRows) || restoredRows.length === 0) {
      return jsonResponse(404, {
        error: 'No archived attendance record was restored. Refresh and try again.',
      });
    }

    return jsonResponse(200, {
      success: true,
      restoredIds: restoredRows.map((row) => row.id),
    });
  }

  const selectRecords = (archiveMode) => {
    let query = adminClient
      .from('attendance_records')
      .select(`
        *,
        training_sessions (*)
      `)
      .order('signed_at', { ascending: false });

    if (archiveMode === 'active') {
      query = query.is('archived_at', null);
    } else if (archiveMode === 'archived') {
      query = query.not('archived_at', 'is', null);
    }

    return query;
  };

  let archiveColumnsAvailable = true;
  let { data, error } = await selectRecords('active');

  if (isMissingArchiveColumn(error)) {
    archiveColumnsAvailable = false;
    const fallbackResponse = await selectRecords('all');
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (error) {
    console.error('Attendance records load error:', error);
    return jsonResponse(500, { error: error.message || 'Unable to load records.' });
  }

  let archivedData = [];

  if (archiveColumnsAvailable) {
    const archivedResponse = await selectRecords('archived');

    if (archivedResponse.error) {
      console.error('Archived attendance records load error:', archivedResponse.error);
      return jsonResponse(500, {
        error: archivedResponse.error.message || 'Unable to load archived records.',
      });
    }

    archivedData = archivedResponse.data || [];
  }

  const ownerRecords = (data || []).filter((record) =>
    isSettingsAdmin ||
    recordMatchesAttendanceAccess(
        record,
        userData.user,
        sharedAttendanceOwnerIds
      )
  );
  const ownerArchivedRecords = isSettingsAdmin ? archivedData || [] : [];
  const visibleSessionIdsWithRecords = new Set(
    ownerRecords
      .map((record) => record.training_session_id)
      .filter(Boolean)
  );

  const { data: sessionData, error: sessionError } = await adminClient
    .from('training_sessions')
    .select('*')
    .order('training_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (sessionError) {
    console.error('Attendance sessions load error:', sessionError);
    return jsonResponse(500, { error: sessionError.message || 'Unable to load classes.' });
  }

  const ownerSessions = (sessionData || []).filter((session) =>
    (isSettingsAdmin ||
      sessionMatchesAttendanceAccess(
        session,
        userData.user,
        sharedAttendanceOwnerIds
      )) &&
    visibleSessionIdsWithRecords.has(session.id)
  );

  const sessions = await Promise.all(
    ownerSessions.map(async (session) => ({
      ...session,
      trainer_signature_url:
        session.trainer_signature_url ||
        (await addSignedUrl(
          adminClient,
          'signatures',
          session.trainer_signature_path
        )),
    }))
  );

  const records = await Promise.all(
    ownerRecords.map(async (record) => {
      const session = record.training_sessions;
      const trainerSignatureUrl =
        session?.trainer_signature_url ||
        (await addSignedUrl(
          adminClient,
          'signatures',
          session?.trainer_signature_path
        ));

      return {
        ...record,
        signature_url:
          record.signature_url ||
          (await addSignedUrl(adminClient, 'signatures', record.signature_path)),
        photo_url: await addSignedUrl(
          adminClient,
          'attendance-photos',
          record.photo_path
        ),
        training_sessions: session
          ? {
              ...session,
              trainer_signature_url: trainerSignatureUrl,
            }
          : session,
      };
    })
  );
  const archivedRecords = await Promise.all(
    ownerArchivedRecords.map(async (record) => {
      const session = record.training_sessions;
      const trainerSignatureUrl =
        session?.trainer_signature_url ||
        (await addSignedUrl(
          adminClient,
          'signatures',
          session?.trainer_signature_path
        ));

      return {
        ...record,
        signature_url:
          record.signature_url ||
          (await addSignedUrl(adminClient, 'signatures', record.signature_path)),
        photo_url: await addSignedUrl(
          adminClient,
          'attendance-photos',
          record.photo_path
        ),
        training_sessions: session
          ? {
              ...session,
              trainer_signature_url: trainerSignatureUrl,
            }
          : session,
      };
    })
  );

  return jsonResponse(200, {
    records,
    archivedRecords,
    sessions,
    totalRecordCount: (data || []).length,
    ownedRecordCount: ownerRecords.length,
    ownedArchivedRecordCount: ownerArchivedRecords.length,
    totalSessionCount: (sessionData || []).length,
    ownedSessionCount: ownerSessions.length,
    canManageAttendanceRecords: canManageAssignedAttendanceRecords,
    archiveColumnsAvailable,
    attendanceRecordsCompany,
    email: userData.user.email || '',
  });
}
