# Calendar sharing

In Calendar, use **Share my calendar → Find people** to search eligible colleagues by name or email. Select **Grant access**, or **Remove** from the shared list, then **Save access**. Search filters never discard other selections. Unsaved choices survive background refreshes, and a failed save retains them for retry. Discard changes restores the saved selection.

The picker uses the server's existing `shareableCalendarUsers` directory. It cannot grant access outside administrator-defined calendar eligibility; inactive users are excluded. Existing server authorization and visibility rules remain unchanged. Sharing is directional and does not grant reciprocal access. Administrators retain their existing access. Read-only mode disables changes.

The Days needing attention header has an accessible Collapse/Expand button. Its preference is stored for the current account in this browser; it does not resolve any findings. The header retains the total unresolved-day count, including while filters are active. Reopening retains the current filters and selection.

Validation: standalone browser fixtures exercise grant/revoke, search, pagination, refreshes, saving failures/retry, discarded edits, changing eligibility, read-only mode, German/mobile layout, and collapse persistence. Existing full-app day resolution and accounting checks cover the integrated attention panel. No company sharing settings or attendance data are changed by tests.
