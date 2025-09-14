import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import * as SecureStore from 'expo-secure-store';
import { getApiBaseUrl } from '@/constants/Config';

const SID_KEY = 'sid_token';

export async function saveSessionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(SID_KEY, token);
}

export async function getSessionToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SID_KEY);
  } catch {
    return null;
  }
}

export async function clearSessionToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SID_KEY);
  } catch {}
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

