# Omi Mobile (Expo)

A simple Expo React Native app to:
- Login/Register to your backend user system
- Send messages to the assistant (Control tab)
- Link your Omi account to your frontend account using OTP (Settings tab)

## Prerequisites
- Node 18+
- Backend running locally at http://localhost:3000 (or set EXPO_PUBLIC_API_BASE_URL)

## Setup
```bash
cd mobile
npm install
```

Optionally set the API base URL:
```bash
# .env (for local shell session)
export EXPO_PUBLIC_API_BASE_URL="http://localhost:3000"
```

## Run
```bash
npm run web        # web
npm run android    # android emulator/device
npm run ios        # iOS simulator (macOS only)
```

## Notes
- Session token is stored in SecureStore and sent as `Authorization: Bearer <sid>`.
- Ensure backend has ENABLE_USER_SYSTEM=true, database configured, and is running.