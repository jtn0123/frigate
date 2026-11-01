# Frigate Viewer (Android)

A native Android client for a [Frigate NVR](https://frigate.video) server, built with
Kotlin and Jetpack Compose.

## Features

- **Sign in** with Frigate's own login on port 8971, or with no login on port 5000.
  For Frigate's self-signed certificate, the app shows its SHA-256 fingerprint once
  for you to trust, then accepts only that certificate.
- **Cameras**: every camera as a tile, refreshed from `latest.jpg` every 5 seconds,
  with its unreviewed count and last activity. One or two columns.
- **Camera detail**: real-time live video from go2rtc, with HD/SD, mute and fullscreen;
  the last 15 minutes, hour or 6 hours of recordings; and the camera's activity for
  the last 24 hours. Live video stops while the app is in the background.
- **Review**: alerts and detections from the last 24 hours, filtered by severity and
  camera and grouped by day. Each opens its recording, with Older and Newer to step
  through. Swipe a row either way to mark it reviewed, with Undo for a few seconds.
  "Mark all reviewed" asks first.
- **Settings**: server details, the trusted certificate, whether to track what is left
  to review (turn it off to drop the counts, badges and Mark reviewed controls and just
  browse activity), whether opening an item marks it reviewed on the server (on by
  default, as in the web UI), the color theme (T3 Code's six dark themes), and sign out.

The app reopens on the same screen after Android stops it in the background.

## Install on your phone

1. Build the APK (see below), or download `android-app-debug` from a "Fork - Android" run.
2. Turn on USB debugging on the phone, connect it, and run
   `adb install -r app/build/outputs/apk/debug/app-debug.apk`. Over Wi-Fi, turn on
   **Wireless debugging** instead and run `scripts/install.sh <host:port>` with the
   address it shows (add `--debug` for the debug build). The script builds, connects
   and installs for the phone's main user, which a Secure Folder or work profile
   otherwise makes fail.
3. Open **Frigate**, enter the server address, for example `https://192.168.1.10:8971`,
   with your Frigate username and password, and turn on **Self-signed certificate** if
   Frigate uses its default one.
4. Compare the fingerprint the app shows with the one your browser shows for the same
   address, then tap **Trust**.

The phone has to reach the server, so use your home network or a VPN when away.

### Away from home: the built-in WireGuard tunnel

The app can carry its own WireGuard tunnel, used only when the server does not answer
directly, and only for the app's own connections (the rest of the phone is untouched).

1. On the VPN server create a client and download its `.conf` file. On a UniFi gateway:
   **Settings > VPN > VPN Server**, a **WireGuard** server, **Add Client**, then
   **Download** the configuration.
2. Copy the file to the phone, then in the app open **Settings > Remote access > Set up
   WireGuard** and pick it. Android asks once to allow the VPN connection.

Each time the app comes to the front, and when the phone changes network, it tries the
server directly over Wi-Fi or mobile data. If that works the tunnel stays off; if not it
comes up, with Android's key icon in the status bar. It closes a minute after the app
leaves the screen. The home screen widget uses the tunnel only while it is up. The
server address should be one the VPN routes to, such as its LAN address.

When it does not connect, **Settings > Remote access > Tunnel log** shows each step: the
direct check (which network, how long, what failed), the tunnel starting, and the bytes
sent and received while it waits for the VPN server to answer. **Copy** or **Share**
gives a report with WireGuard's own log lines added. It never contains the keys, and
addresses in it, IPv4 and IPv6, are cut to their kind and last number (`public …14`); host
names are cut to their ending (`a hostname ending .org`). WireGuard's
`UAPIOpen: mkdir /data/data/com.wireguard.android: permission denied` is harmless, and the
report says so. Over adb,
`adb logcat -s FrigateTunnel` shows the same steps.

What the log's messages usually mean:

- **"Direct check: answered over Wi-Fi"** and the tunnel stays off: you are home, or the
  server address is reachable from where you are. Nothing to fix.
- **"No answer yet … sent N bytes, received 0 bytes"**: the phone sends handshakes and the
  VPN server never replies. Check, in order:
  1. This phone's client is on the server: saved before the file was downloaded (on UniFi,
     **Apply Changes** after **Add Client**), and not deleted or re-created since. A
     WireGuard server ignores a key it does not know without a word, so a re-created client
     needs its new file. On UniFi, the client list's **Active Clients** stays 0. Check the
     VPN server is on, too.
  2. The report's "VPN server" line. "a private IPv4 address" or "a carrier-grade NAT
     address" cannot be reached from the internet: your gateway is behind another router
     or your ISP's NAT. Forward the UDP port on the router in front, or use a different
     remote access method.
  3. The UDP port is open to the internet. Some mobile networks block UDP, so try from
     another Wi-Fi too.
  4. The official WireGuard app with the same file. If it does not connect either, the
     cause is the server or the network, not this app.
- **"Tunnel did not start: Android did not start the VPN"**: another VPN app is on. Only
  one VPN runs at a time.
- **"received" grows but the cameras do not load**: the tunnel works but does not route
  to the server. The file's AllowedIPs must cover the server's address (the UniFi default,
  all traffic, does).

## Build

Release APKs carry native code for 64-bit devices only, arm64 and x86_64 (WireGuard's
library is about 3.4 MB per ABI); debug APKs include every ABI.

Requires JDK 21 and the Android SDK (compileSdk 37).

```bash
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:testDebugUnitTest    # unit tests (JVM, no device needed)
./gradlew :app:lintDebug
./gradlew spotlessApply             # format with ktlint (spotlessCheck verifies)
./gradlew :app:detekt               # static analysis (config/detekt.yml)
./gradlew :app:koverHtmlReportDebug # test coverage, app/build/reports/kover/htmlDebug
scripts/check.sh                    # everything CI runs; --fix formats first
```

The fork's `.github/workflows/fork-android.yml` runs `scripts/check.sh` (the checks,
tests with coverage, lint, and both debug and the minified release builds) on Linux for
every push and pull request that changes `fork/android/`. Run it locally before pushing. Detekt findings that predate it are in
`app/detekt-baseline.xml`; new code is held to the rules. The check ends with the unit
tests' line coverage, measured by Kover; there is no minimum yet.

