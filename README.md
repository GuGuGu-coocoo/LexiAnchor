# LexiAnchor

LexiAnchor is a local-first EPUB/PDF reader designed for focused English learning.
Its primary goals are comfortable reading, offline dictionaries and translation,
and turning words encountered in books into useful word cards.

The project is in active development. The shared Web/PWA and Electron application
can now batch-import, organize, and read DRM-free EPUB 2/3 and PDF files. Imported books
and reading progress persist locally through SQLite WASM and OPFS. The library supports
drag-and-drop, editable metadata, title/author search, four sort orders, and confirmed local
deletion with choices for preserving reading progress and word cards. Selecting an English word
queries English Wiktionary with a bundled Princeton WordNet 3.1 offline fallback and an optional, installable FreeDict
English–French dictionary plus an optional FreeDict/WikDict English–Chinese dictionary
offline. Users can also import an uncompressed StarDict `.ifo + .idx + .dict` set.
They can enable dictionaries and change result order in Settings, while
explicit online translation and Web search remain available. Dictionary results can be
saved as persistent, searchable and editable word cards with their reading context.
Word cards can be exported to and restored from a versioned JSON backup without a
network connection. Optional Mozilla Bergamot English–French and English–Chinese
models can be installed for private, on-device sentence translation and reused while
offline. EPUB reading includes persistent per-book typography controls and independently
implemented, removable light/medium/strong focus highlighting; text-layer PDFs use the
same focus rules without modifying the original document. Settings show local storage
usage, browser quota, and whether the browser has granted protection from automatic cleanup.
Versioned application backups can optionally include the original local book copies.

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

Create a local desktop test package:

```bash
pnpm --filter @lexianchor/desktop make
```

Quality checks:

```bash
pnpm check
pnpm test:e2e
```

## Project status

LexiAnchor is currently a personal project. Books, downloaded dictionaries,
translation models and local databases are intentionally excluded from Git.
