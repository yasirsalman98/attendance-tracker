import { createClient } from '@supabase/supabase-js';

const settingsAdminEmail = 'excourse7233@gmail.com';
const legacyQuizOwnerEmails = [
  settingsAdminEmail,
  'excourse7233@exceedsafety.com',
];
const archiveRetentionDays = 30;
const allowedArchiveSources = new Set(['saved_quiz', 'saved_quiz_results']);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
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

function getServiceRoleKey() {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_SECRET ||
    process.env.service_role_secret
  );
}

function hasSavedQuizLibrary(user) {
  return Boolean(user?.user_metadata?.imported_assets?.quizzes);
}

function getFallbackSavedQuizLibraryCompany(user) {
  const importedAssets = user?.user_metadata?.imported_assets || {};
  const templateDesigns = user?.user_metadata?.template_designs || {};
  const walletDesign = String(
    templateDesigns.walletCardDesign || templateDesigns.walletCards || ''
  ).toLowerCase();
  const certificateDesign = String(
    templateDesigns.certificateDesign || ''
  ).toLowerCase();

  if (walletDesign === 'bowman' || certificateDesign === 'bowman') {
    return 'bowman';
  }

  if (
    importedAssets.quizzes ||
    importedAssets.savedQuizResults ||
    importedAssets.walletCards ||
    importedAssets.certificateTemplate
  ) {
    return 'excourse';
  }

  return '';
}

