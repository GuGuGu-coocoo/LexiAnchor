export const supportedLocales = ['en', 'zh-CN', 'fr'] as const;

export type Locale = (typeof supportedLocales)[number];

const english = {
  appTagline: 'Focused reading, anchored learning',
  home: 'Home',
  library: 'Library',
  cards: 'Word cards',
  appearance: 'Appearance',
  language: 'Interface language',
  systemTheme: 'System',
  lightTheme: 'Light',
  darkTheme: 'Dark',
  eyeCareTheme: 'Eye care',
  localOnly: 'Local-first',
  privateByDefault: 'Your reading data stays on this device.',
  welcome: 'Good to see you',
  continueReading: 'Continue reading',
  recentDescription: 'Your recent books and reading progress will appear here.',
  sampleData: 'Sample',
  openBook: 'Continue',
  progress: 'Progress',
  fullscreen: 'Full screen',
  exitFullscreen: 'Exit full screen',
  libraryTitle: 'Your library',
  libraryEmptyTitle: 'Your books will live here',
  libraryEmptyBody: 'EPUB and PDF import arrives in the next vertical slice.',
  libraryExperimentBody:
    'Open a project-owned test book or choose a DRM-free EPUB or PDF from this device.',
  importEpub: 'Import EPUB',
  importBook: 'Import EPUB or PDF',
  openSampleBook: 'Open test book',
  sampleBookDescription: 'A small project-owned book for testing reflow, selection, and location.',
  sampleTextPdfDescription:
    'A three-page PDF for testing faithful layout, text selection, zoom, and progress.',
  sampleScanPdfDescription:
    'An image-only PDF for checking the readable fallback when no text layer exists.',
  textLayer: 'Text layer',
  imageOnly: 'Image only',
  cardsTitle: 'Your word cards',
  cardsEmptyTitle: 'Save words without breaking your flow',
  cardsEmptyBody: 'Dictionary results you save will appear here with context.',
  phaseLabel: 'Foundation in progress',
  phaseTitle: 'One calm reading surface, shared everywhere',
  phaseBody:
    'This foundation already shares navigation, themes, language, and accessibility behavior between Web and Electron.',
  desktop: 'Desktop',
  web: 'Web',
  version: 'Version',
  actionFailed: 'That action could not be completed.',
  backToLibrary: 'Library',
  readerExperiment: 'Reader experiment',
  readerExperimentBody: 'These controls validate the engine before the full reader is built.',
  previousPage: 'Previous',
  nextPage: 'Next',
  readingSettings: 'Reading settings',
  focusMode: 'Focus emphasis',
  focusModeDescription: 'Emphasize the beginning of each word.',
  readingLayout: 'Layout',
  pageMode: 'Pages',
  scrollMode: 'Continuous scroll',
  fontSize: 'Text size',
  lineHeight: 'Line height',
  wordSpacing: 'Word spacing',
  selectedText: 'Selection',
  selectionHint: 'Select a word or phrase in the book to inspect its sentence.',
  loadingBook: 'Opening book…',
  readerError: 'The book could not be opened.',
  pdfReader: 'PDF reader',
  pdfReaderDescription:
    'The page keeps its original layout. Zoom and selection use the available PDF text layer.',
  pdfFocusDescription: 'Emphasize word beginnings on the selectable text layer.',
  zoom: 'Zoom',
  page: 'Page',
  of: 'of',
  imageOnlyPdf: 'Image-only page',
  imageOnlyDescription:
    'This page has no selectable text. It remains readable as an image; OCR is not included yet.',
  pdfSelectionHint: 'Select a word or phrase on the page to inspect its sentence.',
} as const;

export type MessageKey = keyof typeof english;

