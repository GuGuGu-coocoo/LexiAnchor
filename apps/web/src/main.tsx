import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@lexianchor/app';
import { createWebPlatformBridge } from '@lexianchor/platform';
import { registerSW } from 'virtual:pwa-register';

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('LexiAnchor could not find the root element.');
}

registerSW({
  immediate: true,
});

createRoot(rootElement).render(
  <StrictMode>
    <App platform={createWebPlatformBridge()} />
  </StrictMode>,
);
