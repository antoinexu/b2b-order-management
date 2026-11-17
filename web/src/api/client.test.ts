import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { sessionStore, tokenStorage } from '@/auth/session';

vi.stubEnv('VITE_API_URL', 'http://api.test');
const { createSessionClient } = await import('./client');

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });
  vi.stubGlobal('window', new EventTarget());
  sessionStore.sync();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('session-bound API requests', () => {
  it('rejects an old form before sending when storage changed before its event arrives', async () => {
    sessionStore.setToken('alpha');
    const session = sessionStore.getSnapshot();
    const client = createSessionClient(session);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    tokenStorage.set('bravo');
    await expect(client.POST('/customers', { body: { companyName: 'Wrong tenant' } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionStore.getSnapshot().token).toBe('bravo');
    expect(session.signal.aborted).toBe(true);
  });

  it('does not let a delayed old 401 log out the new account', async () => {
    sessionStore.setToken('alpha');
    const client = createSessionClient(sessionStore.getSnapshot());
    let reply!: (response: Response) => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    // Deliberately ignore abort to verify the response guard too.
    vi.stubGlobal('fetch', vi.fn(() => { started(); return new Promise<Response>((resolve) => { reply = resolve; }); }));
    const pending = client.GET('/users');
    await requested;
    sessionStore.setToken('bravo');
    reply(new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(tokenStorage.get()).toBe('bravo');
  });

  it('sends the captured token and revokes only the current session on 401', async () => {
    sessionStore.setToken('alpha');
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('Authorization')).toBe('Bearer alpha');
      return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetch);
    await createSessionClient(sessionStore.getSnapshot()).GET('/users');
    expect(tokenStorage.get()).toBeNull();
  });

  it('never revives an old client when the same account signs in again', async () => {
    sessionStore.setToken('alpha');
    const old = sessionStore.getSnapshot();
    const client = createSessionClient(old);
    sessionStore.clearIfCurrent(old);
    sessionStore.setToken('alpha');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(client.GET('/users')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('notifies subscribers of cross-tab sign-in, sign-out and storage.clear', () => {
    const changed = vi.fn();
    const unsubscribe = sessionStore.subscribe(changed);
    const send = (key: string | null) => window.dispatchEvent(Object.assign(new Event('storage'), { key, storageArea: localStorage }));
    tokenStorage.set('bravo');
    send('b2b.token');
    expect(changed).toHaveBeenCalledTimes(1);
    tokenStorage.clear();
    send(null);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(sessionStore.getSnapshot().token).toBeNull();
    unsubscribe();
  });
});
