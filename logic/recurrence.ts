/** Accepted `rec:` values: optional `+` for strict recurrence, positive amount. */
export const RECURRENCE_PATTERN = /^(\+)?([1-9]\d*)([dwmy])$/i;

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

function addRecurrence(date: Date, recurrence: Recurrence): Date {
  const next = new Date(date.getTime());
  switch (recurrence.unit) {
    case "d":
      next.setUTCDate(next.getUTCDate() + recurrence.amount);
      break;
    case "w":
      next.setUTCDate(next.getUTCDate() + recurrence.amount * 7);
      break;
    case "m":
      next.setUTCMonth(next.getUTCMonth() + recurrence.amount);
      break;
    case "y":
      next.setUTCFullYear(next.getUTCFullYear() + recurrence.amount);
      break;
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
  return { due: nextDue, threshold: nextThreshold };
}
