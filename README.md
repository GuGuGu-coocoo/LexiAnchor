# LexiAnchor

LexiAnchor is a local-first EPUB/PDF reader designed for focused English learning.
Its primary goals are comfortable reading, offline dictionaries and translation,
and turning words encountered in books into useful word cards.

The project is in active development. The Phase 0 foundation now runs a shared
React application in Electron and the Web/PWA.

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

## Project status

LexiAnchor is currently a personal project. Books, downloaded dictionaries,
translation models and local databases are intentionally excluded from Git.
