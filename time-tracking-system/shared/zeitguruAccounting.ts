/** Normalized server-side source evidence. `details` must be encrypted and excluded from public state. */
export type ZeitguruWeekDay = 'mo' | 'tu' | 'we' | 'th' | 'fr' | 'sa' | 'su'
export interface ZeitguruAccountingContract {
  sourceId: string; validFrom: string; validTo: string; interval: 'weekly' | 'monthly'; totalHours: number;
  dailyQuota: Record<ZeitguruWeekDay, number | null>; intervalStartDay: number; mainBranchId?: string;
  applyQuotaOnHolidays: boolean; applyFixedValueOnHolidays: boolean; minutesToApplyOnHolidays: number;
  vacationDayCredit: number | null; illnessDayCredit: number | null;
}
export interface ZeitguruAccountingDay {
  date: string; expectedMinutes: number; workedMinutes: number; absenceMinutes: number;
  holidayMinutes: number; correctionMinutes: number; creditedMinutes: number; balanceMinutes: number;
  /** Exact daily change before the vendor rounds its displayed running balance. */
  exactDeltaMinutes: number;
  absence?: { typeCode: string; typeName: string; startsHalfDay: boolean; endsHalfDay: boolean };
  details: Record<string, unknown>;
}
export interface ZeitguruAccountingForecastDay {
  date: string; expectedMinutes: number;
  quotaMinutes?: number; absenceMinutes?: number; holidayMinutes?: number;
}
export interface ZeitguruAccountingReport {
  fromDate: string; toDate: string; observedAt: string;
  opening: { date: string; minutes: number };
  openingKnown: boolean; balanceBasis: 'source_opening' | 'period_delta';
  /** Exact balance immediately before fromDate; rounding belongs to display only. */
  openingBalanceMinutes: number; closingBalanceMinutes: number;
  days: ZeitguruAccountingDay[]; contracts: ZeitguruAccountingContract[];
  forecast: ZeitguruAccountingForecastDay[]; warnings: string[]; details: Record<string, unknown>;
}
