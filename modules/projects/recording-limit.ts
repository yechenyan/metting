export const defaultMaxRecordingMinutes = 180;
export const millisecondsPerMinute = 60_000;

export function validRecordingMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value * millisecondsPerMinute)
  );
}
