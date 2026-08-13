import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';
import { supabase } from '../supabaseClient';
import {
  fetchWithTimeout,
  getStudentGroupKey,
  loadStudentsWithCache,
  replaceSessionRecords,
} from './adminRecordsLazy';

const SHAREPOINT_ARCHIVE_EMAILS = new Set([
  'excourse7233@gmail.com',
  'exceedsafety@gmail.com',
]);
const SETTINGS_ADMIN_EMAIL = 'excourse7233@gmail.com';
const ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE =
  'Attendance archive requires database migration before it can be used.';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeComparableText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isValidStudentEmail(value) {
  const email = normalizeEmail(value);

  return (
    email &&
    email.includes('@') &&
    email !== 'none@none.com' &&
    !email.endsWith('@excourse.local') &&
    !email.startsWith('unprovided-')
  );
}

function isSettingsAdminUser(user) {
  return normalizeEmail(user?.email) === SETTINGS_ADMIN_EMAIL;
}

function getAssetAccessFromUser(user) {
  const importedAssets = user?.user_metadata?.imported_assets;

  if (!importedAssets) {
    return {
      certificateTemplate: true,
      walletCards: true,
    };
  }

  return {
    certificateTemplate: Boolean(importedAssets.certificateTemplate),
    walletCards: Boolean(importedAssets.walletCards),
  };
}

function getAttendanceRecordsCompanyFromUser(user) {
  const metadata = user?.user_metadata || {};

  if (!metadata.imported_assets?.attendanceRecords) {
    return '';
  }

  return String(metadata.template_designs?.attendanceRecordsCompany || '').trim();
}

function canManageAttendanceRecordsFromUser(user) {
  return Boolean(getAttendanceRecordsCompanyFromUser(user));
}

function formatDateTime(value) {
  if (!value) return 'N/A';

  return new Date(value).toLocaleString();
}

function formatTime(value) {
  if (!value) return 'N/A';

  return new Date(value).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatAccuracy(value) {
  return value ? `${Math.round(value)} meters` : 'N/A';
}

function getSessionValue(session, key) {
  return session?.[key] || 'N/A';
}

function isArchiveDeadlineOverdue(value) {
  return Boolean(value && new Date(value).getTime() <= Date.now());
}

function getStudentCount(session, records = []) {
  const count = Number(session?.student_count);
  return Number.isFinite(count) ? count : records.length;
}

function getQuizCompletionMap(records, quizAttempts) {
  const attemptsByAttendanceRecordId = new Set();
  const attemptsBySessionAndEmail = new Set();
  const attemptsBySessionAndName = new Set();

  (quizAttempts || []).forEach((attempt) => {
    const sessionId = attempt.training_session_id;

    if (attempt.attendance_record_id) {
      attemptsByAttendanceRecordId.add(attempt.attendance_record_id);
    }

    if (!sessionId) return;

    const email = normalizeEmail(attempt.student_email);
    const name = normalizeComparableText(attempt.student_name);

    if (isValidStudentEmail(email)) {
      attemptsBySessionAndEmail.add(`${sessionId}::${email}`);
    }

    if (name) {
      attemptsBySessionAndName.add(`${sessionId}::${name}`);
    }
  });

  return new Map(
    records.map((record) => {
      const sessionId = record.training_session_id;
      const email = normalizeEmail(record.student_email);
      const name = normalizeComparableText(record.student_name);

      // Quiz completion is connected to attendance by the selected session ID.
      // Match attendance_record_id first, then same-session valid email, then
      // same-session name. Never match student names across sessions/classes.
      const completed =
        attemptsByAttendanceRecordId.has(record.id) ||
        (sessionId &&
          isValidStudentEmail(email) &&
          attemptsBySessionAndEmail.has(`${sessionId}::${email}`)) ||
        (sessionId && name && attemptsBySessionAndName.has(`${sessionId}::${name}`));

      return [record.id, completed];
    })
  );
}

function applyQuizCompletionToRecords(records, quizAttempts) {
  const quizCompletionMap = getQuizCompletionMap(records, quizAttempts);

  return records.map((record) => ({
    ...record,
    quiz_completed: Boolean(quizCompletionMap.get(record.id)),
  }));
}

function getDownloadFileName(contentDisposition, fallbackName) {
  const match = contentDisposition?.match(/filename="?([^"]+)"?/i);
  return match?.[1] || fallbackName;
}

async function assertValidZipBlob(blob, label) {
  const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());

  if (header[0] === 0x50 && header[1] === 0x4b) {
    return;
  }

  throw new Error(
    `${label} download did not return a valid ZIP file. Please try again.`
  );
}

async function downloadZipResponse(response, fallbackFileName, label) {
  const blob = await response.blob();

  await assertValidZipBlob(blob, label);

  const url = window.URL.createObjectURL(blob);
  const contentDisposition = response.headers.get('Content-Disposition');
  const link = document.createElement('a');

  link.href = url;
  link.download = getDownloadFileName(contentDisposition, fallbackFileName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function cleanFileName(value, fallback = 'student-photo') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || fallback;
}

function getClassArchivePdfFileName(session) {
  const courseName = cleanFileName(session?.course_name, 'training-session');
  const trainingDate = session?.training_date || new Date().toISOString().split('T')[0];

  return `${courseName}-class-archive-${trainingDate}.pdf`;
}

function getClassArchiveExcelFileName(session) {
  const courseName = cleanFileName(session?.course_name, 'training-session');
  const trainingDate = session?.training_date || new Date().toISOString().split('T')[0];

  return `${courseName}-class-archive-${trainingDate}.xlsx`;
}

function getClassInfoRows(session, recordCount, generatedAt) {
  return [
    ['Course Name', session.course_name || 'N/A'],
    ['Training Date', session.training_date || 'N/A'],
    ['Time Started', formatDateTime(session.time_started)],
    ['Class End Time', formatDateTime(session.time_stopped)],
    ['Attendance Link Expires At', formatDateTime(session.expires_at)],
    ['Trainer Name', session.trainer_name || 'N/A'],
    ['Company Name', session.company_name || 'N/A'],
    ['Training Location', session.training_location || 'N/A'],
    ['Course Outline', session.course_outline || 'N/A'],
    ['Total Students Attended', String(recordCount)],
    ['Generated At', generatedAt],
  ];
}

function getImageExtension(dataUrl) {
  if (String(dataUrl).startsWith('data:image/jpeg')) return 'jpeg';
  if (String(dataUrl).startsWith('data:image/jpg')) return 'jpeg';

  return 'png';
}

function isLocalHost() {
  return (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

function getCertificatesUrl(sessionId) {
  if (isLocalHost()) {
    return `http://localhost:3001/.netlify/functions/certificates-session?sessionId=${sessionId}`;
  }

  return `/.netlify/functions/certificates-session?sessionId=${sessionId}`;
}

function getWalletCardsUrl(sessionId) {
  if (isLocalHost()) {
    return `http://localhost:3001/.netlify/functions/wallet-cards-session?sessionId=${sessionId}`;
  }

  return `/.netlify/functions/wallet-cards-session?sessionId=${sessionId}`;
}

function getAttendanceRecordsUrl() {
  if (isLocalHost()) {
    return 'http://localhost:3001/.netlify/functions/attendance-records';
  }

  return '/.netlify/functions/attendance-records';
}

function getUploadClassPdfUrl() {
  if (isLocalHost()) {
    return 'http://localhost:3001/.netlify/functions/upload-class-pdf';
  }

  return '/.netlify/functions/upload-class-pdf';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',').pop() : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function uploadPdfToSharePoint(doc, fileName) {
  const pdfBlob = doc.output('blob');
  const pdfBase64 = await blobToBase64(pdfBlob);
  const response = await fetch(getUploadClassPdfUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, pdfBase64 }),
  });
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.success) {
    throw new Error(data?.error || 'SharePoint upload failed.');
  }

  return data;
}

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();

  if (error || !data?.session?.access_token) {
    throw new Error('Please sign in again.');
  }

  return data.session.access_token;
}

