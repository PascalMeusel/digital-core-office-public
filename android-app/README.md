# Digital Core Office for Android

One Android application opens Time Tracking, Inventory, and Projects from a
customer-operated Digital Core Office server. The server address is entered once,
validated through `/api/health` before sign-in, and can be changed with the
**Server wechseln / Change server** settings button on the login page. The
workplace uses the full content area without an additional native server bar.
The offline recovery screen also offers server switching. No server is selected by default.
Use an HTTPS origin (for example `office.example.com`, with an optional port),
without a page path, credentials, query, or fragment. The native error view
offers reload and change-server actions without depending on website JavaScript.

Updated Core servers also show a small fixed QR button at the bottom right after
sign-in, across the embedded workspaces. It opens the existing native scanner to
scan the desktop login page's QR code, then asks the user to confirm the account
before authorizing that device. The button is absent before login and password
changes, and does not require Inventory access. Server rollout and acceptance records are maintained privately.

## Security model

- Release builds accept HTTPS only and reject certificate errors.
- The WebView bridge is exposed only to the selected server origin. It supports
  QR scanning, changing servers, and bounded file exports; it exposes no arbitrary native API.
- Google Code Scanner supplies the native QR interface without giving this app
  camera permission.
- External origins open in the system browser. File and clear-text access are off.
- Changing servers clears cookies and WebView storage but never changes server data.

Browser-generated CSV, calendar, JSON, spreadsheet and attachment downloads use
Android's document picker. Exports up to 20 MB are transferred in ordered chunks
to a private temporary file before the picker opens; the selected destination
receives the exact bytes. Cancelled/finished exports remove the temporary copy.
The original server data remains unchanged. Larger exports report the limit and
can be downloaded from a desktop browser. Direct HTTPS downloads continue to use
Android Download Manager. A current Android System WebView is required for the
origin-restricted export bridge.

## Build and test

Install JDK 17 and Android SDK 36, then run:

```powershell
./gradlew testDebugUnitTest assembleDebug
./gradlew connectedDebugAndroidTest
```

The instrumented tests verify native recovery with an unavailable server and an
actual browser blob export through the document-picker callback into a saved file.
They also check blank first launch, invalid addresses, draft restoration on
rotation, saved-host persistence, and cookie clearing. Opt in to live acceptance:

```powershell
./gradlew connectedDebugAndroidTest '-Pandroid.testInstrumentationRunnerArguments.dcoLiveHost=office.example.test'
```

This validates the actual HTTPS server, loads its login page, recreates the app,
and changes/reconnects the host. An optional `live-test-credentials.json` in the
debug app's external files directory enables password and all-module checks.
It must contain `host`, `email`, and `password`; it is deleted before use and is
never part of an APK. Use a dedicated temporary account and revoke it afterward.
The opt-in `ServerSetupPreviewTest` accepts `dcoPreviewLocale` (`en` or `de`) and
`dcoPreviewDark` (`true` or `false`) for responsive screenshots.

The committed application id is permanently `de.digitalcoreoffice`. The current
minimum Android version is Android 10 (API 29), target/compile API is 36.

## Signing

The upload key and passwords live in `android-app/secrets/`, which is intentionally
gitignored. Keep an encrypted off-PC backup: losing the upload key complicates or
prevents future updates. `secrets/keystore.properties` uses:

```properties
storeFile=secrets/digital-core-office-upload.jks
storePassword=...
keyAlias=digital-core-office-upload
keyPassword=...
```

Create the Play bundle with `./gradlew bundleRelease`. Enrol in Play App Signing;
the local key is the upload key, while Google protects the distribution key.

The current release is version 1.0.3 (version code 4). Its signed APK, signed AAB,
checksums, and exact build-input record are under `artifacts/android` at the
repository root. Previous release artifacts are preserved. See
[release provenance](store-listing/release-artifact-provenance.md) for verification
results. Version 1.0.3 is published and available to internal testers in Play
Console (10 September 2026, 10:53).

For future uploads without manual Console file selection, the
[Google Play test publisher](publishing/README.md) checks the tested bundle and
submits it to the configured internal test track. Service-account access is
connected; the 1.0.3 update was published through the API and verified in Console.
The closed Alpha 1.0.2 draft remains until the initial Play setup is complete.
Switch the publisher to Alpha when that closed test is ready.
Production publishing is disabled for the current testing phase.

## Links and self-hosting

Verified Android App Links are declared for `review.example.test`. Arbitrary customer hosts
cannot be pre-verified in a Play manifest, but links scanned or opened inside the
app remain on the selected compatible server. Customers operate and secure their
own server; the app publisher does not provide hosting.
