export const SETTINGS_ADMIN_EMAIL = 'excourse7233@gmail.com';
const ADMIN_QUIZ_OWNER_EMAILS = new Set([
  SETTINGS_ADMIN_EMAIL,
  'excourse7233@exceedsafety.com',
]);

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isSettingsAdminUser(user) {
  return normalizeEmail(user?.email) === SETTINGS_ADMIN_EMAIL;
}

export function getImportedAssets(user) {
  return user?.user_metadata?.imported_assets || {};
}

export function isExCourseFeatureUser(user) {
  if (isSettingsAdminUser(user)) return false;

  const importedAssets = getImportedAssets(user);
  const templateDesigns = user?.user_metadata?.template_designs || {};
  const hasExCourseWalletCards =
    importedAssets.walletCards &&
    (templateDesigns.walletCardDesign || 'excourse') === 'excourse';
  const hasExCourseCertificate =
    importedAssets.certificateTemplate &&
    (templateDesigns.certificateDesign || 'excourse') === 'excourse';

  return Boolean(
    importedAssets.savedQuizResults ||
      hasExCourseWalletCards ||
      hasExCourseCertificate
  );
}

export function canUseSavedQuizLibrary(user) {
  return (
    isSettingsAdminUser(user) ||
    (Boolean(getImportedAssets(user).quizzes) && !isExCourseFeatureUser(user))
  );
}

export function canLoadSavedQuizQuestions(user) {
  return isSettingsAdminUser(user) || Boolean(getImportedAssets(user).quizzes);
}

export function canDeleteSavedQuizResults(user) {
  return isSettingsAdminUser(user) || !isExCourseFeatureUser(user);
}

export function getSavedQuizDraftLabel(quiz) {
  const ownerEmail = normalizeEmail(quiz?.owner_email);

  return ownerEmail && !ADMIN_QUIZ_OWNER_EMAILS.has(ownerEmail) ? 'Copy' : 'Draft';
}
