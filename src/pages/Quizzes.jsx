import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { supabase } from '../supabaseClient';
import { downloadQuizResultsExcel } from '../quizResultsExcel';
import { getQuizResultSummary } from '../quizResultsUtils';
import {
  canDeleteSavedQuizResults,
  canUseSavedQuizLibrary,
  isSettingsAdminUser,
  normalizeEmail,
} from '../userFeatureAccess';
import './Quiz.css';

const EXCEEDSAFETY_EMAIL = 'exceedsafety@gmail.com';
const SHAREPOINT_ARCHIVE_EMAILS = new Set([
  'excourse7233@gmail.com',
  EXCEEDSAFETY_EMAIL,
]);
const ARCHIVE_RETENTION_DAYS = 30;
const ARCHIVE_SOURCE_LABELS = {
  saved_quiz: 'Saved Quizzes',
  saved_quiz_results: 'Saved Quiz Results',
};
const ARCHIVE_MIGRATION_MESSAGE =
  'Archive requires database migration before it can be used.';

function formatDate(value) {
  if (!value) return 'Not provided';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString();
}

async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error('Please sign in again.');
  }

  return data.user;
}

async function getCurrentAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;

  if (error || !accessToken) {
    throw new Error('Please sign in again.');
  }

  return accessToken;
}

function isLocalHost() {
  return (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );
}

function getSavedQuizLibraryUrl() {
  if (isLocalHost()) {
    return 'http://localhost:3001/.netlify/functions/saved-quiz-library';
  }

  return '/.netlify/functions/saved-quiz-library';
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

async function readFunctionJson(response, fallbackMessage) {
  const responseText = await response.text();
  let responseData = null;

  if (responseText.trim()) {
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      responseData?.error ||
        (responseText && !responseText.trim().startsWith('<') ? responseText : '') ||
        `${fallbackMessage} (${response.status} ${response.statusText})`
    );
  }

  return responseData || {};
}

async function syncSavedQuizLibrary() {
  const accessToken = await getCurrentAccessToken();

  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const responseData = await readFunctionJson(
    response,
    'Unable to sync saved quiz library.'
  );

  return responseData?.importedQuizCount || 0;
}

async function fetchSavedQuizLibrary() {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return readFunctionJson(response, 'Unable to load saved quiz library.');
}

function formatDateTime(value) {
  if (!value) return 'Not provided';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not provided';

  return date.toLocaleString();
}

function getArchiveDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return date;
}

function buildArchivePayload(user, archiveSource) {
  const archivedAt = new Date();
  const archiveDeleteAfter = new Date(archivedAt);
  archiveDeleteAfter.setDate(archiveDeleteAfter.getDate() + ARCHIVE_RETENTION_DAYS);

  return {
    archived_at: archivedAt.toISOString(),
    archived_by: user.id,
    archive_delete_after: archiveDeleteAfter.toISOString(),
    archive_source: archiveSource,
  };
}

function getArchiveSourceLabel(quiz) {
  return ARCHIVE_SOURCE_LABELS[quiz.archive_source] || 'Archived Quiz';
}

function getArchiveDeleteStatus(quiz) {
  const deleteAfter = getArchiveDate(quiz.archive_delete_after);

  if (!deleteAfter) return 'Permanent delete date not set';

  if (deleteAfter.getTime() <= Date.now()) {
    return 'Eligible for permanent delete';
  }

  return `Permanent delete after ${formatDateTime(quiz.archive_delete_after)}`;
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

async function archiveSavedQuizInLibrary(quizId, archiveSource) {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ quizId, archiveSource }),
  });

  return readFunctionJson(response, 'Unable to archive saved quiz.');
}

async function restoreArchivedQuizInLibrary(quizId) {
  const accessToken = await getCurrentAccessToken();
  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ quizId, action: 'restore' }),
  });

  return readFunctionJson(response, 'Unable to restore archived quiz.');
}

