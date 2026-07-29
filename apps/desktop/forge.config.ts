import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { MakerZIP } from '@electron-forge/maker-zip';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import type { ForgeConfig } from '@electron-forge/shared-types';

const execFileAsync = promisify(execFile);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'dev.lexianchor.reader',
    executableName: 'LexiAnchor',
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') {
        return;
      }

      // The Fuses plugin changes Electron after Packager's initial ad-hoc
      // signature. Re-sign the completed app bundle so macOS does not report
      // local test builds as damaged.
      await Promise.all(
        packageResult.outputPaths.map((outputPath) =>
          execFileAsync('/usr/bin/codesign', [
            '--force',
            '--deep',
            '--sign',
            '-',
            path.join(outputPath, 'LexiAnchor.app'),
          ]),
        ),
      );
    },
  },
  makers: [new MakerZIP({}, ['darwin', 'win32'])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
