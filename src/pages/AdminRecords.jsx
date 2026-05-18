// src/pages/AdminRecords.jsx

import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export default function AdminRecords() {
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState('Loading records...');
  const [deletingId, setDeletingId] = useState(null);

  async function loadRecords() {
    setStatus('Loading records...');

    const result = await supabase
      .from('attendance_records')
      .select(`
        *,
        training_sessions (
          id,
          course_name,
          training_date,
          time_started,
          time_stopped,
          duration_minutes,
          company_name,
          training_location,
          trainer_name,
          course_outline
        )
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

  useEffect(() => {
    loadRecords();
  }, []);

  return (
    <section className="card">
      <div className="admin-header">
        <div>
          <h2>Admin Attendance Records</h2>
          <p className="muted">
            View submitted student attendance records and their related training sessions.
          </p>
        </div>

        <button type="button" className="secondary-button" onClick={loadRecords}>
          Refresh
        </button>
      </div>

      {status && <p className="status">{status}</p>}

      {!status && records.length === 0 && (
        <p className="muted">No attendance records found yet.</p>
      )}

      {records.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Course</th>
                <th>Training Date</th>
                <th>Trainer</th>
                <th>Training Company</th>
                <th>Location</th>
                <th>Student Name</th>
                <th>Email</th>
                <th>Student Company</th>
                <th>Signed Date/Time</th>
                <th>Latitude</th>
                <th>Longitude</th>
                <th>Accuracy</th>
                <th>Signature</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {records.map((record) => {
                const session = record.training_sessions;

                return (
                  <tr key={record.id}>
                    <td>{session?.course_name || 'N/A'}</td>
                    <td>{session?.training_date || 'N/A'}</td>
                    <td>{session?.trainer_name || 'N/A'}</td>
                    <td>{session?.company_name || 'N/A'}</td>
                    <td>{session?.training_location || 'N/A'}</td>
                    <td>{record.student_name}</td>
                    <td>{record.student_email}</td>
                    <td>{record.company || 'N/A'}</td>
                    <td>
                      {record.signed_at
                        ? new Date(record.signed_at).toLocaleString()
                        : 'N/A'}
                    </td>
                    <td>{record.latitude ?? 'N/A'}</td>
                    <td>{record.longitude ?? 'N/A'}</td>
                    <td>
                      {record.location_accuracy
                        ? `${Math.round(record.location_accuracy)} meters`
                        : 'N/A'}
                    </td>
                    <td>
                      {record.signature_url ? (
                        <img
                          src={record.signature_url}
                          alt={`Signature for ${record.student_name}`}
                          className="signature-preview"
                        />
                      ) : (
                        'N/A'
                      )}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}