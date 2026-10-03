import { licenseAssets } from '../../tools/license-assets';
import react from '@vitejs/plugin-react';
import { bergamotWorkerAssets } from '@lexianchor/translation/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [licenseAssets(), bergamotWorkerAssets(), react()],
  // A different dev origin has a different OPFS/localStorage library, even
  // with the same profile. Refuse a busy port instead of silently switching.
  server: { port: 5173, strictPort: true },
  // Workspace packages contain Vite URL assets (EPUB/WordNet). Process these
  // as source rather than feeding their query suffixes to the dev optimizer.
  optimizeDeps: {
    exclude: ['@lexianchor/app', '@lexianchor/test-fixtures', '@lexianchor/dictionary'],
  },
});
