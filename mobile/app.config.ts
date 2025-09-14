import type { ExpoConfig } from 'expo/config';

const HOST = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000';

const config: ExpoConfig = {
  name: 'Omi Mobile',
  slug: 'omi-mobile',
  scheme: 'omiapp',
  splash: {
    image: './assets/images/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  ios: {
    bundleIdentifier: 'com.example.omimobile',
  },
  android: {
    package: 'com.example.omimobile',
  },
  extra: {
    apiBaseUrl: HOST,
    eas: {
      projectId: process.env.EAS_PROJECT_ID,
    },
  },
  experiments: {
    typedRoutes: true,
  },
};

export default config;

