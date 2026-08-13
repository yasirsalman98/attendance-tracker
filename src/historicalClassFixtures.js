function makeStudent(index) {
  const number = index + 1;
  return {
    id: `fixture-attendance-${String(number).padStart(3, '0')}`,
    student_name: `Fixture Student ${number}`,
    student_email: `fixture.student.${number}@example.test`,
    company: number % 3 === 0 ? 'Example Industrial' : 'Example Safety',
    employee_identifier: `EMP-${String(number).padStart(4, '0')}`,
    signature_path: `forbidden/signature-${number}.png`,
    photo_path: `forbidden/photo-${number}.jpg`,
    signed_at: '2025-01-15T14:00:00Z',
    created_at: '2025-01-15T14:00:00Z',
    quiz_completed: true,
    archive_source: null,
  };
}

const largeRoster = Array.from({ length: 116 }, (_, index) => makeStudent(index));
largeRoster[7] = { ...largeRoster[7], student_email: '' };
largeRoster[18] = {
  ...largeRoster[18],
  student_email: largeRoster[17].student_email,
};
largeRoster[42] = { ...largeRoster[42], already_in_proposed_class: true };

export const HISTORICAL_CLASS_FIXTURE_SESSIONS = [
  {
    id: 'fixture-session-116',
    course_name: 'Fall Protection — Local Review Fixture',
    training_date: '2025-01-15',
    trainer_name: 'Fixture Trainer',
    company_name: 'Example Safety',
    training_location: 'Raleigh Training Room',
    time_started: '2025-01-15T13:00:00Z',
    time_stopped: '2025-01-15T17:00:00Z',
    student_count: 116,
  },
  {
    id: 'fixture-session-small',
    course_name: 'First Aid — Local Review Fixture',
    training_date: '2025-03-20',
    trainer_name: 'Fixture Administrator',
    company_name: 'Example Industrial',
    training_location: 'Mock Classroom B',
    time_started: '2025-03-20T12:00:00Z',
    time_stopped: '2025-03-20T16:00:00Z',
    student_count: 8,
  },
];

export const HISTORICAL_CLASS_FIXTURE_STUDENTS = {
  'fixture-session-116': largeRoster,
  'fixture-session-small': Array.from({ length: 8 }, (_, index) => makeStudent(index)),
};
