import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const settingsAdminEmail = 'excourse7233@gmail.com';
const legacyQuizOwnerEmails = [
  settingsAdminEmail,
  'excourse7233@exceedsafety.com',
];
const templateBucketName = 'instructor-templates';

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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePassword(password) {
  return String(password || '');
}

function isMissingSavedTemplateColumn(error) {
  return String(error?.message || '').toLowerCase().includes('is_saved_template');
}

function normalizeImportOptions(importOptions) {
  return {
    walletCards: Boolean(importOptions?.walletCards),
    certificateTemplate: Boolean(importOptions?.certificateTemplate),
    quizzes: Boolean(importOptions?.quizzes),
  };
}

function normalizeTemplateDesigns(templateDesigns) {
  const legacyWalletDesign =
    templateDesigns?.walletCards === 'different' ? 'different' : 'same';
  const walletCardDesign =
    templateDesigns?.walletCardDesign === 'bowman' ? 'bowman' : 'excourse';

  return {
    walletCards: legacyWalletDesign,
    walletCardDesign,
    walletFront:
      templateDesigns?.walletFront === 'different'
        ? 'different'
        : legacyWalletDesign,
    walletBack:
      templateDesigns?.walletBack === 'different'
        ? 'different'
        : legacyWalletDesign,
    certificateTemplate:
      templateDesigns?.certificateTemplate === 'different' ? 'different' : 'same',
    certificateDesign: templateDesigns?.certificateDesign || 'excourse',
  };
}

function cleanFileName(value, fallback = 'template') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

  return cleaned || fallback;
}

