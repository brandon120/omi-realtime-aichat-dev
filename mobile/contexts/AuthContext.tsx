import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { router } from 'expo-router';
import { Alert } from 'react-native';
import {
  apiLogin,
  apiRegister,
  apiLogout,
  apiMe,
  getSessionToken,
  clearSessionToken,
  type User
} from '@/lib/api';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, displayName?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);

  async function hydrateFromStorage() {
    try {
      const token = await getSessionToken();
      if (!token) {
        setUser(null);
        setStatus('unauthenticated');
        return;
      }
      const me = await apiMe();
      if (me && me.user) {
        setUser(me.user);
        setStatus('authenticated');
      } else {
        setUser(null);
        setStatus('unauthenticated');
      }
    } catch {
      setUser(null);
      setStatus('unauthenticated');
    }
  }

  useEffect(() => {
    hydrateFromStorage();
  }, []);

  async function login(email: string, password: string): Promise<boolean> {
    try {
      const res = await apiLogin({ email, password });
      if (!res) return false;
      // Immediately authenticate using response data for snappy UX
      setUser(res.user);
      setStatus('authenticated');
      // Background refresh to sync server-side user state
      (async () => {
        try {
          const me = await apiMe();
          if (me && me.user) setUser(me.user);
        } catch {}
      })();
      return true;
    } catch (e: any) {
      Alert.alert('Login failed', e?.message || 'Please try again.');
      return false;
    }
  }

  async function register(email: string, password: string, displayName?: string): Promise<boolean> {
    try {
      const res = await apiRegister({ email, password, display_name: displayName });
      if (!res) return false;
      // Immediately authenticate using response data
      setUser(res.user);
      setStatus('authenticated');
      // Background refresh
      (async () => {
        try {
          const me = await apiMe();
          if (me && me.user) setUser(me.user);
        } catch {}
      })();
      return true;
    } catch (e: any) {
      Alert.alert('Registration failed', e?.message || 'Please try again.');
      return false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await apiLogout();
    } catch {}
    try {
      await clearSessionToken();
    } catch {}
    setUser(null);
    setStatus('unauthenticated');
    // Navigate to auth stack after logout
    try { router.replace('/(auth)'); } catch {}
  }

  async function refresh(): Promise<void> {
    await hydrateFromStorage();
  }

  const value = useMemo<AuthContextValue>(() => ({ status, user, login, register, logout, refresh }), [status, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

