import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import SignaturePad from 'signature_pad';
import {
  buildHistoricalClassDraft,
  getStudentWarnings,
  HISTORICAL_STUDENT_COPY_FIELDS,
  validateHistoricalClassInfo,
} from '../historicalClassModel';
import {
  createHistoricalClass,
  createHistoricalClassFixture,
  loadHistoricalSourceStudents,
  searchHistoricalSourceClasses,
} from '../historicalClassLocalService';
import './HistoricalClass.css';

const ROSTER_PAGE_SIZE = 25;
const initialClassInfo = {
  courseName: '',
  trainingDate: '',
  startTime: '',
  endTime: '',
  trainerName: '',
  companyName: '',
  location: '',
  courseOutline: '',
};

function makeIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}`;
}

function Field({ label, children }) {
  return <label className="historical-field"><span>{label}</span>{children}</label>;
}

export default function CreateHistoricalClass({ session }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [classInfo, setClassInfo] = useState(initialClassInfo);
  const [errors, setErrors] = useState([]);
  const [sourceSearch, setSourceSearch] = useState('');
  const [sourcePage, setSourcePage] = useState(1);
  const [sourceResult, setSourceResult] = useState({ sessions: [], total: 0, pageSize: 10 });
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [selectedSource, setSelectedSource] = useState(null);
  const [sourceStudents, setSourceStudents] = useState([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentSearch, setStudentSearch] = useState('');
  const [studentPage, setStudentPage] = useState(1);
  const [selectedStudentIds, setSelectedStudentIds] = useState(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [hasTrainerSignature, setHasTrainerSignature] = useState(false);
  const [trainerSignatureDataUrl, setTrainerSignatureDataUrl] = useState('');
  const [trainerSignatureError, setTrainerSignatureError] = useState('');
  const trainerSignatureCanvasRef = useRef(null);
  const trainerSignaturePadRef = useRef(null);
  const idempotencyKeyRef = useRef(makeIdempotencyKey());
  const isPrivateLocalTest = import.meta.env.DEV &&
    ['localhost', '127.0.0.1'].includes(window.location.hostname);

  useEffect(() => {
    let active = true;
    searchHistoricalSourceClasses({
      accessToken: session.access_token,
      search: sourceSearch,
      page: sourcePage,
    })
      .then((next) => {
        if (!active) return;
        setSourceResult(next);
        setErrors([]);
      })
      .catch((error) => active && setErrors([error.message || 'Unable to load source classes.']))
      .finally(() => active && setSourcesLoading(false));
    return () => { active = false; };
  }, [session.access_token, sourceSearch, sourcePage]);

  useEffect(() => {
    if (step !== 1 || !trainerSignatureCanvasRef.current) return undefined;
    const canvas = trainerSignatureCanvasRef.current;
    const ratio = Math.max(globalThis.devicePixelRatio || 1, 1);
    const width = Math.max(canvas.parentElement?.clientWidth || 600, 1);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(170 * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = '170px';
    canvas.getContext('2d')?.scale(ratio, ratio);
    const pad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)',
    });
    trainerSignaturePadRef.current = pad;
    const handleEnd = () => {
      setHasTrainerSignature(!pad.isEmpty());
      setTrainerSignatureDataUrl('');
      setTrainerSignatureError('');
    };
    pad.addEventListener('endStroke', handleEnd);
    if (trainerSignatureDataUrl) {
      pad.fromDataURL(trainerSignatureDataUrl)
        .then(() => pad.off())
        .catch(() => undefined);
    }
    return () => {
      pad.removeEventListener('endStroke', handleEnd);
      pad.off();
      trainerSignaturePadRef.current = null;
    };
  }, [step, trainerSignatureDataUrl]);

  const warningsByStudentId = useMemo(
    () => getStudentWarnings(sourceStudents),
    [sourceStudents]
  );
  const filteredStudents = useMemo(() => {
    const needle = studentSearch.trim().toLowerCase();
    if (!needle) return sourceStudents;
    return sourceStudents.filter((student) =>
      [student.student_name, student.student_email, student.company]
        .some((value) => String(value || '').toLowerCase().includes(needle))
    );
  }, [sourceStudents, studentSearch]);
  const rosterPageCount = Math.max(1, Math.ceil(filteredStudents.length / ROSTER_PAGE_SIZE));
  const sourcePageCount = Math.max(1, Math.ceil(sourceResult.total / sourceResult.pageSize));
  const visibleStudents = filteredStudents.slice(
    (studentPage - 1) * ROSTER_PAGE_SIZE,
    studentPage * ROSTER_PAGE_SIZE
  );
  const selectedStudents = sourceStudents.filter((student) => selectedStudentIds.has(student.id));
  const selectedWarnings = selectedStudents.flatMap((student) =>
    (warningsByStudentId.get(student.id) || []).map((warning) =>
      `${student.student_name}: ${warning}`
    )
  );

  function updateClassInfo(key, value) {
    setClassInfo((current) => ({ ...current, [key]: value }));
  }

  function continueFromClassInfo() {
    const nextErrors = validateHistoricalClassInfo(classInfo);
    if (!trainerSignatureDataUrl) nextErrors.push('Accept the trainer signature before continuing.');
    setErrors(nextErrors);
    if (nextErrors.length === 0) setStep(2);
  }

  function acceptTrainerSignature() {
    const pad = trainerSignaturePadRef.current;
    if (!pad || pad.isEmpty()) {
      setTrainerSignatureError('Sign in the box before accepting.');
      return;
    }
    setTrainerSignatureDataUrl(pad.toDataURL('image/png'));
    setHasTrainerSignature(true);
    setTrainerSignatureError('');
    pad.off();
  }

  function clearTrainerSignature() {
    trainerSignaturePadRef.current?.clear();
    trainerSignaturePadRef.current?.on();
    setHasTrainerSignature(false);
    setTrainerSignatureDataUrl('');
    setTrainerSignatureError('');
  }

  async function selectSource(sessionSummary) {
    setSelectedSource(sessionSummary);
    setStudentsLoading(true);
    setErrors([]);
    try {
      const students = await loadHistoricalSourceStudents(sessionSummary.id, session.access_token);
      setSourceStudents(students);
      setSelectedStudentIds(new Set(students.map((student) => student.id)));
      setStudentSearch('');
      setStudentPage(1);
      setStep(3);
    } catch (error) {
      setErrors([error.message || 'Unable to load source students.']);
    } finally {
      setStudentsLoading(false);
    }
  }

  function toggleStudent(studentId) {
    setSelectedStudentIds((current) => {
      const next = new Set(current);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }

  function continueFromStudents() {
    const nextErrors = [];
    if (selectedStudents.length === 0) nextErrors.push('Select at least one student.');
    if (selectedWarnings.length > 0) {
      nextErrors.push('Deselect students with duplicate, missing-email, or existing-record warnings before creation.');
    }
    setErrors(nextErrors);
    if (nextErrors.length === 0) setStep(4);
  }

  function getDraft() {
    const localTrainingDate = new Date(`${classInfo.trainingDate}T${classInfo.startTime}:00`);
    return buildHistoricalClassDraft({
      classInfo: {
        ...classInfo,
        trainerSignatureDataUrl,
        timezoneOffsetMinutes: localTrainingDate.getTimezoneOffset(),
      },
      sourceSession: selectedSource,
      selectedStudents,
      createdBy: {
        id: session.user.id,
        email: session.user.email,
      },
      idempotencyKey: idempotencyKeyRef.current,
    });
  }

  async function createLocalHistoricalClass() {
    if (submitting) return;
    setSubmitting(true);
    setErrors([]);
    try {
      const draft = getDraft();
      const response = isPrivateLocalTest
        ? await createHistoricalClassFixture(draft)
        : await createHistoricalClass({
            accessToken: session.access_token,
            payload: {
              classInfo: {
                ...classInfo,
                trainerSignatureDataUrl,
                timezoneOffsetMinutes: new Date(
                  `${classInfo.trainingDate}T${classInfo.startTime}:00`
                ).getTimezoneOffset(),
              },
              sourceSessionId: selectedSource.id,
              selectedSourceAttendanceIds: draft.selected_source_attendance_ids,
              idempotencyKey: idempotencyKeyRef.current,
            },
          });
      setResult(response);
      if (isPrivateLocalTest) navigate('/records-7392');
    } catch (error) {
      setErrors([error.message || 'Local historical-class request failed.']);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="historical-page">
      <div className="historical-card">
        <div className="historical-heading">
          <div>
            <p className="eyebrow">Administrative workflow</p>
            <h1>Create Historical Class</h1>
            <p>Create a past class and carry over the selected students' attendance information.</p>
          </div>
        </div>

        <ol className="historical-steps" aria-label="Historical class steps">
          {['Class information', 'Source class', 'Students', 'Final review'].map((label, index) => (
            <li className={step === index + 1 ? 'is-current' : step > index + 1 ? 'is-complete' : ''} key={label}>
              <span>{index + 1}</span>{label}
            </li>
          ))}
        </ol>

        {errors.length > 0 && (
          <div className="historical-alert" role="alert">
            <strong>Review required</strong>
            <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
          </div>
        )}

        {step === 1 && (
          <div className="historical-step-panel">
            <h2>1. Enter the class information</h2>
            <div className="historical-form-grid">
              <Field label="Course name"><input value={classInfo.courseName} onChange={(e) => updateClassInfo('courseName', e.target.value)} /></Field>
              <Field label="Actual training date"><input type="date" max={new Date().toISOString().slice(0, 10)} value={classInfo.trainingDate} onChange={(e) => updateClassInfo('trainingDate', e.target.value)} /></Field>
              <Field label="Actual start time"><input type="time" value={classInfo.startTime} onChange={(e) => updateClassInfo('startTime', e.target.value)} /></Field>
              <Field label="Actual end time"><input type="time" value={classInfo.endTime} onChange={(e) => updateClassInfo('endTime', e.target.value)} /></Field>
              <Field label="Trainer"><input value={classInfo.trainerName} onChange={(e) => updateClassInfo('trainerName', e.target.value)} /></Field>
              <div className="historical-signature-field">
                <strong>Trainer signature</strong>
                <div className={`historical-signature-box${trainerSignatureDataUrl ? ' is-accepted' : ''}`}>
                  <canvas ref={trainerSignatureCanvasRef} aria-label="Trainer signature pad" />
                </div>
                <div className="historical-signature-actions">
                  <button type="button" onClick={acceptTrainerSignature}>Accept Signature</button>
                  <button type="button" className="secondary-button" onClick={clearTrainerSignature} disabled={!hasTrainerSignature && !trainerSignatureDataUrl}>Remove Signature</button>
                </div>
                {trainerSignatureDataUrl && <span className="historical-signature-success">Signature accepted.</span>}
                {trainerSignatureError && <span className="historical-warning">{trainerSignatureError}</span>}
              </div>
              <Field label="Company"><input value={classInfo.companyName} onChange={(e) => updateClassInfo('companyName', e.target.value)} /></Field>
              <Field label="Location"><input value={classInfo.location} onChange={(e) => updateClassInfo('location', e.target.value)} /></Field>
              <Field label="Course outline"><textarea rows="3" value={classInfo.courseOutline} onChange={(e) => updateClassInfo('courseOutline', e.target.value)} /></Field>
            </div>
            <div className="historical-actions"><Link to="/instructor-7392" className="secondary-link-button">Cancel</Link><button type="button" onClick={continueFromClassInfo}>Continue</button></div>
          </div>
        )}

        {step === 2 && (
          <div className="historical-step-panel">
            <h2>2. Select the source class</h2>
            <p className="historical-note">All available attendance classes are loaded as lightweight summaries. Students, signatures, photos, and quiz results are not loaded here.</p>
            <input type="search" placeholder="Search course, date, trainer, company, or location" value={sourceSearch} onChange={(e) => { setSourcesLoading(true); setSourceSearch(e.target.value); setSourcePage(1); }} />
            <div className="historical-source-list">
              {sourceResult.sessions.map((source) => (
                <button type="button" className="historical-source-card" key={source.id} onClick={() => selectSource(source)} disabled={studentsLoading}>
                  <strong>{source.course_name}</strong>
                  <span>{source.training_date} · {source.trainer_name}</span>
                  <span>{source.company_name} · {source.training_location}</span>
                  <span>{source.student_count} students</span>
                </button>
              ))}
            </div>
            {sourcesLoading && <p className="historical-note" role="status">Loading attendance classes...</p>}
            {!sourcesLoading && sourceResult.sessions.length === 0 && <p className="historical-note">No attendance classes match this search.</p>}
            {studentsLoading && <p className="historical-note" role="status">Loading the selected source roster...</p>}
            <div className="historical-pagination"><button type="button" className="secondary-button" disabled={sourcePage === 1 || sourcesLoading} onClick={() => { setSourcesLoading(true); setSourcePage((value) => value - 1); }}>Previous</button><span>Page {sourcePage} of {sourcePageCount}</span><button type="button" className="secondary-button" disabled={sourcePage >= sourcePageCount || sourcesLoading} onClick={() => { setSourcesLoading(true); setSourcePage((value) => value + 1); }}>Next</button></div>
            <div className="historical-actions"><button type="button" className="secondary-button" onClick={() => setStep(1)}>Back</button></div>
          </div>
        )}

        {step === 3 && selectedSource && (
          <div className="historical-step-panel">
            <h2>3. Preview and select students</h2>
            <div className="historical-selected-source"><strong>{selectedSource.course_name}</strong><span>{selectedSource.training_date} · {selectedSource.trainer_name}</span><span>{selectedSource.student_count} source students</span></div>
            <div className="historical-roster-toolbar">
              <input type="search" placeholder="Search students" value={studentSearch} onChange={(e) => { setStudentSearch(e.target.value); setStudentPage(1); }} />
              <button type="button" className="secondary-button" onClick={() => setSelectedStudentIds(new Set(sourceStudents.map((student) => student.id)))}>Select all</button>
              <button type="button" className="secondary-button" onClick={() => setSelectedStudentIds(new Set())}>Clear all</button>
              <strong>{selectedStudents.length} selected</strong>
            </div>
            <div className="historical-roster-table" role="region" aria-label="Source student roster" tabIndex="0">
              <table>
                <thead><tr><th>Select</th><th>Student</th><th>Email</th><th>Company</th><th>Warnings</th></tr></thead>
                <tbody>{visibleStudents.map((student) => (
                  <tr key={student.id}>
                    <td><input type="checkbox" aria-label={`Select ${student.student_name}`} checked={selectedStudentIds.has(student.id)} onChange={() => toggleStudent(student.id)} /></td>
                    <td>{student.student_name}</td><td>{student.student_email || 'Missing'}</td><td>{student.company || 'N/A'}</td>
                    <td>{(warningsByStudentId.get(student.id) || []).map((warning) => <span className="historical-warning" key={warning}>{warning}</span>)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="historical-pagination"><button type="button" className="secondary-button" disabled={studentPage === 1} onClick={() => setStudentPage((value) => value - 1)}>Previous</button><span>Page {studentPage} of {rosterPageCount}</span><button type="button" className="secondary-button" disabled={studentPage >= rosterPageCount} onClick={() => setStudentPage((value) => value + 1)}>Next</button></div>

            <div className="historical-actions"><button type="button" className="secondary-button" onClick={() => setStep(2)}>Back</button><button type="button" onClick={continueFromStudents}>Review historical class</button></div>
          </div>
        )}

        {step === 4 && selectedSource && (
          <div className="historical-step-panel">
            <h2>4. Final review</h2>
            <div className="historical-badges"><span>Historical Entry</span></div>
            <dl className="historical-review-grid">
              <div><dt>Course</dt><dd>{classInfo.courseName}</dd></div><div><dt>Actual Training Date</dt><dd>{classInfo.trainingDate}</dd></div>
              <div><dt>Actual Time</dt><dd>{classInfo.startTime}–{classInfo.endTime}</dd></div><div><dt>Record Created At</dt><dd>Actual submission time (not backdated)</dd></div>
              <div><dt>Trainer</dt><dd>{classInfo.trainerName}</dd></div><div><dt>Company</dt><dd>{classInfo.companyName}</dd></div>
              <div><dt>Location</dt><dd>{classInfo.location}</dd></div><div><dt>Created by</dt><dd>{session.user.email}</dd></div>
              <div><dt>Source class</dt><dd>{selectedSource.course_name} · {selectedSource.training_date}</dd></div><div><dt>Students selected</dt><dd>{selectedStudents.length}</dd></div>
            </dl>
            <div className="historical-copy-review"><div><h3>Student information copied from the source class</h3><ul>{HISTORICAL_STUDENT_COPY_FIELDS.map((field) => <li key={field}>{field.replaceAll('_', ' ')}</li>)}</ul></div></div>
            <details><summary>Selected students ({selectedStudents.length})</summary><div className="historical-review-students">{selectedStudents.map((student) => <span key={student.id}>{student.student_name} · {student.student_email}</span>)}</div></details>
            {result && <div className="historical-success" role="status"><strong>Historical class preview completed</strong><span>Created at: {new Date(result.createdAt).toLocaleString()}</span>{result.repeated && <span>Repeated submission returned the original result.</span>}<Link to="/records-7392">View Attendance Records</Link></div>}
            <div className="historical-actions"><button type="button" className="secondary-button" onClick={() => setStep(3)}>Back</button><button type="button" disabled={Boolean(result) || submitting || selectedWarnings.length > 0} onClick={createLocalHistoricalClass}>{submitting ? 'Creating historical class...' : 'Create Historical Class'}</button></div>
          </div>
        )}
      </div>
    </section>
  );
}