function getFileExtension(fileName) {
  const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

function assertTemplateUpload(upload, allowedExtensions, label) {
  if (!upload?.base64 || !upload?.fileName) {
    throw new Error(`${label} upload is required.`);
  }

  const extension = getFileExtension(upload.fileName);

  if (!allowedExtensions.includes(extension)) {
    throw new Error(`${label} must be ${allowedExtensions.join(', ')}.`);
  }
}

function getUploadBuffer(upload) {
  return Buffer.from(upload.base64, 'base64');
}

function serializeUser(user) {
  const importedAssets = normalizeImportOptions(user.user_metadata?.imported_assets);

  return {
    id: user.id,
    email: user.email || '',
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at || '',
    imported_assets: importedAssets,
    template_designs: normalizeTemplateDesigns(user.user_metadata?.template_designs),
  };
}

async function listUsers(adminClient) {
  const { data, error } = await adminClient.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return (data?.users || [])
    .map(serializeUser)
    .filter((user) => user.email)
    .sort((left, right) => left.email.localeCompare(right.email));
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

function getUniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

async function removeStorageFiles(adminClient, bucketName, paths) {
  const uniquePaths = getUniqueValues(paths);

  if (uniquePaths.length === 0) return;

  const { error } = await adminClient.storage.from(bucketName).remove(uniquePaths);

  if (error) {
    console.error(`Storage cleanup error for ${bucketName}:`, error);
  }
}

async function removeTemplateFolder(adminClient, userId, folder) {
  const prefix = `${userId}/${folder}`;
  const { data, error } = await adminClient.storage
    .from(templateBucketName)
    .list(prefix, { limit: 1000 });

  if (error) return;

  const paths = (data || [])
    .filter((item) => item.name)
    .map((item) => `${prefix}/${item.name}`);

  await removeStorageFiles(adminClient, templateBucketName, paths);
}

async function removeUserTemplateFiles(adminClient, userId) {
  await Promise.all([
    removeTemplateFolder(adminClient, userId, 'certificate-template'),
    removeTemplateFolder(adminClient, userId, 'wallet-cards-front'),
    removeTemplateFolder(adminClient, userId, 'wallet-cards-back'),
    removeTemplateFolder(adminClient, userId, 'wallet-cards-front-reference'),
    removeTemplateFolder(adminClient, userId, 'wallet-cards-back-reference'),
  ]);
}

async function ensureTemplateBucket(adminClient) {
  const { error } = await adminClient.storage.createBucket(templateBucketName, {
    public: false,
  });

  if (
    error &&
    !String(error.message || '').toLowerCase().includes('already exists')
  ) {
    throw error;
  }
}

async function uploadTemplateFile(adminClient, userId, upload, folder, allowedExtensions) {
  assertTemplateUpload(upload, allowedExtensions, folder);
  await ensureTemplateBucket(adminClient);

  const extension = getFileExtension(upload.fileName);
  const fileName = `${Date.now()}-${crypto.randomUUID()}-${cleanFileName(
    upload.fileName
  )}`;
  const path = `${userId}/${folder}/${fileName}`;
  const { error } = await adminClient.storage
    .from(templateBucketName)
    .upload(path, getUploadBuffer(upload), {
      contentType: upload.mimeType || 'application/octet-stream',
      upsert: false,
    });

  if (error) throw error;

  return {
    path,
    fileName: upload.fileName,
    mimeType: upload.mimeType || 'application/octet-stream',
    extension,
  };
}

async function uploadCustomTemplates(adminClient, userId, importOptions, templateDesigns, uploads) {
  const customTemplates = {};

  if (
    importOptions.certificateTemplate &&
    templateDesigns.certificateTemplate === 'different'
  ) {
    customTemplates.certificateTemplate = await uploadTemplateFile(
      adminClient,
      userId,
      uploads?.certificateTemplate,
      'certificate-template',
      ['docx', 'pdf']
    );
  }

  if (importOptions.walletCards) {
    const walletCardTemplates = {};

    if (templateDesigns.walletFront === 'different') {
      walletCardTemplates.front = await uploadTemplateFile(
        adminClient,
        userId,
        uploads?.walletCards?.front,
        'wallet-cards-front',
        ['png', 'jpg', 'jpeg', 'webp', 'pdf']
      );

      if (uploads?.walletCards?.frontReference) {
        walletCardTemplates.frontReference = await uploadTemplateFile(
          adminClient,
          userId,
          uploads.walletCards.frontReference,
          'wallet-cards-front-reference',
          ['png', 'jpg', 'jpeg', 'webp']
        );
      }
    }

    if (templateDesigns.walletBack === 'different') {
      walletCardTemplates.back = await uploadTemplateFile(
        adminClient,
        userId,
        uploads?.walletCards?.back,
        'wallet-cards-back',
        ['png', 'jpg', 'jpeg', 'webp', 'pdf']
      );

      if (uploads?.walletCards?.backReference) {
        walletCardTemplates.backReference = await uploadTemplateFile(
          adminClient,
          userId,
          uploads.walletCards.backReference,
          'wallet-cards-back-reference',
          ['png', 'jpg', 'jpeg', 'webp']
        );
      }
    }

    if (Object.keys(walletCardTemplates).length > 0) {
      customTemplates.walletCards = walletCardTemplates;
    }
  }

  return customTemplates;
}

async function deleteOwnedData(adminClient, userId) {
  const { data: sessions, error: sessionsError } = await adminClient
    .from('training_sessions')
    .select('id, trainer_signature_path')
    .eq('owner_user_id', userId);

  if (sessionsError) throw sessionsError;

  const sessionIds = (sessions || []).map((session) => session.id);

  if (sessionIds.length > 0) {
    const { data: ownedRecords, error: recordsError } = await adminClient
      .from('attendance_records')
      .select('id, signature_path, photo_path')
      .in('training_session_id', sessionIds);

    if (recordsError) throw recordsError;

    const records = ownedRecords || [];

    await removeStorageFiles(
      adminClient,
      'signatures',
      [
        ...(sessions || []).map((session) => session.trainer_signature_path),
        ...records.map((record) => record.signature_path),
      ]
    );
    await removeStorageFiles(
      adminClient,
      'attendance-photos',
      records.map((record) => record.photo_path)
    );

    const { error: attendanceDeleteError } = await adminClient
      .from('attendance_records')
      .delete()
      .in('training_session_id', sessionIds);

    if (attendanceDeleteError) throw attendanceDeleteError;

    const { error: sessionsDeleteError } = await adminClient
      .from('training_sessions')
      .delete()
      .eq('owner_user_id', userId);

    if (sessionsDeleteError) throw sessionsDeleteError;
  }

  const { error: quizzesDeleteError } = await adminClient
    .from('quiz_templates')
    .delete()
    .eq('owner_user_id', userId);

  if (quizzesDeleteError) throw quizzesDeleteError;

  await removeUserTemplateFiles(adminClient, userId);
}

async function copyQuizzesToUser(adminClient, sourceUserId, targetUserId) {
  const selectReusableQuizzes = (useSavedTemplateFlag) => {
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

    return useSavedTemplateFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);
  };

  let { data: quizzes, error } = await selectReusableQuizzes(true);

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectReusableQuizzes(false);
    quizzes = fallbackResponse.data;
    error = fallbackResponse.error;
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

async function getSavedLibraryQuizKeys(adminClient, sourceUserId) {
  const selectKeys = (useSavedTemplateFlag) => {
    let query = adminClient
      .from('quiz_templates')
      .select('course_name, quiz_title')
      .eq('owner_user_id', sourceUserId);

    return useSavedTemplateFlag
      ? query.eq('is_saved_template', true)
      : query.eq('is_active', false).eq('results_saved', false);
  };

  let { data, error } = await selectKeys(true);

  if (isMissingSavedTemplateColumn(error)) {
    const fallbackResponse = await selectKeys(false);
    data = fallbackResponse.data;
    error = fallbackResponse.error;
  }

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

async function getCurrentUser(event) {
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!accessToken) {
    return { error: 'Login required.' };
  }

  const authClient = getSupabaseClient(anonKey);

  if (!authClient) {
    return { error: 'Supabase environment variables are missing.' };
  }

  const { data, error } = await authClient.auth.getUser(accessToken);

  if (error || !data?.user) {
    return { error: 'Login required.' };
  }

  return { user: data.user };
}

export async function handler(event) {
  const serviceRoleKey = getServiceRoleKey();
  const adminClient = getSupabaseClient(serviceRoleKey);

  if (!adminClient) {
    return jsonResponse(500, { error: 'Supabase service role key is missing.' });
  }

  const { user, error: authError } = await getCurrentUser(event);

  if (authError) {
    return jsonResponse(401, { error: authError });
  }

  if (normalizeEmail(user.email) !== settingsAdminEmail) {
    return jsonResponse(403, { error: 'Settings access is not allowed for this email.' });
  }

  try {
    if (event.httpMethod === 'GET') {
      return jsonResponse(200, { users: await listUsers(adminClient) });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const email = normalizeEmail(body.email);
      const password = normalizePassword(body.password);
      const importOptions = normalizeImportOptions(body.importOptions);
      const templateDesigns = normalizeTemplateDesigns(body.templateDesigns);
      const templateUploads = body.templateUploads || {};

      if (!email) {
        return jsonResponse(400, { error: 'Email is required.' });
      }

      if (password.length < 6) {
        return jsonResponse(400, { error: 'Password must be at least 6 characters.' });
      }

      const existingUsers = await listUsers(adminClient);
      const existingUser = existingUsers.find((nextUser) => nextUser.email === email);

      if (existingUser) {
        return jsonResponse(409, { error: 'That email already has login access.' });
      }

      const { data: createdUserData, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          imported_assets: importOptions,
          template_designs: templateDesigns,
          custom_templates: {},
        },
      });

      if (error) throw error;

      const createdUser = createdUserData?.user;
      let importedQuizCount = 0;

      try {
        let customTemplates = {};

        if (createdUser?.id) {
          customTemplates = await uploadCustomTemplates(
            adminClient,
            createdUser.id,
            importOptions,
            templateDesigns,
            templateUploads
          );

          const { error: metadataError } = await adminClient.auth.admin.updateUserById(
            createdUser.id,
            {
              user_metadata: {
                imported_assets: importOptions,
                template_designs: templateDesigns,
                custom_templates: customTemplates,
              },
            }
          );

          if (metadataError) throw metadataError;
        }

        if (importOptions.quizzes && createdUser?.id) {
          const sourceUsers = await getUsersByEmails(
            adminClient,
            legacyQuizOwnerEmails
          );

          importedQuizCount = await copyQuizzesFromUsers(
            adminClient,
            sourceUsers,
            createdUser.id
          );
        }
      } catch (copyError) {
        if (createdUser?.id) {
          await deleteOwnedData(adminClient, createdUser.id).catch((cleanupError) => {
            console.error('Created user cleanup error:', cleanupError);
          });
          await adminClient.auth.admin.deleteUser(createdUser.id).catch((deleteError) => {
            console.error('Created user delete cleanup error:', deleteError);
          });
        }

        throw copyError;
      }

      return jsonResponse(200, {
        users: await listUsers(adminClient),
        importedQuizCount,
      });
    }

    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const action = String(body.action || '').trim();
      const email = normalizeEmail(body.email);

      if (!email) {
        return jsonResponse(400, { error: 'Email is required.' });
      }

      const existingUsers = await listUsers(adminClient);
      const existingUser = existingUsers.find((nextUser) => nextUser.email === email);

      if (!existingUser) {
        return jsonResponse(404, { error: 'Email was not found.' });
      }

      if (action === 'update-features') {
        const { data: currentUserData, error: currentUserError } =
          await adminClient.auth.admin.getUserById(existingUser.id);

        if (currentUserError || !currentUserData?.user) {
          throw currentUserError || new Error('Email was not found.');
        }

        const currentMetadata = currentUserData.user.user_metadata || {};
        const nextAssets = normalizeImportOptions(body.importOptions);
        const nextTemplateDesigns = normalizeTemplateDesigns(body.templateDesigns);
        const templateUploads = body.templateUploads || {};
        const previousCustomTemplates = currentMetadata.custom_templates || {};
        const uploadedCustomTemplates = await uploadCustomTemplates(
          adminClient,
          existingUser.id,
          nextAssets,
          nextTemplateDesigns,
          templateUploads
        );
        const nextCustomTemplates = {
          ...previousCustomTemplates,
          ...uploadedCustomTemplates,
          walletCards: {
            ...(previousCustomTemplates.walletCards || {}),
            ...(uploadedCustomTemplates.walletCards || {}),
          },
        };

        if (Object.keys(nextCustomTemplates.walletCards).length === 0) {
          delete nextCustomTemplates.walletCards;
        }

        const nextMetadata = {
          ...currentMetadata,
          imported_assets: nextAssets,
          template_designs: nextTemplateDesigns,
          custom_templates: nextCustomTemplates,
        };

        const { error: metadataError } = await adminClient.auth.admin.updateUserById(
          existingUser.id,
          { user_metadata: nextMetadata }
        );

        if (metadataError) throw metadataError;

        let importedQuizCount = 0;

        const sourceUsers = await getUsersByEmails(
          adminClient,
          legacyQuizOwnerEmails
        );

        if (nextAssets.quizzes) {
          importedQuizCount = await copyQuizzesFromUsers(
            adminClient,
            sourceUsers,
            existingUser.id
          );
        }

        if (!nextAssets.quizzes) {
          await removeSavedLibraryCopiesFromUsers(
            adminClient,
            sourceUsers,
            existingUser.id
          );
        }

        return jsonResponse(200, {
          users: await listUsers(adminClient),
          importedQuizCount,
        });
      }

      const password = normalizePassword(body.password);

      if (password.length < 6) {
        return jsonResponse(400, { error: 'Password must be at least 6 characters.' });
      }

      const { error } = await adminClient.auth.admin.updateUserById(
        existingUser.id,
        { password }
      );

      if (error) throw error;

      return jsonResponse(200, { users: await listUsers(adminClient) });
    }

    if (event.httpMethod === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      const userId = String(body.userId || '').trim();

      if (!userId) {
        return jsonResponse(400, { error: 'User id is required.' });
      }

      if (userId === user.id) {
        return jsonResponse(400, { error: 'You cannot delete your own login.' });
      }

      await deleteOwnedData(adminClient, userId);

      const { error } = await adminClient.auth.admin.deleteUser(userId);

      if (error) throw error;

      return jsonResponse(200, { users: await listUsers(adminClient) });
    }

    return jsonResponse(405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error('Instructor users function error:', error);
    return jsonResponse(500, {
      error: error?.message || 'Unable to manage instructor emails.',
    });
  }
}
