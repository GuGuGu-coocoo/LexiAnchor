export interface RecentBook {
  readonly id: string;
  readonly title: string;
  readonly author: string;
  readonly format: 'EPUB' | 'PDF';
  readonly progressPercent: number;
  readonly updatedAt: string;
}

export function normalizeProgress(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }

  return Math.min(100, Math.max(0, Math.round(percent)));
}
