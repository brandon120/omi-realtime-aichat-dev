import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { getApiBaseUrl } from '@/constants/Config';

const SID_KEY = 'sid_token';

function webLocalStorageGet(key: string): string | null {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch {}
  return null;
}

function webLocalStorageSet(key: string, value: string): void {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(key, value);
    }
  } catch {}
}

function webLocalStorageRemove(key: string): void {
  try {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.removeItem(key);
    }
  } catch {}
}

export async function saveSessionToken(token: string): Promise<void> {
  // Use localStorage on web, SecureStore on native
  if (Platform.OS === 'web') {
    webLocalStorageSet(SID_KEY, token);
    return;
  }
  try {
    await SecureStore.setItemAsync(SID_KEY, token);
  } catch {
    // Best-effort fallback
    webLocalStorageSet(SID_KEY, token);
  }
}

export async function getSessionToken(): Promise<string | null> {
  // Prefer web storage on web
  if (Platform.OS === 'web') {
    const fromWeb = webLocalStorageGet(SID_KEY);
    if (fromWeb) return fromWeb;
  }
  try {
    const val = await SecureStore.getItemAsync(SID_KEY);
    if (val) return val;
  } catch {}
  // Fallback to web storage in case SecureStore is unavailable
  return webLocalStorageGet(SID_KEY);
}

export async function clearSessionToken(): Promise<void> {
  if (Platform.OS === 'web') {
    webLocalStorageRemove(SID_KEY);
    return;
  }
  try {
    await SecureStore.deleteItemAsync(SID_KEY);
  } catch {}
  // Also clear web storage just in case
  webLocalStorageRemove(SID_KEY);
}

export function createApiClient(): AxiosInstance {
  const instance = axios.create({
    baseURL: getApiBaseUrl(),
    timeout: 15000,
  });

  instance.interceptors.request.use(async (config: AxiosRequestConfig) => {
    const token = await getSessionToken();
    if (token) {
      config.headers = config.headers || {};
      (config.headers as any)['Authorization'] = `Bearer ${token}`;
    }
    (config.headers as any)['Content-Type'] = 'application/json';
    return config;
  });

  return instance;
}

// ---- Typed helpers ----
export type LoginRequest = { email: string; password: string };
export type RegisterRequest = { email: string; password: string; display_name?: string };
export type User = { id: string; email: string; displayName?: string | null };

export async function apiLogin(req: LoginRequest): Promise<{ user: User; session_token: string } | null> {
  const client = createApiClient();
  const { data } = await client.post('/auth/login', req);
  if (data && data.ok && data.session_token) {
    await saveSessionToken(String(data.session_token));
    return { user: data.user, session_token: String(data.session_token) };
  }
  return null;
}

export async function apiRegister(req: RegisterRequest): Promise<{ user: User; session_token: string } | null> {
  const client = createApiClient();
  const { data } = await client.post('/auth/register', req);
  if (data && data.ok && data.session_token) {
    await saveSessionToken(String(data.session_token));
    return { user: data.user, session_token: String(data.session_token) };
  }
  return null;
}

export async function apiLogout(): Promise<void> {
  const client = createApiClient();
  try {
    await client.post('/auth/logout', {});
  } catch {}
  await clearSessionToken();
}

export async function apiMe(): Promise<{ user: User; omi_links: Array<{ omiUserId: string; isVerified: boolean }> } | null> {
  const client = createApiClient();
  try {
    const { data } = await client.get('/me');
    if (data && data.ok) return data;
  } catch {}
  return null;
}

// Account management
export async function apiUpdateProfile(params: { display_name?: string; email?: string; current_password?: string }): Promise<{ user: User } | null> {
  const client = createApiClient();
  try {
    const { data } = await client.patch('/account/profile', params);
    if (data && data.ok) return { user: data.user };
  } catch {}
  return null;
}

export async function apiChangePassword(current_password: string, new_password: string): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/account/password', { current_password, new_password });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

export async function apiListSessions(): Promise<Array<{ session_token_masked: string; createdAt: string; expiresAt: string; is_current: boolean }>> {
  const client = createApiClient();
  try {
    const { data } = await client.get('/account/sessions');
    if (data && data.ok) return data.sessions || [];
  } catch {}
  return [];
}

export async function apiRevokeSession(session_token: string): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/account/sessions/revoke', { session_token });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

export async function apiRevokeOtherSessions(): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/account/sessions/revoke-others', {});
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

export async function apiDeleteAccount(current_password: string): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.delete('/account', { data: { current_password } as any });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

export async function apiStartOmiLink(omi_user_id: string): Promise<{ dev_code?: string } | null> {
  const client = createApiClient();
  const { data } = await client.post('/link/omi/start', { omi_user_id });
  if (data && data.ok) return data;
  return null;
}

export async function apiConfirmOmiLink(omi_user_id: string, code: string): Promise<boolean> {
  const client = createApiClient();
  const { data } = await client.post('/link/omi/confirm', { omi_user_id, code });
  return !!(data && data.ok);
}

// Spaces & Windows
export async function apiGetSpaces(): Promise<{ active: string; spaces: string[] } | null> {
  const client = createApiClient();
  try {
    const { data } = await client.get('/spaces');
    if (data && data.ok) return { active: data.active, spaces: data.spaces };
  } catch {}
  return null;
}

export async function apiSwitchSpace(space: string): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/spaces/switch', { space });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

export async function apiListWindows(): Promise<Array<{ slot: number; isActive: boolean; title?: string | null; summary?: string | null }>> {
  const client = createApiClient();
  try {
    const { data } = await client.get('/windows');
    if (data && data.ok) return data.items;
  } catch {}
  return [];
}

export async function apiActivateWindow(slot: number): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/windows/activate', { slot });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

// Memories
export type MemoryItem = { id: string; text: string; createdAt: string };
export async function apiListMemories(limit: number = 50, cursor?: string): Promise<{ items: MemoryItem[]; nextCursor: string | null }> {
  const client = createApiClient();
  try {
    const { data } = await client.get('/memories', { params: { limit, ...(cursor ? { cursor } : {}) } });
    if (data && data.ok) return { items: data.items, nextCursor: data.nextCursor || null };
  } catch {}
  return { items: [], nextCursor: null };
}

export async function apiCreateMemory(text: string): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/memories', { text });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

// Agent events (tasks)
export type AgentEventItem = { id: string; type: string; payload?: any; createdAt: string };
export async function apiListAgentEvents(limit: number = 50, cursor?: string): Promise<{ items: AgentEventItem[]; nextCursor: string | null }> {
  const client = createApiClient();
  try {
    const { data } = await client.get('/agent-events', { params: { limit, ...(cursor ? { cursor } : {}) } });
    if (data && data.ok) return { items: data.items, nextCursor: data.nextCursor || null };
  } catch {}
  return { items: [], nextCursor: null };
}

export async function apiCreateTask(text: string): Promise<boolean> {
  const client = createApiClient();
  try {
    const { data } = await client.post('/agent-events', { type: 'task_created', payload: { text } });
    return !!(data && data.ok);
  } catch {
    return false;
  }
}

