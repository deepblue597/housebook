/** "Data from …" in banners (D47): the time today, the date and time on another day. */
export function dataTime(at: Date, now: Date = new Date(), locale?: string): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
