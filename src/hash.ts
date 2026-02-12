export function normalizeForHash(input: string): string {
  let s = String(input ?? "").trim();

  // strip [[...]]
  if (s.startsWith("[[") && s.endsWith("]]")) {
    s = s.slice(2, -2).trim();
  }

  s = s.replace(/\\/g, "/");
  s = s.replace(/^\.\/+/, "");
  s = s.replace(/\/{2,}/g, "/");
  s = s.replace(/^\/+/, "");
  return s;
}

// FNV-1a 32-bit (stable, works on mobile too)
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashPathToId(path: string): string {
  const norm = normalizeForHash(path);
  return fnv1a32(norm).toString(36);
}

// Hash for non-path identifiers (e.g. timeline names)
export function hashKeyToId(key: string): string {
  const norm = String(key ?? "").trim().toLowerCase();
  return fnv1a32(norm).toString(36);
}