import frenchManifest from '../resources/bergamot-en-fr.manifest.json';
import chineseManifest from '../resources/bergamot-en-zh.manifest.json';

export type TranslationTargetLanguage = 'fr' | 'zh';
export type TranslationModelPart = 'model' | 'shortlist' | 'vocab' | 'sourceVocab' | 'targetVocab';

export interface TranslationModelFile {
  readonly part: TranslationModelPart;
  readonly url: string;
  readonly compressedSize: number;
  readonly compressedSha256: string;
  readonly size: number;
  readonly sha256: string;
}

export interface TranslationModelResource {
  readonly id: string;
  readonly name: string;
  readonly sourceLanguage: 'en';
  readonly targetLanguage: TranslationTargetLanguage;
  readonly architecture: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly sourceUrl: string;
  readonly files: readonly TranslationModelFile[];
  readonly downloadSize: number;
  readonly installedSize: number;
  readonly attribution: string;
}

export interface TranslationModelInstallStatus {
  readonly installed: boolean;
  readonly partial: boolean;
  readonly installedParts: number;
  readonly totalParts: number;
  readonly storedBytes: number;
}

export interface TranslationModelProgress {
  readonly targetLanguage: TranslationTargetLanguage;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly completedParts: number;
  readonly totalParts: number;
}

export interface TranslationModelStore {
  hasPart(resourceId: string, part: TranslationModelPart, size: number): Promise<boolean>;
  getPart(resourceId: string, part: TranslationModelPart): Promise<ArrayBuffer | null>;
  putPart(resourceId: string, part: TranslationModelPart, value: ArrayBuffer): Promise<void>;
  isComplete(resourceId: string): Promise<boolean>;
  markComplete(resourceId: string): Promise<void>;
  remove(resourceId: string): Promise<void>;
}

function resourceFromManifest(
  manifest: typeof frenchManifest | typeof chineseManifest,
): TranslationModelResource {
  return {
    id: manifest.id,
    name: manifest.name,
    sourceLanguage: 'en',
    targetLanguage: manifest.targetLanguage as TranslationTargetLanguage,
    architecture: manifest.architecture,
    license: manifest.license.name,
    licenseUrl: manifest.license.url,
    sourceUrl: manifest.source,
    files: manifest.files as readonly TranslationModelFile[],
    downloadSize: manifest.downloadSize,
    installedSize: manifest.installedSize,
    attribution: manifest.attribution,
  };
}

export const translationModelResources: Readonly<
  Record<TranslationTargetLanguage, TranslationModelResource>
> = {
  fr: resourceFromManifest(frenchManifest),
  zh: resourceFromManifest(chineseManifest),
};

async function modelRootDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const appDirectory = await root.getDirectoryHandle('lexianchor', { create: true });
  return appDirectory.getDirectoryHandle('translation-models', { create: true });
}

async function modelDirectory(
  resourceId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await modelRootDirectory()).getDirectoryHandle(resourceId, { create });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return null;
    }
    throw error;
  }
}

