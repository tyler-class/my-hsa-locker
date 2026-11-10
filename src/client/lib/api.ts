// Thin JSON client for the Worker API.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(
      0,
      'offline',
      'You seem to be offline. Try again when you have a connection.',
    );
  }
  const text = await res.text();
  const data: unknown = parseBody(text);
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    // Logged out: tell the app, except when it's asking about the session itself (that
    // would ask again, in a loop).
    if (res.status === 401 && path !== '/login' && path !== '/session')
      unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(
      res.status,
      err.error ?? 'error',
      err.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Raw-body file upload with progress. One file per request. */
export function uploadFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<{ duplicate: boolean; document: import('@shared/types').DocumentSummary }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      const data = parseBody(xhr.responseText) as { message?: string; error?: string };
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else {
        if (xhr.status === 401) unauthorizedListeners.forEach((fn) => fn());
        reject(
          new ApiError(
            xhr.status,
            data?.error ?? 'error',
            data?.message ?? `Upload failed (${xhr.status}).`,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'You seem to be offline.'));
    xhr.send(file);
  });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
