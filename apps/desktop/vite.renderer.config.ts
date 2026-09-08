import { licenseAssets } from '../../tools/license-assets';
import react from '@vitejs/plugin-react';
import { bergamotWorkerAssets } from '@lexianchor/translation/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [licenseAssets(), bergamotWorkerAssets(), react()],
});
