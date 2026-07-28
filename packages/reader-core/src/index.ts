export type ReaderFlow = 'paginated' | 'scrolled';
export type ReaderPageSpread = 'single' | 'double';
export type DocumentFormat = 'epub' | 'pdf';
export type FocusStrength = 'light' | 'medium' | 'strong';
export type ReaderFontFamily = 'serif' | 'sans-serif';
export type ReaderTextAlignment = 'start' | 'justify';

export interface ReaderLocator {
  readonly href: string;
  readonly cfi?: string;
  readonly progression?: number;
  readonly totalProgression?: number;
  readonly pageNumber?: number;
}

export interface ReaderPreferences {
  readonly flow: ReaderFlow;
  readonly pageSpread: ReaderPageSpread;
  readonly fontSizePercent: number;
  readonly lineHeight: number;
  readonly wordSpacingEm: number;
  readonly letterSpacingEm: number;
  readonly fontFamily: ReaderFontFamily;
  readonly fontWeight: number;
  readonly contentWidthPercent: number;
  readonly textAlignment: ReaderTextAlignment;
  readonly foreground: string;
  readonly background: string;
  readonly focusMode: boolean;
  readonly focusStrength: FocusStrength;
}

export interface ReaderSelection {
  readonly text: string;
  readonly sentence: string;
  readonly cfiRange?: string;
  readonly pageNumber?: number;
  readonly anchorRect?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
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
  pageSpread: 'single',
  fontSizePercent: 100,
  lineHeight: 1.55,
  wordSpacingEm: 0,
  letterSpacingEm: 0,
  fontFamily: 'serif',
  fontWeight: 400,
  contentWidthPercent: 90,
  textAlignment: 'start',
  foreground: '#20211f',
  background: '#faf9f6',
  focusMode: false,
  focusStrength: 'medium',
};

const focusRatios: Readonly<Record<FocusStrength, number>> = {
  light: 0.34,
  medium: 0.45,
  strong: 0.58,
};

const focusWeights: Readonly<Record<FocusStrength, number>> = {
  light: 650,
  medium: 750,
  strong: 850,
};

export function focusPrefixLength(wordLength: number, strength: FocusStrength): number {
  const safeLength = Math.max(0, Math.floor(wordLength));

  if (safeLength === 0) {
    return 0;
  }

  if (safeLength <= 3) {
    return strength === 'strong' ? Math.min(2, safeLength) : 1;
  }

  return Math.min(safeLength, Math.ceil(safeLength * focusRatios[strength]));
}

export function focusFontWeight(strength: FocusStrength): number {
  return focusWeights[strength];
}
