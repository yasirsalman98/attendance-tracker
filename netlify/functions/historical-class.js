import { createClient } from '@supabase/supabase-js';
import { Buffer } from 'node:buffer';
import {
  buildHistoricalClassDraft,
  validateHistoricalClassInfo,
} from '../../src/historicalClassModel.js';

const SETTINGS_ADMIN_EMAIL = 'excourse7233@gmail.com';
const SOURCE_PAGE_SIZE = 10;
const READ_RESPONSE_VERSION = 'historical-class-read-v1';
const WRITE_RESPONSE_VERSION = 'historical-class-v1';
const SOURCE_SESSION_FIELDS = `
  id,
  course_name,
  training_date,
  trainer_name,
  company_name,
  training_location,
  time_started,
  time_stopped,
  course_outline,
  owner_user_id,
  created_at,
  expires_at,
  attendance_archived_at
`;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function getClient(key, accessToken = '') {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: accessToken
      ? { headers: { Authorization: `Bearer ${accessToken}` } }
      : undefined,
  });
}

async function defaultAuthenticate(accessToken) {
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const authClient = getClient(anonKey, accessToken);
  if (!authClient) return null;
  const result = await authClient.auth.getUser(accessToken);
  return result.error ? null : result.data?.user || null;
}

function defaultGetAdminClient() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_SECRET ||
    process.env.service_role_secret;
  return getClient(key);
}

function isolatedWritesEnabled(environment = process.env) {
  return environment.HISTORICAL_CLASS_WRITES_ENABLED === 'true';
}

function decodeTrainerSignature(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw new Error('A valid trainer signature is required.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length === 0 || bytes.length > 2_000_000) {
    throw new Error('Trainer signature must be smaller than 2 MB.');
  }
  return bytes;
}

function isMissingColumn(error, columnName) {
  const message = String(error?.message || '').toLowerCase();
  return (error?.code === '42703' || message.includes('column')) &&
    message.includes(String(columnName).toLowerCase());
}

function cleanSearch(value) {
  return String(value || '')
    .trim()
    .slice(0, 100)
    .replace(/[,()*%]/g, ' ')
    .replace(/\s+/g, ' ');
}

