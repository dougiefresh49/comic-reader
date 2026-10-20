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
  A TV check in the reader matches `SMART-TV` or `Tizen`, not a Chrome version.
- On the launcher page, `tizen` and `tizen.tvinputdevice` exist. After the
  redirect to the reader, `typeof tizen` and `typeof webapis` are
  `undefined`: the hosted reader gets no Tizen APIs, as Samsung's hosted-app
  FAQ says.
- The redirect works: `location.replace` takes the main frame to the reader,
  and the requests to the Vercel host and `*.supabase.co` go out.
- On the reader origin, `CSS.supports` is true for `oklch()`,
  `color-mix()` and nesting, and `CSSLayerBlockRule` and `CSSPropertyRule`
  exist, so Tailwind 4's output is within this engine. `navigator.serviceWorker`
  exists and the origin is a secure context.
- Not yet observed: the library and a reader page rendering on screen, arrow
  keys turning pages, Enter playing a bubble, and the service worker
  registering. The app was not in the foreground during this install (most
  likely the screen was off), so the page stayed hidden and never finished
  loading.
