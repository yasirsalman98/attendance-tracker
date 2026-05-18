import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import AttendanceForm from './pages/AttendanceForm';
import AdminRecords from './pages/AdminRecords';
import CreateTrainingSession from './pages/CreateTrainingSession';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="top-bar">
          <div className="brand">
            <img
              src="/images/logo.png"
              alt="Attendance Tracker logo"
              className="brand-logo"
            />
            <h1>Attendance Tracker</h1>
          </div>

          <nav>
            <Link to="/">Student Form</Link>
            <Link to="/create-session">Create Session</Link>
          </nav>
        </header>

        <main>
          <Routes>
            <Route path="/" element={<AttendanceForm />} />
            <Route path="/attendance/session/:sessionId" element={<AttendanceForm />} />
            <Route path="/create-session" element={<CreateTrainingSession />} />
            <Route path="/records-7392" element={<AdminRecords />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;