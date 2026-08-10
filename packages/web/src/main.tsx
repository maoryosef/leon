import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { initToken } from './lib/token';

initToken();

/**
 * Inside the desktop shell the window has no title bar: the header has to
 * clear the traffic lights and act as the drag handle. index.css keys that off
 * this attribute so the browser build is untouched.
 */
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.dataset.desktop = '';
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