async function fetchOwnSavedQuizzes(user) {
  const selectOwnSavedQuizzes = (includeSavedFlag, includeArchiveFields) => {
    const savedQuizFields = includeSavedFlag
      ? 'id, course_name, quiz_title, class_date, passing_score, is_active, results_saved, is_saved_template, quiz_duration_minutes, created_at, owner_user_id, archived_at, archived_by, archive_delete_after, archive_source'
      : 'id, course_name, quiz_title, class_date, passing_score, is_active, results_saved, quiz_duration_minutes, created_at, owner_user_id, archived_at, archived_by, archive_delete_after, archive_source';
    const fallbackSavedQuizFields = includeSavedFlag
      ? 'id, course_name, quiz_title, class_date, passing_score, is_active, results_saved, is_saved_template, quiz_duration_minutes, created_at, owner_user_id'
      : 'id, course_name, quiz_title, class_date, passing_score, is_active, results_saved, quiz_duration_minutes, created_at, owner_user_id';

    let query = supabase
      .from('quiz_templates')
      .select(includeArchiveFields ? savedQuizFields : fallbackSavedQuizFields)
      .eq('owner_user_id', user.id)
      .order('created_at', { ascending: false });

    if (includeArchiveFields) {
      query = query.is('archived_at', null);
    }

    query = includeSavedFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);

    return query;
  };

  let archiveColumnsAvailable = true;
  let { data, error } = await selectOwnSavedQuizzes(true, true);

  if (isMissingArchiveColumn(error)) {
    archiveColumnsAvailable = false;
    const fallbackResponse = await selectOwnSavedQuizzes(true, false);
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectOwnSavedQuizzes(
      false,
      archiveColumnsAvailable
    );
    data = fallbackResponse.data;
    error = fallbackResponse.error;

    if (isMissingArchiveColumn(error)) {
      archiveColumnsAvailable = false;
      const noArchiveFallbackResponse = await selectOwnSavedQuizzes(
        false,
        false
      );
      data = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  return {
    archiveColumnsAvailable,
    quizzes: data || [],
  };
}

function mergeSavedQuizLists(ownQuizzes, sharedQuizzes) {
  const savedQuizById = new Map();

  for (const quiz of [...ownQuizzes, ...sharedQuizzes]) {
    if (!quiz?.id || savedQuizById.has(quiz.id)) continue;
    savedQuizById.set(quiz.id, quiz);
  }

  return [...savedQuizById.values()];
}

function shouldKeepExistingSavedQuizBehavior(user) {
  return normalizeEmail(user?.email) === EXCEEDSAFETY_EMAIL;
}

function getSavedQuizOptionLabel(quiz) {
  return `${quiz.course_name || 'Untitled Course'} - ${
    quiz.quiz_title || 'Untitled Quiz'
  }`;
}

function cleanFileName(value, fallback = 'quiz-results') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || fallback;
}

function getQuizArchivePdfFileName(quiz) {
  const courseName = cleanFileName(quiz?.course_name, 'quiz');
  const quizTitle = cleanFileName(quiz?.quiz_title, 'results');
  const classDate = quiz?.class_date || new Date().toISOString().split('T')[0];

  return `${courseName}-${quizTitle}-quiz-results-${classDate}.pdf`;
}

function buildQuizResultsPdf(quiz, attempts) {
  const summary = getQuizResultSummary(quiz, attempts);
  const generatedAt = new Date().toLocaleString();
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'pt',
    format: 'letter',
  });

  doc.setTextColor('#036f5e');
  doc.setFontSize(20);
  doc.setFont(undefined, 'bold');
  doc.text('Quiz Results Archive', 40, 42);

  doc.setTextColor('#111827');
  doc.setFontSize(10);
  doc.setFont(undefined, 'normal');
  doc.text(`Generated date/time: ${generatedAt}`, 40, 64);

  autoTable(doc, {
    startY: 84,
    head: [['Quiz Information', '']],
    body: [
      ['Course', quiz.course_name || 'Untitled Course'],
      ['Quiz', quiz.quiz_title || 'Untitled Quiz'],
      ['Class Date', formatDate(quiz.class_date)],
      ['Passing Score', `${quiz.passing_score ?? 0}%`],
      ['Total Attempts', String(attempts.length)],
      ['Class Average', `${summary.averagePercentage.toFixed(2)}%`],
      ['Passed', String(summary.passCount)],
      ['Failed', String(summary.failCount)],
    ],
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
      0: { cellWidth: 150, fontStyle: 'bold' },
      1: { cellWidth: 575 },
    },
    margin: { left: 40, right: 40 },
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 18,
    head: [[
      'Student Name',
      'Email',
      'Company',
      'Score',
      'Percentage',
      'Passed/Failed',
      'Submitted Date/Time',
    ]],
    body: attempts.map((attempt) => [
      attempt.student_name || '',
      attempt.student_email || '',
      attempt.company || 'N/A',
      `${attempt.score ?? 0} / ${attempt.total_questions ?? 0}`,
      `${Number(attempt.percentage || 0).toFixed(2)}%`,
      attempt.passed ? 'Passed' : 'Failed',
      formatDateTime(attempt.submitted_at),
    ]),
    theme: 'grid',
    headStyles: {
      fillColor: '#036f5e',
      textColor: '#ffffff',
      fontStyle: 'bold',
    },
    styles: {
      fontSize: 7,
      cellPadding: 4,
      overflow: 'linebreak',
      valign: 'middle',
    },
    margin: { left: 40, right: 40 },
  });

  if (summary.mostMissedQuestions.length > 0) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 18,
      head: [['Question', 'Correct', 'Missed', 'Miss Percentage']],
      body: summary.mostMissedQuestions.map((question) => [
        question.questionText || '',
        `${question.correctCount} of ${attempts.length} (${question.correctPercentage.toFixed(2)}%)`,
        `${question.missedCount} of ${attempts.length}`,
        `${question.missPercentage.toFixed(2)}%`,
      ]),
      theme: 'grid',
      headStyles: {
        fillColor: '#036f5e',
        textColor: '#ffffff',
        fontStyle: 'bold',
      },
      styles: {
        fontSize: 7,
        cellPadding: 4,
        overflow: 'linebreak',
        valign: 'middle',
      },
      columnStyles: {
        0: { cellWidth: 470 },
      },
      margin: { left: 40, right: 40 },
    });
  }

  return doc;
}

