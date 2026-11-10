# Administrator request queue

The administrator view defaults to pending requests, oldest submission first, across
all dates. Status, employee, type, text and requested-date filters combine; pending
requests no longer bypass explicit filters. The list renders 25 requests per page,
with a separate selected-request review pane and a stacked phone layout. A deep link
or linked request can remain open outside the current filters, explicitly labelled.

Time corrections compare currently effective records with proposed start/end, breaks,
worked minutes and estimated credit change. This is a current reference, not a saved
submission snapshot. Original imported durations use the source ledger. Overnight
requests are labelled. Missing/invalid details and running entries disable approval
in this view; server validation and permissions remain authoritative and unchanged.

The pane includes submitted reason, employee identity, submission and decision dates,
attachments, decision notes, daily checks, absence/holiday overlap and other pending
requests. Matching reconstruction proposals show linked source/destination dates and
submitted requests; edited proposals retain the submitted reason instead of falsely
claiming a match to the current plan. Date-range requests include calendar-day and
weekday counts; the displayed vacation balance is current and excludes pending leave.

Approval/rejection is explicit for the selected request. There is no bulk approval.
Read-only users cannot decide; the existing request mutation and audit flows remain.
