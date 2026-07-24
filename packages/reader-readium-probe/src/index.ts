import { EpubNavigator, type EpubNavigatorListeners } from '@readium/navigator';
import { HttpFetcher, Link, Manifest, Publication } from '@readium/shared';

/**
 * Compile-checked Readium Web integration seam used by ADR-0003.
 *
 * This deliberately accepts an RWPM URL rather than an EPUB file. Producing and
 * serving the manifest, positions list, and unpacked resources is the additional
 * backend/preprocessing boundary evaluated by the spike.
 */
export async function openReadiumWebProbe(
  container: HTMLElement,
  manifestUrl: string,
): Promise<EpubNavigator> {
  const fetcher = new HttpFetcher(undefined, manifestUrl);
  const manifestJSON = await fetcher.get(new Link({ href: manifestUrl })).readAsJSON();
  const manifest = Manifest.deserialize(manifestJSON);

  if (!manifest) {
    throw new Error('Readium Web could not deserialize the publication manifest.');
  }

  manifest.setSelfLink(manifestUrl);
  const publication = new Publication({ manifest, fetcher });
  const positions = await publication.positionsFromManifest();

  if (positions.length === 0) {
    throw new Error('Readium Web requires a positions list before the EPUB navigator can load.');
  }

  const navigator = new EpubNavigator(
    container,
    publication,
    {} as EpubNavigatorListeners,
    positions,
  );
  await navigator.load();
  return navigator;
}
