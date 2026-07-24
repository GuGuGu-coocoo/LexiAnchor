export interface TranslationModelBuffers {
  readonly model: ArrayBuffer;
  readonly shortlist: ArrayBuffer;
  readonly vocabs: readonly ArrayBuffer[];
  readonly config?: Readonly<Record<string, string | number | boolean>>;
}

export interface TranslationRequest {
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly html?: boolean;
  readonly qualityScores?: boolean;
}

export interface TranslationResponse {
  readonly request: TranslationRequest;
  readonly target: { readonly text: string };
}

export class TranslatorBacking {
  constructor(options?: Readonly<Record<string, unknown>>);
  readonly onerror: (error: Error) => void;
  loadModelRegistery(): Promise<readonly unknown[]>;
  loadTranslationModel(
    pair: { readonly from: string; readonly to: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<TranslationModelBuffers>;
  getModels(pair: {
    readonly from: string;
    readonly to: string;
  }): Promise<readonly { readonly from: string; readonly to: string }[]>;
  getTranslationModel(
    pair: { readonly from: string; readonly to: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<TranslationModelBuffers>;
  loadWorker(): Promise<unknown>;
}

export class LatencyOptimisedTranslator {
  constructor(options?: Readonly<Record<string, unknown>>, backing?: TranslatorBacking);
  translate(
    request: TranslationRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<TranslationResponse>;
  delete(): Promise<void>;
}
