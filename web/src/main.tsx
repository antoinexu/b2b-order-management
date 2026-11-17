import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionApp } from '@/auth/SessionApp';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><SessionApp /></StrictMode>,
);
