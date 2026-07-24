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
