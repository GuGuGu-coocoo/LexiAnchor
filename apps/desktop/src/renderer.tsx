import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@lexianchor/app';

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('LexiAnchor could not find the root element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App platform={window.lexiAnchor} />
  </StrictMode>,
);
