/**
 * Parse an ISO 8601 duration string (PTnHnMnS) to milliseconds.
 * Supports hours (H), minutes (M), and seconds (S) components.
 */
export function parseDuration(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) {
    throw new Error(`Invalid ISO 8601 duration: ${iso}`);
  }

  const hours = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const seconds = parseInt(match[3] ?? '0', 10);

  if (hours === 0 && minutes === 0 && seconds === 0) {
    throw new Error(`Invalid ISO 8601 duration: ${iso}`);
  }

  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}
