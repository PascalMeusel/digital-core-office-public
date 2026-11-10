# Third-Party Notices

This repository includes third-party software. Each dependency is licensed by its own owner under its own terms.

This file is a release checklist and summary, not a replacement for the license files included in package metadata, `node_modules`, or generated distribution artifacts.

## Runtime Web/API Dependencies

| Package | Used by | Version declared | License |
| --- | --- | ---: | --- |
| cors | Time, Inventory, Agile | ^2.8.6 | MIT |
| csv-parse | Time | ^7.0.0 | MIT |
| date-holidays | Time | ^3.30.2 | ISC AND CC-BY-3.0 |
| express | Core, Time, Inventory, Agile | ^5.2.1 | MIT |
| lucide-react | Core, Time, Inventory, Agile | ^1.21.0 | ISC |
| node-ical | Time | ^0.26.1 | Apache-2.0 |
| nodemailer | Core, Time | ^9.0.1 | MIT-0 |
| qrcode | Core, Inventory | ^1.5.4 | MIT |
| react | Core, Time, Inventory, Agile | ^19.2.7 | MIT |
| react-dom | Core, Time, Inventory, Agile | ^19.2.7 | MIT |
| tsdav | Time | ^2.3.0 | MIT |
| tsx | Core, Time, Inventory, Agile | ^4.22.4 / ^4.23.0 | MIT |
| ws | Time | ^8.21.0 | MIT |

Time Tracking CalDAV support also pulls in packages such as `@js-temporal/polyfill`, `rrule-temporal`, `sax`, `temporal-polyfill`, `temporal-spec`, and `xml-js`. Review the installed dependency tree before each public release.

## Development And Build Dependencies

| Package | Used by | Version declared | License |
| --- | --- | ---: | --- |
| @playwright/test | Time | ^1.61.1 | Apache-2.0 |
| @types/* packages | Core, Time, Inventory, Agile | package-specific | MIT |
| @vitejs/plugin-react | Core, Time, Inventory, Agile | ^6.0.2 | MIT |
| concurrently | Core, Time, Inventory, Agile | ^10.0.3 | MIT |
| oxlint | Core, Time, Inventory, Agile | ^1.69.0 | MIT |
| typescript | Core, Time, Inventory, Agile | ~6.0.2 | Apache-2.0 |
| vite | Core, Time, Inventory, Agile | ^8.1.0 | MIT |

## Release Checklist

- Run `npm ci` from a clean checkout in each app and confirm package licenses before each public release.
- Review transitive dependency licenses from each `package-lock.json`.
- Include this file and `LICENSE.md` in any source or binary distribution.
- Keep dependency source/license notices available to customers who self-host or audit the software.
