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

The reader URL is the `READER_URL` constant at the top of the script in
`tizen/index.html`. The hosts the app may reach are the `<access>` and
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

## Debugging on the TV

A retail TV has no console, no address bar, and no web inspector. The debug
block on the launcher page is the only on-screen diagnostics: the user agent,
the Chrome version parsed from it, `typeof tizen`, whether
`tizen.tvinputdevice` exists, and the target URL. It stays up for 5 seconds so
you can read or photograph it; press Enter to skip ahead. Once the redirect
happens, that block is gone.

## Findings

Filled in by the lead after the first install (#950).
