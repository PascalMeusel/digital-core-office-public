# Google Play data-safety working sheet

This answer set describes version 1.0.1 (version code 2) as implemented. Recheck it whenever an SDK,
analytics product, crash reporter, push service, or server feature changes.

## Publisher-operated collection

- No advertising, analytics, crash-reporting, or publisher telemetry SDK is included.
- The app publisher does not receive customer operational data merely because the
  app is installed.
- The selected server address is stored locally in private app preferences.
- Authentication cookies and site storage remain locally in Android WebView storage.
- Google Code Scanner / Google Play services processes camera input in its own UI and
  returns the selected barcode value to the app. The app requests no camera permission.

## Customer-server processing

Accounts, time records, inventory records, projects, audit events, uploaded files,
and QR targets are sent to the server deliberately selected by the user. That server
is controlled by the customer organization, which determines its own privacy,
retention, deletion, and security rules. This processing must be assessed in the
Play Console questionnaire using Google’s current definitions; do not automatically
claim “no data collected” solely because Pascal Meusel does not operate the server.

## Security and deletion

### ExampleCompany evaluation feature (server-side, September 2026)

The ExampleCompany company server optionally connects an employee's own Zeitguru account.
After that employee verifies the account and opts in, the server forwards ordinary
clock-in/out and break actions to Zeitguru. Login credentials are transmitted for
sign-in; the password is discarded and the resulting provider session is stored
encrypted on that company server. An encrypted delivery journal retains action and
confirmation history. Disconnect removes the active stored session; company backups
follow the operator's retention policy. This feature is disabled on the synthetic
Play review server and on other deployments by default. Assess this optional
customer-server forwarding in the final Console answers; it is not publisher analytics.

Employees can also explicitly import their own closed Zeitguru history into an
encrypted archive on the company server, using a saved connection or a one-time
verified login. This reads historical work/break records and associated credits;
it does not alter the provider's records or activate forwarding. Undo removes
unchanged records added by that import while retaining a batch audit. Company
backups can retain earlier snapshots under the operator's retention policy.

### General app behavior

- Data in transit: HTTPS required by the client.
- Account creation: managed by the selected customer server.
- Local deletion: Change server clears WebView cookies/storage; uninstalling removes
  remaining private app data.
- Server deletion requests: contact the organization operating the chosen server.
- Publisher contact: dev.meusel@outlook.de.

Final Play Console answers require a manual review against the questionnaire shown
at submission time and the final privacy notice.

