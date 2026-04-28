# Image Optimization — Future Path

## Status: `pending` (revisit when on Supabase Pro)

## Today

`next.config.js` has `images.unoptimized: true`. Every `<Image>` component
renders a plain `<img>` pointing directly at the Supabase Storage CDN URL
returned by `pageImageUrl()`. There is no double-caching, no transform-
quota hit, and audio is unaffected (Next.js never optimized audio).

The cost: every client gets the full-size WebP regardless of viewport. For
this app that's tolerable — comic pages are meant to be displayed near
full-size, the originals are already sized for desktop reading (~940 KB
each), and family use means very low concurrent load.

Storage snapshot at the time this was written:
- `comic-pages`: 47 MB / 1 GB free tier
- `comic-audio`: 24 MB
- `comic-ocr-crops`: 8.5 MB

Bandwidth estimate per full-issue read: ~35 MB (22 MB images + 12 MB
audio). Comfortable headroom on both Supabase (5 GB/mo free) and Vercel
Pro (1 TB/mo).

## When to upgrade this

Upgrade to **Option 2 (Supabase Image Transformations + custom loader)**
when one of these is true:

1. You move to **Supabase Pro** (Image Transformations are Pro+ only).
2. You add **mobile-heavy reading patterns** where serving a 940 KB image
   to a phone over cellular feels slow.
3. You hit **noticeable bandwidth growth** on the Supabase egress meter
   (at 5 GB/mo free, 250 GB/mo on Pro, you'd need to be reading ~140
   issues/day to push it).

## How (Option 2: Supabase Image Transformations)

Supabase's Storage CDN supports image transformations via URL params on
Pro+:

```
https://<project>.supabase.co/storage/v1/render/image/public/comic-pages/
  tmnt-mmpr-iii/issue-1/page-01.webp?width=800&quality=80
```

Notable: the URL path changes from `/object/public/...` to
`/render/image/public/...` for transformations.

### 1. Custom Next.js loader

```ts
// src/lib/supabase-image-loader.ts
import "client-only";

interface LoaderArgs {
  src: string;
  width: number;
  quality?: number;
}

const STORAGE_OBJECT_RE = /\/storage\/v1\/object\/public\//;

export function supabaseImageLoader({ src, width, quality }: LoaderArgs): string {
  // Only transform images from our Supabase project; passthrough for
  // anything else.
  if (!STORAGE_OBJECT_RE.test(src)) return src;

  const transformed = src.replace(STORAGE_OBJECT_RE, "/storage/v1/render/image/public/");
  const params = new URLSearchParams({
    width: String(width),
    quality: String(quality ?? 80),
  });
  return `${transformed}?${params.toString()}`;
}
```

### 2. Wire it up in `next.config.js`

```js
images: {
  loader: "custom",
  loaderFile: "./src/lib/supabase-image-loader.ts",
  // remotePatterns is no longer required when using a custom loader.
  // unoptimized: true must be REMOVED.
},
```

`<Image>` then uses the loader to construct `srcset` URLs, e.g.
`?width=640`, `?width=1080`, `?width=1920` — Supabase resizes on the
edge, the browser picks the right one.

### 3. Drop `pageImageUrl` if convenient

Once `<Image>` handles URL construction, the `pageImageUrl()` helper is
only needed for non-`<Image>` use (e.g. the manual `new Image()` inside
`extractBubbleCrop` for the Re-run Gemini Context flow). Keep it; just
note that two paths exist.

## What to verify before flipping the switch

- [ ] You are on Supabase Pro (or the storage transformation add-on)
- [ ] CORS is still happy for the Re-run Gemini Context flow — the
      `<img crossOrigin="anonymous">` inside `extractBubbleCrop` should
      keep working since Supabase returns `Access-Control-Allow-Origin: *`
      on the render endpoint too. Quick smoke test: open a review page,
      hit Re-run Gemini Context, confirm no `SecurityError` from
      `canvas.toDataURL`.
- [ ] The `priority` and `fill` props on the existing `<Image>` calls
      still behave as expected. (They should — custom loaders don't
      change those.)
- [ ] Quality default. WebP at quality=80 is usually visually
      indistinguishable from quality=95 but materially smaller; tune if
      character art or text at small sizes looks soft.

## Audio path

No action needed. Audio is direct-from-Supabase today and will remain so.
Vercel does not optimize or cache audio assets.