function groupRecordsBySession(records, sessions = []) {
  const groupsById = new Map();
  const unassignedRecords = [];

  sessions.forEach((session) => {
    if (!session?.id || groupsById.has(session.id)) return;

    groupsById.set(session.id, {
      id: session.id,
      session,
      records: [],
    });
  });

  records.forEach((record) => {
    const session = record.training_sessions;

    if (!record.training_session_id || !session) {
      unassignedRecords.push(record);
      return;
    }

    if (!groupsById.has(record.training_session_id)) {
      groupsById.set(record.training_session_id, {
        id: record.training_session_id,
        session,
        records: [],
      });
    }

    groupsById.get(record.training_session_id).records.push(record);
  });

  const sessionGroups = Array.from(groupsById.values()).sort((a, b) => {
    const dateA = a.session?.created_at || a.session?.training_date || '';
    const dateB = b.session?.created_at || b.session?.training_date || '';
    return dateB.localeCompare(dateA);
  });

  if (unassignedRecords.length > 0) {
    sessionGroups.push({
      id: 'unassigned',
      session: null,
      records: unassignedRecords,
      title: 'Unassigned Attendance Records',
    });
  }

  return sessionGroups;
}

function SignaturePreview({ record, onError }) {
  const [signatureUrl, setSignatureUrl] = useState(record.signature_url || '');
  const [isLoading, setIsLoading] = useState(Boolean(record.signature_path));

  useEffect(() => {
    let isActive = true;

    async function loadSignatureUrl() {
      if (!record.signature_path) {
        setSignatureUrl(record.signature_url || '');
        setIsLoading(false);
        return;
      }

      if (record.signature_url) {
        setSignatureUrl(record.signature_url);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await supabase.storage
        .from('signatures')
        .createSignedUrl(record.signature_path, 300);

      if (!isActive) return;

      if (error || !data?.signedUrl) {
        console.error('Signature signed URL error:', error);
        setSignatureUrl(record.signature_url || '');
        setIsLoading(false);

        if (!record.signature_url) {
          onError('Unable to load student signature.');
        }

        return;
      }

      setSignatureUrl(data.signedUrl);
      setIsLoading(false);
    }

    loadSignatureUrl();

    return () => {
      isActive = false;
    };
  }, [record.signature_path, record.signature_url, onError]);

  if (isLoading) {
    return <span className="muted">Loading...</span>;
  }

  if (!signatureUrl) {
    return 'N/A';
  }

  return (
    <img
      src={signatureUrl}
      alt={`Signature for ${record.student_name}`}
      className="signature-preview"
      onError={() => onError('Unable to load student signature.')}
    />
  );
}

function StudentPhotoThumbnail({ record, onOpen, onError }) {
  const [photoUrl, setPhotoUrl] = useState(record.photo_url || '');
  const [isLoading, setIsLoading] = useState(Boolean(record.photo_path));

  useEffect(() => {
    let isActive = true;

    async function loadPhotoUrl() {
      if (!record.photo_path) {
        setPhotoUrl(record.photo_url || '');
        setIsLoading(false);
        return;
      }

      if (record.photo_url) {
        setPhotoUrl(record.photo_url);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await supabase.storage
        .from('attendance-photos')
        .createSignedUrl(record.photo_path, 300);

      if (!isActive) return;

      if (error || !data?.signedUrl) {
        console.error('Photo signed URL error:', error);
        setPhotoUrl('');
        setIsLoading(false);
        onError('Unable to load student photo.');
        return;
      }

      setPhotoUrl(data.signedUrl);
      setIsLoading(false);
    }

    loadPhotoUrl();

    return () => {
      isActive = false;
    };
  }, [record.photo_path, record.photo_url, onError]);

  if (!record.photo_path && !record.photo_url) {
    return 'N/A';
  }

  if (isLoading) {
    return <span className="muted">Loading...</span>;
  }

  if (!photoUrl) {
    return 'N/A';
  }

  const altText = `Photo for ${record.student_name}`;

  return (
    <button
      type="button"
      className="student-photo-button"
      onClick={() => onOpen(photoUrl, altText, record.student_name)}
      aria-label={`Open ${altText}`}
    >
      <img src={photoUrl} alt={altText} className="student-photo-thumbnail" />
    </button>
  );
}

function TrainerSignaturePreview({
  session,
  signatureUrl,
  isLoading,
  error,
  onLoad,
  onImageError,
}) {
  if (!session?.trainer_signature_path) return 'N/A';

  if (signatureUrl) {
    return (
      <img
        src={signatureUrl}
        alt="Trainer signature"
        className="signature-preview"
        onError={onImageError}
      />
    );
  }

  if (isLoading) {
    return <span className="muted" role="status">Loading signature...</span>;
  }

  if (error) {
    return (
      <span className="trainer-signature-error">
        Trainer signature unavailable
        <button type="button" className="secondary-button trainer-signature-retry" onClick={onLoad}>
          Retry
        </button>
      </span>
    );
  }

  return (
    <button type="button" className="secondary-button" onClick={onLoad}>
      Show Trainer Signature
    </button>
  );
}

export default function AdminRecords() {
  const [records, setRecords] = useState([]);
  const [archivedRecords, setArchivedRecords] = useState([]);
  const [archivedStudentRecords, setArchivedStudentRecords] = useState([]);
  const [studentArchives, setStudentArchives] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [archivedSessions, setArchivedSessions] = useState([]);
  const [currentUserEmail, setCurrentUserEmail] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [canManageAttendanceRecords, setCanManageAttendanceRecords] =
    useState(false);
  const [assetAccess, setAssetAccess] = useState({
    certificateTemplate: true,
    walletCards: true,
  });
  const [status, setStatus] = useState('');
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [summariesError, setSummariesError] = useState('');
  const [deletingId, setDeletingId] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  const [restoringArchivedClassId, setRestoringArchivedClassId] = useState(null);
  const [archivingAttendanceClassId, setArchivingAttendanceClassId] =
    useState(null);
  const [attendanceArchiveColumnsAvailable, setAttendanceArchiveColumnsAvailable] =
    useState(null);
  const [generatingCertificatesId, setGeneratingCertificatesId] = useState(null);
  const [generatingWalletCardsId, setGeneratingWalletCardsId] = useState(null);
  const [archivingClassId, setArchivingClassId] = useState(null);
  const [archivingClassExcelId, setArchivingClassExcelId] = useState(null);
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('');
  const [selectedPhotoAlt, setSelectedPhotoAlt] = useState('');
  const [selectedPhotoFileName, setSelectedPhotoFileName] = useState('');
  const [photoModalError, setPhotoModalError] = useState('');
  const [expandedSessionIds, setExpandedSessionIds] = useState(() => new Set());
  const [openSessionActionsId, setOpenSessionActionsId] = useState('');
  const [studentsLoadingByRecordId, setStudentsLoadingByRecordId] = useState({});
  const [studentsErrorByRecordId, setStudentsErrorByRecordId] = useState({});
  const [trainerSignatureUrlsByRecordId, setTrainerSignatureUrlsByRecordId] =
    useState({});
  const [trainerSignatureLoadingByRecordId, setTrainerSignatureLoadingByRecordId] =
    useState({});
  const [trainerSignatureErrorByRecordId, setTrainerSignatureErrorByRecordId] =
    useState({});
  const [recordsPage, setRecordsPage] = useState(1);
  const [archivePage, setArchivePage] = useState(1);
  const [hasMoreRecords, setHasMoreRecords] = useState(false);
  const [hasMoreArchivedRecords, setHasMoreArchivedRecords] = useState(false);
  const [loadMoreLoading, setLoadMoreLoading] = useState('');
  const [loadMoreError, setLoadMoreError] = useState('');
  const studentCacheRef = useRef(new Map());
  const studentRequestsRef = useRef(new Map());
  const trainerSignatureCacheRef = useRef(new Map());
  const trainerSignatureRequestsRef = useRef(new Map());
  const summariesControllerRef = useRef(null);
  const studentControllersRef = useRef(new Map());
  const trainerSignatureControllersRef = useRef(new Map());
  const requestGenerationRef = useRef(0);

  const groupedRecords = useMemo(
    () => groupRecordsBySession(records, sessions),
    [records, sessions]
  );
  const studentArchiveSessions = useMemo(() => {
    const grouped = new Map();

    studentArchives.forEach((record) => {
      const session = record.training_sessions;
      if (!session?.id) return;
      const existing = grouped.get(session.id) || {
        ...session,
        archived_at: record.archived_at,
        archive_delete_after: record.archive_delete_after,
        student_count: 0,
        archive_type: 'student',
      };
      existing.student_count += 1;
      if (record.archived_at > existing.archived_at) {
        existing.archived_at = record.archived_at;
      }
      if (
        record.archive_delete_after &&
        (!existing.archive_delete_after ||
          record.archive_delete_after < existing.archive_delete_after)
      ) {
        existing.archive_delete_after = record.archive_delete_after;
      }
      grouped.set(session.id, existing);
    });

    return [...grouped.values()];
  }, [studentArchives]);
  const groupedArchivedRecords = useMemo(() => {
    const classGroups = groupRecordsBySession(archivedRecords, archivedSessions).map(
      (group) => ({ ...group, archiveType: 'class' })
    );
    const studentGroups = groupRecordsBySession(
      archivedStudentRecords,
      studentArchiveSessions
    ).map((group) => ({ ...group, archiveType: 'student' }));

    return [...classGroups, ...studentGroups].sort((a, b) =>
      String(b.session?.archived_at || '').localeCompare(
        String(a.session?.archived_at || '')
      )
    );
  }, [archivedRecords, archivedSessions, archivedStudentRecords, studentArchiveSessions]);
  const canViewAttendanceArchive = isSettingsAdminUser({
    email: currentUserEmail,
  });
  const shouldArchiveToSharePoint = SHAREPOINT_ARCHIVE_EMAILS.has(
    normalizeEmail(currentUserEmail)
  );
  const handleMediaLoadError = useCallback((message) => {
    setPhotoModalError(message);
    setStatus(message);
  }, []);

  function openPhotoModal(photoUrl, altText, studentName) {
    setPhotoModalError('');
    setSelectedPhotoUrl(photoUrl);
    setSelectedPhotoAlt(altText);
    setSelectedPhotoFileName(`${cleanFileName(studentName)}-photo.jpg`);
  }

  function closePhotoModal() {
    setSelectedPhotoUrl('');
    setSelectedPhotoAlt('');
    setSelectedPhotoFileName('');
    setPhotoModalError('');
  }

  function toggleSessionActions(sessionId) {
    setOpenSessionActionsId((currentId) =>
      currentId === sessionId ? '' : sessionId
    );
  }

  function abortPendingRequests() {
    summariesControllerRef.current?.abort();
    studentControllersRef.current.forEach((controller) => controller.abort());
    trainerSignatureControllersRef.current.forEach((controller) => controller.abort());
    studentControllersRef.current.clear();
    trainerSignatureControllersRef.current.clear();
  }

  async function loadTrainerSignature(session) {
    const sessionId = session?.id;
    const signaturePath = session?.trainer_signature_path;

    if (!sessionId || !signaturePath) return;

    setTrainerSignatureLoadingByRecordId((current) => ({
      ...current,
      [sessionId]: true,
    }));
    setTrainerSignatureErrorByRecordId((current) => ({
      ...current,
      [sessionId]: '',
    }));

    try {
      const signatureUrl = await loadStudentsWithCache({
        cache: trainerSignatureCacheRef.current,
        inFlight: trainerSignatureRequestsRef.current,
        key: signaturePath,
        load: async () => {
          const controller = new AbortController();
          trainerSignatureControllersRef.current.set(signaturePath, controller);
          const accessToken = await getAccessToken();
          const query = new URLSearchParams({
            view: 'trainer-signature',
            sessionId,
          });
          const response = await fetchWithTimeout(
            `${getAttendanceRecordsUrl()}?${query}`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
            { controller, timeoutMs: 12000 }
          );
          const data = await response.json().catch(() => null);

          if (response.ok && data?.responseVersion !== 'attendance-archive-v3') {
            throw new Error('The optimized attendance endpoint is not deployed.');
          }

          if (
            !response.ok ||
            !data?.signatureUrl
          ) {
            throw new Error(data?.error || 'Trainer signature is unavailable.');
          }

          return data.signatureUrl;
        },
      });

      setTrainerSignatureUrlsByRecordId((current) => ({
        ...current,
        [sessionId]: signatureUrl,
      }));
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('Trainer signature request error:', error);
        setTrainerSignatureErrorByRecordId((current) => ({
          ...current,
          [sessionId]: error?.message || 'Trainer signature is unavailable.',
        }));
      }
    } finally {
      trainerSignatureControllersRef.current.delete(signaturePath);
      setTrainerSignatureLoadingByRecordId((current) => ({
        ...current,
        [sessionId]: false,
      }));
    }
  }

  function handleTrainerSignatureImageError(session) {
    if (!session?.id) return;
    trainerSignatureCacheRef.current.delete(session.trainer_signature_path);
    setTrainerSignatureUrlsByRecordId((current) => ({
      ...current,
      [session.id]: '',
    }));
    setTrainerSignatureErrorByRecordId((current) => ({
      ...current,
      [session.id]: 'Trainer signature is unavailable.',
    }));
  }

  async function fetchStudents(
    sessionId,
    archived = false,
    expand = true,
    archiveType = 'class'
  ) {
    const cacheSessionId = archived ? `${archiveType}:${sessionId}` : sessionId;
    const groupKey = getStudentGroupKey(cacheSessionId, archived);

    const load = async () => {
      const generation = requestGenerationRef.current;
      const controller = new AbortController();
      studentControllersRef.current.set(groupKey, controller);
      setStudentsLoadingByRecordId((current) => ({
        ...current,
        [groupKey]: true,
      }));
      setStudentsErrorByRecordId((current) => ({
        ...current,
        [groupKey]: '',
      }));

      try {
        const accessToken = await getAccessToken();
        const query = new URLSearchParams({
          view: 'students',
          sessionId,
          archived: String(archived),
        });
        if (archived) query.set('archiveType', archiveType);
        const response = await fetchWithTimeout(
          `${getAttendanceRecordsUrl()}?${query}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
          { controller, timeoutMs: 20000 }
        );
        const data = await response.json().catch(() => null);

        if (response.ok && data?.responseVersion !== 'attendance-archive-v3') {
          throw new Error('The optimized attendance endpoint is not deployed.');
        }

        if (
          !response.ok ||
          !Array.isArray(data?.records)
        ) {
          throw new Error(data?.error || 'Unable to load students.');
        }

        const nextRecords = applyQuizCompletionToRecords(
          data.records,
          data.quizAttempts || []
        );
        if (generation === requestGenerationRef.current) {
          const setTargetRecords = archived
            ? archiveType === 'student'
              ? setArchivedStudentRecords
              : setArchivedRecords
            : setRecords;
          setTargetRecords((current) =>
            replaceSessionRecords(current, sessionId, nextRecords)
          );
        }

        return nextRecords;
      } catch (error) {
        const message = error?.message || 'Unable to load students.';
        if (generation === requestGenerationRef.current && error?.name !== 'AbortError') {
          setStudentsErrorByRecordId((current) => ({
            ...current,
            [groupKey]: message,
          }));
        }
        throw error;
      } finally {
        studentControllersRef.current.delete(groupKey);
        if (generation === requestGenerationRef.current) {
          setStudentsLoadingByRecordId((current) => ({
            ...current,
            [groupKey]: false,
          }));
        }
      }
    };

    const nextRecords = await loadStudentsWithCache({
      cache: studentCacheRef.current,
      inFlight: studentRequestsRef.current,
      key: groupKey,
      load,
    });

    if (expand) {
      setExpandedSessionIds((currentIds) => new Set(currentIds).add(groupKey));
    }

    return nextRecords;
  }

  async function toggleStudents(sessionId, archived = false, archiveType = 'class') {
    const cacheSessionId = archived ? `${archiveType}:${sessionId}` : sessionId;
    const groupKey = getStudentGroupKey(cacheSessionId, archived);

    if (expandedSessionIds.has(groupKey)) {
      setExpandedSessionIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(groupKey);
        return nextIds;
      });
      return;
    }

    try {
      await fetchStudents(sessionId, archived, true, archiveType);
    } catch (error) {
      console.error('Attendance students request error:', error);
    }
  }

  async function downloadSelectedPhoto() {
    if (!selectedPhotoUrl) return;

    try {
      const response = await fetch(selectedPhotoUrl);

      if (!response.ok) {
        throw new Error('Photo download failed.');
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = objectUrl;
      link.download = selectedPhotoFileName || 'student-photo.jpg';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error('Photo download error:', error);
      setPhotoModalError('Unable to download student photo.');
      setStatus('Unable to download student photo.');
    }
  }

  async function loadRecords({
    page = 1,
    nextArchivePage = 1,
    scope = 'all',
    append = false,
  } = {}) {
    if (!append) {
      requestGenerationRef.current += 1;
      abortPendingRequests();
      setSummariesLoading(true);
      setSummariesError('');
      setStatus('');
      setPhotoModalError('');
      setRecords([]);
      setArchivedRecords([]);
      setArchivedStudentRecords([]);
      setStudentArchives([]);
      setSessions([]);
      setArchivedSessions([]);
      setRecordsPage(1);
      setArchivePage(1);
      setHasMoreRecords(false);
      setHasMoreArchivedRecords(false);
      setExpandedSessionIds(new Set());
      setStudentsLoadingByRecordId({});
      setStudentsErrorByRecordId({});
      setTrainerSignatureUrlsByRecordId({});
      setTrainerSignatureLoadingByRecordId({});
      setTrainerSignatureErrorByRecordId({});
      studentCacheRef.current.clear();
      studentRequestsRef.current.clear();
      trainerSignatureCacheRef.current.clear();
      trainerSignatureRequestsRef.current.clear();
    } else {
      setLoadMoreLoading(scope);
      setLoadMoreError('');
    }

    summariesControllerRef.current?.abort();
    const controller = new AbortController();
    summariesControllerRef.current = controller;

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    const user = sessionData?.session?.user;
    const userEmail = user?.email || '';

    setCurrentUserEmail(userEmail.trim().toLowerCase());
    setCurrentUserId(user?.id || '');
    setCanManageAttendanceRecords(canManageAttendanceRecordsFromUser(user));
    setAssetAccess(getAssetAccessFromUser(user));

    if (sessionError || !accessToken) {
      console.error('Attendance records auth error:', sessionError);
      setSummariesError('Please sign in again to view attendance records.');
      setSummariesLoading(false);
      setLoadMoreLoading('');
      if (summariesControllerRef.current === controller) {
        summariesControllerRef.current = null;
      }
      return;
    }

    try {
      const query = new URLSearchParams({
        page: String(page),
        archivePage: String(nextArchivePage),
        scope,
      });
      const response = await fetchWithTimeout(
        `${getAttendanceRecordsUrl()}?${query}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
        { controller, timeoutMs: 15000 }
      );
      const data = await response.json().catch(() => null);

      if (response.ok && data?.responseVersion !== 'attendance-archive-v3') {
        throw new Error(
          'The optimized attendance endpoint is not deployed. Deploy the latest function and refresh.'
        );
      }

      if (
        !response.ok ||
        !Array.isArray(data?.sessions)
      ) {
        throw new Error(data?.error || 'Unable to load attendance records.');
      }

      const returnedSummaries = [
        ...data.sessions,
        ...(data.classArchives || data.archivedSessions || []),
      ];

      if (
        returnedSummaries.some(
          (session) => !Number.isFinite(Number(session?.student_count))
        )
      ) {
        throw new Error(
          'The attendance summary response is missing student totals. Deploy the latest function and Supabase migration.'
        );
      }

      console.info('Attendance summaries response:', {
        responseVersion: data.responseVersion,
        summarySource: data.summarySource,
        pageSize: data.pageSize,
      });

      setCanManageAttendanceRecords(Boolean(data.canManageAttendanceRecords));
      if (typeof data.archiveColumnsAvailable === 'boolean') {
        setAttendanceArchiveColumnsAvailable(data.archiveColumnsAvailable);
      }

      if (scope !== 'archived') {
        setSessions((current) => append ? [...current, ...data.sessions] : data.sessions);
        setRecordsPage(page);
        setHasMoreRecords(Boolean(data.hasMoreRecords));
      }

      if (scope !== 'active') {
        const nextArchivedSessions = data.classArchives || data.archivedSessions || [];
        setArchivedSessions((current) =>
          append ? [...current, ...nextArchivedSessions] : nextArchivedSessions
        );
        const nextStudentArchives = data.studentArchives || [];
        setStudentArchives((current) =>
          append ? [...current, ...nextStudentArchives] : nextStudentArchives
        );
        setArchivePage(nextArchivePage);
        setHasMoreArchivedRecords(Boolean(data.hasMoreArchivedRecords));
      }

    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.error('Attendance records function error:', error);
        if (append) {
          setLoadMoreError(
            error?.message || 'Unable to load more attendance records.'
          );
        } else {
          setSummariesError(
            error?.message || 'Unable to load attendance records.'
          );
        }
      }
    } finally {
      if (summariesControllerRef.current === controller) {
        summariesControllerRef.current = null;
        setSummariesLoading(false);
        setLoadMoreLoading('');
      }
    }
  }

  async function deleteRecord(record) {
    const confirmed = window.confirm(
      `Archive attendance record for ${record.student_name}? It will stay in Attendance Archive for 30 days before it can be permanently deleted.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingId(record.id);
    setStatus('');

    try {
      if (attendanceArchiveColumnsAvailable === false) {
        setStatus(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE);
        return;
      }

      const accessToken = await getAccessToken();
      const response = await fetch(getAttendanceRecordsUrl(), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recordId: record.id }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Failed to delete record.');
      }

      await loadRecords();
      setStatus('Attendance record archived.');
    } catch (error) {
      console.error(error);
      if (String(error?.message || '').includes(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE)) {
        setAttendanceArchiveColumnsAvailable(false);
        setStatus(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setStatus(error.message || 'Failed to archive attendance record.');
      }
    } finally {
      setDeletingId(null);
    }
  }

  async function restoreArchivedRecord(record) {
    if (!canViewAttendanceArchive) {
      setStatus('Only the admin account can restore archived attendance records.');
      return;
    }

    const confirmed = window.confirm(
      `Restore ${record.student_name || 'this student'}? Only this student attendance record will return to Attendance Records.`
    );

    if (!confirmed) {
      return;
    }

    setRestoringId(record.id);
    setStatus('');

    try {
      const accessToken = await getAccessToken();
      const response = await fetch(getAttendanceRecordsUrl(), {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recordId: record.id, action: 'restore' }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Failed to restore record.');
      }

      await loadRecords();
      setStatus('Student attendance record restored.');
    } catch (error) {
      console.error(error);
      if (String(error?.message || '').includes(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE)) {
        setAttendanceArchiveColumnsAvailable(false);
        setStatus(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setStatus(error.message || 'Failed to restore attendance record.');
      }
    } finally {
      setRestoringId(null);
    }
  }

  async function restoreArchivedClass(group) {
    if (!canViewAttendanceArchive) {
      setStatus('Only the admin account can restore archived attendance classes.');
      return;
    }

    if (!group?.id || group.id === 'unassigned') {
      setStatus('This class cannot be restored because it has no training session id.');
      return;
    }

    const confirmed = window.confirm(
      'Restore this entire class? All archived students in this class will return to Attendance Records.'
    );

    if (!confirmed) {
      return;
    }

    setRestoringArchivedClassId(group.id);
    setStatus('');

    try {
      const accessToken = await getAccessToken();
      const response = await fetch(getAttendanceRecordsUrl(), {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'restore_class', sessionId: group.id }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || 'Failed to restore class.');
      }

      await loadRecords();
      setStatus('Class restored successfully.');
    } catch (error) {
      console.error(error);
      if (String(error?.message || '').includes(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE)) {
        setAttendanceArchiveColumnsAvailable(false);
        setStatus(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setStatus(error.message || 'Failed to restore attendance class.');
      }
    } finally {
      setRestoringArchivedClassId(null);
    }
  }

  async function archiveAttendanceClass(group) {
    if (!canViewAttendanceArchive) {
      setStatus('Only the admin account can archive entire attendance classes.');
      return;
    }

    if (!group?.id || group.id === 'unassigned') {
      setStatus('This class cannot be archived because it has no training session id.');
      return;
    }

    const confirmed = window.confirm(
      'Archive this entire class and every student? Unless restored, the class and its class-owned data will be permanently deleted after 30 days.'
    );

    if (!confirmed) {
      return;
    }

    setArchivingAttendanceClassId(group.id);
    setStatus('');

    try {
      if (attendanceArchiveColumnsAvailable === false) {
        setStatus(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE);
        return;
      }

      const accessToken = await getAccessToken();
      const requestUrl = getAttendanceRecordsUrl();
      const requestBody = { action: 'archive_class', sessionId: group.id };
      const response = await fetch(requestUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          `Archive Class failed (${response.status}) at ${requestUrl} with ${JSON.stringify(
            requestBody
          )}: ${data?.error || 'No response body.'}`
        );
      }

      await loadRecords();
      setStatus(
        `Attendance class archived. ${data?.archivedCount || 0} student record(s) moved to Attendance Archive.`
      );
    } catch (error) {
      console.error(error);
      if (String(error?.message || '').includes(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE)) {
        setAttendanceArchiveColumnsAvailable(false);
        setStatus(ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setStatus(error.message || 'Failed to archive attendance class.');
      }
    } finally {
      setArchivingAttendanceClassId(null);
    }
  }

  async function downloadSessionCertificates(group) {
    if (group.id === 'unassigned') return;

    if (!assetAccess.certificateTemplate) {
      setStatus('Certificate downloads were not included for this email.');
      return;
    }

    if ((group.session?.student_count ?? group.records.length) === 0) {
      setStatus('No students found for this session.');
      return;
    }

    setStatus('');
    setGeneratingCertificatesId(group.id);

    try {
      const accessToken = await getAccessToken();
      const response = await fetch(getCertificatesUrl(group.id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const errorData = contentType.includes('application/json')
          ? await response.json().catch(() => null)
          : null;

        throw new Error(
          errorData?.error ||
            'Certificates could not be downloaded for this email.'
        );
      }

      await downloadZipResponse(response, 'certificates.zip', 'Certificate');
    } catch (error) {
      console.error(error);
      const message =
        error instanceof TypeError
          ? 'Certificates could not be downloaded. Please try again.'
          : error.message || 'Certificates could not be downloaded.';

      setStatus(message);
    } finally {
      setGeneratingCertificatesId(null);
    }
  }

  async function downloadSessionWalletCards(group) {
    if (group.id === 'unassigned') return;

    if (!assetAccess.walletCards) {
      setStatus('Wallet card downloads were not included for this email.');
      return;
    }

    if ((group.session?.student_count ?? group.records.length) === 0) {
      setStatus('No students found for this session.');
      return;
    }

    setStatus('');
    setGeneratingWalletCardsId(group.id);

    try {
      const accessToken = await getAccessToken();
      const response = await fetch(getWalletCardsUrl(group.id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const errorData = contentType.includes('application/json')
          ? await response.json().catch(() => null)
          : null;

        throw new Error(
          errorData?.error ||
            'Wallet cards could not be downloaded for this email.'
        );
      }

      await downloadZipResponse(response, 'wallet-cards.zip', 'Wallet cards');
    } catch (error) {
      console.error(error);
      const message =
        error instanceof TypeError
          ? 'Wallet cards could not be downloaded. Please try again.'
          : error.message || 'Wallet cards could not be downloaded.';

      setStatus(message);
    } finally {
      setGeneratingWalletCardsId(null);
    }
  }

  async function downloadArchiveImage(bucketName, filePath, fallbackUrl) {
    try {
      if (fallbackUrl) {
        const response = await fetch(fallbackUrl);

        if (response.ok) {
          const blob = await response.blob();

          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }
      }

      if (filePath) {
        const { data, error } = await supabase.storage
          .from(bucketName)
          .download(filePath);

        if (!error && data) {
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(data);
          });
        }
      }
    } catch (error) {
      console.error(`${bucketName} archive image load error:`, error);
    }

    return null;
  }

  async function downloadClassArchivePdf(group) {
    if (group.id === 'unassigned' || !group.session) return;

    setStatus('');
    setArchivingClassId(group.id);

    try {
      const recordsToArchive = group.records.length > 0
        ? group.records
        : await fetchStudents(group.id, false, true);

      if (recordsToArchive.length === 0) {
        setStatus('No attendance records to archive.');
        return;
      }

      const { session } = group;
      const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'pt',
        format: 'letter',
      });
      const generatedAt = new Date().toLocaleString();
      const tableRows = [];
      const tableImages = [];

      for (const record of recordsToArchive) {
        const photoImage = await downloadArchiveImage(
          'attendance-photos',
          record.photo_path,
          record.photo_url
        );
        const signatureImage = await downloadArchiveImage(
          'signatures',
          record.signature_path,
          record.signature_url
        );

        tableImages.push({ photoImage, signatureImage });
        tableRows.push([
          record.student_name || '',
          record.quiz_completed ? 'Yes' : 'No',
          record.student_email || '',
          record.company || 'N/A',
          formatDateTime(record.signed_at),
          record.latitude ?? 'N/A',
          record.longitude ?? 'N/A',
          formatAccuracy(record.location_accuracy),
          photoImage ? '' : 'N/A',
          signatureImage ? '' : 'N/A',
          record.is_suspicious ? 'Yes' : 'No',
          record.suspicious_reason || '',
          record.device_id || '',
          record.user_agent || '',
        ]);
      }
      const classInfoRows = getClassInfoRows(
        session,
        recordsToArchive.length,
        generatedAt
      );

      doc.setTextColor('#036f5e');
      doc.setFontSize(20);
      doc.setFont(undefined, 'bold');
      doc.text('Attendance Class Archive', 40, 42);

      doc.setTextColor('#111827');
      doc.setFontSize(10);
      doc.setFont(undefined, 'normal');
      doc.text(`Generated date/time: ${generatedAt}`, 40, 64);
      doc.text(`Total number of records: ${recordsToArchive.length}`, 40, 80);

      autoTable(doc, {
        startY: 100,
        head: [['Class Information', '']],
        body: classInfoRows,
        theme: 'grid',
        headStyles: {
          fillColor: '#036f5e',
          textColor: '#ffffff',
          fontStyle: 'bold',
        },
        styles: {
          fontSize: 8,
          cellPadding: 4,
          overflow: 'linebreak',
          valign: 'middle',
        },
        columnStyles: {
          0: { cellWidth: 170, fontStyle: 'bold' },
          1: { cellWidth: 555 },
        },
        margin: { left: 40, right: 40 },
      });

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 18,
        head: [[
          'Student Name',
          'Quiz Completed',
          'Student Email',
          'Company',
          'Signed Date/Time',
          'Latitude',
          'Longitude',
          'Location Accuracy',
          'Student Photo',
          'Signature',
          'Possible Duplicate Device',
          'Suspicious Reason',
          'Device ID',
          'User Agent',
        ]],
        body: tableRows,
        theme: 'grid',
        headStyles: {
          fillColor: '#036f5e',
          textColor: '#ffffff',
          fontStyle: 'bold',
        },
        styles: {
          fontSize: 5.6,
          cellPadding: 3,
          overflow: 'linebreak',
          valign: 'middle',
          minCellHeight: 44,
        },
        columnStyles: {
          0: { cellWidth: 55 },
          1: { cellWidth: 42 },
          2: { cellWidth: 70 },
          3: { cellWidth: 43 },
          4: { cellWidth: 60 },
          5: { cellWidth: 43 },
          6: { cellWidth: 43 },
          7: { cellWidth: 42 },
          8: { cellWidth: 42 },
          9: { cellWidth: 52 },
          10: { cellWidth: 43 },
          11: { cellWidth: 52 },
          12: { cellWidth: 43 },
          13: { cellWidth: 80 },
        },
        didDrawCell: (data) => {
          if (data.section !== 'body') return;

          const media = tableImages[data.row.index];

          if (data.column.index === 8 && media?.photoImage) {
            doc.addImage(
              media.photoImage,
              data.cell.x + 6,
              data.cell.y + 5,
              34,
              34
            );
          }

          if (data.column.index === 9 && media?.signatureImage) {
            doc.addImage(
              media.signatureImage,
              data.cell.x + 4,
              data.cell.y + 10,
              48,
              24
            );
          }
        },
        margin: { left: 40, right: 40 },
      });

      const fileName = getClassArchivePdfFileName(session);

      if (shouldArchiveToSharePoint) {
        try {
          await uploadPdfToSharePoint(doc, fileName);
          setStatus('Class PDF uploaded to SharePoint.');
        } catch (error) {
          console.error(error);
          doc.save(fileName);
          setStatus('SharePoint upload failed. PDF downloaded locally instead.');
        }
      } else {
        doc.save(fileName);
      }
    } catch (error) {
      console.error('Class archive PDF generation error:', error);
      setStatus(error.message || 'Failed to generate class archive.');
    } finally {
      setArchivingClassId(null);
    }
  }

  async function downloadClassArchiveExcel(group) {
    if (group.id === 'unassigned' || !group.session) return;

    setStatus('');
    setArchivingClassExcelId(group.id);

    try {
      const recordsToArchive = group.records.length > 0
        ? group.records
        : await fetchStudents(group.id, false, true);

      if (recordsToArchive.length === 0) {
        setStatus('No attendance records to archive.');
        return;
      }

      const { session } = group;
      const generatedAt = new Date().toLocaleString();
      const classInfoRows = getClassInfoRows(
        session,
        recordsToArchive.length,
        generatedAt
      );
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'ExCourse';
      workbook.created = new Date();

      const classInfoSheet = workbook.addWorksheet('Class Information');
      classInfoSheet.columns = [{ width: 30 }, { width: 90 }];
      classInfoSheet.addRow(['Attendance Class Archive']);
      classInfoSheet.addRow(['Generated date/time', generatedAt]);
      classInfoSheet.addRow(['Total number of records', recordsToArchive.length]);
      classInfoSheet.addRow([]);
      classInfoSheet.addRow(['Class Information', '']);
      classInfoRows.forEach((row) => classInfoSheet.addRow(row));
      classInfoSheet.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF036F5E' } };
      classInfoSheet.getRow(5).font = { bold: true };

      const attendanceSheet = workbook.addWorksheet('Attendance Records');
      attendanceSheet.columns = [
        { header: 'Student Name', key: 'studentName', width: 24 },
        { header: 'Quiz Completed', key: 'quizCompleted', width: 18 },
        { header: 'Student Email', key: 'studentEmail', width: 30 },
        { header: 'Company', key: 'company', width: 24 },
        { header: 'Signed Date/Time', key: 'signedAt', width: 24 },
        { header: 'Latitude', key: 'latitude', width: 14 },
        { header: 'Longitude', key: 'longitude', width: 14 },
        { header: 'Location Accuracy', key: 'locationAccuracy', width: 18 },
        { header: 'Student Photo', key: 'studentPhoto', width: 18 },
        { header: 'Signature', key: 'signature', width: 24 },
        { header: 'Possible Duplicate Device', key: 'isSuspicious', width: 24 },
        { header: 'Suspicious Reason', key: 'suspiciousReason', width: 36 },
        { header: 'Device ID', key: 'deviceId', width: 36 },
        { header: 'User Agent', key: 'userAgent', width: 80 },
      ];
      attendanceSheet.views = [{ state: 'frozen', ySplit: 1 }];
      attendanceSheet.autoFilter = {
        from: 'A1',
        to: 'N1',
      };
      attendanceSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      attendanceSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF036F5E' },
      };

      for (const record of recordsToArchive) {
        const photoImage = await downloadArchiveImage(
          'attendance-photos',
          record.photo_path,
          record.photo_url
        );
        const signatureImage = await downloadArchiveImage(
          'signatures',
          record.signature_path,
          record.signature_url
        );
        const row = attendanceSheet.addRow({
          studentName: record.student_name || '',
          quizCompleted: record.quiz_completed ? 'Yes' : 'No',
          studentEmail: record.student_email || '',
          company: record.company || 'N/A',
          signedAt: formatDateTime(record.signed_at),
          latitude: record.latitude ?? 'N/A',
          longitude: record.longitude ?? 'N/A',
          locationAccuracy: formatAccuracy(record.location_accuracy),
          studentPhoto: photoImage ? '' : 'N/A',
          signature: signatureImage ? '' : 'N/A',
          isSuspicious: record.is_suspicious ? 'Yes' : 'No',
          suspiciousReason: record.suspicious_reason || '',
          deviceId: record.device_id || '',
          userAgent: record.user_agent || '',
        });

        row.height = 62;

        if (photoImage) {
          const imageId = workbook.addImage({
            base64: photoImage,
            extension: getImageExtension(photoImage),
          });
          attendanceSheet.addImage(imageId, {
            tl: { col: 8.15, row: row.number - 0.85 },
            ext: { width: 58, height: 58 },
          });
        }

        if (signatureImage) {
          const imageId = workbook.addImage({
            base64: signatureImage,
            extension: getImageExtension(signatureImage),
          });
          attendanceSheet.addImage(imageId, {
            tl: { col: 9.1, row: row.number - 0.78 },
            ext: { width: 120, height: 42 },
          });
        }
      }

      attendanceSheet.eachRow((row) => {
        row.alignment = { vertical: 'middle', wrapText: true };
      });

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = getClassArchiveExcelFileName(session);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Class archive Excel generation error:', error);
      setStatus(error.message || 'Failed to generate class archive Excel.');
    } finally {
      setArchivingClassExcelId(null);
    }
  }

  useEffect(() => {
    const timerId = window.setTimeout(() => {
      loadRecords();
    }, 0);

    return () => {
      window.clearTimeout(timerId);
      requestGenerationRef.current += 1;
      abortPendingRequests();
    };
    // Admin records intentionally load once when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!openSessionActionsId) return undefined;

    function closeSessionActionsOnOutsideClick(event) {
      if (
        event.target instanceof Element &&
        event.target.closest('.session-actions-menu')
      ) {
        return;
      }

      setOpenSessionActionsId('');
    }

    document.addEventListener('click', closeSessionActionsOnOutsideClick);

    return () => {
      document.removeEventListener('click', closeSessionActionsOnOutsideClick);
    };
  }, [openSessionActionsId]);

  return (
    <section className="card">
      <div className="admin-header">
        <div>
          <h2>Admin Attendance Records</h2>
          <p className="muted">View submitted student attendance records.</p>
        </div>

        <div className="admin-actions">
          <button type="button" className="secondary-button" onClick={() => loadRecords()}>
            Refresh
          </button>
        </div>
      </div>

      {summariesLoading && <p className="status">Loading records...</p>}

      {summariesError && <p className="status" role="alert">{summariesError}</p>}

      {(status || photoModalError) && (
        <p className="status">{status || photoModalError}</p>
      )}

      {!summariesLoading && !summariesError && groupedRecords.length === 0 && (
        <p className="muted">No attendance records found yet.</p>
      )}

      {groupedRecords.length > 0 && (
        <div className="session-records-list">
          {groupedRecords.map((group) => {
            const groupKey = getStudentGroupKey(group.id, false);
            const isExpanded = expandedSessionIds.has(groupKey);
            const loadState = {
              status: studentsLoadingByRecordId[groupKey]
                ? 'loading'
                : studentsErrorByRecordId[groupKey]
                  ? 'error'
                  : '',
              error: studentsErrorByRecordId[groupKey] || '',
            };
            const studentsRegionId = `students-${group.id}`;
            const classTitle = group.title || getSessionValue(group.session, 'course_name');

            return (
            <section
              className={`session-record-card ${
                isExpanded ? 'session-record-card-expanded' : 'session-record-card-collapsed'
              }`}
              key={group.id}
            >
              <div className="session-record-top-row">
                <div className="session-record-title-row">
                  <button
                    type="button"
                    className="secondary-button session-expand-button"
                    onClick={() => toggleStudents(group.id, false)}
                    aria-expanded={isExpanded}
                    aria-controls={studentsRegionId}
                    disabled={loadState.status === 'loading'}
                  >
                    {loadState.status === 'loading'
                      ? 'Loading Students...'
                      : isExpanded
                        ? 'Hide Students ↑'
                        : 'Show Students ↓'}
                  </button>
                  <h3>{classTitle}</h3>
                </div>

                <div className="session-card-actions">
                  {group.id !== 'unassigned' && (
                    <div className="session-actions-menu">
                      <button
                        type="button"
                        className="secondary-button session-actions-icon-button"
                        onClick={() => toggleSessionActions(group.id)}
                        aria-expanded={openSessionActionsId === group.id}
                        aria-controls={`session-actions-${group.id}`}
                        aria-label="Class actions"
                        title="Class actions"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          width="20"
                          height="20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="1" />
                          <circle cx="19" cy="12" r="1" />
                          <circle cx="5" cy="12" r="1" />
                        </svg>
                      </button>

                      {openSessionActionsId === group.id && (
                        <div
                          className="session-actions-panel"
                          id={`session-actions-${group.id}`}
                        >
                          <button
                            type="button"
                            className="secondary-button session-action-button"
                            onClick={() => {
                              setOpenSessionActionsId('');
                              downloadSessionCertificates(group);
                            }}
                            disabled={
                              !assetAccess.certificateTemplate ||
                              getStudentCount(group.session, group.records) === 0 ||
                              generatingCertificatesId === group.id
                            }
                            title={
                              assetAccess.certificateTemplate
                                ? ''
                                : 'Certificate downloads were not included for this email.'
                            }
                          >
                            {generatingCertificatesId === group.id
                              ? 'Generating certificates...'
                              : 'Download Certificates'}
                          </button>

                          <button
                            type="button"
                            className="secondary-button session-action-button"
                            onClick={() => {
                              setOpenSessionActionsId('');
                              downloadSessionWalletCards(group);
                            }}
                            disabled={
                              !assetAccess.walletCards ||
                              getStudentCount(group.session, group.records) === 0 ||
                              generatingWalletCardsId === group.id
                            }
                            title={
                              assetAccess.walletCards
                                ? ''
                                : 'Wallet card downloads were not included for this email.'
                            }
                          >
                            {generatingWalletCardsId === group.id
                              ? 'Generating wallet cards...'
                              : 'Download Wallet Cards'}
                          </button>

                          <button
                            type="button"
                            className="secondary-button session-action-button archive-class-button"
                            onClick={() => {
                              setOpenSessionActionsId('');
                              downloadClassArchivePdf(group);
                            }}
                            disabled={archivingClassId === group.id}
                          >
                            {archivingClassId === group.id
                              ? 'Archiving...'
                              : 'Archive Class PDF'}
                          </button>

                          <button
                            type="button"
                            className="secondary-button session-action-button archive-class-button"
                            onClick={() => {
                              setOpenSessionActionsId('');
                              downloadClassArchiveExcel(group);
                            }}
                            disabled={archivingClassExcelId === group.id}
                          >
                            {archivingClassExcelId === group.id
                              ? 'Archiving Excel...'
                              : 'Archive Class Excel'}
                          </button>

                          {canViewAttendanceArchive && (
                            <button
                              type="button"
                              className="delete-button session-action-button"
                              onClick={() => {
                                setOpenSessionActionsId('');
                                archiveAttendanceClass(group);
                              }}
                              disabled={
                                archivingAttendanceClassId === group.id ||
                                attendanceArchiveColumnsAvailable === false
                              }
                            >
                              {archivingAttendanceClassId === group.id
                                ? 'Archiving class...'
                                : 'Archive Class'}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <dl className="session-meta">
                <div>
                  <dt>Course Name</dt>
                  <dd>{getSessionValue(group.session, 'course_name')}</dd>
                </div>

                <div>
                  <dt>Training Date</dt>
                  <dd>{getSessionValue(group.session, 'training_date')}</dd>
                </div>

                <div>
                  <dt>Created At</dt>
                  <dd>{formatDateTime(group.session?.created_at)}</dd>
                </div>

                <div>
                  <dt>Trainer</dt>
                  <dd>{getSessionValue(group.session, 'trainer_name')}</dd>
                </div>

                <div>
                  <dt>Company</dt>
                  <dd>{getSessionValue(group.session, 'company_name')}</dd>
                </div>

                <div>
                  <dt>Location</dt>
                  <dd>{getSessionValue(group.session, 'training_location')}</dd>
                </div>

                <div>
                  <dt>Time Started</dt>
                  <dd>{formatTime(group.session?.time_started)}</dd>
                </div>

                <div>
                  <dt>Class End Time</dt>
                  <dd>{formatTime(group.session?.time_stopped)}</dd>
                </div>

                <div>
                  <dt>Expires At</dt>
                  <dd>{formatDateTime(group.session?.expires_at)}</dd>
                </div>

                <div>
                  <dt>Course Outline</dt>
                  <dd>{group.session?.course_outline || 'Not provided'}</dd>
                </div>

                <div>
                  <dt>Trainer Signature</dt>
                  <dd>
                    <TrainerSignaturePreview
                      session={group.session}
                      signatureUrl={trainerSignatureUrlsByRecordId[group.id] || ''}
                      isLoading={Boolean(
                        trainerSignatureLoadingByRecordId[group.id]
                      )}
                      error={trainerSignatureErrorByRecordId[group.id] || ''}
                      onLoad={() => loadTrainerSignature(group.session)}
                      onImageError={() =>
                        handleTrainerSignatureImageError(group.session)
                      }
                    />
                  </dd>
                </div>

                <div>
                  <dt>Total Students</dt>
                  <dd>{getStudentCount(group.session, group.records)}</dd>
                </div>
              </dl>

              {loadState.status === 'loading' && (
                <p className="muted student-load-status" role="status">
                  Loading students...
                </p>
              )}

              {loadState.status === 'error' && (
                <div className="student-load-error" role="alert">
                  <span>{loadState.error}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => toggleStudents(group.id, false)}
                  >
                    Retry
                  </button>
                </div>
              )}

              {isExpanded && (
              <div className="table-wrap" id={studentsRegionId}>
                <div className="quiz-status-legend" aria-label="Quiz completion legend">
                  <span>
                    <span className="quiz-status-icon quiz-completed" aria-hidden="true">
                      ✓
                    </span>
                    Quiz completed
                  </span>
                  <span>
                    <span className="quiz-status-icon quiz-not-completed" aria-hidden="true">
                      ×
                    </span>
                    Quiz not completed
                  </span>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>Student Name</th>
                      <th>Quiz</th>
                      <th>Email</th>
                      <th>Company</th>
                      <th>Signed Date/Time</th>
                      <th>Signature</th>
                      <th>Photo</th>
                      <th>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {group.records.length === 0 && (
                      <tr>
                        <td colSpan="8" className="muted">
                          No students found for this class.
                        </td>
                      </tr>
                    )}

                    {group.records.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <div>{record.student_name}</div>

                          {record.is_suspicious && (
                            <div className="suspicious-warning">
                              <span className="suspicious-icon" aria-hidden="true">
                                ⚠
                              </span>

                              <div className="suspicious-copy">
                                <div className="suspicious-title">
                                  Duplicate device
                                </div>

                                <div className="suspicious-reason">
                                  {record.suspicious_reason ||
                                    'Same device already submitted for another student in this session'}
                                </div>
                              </div>
                            </div>
                          )}
                        </td>
                        <td>
                          <span
                            className={`quiz-status-icon ${
                              record.quiz_completed
                                ? 'quiz-completed'
                                : 'quiz-not-completed'
                            }`}
                            title={
                              record.quiz_completed
                                ? 'Quiz completed for this session'
                                : 'No quiz completion found for this session'
                            }
                            aria-label={
                              record.quiz_completed
                                ? 'Quiz completed for this session'
                                : 'No quiz completion found for this session'
                            }
                          >
                            {record.quiz_completed ? '✓' : '×'}
                          </span>
                        </td>
                        <td>{record.student_email}</td>
                        <td>{record.company || 'N/A'}</td>
                        <td>{formatDateTime(record.signed_at)}</td>
                        <td>
                          <SignaturePreview
                            record={record}
                            onError={handleMediaLoadError}
                          />
                        </td>
                        <td>
                          <StudentPhotoThumbnail
                            record={record}
                            onOpen={openPhotoModal}
                            onError={handleMediaLoadError}
                          />
                        </td>
                        <td>
                          {canManageAttendanceRecords ||
                          shouldArchiveToSharePoint ||
                          record.training_sessions?.owner_user_id === currentUserId ? (
                            <button
                              type="button"
                              className="delete-button"
                              onClick={() => deleteRecord(record)}
                              disabled={
                                deletingId === record.id ||
                                attendanceArchiveColumnsAvailable === false
                              }
                            >
                              {deletingId === record.id ? 'Archiving...' : 'Archive'}
                            </button>
                          ) : (
                            'N/A'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </section>
            );
          })}
        </div>
      )}

      {hasMoreRecords && (
        <div className="load-more-records">
          <button
            type="button"
            className="secondary-button"
            onClick={() => loadRecords({
              page: recordsPage + 1,
              nextArchivePage: archivePage,
              scope: 'active',
              append: true,
            })}
            disabled={loadMoreLoading === 'active'}
          >
            {loadMoreLoading === 'active' ? 'Loading...' : 'Load More Records'}
          </button>
        </div>
      )}

      {loadMoreError && <p className="status" role="alert">{loadMoreError}</p>}

      {canViewAttendanceArchive && (
        <section className="session-records-list">
          <div className="admin-header attendance-archive-header">
            <div>
              <h2>Attendance Archive</h2>
              <p className="muted">
                Archived students and classes remain here for 30 days before permanent deletion.
              </p>
            </div>
          </div>

          {attendanceArchiveColumnsAvailable === false ? (
            <p className="muted">{ATTENDANCE_ARCHIVE_MIGRATION_MESSAGE}</p>
          ) : groupedArchivedRecords.length === 0 ? (
            <p className="muted">No archived attendance records.</p>
          ) : (
            groupedArchivedRecords.map((group) => {
              const groupKey = getStudentGroupKey(
                `${group.archiveType}:${group.id}`,
                true
              );
              const isExpanded = expandedSessionIds.has(groupKey);
              const loadState = {
                status: studentsLoadingByRecordId[groupKey]
                  ? 'loading'
                  : studentsErrorByRecordId[groupKey]
                    ? 'error'
                    : '',
                error: studentsErrorByRecordId[groupKey] || '',
              };
              const studentsRegionId = `archived-${group.archiveType}-students-${group.id}`;
              const classTitle = group.title || getSessionValue(group.session, 'course_name');

              return (
                <section
                  className={`session-record-card ${
                    isExpanded
                      ? 'session-record-card-expanded'
                      : 'session-record-card-collapsed'
                  }`}
                  key={`archive-${group.archiveType}-${group.id}`}
                >
                  <div className="session-record-top-row">
                    <div className="session-record-title-row">
                      <button
                        type="button"
                        className="secondary-button session-expand-button"
                        onClick={() =>
                          toggleStudents(group.id, true, group.archiveType)
                        }
                        aria-expanded={isExpanded}
                        aria-controls={studentsRegionId}
                        disabled={loadState.status === 'loading'}
                      >
                        {loadState.status === 'loading'
                          ? 'Loading Students...'
                          : isExpanded
                            ? 'Hide Students ↑'
                            : 'Show Students ↓'}
                      </button>
                      <h3>{classTitle}</h3>
                    </div>

                    <div className="session-card-actions">
                      <span className="archived-class-date">
                        Archived: {formatDateTime(group.session?.archived_at)}
                      </span>
                      <span>
                        Deletes permanently: {formatDateTime(group.session?.archive_delete_after)}
                      </span>
                      {isArchiveDeadlineOverdue(group.session?.archive_delete_after) && (
                        <strong className="archive-overdue">Overdue for cleanup</strong>
                      )}
                      {group.archiveType === 'class' && (
                        <button
                          type="button"
                          className="secondary-button session-action-button"
                          onClick={() => restoreArchivedClass(group)}
                          disabled={restoringArchivedClassId === group.id}
                        >
                          {restoringArchivedClassId === group.id
                            ? 'Restoring class...'
                            : 'Restore Class'}
                        </button>
                      )}
                    </div>
                  </div>

                      <dl className="session-meta">
                        <div>
                          <dt>Course Name</dt>
                          <dd>{getSessionValue(group.session, 'course_name')}</dd>
                        </div>

                        <div>
                          <dt>Training Date</dt>
                          <dd>{getSessionValue(group.session, 'training_date')}</dd>
                        </div>

                        <div>
                          <dt>Created At</dt>
                          <dd>{formatDateTime(group.session?.created_at)}</dd>
                        </div>

                        <div>
                          <dt>Trainer</dt>
                          <dd>{getSessionValue(group.session, 'trainer_name')}</dd>
                        </div>

                        <div>
                          <dt>Company</dt>
                          <dd>{getSessionValue(group.session, 'company_name')}</dd>
                        </div>

                        <div>
                          <dt>Location</dt>
                          <dd>{getSessionValue(group.session, 'training_location')}</dd>
                        </div>

                        <div>
                          <dt>Time Started</dt>
                          <dd>{formatTime(group.session?.time_started)}</dd>
                        </div>

                        <div>
                          <dt>Class End Time</dt>
                          <dd>{formatTime(group.session?.time_stopped)}</dd>
                        </div>

                        <div>
                          <dt>Expires At</dt>
                          <dd>{formatDateTime(group.session?.expires_at)}</dd>
                        </div>

                        <div>
                          <dt>Course Outline</dt>
                          <dd>{group.session?.course_outline || 'Not provided'}</dd>
                        </div>

                        <div>
                          <dt>Trainer Signature</dt>
                          <dd>
                            <TrainerSignaturePreview
                              session={group.session}
                              signatureUrl={
                                trainerSignatureUrlsByRecordId[group.id] || ''
                              }
                              isLoading={Boolean(
                                trainerSignatureLoadingByRecordId[group.id]
                              )}
                              error={
                                trainerSignatureErrorByRecordId[group.id] || ''
                              }
                              onLoad={() => loadTrainerSignature(group.session)}
                              onImageError={() =>
                                handleTrainerSignatureImageError(group.session)
                              }
                            />
                          </dd>
                        </div>

                        <div>
                          <dt>Total Students</dt>
                          <dd>{getStudentCount(group.session, group.records)}</dd>
                        </div>
                      </dl>

                      {loadState.status === 'loading' && (
                        <p className="muted student-load-status" role="status">
                          Loading students...
                        </p>
                      )}

                      {loadState.status === 'error' && (
                        <div className="student-load-error" role="alert">
                          <span>{loadState.error}</span>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() =>
                              toggleStudents(group.id, true, group.archiveType)
                            }
                          >
                            Retry
                          </button>
                        </div>
                      )}

                      {isExpanded && (
                      <div className="table-wrap" id={studentsRegionId}>
                        <table>
                          <thead>
                            <tr>
                              <th>Student Name</th>
                              <th>Email</th>
                              <th>Company</th>
                              <th>Signed Date/Time</th>
                              <th>Signature</th>
                              <th>Photo</th>
                              <th>Action</th>
                            </tr>
                          </thead>

                          <tbody>
                            {group.records.length === 0 && (
                              <tr>
                                <td colSpan="7" className="muted">
                                  No students found for this class.
                                </td>
                              </tr>
                            )}
                            {group.records.map((record) => (
                              <tr key={record.id}>
                                <td>{record.student_name}</td>
                                <td>{record.student_email}</td>
                                <td>{record.company || 'N/A'}</td>
                                <td>{formatDateTime(record.signed_at)}</td>
                                <td>
                                  <SignaturePreview
                                    record={record}
                                    onError={handleMediaLoadError}
                                  />
                                </td>
                                <td>
                                  <StudentPhotoThumbnail
                                    record={record}
                                    onOpen={openPhotoModal}
                                    onError={handleMediaLoadError}
                                  />
                                </td>
                                <td>
                                  {group.archiveType === 'student' ? (
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      onClick={() => restoreArchivedRecord(record)}
                                      disabled={restoringId === record.id}
                                    >
                                      {restoringId === record.id
                                        ? 'Restoring student...'
                                        : 'Restore Student'}
                                    </button>
                                  ) : (
                                    'Restored with class'
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                  )}
                </section>
              );
            })
          )}

          {hasMoreArchivedRecords && (
            <div className="load-more-records">
              <button
                type="button"
                className="secondary-button"
                onClick={() => loadRecords({
                  page: recordsPage,
                  nextArchivePage: archivePage + 1,
                  scope: 'archived',
                  append: true,
                })}
                disabled={loadMoreLoading === 'archived'}
              >
                {loadMoreLoading === 'archived'
                  ? 'Loading...'
                  : 'Load More Archived Records'}
              </button>
            </div>
          )}
        </section>
      )}

      {selectedPhotoUrl && (
        <div
          className="photo-modal-overlay"
          onClick={closePhotoModal}
          role="presentation"
        >
          <div className="photo-modal" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="photo-modal-close"
              onClick={closePhotoModal}
              aria-label="Close photo"
            >
              X
            </button>

            <img
              src={selectedPhotoUrl}
              alt={selectedPhotoAlt}
              className="photo-modal-image"
            />

            <div className="photo-modal-actions">
              <button type="button" onClick={downloadSelectedPhoto}>
                Download Photo
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
