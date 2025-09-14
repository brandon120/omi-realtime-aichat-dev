import Constants from 'expo-constants';

export function getApiBaseUrl(): string {
  const fromPublic = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (fromPublic && fromPublic.length > 0) return fromPublic;
  const extra = (Constants?.expoConfig as any)?.extra || {};
  const val = extra.apiBaseUrl as string | undefined;
  return val || 'http://localhost:3000';
}