function isOriginalSavedQuizTemplate(quiz) {
  const quizTitle = (quiz.quiz_title || '').trim();
  const isSavedTemplate =
    'is_saved_template' in quiz
      ? quiz.is_saved_template === true
      : quiz.is_active === false && !quiz.results_saved;

  return isSavedTemplate && !/\bcopy$/i.test(quizTitle);
}

function getEditableSavedQuizzes(user, allQuizzes) {
  return isSettingsAdminUser(user)
    ? allQuizzes
    : allQuizzes.filter(isOriginalSavedQuizTemplate);
}

async function archiveSavedQuizTemplateById(quizId, user) {
  if (isSettingsAdminUser(user)) {
    return archiveSavedQuizInLibrary(quizId, 'saved_quiz');
  }

  const applyOwnerFilter = !isSettingsAdminUser(user);
  const applyOwnerScope = (query) =>
    applyOwnerFilter ? query.eq('owner_user_id', user.id) : query;
  const archivePayload = buildArchivePayload(user, 'saved_quiz');

  let archiveQuery = supabase
    .from('quiz_templates')
    .update(archivePayload)
    .eq('id', quizId)
    .eq('is_saved_template', true)
    .is('archived_at', null);
  archiveQuery = applyOwnerScope(archiveQuery);
  let { data, error } = await archiveQuery.select('id');

  if (isMissingSavedTemplateColumn(error)) {
    let fallbackArchiveQuery = supabase
      .from('quiz_templates')
      .update(archivePayload)
      .eq('id', quizId)
      .eq('is_active', false)
      .eq('results_saved', false)
      .is('archived_at', null);
    fallbackArchiveQuery = applyOwnerScope(fallbackArchiveQuery);

    const fallbackResponse = await fallbackArchiveQuery.select('id');
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (error) throw error;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('No saved quiz was archived. Refresh and try again.');
  }

  return data;
}

async function restoreArchivedQuizById(quizId, user) {
  if (isSettingsAdminUser(user)) {
    return restoreArchivedQuizInLibrary(quizId);
  }

  const { data, error } = await supabase
    .from('quiz_templates')
    .update({
      archived_at: null,
      archived_by: null,
      archive_delete_after: null,
      archive_source: null,
    })
    .eq('id', quizId)
    .eq('owner_user_id', user.id)
    .not('archived_at', 'is', null)
    .select('id');

  if (error) throw error;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('No archived quiz was restored. Refresh and try again.');
  }

  return data;
}

function isMissingSavedTemplateColumn(error) {
  return String(error?.message || '').toLowerCase().includes('is_saved_template');
}

