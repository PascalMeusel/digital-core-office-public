import { Baby, CalendarClock, CalendarDays, Clock3, Palmtree, Stethoscope, Sun } from 'lucide-react'

const icons = {
  holiday: Sun,
  vacation: Palmtree,
  sick_leave: Stethoscope,
  child_sick_leave: Baby,
  overtime_time_off: Clock3,
  external_busy: CalendarClock,
  custom_event: CalendarDays,
}

export function CalendarKindIcon({ kind }: { kind: string }) {
  const Icon = icons[kind as keyof typeof icons] ?? CalendarDays
  return <Icon className="calendar-kind-icon" size={12} strokeWidth={2} aria-hidden="true" />
}
