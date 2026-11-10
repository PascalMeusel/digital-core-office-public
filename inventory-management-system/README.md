# Inventory Management

Independent Digital Core Office inventory management system.

It contains its own React frontend, Express API, SQLite schema, authentication, role permissions, stock workflow endpoints, exports, QR login/scanning, and local bootstrap script.

## Everyday inventory workflows

The main workspace is **My work**, **Projects**, **Articles & stock**, **Requests**,
**Orders**, and **Places & room plan**. General supplies and experiments do not
need a project. Articles & stock contains the stock, catalog and product subviews.

**I need something** on My work, Requests and Projects opens a short request form:
the selected project's parts are visible immediately, with freely available stock.
**Show all articles** opens the complete catalog; typing searches all articles.
All matches can be browsed in the scrollable list, and **Request a new part** stays
above it. Without a project, the catalog is shown directly. Select an article or
paste a supplier link, then enter the quantity. Choose stock handout or purchase;
requesting more than is free does not silently create a purchase or reserve stock.
A supplier link needs a short part name. New parts can be requested without catalog
management rights. **Request multiple parts** and the project's **Request parts**
still open the batch composer directly.

While a request dialog stays open, quantities and supplier details remain attached
to their article when switching selections; the new-part draft stays separate.
Project changes retain those inputs and refresh the project supply information.
Search Enter only filters, and adding an already selected batch part never replaces
its quantity. Approval notes and confirmed order prices also survive toggling a
decision or selection. `node tests/request-usability.browser.test.mjs` exercises
these cases and a lost-response retry in Chromium and Firefox at mobile and desktop
widths, against an isolated database.

Each request position shows its next step and a collapsible **Request progress**.
Purchase progress follows approval, ordering and actual received quantities; stock
requests follow handout quantities. Deferrals and changes stay visible, and the
actual approver is named for the ordering step. Receipt progress describes delivery,
not a promise that those units are still freely available.

Under **Articles & stock → Parts & materials**, articles support a photo upload
or mobile camera capture (PNG/JPEG/WebP, max. 4 MB), an http(s) supplier link,
an optional EUR estimate and a controlled unit. The technical **Component value**
field remains separate (e.g. 10 kΩ). Prices accept comma or dot decimals, up to
four decimal places, without thousands separators or currency symbols.

**Import parts list** accepts pasted Excel cells, CSV/TSV or the first XLSX sheet
(max. 1,000 articles and 4 MB). Example headers: `Name;SKU;Unit;Category;Link;Price EUR`.
Only Name is mandatory. Preview validates all rows before an atomic import.
Existing matching articles are skipped; conflicting names/units and duplicates
need correction. This imports catalog definitions; quantities belong in receiving.

**Assign articles to projects** adds multiple articles to multiple project parts
lists, without reserving or duplicating stock. Existing project associations remain.
The same selection is available on individual articles. Historical requests,
orders and usage can still make an article appear after a manual association is removed.

**Activity & history** on an article or project shows recorded inventory actions
with actor and timestamp, including requests, approval, orders, receipt and usage.
Only inventory events and a restricted set of details are exposed to readers;
account/security history remains restricted. Older events are shown when recorded.
Photos are authenticated and stored inside SQLite, so ordinary inventory database
backups include them. The schema additions preserve existing tables and records.

To request purchases, select a project and choose **Request parts**. Enter
quantities next to the needed articles and **Send for approval** once for all of
them. The project is carried into the request; no product or build is required.
The list suggests the project's catalog category/code and parts from its existing
requests, assignments and builds. Search also finds articles elsewhere in the
catalog, and entered quantities remain visible while searching. New articles can
be requested through **Request a new part**, above the catalog list, without
creating stock. Enter a name, quantity, unit and optional supplier link, then
**Send for approval** directly; adding the part to a larger batch is optional.
Selected parts appear first, with supplier links beside their quantities.
Catalog links and estimates are proposed automatically;
new-item links and estimates are retained when received into the catalog.
General supplies can be requested
without a project; units such as m² accept decimal quantities.

