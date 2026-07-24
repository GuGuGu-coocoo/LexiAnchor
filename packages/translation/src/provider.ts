import {
  LatencyOptimisedTranslator,
  TranslatorBacking,
  type TranslationModelBuffers,
} from './bergamot-runtime.js';

import {
  TranslationModelManager,
  type TranslationModelResource,
  type TranslationModelStore,
  type TranslationTargetLanguage,
} from './model-manager';

export interface LocalTranslationResult {
  readonly sourceLanguage: 'en';
  readonly targetLanguage: TranslationTargetLanguage;
  readonly sourceText: string;
  readonly translatedText: string;
  readonly model: TranslationModelResource;
}

class LocalModelBacking extends TranslatorBacking {
  constructor(
    private readonly store: TranslationModelStore,
    private readonly resources: Readonly<
      Record<TranslationTargetLanguage, TranslationModelResource>
    >,
  ) {
    super({ pivotLanguage: null, cacheSize: 64 });
  }

  override loadModelRegistery() {
    // TranslatorBacking calls this override from its constructor, before
    // TypeScript parameter properties have assigned `resources`.
    return Promise.resolve([
      { from: 'en', to: 'fr', files: {} },
      { from: 'en', to: 'zh', files: {} },
    ]);
  }

  override async loadTranslationModel({
    to,
  }: {
    readonly from: string;
    readonly to: string;
  }): Promise<TranslationModelBuffers> {
    if (to !== 'fr' && to !== 'zh') {
      throw new Error(`No local translation model is configured for English to ${to}.`);
    }

    const resource = this.resources[to];
    const parts = new Map(
      await Promise.all(
        resource.files.map(
          async (file) => [file.part, await this.store.getPart(resource.id, file.part)] as const,
        ),
      ),
    );
    const model = parts.get('model');
    const shortlist = parts.get('shortlist');
    const vocab = parts.get('vocab');
    const sourceVocab = parts.get('sourceVocab');
    const targetVocab = parts.get('targetVocab');

    if (!model || !shortlist || (!vocab && (!sourceVocab || !targetVocab))) {
      throw new Error('The installed local translation model is incomplete.');
    }

    return {
      model,
      shortlist,
      vocabs: vocab ? [vocab] : [sourceVocab!, targetVocab!],
      config: { 'gemm-precision': 'int8shiftAlphaAll' },
    };
  }
}

export class BergamotTranslationProvider {
  private translator: LatencyOptimisedTranslator | null = null;

  constructor(readonly manager = new TranslationModelManager()) {}

  async translate(
    text: string,
    targetLanguage: TranslationTargetLanguage,
    signal?: AbortSignal,
  ): Promise<LocalTranslationResult> {
    const sourceText = text.trim();

    if (!sourceText) {
      throw new Error('Select text before translating it.');
    }

    if (sourceText.length > 2_000) {
      throw new Error('Local translation is limited to 2,000 characters at a time.');
    }

    if (!(await this.manager.status(targetLanguage)).installed) {
      throw new Error('The required local translation model is not installed.');
    }

    this.translator ??= new LatencyOptimisedTranslator(
      { pivotLanguage: null, cacheSize: 64 },
      new LocalModelBacking(this.manager.store, {
        fr: this.manager.resource('fr'),
        zh: this.manager.resource('zh'),
      }),
    );
    const result = await this.translator.translate(
      {
        from: 'en',
        to: targetLanguage,
        text: sourceText,
        html: false,
        qualityScores: false,
      },
      { signal },
    );

    return {
      sourceLanguage: 'en',
      targetLanguage,
      sourceText,
      translatedText: result.target.text,
      model: this.manager.resource(targetLanguage),
    };
  }

  async dispose(): Promise<void> {
    await this.translator?.delete();
    this.translator = null;
  }
}
