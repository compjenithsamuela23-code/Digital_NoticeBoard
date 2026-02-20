import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './contexts/SocketContext';
import DisplayBoard from './components/DisplayBoard';
import DisplayLogin from './components/DisplayLogin';
import AdminPanel from './components/AdminPanel';
import AdminLogin from './components/AdminLogin';
import AdminHistory from './components/AdminHistory';
import StaffLogin from './components/StaffLogin';
import { hasAdminSession } from './config/auth';
import { hasDisplaySession } from './config/displayAuth';
import { hasStaffSession } from './config/staffAuth';

const ProtectedAdminRoute = ({ children }) => {
  if (!hasAdminSession()) {
    return <Navigate to="/admin/login" replace />;
  }

  return children;
};

const ProtectedDisplayRoute = ({ children }) => {
  if (!hasDisplaySession()) {
    return <Navigate to="/display/login" replace />;
  }

  return children;
};

const ProtectedStaffRoute = ({ children }) => {
  if (!hasStaffSession()) {
    return <Navigate to="/staff/login" replace />;
  }

  return children;
};

function App() {
  return (
    <SocketProvider>
      <Router>
        <Routes>
          <Route path="/display/login" element={<DisplayLogin />} />
          <Route
            path="/"
            element={
              <ProtectedDisplayRoute>
                <DisplayBoard />
              </ProtectedDisplayRoute>
            }
          />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/staff/login" element={<StaffLogin />} />
          <Route
            path="/admin"
            element={
              <ProtectedAdminRoute>
                <AdminPanel workspaceRole="admin" />
              </ProtectedAdminRoute>
            }
          />
          <Route
            path="/staff"
            element={
              <ProtectedStaffRoute>
                <AdminPanel workspaceRole="staff" />
              </ProtectedStaffRoute>
            }
          />
          <Route
            path="/admin/history"
            element={
              <ProtectedAdminRoute>
                <AdminHistory workspaceRole="admin" />
              </ProtectedAdminRoute>
            }
          />
          <Route
            path="/staff/history"
            element={
              <ProtectedStaffRoute>
                <AdminHistory workspaceRole="staff" />
              </ProtectedStaffRoute>
            }
          />
          <Route path="*" element={<Navigate to="/display/login" />} />
        </Routes>
      </Router>
    </SocketProvider>
  );
}

export default App;
