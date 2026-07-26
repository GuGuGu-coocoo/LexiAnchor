# LexiAnchor

LexiAnchor is a local-first EPUB/PDF reader designed for focused English learning.
Its primary goals are comfortable reading, offline dictionaries and translation,
and turning words encountered in books into useful word cards.

The project is in active development. The shared Web/PWA and Electron application
can now import and read DRM-free EPUB 2/3 and PDF files. Imported books and reading
progress persist locally through SQLite WASM and OPFS. The library supports title/author
search, four sort orders, and confirmed local deletion with choices for preserving reading
progress and word cards. Selecting an English word
queries the bundled Princeton WordNet 3.1 and an optional, installable FreeDict
English–French dictionary plus an optional FreeDict/WikDict English–Chinese dictionary
offline. Users can also import an uncompressed StarDict `.ifo + .idx + .dict` set.
They can enable dictionaries and change result order in Settings, while
explicit online translation and Web search remain available. Dictionary results can be
saved as persistent, searchable and editable word cards with their reading context.
Word cards can be exported to and restored from a versioned JSON backup without a
network connection. Optional Mozilla Bergamot English–French and English–Chinese
models can be installed for private, on-device sentence translation and reused while
offline.

## Requirements

- Node.js 24 LTS
- pnpm 11
- macOS or Windows for desktop packaging

## Development

```bash
pnpm install
pnpm dev:web
pnpm dev:desktop
```

Quality checks:

```bash
pnpm check
pnpm test:e2e
```

## Documentation

- [Product requirements](./PRD.md)
- [Technical architecture](./TECHNICAL_ARCHITECTURE.md)
- [Development workflow](./DEVELOPMENT_WORKFLOW.md)
- [Architecture decisions](./docs/adr)
- [Phase 0 status](./docs/PHASE_0_STATUS.md)
- [Current reader status](./docs/PHASE_1_READER_STATUS.md)
- [EPUB engine spike](./docs/spikes/0001-epub-engine.md)
- [PDF engine spike](./docs/spikes/0002-pdf-engine.md)
- [SQLite and OPFS spike](./docs/spikes/0003-sqlite-opfs.md)
- [WordNet offline dictionary spike](./docs/spikes/0004-wordnet.md)
- [FreeDict English–French spike](./docs/spikes/0005-freedict-eng-fra.md)
- [FreeDict/WikDict English–Chinese spike](./docs/spikes/0006-freedict-eng-zho.md)
- [StarDict user dictionary import spike](./docs/spikes/0007-stardict-import.md)
- [Bergamot local translation spike](./docs/spikes/0008-bergamot-local-translation.md)

## Project status

LexiAnchor is currently a personal project. Books, downloaded dictionaries,
translation models and local databases are intentionally excluded from Git.
