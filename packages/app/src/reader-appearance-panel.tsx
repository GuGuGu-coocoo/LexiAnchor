import { useEffect, useMemo, useState } from 'react';

import { defaultReaderPreferences, type ReaderPreferences } from '@lexianchor/reader-core';
import type { MessageKey } from '@lexianchor/i18n';

import {
  defaultReaderPresetId,
  persistReaderPresetStore,
  readReaderPresetStore,
  type ReaderPreset,
} from './reader-preferences';
import { readerColorsForTheme, type Theme } from './theme';

interface ReaderAppearancePanelProps {
  readonly preferences: ReaderPreferences;
  readonly theme: Theme;
  readonly t: (key: MessageKey) => string;
  readonly onApplyPreferences: (preferences: ReaderPreferences) => void;
  readonly onThemeChange: (theme: Theme) => void;
}

function samePreset(
  preset: Pick<ReaderPreset, 'theme' | 'preferences'>,
  theme: Theme,
  preferences: ReaderPreferences,
): boolean {
  return (
    preset.theme === theme && JSON.stringify(preset.preferences) === JSON.stringify(preferences)
  );
}

function presetId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `preset-${Date.now().toString(36)}`;
}

export function ReaderAppearancePanel({
  preferences,
  theme,
  t,
  onApplyPreferences,
  onThemeChange,
}: ReaderAppearancePanelProps) {
  const [presetStore, setPresetStore] = useState(readReaderPresetStore);
  const activePreset = presetStore.presets.find(
    (preset) => preset.id === presetStore.activePresetId,
  );
  const defaultPreset = useMemo<ReaderPreset>(
    () => ({
      id: defaultReaderPresetId,
      name: t('defaultPreset'),
      theme: 'system',
      preferences: {
        ...defaultReaderPreferences,
        ...readerColorsForTheme('system'),
      },
    }),
    [t],
  );
  const isModified = !samePreset(activePreset ?? defaultPreset, theme, preferences);

  useEffect(() => {
    persistReaderPresetStore(presetStore);
  }, [presetStore]);

  function updatePreference<Key extends keyof ReaderPreferences>(
    key: Key,
    value: ReaderPreferences[Key],
  ) {
    onApplyPreferences({ ...preferences, [key]: value });
  }

  function applyPreset(preset: ReaderPreset) {
    onThemeChange(preset.theme);
    onApplyPreferences({
      ...preset.preferences,
      ...readerColorsForTheme(preset.theme),
    });
    setPresetStore((current) => ({ ...current, activePresetId: preset.id }));
  }

  function saveAsPreset() {
    const sequence = presetStore.presets.length + 1;
    const preset: ReaderPreset = {
      id: presetId(),
      name: `${t('readingPreset')} ${sequence}`,
      theme,
      preferences,
    };
    setPresetStore((current) => ({
      activePresetId: preset.id,
      presets: [...current.presets, preset],
    }));
  }

  function overwriteActivePreset() {
    if (!activePreset) {
      return;
    }

    setPresetStore((current) => ({
      ...current,
      presets: current.presets.map((preset) =>
        preset.id === activePreset.id ? { ...preset, theme, preferences } : preset,
      ),
    }));
  }

  return (
    <details className="reader-appearance-panel">
      <summary>
        <span>{t('typographyAndLayout')}</span>
        <small>{t('collapsedSettingsHint')}</small>
      </summary>

      <div className="reader-appearance-content">
        <label className="reader-control reader-preset-control">
          <span>
            {t('currentPreset')}
            {isModified ? <output>{t('presetModified')}</output> : null}
          </span>
          <select
            aria-label={t('currentPreset')}
            value={presetStore.activePresetId}
            onChange={(event) => {
              const preset =
                event.target.value === defaultReaderPresetId
                  ? defaultPreset
                  : presetStore.presets.find((candidate) => candidate.id === event.target.value);
              if (preset) {
                applyPreset(preset);
              }
            }}
          >
            <option value={defaultReaderPresetId}>{t('defaultPreset')}</option>
            {presetStore.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>

        <label className="reader-control">
          <span>{t('appearance')}</span>
          <select
            value={theme}
            onChange={(event) => {
              const nextTheme = event.target.value as Theme;
              onThemeChange(nextTheme);
              onApplyPreferences({ ...preferences, ...readerColorsForTheme(nextTheme) });
            }}
          >
            <option value="system">{t('systemTheme')}</option>
            <option value="light">{t('lightTheme')}</option>
            <option value="dark">{t('darkTheme')}</option>
            <option value="eye-care">{t('eyeCareTheme')}</option>
          </select>
        </label>

        <label className="reader-toggle">
          <span>
            <strong>{t('focusMode')}</strong>
            <small>{t('focusModeDescription')}</small>
          </span>
          <input
            type="checkbox"
            checked={preferences.focusMode}
            onChange={(event) => updatePreference('focusMode', event.target.checked)}
          />
        </label>

        <label className="reader-control">
          <span>{t('focusStrength')}</span>
          <select
            value={preferences.focusStrength}
            onChange={(event) =>
              updatePreference(
                'focusStrength',
                event.target.value as ReaderPreferences['focusStrength'],
              )
            }
          >
            <option value="light">{t('lightStrength')}</option>
            <option value="medium">{t('mediumStrength')}</option>
            <option value="strong">{t('strongStrength')}</option>
          </select>
        </label>

        <label className="reader-control">
          <span>{t('readingLayout')}</span>
          <select
            value={preferences.flow}
            onChange={(event) =>
              updatePreference('flow', event.target.value as ReaderPreferences['flow'])
            }
          >
            <option value="paginated">{t('pageMode')}</option>
            <option value="scrolled">{t('scrollMode')}</option>
          </select>
        </label>

        <label className="reader-control" aria-disabled={preferences.flow === 'scrolled'}>
          <span>{t('pageColumns')}</span>
          <select
            value={preferences.pageSpread}
            disabled={preferences.flow === 'scrolled'}
            onChange={(event) =>
              updatePreference('pageSpread', event.target.value as ReaderPreferences['pageSpread'])
            }
          >
            <option value="single">{t('singleColumn')}</option>
            <option value="double">{t('doubleColumn')}</option>
          </select>
        </label>

        <label className="reader-control">
          <span>{t('fontFamily')}</span>
          <select
            value={preferences.fontFamily}
            onChange={(event) =>
              updatePreference('fontFamily', event.target.value as ReaderPreferences['fontFamily'])
            }
          >
            <option value="serif">{t('serifFont')}</option>
            <option value="sans-serif">{t('sansSerifFont')}</option>
          </select>
        </label>

        <label className="reader-control">
          <span>
            {t('fontSize')} <output>{preferences.fontSizePercent}%</output>
          </span>
          <input
            type="range"
            aria-label={t('fontSize')}
            min="80"
            max="180"
            step="5"
            value={preferences.fontSizePercent}
            onChange={(event) => updatePreference('fontSizePercent', Number(event.target.value))}
          />
        </label>

        <label className="reader-control">
          <span>
            {t('fontWeight')} <output>{preferences.fontWeight}</output>
          </span>
          <input
            type="range"
            aria-label={t('fontWeight')}
            min="350"
            max="700"
            step="50"
            value={preferences.fontWeight}
            onChange={(event) => updatePreference('fontWeight', Number(event.target.value))}
          />
        </label>

        <label className="reader-control">
          <span>
            {t('lineHeight')} <output>{preferences.lineHeight.toFixed(2)}</output>
          </span>
          <input
            type="range"
            aria-label={t('lineHeight')}
            min="1.2"
            max="2.2"
            step="0.05"
            value={preferences.lineHeight}
            onChange={(event) => updatePreference('lineHeight', Number(event.target.value))}
          />
        </label>

        <label className="reader-control">
          <span>
            {t('letterSpacing')} <output>{preferences.letterSpacingEm.toFixed(2)} em</output>
          </span>
          <input
            type="range"
            aria-label={t('letterSpacing')}
            min="0"
            max="0.15"
            step="0.01"
            value={preferences.letterSpacingEm}
            onChange={(event) => updatePreference('letterSpacingEm', Number(event.target.value))}
          />
        </label>

        <label className="reader-control">
          <span>
            {t('contentWidth')} <output>{preferences.contentWidthPercent}%</output>
          </span>
          <input
            type="range"
            aria-label={t('contentWidth')}
            min="55"
            max="100"
            step="5"
            value={preferences.contentWidthPercent}
            onChange={(event) =>
              updatePreference('contentWidthPercent', Number(event.target.value))
            }
          />
        </label>

        <label className="reader-control">
          <span>{t('textAlignment')}</span>
          <select
            value={preferences.textAlignment}
            onChange={(event) =>
              updatePreference(
                'textAlignment',
                event.target.value as ReaderPreferences['textAlignment'],
              )
            }
          >
            <option value="start">{t('alignLeft')}</option>
            <option value="justify">{t('justifyText')}</option>
          </select>
        </label>

        <label className="reader-control">
          <span>
            {t('wordSpacing')} <output>{preferences.wordSpacingEm.toFixed(2)} em</output>
          </span>
          <input
            type="range"
            aria-label={t('wordSpacing')}
            min="0"
            max="0.5"
            step="0.05"
            value={preferences.wordSpacingEm}
            onChange={(event) => updatePreference('wordSpacingEm', Number(event.target.value))}
          />
        </label>

        <div className="reader-preset-actions">
          <button type="button" onClick={saveAsPreset}>
            {t('saveAsPreset')}
          </button>
          <button type="button" disabled={!activePreset} onClick={overwriteActivePreset}>
            {t('overwritePreset')}
          </button>
          <button type="button" onClick={() => applyPreset(defaultPreset)}>
            {t('restoreDefaultSettings')}
          </button>
        </div>
      </div>
    </details>
  );
}