async function readSourceClasses(adminClient, query) {
  const page = Math.max(1, Number.parseInt(query?.page, 10) || 1);
  const search = cleanSearch(query?.search);
  const from = (page - 1) * SOURCE_PAGE_SIZE;
  const to = from + SOURCE_PAGE_SIZE - 1;
  const buildQuery = (includeArchiveFilter) => {
    let request = adminClient
      .from('training_sessions')
      .select(`${SOURCE_SESSION_FIELDS}, attendance_records(count)`, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (includeArchiveFilter) {
      request = request
        .is('attendance_archived_at', null)
        .is('attendance_records.archived_at', null);
    }
    if (search) {
      const filters = [
        `course_name.ilike.%${search}%`,
        `trainer_name.ilike.%${search}%`,
        `company_name.ilike.%${search}%`,
        `training_location.ilike.%${search}%`,
      ];
      if (/^\d{4}-\d{2}-\d{2}$/.test(search)) filters.push(`training_date.eq.${search}`);
      request = request.or(filters.join(','));
    }
    return request;
  };
  let response = await buildQuery(true);
  if (isMissingColumn(response.error, 'attendance_archived_at')) response = await buildQuery(false);
  if (response.error) return jsonResponse(500, { error: 'Unable to load source classes.' });
  const sessions = (response.data || []).map(({ attendance_records: countRows, ...session }) => ({
    ...session,
    student_count: Number(countRows?.[0]?.count) || 0,
  }));
  const total = Number(response.count) || 0;
  return jsonResponse(200, {
    sessions,
    total,
    page,
    pageSize: SOURCE_PAGE_SIZE,
    hasMore: from + sessions.length < total,
    responseVersion: READ_RESPONSE_VERSION,
  });
}

async function readSourceStudents(adminClient, query) {
  const sessionId = String(query?.sessionId || '').trim();
  if (!sessionId) return jsonResponse(400, { error: 'Source session is required.' });
  const selectStudents = () => {
    return adminClient
      .from('attendance_records')
      .select('id, student_name, student_email, company, signature_path, photo_path, signed_at')
      .eq('training_session_id', sessionId)
      .is('archived_at', null)
      .order('student_name', { ascending: true });
  };
  const response = await selectStudents();
  if (response.error) return jsonResponse(500, { error: 'Unable to load source students.' });
  return jsonResponse(200, {
    students: (response.data || []).map((student) => ({
      id: student.id,
      student_name: student.student_name || '',
      student_email: student.student_email || '',
      company: student.company || '',
      signature_path: student.signature_path || null,
      photo_path: student.photo_path || null,
      signed_at: student.signed_at || null,
    })),
    responseVersion: READ_RESPONSE_VERSION,
  });
}

function validateRequestBody(body) {
  const classInfo = body?.classInfo || {};
  const errors = validateHistoricalClassInfo(classInfo);
  const sourceSessionId = String(body?.sourceSessionId || '').trim();
  const selectedIds = Array.isArray(body?.selectedSourceAttendanceIds)
    ? body.selectedSourceAttendanceIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const idempotencyKey = String(body?.idempotencyKey || '').trim();
  if (!sourceSessionId) errors.push('Source session is required.');
  if (selectedIds.length === 0) errors.push('At least one source student is required.');
  if (new Set(selectedIds).size !== selectedIds.length) {
    errors.push('Duplicate source student IDs are not allowed.');
  }
  if (!/^[a-zA-Z0-9_-]{12,120}$/.test(idempotencyKey)) {
    errors.push('A valid idempotency key is required.');
  }
  return { errors, classInfo, sourceSessionId, selectedIds, idempotencyKey };
}

export function createHistoricalClassHandler({
  authenticate = defaultAuthenticate,
  getAdminClient = defaultGetAdminClient,
  environment = process.env,
} = {}) {
  return async function handler(event) {
    if (!['GET', 'POST'].includes(event.httpMethod)) {
      return jsonResponse(405, { error: 'Method not allowed.' });
    }
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!accessToken) return jsonResponse(401, { error: 'Login required.' });

    const user = await authenticate(accessToken);
    if (!user) return jsonResponse(401, { error: 'Login required.' });
    if (normalizeEmail(user.email) !== SETTINGS_ADMIN_EMAIL) {
      return jsonResponse(403, { error: 'Historical-class administrator access required.' });
    }

    if (event.httpMethod === 'GET') {
      const adminClient = getAdminClient();
      if (!adminClient) return jsonResponse(500, { error: 'Database configuration is missing.' });
      const query = event.queryStringParameters || {};
      if (query.view === 'sources') return readSourceClasses(adminClient, query);
      if (query.view === 'students') return readSourceStudents(adminClient, query);
      return jsonResponse(400, { error: 'Invalid historical-class read view.' });
    }

    if (!isolatedWritesEnabled(environment)) {
      return jsonResponse(503, {
        error: 'Historical class creation is not enabled for this deployment.',
      });
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return jsonResponse(400, { error: 'Invalid request body.' });
    }
    const validation = validateRequestBody(body);
    let trainerSignatureBytes;
    try {
      trainerSignatureBytes = decodeTrainerSignature(validation.classInfo.trainerSignatureDataUrl);
    } catch (error) {
      validation.errors.push(error.message);
    }
    if (validation.errors.length) {
      return jsonResponse(400, { error: validation.errors.join(' ') });
    }

    const adminClient = getAdminClient();
    if (!adminClient) return jsonResponse(500, { error: 'Database configuration is missing.' });
    const existingRequest = await adminClient
      .from('historical_class_audit')
      .select('historical_session_id, created_at')
      .eq('idempotency_key', validation.idempotencyKey)
      .maybeSingle();
    if (existingRequest.error) {
      return jsonResponse(500, { error: 'Historical class database migration is not available.' });
    }
    if (existingRequest.data) {
      return jsonResponse(200, {
        historicalClassId: existingRequest.data.historical_session_id,
        createdAt: existingRequest.data.created_at,
        repeated: true,
        responseVersion: WRITE_RESPONSE_VERSION,
      });
    }
    const sourceSession = await adminClient
      .from('training_sessions')
      .select('id, course_name, training_date, attendance_archived_at')
      .eq('id', validation.sourceSessionId)
      .maybeSingle();
    if (sourceSession.error) return jsonResponse(500, { error: 'Unable to validate source class.' });
    if (!sourceSession.data) return jsonResponse(404, { error: 'Source class was not found.' });
    if (sourceSession.data.attendance_archived_at) {
      return jsonResponse(409, { error: 'Archived classes cannot be used as a source.' });
    }

    const sourceStudents = await adminClient
      .from('attendance_records')
      .select('id, student_name, student_email, company, signature_path, photo_path, signed_at')
      .eq('training_session_id', validation.sourceSessionId)
      .is('archived_at', null)
      .in('id', validation.selectedIds);
    if (sourceStudents.error) return jsonResponse(500, { error: 'Unable to validate source students.' });
    if (sourceStudents.data?.length !== validation.selectedIds.length) {
      return jsonResponse(409, { error: 'One or more selected students do not belong to the source class.' });
    }

    const draft = buildHistoricalClassDraft({
      classInfo: validation.classInfo,
      sourceSession: sourceSession.data,
      selectedStudents: sourceStudents.data,
      createdBy: { id: user.id, email: user.email },
      idempotencyKey: validation.idempotencyKey,
    });
    const trainerSignaturePath = `${user.id}/trainer-signatures/historical-${Date.now()}-${globalThis.crypto.randomUUID()}.png`;
    const uploadResult = await adminClient.storage
      .from('signatures')
      .upload(trainerSignaturePath, trainerSignatureBytes, {
        contentType: 'image/png',
        upsert: false,
      });
    if (uploadResult.error) {
      return jsonResponse(500, { error: 'Unable to save trainer signature.' });
    }
    draft.class.trainer_signature_path = trainerSignaturePath;
    delete draft.class.trainer_signature_url;
    const rpc = await adminClient.rpc('create_historical_class', {
      p_source_session_id: validation.sourceSessionId,
      p_class: draft.class,
      p_selected_attendance_ids: validation.selectedIds,
      p_reason: draft.class.historical_entry_reason,
      p_created_by: user.id,
      p_idempotency_key: validation.idempotencyKey,
    });
    if (rpc.error) {
      await adminClient.storage.from('signatures').remove([trainerSignaturePath]);
      const repeatedRequest = await adminClient
        .from('historical_class_audit')
        .select('historical_session_id, created_at')
        .eq('idempotency_key', validation.idempotencyKey)
        .maybeSingle();
      if (!repeatedRequest.error && repeatedRequest.data) {
        return jsonResponse(200, {
          historicalClassId: repeatedRequest.data.historical_session_id,
          createdAt: repeatedRequest.data.created_at,
          repeated: true,
          responseVersion: WRITE_RESPONSE_VERSION,
        });
      }
      console.error('Historical class transaction failed:', rpc.error.code || 'rpc_failed');
      return jsonResponse(500, { error: 'Historical class transaction failed.' });
    }
    const createdSession = await adminClient
      .from('training_sessions')
      .select('created_at')
      .eq('id', rpc.data)
      .maybeSingle();
    return jsonResponse(201, {
      historicalClassId: rpc.data,
      createdAt: createdSession.data?.created_at || new Date().toISOString(),
      createdAtUsesDatabaseDefault: true,
      responseVersion: WRITE_RESPONSE_VERSION,
    });
  };
}

export const handler = createHistoricalClassHandler();
