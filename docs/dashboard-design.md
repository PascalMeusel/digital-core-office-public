# Dashboard design direction

The dashboard is a daily work instrument for clocking, checking recorded time and reviewing requests. The current refinement keeps its navigation and workflows familiar while removing decoration that competes with those jobs.

## Design tokens

- Paper: `#f4f7f8`, the light workspace canvas.
- Surface: `#ffffff`, the content surface.
- Ink: `#243041`, primary reading text.
- Rule: `#bdc9d6`, boundaries between interactive regions.
- Action: `#0f766e`, the established teal for actionable controls.
- Night: `#101418`, the existing dark workspace canvas; its established lighter text and teal tokens remain in use.

Type uses the existing locally available humanist sans stack for continuity, with explicit reading hierarchy and tabular numerals for changing durations. No font downloads or ornamental display face are needed for a time ledger. Panel headings are sentence case; helper text is secondary and limited in measure.

The active clock remains the recognizable control at the top. Review queues use one list with a detail area; summaries and exports stay collapsible below. Content and headers share a common horizontal inset, and long values wrap inside their allocated column. There is one normal panel border, with no shadow pretending to be another border. Floating menus retain a shadow to distinguish them from the content underneath.

```
Active clock and work location
Days requiring attention: list | selected day's details
Worked time / overtime / exports: collapsible sections
Time log and notifications
```

The initial design already leaned heavily on equally weighted cards, gradients and raised metrics. This pass removes those repeated decorations instead of applying a new dashboard template. Color identifies state and action; spacing distinguishes hierarchy. Native and custom selects receive visible hover/focus feedback without changing control dimensions.

Future structural React work follows the requested composition and performance skills: compose explicit sections, keep interaction state local, derive values rather than mirror them into effects, and avoid new polling or layout state for CSS concerns.

Selection must not change a control's geometry. Tabs and filters keep the same font weight, padding and border width in every state; color and an inset underline identify the active choice. Press and hover feedback must not translate or scale buttons. Verify sibling positions as well as the selected control at narrow wrapping widths.

Disclosures animate their height over 220 ms and reverse smoothly on repeated input. Respect reduced motion and keep popovers unclipped after expansion. Calendar cells have fixed heights with compact, single-line event previews. A bounded, searchable day agenda provides the full list; overflowing events must never expand the grid. Use the event title before its owner in previews. Keep the legend beneath the grid, outside its horizontal scroll area.

Calendar editors use a focused dialog with consistent field spacing, native date/time inputs, a neutral cancel action and a clear save action. Destructive actions use red and an explicit confirmation. Keep unsaved input when background state refreshes. CSV export is an ordinary available action with its own pending state and an inline download result, independent of unrelated loading indicators.

Day and week calendars show the entire 00:00–24:00 timeline inside a bounded scroll area. Start at 07:00 when navigating; preserve the user's position during background refreshes. Day headings and the time axis remain visible while scrolling vertically and horizontally. Calendar export is a quiet text action below the legend, leaving the header for date and view navigation.

All systems use the Inventory workspace's background construction: the same vertical fade, strength and neutral base in each theme. Shared suite tokens own the geometry (260px / 8% in light, 280px / 9% in dark); modules only choose a tint. Core is violet, Time blue, Inventory retains its existing teal tint and Agile uses amber. Reuse this construction for loading and authentication surfaces too.

Calendar categories use opaque fills with white text, a minimum measured text contrast of 5:1, and matching small symbols in entries and the legend. Holidays are ochre, vacation green, sickness red, child sickness violet, time off cyan, external events slate and own events blue. Color never depends on the underlying day cell. Keep the same category colors across themes, add a lighter boundary in dark mode, and retain descriptive text/tooltips so identification does not rely only on color.