### Screenshot tests

`ScreenshotTest` renders the sign-in screen, Settings, the review list and camera grid
skeletons, and an empty state on a phone-sized screen under Robolectric, with
[Roborazzi](https://github.com/takahirom/roborazzi). The golden images are committed in
`app/src/test/screenshots`, and every unit test run (so `scripts/check.sh` and CI too)
compares against them and fails on a difference, leaving the new image and a diff
(`*_actual.png`, `*_compare.png`) in `app/build/outputs/roborazzi`. After an intended
visual change, re-record them, look at the new images, and commit them:

```sh
./gradlew :app:recordRoborazziDebug
```

Gradle checks every dependency against the SHA-256 sums in
`gradle/verification-metadata.xml`, so a tampered or swapped download fails the build.
After changing a version in `gradle/libs.versions.toml`, regenerate the file over the
tasks CI runs and review the diff:

```sh
./gradlew --write-verification-metadata sha256 spotlessCheck :app:detekt \
    :app:testDebugUnitTest :app:koverXmlReportDebug :app:lintDebug :app:assembleDebug :app:assembleRelease
```

aapt2 ships one jar per platform and only the local one is downloaded, so add the
Linux jar's sum for CI by hand from Google Maven's `aapt2-<version>-linux.jar.sha256`.

## How it talks to Frigate

| Feature        | Endpoint |
| -------------- | -------- |
| Login          | `POST /api/login`. The JWT arrives in `Set-Cookie` and is sent back as that cookie, so Frigate renews it before it expires. |
| Sign out       | `GET /api/logout`, so the token stops working on the server rather than when it expires |
| Cameras        | `GET /api/config`, which also gives the go2rtc stream names (with credentials masked) |
| Snapshots      | `GET /api/<camera>/latest.jpg?h=<height>` |
| Review list    | `GET /api/review?after=&limit=` (filters apply on the phone) |
| Mark reviewed, and Undo  | `POST /api/reviews/viewed` (`reviewed: false` to undo) |
| Thumbnails     | `/clips/review/<file>` (from `thumb_path`) |
| Recordings     | `/vod/<camera>/start/<s>/end/<e>/index.m3u8` (HLS) |
| Live video     | `wss://<server>/live/mse/api/ws?src=<stream>`, go2rtc's MSE stream behind Frigate's auth, the same one the web UI uses |

Live video is fragmented MP4 over the WebSocket, played by ExoPlayer (`MseDataSource`).
When it cannot start, the camera falls back to refreshing snapshots.

## Code layout

- `data/`: the HTTP client and auth (`Http.kt`), the Frigate API (`FrigateApi.kt`), the
  live stream (`MseDataSource.kt`), models and saved settings.
- `tunnel/`: the app-only WireGuard tunnel (`RemoteAccess` decides when it is up,
  `DirectRoute` tries the server around it, `TunnelBackend` wraps WireGuard's library).
- `ui/`: Compose screens, `AppViewModel` for session and navigation, and `ReviewStore`
  for the review list. `ReviewStore` and the `data/` classes have no Android
  dependencies and are tested on the JVM against MockWebServer. Compose components
  such as the certificate prompt and review rows are tested on the JVM too, under
  Robolectric.

## Security notes

- The password is never stored. The JWT is encrypted with a key kept in the Android
  Keystore, and it and the settings live in the app's private storage, which is
  excluded from backups and device transfer.
- The WireGuard file, private key included, is encrypted with the same Keystore key and
  is never logged or shown. Its tunnel is limited to this app whatever the file says.
- With **Self-signed certificate** on, only the certificate you trusted is accepted. If
  it changes, the app signs out and shows the new fingerprint at sign-in.
- Plain HTTP (port 5000) is allowed because Frigate often runs that way on a LAN.
  Anything sent over it is unencrypted, so the app refuses to send a password over
  HTTP to an address that is not on a private network (or a Tailscale address).
- Release builds are signed with this machine's debug key, so updates install over the
  existing app only from the same machine. Keep a copy of `~/.android/debug.keystore`
  and restore it on a new computer before building, or the phone will refuse the
  update until the app is uninstalled (which signs you out).
