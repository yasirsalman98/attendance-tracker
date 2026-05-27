import { createClient } from '@supabase/supabase-js';

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

export async function handler(event) {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!accessToken) {
    return jsonResponse(401, { error: 'Login required.' });
  }

  const authClient = getSupabaseClient(anonKey);
  const adminClient = getSupabaseClient(serviceRoleKey || anonKey);

  if (!authClient || !adminClient) {
    return jsonResponse(500, { error: 'Supabase environment variables are missing.' });
  }

  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);

  if (userError || !userData?.user) {
    return jsonResponse(401, { error: 'Login required.' });
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

  const records = await Promise.all(
    (data || []).map(async (record) => {
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

  return jsonResponse(200, { records });
}
