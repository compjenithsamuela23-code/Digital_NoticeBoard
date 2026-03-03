import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './contexts/SocketContext';
import RouteLoader from './components/RouteLoader';
import { hasAdminSession } from './config/auth';
import { hasDisplaySession } from './config/displayAuth';
import { hasStaffSession } from './config/staffAuth';

const DisplayBoard = lazy(() => import('./components/DisplayBoard'));
const DisplayLogin = lazy(() => import('./components/DisplayLogin'));
const AdminPanel = lazy(() => import('./components/AdminPanel'));
const AdminLogin = lazy(() => import('./components/AdminLogin'));
const AdminHistory = lazy(() => import('./components/AdminHistory'));
const StaffLogin = lazy(() => import('./components/StaffLogin'));

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
  const withRouteSuspense = (node, message) => (
    <Suspense fallback={<RouteLoader message={message} />}>
      {node}
    </Suspense>
  );

  return (
    <SocketProvider>
      <Router>
        <Routes>
          <Route
            path="/display/login"
            element={withRouteSuspense(<DisplayLogin />, 'Loading display access...')}
          />
          <Route
            path="/"
            element={
              <ProtectedDisplayRoute>
                {withRouteSuspense(<DisplayBoard />, 'Loading notice display...')}
              </ProtectedDisplayRoute>
            }
          />
          <Route
            path="/admin/login"
            element={withRouteSuspense(<AdminLogin />, 'Loading admin login...')}
          />
          <Route
            path="/staff/login"
            element={withRouteSuspense(<StaffLogin />, 'Loading staff login...')}
          />
          <Route
            path="/admin"
            element={
              <ProtectedAdminRoute>
                {withRouteSuspense(<AdminPanel workspaceRole="admin" />, 'Loading admin workspace...')}
              </ProtectedAdminRoute>
            }
          />
          <Route
            path="/staff"
            element={
              <ProtectedStaffRoute>
                {withRouteSuspense(<AdminPanel workspaceRole="staff" />, 'Loading staff workspace...')}
              </ProtectedStaffRoute>
            }
          />
          <Route
            path="/admin/history"
            element={
              <ProtectedAdminRoute>
                {withRouteSuspense(<AdminHistory workspaceRole="admin" />, 'Loading history...')}
              </ProtectedAdminRoute>
            }
          />
          <Route
            path="/staff/history"
            element={
              <ProtectedStaffRoute>
                {withRouteSuspense(<AdminHistory workspaceRole="staff" />, 'Loading history...')}
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
