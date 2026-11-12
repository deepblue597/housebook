// UI text of the printable emergency sheet (D44).
import { formatDate } from '../domain/dates';

export const EMERGENCY = {
  title: 'Emergency sheet',
  back: 'Back to the house',
  print: 'Print or save as PDF',
  printHint:
    'Your browser’s print dialog prints it, or saves it as a PDF (choose “Save as PDF” as the printer). Keep a copy where it is needed when the power is out, e.g. inside the fuse box door.',
  printed: (date: string, version: string) => `Printed ${formatDate(date)} · version ${version}`,
  intro: 'Where to find what you need in an emergency, and what to do.',
  loading: 'Loading the house…',
  loadFailed: 'Couldn’t load the house.',
  retry: 'Try again',
  none: 'No emergency items yet.',
  noneHelp:
    'Water and gas valves, the fuse box, the boiler and the router are emergency items by default. Mark any other item as one with “Emergency item” in its note.',
  plan: (floor: string) => `${floor} plan`,
  unplaced: 'Not on the plan',
  where: (room: string | null, floor: string | null) =>
    room && floor ? `${room}, ${floor}` : (room ?? floor ?? 'Not on the plan'),
  brandModel: 'Make and model',
  support: 'Support',
  noHelp: 'Nothing written in the note yet.',
  askPrinted: 'Did it print (or save)?',
  askPrintedHint: 'If so, the Attention view reminds you to print it again when it changes.',
  yesPrinted: 'Yes, remember this version',
  notPrinted: 'No',
  lastPrinted: (date: string) => `Last printed here on ${formatDate(date)}`,
  upToDate: 'and still up to date.',
  outOfDate: 'but the house has changed since: print it again.',
  // Attention view
  reprint: (date: string) => `The emergency sheet printed on ${formatDate(date)} is out of date.`,
  reprintLink: 'Print it again',
  open: 'Emergency sheet',
};
