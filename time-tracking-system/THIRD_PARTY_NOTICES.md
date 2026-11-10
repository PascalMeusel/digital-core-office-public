# Third-Party Notices

This project includes third-party software. Each dependency is licensed by its own owner under its own terms.

This file is a release checklist and summary, not a replacement for the license files included in `node_modules`, Cargo crates, or generated distribution artifacts.

## Runtime Web/API Dependencies

| Package | Version checked | License |
| --- | ---: | --- |
| cors | 2.8.6 | MIT |
| csv-parse | 7.0.0 | MIT |
| date-holidays | 3.30.2 | ISC AND CC-BY-3.0 |
| date-holidays-parser | 3.4.7 | ISC |
| express | 5.2.1 | MIT |
| js-yaml | 4.3.0 | MIT |
| lodash | 4.18.1 | MIT |
| lucide-react | 1.21.0 | ISC |
| node-ical | 0.26.1 | Apache-2.0 |
| nodemailer | 9.0.1 | MIT-0 |
| prepin | 1.0.3 | Unlicense |
| react | 19.2.7 | MIT |
| react-dom | 19.2.7 | MIT |
| tsdav | 2.3.0 | MIT |
| tsx | 4.22.4 | MIT |

CalDAV support also pulls in `@js-temporal/polyfill` 0.5.1 (ISC), `rrule-temporal` 1.5.3 (MIT), `sax` 1.6.0 (BlueOak-1.0.0), `temporal-polyfill` 0.3.2 (MIT), `temporal-spec` 0.3.1 (ISC), and `xml-js` 1.6.11 (MIT).

## Development And Build Dependencies

| Package | Version checked | License |
| --- | ---: | --- |
| @playwright/test | 1.61.1 | Apache-2.0 |
| @types/cors | 2.8.19 | MIT |
| @types/express | 5.0.6 | MIT |
| @types/node | 24.13.2 | MIT |
| @types/nodemailer | 8.0.1 | MIT |
| @types/react | 19.2.17 | MIT |
| @types/react-dom | 19.2.3 | MIT |
| @vitejs/plugin-react | 6.0.3 | MIT |
| concurrently | 10.0.3 | MIT |
| oxlint | 1.71.0 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| vite | 8.1.0 | MIT |

## Release Checklist

- Run `npm install` from a clean checkout and confirm package licenses again before each public release.
- Include this file and `LICENSE.md` in any source or binary distribution.
- Keep dependency source/license notices available to customers who self-host or audit the app.
