import { createClient } from '@supabase/supabase-js';

const allClassViewerEmails = new Set([
  'excourse7233@gmail.com',
]);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
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

  const canViewAllClasses = allClassViewerEmails.has(
    normalizeEmail(userData.user.email)
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

    if (recordError) {
      console.error('Attendance record delete lookup error:', recordError);
      return jsonResponse(500, { error: recordError.message || 'Unable to delete record.' });
    }

    if (!record) {
      return jsonResponse(404, { error: 'Attendance record was not found.' });
    }

    const session = record.training_sessions;

    if (!canViewAllClasses && session?.owner_user_id !== userData.user.id) {
      return jsonResponse(403, { error: 'You do not have access to delete this record.' });
    }

    await removeStorageFiles(adminClient, 'signatures', [record.signature_path]);
    await removeStorageFiles(adminClient, 'attendance-photos', [record.photo_path]);

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

    let deletedSession = false;

    if (record.training_session_id) {
      const { count, error: countError } = await adminClient
        .from('attendance_records')
        .select('id', { count: 'exact', head: true })
        .eq('training_session_id', record.training_session_id);

      if (countError) {
        console.error('Attendance record count error:', countError);
      } else if (count === 0) {
        await removeStorageFiles(adminClient, 'signatures', [
          session?.trainer_signature_path,
        ]);

        let deleteSessionQuery = adminClient
          .from('training_sessions')
          .delete()
          .eq('id', record.training_session_id);

        if (!canViewAllClasses) {
          deleteSessionQuery = deleteSessionQuery.eq('owner_user_id', userData.user.id);
        }

        const { error: deleteSessionError } = await deleteSessionQuery;

        if (deleteSessionError) {
          console.error('Empty training session delete error:', deleteSessionError);
          return jsonResponse(500, {
            error: deleteSessionError.message || 'Unable to delete empty class.',
          });
        }

        deletedSession = true;
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

  const ownerRecords = canViewAllClasses
    ? data || []
    : (data || []).filter(
        (record) => record.training_sessions?.owner_user_id === userData.user.id
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
    totalRecordCount: (data || []).length,
    ownedRecordCount: ownerRecords.length,
    email: userData.user.email || '',
  });
}
