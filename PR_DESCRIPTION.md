## Omi Mobile – Auth Gating, Modernized Flow, and Dashboard

### Summary
- Added `AuthProvider` and `useAuth` for session management
- Introduced `(auth)` stack: welcome, sign-in, sign-up
- Gated `(tabs)` so unauthenticated users are redirected to auth
- Refactored Home tab into a concise dashboard
- Enhanced Settings groundwork for OMI/account management

### Key statement
Next I’ll gate the tab layout so unauthenticated users are redirected to the new welcome/sign-in flow and then refactor the Home tab into a dashboard.

### Notes
- Mobile base URL via `EXPO_PUBLIC_API_BASE_URL`
- Secure session token via `expo-secure-store`
- Server must have `ENABLE_USER_SYSTEM=true`

