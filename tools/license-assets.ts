import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Entry = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage?: string;
};

export function licenseAssets() {
  return {
    name: 'lexianchor-license-assets',
    generateBundle(this: {
      emitFile: (asset: { type: 'asset'; fileName: string; source: string }) => void;
    }) {
      const emit = (fileName: string, source: string) =>
        this.emitFile({ type: 'asset', fileName, source });
      const entries: Entry[] = [];
      const scan = (modules: string) => {
        if (!existsSync(modules)) return;
        for (const item of readdirSync(modules, { withFileTypes: true })) {
          if (item.name.startsWith('.')) continue;
          if (item.name.startsWith('@')) {
            scan(path.join(modules, item.name));
            continue;
          }
          const directory = path.join(modules, item.name);
          const manifest = path.join(directory, 'package.json');
          if (!existsSync(manifest)) continue;
          const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
          if (pkg.name.startsWith('@lexianchor/')) continue;
          entries.push({
            name: pkg.name,
            versions: [pkg.version],
            paths: [directory],
            license:
              typeof pkg.license === 'string'
                ? pkg.license
                : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN'),
            homepage: pkg.homepage,
          });
          scan(path.join(directory, 'node_modules'));
        }
      };
      scan(path.join(root, 'node_modules'));
      if (
        !entries.some((entry) => entry.name === 'pdfjs-dist') ||
        !entries.some((entry) => entry.name === '@browsermt/bergamot-translator')
      )
        throw new Error('Install the locked workspace dependencies before building notices.');
      const sections = [
        '# Installed dependency notices\n\nThis inventory includes build tools as well as runtime dependencies. It does not relicense them.',
      ];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        sections.push(
          `## ${entry.name} ${entry.versions.join(', ')}\nLicense: ${entry.license}\nUpstream: ${entry.homepage ?? 'See package source'}`,
        );
        for (const directory of entry.paths) {
          const collect = (dir: string, depth: number) => {
            for (const item of readdirSync(dir, { withFileTypes: true })) {
              if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
              const full = path.join(dir, item.name);
              if (item.isDirectory() && depth < 3) collect(full, depth + 1);
              else if (
                item.isFile() &&
                /^(licen[cs]e|copying|notice|copyright)([._-]|$)/i.test(item.name)
              ) {
                sections.push(
                  `### ${path.relative(directory, full)}\n\n${readFileSync(full, 'utf8')}`,
                );
              }
            }
          };
          collect(directory, 0);
        }
      }
      emit('licenses/DEPENDENCY-NOTICES.txt', sections.join('\n\n'));
      emit('licenses/LICENSE.txt', readFileSync(path.join(root, 'LICENSE'), 'utf8'));
      emit(
        'licenses/THIRD-PARTY-NOTICES.md',
        readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8'),
      );
      for (const name of readdirSync(path.join(root, 'docs/licenses'))) {
        emit(`licenses/${name}`, readFileSync(path.join(root, 'docs/licenses', name), 'utf8'));
      }
      for (const kind of ['dictionary', 'translation']) {
        const dir = path.join(root, 'packages', kind, 'resources');
        for (const name of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
          emit(`licenses/resources/${name}`, readFileSync(path.join(dir, name), 'utf8'));
        }
      }
    },
  };
}