export default function Quizzes() {
  const navigate = useNavigate();
  const [allSavedQuizzes, setAllSavedQuizzes] = useState([]);
  const [savedQuizzes, setSavedQuizzes] = useState([]);
  const [selectedSavedQuizId, setSelectedSavedQuizId] = useState('');
  const [selectedCopiedQuizId, setSelectedCopiedQuizId] = useState('');
  const [isLoadingSavedQuizzes, setIsLoadingSavedQuizzes] = useState(false);
  const [deletingCopiedQuizId, setDeletingCopiedQuizId] = useState('');
  const [savedResultQuizzes, setSavedResultQuizzes] = useState([]);
  const [isLoadingSavedResults, setIsLoadingSavedResults] = useState(false);
  const [archivedQuizzes, setArchivedQuizzes] = useState([]);
  const [isLoadingArchivedQuizzes, setIsLoadingArchivedQuizzes] = useState(false);
  const [archiveColumnsAvailable, setArchiveColumnsAvailable] = useState(null);
  const [restoringArchivedQuizId, setRestoringArchivedQuizId] = useState('');
  const [downloadingResultsQuizId, setDownloadingResultsQuizId] = useState('');
  const [archivingQuizPdfId, setArchivingQuizPdfId] = useState('');
  const [deletingSavedResultQuizId, setDeletingSavedResultQuizId] = useState('');
  const [openSavedResultActionsId, setOpenSavedResultActionsId] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [userPermissions, setUserPermissions] = useState({
    canUseSavedQuizLibrary: false,
    canShowSavedQuizzesSection: false,
    canDeleteSavedQuizResults: true,
    canViewArchivedQuizzes: false,
  });

  const loadSavedQuizzes = useCallback(async function loadSavedQuizzes() {
    setIsLoadingSavedQuizzes(true);
    setErrorMessage('');

    try {
      const user = await getCurrentUser();
      const userCanUseSavedQuizLibrary = canUseSavedQuizLibrary(user);
      const keepExistingSavedQuizBehavior =
        shouldKeepExistingSavedQuizBehavior(user);

      setUserPermissions((currentPermissions) => ({
        ...currentPermissions,
        canUseSavedQuizLibrary: userCanUseSavedQuizLibrary,
        canShowSavedQuizzesSection: keepExistingSavedQuizBehavior
          ? userCanUseSavedQuizLibrary
          : true,
        canViewArchivedQuizzes: isSettingsAdminUser(user),
      }));

      if (keepExistingSavedQuizBehavior && !userCanUseSavedQuizLibrary) {
        setAllSavedQuizzes([]);
        setSavedQuizzes([]);
        setSelectedSavedQuizId('');
        setSelectedCopiedQuizId('');
        return;
      }

      let ownQuizzes = [];

      if (!keepExistingSavedQuizBehavior) {
        const ownQuizzesResponse = await fetchOwnSavedQuizzes(user);
        ownQuizzes = ownQuizzesResponse.quizzes;
        setArchiveColumnsAvailable(ownQuizzesResponse.archiveColumnsAvailable);
      }

      let sharedQuizzes = [];

      if (userCanUseSavedQuizLibrary) {
        await syncSavedQuizLibrary();
        const libraryData = await fetchSavedQuizLibrary();
        sharedQuizzes = libraryData.savedQuizzes || [];
        if (typeof libraryData.archiveColumnsAvailable === 'boolean') {
          setArchiveColumnsAvailable(libraryData.archiveColumnsAvailable);
        }
      }

      const allQuizzes = keepExistingSavedQuizBehavior
        ? sharedQuizzes
        : mergeSavedQuizLists(ownQuizzes, sharedQuizzes);
      const quizzes = getEditableSavedQuizzes(user, allQuizzes);

      setAllSavedQuizzes(allQuizzes);
      setSavedQuizzes(quizzes);
      setSelectedSavedQuizId((currentId) =>
        quizzes.some((quiz) => quiz.id === currentId)
          ? currentId
          : quizzes[0]?.id || ''
      );
      setSelectedCopiedQuizId((currentId) =>
        allQuizzes.some((quiz) => quiz.id === currentId) ? currentId : ''
      );
    } catch (error) {
      console.error('Load saved quizzes error:', error);
      setAllSavedQuizzes([]);
      setSavedQuizzes([]);
      setSelectedSavedQuizId('');
      setSelectedCopiedQuizId('');
      setErrorMessage(error?.message || 'Unable to load saved quizzes.');
    } finally {
      setIsLoadingSavedQuizzes(false);
    }
  }, []);

  const loadSavedResultQuizzes = useCallback(async function loadSavedResultQuizzes() {
    setIsLoadingSavedResults(true);
    setErrorMessage('');

    try {
      const user = await getCurrentUser();
      const userCanDeleteSavedQuizResults = canDeleteSavedQuizResults(user);

      setUserPermissions((currentPermissions) => ({
        ...currentPermissions,
        canDeleteSavedQuizResults: userCanDeleteSavedQuizResults,
        canViewArchivedQuizzes: isSettingsAdminUser(user),
      }));

      const selectSavedResults = (includeArchiveFields) => {
        let query = supabase
          .from('quiz_templates')
          .select(
            includeArchiveFields
              ? 'id, course_name, quiz_title, class_date, passing_score, quiz_duration_minutes, is_active, results_saved, created_at, owner_user_id, archived_at, archived_by, archive_delete_after, archive_source'
              : 'id, course_name, quiz_title, class_date, passing_score, quiz_duration_minutes, is_active, results_saved, created_at, owner_user_id'
          )
          .eq('results_saved', true)
          .order('created_at', { ascending: false });

        if (includeArchiveFields) {
          query = query.is('archived_at', null);
        }

        if (!isSettingsAdminUser(user)) {
          query = query.eq('owner_user_id', user.id);
        }

        return query;
      };

      let { data, error } = await selectSavedResults(true);

      if (isMissingArchiveColumn(error)) {
        setArchiveColumnsAvailable(false);
        const fallbackResponse = await selectSavedResults(false);
        data = fallbackResponse.data;
        error = fallbackResponse.error;
      }

      if (error) throw error;

      setSavedResultQuizzes(data || []);
    } catch (error) {
      console.error('Load saved quiz results error:', error);
      setErrorMessage(error?.message || 'Unable to load saved quiz results.');
    } finally {
      setIsLoadingSavedResults(false);
    }
  }, []);

  const loadArchivedQuizzes = useCallback(async function loadArchivedQuizzes() {
    setIsLoadingArchivedQuizzes(true);
    setErrorMessage('');

    try {
      const user = await getCurrentUser();

      setUserPermissions((currentPermissions) => ({
        ...currentPermissions,
        canViewArchivedQuizzes: isSettingsAdminUser(user),
      }));

      if (!isSettingsAdminUser(user)) {
        setArchivedQuizzes([]);
        return;
      }

      let archivedQuery = supabase
        .from('quiz_templates')
        .select('id, owner_user_id, course_name, quiz_title, class_date, passing_score, quiz_duration_minutes, is_active, results_saved, created_at, archived_at, archived_by, archive_delete_after, archive_source')
        .not('archived_at', 'is', null)
        .order('archived_at', { ascending: false });

      const { data, error } = await archivedQuery;

      if (isMissingArchiveColumn(error)) {
        setArchiveColumnsAvailable(false);
        setArchivedQuizzes([]);
        return;
      }

      if (error) throw error;

      setArchiveColumnsAvailable(true);
      setArchivedQuizzes(data || []);
    } catch (error) {
      console.error('Load archived quizzes error:', error);
      setArchivedQuizzes([]);
      setErrorMessage(error?.message || 'Unable to load archived quizzes.');
    } finally {
      setIsLoadingArchivedQuizzes(false);
    }
  }, []);

  async function loadFullSavedQuizResults(quiz) {
    const user = await getCurrentUser();
    let fullQuizQuery = supabase
      .from('quiz_templates')
      .select(`
        *,
        quiz_questions (
          id,
          question_text,
          sort_order,
          quiz_answer_choices (
            id,
            choice_text,
            is_correct,
            sort_order
          )
        )
      `)
      .eq('id', quiz.id)
      .eq('results_saved', true)
      .is('archived_at', null);

    if (!isSettingsAdminUser(user)) {
      fullQuizQuery = fullQuizQuery.eq('owner_user_id', user.id);
    }

    let { data: fullQuiz, error: quizError } = await fullQuizQuery.single();

    if (isMissingArchiveColumn(quizError)) {
      let fallbackFullQuizQuery = supabase
        .from('quiz_templates')
        .select(`
          *,
          quiz_questions (
            id,
            question_text,
            sort_order,
            quiz_answer_choices (
              id,
              choice_text,
              is_correct,
              sort_order
            )
          )
        `)
        .eq('id', quiz.id)
        .eq('results_saved', true);

      if (!isSettingsAdminUser(user)) {
        fallbackFullQuizQuery = fallbackFullQuizQuery.eq(
          'owner_user_id',
          user.id
        );
      }

      const fallbackResponse = await fallbackFullQuizQuery.single();
      fullQuiz = fallbackResponse.data;
      quizError = fallbackResponse.error;
      setArchiveColumnsAvailable(false);
    }

    if (quizError) throw quizError;

    const { data: attempts, error: attemptsError } = await supabase
      .from('quiz_attempts')
      .select(`
        *,
        quiz_attempt_answers (
          id,
          question_id,
          selected_choice_ids,
          is_correct
        )
      `)
      .eq('quiz_template_id', quiz.id)
      .order('submitted_at', { ascending: false });

    if (attemptsError) throw attemptsError;

    return { attempts: attempts || [], fullQuiz };
  }

  async function downloadSavedQuizResults(quiz) {
    setDownloadingResultsQuizId(quiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const { attempts, fullQuiz } = await loadFullSavedQuizResults(quiz);

      await downloadQuizResultsExcel(fullQuiz, attempts);
      setStatusMessage('Quiz results Excel downloaded.');
    } catch (error) {
      console.error('Download quiz results error:', error);
      setErrorMessage(error?.message || 'Unable to download quiz results.');
    } finally {
      setDownloadingResultsQuizId('');
    }
  }

  async function archiveQuizResultsPdf(quiz) {
    setArchivingQuizPdfId(quiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const user = await getCurrentUser();
      const { attempts, fullQuiz } = await loadFullSavedQuizResults(quiz);
      const doc = buildQuizResultsPdf(fullQuiz, attempts);
      const fileName = getQuizArchivePdfFileName(fullQuiz);
      const shouldUploadToSharePoint = SHAREPOINT_ARCHIVE_EMAILS.has(
        normalizeEmail(user.email)
      ) && !isLocalHost();

      if (!shouldUploadToSharePoint) {
        doc.save(fileName);
        setStatusMessage('Quiz PDF downloaded.');
        return;
      }

      try {
        await uploadPdfToSharePoint(doc, fileName);
        setStatusMessage('Quiz PDF uploaded to SharePoint.');
      } catch (error) {
        console.error(error);
        doc.save(fileName);
        setErrorMessage(
          `SharePoint upload failed: ${
            error?.message || 'Unknown upload error.'
          } Quiz PDF downloaded locally instead.`
        );
      }
    } catch (error) {
      console.error('Archive quiz PDF error:', error);
      setErrorMessage(error?.message || 'Unable to archive quiz PDF.');
    } finally {
      setArchivingQuizPdfId('');
    }
  }

  async function deleteSavedQuizResult(quiz) {
    const confirmed = window.confirm(
      'Archive this saved result? It will move to Archived Quizzes for 30 days.'
    );

    if (!confirmed) return;

    setDeletingSavedResultQuizId(quiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      if (archiveColumnsAvailable === false) {
        setErrorMessage(ARCHIVE_MIGRATION_MESSAGE);
        return;
      }

      if (!userPermissions.canDeleteSavedQuizResults) {
        setErrorMessage('This email cannot archive saved quiz results.');
        return;
      }

      const user = await getCurrentUser();
      if (isSettingsAdminUser(user)) {
        await archiveSavedQuizInLibrary(quiz.id, 'saved_quiz_results');
        setSavedResultQuizzes((currentQuizzes) =>
          currentQuizzes.filter((savedQuiz) => savedQuiz.id !== quiz.id)
        );
        await loadArchivedQuizzes();
        setStatusMessage('Saved result archived.');
        return;
      }

      const archivePayload = buildArchivePayload(user, 'saved_quiz_results');
      let archiveQuery = supabase
        .from('quiz_templates')
        .update(archivePayload)
        .eq('id', quiz.id)
        .eq('results_saved', true)
        .is('archived_at', null);

      archiveQuery = archiveQuery.eq('owner_user_id', user.id);

      const { data: archivedRows, error } = await archiveQuery.select('id');

      if (error) throw error;

      if (!Array.isArray(archivedRows) || archivedRows.length !== 1) {
        throw new Error('No saved quiz result was archived. Refresh and try again.');
      }

      setSavedResultQuizzes((currentQuizzes) =>
        currentQuizzes.filter((savedQuiz) => savedQuiz.id !== quiz.id)
      );
      await loadArchivedQuizzes();
      setStatusMessage('Saved result archived.');
    } catch (error) {
      console.error('Archive saved quiz result error:', error);
      if (isMissingArchiveColumn(error)) {
        setArchiveColumnsAvailable(false);
        setErrorMessage(ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setErrorMessage(error?.message || 'Unable to archive saved quiz result.');
      }
    } finally {
      setDeletingSavedResultQuizId('');
    }
  }

  function openSavedQuizResults(quiz) {
    navigate(`/quiz-results-7392?quizId=${quiz.id}`);
  }

  function toggleSavedResultActions(quizId) {
    setOpenSavedResultActionsId((currentId) =>
      currentId === quizId ? '' : quizId
    );
  }

  function handleSavedResultRowKeyDown(event, quiz) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSavedQuizResults(quiz);
    }
  }

  async function deleteSelectedCopiedQuiz() {
    const selectedQuiz = allSavedQuizzes.find(
      (quiz) => quiz.id === selectedCopiedQuizId
    );

    if (!selectedQuiz) {
      setErrorMessage('Choose a saved quiz to delete.');
      return;
    }

    const quizLabel = getSavedQuizOptionLabel(selectedQuiz);
    const confirmed = window.confirm(
      `Archive ${quizLabel}? It will stay in Archived Quizzes for 30 days before it can be permanently deleted.`
    );

    if (!confirmed) return;

    setDeletingCopiedQuizId(selectedQuiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      if (archiveColumnsAvailable === false) {
        setErrorMessage(ARCHIVE_MIGRATION_MESSAGE);
        return;
      }

      const user = await getCurrentUser();
      await archiveSavedQuizTemplateById(selectedQuiz.id, user);

      const nextAllSavedQuizzes = allSavedQuizzes.filter(
        (quiz) => quiz.id !== selectedQuiz.id
      );
      const nextSavedQuizzes = getEditableSavedQuizzes(
        user,
        nextAllSavedQuizzes
      );

      setAllSavedQuizzes(nextAllSavedQuizzes);
      setSavedQuizzes(nextSavedQuizzes);
      setSelectedSavedQuizId((currentId) =>
        nextSavedQuizzes.some((quiz) => quiz.id === currentId)
          ? currentId
          : nextSavedQuizzes[0]?.id || ''
      );
      setSelectedCopiedQuizId('');
      await loadArchivedQuizzes();
      setStatusMessage('Saved quiz archived.');
    } catch (error) {
      console.error('Delete copied quiz error:', error);
      if (isMissingArchiveColumn(error)) {
        setArchiveColumnsAvailable(false);
        setErrorMessage(ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setErrorMessage(error?.message || 'Unable to delete saved quiz.');
      }
    } finally {
      setDeletingCopiedQuizId('');
    }
  }

  async function restoreArchivedQuiz(quiz) {
    if (!quiz?.id) return;

    const confirmed = window.confirm(
      'Restore this quiz? It will return to its original section.'
    );

    if (!confirmed) return;

    setRestoringArchivedQuizId(quiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const user = await getCurrentUser();
      if (!isSettingsAdminUser(user)) {
        throw new Error('Only the admin account can restore archived quizzes.');
      }

      await restoreArchivedQuizById(quiz.id, user);
      await Promise.all([
        loadSavedQuizzes(),
        loadSavedResultQuizzes(),
        loadArchivedQuizzes(),
      ]);
      setStatusMessage('Archived quiz restored.');
    } catch (error) {
      console.error('Restore archived quiz error:', error);
      if (isMissingArchiveColumn(error)) {
        setArchiveColumnsAvailable(false);
        setErrorMessage(ARCHIVE_MIGRATION_MESSAGE);
      } else {
        setErrorMessage(error?.message || 'Unable to restore archived quiz.');
      }
    } finally {
      setRestoringArchivedQuizId('');
    }
  }

  const refreshQuizPage = useCallback(function refreshQuizPage() {
    loadSavedQuizzes();
    loadSavedResultQuizzes();
    loadArchivedQuizzes();
  }, [loadSavedQuizzes, loadSavedResultQuizzes, loadArchivedQuizzes]);

  useEffect(() => {
    Promise.resolve().then(() => {
      refreshQuizPage();
    });
  }, [refreshQuizPage]);

  useEffect(() => {
    if (!openSavedResultActionsId) return undefined;

    function closeSavedResultActionsOnOutsideClick(event) {
      if (
        event.target instanceof Element &&
        event.target.closest('.saved-result-actions-menu')
      ) {
        return;
      }

      setOpenSavedResultActionsId('');
    }

    document.addEventListener('click', closeSavedResultActionsOnOutsideClick);

    return () => {
      document.removeEventListener('click', closeSavedResultActionsOnOutsideClick);
    };
  }, [openSavedResultActionsId]);

  return (
    <section className="quiz-page">
      <div className="quiz-card">
        <div className="quiz-header">
          <h1>Quizzes</h1>
          <p>Review saved quiz results. Edit saved quiz questions and answers.</p>
        </div>

        <div className="quiz-nav-row quizzes-nav-row">
          <Link to="/create-quiz-7392" className="primary-button link-button">
            Create Quiz
          </Link>
          <button
            type="button"
            className="secondary-button"
            onClick={refreshQuizPage}
            disabled={
              isLoadingSavedQuizzes ||
              isLoadingSavedResults ||
              isLoadingArchivedQuizzes
            }
          >
            {isLoadingSavedQuizzes ||
            isLoadingSavedResults ||
            isLoadingArchivedQuizzes
              ? 'Refreshing...'
              : 'Refresh'}
          </button>
        </div>

        {errorMessage && (
          <div className="alert alert-error" role="alert">
            {errorMessage}
          </div>
        )}

        {statusMessage && (
          <div className="alert alert-success" role="status">
            {statusMessage}
          </div>
        )}

        {userPermissions.canShowSavedQuizzesSection && (
        <section className="active-quiz-panel saved-quizzes-panel">
          <div className="quiz-section-header">
            <div>
              <h2>Saved Quizzes</h2>
            </div>
          </div>

          {isLoadingSavedQuizzes ? (
            <p className="muted">Loading saved quizzes...</p>
          ) : savedQuizzes.length === 0 ? (
            <p className="muted">No saved quizzes found.</p>
          ) : (
            <>
              <div className="saved-quiz-edit-row">
                <select
                  value={selectedSavedQuizId}
                  onChange={(event) => setSelectedSavedQuizId(event.target.value)}
                  aria-label="Saved quizzes"
                >
                  {savedQuizzes.map((quiz) => (
                    <option key={quiz.id} value={quiz.id}>
                      {getSavedQuizOptionLabel(quiz)}
                    </option>
                  ))}
                </select>

                <Link
                  className="primary-button link-button saved-quiz-edit-button"
                  to={`/create-quiz-7392?editQuizId=${selectedSavedQuizId}`}
                >
                  Edit Quiz
                </Link>
              </div>
            </>
          )}

          {!isLoadingSavedQuizzes && allSavedQuizzes.length > 0 && (
            <div className="saved-quiz-delete-row">
              <select
                value={selectedCopiedQuizId}
                onChange={(event) => setSelectedCopiedQuizId(event.target.value)}
                aria-label="Saved quizzes to delete"
              >
                <option value="">Select quiz</option>
                {allSavedQuizzes.map((quiz) => (
                  <option key={quiz.id} value={quiz.id}>
                    {getSavedQuizOptionLabel(quiz)}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="quiz-danger-button saved-quiz-delete-action"
                onClick={deleteSelectedCopiedQuiz}
                disabled={
                  !selectedCopiedQuizId ||
                  deletingCopiedQuizId === selectedCopiedQuizId ||
                  archiveColumnsAvailable === false
                }
              >
                {selectedCopiedQuizId &&
                deletingCopiedQuizId === selectedCopiedQuizId
                  ? 'Archiving...'
                  : 'Archive Quiz'}
              </button>
            </div>
          )}
        </section>
        )}

        <section className="active-quiz-panel saved-results-panel">
          <div className="quiz-section-header">
            <div>
              <h2>Saved Quiz Results</h2>
            </div>
          </div>

          {isLoadingSavedResults ? (
            <p className="muted">Loading saved quiz results...</p>
          ) : savedResultQuizzes.length === 0 ? (
            <p className="muted">No saved quiz results.</p>
          ) : (
            <div className="active-quiz-list">
              {savedResultQuizzes.map((quiz) => (
                <div
                  className={`active-quiz-row saved-result-row ${
                    openSavedResultActionsId === quiz.id
                      ? 'saved-result-row-menu-open'
                      : ''
                  }`}
                  key={quiz.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openSavedQuizResults(quiz)}
                  onKeyDown={(event) => handleSavedResultRowKeyDown(event, quiz)}
                >
                  <div>
                    <strong>
                      {quiz.course_name || 'Untitled Course'} -{' '}
                      {quiz.quiz_title || 'Untitled Quiz'}
                    </strong>
                    <div className="active-quiz-meta">
                      <span>{formatDate(quiz.class_date)}</span>
                      <span>Passing: {quiz.passing_score}%</span>
                    </div>
                  </div>
                  <div className="active-quiz-actions">
                    <div
                      className="session-actions-menu saved-result-actions-menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="secondary-button session-actions-icon-button"
                        onClick={() => toggleSavedResultActions(quiz.id)}
                        aria-expanded={openSavedResultActionsId === quiz.id}
                        aria-controls={`saved-result-actions-${quiz.id}`}
                        aria-label="Saved quiz result actions"
                        title="Saved quiz result actions"
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

                      {openSavedResultActionsId === quiz.id && (
                        <div
                          className="session-actions-panel"
                          id={`saved-result-actions-${quiz.id}`}
                        >
                          <Link
                            className="secondary-link-button session-action-button"
                            to={`/quiz-results-7392?quizId=${quiz.id}`}
                            onClick={() => setOpenSavedResultActionsId('')}
                          >
                            View Results
                          </Link>
                          <button
                            type="button"
                            className="secondary-button session-action-button"
                            onClick={() => {
                              setOpenSavedResultActionsId('');
                              downloadSavedQuizResults(quiz);
                            }}
                            disabled={downloadingResultsQuizId === quiz.id}
                          >
                            {downloadingResultsQuizId === quiz.id
                              ? 'Downloading...'
                              : 'Download Results'}
                          </button>
                          <button
                            type="button"
                            className="secondary-button session-action-button archive-class-button"
                            onClick={() => {
                              setOpenSavedResultActionsId('');
                              archiveQuizResultsPdf(quiz);
                            }}
                            disabled={archivingQuizPdfId === quiz.id}
                          >
                            {archivingQuizPdfId === quiz.id
                              ? 'Archiving...'
                              : 'Archive Quiz PDF'}
                          </button>
                        </div>
                      )}
                    </div>
                    {userPermissions.canDeleteSavedQuizResults && (
                      <button
                        type="button"
                        className="quiz-delete-icon-button"
                        aria-label={`Archive saved result for ${
                          quiz.course_name || 'Untitled Course'
                        } - ${quiz.quiz_title || 'Untitled Quiz'}`}
                        title="Archive saved result"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenSavedResultActionsId('');
                          deleteSavedQuizResult(quiz);
                        }}
                        disabled={
                          deletingSavedResultQuizId === quiz.id ||
                          archiveColumnsAvailable === false
                        }
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          width="18"
                          height="18"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v5" />
                          <path d="M14 11v5" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {userPermissions.canViewArchivedQuizzes && (
          <section className="active-quiz-panel archived-quizzes-panel">
            <div className="quiz-section-header">
              <div>
                <h2>Archived Quizzes</h2>
              </div>
            </div>

            {isLoadingArchivedQuizzes ? (
              <p className="muted">Loading archived quizzes...</p>
            ) : archiveColumnsAvailable === false ? (
              <p className="muted">{ARCHIVE_MIGRATION_MESSAGE}</p>
            ) : archivedQuizzes.length === 0 ? (
              <p className="muted">No archived quizzes.</p>
            ) : (
              <div className="active-quiz-list">
                {archivedQuizzes.map((quiz) => (
                  <div className="active-quiz-row" key={quiz.id}>
                    <div>
                      <strong>
                        {quiz.course_name || 'Untitled Course'} -{' '}
                        {quiz.quiz_title || 'Untitled Quiz'}
                      </strong>
                      <div className="active-quiz-meta">
                        <span>{getArchiveSourceLabel(quiz)}</span>
                        <span>Archived: {formatDateTime(quiz.archived_at)}</span>
                        <span>{getArchiveDeleteStatus(quiz)}</span>
                      </div>
                    </div>
                    <div className="active-quiz-actions">
                      <button
                        type="button"
                        className="secondary-button compact-link-button"
                        onClick={() => restoreArchivedQuiz(quiz)}
                        disabled={restoringArchivedQuizId === quiz.id}
                      >
                        {restoringArchivedQuizId === quiz.id
                          ? 'Restoring...'
                          : 'Restore'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
