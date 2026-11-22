import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppErrorBoundary, SupabaseProvider } from './components/SupabaseProvider.tsx';
import { ToastProvider } from './components/PopupToast.tsx';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <SupabaseProvider>
            <App />
          </SupabaseProvider>
        </BrowserRouter>
      </ToastProvider>
    </AppErrorBoundary>
  </StrictMode>
);