**Paste a parts list** accepts Excel cells or quoted CSV (tabs, semicolons or
commas). Use Article and Quantity; optional columns are Unit, Link and Price EUR.
The preview resolves existing names/SKUs, validates new parts, combines repeated
rows and leaves already selected quantities unchanged. Parsing only prepares local
request positions. Sending creates the request; new catalog articles are created
with their first recorded delivery.
An unprocessed pasted list blocks submission so it cannot be silently omitted.
Both decimal comma and decimal point are accepted without thousands separators.
Rows with unexpected extra cells are rejected instead of silently shortening a
quantity or dropping a link. In comma-separated CSV, quote a decimal comma
(for example `"2,5"`); tab/semicolon-separated Excel lists accept it directly.

The **Requests** queue can be filtered by project/general supplies, status, own
requests or actions available to the current user. Search covers people, supplier,
article numbers and request/order references. A matching batch always retains its
sibling positions, including deferred or completed lines. Individual review notes
open in the request dialog, with focus on the reason, rather than below the queue.

Purchasing shows supplier links, a supplier suggestion, confirmed EUR unit prices,
shipping and the rounded order total. Missing prices remain visibly incomplete;
prices above the approved ceiling require revised approval. The form retains the
approval versions originally reviewed, including after a conflict refresh.

Receiving keeps separate drafts when switching deliveries inside the open dialog.
Quantities, common/override places, conditions and delivery notes survive switching
back. If an order changes concurrently, the receiver must explicitly update its
outstanding quantities and review the retained entries; quantities are never
silently reduced. Saving one delivery retains other entered drafts in the picker.
Closing/cancelling the dialog discards unsaved entries. Receiving without an order
keeps quantity, cost and condition per selected article and displays its unit.

Handout quantities remain attached to their selected storage place while the
dialog stays open. Looking at a second room no longer reduces the quantity entered
for the first one. Move and build-reservation choices also show full place paths.
Dialog scroll padding and focus visibility checks keep keyboard-focused controls
clear of sticky bars after short-viewport or virtual-keyboard size changes.

The selected project opens with a searchable **Parts & availability** overview,
including catalog articles with no stock. A sole active project is selected
automatically. Rows show physical stock, freely available stock, usable stock
allocated to this project, open purchase requests (including approved requests),
and the project's outstanding order quantities. Storage-place links open the
existing location view. **Request purchase** carries both the article and project
into the request; **Choose more parts** expands the same request to other articles.

New requested or ordered parts are visible in the project overview before their
first receipt creates a catalog article. Expand **Already requested or on order**
to see requester, review status, supplier order and outstanding quantity. New-part
forms also offer hints for identical names or supplier links in the same project;
these are informational and never merge requests or block additional demand.

Stock filters for a room or shelf include its descendant shelves/containers.
Location choices show the full hierarchy, including codes, so identically named
boxes in different rooms are distinguishable. Stock search also covers these paths
and shared catalog-project associations, without creating reservations.

Request rows show the same availability and procurement figures. Free stock
excludes all active allocations and unusable/quarantined stock. Project figures
exclude other projects; general-supply requests use the scope without a project.
Partial arrivals count only their outstanding remainder as ordered and do not
also count the original request. Assignment quantities from the state API already
exclude consumption. No shortage target is inferred from an empty stock position.

Notes, supplier links and estimated unit prices are optional details. Actual
prices and shared shipping are recorded by the approver when placing the order.
`POST /workflows/requests/batch` validates all lines in one transaction and saves
linked, individually reviewable requests using the existing permissions and
idempotency protection. An invalid line rejects the whole submission.

- **Products** are hardware designs with reusable parts lists. **Items** are the
  purchased components, equipment, supplies, and physical finished products.
- Hardware developers can maintain products, plan builds, reserve stock, and
  request purchases. A build snapshots its parts list and revision. Recording
  completed units consumes its reserved parts and creates finished stock.
