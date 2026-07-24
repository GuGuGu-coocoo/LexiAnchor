/// <reference lib="webworker" />

import { StarDictProvider, type StarDictFiles } from '@lexianchor/dictionary';

type StarDictImportResponse =
  | {
      readonly ok: true;
      readonly status: {
        readonly installed: boolean;
        readonly name: string;
        readonly wordCount: number;
        readonly size: number;
      };
    }
  | { readonly ok: false; readonly error: string };

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<StarDictFiles>) => {
  void new StarDictProvider()
    .install(event.data)
    .then((status) => {
      const response: StarDictImportResponse = { ok: true, status };
      worker.postMessage(response);
    })
    .catch((error: unknown) => {
      const response: StarDictImportResponse = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      worker.postMessage(response);
    });
};
