# Overtime policy and administrator alerts

In Time → Settings → Overtime and alerts, a Time administrator can allow or
disallow overtime and configure separate positive and negative limits in hours.
Choose the displayed time-account balance, individual workdays, or both with
separate limits. Empty fields mean unlimited; equality with a limit is permitted.
Disallowing overtime sets the effective positive limit to zero. Work is always
recorded in full; this policy does not block punches, discard hours or change pay.

Email starts disabled. Configure the Time SMTP mail server, select active Time
administrators, enable alerts and save. The server checks every minute. New
settings evaluate the current balance immediately. Daily checks cover completed
work from the policy activation date; historical imports do not generate a series
of daily emails. Daily deviations exclude payouts and balance-only corrections;
approved absences and holidays reduce expected attendance.

Balance alerts use the same balance as the DCO summary, including imported
accounting. Missing opening balances or unresolved source checks are identified
as provisional in emails. The policy does not resolve those accounting questions.

One message per selected administrator is queued when a bound is crossed.
Remaining outside that bound does not repeatedly email. Returning within bounds,
crossing the opposite bound, or saving a new policy can generate a new alert.
Recipients are checked against current Core Time administrator access before
delivery. Policy edits are audited; policy and queued email content are encrypted
when installation data encryption is enabled and included in the suite backup.

The settings show pending, sent, failed and uncertain deliveries. Explicitly retry
known failures after fixing SMTP. An interrupted or ambiguous SMTP send is marked
uncertain and is not automatically retried; check the recipient mailbox first.

The company deployment reuses the existing DCO core symbol as the root favicon
(SVG, PNG, ICO and Apple touch icon). Browsers may cache the previous icon.
