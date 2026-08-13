export const HISTORICAL_STUDENT_COPY_FIELDS = [
  'student_name',
  'student_email',
  'company',
  'signature_path',
  'photo_path',
  'signed_at',
];

export function validateHistoricalClassInfo(classInfo) {
  const required = [
    ['courseName', 'Course name'],
    ['trainingDate', 'Actual training date'],
    ['startTime', 'Actual start time'],
    ['endTime', 'Actual end time'],
    ['trainerName', 'Trainer'],
    ['companyName', 'Company'],
    ['location', 'Location'],
  ];
  const errors = required
    .filter(([key]) => !String(classInfo?.[key] || '').trim())
    .map(([, label]) => `${label} is required.`);
  if (classInfo?.trainingDate && classInfo.trainingDate > new Date().toISOString().slice(0, 10)) {
    errors.push('Actual training date cannot be in the future.');
  }
  if (classInfo?.startTime && classInfo?.endTime && classInfo.endTime <= classInfo.startTime) {
    errors.push('Actual end time must be after the start time.');
  }
  return errors;
}

export function getStudentWarnings(students) {
  const counts = new Map();
  students.forEach((student) => {
    const key = String(student.student_email || student.student_name || '').trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return new Map(students.map((student) => {
    const warnings = [];
    const email = String(student.student_email || '').trim();
    const key = String(email || student.student_name || '').trim().toLowerCase();
    if (!email || !email.includes('@')) warnings.push('Missing or invalid email');
    if (key && counts.get(key) > 1) warnings.push('Possible duplicate student');
    if (student.already_in_proposed_class) warnings.push('Already associated with proposed class');
    return [student.id, warnings];
  }));
}

export function selectBasicStudentFields(student) {
  return {
    student_name: String(student?.student_name || '').trim(),
    student_email: String(student?.student_email || '').trim(),
    company: String(student?.company || '').trim(),
    signature_path: student?.signature_path || null,
    photo_path: student?.photo_path || null,
    signed_at: student?.signed_at || null,
  };
}

function historicalDateTimeToIso(date, time, timezoneOffsetMinutes) {
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset) || Math.abs(offset) > 14 * 60) {
    return `${date}T${time}:00`;
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute) + offset * 60_000
  ).toISOString();
}

export function buildHistoricalClassDraft({
  classInfo,
  sourceSession,
  selectedStudents,
  createdBy,
  idempotencyKey,
}) {
  const studentIds = selectedStudents.map((student) => student.id);
  if (new Set(studentIds).size !== studentIds.length) {
    throw new Error('The same source student was selected more than once.');
  }
  return {
    idempotency_key: idempotencyKey,
    class: {
      course_name: String(classInfo.courseName || '').trim(),
      training_date: classInfo.trainingDate,
      time_started: historicalDateTimeToIso(
        classInfo.trainingDate,
        classInfo.startTime,
        classInfo.timezoneOffsetMinutes
      ),
      time_stopped: historicalDateTimeToIso(
        classInfo.trainingDate,
        classInfo.endTime,
        classInfo.timezoneOffsetMinutes
      ),
      trainer_name: String(classInfo.trainerName || '').trim(),
      trainer_signature_url: classInfo.trainerSignatureDataUrl || null,
      company_name: String(classInfo.companyName || '').trim(),
      training_location: String(classInfo.location || '').trim(),
      course_outline: String(classInfo.courseOutline || '').trim(),
      is_historical_entry: true,
      historical_source_session_id: sourceSession.id,
      historical_entry_reason: 'Historical class entry',
      historical_created_by: createdBy.id,
    },
    source: {
      session_id: sourceSession.id,
      course_name: sourceSession.course_name,
      training_date: sourceSession.training_date,
    },
    selected_source_attendance_ids: studentIds,
    students: selectedStudents.map(selectBasicStudentFields),
    copy_fields: [...HISTORICAL_STUDENT_COPY_FIELDS],
    // Database defaults, not the historical training date, own created_at.
    created_at: null,
  };
}
