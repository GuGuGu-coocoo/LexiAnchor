import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const assets = [
  {
    name: 'bergamot-translator-worker.js',
    path: require.resolve('@browsermt/bergamot-translator/worker/bergamot-translator-worker.js'),
    type: 'text/javascript',
  },
  {
    name: 'bergamot-translator-worker.wasm',
    path: require.resolve('@browsermt/bergamot-translator/worker/bergamot-translator-worker.wasm'),
    type: 'application/wasm',
  },
] as const;

export function bergamotWorkerAssets(): Plugin {
  return {
    name: 'lexianchor-bergamot-worker-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const asset = assets.find(({ name }) => request.url?.endsWith(`/${name}`));

        if (!asset) {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', asset.type);
        response.end(readFileSync(asset.path));
      });
    },
    generateBundle() {
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${asset.name}`,
          source: readFileSync(asset.path),
        });
      }
    },
  };
}
