# Comic Reader on the Samsung TV (Tizen)

`tizen/` builds a Tizen web app that is only a launcher. Its `index.html` shows
a short debug block, then redirects to the hosted reader at
`https://comic-reader-eta.vercel.app/`. Everything after that is the live
Vercel site, so a reader change reaches the TV on the next launch, with no
rebuild and no reinstall. Only a change under `tizen/` needs a new install.

## Prerequisites

The one-time setup is the same as jellyfin-streamline's, and it is already done
on Doug's Mac: the Tizen CLI with the `TIZEN-9.0-WebAppDevelopment` package,
JDK 17, the certificate profile, and Developer Mode on the TV. Follow
[jellyfin-streamline's docs/tizen.md](https://github.com/dougiefresh49/jellyfin-streamline/blob/main/docs/tizen.md)
to set it up anywhere else. The scripts need this on `PATH`:

```sh
export PATH="$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH"
export PATH="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home/bin:$PATH"
```

Sign with the existing `treecastle-tv` profile, the one jellyfin-streamline
uses for the same TV.

## Build and install

```sh
CERT_PROFILE=treecastle-tv tizen/build.sh   # signed .wgt in tizen/.build/.buildResult/
tizen/install.sh <tv-ip>                    # sdb connect, then tizen install
```

Without `CERT_PROFILE`, `build.sh` stops after `tizen build-web`, which checks
the toolchain but gives you nothing you can install. The build output and the
`.wgt` are gitignored.

The reader URL is the `READER_URL` constant at the top of `tizen/app.js`. The hosts the app may reach are the `<access>` and
`<tizen:allow-navigation>` entries in `tizen/config.xml`: the Vercel host and
`*.supabase.co` (page images and bubble audio). A new runtime host in the
reader needs an entry there, then a rebuild and a reinstall.

## Gotchas

Each one is covered in full in jellyfin-streamline's doc.

- Host-IP trap: the TV accepts `sdb` only from the host IP set in Developer
  Mode, so when the Mac's IP changes, `sdb connect` fails while port 26101
  still looks open.
- Install with `tizen install`, never `sdb install`, which reports success and
  installs nothing.
- Never `pkill` anything sdb-related; it takes down the local sdb server and
  drops the connection.
- An install wipes the app's storage.
- The TV applies a default CSP of `script-src 'self'; style-src 'self'` to
  the packaged pages, so the launcher's script and style live in `app.js` and
  `app.css`. An inline `<script>` in `index.html` silently never runs.
- The TV's installer fails on a `.wgt` whose name has a space, with no log
  line. `tizen package` names the file after `<name>`, so `build.sh` renames
  it to `ComicReader.wgt`.

## Debugging on the TV

The debug block on the launcher page shows the user agent, the Chrome version
parsed from it, `typeof tizen`, whether `tizen.tvinputdevice` exists, and the
target URL. It stays up for 5 seconds so you can read or photograph it; press
Enter to skip ahead. Once the redirect happens, that block is gone.

In Developer Mode the TV also exposes Chrome DevTools for this app, before and
after the redirect:

```sh
sdb -s <tv-ip>:26101 shell 0 debug CmcRdrTV01.ComicReader   # prints "... port: NNNNN"
sdb -s <tv-ip>:26101 forward tcp:NNNNN tcp:NNNNN
curl http://127.0.0.1:NNNNN/json                            # the page target and its ws URL
```

Open `devtools/inspector.html?ws=...` from that list in desktop Chrome, or
drive the WebSocket with any CDP client. A page whose app is not in the
foreground (the TV screen off, or another app in front) reports
`visibilityState: hidden` and its subresource loads never finish, so check
`document.visibilityState` before you read anything into a stalled page.

## Findings

First install, 2026-10-20, on the UN60DU7200FXZA (#950). Read through the
DevTools route above.

- Engine: Tizen 9.0, Chromium 120.0.6099.5, 1920x1080 CSS pixels at DPR 1.
  The user agent has no `Chrome/` token:
  `Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36`.
  A TV check added to the reader should match `SMART-TV` or `Tizen`, not a
  Chrome version (the reader has no such check yet).
- On the launcher page, `tizen` and `tizen.tvinputdevice` exist. After the
  redirect to the reader, `typeof tizen` and `typeof webapis` are
  `undefined`: the hosted reader gets no Tizen APIs, as Samsung's hosted-app
  FAQ says.
- The navigation itself is allowed: calling the launcher's `go()` from
  DevTools ran `location.replace`, which took the main frame to the reader,
  and the requests to the Vercel host and `*.supabase.co` went out. The
  5-second timer never fired on its own, because the app was hidden (below).
- On the reader origin, `CSS.supports` is true for `oklch()`,
  `color-mix()` and nesting, and `CSSLayerBlockRule` and `CSSPropertyRule`
  exist, so Tailwind 4's output is within this engine. `navigator.serviceWorker`
  exists and the origin is a secure context.
- On screen, 2026-10-20 and 21 (#951, #962): the library and reader pages
  render, the arrows move focus and turn pages, Enter plays a bubble with the
  words lighting, and the service worker registers and controls the page.
  On the first install the page never got past loading, because the app was
  not in the foreground (most likely the screen was off) and stayed hidden.
- Keys from DevTools: `sdb shell 0 debug` launches the app in debug mode, so
  it is a way to start the app as well as to inspect it. Over the forwarded
  port, CDP `Input.dispatchKeyEvent` drives the reader like the remote. Back
  is `windowsVirtualKeyCode` 10009. Doug's physical remote reaches the
  reader's arrow keys.
- The network remote does not pair. A socket on `wss://<tv-ip>:8002` (or
  `ws://` on 8001) to `samsung.remote.control` opens, but the TV sends no
  frame: no `ms.channel.connect`, no `unauthorized`, no Allow prompt. This
  was true with Settings > Connection > Network > Expert Settings > IP Remote
  turned on, and with Access Notification set to "First Time Only".
- One media decoder at a time: when a second `<audio>` starts, the voice
  that was playing drops to readyState 1 and never fires `ended` (#962).
  Web Audio buffers don't take that decoder: TV mode plays panel music, SFX
  and ambience as `decodeAudioData` buffers, and the voice `<audio>` still
  plays to `ended` and auto-advances under looping music. A 30 s library
  track fetches and decodes in about 0.9 s (#965).
- Full-size page images are the bottleneck in panel view. Camera motion
  re-rastered the 1988x3057 WebP every frame (about 4.7 s per panel move),
  and with motion off every panel move still re-decoded it (about 1.2 s),
  because the page plane remounts. TV mode turns motion off and
  shows a copy with its long edge capped at 2448 px, which stays in the
  decode cache: about 160 ms per panel move and about 35 ms per arrow press
  in page view (#962).
- CSS `zoom` is the legacy kind in Chromium 120: `getBoundingClientRect()`
  on a zoomed element is in unzoomed units.

## Home screen

Research only, 2026-10-21 (#979), from Samsung's developer docs; nothing
here has run on the TV yet.

- No public API feeds the home screen's Continue Watching row. Samsung's
  [Product API index](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references.html)
  has no module for it, so there is no documented way for a web app to put
  a book there.
- The documented option is [Smart Hub Preview](https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview.html):
  up to 40 tiles that show "when the user hovers over your application icon
  in the launcher", each deep-linking into the app. A personal preview comes
  from a service app in the same package that calls
  `webapis.preview.setPreviewData()`, declared with the
  `http://samsung.com/tv/metadata/use.preview` = `bg_service` metadata
  ([personal preview guide](https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/implementing-personal-preview.html)).
  The preview guides name no privilege and no partner or store requirement
  for it.
- Samsung's guide says "All Samsung TVs from 2016 through 2021 support Smart
  Hub Preview" and says nothing about later years, so whether this 2024
  Tizen 9 TV shows the tiles is unknown until a build tries it.
- The service is a separate app from the hosted reader, and the reader's
  `localStorage` belongs to the Vercel origin, so in-progress books would
  have to reach the service through the server. A tile's `action_data`
  arrives on the packaged page as the `PAYLOAD` app-control entry, which the
  launcher would turn into a reader path before its redirect
  ([public preview guide](https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/implementing-public-preview.html)).
