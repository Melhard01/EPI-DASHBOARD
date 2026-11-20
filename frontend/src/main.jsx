import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.jsx';
import { configureClient } from './api/client.js';
import { createQueryClient } from './queryClient.js';
import { reloadToSignIn } from './lib/session.js';
import { applyTheme, getTheme } from './lib/theme.js';

applyTheme(getTheme());
// A 401 means the Cloudflare Access session is gone: reload so Access shows its login.
configureClient({ onUnauthorized: reloadToSignIn });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
