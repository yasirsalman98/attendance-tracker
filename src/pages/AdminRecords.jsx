import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';

function formatDateTime(value) {
  if (!value) return 'N/A';

  return new Date(value).toLocaleString();
}

function formatTime(value) {
  if (!value) return 'N/A';

  return new Date(value).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatAccuracy(value) {
  return value ? `${Math.round(value)} meters` : 'N/A';
}

function getSessionValue(session, key) {
  return session?.[key] || 'N/A';
}

function getDownloadFileName(contentDisposition, fallbackName) {
  const match = contentDisposition?.match(/filename="?([^"]+)"?/i);
  return match?.[1] || fallbackName;
}

function cleanFileName(value, fallback = 'student-photo') {
  const cleaned = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return cleaned || fallback;
}

function groupRecordsBySession(records) {
  const groupsById = new Map();
  const unassignedRecords = [];

  records.forEach((record) => {
    const session = record.training_sessions;

    if (!record.training_session_id || !session) {
      unassignedRecords.push(record);
      return;
    }

    if (!groupsById.has(record.training_session_id)) {
      groupsById.set(record.training_session_id, {
        id: record.training_session_id,
        session,
        records: [],
      });
    }

    groupsById.get(record.training_session_id).records.push(record);
  });

  const sessionGroups = Array.from(groupsById.values()).sort((a, b) => {
    const dateA = a.session?.training_date || '';
    const dateB = b.session?.training_date || '';
    return dateB.localeCompare(dateA);
  });

  if (unassignedRecords.length > 0) {
    sessionGroups.push({
      id: 'unassigned',
      session: null,
      records: unassignedRecords,
      title: 'Unassigned Attendance Records',
    });
  }

  return sessionGroups;
}

