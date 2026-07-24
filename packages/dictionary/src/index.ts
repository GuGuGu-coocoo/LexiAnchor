export {
  FreeDictEnglishChineseProvider,
  FreeDictEnglishFrenchProvider,
  FreeDictTeiProvider,
  OpfsDictionaryAssetStore,
  freeDictEnglishChineseResource,
  freeDictEnglishFrenchResource,
  parseFreeDictTei,
  type DictionaryAssetStore,
  type FreeDictInstallStatus,
  type FreeDictResource,
} from './freedict';
export {
  WordNetProvider,
  type DictionaryProvider,
  type DictionaryResult,
  type DictionarySource,
} from './wordnet';
export {
  OpfsStarDictAssetStore,
  StarDictProvider,
  parseStarDictInfo,
  type StarDictAssetStore,
  type StarDictFiles,
  type StarDictInfo,
  type StarDictInstallStatus,
} from './stardict';
export {
  findIndexLine,
  lineAtByteOffset,
  morphologyCandidates,
  normalizeLookupTerm,
  parseDataLine,
  parseIndexLine,
  type DictionaryPartOfSpeech,
  type WordNetIndexRecord,
  type WordNetPartOfSpeech,
  type WordNetSense,
} from './parser';
