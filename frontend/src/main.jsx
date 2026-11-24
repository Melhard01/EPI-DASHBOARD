import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.jsx';
import { configureClient } from './api/client.js';
import { createQueryClient } from './queryClient.js';
import { applyTheme, getTheme } from './lib/theme.js';
import { clearToken } from './lib/jwt.js';

applyTheme(getTheme());
// A 401 means the JWT token is invalid or expired: clear it and show the login screen.
configureClient({ onUnauthorized: clearToken });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