const simplifiedChinese: Record<MessageKey, string> = {
  appTagline: '专注阅读，稳固学习',
  home: '主页',
  library: '书库',
  cards: '词卡',
  appearance: '外观',
  language: '界面语言',
  systemTheme: '跟随系统',
  lightTheme: '浅色',
  darkTheme: '深色',
  eyeCareTheme: '护眼',
  localOnly: '本地优先',
  privateByDefault: '阅读数据默认只保存在这台设备上。',
  welcome: '欢迎回来',
  continueReading: '继续阅读',
  recentDescription: '最近阅读的书籍和进度会显示在这里。',
  sampleData: '示例',
  openBook: '继续',
  progress: '进度',
  fullscreen: '全屏',
  exitFullscreen: '退出全屏',
  libraryTitle: '你的书库',
  libraryEmptyTitle: '书籍会集中保存在这里',
  libraryEmptyBody: 'EPUB 与 PDF 导入将在下一条垂直功能切片中实现。',
  libraryExperimentBody: '打开项目自制测试书，或从本机选择无 DRM 的 EPUB 或 PDF。',
  importEpub: '导入 EPUB',
  importBook: '导入 EPUB 或 PDF',
  openSampleBook: '打开测试书',
  sampleBookDescription: '项目自制的小型 EPUB，用于测试重排、选词和位置保存。',
  sampleTextPdfDescription: '三页文本型 PDF，用于测试版式还原、选词、缩放和进度保存。',
  sampleScanPdfDescription: '纯图片 PDF，用于验证没有文本层时仍可阅读的降级体验。',
  textLayer: '可选文本',
  imageOnly: '纯图片',
  cardsTitle: '你的词卡',
  cardsEmptyTitle: '查词后保存，不打断阅读节奏',
  cardsEmptyBody: '保存的词典结果会连同原句和来源一起显示在这里。',
  phaseLabel: '基础工程开发中',
  phaseTitle: '一套安静的阅读界面，跨平台共享',
  phaseBody: '当前骨架已经在 Web 与 Electron 之间共享导航、主题、语言和无障碍行为。',
  desktop: '桌面端',
  web: 'Web 端',
  version: '版本',
  actionFailed: '操作未能完成。',
  backToLibrary: '返回书库',
  readerExperiment: '阅读内核实验',
  readerExperimentBody: '这些控制项用于在完整阅读器开发前验证内核能力。',
  previousPage: '上一页',
  nextPage: '下一页',
  readingSettings: '阅读设置',
  focusMode: '焦点加粗',
  focusModeDescription: '加粗每个词语的前半部分。',
  readingLayout: '阅读布局',
  pageMode: '分页',
  scrollMode: '连续滚动',
  fontSize: '文字大小',
  lineHeight: '行距',
  wordSpacing: '词间距',
  selectedText: '选中内容',
  selectionHint: '在书中选中单词或短语，这里会显示所在原句。',
  loadingBook: '正在打开书籍…',
  readerError: '无法打开这本书。',
  pdfReader: 'PDF 阅读器',
  pdfReaderDescription: '页面保留原始版式；缩放与选词使用 PDF 中已有的文本层。',
  pdfFocusDescription: '在可选文本层中强调每个英文单词的前半部分。',
  zoom: '缩放',
  page: '页码',
  of: '/',
  imageOnlyPdf: '纯图片页面',
  imageOnlyDescription: '这一页没有可选文本，仍可按图片阅读；当前版本暂不包含 OCR。',
  pdfSelectionHint: '在页面中选中单词或短语，这里会显示所在原句。',
};

