import { Route, Routes } from 'react-router';
import SessionProvider from './auth/SessionProvider.jsx';
import { RequireApplication, RequireSession, RequireSuperAdmin } from './auth/guards.jsx';
import DashboardLayout from './layouts/DashboardLayout.jsx';
import Overview from './pages/Overview.jsx';
import { AllSubmissions, FormSubmissions } from './pages/Submissions.jsx';
import TeamManagement from './pages/TeamManagement.jsx';
import AuditLogs from './pages/AuditLogs.jsx';
import Settings from './pages/Settings.jsx';
import Login from './pages/Login.jsx';
import { NotFound } from './pages/StatusPages.jsx';

/**
 * Routes. Guards decide what to SHOW; the backend enforces every permission.
 * The router and the QueryClientProvider are supplied by main.jsx (or by tests).
 */
export default function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireSession>
              <DashboardLayout />
            </RequireSession>
          }
        >
          <Route index element={<Overview />} />
          <Route path="submissions" element={<AllSubmissions />} />
          <Route
            path="apps/:application/:formType"
            element={
              <RequireApplication>
                <FormSubmissions />
              </RequireApplication>
            }
          />
          <Route path="team" element={<RequireSuperAdmin><TeamManagement /></RequireSuperAdmin>} />
          <Route path="audit" element={<RequireSuperAdmin><AuditLogs /></RequireSuperAdmin>} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </SessionProvider>
  );
}