function getSavedQuizLibraryCompany(user) {
  if (legacyQuizOwnerEmails.includes(normalizeEmail(user?.email))) {
    return 'excourse';
  }

  return String(
    user?.user_metadata?.template_designs?.savedQuizLibraryCompany ||
      user?.user_metadata?.template_designs?.attendanceRecordsCompany ||
      user?.user_metadata?.template_designs?.savedQuizResultsCompany ||
      getFallbackSavedQuizLibraryCompany(user)
  ).trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isSettingsAdmin(user) {
  return normalizeEmail(user?.email) === settingsAdminEmail;
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

function normalizeQuestionType(questionType) {
  return questionType === 'multiple_choice' ? 'multiple_choice' : 'single_choice';
}

function buildArchivePayload(user, archiveSource) {
  const archivedAt = new Date();
  const archiveDeleteAfter = new Date(archivedAt);
  archiveDeleteAfter.setDate(archiveDeleteAfter.getDate() + archiveRetentionDays);

  return {
    archived_at: archivedAt.toISOString(),
    archived_by: user.id,
    archive_delete_after: archiveDeleteAfter.toISOString(),
    archive_source: archiveSource,
  };
}

function getQueryParam(event, key) {
  if (event.queryStringParameters?.[key]) {
    return event.queryStringParameters[key];
  }

  const params = new URLSearchParams(event.rawQuery || '');
  return params.get(key) || '';
}

async function listAuthUsers(adminClient) {
  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return data?.users || [];
}

async function getUsersByEmails(adminClient, emails) {
  const authUsers = await listAuthUsers(adminClient);
  const wantedEmails = new Set(emails.map(normalizeEmail));

  return authUsers.filter((user) =>
    wantedEmails.has(normalizeEmail(user.email))
  );
}

async function getUserEmailMap(adminClient) {
  const authUsers = await listAuthUsers(adminClient);

  return new Map(
    authUsers.map((user) => [
      user.id,
      normalizeEmail(user.email),
    ])
  );
}

async function getSharedSavedQuizOwnerIds(adminClient, user) {
  if (isSettingsAdmin(user)) return null;
  if (!hasSavedQuizLibrary(user)) return [];

  const company = getSavedQuizLibraryCompany(user);

  if (!company) return [user.id];

  const authUsers = await listAuthUsers(adminClient);
  const ownerIds = authUsers
    .filter((authUser) => getSavedQuizLibraryCompany(authUser) === company)
    .map((authUser) => authUser.id);

  return ownerIds.length ? ownerIds : [user.id];
}

function withOwnerEmail(quiz, userEmailById) {
  return {
    ...quiz,
    owner_email: userEmailById.get(quiz.owner_user_id) || '',
  };
}

function getSavedQuizContentKey(quiz) {
  const questions = [...(quiz.quiz_questions || [])]
    .sort((left, right) => (left.sort_order || 0) - (right.sort_order || 0))
    .map((question) => ({
      text: question.question_text || '',
      type: question.question_type || '',
      choices: [...(question.quiz_answer_choices || [])]
        .sort((left, right) => (left.sort_order || 0) - (right.sort_order || 0))
        .map((choice) => ({
          text: choice.choice_text || '',
          correct: Boolean(choice.is_correct),
        })),
    }));

  return JSON.stringify({
    courseName: quiz.course_name || '',
    quizTitle: quiz.quiz_title || '',
    passingScore: Number(quiz.passing_score || 0),
    duration: Number(quiz.quiz_duration_minutes || 0),
    questions,
  });
}

function dedupeSavedQuizzes(quizzes, user) {
  const savedQuizByContent = new Map();

  for (const quiz of quizzes || []) {
    const contentKey = getSavedQuizContentKey(quiz);
    const existingQuiz = savedQuizByContent.get(contentKey);

    if (!existingQuiz) {
      savedQuizByContent.set(contentKey, quiz);
      continue;
    }

    const quizIsAdminOwned = legacyQuizOwnerEmails.includes(
      normalizeEmail(quiz.owner_email)
    );
    const existingIsAdminOwned = legacyQuizOwnerEmails.includes(
      normalizeEmail(existingQuiz.owner_email)
    );
    const quizIsCurrentUsers = quiz.owner_user_id === user.id;
    const existingIsCurrentUsers = existingQuiz.owner_user_id === user.id;

    if (
      (quizIsAdminOwned && !existingIsAdminOwned) ||
      (!existingIsAdminOwned && quizIsCurrentUsers && !existingIsCurrentUsers)
    ) {
      savedQuizByContent.set(contentKey, quiz);
    }
  }

  return [...savedQuizByContent.values()];
}

async function getSavedLibraryQuizKeys(adminClient, sourceUserId) {
  const selectKeys = (useSavedTemplateFlag, includeArchiveFilter) => {
    let query = adminClient
      .from('quiz_templates')
      .select('course_name, quiz_title')
      .eq('owner_user_id', sourceUserId);

    if (includeArchiveFilter) {
      query = query.is('archived_at', null);
    }

    return useSavedTemplateFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);
  };

  let archiveColumnsAvailable = true;
  let { data, error } = await selectKeys(true, true);

  if (isMissingArchiveColumn(error)) {
    archiveColumnsAvailable = false;
    const fallbackResponse = await selectKeys(true, false);
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectKeys(false, archiveColumnsAvailable);
    data = fallbackResponse.data;
    error = fallbackResponse.error;

    if (isMissingArchiveColumn(error)) {
      const noArchiveFallbackResponse = await selectKeys(false, false);
      data = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  return (data || []).map((quiz) => ({
    courseName: quiz.course_name,
    quizTitle: quiz.quiz_title,
  }));
}

async function removeSavedLibraryCopies(adminClient, sourceUserId, targetUserId) {
  // DATA SAFETY: hard-deletes copied saved quiz library templates.
  const libraryQuizKeys = await getSavedLibraryQuizKeys(adminClient, sourceUserId);

  for (const quizKey of libraryQuizKeys) {
    const { error } = await adminClient
      .from('quiz_templates')
      .delete()
      .eq('owner_user_id', targetUserId)
      .eq('course_name', quizKey.courseName)
      .eq('quiz_title', quizKey.quizTitle)
      .eq('is_active', false)
      .eq('results_saved', false);

    if (error) throw error;
  }
}

async function removeSavedLibraryCopiesFromUsers(adminClient, sourceUsers, targetUserId) {
  for (const sourceUser of sourceUsers) {
    if (sourceUser.id === targetUserId) continue;
    await removeSavedLibraryCopies(adminClient, sourceUser.id, targetUserId);
  }
}

async function copyQuizzesToUser(adminClient, sourceUserId, targetUserId) {
  const selectReusableQuizzes = (useSavedTemplateFlag, includeArchiveFilter) => {
    let query = adminClient
      .from('quiz_templates')
      .select(`
        course_name,
        quiz_title,
        quiz_description,
        instructor_name,
        class_date,
        passing_score,
        quiz_duration_minutes,
        quiz_questions (
          question_text,
          question_type,
          sort_order,
          quiz_answer_choices (
            choice_text,
            is_correct,
            sort_order
          )
        )
      `)
      .eq('owner_user_id', sourceUserId)
      .order('created_at', { ascending: false });

    if (includeArchiveFilter) {
      query = query.is('archived_at', null);
    }

    return useSavedTemplateFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);
  };

  let archiveColumnsAvailable = true;
  let { data: quizzes, error } = await selectReusableQuizzes(true, true);

  if (isMissingArchiveColumn(error)) {
    archiveColumnsAvailable = false;
    const fallbackResponse = await selectReusableQuizzes(true, false);
    quizzes = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectReusableQuizzes(
      false,
      archiveColumnsAvailable
    );
    quizzes = fallbackResponse.data;
    error = fallbackResponse.error;

    if (isMissingArchiveColumn(error)) {
      const noArchiveFallbackResponse = await selectReusableQuizzes(false, false);
      quizzes = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  let copiedCount = 0;

  for (const quiz of quizzes || []) {
    const { data: existingCopies, error: existingCopyError } = await adminClient
      .from('quiz_templates')
      .select('id')
      .eq('owner_user_id', targetUserId)
      .eq('course_name', quiz.course_name)
      .eq('quiz_title', quiz.quiz_title)
      .eq('is_active', false)
      .eq('results_saved', false)
      .limit(1);

    if (existingCopyError) throw existingCopyError;
    if ((existingCopies || []).length > 0) continue;

    let { data: copiedQuiz, error: quizError } = await adminClient
      .from('quiz_templates')
      .insert({
        course_name: quiz.course_name,
        quiz_title: quiz.quiz_title,
        quiz_description: quiz.quiz_description,
        instructor_name: quiz.instructor_name,
        class_date: quiz.class_date,
        passing_score: quiz.passing_score,
        quiz_duration_minutes: quiz.quiz_duration_minutes || 30,
        is_active: false,
        is_saved_template: true,
        owner_user_id: targetUserId,
      })
      .select('id')
      .single();

    if (isMissingSavedTemplateColumn(quizError)) {
      const fallbackResponse = await adminClient
        .from('quiz_templates')
        .insert({
          course_name: quiz.course_name,
          quiz_title: quiz.quiz_title,
          quiz_description: quiz.quiz_description,
          instructor_name: quiz.instructor_name,
          class_date: quiz.class_date,
          passing_score: quiz.passing_score,
          quiz_duration_minutes: quiz.quiz_duration_minutes || 30,
          is_active: false,
          owner_user_id: targetUserId,
        })
        .select('id')
        .single();

      copiedQuiz = fallbackResponse.data;
      quizError = fallbackResponse.error;
    }

    if (quizError) throw quizError;

    const questions = [...(quiz.quiz_questions || [])].sort(
      (left, right) => left.sort_order - right.sort_order
    );

    for (const question of questions) {
      const { data: copiedQuestion, error: questionError } = await adminClient
        .from('quiz_questions')
        .insert({
          quiz_template_id: copiedQuiz.id,
          question_text: question.question_text,
          question_type: question.question_type,
          sort_order: question.sort_order,
        })
        .select('id')
        .single();

      if (questionError) throw questionError;

      const choices = [...(question.quiz_answer_choices || [])]
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((choice) => ({
          question_id: copiedQuestion.id,
          choice_text: choice.choice_text,
          is_correct: choice.is_correct,
          sort_order: choice.sort_order,
        }));

      if (choices.length > 0) {
        const { error: choicesError } = await adminClient
          .from('quiz_answer_choices')
          .insert(choices);

        if (choicesError) throw choicesError;
      }
    }

    copiedCount += 1;
  }

  return copiedCount;
}

async function copyQuizzesFromUsers(adminClient, sourceUsers, targetUserId) {
  let copiedCount = 0;

  for (const sourceUser of sourceUsers) {
    if (sourceUser.id === targetUserId) continue;
    copiedCount += await copyQuizzesToUser(
      adminClient,
      sourceUser.id,
      targetUserId
    );
  }

  return copiedCount;
}

async function listSavedQuizzes(adminClient, user) {
  const sharedOwnerIds = await getSharedSavedQuizOwnerIds(adminClient, user);

  if (Array.isArray(sharedOwnerIds) && sharedOwnerIds.length === 0) {
    return [];
  }

  const selectSavedQuizzes = (useSavedTemplateFlag, includeArchiveFields) => {
    let query = adminClient
      .from('quiz_templates')
      .select(
        useSavedTemplateFlag
          ? includeArchiveFields
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
            owner_user_id,
            archived_at,
            archived_by,
            archive_delete_after,
            archive_source,
            quiz_questions (
              question_text,
              question_type,
              sort_order,
              quiz_answer_choices (
                choice_text,
                is_correct,
                sort_order
              )
            )
          `
            : `
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
            owner_user_id,
            quiz_questions (
              question_text,
              question_type,
              sort_order,
              quiz_answer_choices (
                choice_text,
                is_correct,
                sort_order
              )
            )
          `
          : includeArchiveFields
            ? `
            id,
            course_name,
            quiz_title,
            class_date,
            passing_score,
            is_active,
            results_saved,
            quiz_duration_minutes,
            created_at,
            owner_user_id,
            archived_at,
            archived_by,
            archive_delete_after,
            archive_source,
            quiz_questions (
              question_text,
              question_type,
              sort_order,
              quiz_answer_choices (
                choice_text,
                is_correct,
                sort_order
              )
            )
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
            owner_user_id,
            quiz_questions (
              question_text,
              question_type,
              sort_order,
              quiz_answer_choices (
                choice_text,
                is_correct,
                sort_order
              )
            )
          `
      )
      .order('created_at', { ascending: false });

    query = useSavedTemplateFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);

    if (includeArchiveFields) {
      query = query.is('archived_at', null);
    }

    if (Array.isArray(sharedOwnerIds)) {
      query = query.in('owner_user_id', sharedOwnerIds);
    }

    return query;
  };

  let archiveColumnsAvailable = true;
  let { data, error } = await selectSavedQuizzes(true, true);

  if (isMissingArchiveColumn(error)) {
    archiveColumnsAvailable = false;
    const fallbackResponse = await selectSavedQuizzes(true, false);
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectSavedQuizzes(
      false,
      archiveColumnsAvailable
    );
    data = fallbackResponse.data;
    error = fallbackResponse.error;

    if (isMissingArchiveColumn(error)) {
      archiveColumnsAvailable = false;
      const noArchiveFallbackResponse = await selectSavedQuizzes(false, false);
      data = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  const userEmailById = await getUserEmailMap(adminClient);
  const quizzesWithOwnerEmail = (data || []).map((quiz) =>
    withOwnerEmail(quiz, userEmailById)
  );

  return {
    archiveColumnsAvailable,
    savedQuizzes: dedupeSavedQuizzes(quizzesWithOwnerEmail, user),
  };
}

async function getSavedQuizDetails(adminClient, user, quizId) {
  const sharedOwnerIds = await getSharedSavedQuizOwnerIds(adminClient, user);

  if (Array.isArray(sharedOwnerIds) && sharedOwnerIds.length === 0) {
    return null;
  }

  const selectSavedQuizDetails = (useSavedTemplateFlag, includeArchiveFilter) => {
    let query = adminClient
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
      .eq('id', quizId);

    if (includeArchiveFilter) {
      query = query.is('archived_at', null);
    }

    query = useSavedTemplateFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);

    if (Array.isArray(sharedOwnerIds)) {
      query = query.in('owner_user_id', sharedOwnerIds);
    }

    return query;
  };

  let { data, error } = await selectSavedQuizDetails(true, true).maybeSingle();

  if (isMissingArchiveColumn(error)) {
    const fallbackResponse = await selectSavedQuizDetails(true, false).maybeSingle();
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectSavedQuizDetails(
      false,
      !isMissingArchiveColumn(error)
    ).maybeSingle();
    data = fallbackResponse.data;
    error = fallbackResponse.error;

    if (isMissingArchiveColumn(error)) {
      const noArchiveFallbackResponse = await selectSavedQuizDetails(
        false,
        false
      ).maybeSingle();
      data = noArchiveFallbackResponse.data;
      error = noArchiveFallbackResponse.error;
    }
  }

  if (error) throw error;

  return data;
}

async function updateSavedQuizById(adminClient, quizId, quiz, questions) {
  const quizPayload = {
    course_name: String(quiz?.course_name || '').trim(),
    quiz_title: String(quiz?.quiz_title || '').trim(),
    quiz_description: String(quiz?.quiz_description || '').trim() || null,
    instructor_name: String(quiz?.instructor_name || '').trim() || null,
    class_date: quiz?.class_date || null,
    passing_score: Number(quiz?.passing_score),
    quiz_duration_minutes: Number(quiz?.quiz_duration_minutes),
    is_saved_template: true,
  };

  if (!quizPayload.course_name || !quizPayload.quiz_title) {
    return {
      statusCode: 400,
      body: { error: 'Course name and quiz title are required.' },
    };
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    return {
      statusCode: 400,
      body: { error: 'At least one quiz question is required.' },
    };
  }

  const sanitizedQuestions = questions.map((question, questionIndex) => {
    const questionText = String(question?.questionText || '').trim();
    const choices = Array.isArray(question?.choices) ? question.choices : [];
    const sanitizedChoices = choices.map((choice, choiceIndex) => ({
      choice_text: String(choice?.choiceText || '').trim(),
      is_correct: Boolean(choice?.isCorrect),
      sort_order: choiceIndex,
    }));

    return {
      question_text: questionText,
      question_type: normalizeQuestionType(question?.questionType),
      sort_order: questionIndex,
      choices: sanitizedChoices,
    };
  });

  if (sanitizedQuestions.some((question) => !question.question_text)) {
    return {
      statusCode: 400,
      body: { error: 'Each quiz question needs question text.' },
    };
  }

  if (
    sanitizedQuestions.some(
      (question) =>
        question.choices.length === 0 ||
        question.choices.some((choice) => !choice.choice_text)
    )
  ) {
    return {
      statusCode: 400,
      body: { error: 'Each quiz question needs answer choices.' },
    };
  }

  let { data: updatedQuizTemplate, error: quizError } = await adminClient
    .from('quiz_templates')
    .update(quizPayload)
    .eq('id', quizId)
    .eq('is_saved_template', true)
    .select('id, owner_user_id')
    .maybeSingle();

  if (isMissingSavedTemplateColumn(quizError)) {
    const fallbackPayload = { ...quizPayload };
    delete fallbackPayload.is_saved_template;

    const fallbackResponse = await adminClient
      .from('quiz_templates')
      .update(fallbackPayload)
      .eq('id', quizId)
      .eq('is_active', false)
      .eq('results_saved', false)
      .select('id, owner_user_id')
      .maybeSingle();

    updatedQuizTemplate = fallbackResponse.data;
    quizError = fallbackResponse.error;
  }

  if (quizError) throw quizError;

  if (!updatedQuizTemplate) {
    return {
      statusCode: 404,
      body: {
        error: 'You do not have permission to edit this saved quiz, or it no longer exists.',
      },
    };
  }

  // DATA SAFETY: replaces only the selected saved quiz template questions.
  // Student attempts, student answers, saved results, and ownership fields are untouched.
  const { error: deleteQuestionsError } = await adminClient
    .from('quiz_questions')
    .delete()
    .eq('quiz_template_id', updatedQuizTemplate.id);

  if (deleteQuestionsError) throw deleteQuestionsError;

  for (const question of sanitizedQuestions) {
    const { data: savedQuestion, error: questionError } = await adminClient
      .from('quiz_questions')
      .insert({
        quiz_template_id: updatedQuizTemplate.id,
        question_text: question.question_text,
        question_type: question.question_type,
        sort_order: question.sort_order,
      })
      .select('id')
      .single();

    if (questionError) throw questionError;

    const choicesToInsert = question.choices.map((choice) => ({
      question_id: savedQuestion.id,
      ...choice,
    }));

    const { error: choicesError } = await adminClient
      .from('quiz_answer_choices')
      .insert(choicesToInsert);

    if (choicesError) throw choicesError;
  }

  return {
    statusCode: 200,
    body: {
      success: true,
      savedQuiz: updatedQuizTemplate,
    },
  };
}

async function archiveSavedQuizById(adminClient, user, quizId, archiveSource) {
  const archivePayload = buildArchivePayload(user, archiveSource);

  if (archiveSource === 'saved_quiz_results') {
    const { data, error } = await adminClient
      .from('quiz_templates')
      .update(archivePayload)
      .eq('id', quizId)
      .eq('results_saved', true)
      .is('archived_at', null)
      .select('id');

    if (error) throw error;

    return data || [];
  }

  let { data, error } = await adminClient
    .from('quiz_templates')
    .update(archivePayload)
    .eq('id', quizId)
    .eq('is_saved_template', true)
    .is('archived_at', null)
    .select('id');

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await adminClient
      .from('quiz_templates')
      .update(archivePayload)
      .eq('id', quizId)
      .eq('is_active', false)
      .eq('results_saved', false)
      .is('archived_at', null)
      .select('id');

    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

  if (error) throw error;

  return data || [];
}

async function restoreArchivedQuizById(adminClient, quizId) {
  const { data, error } = await adminClient
    .from('quiz_templates')
    .update({
      archived_at: null,
      archived_by: null,
      archive_delete_after: null,
      archive_source: null,
    })
    .eq('id', quizId)
    .not('archived_at', 'is', null)
    .select('id');

  if (error) throw error;

  return data || [];
}

export async function handler(event) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(event.httpMethod)) {
    return jsonResponse(405, { error: 'Method not allowed.' });
  }

  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = getServiceRoleKey();
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!accessToken) {
    return jsonResponse(401, { error: 'Login required.' });
  }

  const authClient = getSupabaseClient(anonKey);
  const adminClient = getSupabaseClient(serviceRoleKey);

  if (!authClient || !adminClient) {
    return jsonResponse(500, { error: 'Supabase service role key is missing.' });
  }

  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);

  if (userError || !userData?.user) {
    return jsonResponse(401, { error: 'Login required.' });
  }

  try {
    if (event.httpMethod === 'GET') {
      const quizId = getQueryParam(event, 'quizId');

      if (quizId) {
        const savedQuiz = await getSavedQuizDetails(
          adminClient,
          userData.user,
          quizId
        );

        if (!savedQuiz) {
          return jsonResponse(404, { error: 'Saved quiz was not found.' });
        }

        return jsonResponse(200, { savedQuiz });
      }

      const savedQuizResponse = await listSavedQuizzes(adminClient, userData.user);

      return jsonResponse(200, savedQuizResponse);
    }

    if (event.httpMethod === 'PATCH' || event.httpMethod === 'DELETE') {
      if (!isSettingsAdmin(userData.user)) {
        return jsonResponse(403, { error: 'Admin access required.' });
      }

      const body = JSON.parse(event.body || '{}');
      const quizId = String(body.quizId || '').trim();
      const action = String(body.action || 'archive').trim();
      const archiveSource = String(body.archiveSource || 'saved_quiz').trim();

      if (!quizId) {
        return jsonResponse(400, { error: 'Saved quiz id is required.' });
      }

      if (action === 'update_saved_quiz') {
        const updateResponse = await updateSavedQuizById(
          adminClient,
          quizId,
          body.quiz || {},
          body.questions || []
        );

        return jsonResponse(updateResponse.statusCode, updateResponse.body);
      }

      if (action === 'restore') {
        const restoredRows = await restoreArchivedQuizById(adminClient, quizId);

        if (restoredRows.length === 0) {
          return jsonResponse(404, {
            error: 'No archived quiz was restored. Refresh and try again.',
          });
        }

        return jsonResponse(200, {
          success: true,
          restoredIds: restoredRows.map((row) => row.id),
        });
      }

      if (action !== 'archive') {
        return jsonResponse(400, { error: 'Invalid saved quiz action.' });
      }

      if (!allowedArchiveSources.has(archiveSource)) {
        return jsonResponse(400, { error: 'Invalid archive source.' });
      }

      const archivedRows = await archiveSavedQuizById(
        adminClient,
        userData.user,
        quizId,
        archiveSource
      );

      if (archivedRows.length === 0) {
        return jsonResponse(404, {
          error: 'No saved quiz was archived. Refresh and try again.',
        });
      }

      return jsonResponse(200, {
        success: true,
        archivedIds: archivedRows.map((row) => row.id),
      });
    }

    if (isSettingsAdmin(userData.user)) {
      return jsonResponse(200, {
        importedQuizCount: 0,
        skipped: true,
      });
    }

    return jsonResponse(200, {
      importedQuizCount: 0,
      sharedLibrary: true,
      skipped: true,
    });
  } catch (error) {
    console.error('Saved quiz library sync error:', error);
    if (isMissingArchiveColumn(error)) {
      return jsonResponse(409, {
        error: 'Archive requires database migration before it can be used.',
      });
    }

    return jsonResponse(500, {
      error: error?.message || 'Unable to sync saved quiz library.',
    });
  }
}
