import { useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertCircle } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { saveToken } from '../lib/jwt.js';
import { ApiError } from '../api/client.js';
import Button from '../components/ui/Button.jsx';
import { TextInput } from '../components/ui/Field.jsx';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await api.login(email, password);
      if (response && response.token) {
        // Store the JWT token and redirect to dashboard
        saveToken(response.token, response.expiresIn);
        navigate('/');
      } else {
        setError('Login failed: no token received from server');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError('Invalid email or password');
        } else {
          setError(err.message);
        }
      } else {
        setError(err?.message || 'Login failed. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-2 px-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
          <p className="mt-2 text-sm text-muted">Sign in to your account</p>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg bg-red-50 p-3 dark:bg-red-950">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-400" />
            <p className="text-sm text-red-700 dark:text-red-200">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <TextInput
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            disabled={isLoading}
            required
          />

          <TextInput
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={isLoading}
            required
          />

          <Button
            type="submit"
            variant="primary"
            loading={isLoading}
            disabled={!email || !password}
            className="w-full"
          >
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted">
          Questions? Contact your Super Admin.
        </p>
      </div>
    </div>
  );
}
