/** Durations and relative times for the hub. Pure functions, no locale. */

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0)
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function formatAgo(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime();
  if (ms < 45_000) return "just now";
  return `${formatDuration(ms)} ago`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return n === 1 ? word : pluralWord;
}
