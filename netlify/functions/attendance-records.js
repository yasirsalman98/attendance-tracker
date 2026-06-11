import { createClient } from '@supabase/supabase-js';

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
  if (!['GET', 'DELETE'].includes(event.httpMethod)) {
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
    // DATA SAFETY: hard-deletes an attendance record, its signature/photo files,
    // and the parent training session when it becomes empty.
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

    if (recordError) {
      console.error('Attendance record delete lookup error:', recordError);
      return jsonResponse(500, { error: recordError.message || 'Unable to delete record.' });
    }

    if (!record) {
      return jsonResponse(404, { error: 'Attendance record was not found.' });
    }

    const session = record.training_sessions;
    const canManageThisRecord = recordMatchesAttendanceAccess(
      record,
      userData.user,
      sharedAttendanceOwnerIds
    );

    if (!canManageThisRecord) {
      return jsonResponse(403, { error: 'You do not have access to delete this record.' });
    }

    const { data: sessionRecordsBeforeDelete, error: sessionRecordsError } =
      record.training_session_id
        ? await adminClient
            .from('attendance_records')
            .select('id, signature_path, photo_path')
            .eq('training_session_id', record.training_session_id)
        : { data: [], error: null };

    if (sessionRecordsError) {
      console.error('Attendance session records lookup error:', sessionRecordsError);
      return jsonResponse(500, {
        error: sessionRecordsError.message || 'Unable to delete record.',
      });
    }

    const { error: deleteRecordError } = await adminClient
      .from('attendance_records')
      .delete()
      .eq('id', record.id);

    if (deleteRecordError) {
      console.error('Attendance record delete error:', deleteRecordError);
      return jsonResponse(500, {
        error: deleteRecordError.message || 'Unable to delete record.',
      });
    }

    await removeStorageFiles(adminClient, 'signatures', [record.signature_path]);
    await removeStorageFiles(adminClient, 'attendance-photos', [record.photo_path]);

    let deletedSession = false;

    if (record.training_session_id) {
      const { count, error: countError } = await adminClient
        .from('attendance_records')
        .select('id', { count: 'exact', head: true })
        .eq('training_session_id', record.training_session_id);

      if (countError) {
        console.error('Attendance record count error:', countError);
      } else if (count === 0) {
        const deletedSessionRecords = sessionRecordsBeforeDelete || [];

        await removeStorageFiles(
          adminClient,
          'signatures',
          [
            session?.trainer_signature_path,
            ...deletedSessionRecords.map((nextRecord) => nextRecord.signature_path),
          ]
        );
        await removeStorageFiles(
          adminClient,
          'attendance-photos',
          deletedSessionRecords.map((nextRecord) => nextRecord.photo_path)
        );

        const deleteSessionQuery = adminClient
          // DATA SAFETY: training session hard delete. Convert this path to
          // soft-delete/archive before expanding deletion behavior.
          .from('training_sessions')
          .delete()
          .eq('id', record.training_session_id)
          .eq('owner_user_id', session?.owner_user_id || '');

        const { data: deletedSessions, error: deleteSessionError } =
          await deleteSessionQuery.select('id');

        if (deleteSessionError) {
          console.error('Empty training session delete error:', deleteSessionError);
          return jsonResponse(500, {
            error: deleteSessionError.message || 'Unable to delete empty class.',
          });
        }

        deletedSession = (deletedSessions || []).length > 0;
      }
    }

    return jsonResponse(200, { success: true, deletedSession });
  }

  const { data, error } = await adminClient
    .from('attendance_records')
    .select(`
      *,
      training_sessions (*)
    `)
    .order('signed_at', { ascending: false });

  if (error) {
    console.error('Attendance records load error:', error);
    return jsonResponse(500, { error: error.message || 'Unable to load records.' });
  }

  const ownerRecords = (data || []).filter((record) =>
    recordMatchesAttendanceAccess(
      record,
      userData.user,
      sharedAttendanceOwnerIds
    )
  );
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
    sessionMatchesAttendanceAccess(
      session,
      userData.user,
      sharedAttendanceOwnerIds
    ) && visibleSessionIdsWithRecords.has(session.id)
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

  return jsonResponse(200, {
    records,
    sessions,
    totalRecordCount: (data || []).length,
    ownedRecordCount: ownerRecords.length,
    totalSessionCount: (sessionData || []).length,
    ownedSessionCount: ownerSessions.length,
    canManageAttendanceRecords: canManageAssignedAttendanceRecords,
    attendanceRecordsCompany,
    email: userData.user.email || '',
  });
}
