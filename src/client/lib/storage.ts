// Per-device conveniences. Never required for the app to work.
export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`hsa-locker:${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`hsa-locker:${key}`, JSON.stringify(value));
  } catch {
    /* private mode or storage full */
  }
}
