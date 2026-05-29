import { createClient } from '@supabase/supabase-js';

const settingsAdminEmail = 'excourse7233@gmail.com';

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

function hasSavedQuizLibrary(user) {
  return Boolean(user?.user_metadata?.imported_assets?.quizzes);
}

async function getUserByEmail(adminClient, email) {
  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return (data?.users || []).find(
    (user) => String(user.email || '').toLowerCase() === email
  );
}

async function getSavedLibraryQuizKeys(adminClient, sourceUserId) {
  const { data, error } = await adminClient
    .from('quiz_templates')
    .select('course_name, quiz_title')
    .eq('owner_user_id', sourceUserId);

  if (error) throw error;

  return (data || []).map((quiz) => ({
    courseName: quiz.course_name,
    quizTitle: quiz.quiz_title,
  }));
}

async function removeSavedLibraryCopies(adminClient, sourceUserId, targetUserId) {
  const libraryQuizKeys = await getSavedLibraryQuizKeys(adminClient, sourceUserId);

  for (const quizKey of libraryQuizKeys) {
    const { error } = await adminClient
      .from('quiz_templates')
      .delete()
      .eq('owner_user_id', targetUserId)
      .eq('course_name', quizKey.courseName)
      .eq('quiz_title', quizKey.quizTitle)
      .eq('is_active', false);

    if (error) throw error;
  }
}

async function copyQuizzesToUser(adminClient, sourceUserId, targetUserId) {
  const { data: quizzes, error } = await adminClient
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
      .limit(1);

    if (existingCopyError) throw existingCopyError;
    if ((existingCopies || []).length > 0) continue;

    const { data: copiedQuiz, error: quizError } = await adminClient
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

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
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
  const adminClient = getSupabaseClient(serviceRoleKey);

  if (!authClient || !adminClient) {
    return jsonResponse(500, { error: 'Supabase service role key is missing.' });
  }

  const { data: userData, error: userError } = await authClient.auth.getUser(accessToken);

  if (userError || !userData?.user) {
    return jsonResponse(401, { error: 'Login required.' });
  }

  try {
    const sourceUser = await getUserByEmail(adminClient, settingsAdminEmail);

    if (!sourceUser?.id) {
      return jsonResponse(404, { error: 'Saved quiz library owner was not found.' });
    }

    if (!hasSavedQuizLibrary(userData.user)) {
      await removeSavedLibraryCopies(adminClient, sourceUser.id, userData.user.id);

      return jsonResponse(200, {
        importedQuizCount: 0,
        removedSavedLibrary: true,
        skipped: true,
      });
    }

    const importedQuizCount = await copyQuizzesToUser(
      adminClient,
      sourceUser.id,
      userData.user.id
    );

    return jsonResponse(200, { importedQuizCount });
  } catch (error) {
    console.error('Saved quiz library sync error:', error);
    return jsonResponse(500, {
      error: error?.message || 'Unable to sync saved quiz library.',
    });
  }
}