const french: Record<MessageKey, string> = {
  appTagline: 'Lecture concentrée, apprentissage ancré',
  home: 'Accueil',
  library: 'Bibliothèque',
  cards: 'Fiches de mots',
  appearance: 'Apparence',
  language: "Langue de l'interface",
  systemTheme: 'Système',
  lightTheme: 'Clair',
  darkTheme: 'Sombre',
  eyeCareTheme: 'Confort visuel',
  localOnly: "D'abord local",
  privateByDefault: 'Vos données de lecture restent sur cet appareil.',
  welcome: 'Ravi de vous revoir',
  continueReading: 'Continuer la lecture',
  recentDescription: 'Vos livres récents et leur progression apparaîtront ici.',
  sampleData: 'Exemple',
  openBook: 'Continuer',
  progress: 'Progression',
  fullscreen: 'Plein écran',
  exitFullscreen: 'Quitter le plein écran',
  libraryTitle: 'Votre bibliothèque',
  libraryEmptyTitle: 'Vos livres seront rassemblés ici',
  libraryEmptyBody: "L'import EPUB et PDF arrive dans la prochaine tranche fonctionnelle.",
  libraryExperimentBody:
    'Ouvrez un livre test ou choisissez un EPUB ou PDF sans DRM sur cet appareil.',
  importEpub: 'Importer un EPUB',
  importBook: 'Importer un EPUB ou PDF',
  openSampleBook: 'Ouvrir le livre test',
  sampleBookDescription:
    'Un petit livre du projet pour tester la redistribution, la sélection et la position.',
  sampleTextPdfDescription:
    'Un PDF de trois pages pour tester la mise en page, la sélection, le zoom et la progression.',
  sampleScanPdfDescription:
    "Un PDF en image pour vérifier la lecture lorsqu'aucune couche de texte n'est disponible.",
  textLayer: 'Texte sélectionnable',
  imageOnly: 'Image seule',
  cardsTitle: 'Vos fiches de mots',
  cardsEmptyTitle: 'Enregistrez des mots sans interrompre votre lecture',
  cardsEmptyBody: 'Les résultats enregistrés apparaîtront ici avec leur contexte.',
  phaseLabel: 'Fondations en cours',
  phaseTitle: 'Une interface de lecture calme, partagée partout',
  phaseBody:
    "Cette base partage déjà la navigation, les thèmes, la langue et l'accessibilité entre le Web et Electron.",
  desktop: 'Bureau',
  web: 'Web',
  version: 'Version',
  actionFailed: "L'action n'a pas pu être effectuée.",
  backToLibrary: 'Bibliothèque',
  readerExperiment: 'Expérience du moteur',
  readerExperimentBody: 'Ces réglages valident le moteur avant de construire le lecteur complet.',
  previousPage: 'Précédent',
  nextPage: 'Suivant',
  readingSettings: 'Réglages de lecture',
  focusMode: 'Mise en évidence',
  focusModeDescription: 'Renforce le début de chaque mot.',
  readingLayout: 'Disposition',
  pageMode: 'Pages',
  scrollMode: 'Défilement continu',
  fontSize: 'Taille du texte',
  lineHeight: 'Interligne',
  wordSpacing: 'Espacement des mots',
  selectedText: 'Sélection',
  selectionHint: 'Sélectionnez un mot ou une phrase pour afficher son contexte.',
  loadingBook: 'Ouverture du livre…',
  readerError: "Le livre n'a pas pu être ouvert.",
  pdfReader: 'Lecteur PDF',
  pdfReaderDescription:
    'La mise en page originale est conservée. Le zoom et la sélection utilisent la couche de texte disponible.',
  pdfFocusDescription: 'Renforce le début des mots dans la couche de texte sélectionnable.',
  zoom: 'Zoom',
  page: 'Page',
  of: 'sur',
  imageOnlyPdf: 'Page en image',
  imageOnlyDescription:
    'Cette page ne contient aucun texte sélectionnable. Elle reste lisible comme image ; l’OCR n’est pas encore inclus.',
  pdfSelectionHint: 'Sélectionnez un mot ou un passage pour afficher sa phrase.',
};

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  en: english,
  'zh-CN': simplifiedChinese,
  fr: french,
};

export function resolveLocale(languageTags: readonly string[]): Locale {
  for (const languageTag of languageTags) {
    const normalized = languageTag.toLowerCase();

    if (normalized.startsWith('zh')) {
      return 'zh-CN';
    }

    if (normalized.startsWith('fr')) {
      return 'fr';
    }

    if (normalized.startsWith('en')) {
      return 'en';
    }
  }

  return 'en';
}

export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') {
    return 'en';
  }

  const languageTags = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return resolveLocale(languageTags);
}

export function translate(locale: Locale, key: MessageKey): string {
  return dictionaries[locale][key];
}
