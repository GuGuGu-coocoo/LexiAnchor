# Third-party software and resource notices

LexiAnchor original code is licensed under MIT (see LICENSE). Dependencies,
dictionaries, models, and imported publications retain their own licenses.
MIT does not grant rights to users' books or third-party resource content.

Builds generate `licenses/DEPENDENCY-NOTICES.txt` from the installed, locked
package versions and their supplied license/copyright/notice files, including
build tools. This is an attribution inventory, not a certification that every
upstream package supplied complete notices. Web builds include the `licenses/`
directory. Desktop distributions also carry it in the application's Resources
folder (macOS: LexiAnchor.app/Contents/Resources/licenses; Windows:
resources/licenses). Keep this directory when redistributing the application.
Electron's own LICENSE and Chromium third-party notices must also be retained.

## Translation engine

The unmodified @browsermt/bergamot-translator 0.4.9 JavaScript/WASM package is
MPL-2.0 software. The full license is included as BERGAMOT-MPL-2.0.txt in the
licenses directory. Its source and build instructions are available at:
https://github.com/browsermt/bergamot-translator
Published package: https://www.npmjs.com/package/@browsermt/bergamot-translator/v/0.4.9

Recipients can obtain the covered source from that upstream project. When
modifying or replacing the engine, retain its notices and provide the source
corresponding to the distributed version, including modifications, under MPL-2.0.
The npm registry records source commit `8cc5d0495479c9ec56eafafd6bcd7fb5b929ca98`:
https://github.com/browsermt/bergamot-translator/tree/8cc5d0495479c9ec56eafafd6bcd7fb5b929ca98
This identifies upstream source; it is not an independently reproduced WASM build.
Review bundled native dependency notices when changing the engine.

## Dictionaries and downloadable models

- Bundled Princeton WordNet 3.1: retain WORDNET-3.1.txt, including its copyright
  and disclaimer. The notice is supplied separately because data is bundled.
- English Wiktionary: definitions are attributed to Wiktionary contributors
  under CC BY-SA 4.0. Preserve entry source links, attribution, license, and
  applicable share-alike obligations when redistributing definition content.
  https://en.wiktionary.org/wiki/Wiktionary:Copyrights
- FreeDict English–French 0.1.6: GPL-2.0-or-later dictionary data, downloaded
  separately. Its resource manifest contains the exact upstream TEI and source
  archive URLs and hashes. If redistributing it, provide the license and
  corresponding source under its terms; do not label it MIT.
- FreeDict English–Chinese: CC BY-SA 3.0 as recorded in its resource manifest;
  preserve attribution and applicable share-alike terms for redistributed data.
- Mozilla translation models: separately downloaded resources. The included
  manifests record their declared MPL-2.0 license, upstream repository, file URLs,
  and hashes. Their license is separate from the application and translation engine.
- User-imported StarDict dictionaries and publications: supplied by the user;
  LexiAnchor grants no additional rights to redistribute them.

The `licenses/resources/` manifests accompany builds for source and version
identification. Downloading a resource separately does not remove its license
obligations. Exporters and future resource mirrors must preserve applicable
attribution, licensing, and source requirements.

## Release checks

Verify that the actual macOS/Windows archive contains the licenses directory,
WordNet and MPL texts, resource manifests, and Electron/Chromium notices. Review
new dependencies and resources individually; metadata and generated inventories
cannot replace a source and asset license review. Previously published archives
are not changed by this repository update.
