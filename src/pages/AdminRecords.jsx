import { useEffect, useMemo, useState } from 'react';
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

export default function AdminRecords() {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState('Loading records...');
  const [deletingId, setDeletingId] = useState(null);
  const [generatingCertificatesId, setGeneratingCertificatesId] = useState(null);

  const groupedRecords = useMemo(() => groupRecordsBySession(records), [records]);

  async function loadRecords() {
    setStatus('Loading records...');

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

      {status && <p className="status">{status}</p>}

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
                      <th>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {group.records.map((record) => (
                      <tr key={record.id}>
                        <td>{record.student_name}</td>
                        <td>{record.student_email}</td>
                        <td>{record.company || 'N/A'}</td>
                        <td>{formatDateTime(record.signed_at)}</td>
                        <td>{record.latitude}</td>
                        <td>{record.longitude}</td>
                        <td>{formatAccuracy(record.location_accuracy)}</td>
                        <td>
                          <img
                            src={record.signature_url}
                            alt={`Signature for ${record.student_name}`}
                            className="signature-preview"
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
    </section>
  );
}
