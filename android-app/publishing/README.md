# Google Play test-release tooling

This optional CLI checks and uploads tested Android bundles to an explicitly
configured testing track. It runs outside the Android application. The source
snapshot includes no publisher account configuration, credentials, tester lists,
signed bundles or publication receipts.

Install and test the tool from the repository root:

```powershell
npm ci --prefix android-app/publishing --ignore-scripts
npm test --prefix android-app/publishing
```

Configure your own service account and test track using the paths documented by
`play.mjs` and `config.example.json`. Keep credentials and signing material in
the ignored `android-app/secrets/` directory. Grant only the app-specific
permissions required for the intended testing track.

`check --record <build-record.json>` validates the recorded artifact offline.
`tracks` reads configured tracks. `validate --record <build-record.json>`
uploads into a temporary edit and discards it after validation.
`publish --record <build-record.json>` commits the tested bundle to the
configured testing track. These last three commands contact Google Play.

Use a new version code for each release and preserve the exact tested bundle,
checksum and build record. Inspect an uncertain commit before retrying.
Production publishing requires separately configured access and release decisions.