function SignaturePreview({ record, onError }) {
  const [signatureUrl, setSignatureUrl] = useState(record.signature_url || '');
  const [isLoading, setIsLoading] = useState(Boolean(record.signature_path));

  useEffect(() => {
    let isActive = true;

    async function loadSignatureUrl() {
      if (!record.signature_path) {
        setSignatureUrl(record.signature_url || '');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await supabase.storage
        .from('signatures')
        .createSignedUrl(record.signature_path, 300);

      if (!isActive) return;

      if (error || !data?.signedUrl) {
        console.error('Signature signed URL error:', error);
        setSignatureUrl(record.signature_url || '');
        setIsLoading(false);

        if (!record.signature_url) {
          onError('Unable to load student signature.');
        }

        return;
      }

      setSignatureUrl(data.signedUrl);
      setIsLoading(false);
    }

    loadSignatureUrl();

    return () => {
      isActive = false;
    };
  }, [record.signature_path, record.signature_url, onError]);

  if (isLoading) {
    return <span className="muted">Loading...</span>;
  }

  if (!signatureUrl) {
    return 'N/A';
  }

  return (
    <img
      src={signatureUrl}
      alt={`Signature for ${record.student_name}`}
      className="signature-preview"
    />
  );
}

function StudentPhotoThumbnail({ record, onOpen, onError }) {
  const [photoUrl, setPhotoUrl] = useState('');
  const [isLoading, setIsLoading] = useState(Boolean(record.photo_path));

  useEffect(() => {
    let isActive = true;

    async function loadPhotoUrl() {
      if (!record.photo_path) {
        setPhotoUrl('');
        setIsLoading(false);
        return;
      }

      setIsLoading(true);

      const { data, error } = await supabase.storage
        .from('attendance-photos')
        .createSignedUrl(record.photo_path, 300);

      if (!isActive) return;

      if (error || !data?.signedUrl) {
        console.error('Photo signed URL error:', error);
        setPhotoUrl('');
        setIsLoading(false);
        onError('Unable to load student photo.');
        return;
      }

      setPhotoUrl(data.signedUrl);
      setIsLoading(false);
    }

    loadPhotoUrl();

    return () => {
      isActive = false;
    };
  }, [record.photo_path, onError]);

  if (!record.photo_path) {
    return 'N/A';
  }

  if (isLoading) {
    return <span className="muted">Loading...</span>;
  }

  if (!photoUrl) {
    return 'N/A';
  }

  const altText = `Photo for ${record.student_name}`;

  return (
    <button
      type="button"
      className="student-photo-button"
      onClick={() => onOpen(photoUrl, altText, record.student_name)}
      aria-label={`Open ${altText}`}
    >
      <img src={photoUrl} alt={altText} className="student-photo-thumbnail" />
    </button>
  );
}

export default function AdminRecords() {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState('Loading records...');
  const [deletingId, setDeletingId] = useState(null);
  const [generatingCertificatesId, setGeneratingCertificatesId] = useState(null);
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('');
  const [selectedPhotoAlt, setSelectedPhotoAlt] = useState('');
  const [selectedPhotoFileName, setSelectedPhotoFileName] = useState('');
  const [photoModalError, setPhotoModalError] = useState('');

  const groupedRecords = useMemo(() => groupRecordsBySession(records), [records]);
  const handleMediaLoadError = useCallback((message) => {
    setPhotoModalError(message);
    setStatus(message);
  }, []);

  function openPhotoModal(photoUrl, altText, studentName) {
    setPhotoModalError('');
    setSelectedPhotoUrl(photoUrl);
    setSelectedPhotoAlt(altText);
    setSelectedPhotoFileName(`${cleanFileName(studentName)}-photo.jpg`);
  }

  function closePhotoModal() {
    setSelectedPhotoUrl('');
    setSelectedPhotoAlt('');
    setSelectedPhotoFileName('');
    setPhotoModalError('');
  }

  async function downloadSelectedPhoto() {
    if (!selectedPhotoUrl) return;

    try {
      const response = await fetch(selectedPhotoUrl);

      if (!response.ok) {
        throw new Error('Photo download failed.');
      }

      const blob = await response.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = objectUrl;
      link.download = selectedPhotoFileName || 'student-photo.jpg';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error('Photo download error:', error);
      setPhotoModalError('Unable to download student photo.');
      setStatus('Unable to download student photo.');
    }
  }

  async function loadRecords() {
    setStatus('Loading records...');
    setPhotoModalError('');

    const result = await supabase
      .from('attendance_records')
      .select(`
        *,
        training_sessions (*)
      `)
      .order('signed_at', { ascending: false });

    if (result.error) {
      console.error(result.error);
      setStatus(result.error.message);
      return;
    }

    setRecords(result.data || []);
    setStatus('');
  }

  async function deleteRecord(record) {
    const confirmed = window.confirm(
      `Delete attendance record for ${record.student_name}? This cannot be undone.`
    );

    if (!confirmed) {
      return;
    }

    setDeletingId(record.id);
    setStatus('');

    try {
      if (record.signature_path) {
        const storageResult = await supabase.storage
          .from('signatures')
          .remove([record.signature_path]);

        if (storageResult.error) {
          throw storageResult.error;
        }
      }

      const deleteResult = await supabase
        .from('attendance_records')
        .delete()
        .eq('id', record.id);

      if (deleteResult.error) {
        throw deleteResult.error;
      }

      setRecords((currentRecords) =>
        currentRecords.filter((currentRecord) => currentRecord.id !== record.id)
      );

      setStatus('Record deleted successfully.');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Failed to delete record.');
    } finally {
      setDeletingId(null);
    }
  }

  async function downloadSessionCertificates(group) {
    if (group.id === 'unassigned') return;

    if (group.records.length === 0) {
      setStatus('No students found for this session.');
      return;
    }

    setStatus('');
    setGeneratingCertificatesId(group.id);

    try {
      const response = await fetch(
        `/.netlify/functions/certificates-session?sessionId=${group.id}`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) {
        const contentType = response.headers.get('Content-Type') || '';
        const errorData = contentType.includes('application/json')
          ? await response.json().catch(() => null)
          : null;

        throw new Error(
          errorData?.error ||
            'Certificate download failed. Please check Netlify function logs.'
        );
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const contentDisposition = response.headers.get('Content-Disposition');
      const fallbackFileName = 'certificates.zip';
      const link = document.createElement('a');

      link.href = url;
      link.download = getDownloadFileName(contentDisposition, fallbackFileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      const message =
        error instanceof TypeError
          ? 'Certificate download failed. Please check Netlify function logs.'
          : error.message || 'Failed to generate certificates.';

      setStatus(message);
    } finally {
      setGeneratingCertificatesId(null);
    }
  }

  useEffect(() => {
    loadRecords();
  }, []);

  return (
    <section className="card">
      <div className="admin-header">
        <div>
          <h2>Admin Attendance Records</h2>
          <p className="muted">View submitted student attendance records.</p>
        </div>

        <div className="admin-actions">
          <button type="button" className="secondary-button" onClick={loadRecords}>
            Refresh
          </button>
        </div>
      </div>

      {(status || photoModalError) && (
        <p className="status">{status || photoModalError}</p>
      )}

      {!status && records.length === 0 && (
        <p className="muted">No attendance records found yet.</p>
      )}

      {groupedRecords.length > 0 && (
        <div className="session-records-list">
          {groupedRecords.map((group) => (
            <section className="session-record-card" key={group.id}>
              <div className="session-record-top-row">
                <h3>{group.title || getSessionValue(group.session, 'course_name')}</h3>

                <div className="session-card-actions">
                  {group.id !== 'unassigned' && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => downloadSessionCertificates(group)}
                      disabled={
                        group.records.length === 0 ||
                        generatingCertificatesId === group.id
                      }
                    >
                      {generatingCertificatesId === group.id
                        ? 'Generating certificates...'
                        : 'Download Certificates'}
                    </button>
                  )}
                </div>
              </div>

              <dl className="session-meta">
                <div>
                  <dt>Training Date</dt>
                  <dd>{getSessionValue(group.session, 'training_date')}</dd>
                </div>

                <div>
                  <dt>Trainer</dt>
                  <dd>{getSessionValue(group.session, 'trainer_name')}</dd>
                </div>

                <div>
                  <dt>Company</dt>
                  <dd>{getSessionValue(group.session, 'company_name')}</dd>
                </div>

                <div>
                  <dt>Location</dt>
                  <dd>{getSessionValue(group.session, 'training_location')}</dd>
                </div>

                <div>
                  <dt>Time Started</dt>
                  <dd>{formatTime(group.session?.time_started)}</dd>
                </div>

                <div>
                  <dt>Class End Time</dt>
                  <dd>{formatTime(group.session?.time_stopped)}</dd>
                </div>

                <div>
                  <dt>Expires At</dt>
                  <dd>{formatDateTime(group.session?.expires_at)}</dd>
                </div>

                <div>
                  <dt>Total Students</dt>
                  <dd>{group.records.length}</dd>
                </div>
              </dl>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Student Name</th>
                      <th>Email</th>
                      <th>Company</th>
                      <th>Signed Date/Time</th>
                      <th>Latitude</th>
                      <th>Longitude</th>
                      <th>Accuracy</th>
                      <th>Signature</th>
                      <th>Photo</th>
                      <th>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {group.records.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <div>{record.student_name}</div>

                          {record.is_suspicious && (
                            <div className="suspicious-warning">
                              <span className="suspicious-icon" aria-hidden="true">
                                ⚠
                              </span>

                              <div className="suspicious-copy">
                                <div className="suspicious-title">
                                  Duplicate device
                                </div>

                                <div className="suspicious-reason">
                                  {record.suspicious_reason ||
                                    'Same device already submitted for another student in this session'}
                                </div>
                              </div>
                            </div>
                          )}
                        </td>
                        <td>{record.student_email}</td>
                        <td>{record.company || 'N/A'}</td>
                        <td>{formatDateTime(record.signed_at)}</td>
                        <td>{record.latitude}</td>
                        <td>{record.longitude}</td>
                        <td>{formatAccuracy(record.location_accuracy)}</td>
                        <td>
                          <SignaturePreview
                            record={record}
                            onError={handleMediaLoadError}
                          />
                        </td>
                        <td>
                          <StudentPhotoThumbnail
                            record={record}
                            onOpen={openPhotoModal}
                            onError={handleMediaLoadError}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="delete-button"
                            onClick={() => deleteRecord(record)}
                            disabled={deletingId === record.id}
                          >
                            {deletingId === record.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {selectedPhotoUrl && (
        <div
          className="photo-modal-overlay"
          onClick={closePhotoModal}
          role="presentation"
        >
          <div className="photo-modal" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="photo-modal-close"
              onClick={closePhotoModal}
              aria-label="Close photo"
            >
              X
            </button>

            <img
              src={selectedPhotoUrl}
              alt={selectedPhotoAlt}
              className="photo-modal-image"
            />

            <div className="photo-modal-actions">
              <button type="button" onClick={downloadSelectedPhoto}>
                Download Photo
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
