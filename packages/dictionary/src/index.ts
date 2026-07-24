export {
  FreeDictEnglishFrenchProvider,
  OpfsDictionaryAssetStore,
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
