export function nowIso(): string {
  return new Date().toISOString();
}

export function ageMs(iso: string): number {
  return Date.now() - Date.parse(iso);
}
