import { ToolFailure } from "./tool-errors.ts";

/** Accepted `rec:` values: optional `+` for strict recurrence, positive amount. */
const RECURRENCE_PATTERN = /^(\+)?([1-9]\d*)([dwmy])$/i;

export interface Recurrence {
  strict: boolean;
  amount: number;
  unit: "d" | "w" | "m" | "y";
}

export function parseRecurrence(value: string): Recurrence | undefined {
  const trimmed = value.trim();
  const match = RECURRENCE_PATTERN.exec(trimmed);
  if (match === null) {
    return undefined;
  }
  return {
    strict: match[1] !== undefined,
    amount: Number.parseInt(match[2], 10),
    unit: match[3].toLowerCase() as Recurrence["unit"],
  };
}

/** Midnight UTC for the calendar day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Parses a `YYYY-MM-DD` tag value and rejects impossible calendar dates. */
export function parseDateTag(
  value: string | string[] | undefined,
): Date | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  const match = text === undefined
    ? null
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date;
}

/** Number of days in a UTC calendar month; `monthIndex` is 0-based. */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Builds a UTC date, clamping the day to the last day of the target month.
 * Without this, `2026-01-31 +1m` would overflow into March.
 */
function clampedUtcDate(
  year: number,
  monthIndex: number,
  day: number,
): Date {
  const lastDay = daysInUtcMonth(year, monthIndex);
  return new Date(Date.UTC(year, monthIndex, Math.min(day, lastDay)));
}

function invalidRecurrence(recurrence: Recurrence): ToolFailure {
  const value = `rec:${recurrence.strict ? "+" : ""}${recurrence.amount}` +
    recurrence.unit;
  return new ToolFailure(
    "INVALID_ARGUMENT",
    `Invalid recurrence "${value}": the next date is out of range. ` +
      "Nothing was saved.",
    { amount: recurrence.amount, unit: recurrence.unit },
  );
}

function addRecurrence(date: Date, recurrence: Recurrence): Date {
  let next: Date;
  switch (recurrence.unit) {
    case "d":
    case "w": {
      const days = recurrence.unit === "w"
        ? recurrence.amount * 7
        : recurrence.amount;
      next = new Date(date.getTime());
      next.setUTCDate(next.getUTCDate() + days);
      break;
    }
    case "m": {
      const targetMonth = date.getUTCMonth() + recurrence.amount;
      const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
      const monthIndex = ((targetMonth % 12) + 12) % 12;
      next = clampedUtcDate(targetYear, monthIndex, date.getUTCDate());
      break;
    }
    case "y":
      next = clampedUtcDate(
        date.getUTCFullYear() + recurrence.amount,
        date.getUTCMonth(),
        date.getUTCDate(),
      );
      break;
  }

  const year = next.getUTCFullYear();
  if (
    !Number.isFinite(next.getTime()) ||
    year < 1 ||
    year > 9999
  ) {
    throw invalidRecurrence(recurrence);
  }
  return next;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

export interface NextRecurrence {
  due: Date;
  threshold?: Date;
}

/**
 * Computes the next occurrence's dates using the shared todo.txt convention:
 * `rec:+1w` advances from the original due date, plain `rec:1w` from the
 * completion date. A threshold keeps its calendar-day offset from the
 * original due date; when there is no due date, the completion day is used as
 * the reference due date.
 *
 * Completed 2024-06-15:
 * - `due:2024-06-20 t:2024-06-10 rec:+1w` -> due 06-27, t 06-17
 * - `due:2024-06-01 t:2024-05-25 rec:1w`  -> due 06-22, t 06-15
 * - `t:2024-06-01 rec:1w`                 -> due 06-22, t 06-08
 */
export function nextRecurrence(
  recurrence: Recurrence,
  due: Date | undefined,
  threshold: Date | undefined,
  completedAt: Date,
): NextRecurrence {
  const today = startOfUtcDay(completedAt);
  const base = recurrence.strict && due !== undefined ? due : today;
  const nextDue = addRecurrence(base, recurrence);

  if (threshold === undefined) {
    return { due: nextDue };
  }

  const referenceDue = due ?? today;
  const offset = daysBetween(referenceDue, threshold);
  const nextThreshold = new Date(nextDue.getTime());
  nextThreshold.setUTCDate(nextThreshold.getUTCDate() - offset);

  // The offset can push the threshold outside the supported year range even
  // when the due date itself is valid (for example a year-9999 due date with a
  // late threshold). Fail the whole mutation instead of persisting a broken
  // `t:` value.
  const thresholdYear = nextThreshold.getUTCFullYear();
  if (
    !Number.isFinite(nextThreshold.getTime()) ||
    thresholdYear < 1 ||
    thresholdYear > 9999
  ) {
    throw invalidRecurrence(recurrence);
  }
  return { due: nextDue, threshold: nextThreshold };
}
