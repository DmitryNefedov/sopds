// Five-field cron expressions (minute hour day-of-month month day-of-week).
// A leaf utility with two unrelated consumers: settings validation of the
// `scanCron` value, and the scan scheduler's minute tick.

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export function isValidCron(expr: string): boolean {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p, i) => fieldValid(p, RANGES[i][0], RANGES[i][1]));
}

function fieldValid(field: string, lo: number, hi: number): boolean {
  return field.split(',').every((token) => {
    const [range, stepStr] = token.split('/');
    if (stepStr !== undefined && (!/^\d+$/.test(stepStr) || Number(stepStr) < 1)) {
      return false;
    }
    if (range === '*') return true;
    const [a, b] = range.split('-');
    const na = Number(a);
    if (!/^\d+$/.test(a) || na < lo || na > hi) return false;
    if (b !== undefined) {
      const nb = Number(b);
      if (!/^\d+$/.test(b) || nb < lo || nb > hi) return false;
    }
    return true;
  });
}

// Returns true if `date` matches the cron expression.
export function cronMatches(expr: string, date: Date = new Date()): boolean {
  if (!isValidCron(expr)) return false;
  const parts = expr.trim().split(/\s+/);
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  return parts.every((field, i) => matchField(field, values[i], i));
}

function matchField(field: string, value: number, idx: number): boolean {
  const [lo, hi] = RANGES[idx];
  return field.split(',').some((token) => {
    const [range, stepStr] = token.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let start = lo;
    let end = hi;
    if (range !== '*') {
      const [a, b] = range.split('-');
      start = Number(a);
      end = b !== undefined ? Number(b) : Number(a);
    }
    for (let n = start; n <= end; n += step) {
      if (n === value) return true;
      // Sunday can be 0 or 7 for day-of-week
      if (idx === 4 && value === 0 && n === 7) return true;
      if (idx === 4 && value === 7 && n === 0) return true;
    }
    return false;
  });
}
