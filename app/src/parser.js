// Parse a MyPixhome instant-gallery URL into its pieces.
//
// Examples of URLs we accept:
//   https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788
//   https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic?storeId=8788
//   https://chicago-star-photography.mypixhome.com/instant-gallery/southport-spring-classic/?storeId=8788#/h_2026_04_12_04
//
// Returns { ok: true, domain, slug, storeId } on success, { ok: false, error } otherwise.

export function parseGalleryUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    return { ok: false, error: 'Please paste a gallery URL.' };
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "That doesn't look like a URL. It should start with https://" };
  }

  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, error: 'URL must start with https://' };
  }

  if (!/\.mypixhome\.com$/i.test(url.hostname)) {
    return { ok: false, error: 'This tool only works with mypixhome.com gallery links.' };
  }

  // Path: /instant-gallery/<slug>/ (trailing slash optional)
  const m = url.pathname.match(/^\/instant-gallery\/([^\/?#]+)\/?$/i);
  if (!m) {
    return {
      ok: false,
      error: 'URL should look like https://….mypixhome.com/instant-gallery/<event-slug>/?storeId=…',
    };
  }
  const slug = decodeURIComponent(m[1]).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return { ok: false, error: 'The event slug has unexpected characters.' };
  }

  const storeId = url.searchParams.get('storeId');
  if (!storeId || !/^\d+$/.test(storeId)) {
    return { ok: false, error: 'URL is missing ?storeId=… (a number).' };
  }

  return {
    ok: true,
    domain: url.hostname.toLowerCase(),
    slug,
    storeId,
  };
}

// Cache-key string uniquely identifying a gallery.
export function galleryKey(p) {
  return `${p.domain}|${p.slug}|${p.storeId}`;
}

// Reconstruct the canonical MyPixhome gallery URL from a parsed object.
export function buildGalleryUrl(p) {
  return `https://${p.domain}/instant-gallery/${p.slug}/?storeId=${p.storeId}`;
}