- Software developers can request existing stock or purchases. Stock requests
  distinguish borrowing (with a later return) from using up materials.
- Buyers approve purchase requests and record the supplier orders they place.
  Approval does not itself create an order or contact a supplier.
- Receivers record partial deliveries and locations and fulfill stock requests.
  Usable project deliveries are reserved for their project or build; unrelated
  supplies remain free stock. Damaged or unchecked deliveries are quarantined.
  Wrong items do not fulfill the original order. Review held stock in the
  existing receiving journal before releasing it.
- Core also offers a combined purchasing/receiving role. Existing memberships
  are preserved; administrators can assign the new roles in Core's user directory.

Project overviews show needs, free/reserved stock, incoming orders, shortages,
places and costs. Shared shipping is allocated across order lines once, in cents.
Purchase costs and material use are displayed separately because they can overlap.
Unknown material prices remain visibly incomplete. Time/labor is not included.
Direct project reservations can be used or returned without defining a product.

Workflow mutations are transactional, audited, revision checked and idempotent
when a submission key is supplied. Schema migration is additive: existing stock,
rooms, receipts and assignment history remain intact. JSON exports include the
workflow documents and project assignments.

## Inventory projects

The **Projects** tab maintains project codes, names and descriptions independently
of the optional Agile product. Admins, hardware developers and stock managers can create projects. Admins and stock managers can
assign available stock quantities to them, with a responsible person and notes.
The project overview lists assigned items, places, quantities and return history.
Viewers can search and read these overviews. Return all assigned stock before
archiving a project; archived projects and assignment history remain available.

Stock assignment also offers an optional project field. Project and person
assignments share the same availability checks and record revisions. Inventory
CSV exports include active project allocations. Search requires every entered
word and supports item metadata, accents, locations and active project names/codes.

## Local Development

```bash
npm ci
npm run inventory:bootstrap-admin
npm run dev
```

- Web app: `http://localhost:5174`
- API health: `http://localhost:4187/api/health`

Copy `.env.example` to `.env` when local configuration is needed.

## Deployment

Use the supported [suite deployment guide](../deploy/README.md), including for an
Inventory-only company installation. It configures Core accounts, HTTPS, selected
products, timezone, and encrypted backups. The local bootstrap above is for
standalone development; suite deployments manage identities and product roles in
Core and link Inventory profiles on first authorized access.

Core verifies every suite request. Legacy module passwords/tokens cannot bypass
revocation, membership changes, or read-only access. Receiving consumes an explicit
source order atomically; retries with the same request key do not duplicate stock.
Assignment guards protect quantities in custody. Receipt corrections and reversals
retain the original journal and export separate adjustment rows.

Use the suite's online SQLite snapshots to back up the database and nested media.
Restore encrypted bundles into a new isolated directory and switch stopped
services to new volumes after verification. The older standalone
`inventory:restore` command also requires a new empty parent directory and refuses
in-place `--force` restoration.

## Android server selection

The current company client is the single [Digital Core Office Android app](../android-app/README.md),
which opens all enabled products through Core login. The Inventory-specific build
described below remains available for compatibility.

The Android-oriented web build is not tied to `review.example.test` or any other operator.
On first launch it asks for the HTTPS domain of the Digital Core Office installation,
checks the installation's Inventory API, and stores only the resulting service address
on the device. For the standard deployment, entering `office.example.com` resolves to
`https://office.example.com/inventory`.

Users can change the connected server from the sign-in screen or the signed-in app
header. The existing session token is cleared only when the new compatible server has
been selected successfully, so a credential from one installation is never sent to
another. Non-HTTPS addresses are rejected except for local development hosts.

Self-hosted Inventory servers allow the supported Capacitor/Tauri WebView origins and
identify the compatibility contract through `GET /inventory/api/health`.

## Contents

- `src/`: Inventory UI.
- `server/`: Inventory API and persistence.
- `shared/`: Inventory domain types.
- `scripts/bootstrapAdmin.ts`: Local admin account bootstrap.
