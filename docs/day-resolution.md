# Autofilled day resolution

Consecutive missing calendar dates for one employee are grouped under one
**Request vacation for this period** button. The request opens with both dates
filled in and still requires approval. Expand **Review individual days** to use
individual correction actions. Groups never cross a date that has an entry or a
different employee, and date filtering bounds the proposed range. Approved DCO
vacation on missing imported dates contributes absence credit; undo removes that
credit and restores the unresolved days.

For the ExampleCompany evaluation, approved imported days totalling exactly eight hours
with zero breaks are treated as historical absence placeholders. The configured
state holiday calendar takes priority, followed by explicit holiday/absence notes;
otherwise the company rule classifies them as vacation. Existing partial absences,
uncertain source records, overlapping intervals, and dates with native DCO entries
are excluded. The rule does not apply to native clock entries or other deployments.
The original archive and total credited time remain unchanged. The effective time
view shows absence instead of work, so those placeholders no longer cause break
warnings. Calendar and history display the classification. As with other imported
absences, historical entitlement is not inferred or deducted from a newly entered
DCO leave allowance.

In Days needing attention, **Auto-fill resolution** prepares an editable correction
request for missing, incomplete, invalid and overlapping entries and missing breaks.
Imported Zeitguru days now retain these actions alongside their source-review link.
Known starts and recorded gaps are retained; missing ends use the daily schedule.
Missing starts default to 09:00. These are proposals, not evidence of attendance.

For a day exceeding ten hours, **Prepare correction to 10 hours** fills an adjusted
end and a proposed break of at least 45 minutes. Review both against the actual work.
Use this option only for an incorrect record. Time actually worked must remain
recorded on its actual date. Spare capacity on another day is not evidence that
work occurred there; this release does not automatically transfer recorded time.

Review and confirm the proposed details, then submit for administrator approval.
Administrators may create a request for the employee shown on the issue; the
request remains pending until approved. The audit identifies the submitting actor
and employee. An approved correction uses the existing replacement and undo flow,
preserving original native entries and immutable imported records. DCO changes are
not sent to Zeitguru during the company evaluation.

An approved local override is shown as information rather than a new unresolved
day. Independent source problems, missing opening balances and checks requiring
human judgment remain visible. No records are guessed or edited merely by opening
or submitting a proposal.

## Email setup

Configure an authorized sender and SMTP credentials in Time → Settings → Mail
server. Port 465 uses immediate TLS; port 587 uses STARTTLS. Use **Send test email**
to verify delivery, then configure recipients and notification preferences.
Installation-specific addresses and saved settings are not included.

## Initial-import reconstruction proposals (ExampleCompany evaluation)

The first Zeitguru accounting import defines a fixed historical cutoff. Later imports
and native DCO work retain normal checks. Historical compliance findings are kept in
**Initial import review and proposals**, outside the current unresolved-day badge;
source discrepancies and missing days still require their ordinary review.

The importer derives proposals without modifying records or credits. For reliable,
approved source attendance it suggests a later start when the previous end leaves
less than eleven hours, and a shorter end when daily work exceeds ten hours. Displaced
minutes are proposed on recorded weekdays with capacity, then Saturdays, within the
same calendar month and initial import period. Every destination respects the proposed
ten-hour cap and adjacent eleven-hour intervals. Added break time is also an estimate.
Holidays, absences, untracked weekdays, source ambiguities and native clock dates are
excluded. Unplaceable minutes are explicitly listed; no hours are silently discarded.

Both the import history and review panel show before/after times, source/destination
dates and minute transfers. Nothing is described as autocorrected before review.
**Review correction proposal** opens the existing editable request with actual-work
confirmation and administrator approval. Review all linked dates together; approvals
are individual, so partial approval can temporarily change the balance. Already matching
approved corrections are identified; changed DCO days require manual comparison.
Source records stay immutable, and no corrections are sent to Zeitguru. This feature
produces estimates; available capacity is not evidence of actual attendance.
