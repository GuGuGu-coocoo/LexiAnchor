export type ReaderFlow = 'paginated' | 'scrolled';
export type DocumentFormat = 'epub' | 'pdf';

export interface ReaderLocator {
  readonly href: string;
  readonly cfi?: string;
  readonly progression?: number;
  readonly totalProgression?: number;
  readonly pageNumber?: number;
}

export interface ReaderPreferences {
  readonly flow: ReaderFlow;
  readonly fontSizePercent: number;
  readonly lineHeight: number;
  readonly wordSpacingEm: number;
  readonly foreground: string;
  readonly background: string;
  readonly focusMode: boolean;
}

export interface ReaderSelection {
  readonly text: string;
  readonly sentence: string;
  readonly cfiRange?: string;
  readonly pageNumber?: number;
}

export interface ReaderCallbacks {
  readonly onLocationChange: (locator: ReaderLocator) => void;
  readonly onSelection: (selection: ReaderSelection | null) => void;
  readonly onError: (error: Error) => void;
  readonly onNavigationCommand?: (command: 'next' | 'previous') => void;
}

export interface ReaderSource {
  readonly data: ArrayBuffer | string;
  readonly name: string;
  readonly format: DocumentFormat;
}

export interface ReaderEngine {
  readonly id: string;
  readonly label: string;
  open(container: HTMLElement, source: ReaderSource, initialLocator?: ReaderLocator): Promise<void>;
  close(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  goTo(locator: ReaderLocator): Promise<void>;
  setPreferences(preferences: ReaderPreferences): Promise<void>;
}

export const defaultReaderPreferences: ReaderPreferences = {
  flow: 'paginated',
  fontSizePercent: 100,
  lineHeight: 1.55,
  wordSpacingEm: 0,
  foreground: '#20211f',
  background: '#faf9f6',
  focusMode: false,
};
