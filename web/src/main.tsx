import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { platform } from './platform/index.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered after render so it never delays first paint. Failure is fine —
// it only costs offline support and reminders, not the app.
void platform.registerServiceWorker();

// One listener at the document answers every button in the app — including the
// ones inside Material Web's shadow roots — with whatever that button declared
// and whatever the member has switched on. See `platform.installPressFeedback`.
platform.installPressFeedback();
