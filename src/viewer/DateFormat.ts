/** Format ISO date as local time with UTC: "Jan 9, 2026, 3:45 PM (2026-01-09T23:45:00Z)" */
export function formatDateWithTimezone(isoDate: string): string {
  const date = new Date(isoDate);
  const local = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const utc = date.toISOString().replace(".000Z", "Z");
  return `${local} (${utc})`;
}

/** Format relative time: "5m ago", "2h ago", "yesterday", "3 days ago" */
export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
