import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bocekfirar.runner',
  appName: 'Böcek Firarda',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    LocalNotifications: {
      iconColor: '#10b981',
    },
  },
};

export default config;
