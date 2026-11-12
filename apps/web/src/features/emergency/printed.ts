/**
 * Which version of the emergency sheet was printed last, in this browser (D44): its fingerprint
 * and the day. Remembered only when the person says the print worked. Browser storage may be
 * missing or blocked (private windows): then nothing is remembered and nothing is reminded.
 */
const KEY = 'housebook.emergencySheet.printed';

export interface Printed {
  fingerprint: string;
  /** `YYYY-MM-DD` in the house's time zone. */
  date: string;
}

export function readPrinted(): Printed | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Printed> | null;
    return v && typeof v.fingerprint === 'string' && typeof v.date === 'string'
      ? { fingerprint: v.fingerprint, date: v.date }
      : null;
  } catch {
    return null;
  }
}

export function savePrinted(p: Printed): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage blocked: no reminder, nothing else changes
  }
}
