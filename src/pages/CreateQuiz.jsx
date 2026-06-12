import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeCanvas } from 'qrcode.react';
import { supabase } from '../supabaseClient';
import { getQuizResultSummary } from '../quizResultsUtils';
import {
  canLoadSavedQuizQuestions,
  getSavedQuizDraftLabel,
  isSettingsAdminUser,
} from '../userFeatureAccess';
import './Quiz.css';

function getTodayDateValue() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const localDate = new Date(now.getTime() - offset * 60 * 1000);
  return localDate.toISOString().split('T')[0];
}

function formatDate(value) {
  if (!value) return 'Not provided';

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString();
}

function formatDuration(minutes) {
  const duration = Number(minutes || 0);

  if (duration === 1) return '1 minute';
  if (duration < 60) return `${duration} minutes`;

  const hours = Math.floor(duration / 60);
  const remainingMinutes = duration % 60;
  const hourLabel = hours === 1 ? '1 hour' : `${hours} hours`;

  return remainingMinutes
    ? `${hourLabel} ${remainingMinutes} min`
    : hourLabel;
}

function formatRemainingTime(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const paddedMinutes = String(minutes).padStart(hours ? 2 : 1, '0');
  const paddedSeconds = String(remainingSeconds).padStart(2, '0');

  return hours
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

function getQuizRemainingSeconds(quiz) {
  if (!quiz?.created_at) return null;

  const startedAt = new Date(quiz.created_at).getTime();
  const durationMinutes = Number(quiz.quiz_duration_minutes || 30);

  if (
    Number.isNaN(startedAt) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return null;
  }

  const deadline = startedAt + durationMinutes * 60 * 1000;

  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

const STUDENT_AUTO_SUBMIT_WAIT_MS = 15000;

function isMissingForceSubmitColumns(error) {
  const message = String(error?.message || '').toLowerCase();

  return message.includes('force_submit') || message.includes('finalizing');
}

function isMissingSavedTemplateColumn(error) {
  return String(error?.message || '').toLowerCase().includes('is_saved_template');
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

function createChoice(text = '') {
  return {
    id: crypto.randomUUID(),
    choiceText: text,
    isCorrect: false,
  };
}

function createQuestion() {
  return {
    id: crypto.randomUUID(),
    questionText: '',
    questionType: 'single_choice',
    choices: [createChoice(), createChoice()],
  };
}

function normalizeQuestionType(questionType) {
  return questionType === 'multiple_choice' ? 'multiple_choice' : 'single_choice';
}

function mapSavedQuizQuestions(savedQuiz, { hideAnswersInEditor = false } = {}) {
  return [...(savedQuiz.quiz_questions || [])]
    .sort((left, right) => left.sort_order - right.sort_order)
    .map((question) => ({
      id: crypto.randomUUID(),
      questionText: question.question_text || '',
      questionType: normalizeQuestionType(question.question_type),
      ...(hideAnswersInEditor ? { loadedFromSavedQuiz: true } : {}),
      choices: [...(question.quiz_answer_choices || [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((choice) => ({
          id: crypto.randomUUID(),
          choiceText: choice.choice_text || '',
          isCorrect: Boolean(choice.is_correct),
        })),
    }));
}

function isReusableSavedQuiz(quiz) {
  if ('is_saved_template' in quiz) {
    return quiz.is_saved_template === true;
  }

  return quiz.is_active === false && !quiz.results_saved;
}

async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user?.id) {
    throw new Error('Please sign in again.');
  }

  return data.user;
}

async function getCurrentUserId() {
  const user = await getCurrentUser();

  return user.id;
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

async function fetchSavedQuizLibrary(params = {}) {
  const accessToken = await getCurrentAccessToken();
  const url = new URL(getSavedQuizLibraryUrl(), window.location.origin);

  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return readFunctionJson(response, 'Unable to load saved quiz library.');
}

async function updateSavedQuizInLibrary({ quizId, quiz, questions }) {
  const accessToken = await getCurrentAccessToken();

  const response = await fetch(getSavedQuizLibraryUrl(), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'update_saved_quiz',
      quizId,
      quiz,
      questions,
    }),
  });

  return readFunctionJson(response, 'Unable to update the saved quiz.');
}

async function fetchOwnSavedQuizzes(user) {
  const selectOwnSavedQuizzes = (includeSavedFlag, includeArchiveFilter) => {
    const savedQuizFields = includeSavedFlag
      ? `
        id,
        course_name,
        quiz_title,
        class_date,
        passing_score,
        is_active,
        results_saved,
        is_saved_template,
        quiz_duration_minutes,
        created_at,
        owner_user_id
      `
      : `
        id,
        course_name,
        quiz_title,
        class_date,
        passing_score,
        is_active,
        results_saved,
        quiz_duration_minutes,
        created_at,
        owner_user_id
      `;

    let query = supabase
      .from('quiz_templates')
      .select(savedQuizFields)
      .eq('owner_user_id', user.id)
      .order('created_at', { ascending: false });

    if (includeArchiveFilter) {
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
      const noArchiveFallbackResponse = await selectOwnSavedQuizzes(false, false);
      data = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  return data || [];
}

async function fetchOwnSavedQuizDetails(quizId, user) {
  const selectOwnSavedQuizDetails = (includeSavedFlag, includeArchiveFilter) => {
    let query = supabase
      .from('quiz_templates')
      .select(`
        *,
        quiz_questions (
          id,
          question_text,
          question_type,
          sort_order,
          quiz_answer_choices (
            id,
            choice_text,
            is_correct,
            sort_order
          )
        )
      `)
      .eq('id', quizId)
      .eq('owner_user_id', user.id);

    if (includeArchiveFilter) {
      query = query.is('archived_at', null);
    }

    query = includeSavedFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);

    return query;
  };

  let archiveColumnsAvailable = true;
  let { data, error } = await selectOwnSavedQuizDetails(true, true).maybeSingle();

  if (isMissingArchiveColumn(error)) {
    archiveColumnsAvailable = false;
    const fallbackResponse = await selectOwnSavedQuizDetails(
      true,
      false
    ).maybeSingle();
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectOwnSavedQuizDetails(
      false,
      archiveColumnsAvailable
    ).maybeSingle();
    data = fallbackResponse.data;
    error = fallbackResponse.error;

    if (isMissingArchiveColumn(error)) {
      const noArchiveFallbackResponse = await selectOwnSavedQuizDetails(
        false,
        false
      ).maybeSingle();
      data = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  return data || null;
}

function mergeSavedQuizLists(ownQuizzes, sharedQuizzes) {
  const savedQuizById = new Map();

  for (const quiz of [...ownQuizzes, ...sharedQuizzes]) {
    if (!quiz?.id || savedQuizById.has(quiz.id)) continue;
    savedQuizById.set(quiz.id, quiz);
  }

  return [...savedQuizById.values()];
}

export default function CreateQuiz() {
  const qrCodeRef = useRef(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [courseName, setCourseName] = useState('');
  const [quizTitle, setQuizTitle] = useState('');
  const [quizDescription, setQuizDescription] = useState('');
  const [instructorName, setInstructorName] = useState('');
  const [classDate, setClassDate] = useState(getTodayDateValue());
  const [passingScore, setPassingScore] = useState(80);
  const [quizDurationMinutes, setQuizDurationMinutes] = useState(30);
  const [questions, setQuestions] = useState([createQuestion()]);
  const [createdQuiz, setCreatedQuiz] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [draftStatusMessage, setDraftStatusMessage] = useState('');
  const [savingAction, setSavingAction] = useState('');
  const [savedDraftId, setSavedDraftId] = useState('');
  const [copied, setCopied] = useState(false);
  const [savedQuizzes, setSavedQuizzes] = useState([]);
  const [selectedSavedQuizId, setSelectedSavedQuizId] = useState('');
  const [isLoadingSavedQuizzes, setIsLoadingSavedQuizzes] = useState(false);
  const [isLoadingQuizQuestions, setIsLoadingQuizQuestions] = useState(false);
  const [activeQuizzes, setActiveQuizzes] = useState([]);
  const [isLoadingActiveQuizzes, setIsLoadingActiveQuizzes] = useState(false);
  const [liveQuizDetails, setLiveQuizDetails] = useState(null);
  const [liveAttempts, setLiveAttempts] = useState([]);
  const [liveResultsError, setLiveResultsError] = useState('');
  const [liveRemainingSeconds, setLiveRemainingSeconds] = useState(null);
  const [savingResultsQuizId, setSavingResultsQuizId] = useState('');
  const [deletingSessionId, setDeletingSessionId] = useState('');
  const [canLoadSharedSavedQuizLibrary, setCanLoadSharedSavedQuizLibrary] =
    useState(false);
  const [isSettingsAdmin, setIsSettingsAdmin] = useState(false);
  const lastScrolledQuizIdRef = useRef('');
  const autoSaveExpiredQuizIdRef = useRef('');
  const saveQuizResultsRef = useRef(null);
  const quizIdFromUrl = searchParams.get('quizId') || '';
  const editQuizIdFromUrl = searchParams.get('editQuizId') || '';
  const isEditingSavedQuiz = Boolean(editQuizIdFromUrl);

  const studentQuizLink = useMemo(() => {
    if (!createdQuiz?.id) return '';

    return `${window.location.origin}/quiz/${createdQuiz.id}`;
  }, [createdQuiz]);
  const liveQuizForResults = useMemo(
    () =>
      liveQuizDetails && createdQuiz?.id === liveQuizDetails.id
        ? { ...createdQuiz, ...liveQuizDetails }
        : createdQuiz,
    [createdQuiz, liveQuizDetails]
  );
  const liveResultSummary = useMemo(
    () => getQuizResultSummary(liveQuizForResults, liveAttempts),
    [liveAttempts, liveQuizForResults]
  );
  saveQuizResultsRef.current = saveQuizResults;

  const loadLiveSessionResults = useCallback(
    async function loadLiveSessionResults(quizId = createdQuiz?.id) {
      if (!quizId) {
        setLiveQuizDetails(null);
        setLiveAttempts([]);
        return;
      }

      setLiveResultsError('');

      try {
        const userId = await getCurrentUserId();
        const [quizResponse, attemptsResponse] = await Promise.all([
          supabase
            .from('quiz_templates')
            .select(
              `
                id,
                is_active,
                results_saved,
                quiz_questions (
                  id,
                  question_text,
                  sort_order
                )
              `
            )
            .eq('id', quizId)
            .eq('owner_user_id', userId)
            .maybeSingle(),
          supabase
            .from('quiz_attempts')
            .select(
              `
                *,
                quiz_attempt_answers (
                  id,
                  question_id,
                  selected_choice_ids,
                  is_correct
                )
              `
            )
            .eq('quiz_template_id', quizId)
            .order('submitted_at', { ascending: false }),
        ]);

        if (quizResponse.error) throw quizResponse.error;
        if (attemptsResponse.error) throw attemptsResponse.error;

        setLiveQuizDetails(quizResponse.data || null);
        setLiveAttempts(attemptsResponse.data || []);

        if (quizResponse.data) {
          setCreatedQuiz((currentQuiz) =>
            currentQuiz?.id === quizId
              ? {
                  ...currentQuiz,
                  is_active: quizResponse.data.is_active,
                  results_saved: Boolean(quizResponse.data.results_saved),
                }
              : currentQuiz
          );

          if (quizResponse.data.is_active === false) {
            setActiveQuizzes((currentQuizzes) =>
              currentQuizzes.filter((activeQuiz) => activeQuiz.id !== quizId)
            );
          }
        }
      } catch (error) {
        console.error('Load live quiz results error:', error);
        setLiveResultsError(error?.message || 'Unable to load live results.');
        setLiveAttempts([]);
      }
    },
    [createdQuiz?.id]
  );

  useEffect(() => {
    let isActive = true;

    async function loadCreatedQuiz() {
      if (!quizIdFromUrl || editQuizIdFromUrl) return;

      setErrorMessage('');
      setStatusMessage('Loading saved quiz...');
      setDraftStatusMessage('');

      let userId;

      try {
        userId = await getCurrentUserId();
      } catch (error) {
        if (!isActive) return;

        setCreatedQuiz(null);
        setStatusMessage('');
        setErrorMessage(error?.message || 'Please sign in again.');
        return;
      }

      const { data, error } = await supabase
        .from('quiz_templates')
        .select('*')
        .eq('id', quizIdFromUrl)
        .eq('owner_user_id', userId)
        .maybeSingle();

      if (!isActive) return;

      if (error || !data) {
        console.error('Load created quiz error:', error);
        setCreatedQuiz(null);
        setStatusMessage('');
        setErrorMessage('Unable to load that saved quiz.');
      } else {
        setCreatedQuiz(data);
        setCopied(false);
        setStatusMessage('');
      }
    }

    loadCreatedQuiz();

    return () => {
      isActive = false;
    };
  }, [editQuizIdFromUrl, quizIdFromUrl]);

  useEffect(() => {
    let isActive = true;

    async function loadEditingQuiz() {
      if (!editQuizIdFromUrl) return;

      setCreatedQuiz(null);
      setCopied(false);
      setSavedDraftId('');
      setErrorMessage('');
      setDraftStatusMessage('');
      setStatusMessage('Loading saved quiz for editing...');

      try {
        const { savedQuiz } = await fetchSavedQuizLibrary({
          quizId: editQuizIdFromUrl,
        });

        if (!isActive) return;

        if (!savedQuiz) {
          setStatusMessage('');
          setErrorMessage('Unable to load that saved quiz.');
          return;
        }

        const loadedQuestions = mapSavedQuizQuestions(savedQuiz);

        setCourseName(savedQuiz.course_name || '');
        setQuizTitle(savedQuiz.quiz_title || '');
        setQuizDescription(savedQuiz.quiz_description || '');
        setInstructorName(savedQuiz.instructor_name || '');
        setClassDate(savedQuiz.class_date || getTodayDateValue());
        setPassingScore(savedQuiz.passing_score ?? 80);
        setQuizDurationMinutes(savedQuiz.quiz_duration_minutes || 30);
        setQuestions(loadedQuestions.length ? loadedQuestions : [createQuestion()]);
        setStatusMessage('Saved quiz loaded for editing.');
      } catch (error) {
        if (!isActive) return;

        console.error('Load edit quiz error:', error);
        setStatusMessage('');
        setErrorMessage(error?.message || 'Unable to load that saved quiz.');
      }
    }

    loadEditingQuiz();

    return () => {
      isActive = false;
    };
  }, [editQuizIdFromUrl]);

  useEffect(() => {
    loadActiveQuizzes();
    if (!isEditingSavedQuiz) {
      loadSavedQuizzes();
    }
  }, [isEditingSavedQuiz]);

  useEffect(() => {
    if (!createdQuiz?.id) {
      lastScrolledQuizIdRef.current = '';
      return;
    }

    if (lastScrolledQuizIdRef.current === createdQuiz.id) return;

    lastScrolledQuizIdRef.current = createdQuiz.id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [createdQuiz?.id]);

  useEffect(() => {
    if (!createdQuiz?.id || createdQuiz.is_active === false) {
      return undefined;
    }

    async function updateLiveCountdown() {
      const nextRemainingSeconds = getQuizRemainingSeconds(createdQuiz);
      setLiveRemainingSeconds(nextRemainingSeconds);

      if (
        nextRemainingSeconds === 0 &&
        autoSaveExpiredQuizIdRef.current !== createdQuiz.id
      ) {
        autoSaveExpiredQuizIdRef.current = createdQuiz.id;
        await saveQuizResultsRef.current?.(createdQuiz);
      }
    }

    const countdownInitialLoadId = window.setTimeout(updateLiveCountdown, 0);
    const countdownIntervalId = window.setInterval(updateLiveCountdown, 1000);
    const initialLoadId = window.setTimeout(() => {
      loadLiveSessionResults(createdQuiz.id);
    }, 0);

    const intervalId = window.setInterval(() => {
      loadLiveSessionResults(createdQuiz.id);
    }, 3000);

    return () => {
      window.clearTimeout(countdownInitialLoadId);
      window.clearInterval(countdownIntervalId);
      window.clearTimeout(initialLoadId);
      window.clearInterval(intervalId);
    };
  }, [
    createdQuiz,
    createdQuiz?.id,
    createdQuiz?.is_active,
    loadLiveSessionResults,
  ]);

  function updateQuestion(questionId, updates) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) =>
        question.id === questionId ? { ...question, ...updates } : question
      )
    );
  }

  function updateQuestionType(questionId, questionType) {
    const nextType = normalizeQuestionType(questionType);

    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId) return question;

        if (nextType === 'multiple_choice') {
          return { ...question, questionType: nextType };
        }

        let hasCorrectChoice = false;
        const choices = question.choices.map((choice) => {
          if (choice.isCorrect && !hasCorrectChoice) {
            hasCorrectChoice = true;
            return choice;
          }

          return { ...choice, isCorrect: false };
        });

        return { ...question, questionType: nextType, choices };
      })
    );
  }

  function updateChoice(questionId, choiceId, updates) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId) return question;

        const choices = question.choices.map((choice) =>
          choice.id === choiceId ? { ...choice, ...updates } : choice
        );

        return { ...question, choices };
      })
    );
  }

  function toggleCorrectChoice(questionId, choiceId) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId) return question;

        const choices = question.choices.map((choice) => {
          if (question.questionType === 'single_choice') {
            return { ...choice, isCorrect: choice.id === choiceId };
          }

          if (choice.id === choiceId) {
            return { ...choice, isCorrect: !choice.isCorrect };
          }

          return choice;
        });

        return { ...question, choices };
      })
    );
  }

  function addQuestion() {
    setQuestions((currentQuestions) => [...currentQuestions, createQuestion()]);
  }

  function removeQuestion(questionId) {
    setQuestions((currentQuestions) =>
      currentQuestions.length === 1
        ? currentQuestions
        : currentQuestions.filter((question) => question.id !== questionId)
    );
  }

  function addChoice(questionId) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) =>
        question.id === questionId
          ? { ...question, choices: [...question.choices, createChoice()] }
          : question
      )
    );
  }

  function removeChoice(questionId, choiceId) {
    setQuestions((currentQuestions) =>
      currentQuestions.map((question) => {
        if (question.id !== questionId || question.choices.length <= 2) {
          return question;
        }

        return {
          ...question,
          choices: question.choices.filter((choice) => choice.id !== choiceId),
        };
      })
    );
  }

  function validateQuiz() {
    if (!courseName.trim()) return 'Course name is required.';
    if (!quizTitle.trim()) return 'Quiz title is required.';
    if (!instructorName.trim()) return 'Instructor name is required.';
    if (!Number.isFinite(Number(passingScore))) return 'Passing score is required.';
    if (Number(passingScore) < 0 || Number(passingScore) > 100) {
      return 'Passing score must be between 0 and 100.';
    }

    if (
      !Number.isFinite(Number(quizDurationMinutes)) ||
      Number(quizDurationMinutes) < 1 ||
      Number(quizDurationMinutes) > 500
    ) {
      return 'Countdown time must be between 1 and 500 minutes.';
    }

    for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
      const question = questions[questionIndex];
      const questionNumber = questionIndex + 1;

      if (!question.questionText.trim()) {
        return `Question ${questionNumber} needs question text.`;
      }

      if (question.choices.length < 2) {
        return `Question ${questionNumber} needs at least 2 answer choices.`;
      }

      for (let choiceIndex = 0; choiceIndex < question.choices.length; choiceIndex += 1) {
        if (!question.choices[choiceIndex].choiceText.trim()) {
          return `Question ${questionNumber} has an empty answer choice.`;
        }
      }

      const correctCount = question.choices.filter((choice) => choice.isCorrect).length;

      if (correctCount === 0) {
        return `Question ${questionNumber} needs at least one correct answer.`;
      }

      if (question.questionType === 'single_choice' && correctCount !== 1) {
        return `Question ${questionNumber} can only have one correct answer.`;
      }
    }

    return '';
  }

  async function loadSavedQuizzes() {
    setErrorMessage('');
    setStatusMessage('Loading saved quizzes...');
    setDraftStatusMessage('');
    setIsLoadingSavedQuizzes(true);

    try {
      const user = await getCurrentUser();
      const userCanLoadSharedSavedQuizLibrary = canLoadSavedQuizQuestions(user);

      setIsSettingsAdmin(isSettingsAdminUser(user));
      setCanLoadSharedSavedQuizLibrary(userCanLoadSharedSavedQuizLibrary);

      const ownQuizzes = await fetchOwnSavedQuizzes(user);
      let sharedQuizzes = [];

      if (userCanLoadSharedSavedQuizLibrary) {
        await syncSavedQuizLibrary();
        const libraryData = await fetchSavedQuizLibrary();
        sharedQuizzes = (libraryData.savedQuizzes || []).filter(isReusableSavedQuiz);
      }

      const quizzes = mergeSavedQuizLists(ownQuizzes, sharedQuizzes);

      setSavedQuizzes(quizzes);
      setSelectedSavedQuizId((currentId) =>
        quizzes.some((quiz) => quiz.id === currentId)
          ? currentId
          : quizzes[0]?.id || ''
      );
      setStatusMessage(quizzes.length ? '' : 'No saved quizzes found yet.');
    } catch (error) {
      setSavedQuizzes([]);
      setSelectedSavedQuizId('');
      setStatusMessage('');
      setErrorMessage(error?.message || 'Please sign in again.');
      setIsLoadingSavedQuizzes(false);
      return;
    }

    setIsLoadingSavedQuizzes(false);
  }

  async function loadSelectedQuizQuestions() {
    if (!selectedSavedQuizId) {
      setErrorMessage('Choose a saved quiz to load.');
      return;
    }

    setErrorMessage('');
    setStatusMessage('Loading quiz questions...');
    setDraftStatusMessage('');
    setIsLoadingQuizQuestions(true);

    try {
      const user = await getCurrentUser();
      const userCanLoadSharedSavedQuizLibrary =
        canLoadSharedSavedQuizLibrary || canLoadSavedQuizQuestions(user);
      let data = await fetchOwnSavedQuizDetails(selectedSavedQuizId, user);

      if (!data && userCanLoadSharedSavedQuizLibrary) {
        const libraryData = await fetchSavedQuizLibrary({
          quizId: selectedSavedQuizId,
        });

        data = libraryData.savedQuiz || null;
      }

      if (!data) {
        setStatusMessage('');
        setErrorMessage('Unable to load that saved quiz.');
        setIsLoadingQuizQuestions(false);
        return;
      }

      const loadedQuestions = mapSavedQuizQuestions(data, {
        hideAnswersInEditor: true,
      });

      setCourseName(data.course_name || '');
      setQuizTitle(data.quiz_title ? `${data.quiz_title} Copy` : '');
      setQuizDescription(data.quiz_description || '');
      setInstructorName(data.instructor_name || '');
      setClassDate(data.class_date || getTodayDateValue());
      setPassingScore(data.passing_score ?? 80);
      setQuizDurationMinutes(data.quiz_duration_minutes || 30);
      setQuestions(loadedQuestions.length ? loadedQuestions : [createQuestion()]);
      setCreatedQuiz(null);
      setSavedDraftId('');
      setCopied(false);
      setSearchParams({});
      setStatusMessage('Saved quiz questions loaded. Review them, then save to create a new quiz link.');
    } catch (error) {
      console.error('Load selected quiz questions error:', error);
      setStatusMessage('');
      setErrorMessage(error?.message || 'Unable to load that saved quiz.');
    }

    setIsLoadingQuizQuestions(false);
  }

  function clearLoadedQuizQuestions() {
    const confirmed = window.confirm(
      'Clear the loaded quiz questions and start a blank quiz draft? This will not delete any saved quizzes.'
    );

    if (!confirmed) return;

    setCourseName('');
    setQuizTitle('');
    setQuizDescription('');
    setInstructorName('');
    setClassDate(getTodayDateValue());
    setPassingScore(80);
    setQuizDurationMinutes(30);
    setQuestions([createQuestion()]);
    setCreatedQuiz(null);
    setSavedDraftId('');
    setCopied(false);
    setSearchParams({});
    setErrorMessage('');
    setDraftStatusMessage('');
    setStatusMessage('Loaded questions cleared. You can start a new quiz draft.');
  }

  async function saveQuiz({ publish }) {
    setCreatedQuiz(null);
    setCopied(false);
    setStatusMessage('');
    setDraftStatusMessage('');

    const validationMessage = validateQuiz();

    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setErrorMessage('');
    setSavingAction(publish ? 'publish' : 'draft');

    try {
      const user = await getCurrentUser();
      const userId = user.id;

      const quizPayload = {
        course_name: courseName.trim(),
        quiz_title: quizTitle.trim(),
        quiz_description: quizDescription.trim() || null,
        instructor_name: instructorName.trim() || null,
        class_date: classDate || null,
        passing_score: Number(passingScore),
        quiz_duration_minutes: Number(quizDurationMinutes),
        is_active: publish,
        is_saved_template: !publish,
        owner_user_id: userId,
      };

      let quizTemplate;
      const savePayloadWithoutTemplateFlag = (payload) => {
        const nextPayload = { ...payload };
        delete nextPayload.is_saved_template;
        return nextPayload;
      };
      const shouldUpdateDraft = !publish && savedDraftId;

      if (shouldUpdateDraft) {
        let { data: updatedQuizTemplate, error: quizError } = await supabase
          .from('quiz_templates')
          .update(quizPayload)
          .eq('id', savedDraftId)
          .eq('owner_user_id', userId)
          .eq('is_saved_template', true)
          .select()
          .single();

        if (isMissingSavedTemplateColumn(quizError)) {
          const fallbackResponse = await supabase
            .from('quiz_templates')
            .update(savePayloadWithoutTemplateFlag(quizPayload))
            .eq('id', savedDraftId)
            .eq('owner_user_id', userId)
            .eq('is_active', false)
            .eq('results_saved', false)
            .select()
            .single();

          updatedQuizTemplate = fallbackResponse.data;
          quizError = fallbackResponse.error;
        }

        if (quizError) throw quizError;

        // DATA SAFETY: hard-deletes existing draft questions before replacing
        // them. Do not apply this pattern to student attempts/results.
        const { error: deleteQuestionsError } = await supabase
          .from('quiz_questions')
          .delete()
          .eq('quiz_template_id', updatedQuizTemplate.id);

        if (deleteQuestionsError) throw deleteQuestionsError;

        quizTemplate = updatedQuizTemplate;
      } else {
        let { data: insertedQuizTemplate, error: quizError } = await supabase
          .from('quiz_templates')
          .insert(quizPayload)
          .select()
          .single();

        if (isMissingSavedTemplateColumn(quizError)) {
          const fallbackResponse = await supabase
            .from('quiz_templates')
            .insert(savePayloadWithoutTemplateFlag(quizPayload))
            .select()
            .single();

          insertedQuizTemplate = fallbackResponse.data;
          quizError = fallbackResponse.error;
        }

        if (quizError) throw quizError;

        quizTemplate = insertedQuizTemplate;
      }

      for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
        const question = questions[questionIndex];
        const { data: savedQuestion, error: questionError } = await supabase
          .from('quiz_questions')
          .insert({
            quiz_template_id: quizTemplate.id,
            question_text: question.questionText.trim(),
            question_type: normalizeQuestionType(question.questionType),
            sort_order: questionIndex,
          })
          .select()
          .single();

        if (questionError) throw questionError;

        const choicesToInsert = question.choices.map((choice, choiceIndex) => ({
          question_id: savedQuestion.id,
          choice_text: choice.choiceText.trim(),
          is_correct: choice.isCorrect,
          sort_order: choiceIndex,
        }));

        const { error: choicesError } = await supabase
          .from('quiz_answer_choices')
          .insert(choicesToInsert);

        if (choicesError) throw choicesError;
      }

      if (publish) {
        setCreatedQuiz(quizTemplate);
        setSearchParams({ quizId: quizTemplate.id });
        setStatusMessage('Quiz published successfully.');
        await loadActiveQuizzes();
      } else {
        setSavedDraftId(quizTemplate.id);
        setSearchParams({});
        setDraftStatusMessage('Draft saved. Students will not see it until you publish.');
      }
    } catch (error) {
      console.error('Create quiz error:', error);
      setErrorMessage(error?.message || 'Unable to save the quiz.');
    } finally {
      setSavingAction('');
    }
  }

  async function updateSavedQuiz() {
    if (!editQuizIdFromUrl) return;

    setCreatedQuiz(null);
    setCopied(false);
    setStatusMessage('');
    setDraftStatusMessage('');

    const validationMessage = validateQuiz();

    if (validationMessage) {
      setErrorMessage(validationMessage);
      return;
    }

    setErrorMessage('');
    setSavingAction('update');

    try {
      const user = await getCurrentUser();
      const userId = user.id;

      const quizPayload = {
        course_name: courseName.trim(),
        quiz_title: quizTitle.trim(),
        quiz_description: quizDescription.trim() || null,
        instructor_name: instructorName.trim() || null,
        class_date: classDate || null,
        passing_score: Number(passingScore),
        quiz_duration_minutes: Number(quizDurationMinutes),
        is_saved_template: true,
      };

      if (isSettingsAdminUser(user)) {
        await updateSavedQuizInLibrary({
          quizId: editQuizIdFromUrl,
          quiz: quizPayload,
          questions: questions.map((question) => ({
            questionText: question.questionText,
            questionType: question.questionType,
            choices: question.choices.map((choice) => ({
              choiceText: choice.choiceText,
              isCorrect: choice.isCorrect,
            })),
          })),
        });

        setStatusMessage('Saved quiz updated.');
        return;
      }

      let { data: updatedQuizTemplate, error: quizError } = await supabase
        .from('quiz_templates')
        .update(quizPayload)
        .eq('id', editQuizIdFromUrl)
        .eq('owner_user_id', userId)
        .eq('is_saved_template', true)
        .select()
        .maybeSingle();

      if (isMissingSavedTemplateColumn(quizError)) {
        const fallbackPayload = { ...quizPayload };
        delete fallbackPayload.is_saved_template;
        const fallbackResponse = await supabase
          .from('quiz_templates')
          .update(fallbackPayload)
          .eq('id', editQuizIdFromUrl)
          .eq('owner_user_id', userId)
          .eq('is_active', false)
          .eq('results_saved', false)
          .select()
          .maybeSingle();

        updatedQuizTemplate = fallbackResponse.data;
        quizError = fallbackResponse.error;
      }

      if (quizError) throw quizError;

      if (!updatedQuizTemplate) {
        throw new Error(
          'You do not have permission to edit this saved quiz, or it no longer exists.'
        );
      }

      // DATA SAFETY: hard-deletes saved quiz questions before replacing them.
      // Do not apply this pattern to student attempts/results.
      const { error: deleteQuestionsError } = await supabase
        .from('quiz_questions')
        .delete()
        .eq('quiz_template_id', updatedQuizTemplate.id);

      if (deleteQuestionsError) throw deleteQuestionsError;

      for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
        const question = questions[questionIndex];
        const { data: savedQuestion, error: questionError } = await supabase
          .from('quiz_questions')
          .insert({
            quiz_template_id: updatedQuizTemplate.id,
            question_text: question.questionText.trim(),
            question_type: normalizeQuestionType(question.questionType),
            sort_order: questionIndex,
          })
          .select()
          .single();

        if (questionError) throw questionError;

        const choicesToInsert = question.choices.map((choice, choiceIndex) => ({
          question_id: savedQuestion.id,
          choice_text: choice.choiceText.trim(),
          is_correct: choice.isCorrect,
          sort_order: choiceIndex,
        }));

        const { error: choicesError } = await supabase
          .from('quiz_answer_choices')
          .insert(choicesToInsert);

        if (choicesError) throw choicesError;
      }

      setStatusMessage('Saved quiz updated.');
    } catch (error) {
      console.error('Update saved quiz error:', error);
      setErrorMessage(error?.message || 'Unable to update the saved quiz.');
    } finally {
      setSavingAction('');
    }
  }

  async function loadActiveQuizzes() {
    setIsLoadingActiveQuizzes(true);

    try {
      const userId = await getCurrentUserId();
      const selectActiveQuizzes = (includeSavedFlag) =>
        supabase
          .from('quiz_templates')
          .select(
            includeSavedFlag
              ? 'id, course_name, quiz_title, class_date, passing_score, quiz_duration_minutes, results_saved, created_at'
              : 'id, course_name, quiz_title, class_date, passing_score, quiz_duration_minutes, created_at'
          )
          .eq('owner_user_id', userId)
          .eq('is_active', true)
          .order('created_at', { ascending: false });

      let { data, error } = await selectActiveQuizzes(true);

      if (error?.message?.includes('results_saved')) {
        const fallbackResponse = await selectActiveQuizzes(false);
        data = fallbackResponse.data;
        error = fallbackResponse.error;
      }

      if (error) throw error;

      setActiveQuizzes(
        (data || []).map((quiz) => ({
          ...quiz,
          results_saved: Boolean(quiz.results_saved),
        }))
      );
    } catch (error) {
      console.error('Load active quizzes error:', error);
    } finally {
      setIsLoadingActiveQuizzes(false);
    }
  }

  async function saveQuizResults(quiz) {
    if (quiz.results_saved && quiz.is_active === false) {
      setStatusMessage('Results already saved.');
      return;
    }

    setSavingResultsQuizId(quiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const { error: forceSubmitError } = await supabase
        .from('quiz_templates')
        .update({ force_submit: true, finalizing: true })
        .eq('id', quiz.id);

      const useResultsSavedFallback = isMissingForceSubmitColumns(forceSubmitError);

      if (forceSubmitError && !useResultsSavedFallback) throw forceSubmitError;

      if (useResultsSavedFallback) {
        let { error: fallbackSignalError } = await supabase
          .from('quiz_templates')
          .update({ results_saved: true, is_saved_template: false })
          .eq('id', quiz.id);

        if (isMissingSavedTemplateColumn(fallbackSignalError)) {
          const fallbackResponse = await supabase
            .from('quiz_templates')
            .update({ results_saved: true })
            .eq('id', quiz.id);

          fallbackSignalError = fallbackResponse.error;
        }

        if (fallbackSignalError) throw fallbackSignalError;
      }

      if (!useResultsSavedFallback && createdQuiz?.id === quiz.id) {
        setCreatedQuiz((currentQuiz) =>
          currentQuiz
            ? { ...currentQuiz, force_submit: true, finalizing: true }
            : currentQuiz
        );
      }

      await delay(STUDENT_AUTO_SUBMIT_WAIT_MS);
      await loadLiveSessionResults(quiz.id);

      const finalizePayload = useResultsSavedFallback
        ? {
            results_saved: true,
            is_active: false,
            is_saved_template: false,
          }
        : {
            results_saved: true,
            is_active: false,
            is_saved_template: false,
            finalizing: false,
          };
      let { error } = await supabase
        .from('quiz_templates')
        .update(finalizePayload)
        .eq('id', quiz.id);

      if (isMissingSavedTemplateColumn(error)) {
        const fallbackFinalizePayload = { ...finalizePayload };
        delete fallbackFinalizePayload.is_saved_template;
        const fallbackResponse = await supabase
          .from('quiz_templates')
          .update(fallbackFinalizePayload)
          .eq('id', quiz.id);

        error = fallbackResponse.error;
      }

      if (error) throw error;

      setActiveQuizzes((currentQuizzes) =>
        currentQuizzes.filter((activeQuiz) => activeQuiz.id !== quiz.id)
      );

      if (createdQuiz?.id === quiz.id) {
        setCreatedQuiz((currentQuiz) =>
          currentQuiz
            ? {
                ...currentQuiz,
                results_saved: true,
                is_active: false,
                is_saved_template: false,
                finalizing: false,
              }
            : currentQuiz
        );
      }

      setStatusMessage('Quiz results saved and session ended.');
    } catch (error) {
      console.error('Save quiz results error:', error);
      setErrorMessage(
        error?.message?.includes('results_saved')
          ? 'Unable to save quiz results. Run the updated Supabase quiz table SQL first.'
          : error?.message ||
              'Unable to save quiz results. Completed submitted attempts were not finalized.'
      );
    } finally {
      setSavingResultsQuizId('');
    }
  }

  function openActiveQuiz(quiz) {
    setCreatedQuiz(quiz);
    setCopied(false);
    setErrorMessage('');
    setDraftStatusMessage('');
    setStatusMessage('');
    setSearchParams({ quizId: quiz.id });
  }

  function refreshCreateQuizPage() {
    loadActiveQuizzes();

    if (createdQuiz?.id) {
      loadLiveSessionResults(createdQuiz.id);
    }
  }

  async function deleteCurrentSession() {
    // DATA SAFETY: hard-deletes a quiz session/template. Prefer soft-delete or
    // archive behavior before expanding this to student attempts/results.
    if (!createdQuiz?.id) return;

    const confirmed = window.confirm(
      `Delete ${createdQuiz.course_name || 'this course'} - ${
        createdQuiz.quiz_title || 'this quiz'
      }? This will permanently delete this quiz session and return you to the Instructor Dashboard.`
    );

    if (!confirmed) return;

    setDeletingSessionId(createdQuiz.id);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const userId = await getCurrentUserId();
      let { error } = await supabase
        .from('quiz_templates')
        .delete()
        .eq('id', createdQuiz.id)
        .eq('owner_user_id', userId)
        .eq('is_saved_template', false);

      if (isMissingSavedTemplateColumn(error)) {
        const fallbackResponse = await supabase
          .from('quiz_templates')
          .delete()
          .eq('id', createdQuiz.id)
          .eq('owner_user_id', userId)
          .or('is_active.eq.true,results_saved.eq.true');

        error = fallbackResponse.error;
      }

      if (error) throw error;

      navigate('/instructor-7392', { replace: true });
    } catch (error) {
      console.error('Delete quiz session error:', error);
      setErrorMessage(error?.message || 'Unable to delete this quiz session.');
    } finally {
      setDeletingSessionId('');
    }
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (isEditingSavedQuiz) {
      updateSavedQuiz();
      return;
    }

    saveQuiz({ publish: true });
  }

  async function handleCopyLink() {
    if (!studentQuizLink) return;

    try {
      await navigator.clipboard.writeText(studentQuizLink);
      setCopied(true);
    } catch (error) {
      console.error('Copy quiz link error:', error);
      setErrorMessage('The quiz was created, but the link could not be copied.');
    }
  }

  function handleDownloadQrCode() {
    const canvas = qrCodeRef.current?.querySelector('canvas');

    if (!canvas || !createdQuiz?.id) return;

    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `student-quiz-${createdQuiz.id}.png`;
    link.click();
  }

  return (
    <section className="quiz-page">
      <div className="quiz-card">
        <div className="quiz-header">
          <h1>
            {createdQuiz
              ? 'Live Quiz Session'
              : isEditingSavedQuiz
                ? 'Edit Saved Quiz'
                : 'Create Quiz'}
          </h1>
          <p>
            {createdQuiz
              ? 'Share this quiz with students and monitor results in real time.'
              : isEditingSavedQuiz
              ? 'Edit saved quiz questions, answer choices, and correct answers.'
              : 'Load a quiz or build a quiz, mark the correct answers, and generate a student link with a QR code.'}
          </p>
        </div>

        <div className="quiz-nav-row quizzes-nav-row">
          <div className="quiz-nav-link-group">
            {!createdQuiz && (
              <Link to="/instructor-7392" className="secondary-link-button">
                Instructor Dashboard
              </Link>
            )}
            {!createdQuiz && isEditingSavedQuiz && (
              <Link to="/quizzes-7392" className="secondary-link-button">
                Back to Quizzes
              </Link>
            )}
          </div>
          {!isEditingSavedQuiz && (
            <div className="quiz-nav-link-group">
              <button
                type="button"
                className="secondary-button"
                onClick={refreshCreateQuizPage}
                disabled={isLoadingActiveQuizzes}
              >
                {isLoadingActiveQuizzes ? 'Refreshing...' : 'Refresh'}
              </button>
              {createdQuiz && !createdQuiz.results_saved && (
                <button
                  type="button"
                  className="quiz-danger-button"
                  onClick={deleteCurrentSession}
                  disabled={deletingSessionId === createdQuiz.id}
                >
                  {deletingSessionId === createdQuiz.id
                    ? 'Deleting...'
                    : 'Delete Session'}
                </button>
              )}
            </div>
          )}
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

        {!createdQuiz && !isEditingSavedQuiz && activeQuizzes.length > 0 && (
          <section className="active-quiz-panel">
            <div className="quiz-section-header">
              <div>
                <h2>Active Quiz Sessions</h2>
                <p>Published quizzes students can open right now.</p>
              </div>
            </div>

            <div className="active-quiz-list">
              {activeQuizzes.map((quiz) => (
                <div
                  className="active-quiz-row"
                  key={quiz.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openActiveQuiz(quiz)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openActiveQuiz(quiz);
                    }
                  }}
                >
                  <div>
                    <strong>
                      {quiz.course_name || 'Untitled Course'} -{' '}
                      {quiz.quiz_title || 'Untitled Quiz'}
                    </strong>
                    <div className="active-quiz-meta">
                      <span>{formatDate(quiz.class_date)}</span>
                      <span>Passing: {quiz.passing_score}%</span>
                      <span>Time: {formatDuration(quiz.quiz_duration_minutes || 30)}</span>
                    </div>
                  </div>
                  <div className="active-quiz-actions">
                    <button
                      type="button"
                      className="secondary-button quiz-save-results-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        saveQuizResults(quiz);
                      }}
                      disabled={savingResultsQuizId === quiz.id}
                    >
                      {savingResultsQuizId === quiz.id
                        ? 'Saving Results...'
                        : 'Save Quiz Results'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {!createdQuiz ? (
          <form className="quiz-form" onSubmit={handleSubmit}>
            {!isEditingSavedQuiz && (
              <section className="load-quiz-panel">
              <div>
                <h2>Load Saved Quiz Questions</h2>
              </div>

              <div className="load-quiz-row">
                <select
                  value={selectedSavedQuizId}
                  onChange={(event) => setSelectedSavedQuizId(event.target.value)}
                  disabled={isLoadingSavedQuizzes || savedQuizzes.length === 0}
                  aria-label="Saved quizzes"
                >
                  {isLoadingSavedQuizzes ? (
                    <option value="">Loading saved quizzes...</option>
                  ) : savedQuizzes.length === 0 ? (
                    <option value="">No saved quizzes found</option>
                  ) : (
                    savedQuizzes.map((quiz) => (
                      <option key={quiz.id} value={quiz.id}>
                        {quiz.course_name} - {quiz.quiz_title}
                        {quiz.is_active ? '' : ` (${getSavedQuizDraftLabel(quiz)})`}
                      </option>
                    ))
                  )}
                </select>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={loadSelectedQuizQuestions}
                  disabled={!selectedSavedQuizId || isLoadingQuizQuestions}
                >
                  {isLoadingQuizQuestions ? 'Loading Questions...' : 'Load Questions'}
                </button>

                <button
                  type="button"
                  className="secondary-button clear-loaded-quiz-button"
                  onClick={clearLoadedQuizQuestions}
                >
                  Clear Loaded Questions
                </button>
              </div>
              </section>
            )}

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="courseName">Course Name *</label>
                <input
                  id="courseName"
                  type="text"
                  value={courseName}
                  onChange={(event) => setCourseName(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="quizTitle">Quiz Title *</label>
                <input
                  id="quizTitle"
                  type="text"
                  value={quizTitle}
                  onChange={(event) => setQuizTitle(event.target.value)}
                />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="quizDescription">Quiz Description</label>
              <textarea
                id="quizDescription"
                value={quizDescription}
                onChange={(event) => setQuizDescription(event.target.value)}
                rows={4}
              />
            </div>

            <div className="form-row four-column-row">
              <div className="form-group">
                <label htmlFor="instructorName">Instructor Name *</label>
                <input
                  id="instructorName"
                  type="text"
                  value={instructorName}
                  onChange={(event) => setInstructorName(event.target.value)}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="classDate">Class Date</label>
                <input
                  id="classDate"
                  type="date"
                  value={classDate}
                  onChange={(event) => setClassDate(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="passingScore">Passing Score *</label>
                <input
                  id="passingScore"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={passingScore}
                  onChange={(event) => setPassingScore(event.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="quizDurationMinutes">Countdown Time *</label>
                <input
                  id="quizDurationMinutes"
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={quizDurationMinutes}
                  onChange={(event) => setQuizDurationMinutes(event.target.value)}
                />
              </div>
            </div>

            <div className="quiz-builder-section">
              <div className="quiz-section-header">
                <h2>Questions</h2>
                <button type="button" className="secondary-button" onClick={addQuestion}>
                  Add Question
                </button>
              </div>

              <div className="question-list">
                {questions.map((question, questionIndex) => {
                  const hideAnswerChoiceEditor = Boolean(question.loadedFromSavedQuiz);

                  return (
                    <section className="question-card" key={question.id}>
                      <div className="question-card-header">
                        <h3>Question {questionIndex + 1}</h3>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => removeQuestion(question.id)}
                          disabled={questions.length === 1}
                        >
                          Remove
                        </button>
                      </div>

                      <div className="form-group">
                        <label htmlFor={`question-${question.id}`}>Question Text *</label>
                        <textarea
                          id={`question-${question.id}`}
                          value={question.questionText}
                          onChange={(event) =>
                            updateQuestion(question.id, {
                              questionText: event.target.value,
                            })
                          }
                          rows={3}
                        />
                      </div>

                      {!hideAnswerChoiceEditor && (
                        <>
                          <fieldset className="choice-fieldset">
                            <legend>Question Type</legend>
                            <label className="inline-choice">
                              <input
                                type="radio"
                                name={`question-type-${question.id}`}
                                value="single_choice"
                                checked={question.questionType === 'single_choice'}
                                onChange={(event) =>
                                  updateQuestionType(question.id, event.target.value)
                                }
                              />
                              Single answer
                            </label>
                            <label className="inline-choice">
                              <input
                                type="radio"
                                name={`question-type-${question.id}`}
                                value="multiple_choice"
                                checked={question.questionType === 'multiple_choice'}
                                onChange={(event) =>
                                  updateQuestionType(question.id, event.target.value)
                                }
                              />
                              Multiple answers
                            </label>
                          </fieldset>

                          <div className="answer-choice-list">
                            {question.choices.map((choice, choiceIndex) => (
                              <div className="answer-choice-row" key={choice.id}>
                                <label className="correct-choice-control">
                                  <input
                                    type={
                                      question.questionType === 'single_choice'
                                        ? 'radio'
                                        : 'checkbox'
                                    }
                                    name={`correct-choice-${question.id}`}
                                    checked={choice.isCorrect}
                                    onChange={() =>
                                      toggleCorrectChoice(question.id, choice.id)
                                    }
                                  />
                                  Correct
                                </label>

                                <input
                                  type="text"
                                  value={choice.choiceText}
                                  onChange={(event) =>
                                    updateChoice(question.id, choice.id, {
                                      choiceText: event.target.value,
                                    })
                                  }
                                  placeholder={`Answer choice ${choiceIndex + 1}`}
                                />

                                <button
                                  type="button"
                                  className="secondary-button compact-button"
                                  onClick={() => removeChoice(question.id, choice.id)}
                                  disabled={question.choices.length <= 2}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>

                          <button
                            type="button"
                            className="secondary-button compact-button"
                            onClick={() => addChoice(question.id)}
                          >
                            Add Answer Choice
                          </button>
                        </>
                      )}
                    </section>
                  );
                })}
              </div>
            </div>

            <div className="quiz-save-actions">
              {isEditingSavedQuiz ? (
                <button
                  className="primary-button"
                  type="submit"
                  disabled={Boolean(savingAction)}
                >
                  {savingAction === 'update' ? 'Updating...' : 'Update Quiz'}
                </button>
              ) : (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => saveQuiz({ publish: false })}
                    disabled={Boolean(savingAction)}
                  >
                    {savingAction === 'draft'
                      ? isSettingsAdmin
                        ? 'Saving Draft...'
                        : 'Saving Copy...'
                      : isSettingsAdmin
                        ? 'Save as Draft'
                        : 'Save as Copy'}
                  </button>

                  <button
                    className="primary-button"
                    type="submit"
                    disabled={Boolean(savingAction)}
                  >
                    {savingAction === 'publish' ? 'Publishing...' : 'Publish'}
                  </button>
                </>
              )}
            </div>

            {draftStatusMessage && (
              <div className="alert alert-success quiz-bottom-status" role="status">
                {draftStatusMessage}
              </div>
            )}
          </form>
        ) : (
          <section className="quiz-created live-session-layout">
            <section className="live-session-card live-status-card">
              <div className="live-status-heading">
                <span
                  className={
                    createdQuiz.is_active === false
                      ? 'live-status-pill is-ended'
                      : 'live-status-pill'
                  }
                >
                  {createdQuiz.is_active === false ? 'Ended' : 'Live'}
                </span>
                <div>
                  <h2>{createdQuiz.course_name || 'Untitled Course'}</h2>
                  <p>{createdQuiz.quiz_title || 'Untitled Quiz'}</p>
                </div>
              </div>

              <dl className="live-session-detail-grid">
                <div>
                  <dt>Class Date</dt>
                  <dd>{formatDate(createdQuiz.class_date)}</dd>
                </div>
                <div>
                  <dt>Passing Score</dt>
                  <dd>{createdQuiz.passing_score}%</dd>
                </div>
                <div>
                  <dt>Time Limit</dt>
                  <dd>{formatDuration(createdQuiz.quiz_duration_minutes || 30)}</dd>
                </div>
                <div className={liveRemainingSeconds === 0 ? 'is-expired' : ''}>
                  <dt>Countdown</dt>
                  <dd>
                    {createdQuiz.is_active === false
                      ? 'Ended'
                      : liveRemainingSeconds === null
                        ? 'Calculating...'
                        : formatRemainingTime(liveRemainingSeconds)}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="live-session-card">
              <div className="live-card-header">
                <h2>Student Access</h2>
              </div>

              {createdQuiz.is_active === false ? (
                <div className="alert alert-error" role="status">
                  This quiz session has ended. The student link and QR code are no longer accessible.
                </div>
              ) : (
                <div className="student-access-grid">
                  <div className="student-link-box">
                    <label htmlFor="studentQuizLink">Student Quiz URL</label>
                    <div className="copy-row">
                      <input
                        id="studentQuizLink"
                        type="text"
                        value={studentQuizLink}
                        readOnly
                      />
                      <button type="button" onClick={handleCopyLink}>
                        {copied ? 'Copied' : 'Copy Link'}
                      </button>
                    </div>
                  </div>

                  <div className="student-access-qr">
                    <div className="qr-code-image" ref={qrCodeRef}>
                      <QRCodeCanvas
                        value={studentQuizLink}
                        size={220}
                        level="M"
                        marginSize={4}
                      />
                    </div>
                    <div className="student-access-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={handleDownloadQrCode}
                      >
                        Download QR Code
                      </button>
                      <a
                        className="primary-button link-button"
                        href={studentQuizLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open Student Quiz
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="live-session-card">
              <div className="live-card-header">
                <h2>Live Results</h2>
              </div>

              {liveResultsError && (
                <div className="alert alert-error" role="alert">
                  {liveResultsError}
                </div>
              )}

              {liveResultSummary.totalAttempts === 0 ? (
                <p className="muted live-results-empty">
                  Results will appear after students submit this quiz.
                </p>
              ) : (
                <>
                  <div className="live-results-grid">
                    <div>
                      <span>Submitted / Total Attempts</span>
                      <strong>
                        {liveResultSummary.totalAttempts} /{' '}
                        {liveResultSummary.totalAttempts}
                      </strong>
                    </div>
                    <div>
                      <span>Class Average</span>
                      <strong>
                        {liveResultSummary.averagePercentage.toFixed(2)}%
                      </strong>
                    </div>
                    <div>
                      <span>Passed</span>
                      <strong>{liveResultSummary.passCount}</strong>
                    </div>
                    <div>
                      <span>Failed</span>
                      <strong>{liveResultSummary.failCount}</strong>
                    </div>
                  </div>

                  <div className="most-missed-card">
                    <span>Most Missed Question</span>
                    {liveResultSummary.mostMissedQuestion ? (
                      <>
                        <strong>
                          {liveResultSummary.mostMissedQuestion.questionText}
                        </strong>
                        <p>
                          {liveResultSummary.mostMissedQuestion.missedCount} missed (
                          {liveResultSummary.mostMissedQuestion.missPercentage.toFixed(2)}
                          %)
                        </p>
                      </>
                    ) : (
                      <p>No questions found for this quiz.</p>
                    )}
                  </div>
                </>
              )}
            </section>

            <div className="live-results-actions">
              <Link
                className="secondary-link-button"
                to={`/quiz-results-7392?quizId=${createdQuiz.id}&from=full-results`}
              >
                View Full Results
              </Link>
              {createdQuiz.results_saved || createdQuiz.is_active === false ? (
                <p className="live-results-saved-note">
                  {createdQuiz.results_saved
                    ? 'Results saved. This session is ended.'
                    : 'This session is ended.'}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className="secondary-button quiz-save-results-button"
                    onClick={() => saveQuizResults(createdQuiz)}
                    disabled={savingResultsQuizId === createdQuiz.id}
                  >
                    {savingResultsQuizId === createdQuiz.id
                      ? 'Saving Results...'
                      : 'Save Quiz Results'}
                  </button>
                  <p className="live-results-action-note">
                    Saves results and closes the student quiz link.
                  </p>
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
