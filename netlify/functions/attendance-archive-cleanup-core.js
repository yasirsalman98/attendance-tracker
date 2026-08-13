export const STUDENT_ARCHIVE_SOURCE = 'deleted_student';
export const CLASS_ARCHIVE_SOURCE = 'archived_class';

export function isDeadlineExpired(value, now = new Date()) {
  const deadline = new Date(value || 0);
  return Number.isFinite(deadline.getTime()) && deadline.getTime() <= now.getTime();
}

export function isStudentArchive(record, now = new Date()) {
  return Boolean(
    record?.archived_at &&
      isDeadlineExpired(record.archive_delete_after, now) &&
      (record.archive_type === 'student' ||
        (!record.archive_type && record.archive_source === STUDENT_ARCHIVE_SOURCE))
  );
}

export function isClassArchive(session, now = new Date()) {
  return Boolean(
    session?.attendance_archived_at &&
      session.attendance_archive_type === 'class' &&
      isDeadlineExpired(session.attendance_archive_delete_after, now)
  );
}

export function purgeControls(environment = process.env) {
  const enabled = environment.ARCHIVE_PURGE_ENABLED === 'true';
  const backupVerifiedAt = new Date(environment.ARCHIVE_BACKUP_VERIFIED_AT || '');
  const backupVerified = Number.isFinite(backupVerifiedAt.getTime());

  return {
    enabled: enabled && backupVerified,
    requested: enabled,
    backupVerified,
  };
}

export function privacySafeErrorCode(error) {
  return String(error?.code || error?.name || 'cleanup_failed')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}
