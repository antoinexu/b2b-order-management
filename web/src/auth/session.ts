const TOKEN_KEY = 'b2b.token';

export const tokenStorage = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token: string) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export interface SessionSnapshot {
  token: string | null;
  version: number;
  signal: AbortSignal;
}

let snapshot: SessionSnapshot | undefined;
let controller: AbortController;
const listeners = new Set<() => void>();

function getSnapshot(): SessionSnapshot {
  if (!snapshot) {
    controller = new AbortController();
    snapshot = { token: tokenStorage.get(), version: 0, signal: controller.signal };
  }
  return snapshot;
}

function sync() {
  const previous = getSnapshot();
  const token = tokenStorage.get();
  if (token === previous.token) return;
  const oldController = controller;
  controller = new AbortController();
  snapshot = { token, version: previous.version + 1, signal: controller.signal };
  oldController.abort();
  listeners.forEach((listener) => listener());
}

export const sessionStore = {
  getSnapshot,
  sync,
  subscribe(listener: () => void) {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && (event.key === TOKEN_KEY || event.key === null)) sync();
    };
    listeners.add(listener);
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener('storage', onStorage);
    };
  },
  setToken(token: string) {
    getSnapshot();
    tokenStorage.set(token);
    sync();
  },
  clearIfCurrent(session: SessionSnapshot) {
    sync();
    if (getSnapshot() !== session) return;
    tokenStorage.clear();
    sync();
  },
};

/** Also checks storage before its cross-tab event has been delivered. */
export function assertCurrentSession(session: SessionSnapshot) {
  sync();
  if (getSnapshot() !== session) throw new DOMException('Your account changed. Please try again.', 'AbortError');
}
