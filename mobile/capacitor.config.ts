import type { CapacitorConfig } from '@capacitor/cli';

// Kanka Chat mobil: masaüstü uygulaması gibi arayüzü doğrudan kankahq.com'dan yükler.
// Böylece web, Windows ve mobil aynı kodu, aynı hesapları ve aynı verileri kullanır;
// arayüz güncellemeleri mağaza onayı beklemeden herkese gelir. Yerel kabuk (www/) sadece
// açılış ve "bağlantı yok" ekranıdır.
const SUNUCU = 'https://kankahq.com';

const config: CapacitorConfig = {
  appId: 'com.kanka.chat',
  appName: 'Kanka Chat',
  webDir: 'www',
  backgroundColor: '#0b0b0c',
  appendUserAgent: 'KankaMobil/1.0',
  server: {
    url: `${SUNUCU}/app`,
    cleartext: false,
    allowNavigation: ['kankahq.com', '*.kankahq.com'],
    errorPath: 'hata.html',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  ios: {
    contentInset: 'never',
    scrollEnabled: false,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 1200, launchAutoHide: true, backgroundColor: '#0b0b0c', showSpinner: false },
    StatusBar: { style: 'DARK', backgroundColor: '#0b0b0c', overlaysWebView: false },
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
    // Uygulama açıkken bildirim gösterme: Kanka kendi içinde gösteriyor
    PushNotifications: { presentationOptions: [] },
  },
};

export default config;
