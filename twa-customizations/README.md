# twa-customizations

Native changes that Bubblewrap does not know about, plus the script that puts
them back after every regeneration.

## Why this exists

`bubblewrap update` (and answering "Y" to the *regenerate the project?* prompt
during `bubblewrap build`) rewrites `app/` wholesale from `twa-manifest.json`.
Anything hand-edited in there disappears — silently. The resulting APK installs
and runs perfectly well; it just quietly stops doing AdTrace attribution.

So the customizations live here, and `apply.mjs` re-applies them.

## What it applies

| Change | Why |
|---|---|
| `LauncherActivity.java` | Reads the Google Advertising ID from Play Services and appends it to the launch URL as `?gps_adid=…`. A TWA has no native↔web bridge, so this is the only way the PWA's AdTrace Web SDK can learn the device id. |
| `proguard-rules.pro` | `minifyEnabled true` is on for release with no rules file otherwise, and R8 strips the advertising-id lookup — breaking attribution in release builds only. |
| `mavenCentral()` in the root `build.gradle` | `io.adtrace:android-sdk` is on Maven Central; the generated project only declares `google()` and the long-dead `jcenter()`. |
| `proguardFiles` + two dependencies in `app/build.gradle` | AdTrace SDK and `play-services-ads-identifier`. |
| Three `<uses-permission>` in `AndroidManifest.xml` | `INTERNET`, `ACCESS_NETWORK_STATE`, and `AD_ID` (mandatory at `targetSdk >= 31`). The generated manifest declares none. |

`apply.mjs` is idempotent and exits non-zero if an anchor is missing, so a
Bubblewrap template change shows up as a failed build instead of a quietly
broken release. It also asserts the version in `app/build.gradle` matches the
constants at the top of the script — bump both when shipping a new version.

## Building

```bash
# 1. Bump appVersionName / appVersion / appVersionCode in twa-manifest.json,
#    and the matching constants at the top of apply.mjs.

# 2. Regenerate, then re-apply.
bubblewrap update --skipVersionUpgrade
node twa-customizations/apply.mjs

# 3. Build + sign. Answer N to any "regenerate the project?" prompt — a Y here
#    drops everything step 2 just applied.
bubblewrap build --skipPwaValidation
```

If a global proxy is configured in `~/.gradle/gradle.properties` and isn't
running, Gradle fails to resolve anything. Either start it, or build the
unsigned APK directly and sign that:

```bash
./gradlew :app:assembleRelease -Dhttp.proxyHost= -Dhttps.proxyHost=
```

## Verifying a build

```bash
BT=~/.bubblewrap/android_sdk/build-tools/35.0.0
APK=app/build/outputs/apk/release/app-release-unsigned.apk

# versionCode, versionName, and the three permissions
$BT/aapt2 dump badging $APK | grep -E "^package:|uses-permission"

# the GAID path survived R8
unzip -p $APK classes.dex | strings | grep -E "gps_adid|getGoogleAdId"
```

On device:

```bash
adb logcat -s PortfoLauncher:V
```

Expect `GAID resolved: <present>` → `Launching TWA (callback)` → `Appended
gps_adid to launch URL`. On a device without Play Services expect `GAID lookup
timed out after 1000ms` and a launch anyway — never a hang.

Deep links must keep working, since `getLaunchingUrl()` appends to the intent's
URL rather than rebuilding it:

```bash
adb shell am start -a android.intent.action.VIEW \
  -d "https://portfo.plus/app/portfolio?foo=bar" plus.portfo.twa
```

`foo=bar` must survive alongside the added `gps_adid`.

## The web half

The APK is only half the integration. `portfo.plus` must preserve the param
through its auth redirect and hand it to `initSdk` — see `src/proxy.ts`,
`src/lib/platform.ts` and `src/lib/analytics/adtrace.ts` in the app repo. If
that half is not deployed, the launch URL param is dropped before any JS runs
and this APK's work is wasted.
