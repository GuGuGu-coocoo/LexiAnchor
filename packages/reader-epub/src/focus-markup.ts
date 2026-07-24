const SKIPPED_ELEMENTS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'SVG', 'MATH']);
const WORD_PATTERN = /([A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’][A-Za-zÀ-ÖØ-öø-ÿ]+)?)/g;

function prefixLength(word: string): number {
  if (word.length <= 3) {
    return 1;
  }

  return Math.ceil(word.length * 0.45);
}

function canDecorate(node: Text): boolean {
  const parent = node.parentElement;

  if (!parent || !node.data.trim()) {
    return false;
  }

  return !parent.closest(
    `${[...SKIPPED_ELEMENTS].map((tag) => tag.toLowerCase()).join(',')},[data-lexianchor-focus="word"]`,
  );
}

export function applyFocusMarkup(document: Document): void {
  if (!document.body || document.body.dataset.lexianchorFocus === 'on') {
    return;
  }

  document.body.dataset.lexianchorFocus = 'on';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE && canDecorate(node as Text)) {
      textNodes.push(node as Text);
    }
  }

  for (const textNode of textNodes) {
    const parts = textNode.data.split(WORD_PATTERN);

    if (parts.length === 1) {
      continue;
    }

    const fragment = document.createDocumentFragment();

    for (const part of parts) {
      if (!WORD_PATTERN.test(part)) {
        fragment.append(part);
        WORD_PATTERN.lastIndex = 0;
        continue;
      }

      WORD_PATTERN.lastIndex = 0;
      const length = prefixLength(part);
      const word = document.createElement('span');
      const anchor = document.createElement('span');
      word.dataset.lexianchorFocus = 'word';
      anchor.dataset.lexianchorFocus = 'anchor';
      anchor.textContent = part.slice(0, length);
      word.append(anchor, part.slice(length));
      fragment.append(word);
    }

    textNode.replaceWith(fragment);
  }
}

export function removeFocusMarkup(document: Document): void {
  if (!document.body || document.body.dataset.lexianchorFocus !== 'on') {
    return;
  }

  for (const word of document.querySelectorAll<HTMLElement>('[data-lexianchor-focus="word"]')) {
    word.replaceWith(document.createTextNode(word.textContent ?? ''));
  }

  document.body.normalize();
  delete document.body.dataset.lexianchorFocus;
}