export class OpfsTranslationModelStore implements TranslationModelStore {
  async hasPart(resourceId: string, part: TranslationModelPart, size: number): Promise<boolean> {
    try {
      const directory = await modelDirectory(resourceId, false);
      const handle = await directory?.getFileHandle(`${part}.bin`);
      return handle ? (await handle.getFile()).size === size : false;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return false;
      }
      throw error;
    }
  }

  async getPart(resourceId: string, part: TranslationModelPart): Promise<ArrayBuffer | null> {
    try {
      const directory = await modelDirectory(resourceId, false);
      const handle = await directory?.getFileHandle(`${part}.bin`);
      return handle ? (await handle.getFile()).arrayBuffer() : null;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return null;
      }
      throw error;
    }
  }

  async putPart(resourceId: string, part: TranslationModelPart, value: ArrayBuffer): Promise<void> {
    const directory = await modelDirectory(resourceId, true);

    if (!directory) {
      throw new Error('The local model directory could not be created.');
    }

    const handle = await directory.getFileHandle(`${part}.bin`, { create: true });
    const writer = await handle.createWritable();

    try {
      await writer.write(value);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async isComplete(resourceId: string): Promise<boolean> {
    try {
      const directory = await modelDirectory(resourceId, false);
      const marker = await directory?.getFileHandle('installed');
      return marker ? (await marker.getFile()).text().then((value) => value === resourceId) : false;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return false;
      }
      throw error;
    }
  }

  async markComplete(resourceId: string): Promise<void> {
    const directory = await modelDirectory(resourceId, true);

    if (!directory) {
      throw new Error('The local model directory could not be created.');
    }

    const handle = await directory.getFileHandle('installed', { create: true });
    const writer = await handle.createWritable();

    try {
      await writer.write(resourceId);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async remove(resourceId: string): Promise<void> {
    try {
      await (await modelRootDirectory()).removeEntry(resourceId, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        throw error;
      }
    }
  }
}

async function sha256(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readDownload(
  response: Response,
  onChunk: (size: number) => void,
): Promise<ArrayBuffer> {
  if (!response.body) {
    const value = await response.arrayBuffer();
    onChunk(value.byteLength);
    return value;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    size += value.byteLength;
    onChunk(value.byteLength);
  }

  const combined = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined.buffer;
}

async function decompressGzip(value: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([value]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export class TranslationModelManager {
  constructor(
    readonly store: TranslationModelStore = new OpfsTranslationModelStore(),
    private readonly download: typeof fetch = fetch,
    private readonly resources: Readonly<
      Record<TranslationTargetLanguage, TranslationModelResource>
    > = translationModelResources,
  ) {}

  resource(targetLanguage: TranslationTargetLanguage): TranslationModelResource {
    return this.resources[targetLanguage];
  }

  async status(targetLanguage: TranslationTargetLanguage): Promise<TranslationModelInstallStatus> {
    const resource = this.resource(targetLanguage);
    const present = await Promise.all(
      resource.files.map((file) => this.store.hasPart(resource.id, file.part, file.size)),
    );
    const installedParts = present.filter(Boolean).length;
    const installed =
      installedParts === resource.files.length && (await this.store.isComplete(resource.id));

    return {
      installed,
      partial: !installed && installedParts > 0,
      installedParts,
      totalParts: resource.files.length,
      storedBytes: resource.files.reduce(
        (total, file, index) => total + (present[index] ? file.size : 0),
        0,
      ),
    };
  }

  async install(
    targetLanguage: TranslationTargetLanguage,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: TranslationModelProgress) => void;
    } = {},
  ): Promise<TranslationModelInstallStatus> {
    const resource = this.resource(targetLanguage);
    let downloadedBytes = 0;
    let completedParts = 0;
    const report = () =>
      options.onProgress?.({
        targetLanguage,
        downloadedBytes,
        totalBytes: resource.downloadSize,
        completedParts,
        totalParts: resource.files.length,
      });

    for (const file of resource.files) {
      options.signal?.throwIfAborted();

      if (await this.store.hasPart(resource.id, file.part, file.size)) {
        downloadedBytes += file.compressedSize;
        completedParts += 1;
        report();
        continue;
      }

      const download = this.download;
      const response = await download(file.url, {
        credentials: 'omit',
        signal: options.signal,
      });

      if (!response.ok) {
        throw new Error(`Translation model download failed (${response.status}).`);
      }

      const compressed = await readDownload(response, (size) => {
        downloadedBytes += size;
        report();
      });

      if (
        compressed.byteLength !== file.compressedSize ||
        (await sha256(compressed)) !== file.compressedSha256
      ) {
        throw new Error('A translation model download did not match its resource manifest.');
      }

      const content = await decompressGzip(compressed);

      if (content.byteLength !== file.size || (await sha256(content)) !== file.sha256) {
        throw new Error('A decompressed translation model file failed integrity validation.');
      }

      await this.store.putPart(resource.id, file.part, content);
      completedParts += 1;
      report();
    }

    await this.store.markComplete(resource.id);
    return this.status(targetLanguage);
  }

  async remove(targetLanguage: TranslationTargetLanguage): Promise<void> {
    await this.store.remove(this.resource(targetLanguage).id);
  }
}
