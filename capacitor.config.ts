import type { CapacitorConfig } from '@capacitor/cli';

// appId is a placeholder. Change it before the first Play upload (Play never allows it to change
// afterwards) here AND as applicationId in android/app/build.gradle; the Gradle namespace and the
// Java package of MainActivity may keep the old name.
const config: CapacitorConfig = {
  appId: 'com.rndl.crowdshooter',
  appName: 'Crowd Shooter Runner',
  webDir: 'dist',
  backgroundColor: '#0a0e1a',
  android: {
    allowMixedContent: false,
    // webContentsDebuggingEnabled is left unset on purpose: Capacitor then enables it only for
    // debuggable (debug) builds, so release APKs/AABs never expose the WebView to DevTools.
  },
  plugins: {
    // MainActivity owns immersive mode; these keep the plugins from fighting it at startup
    // (SystemBars would otherwise show the bars once on load) and keep transient bars legible
    // (light icons on the navy field).
    SystemBars: { hidden: true, style: 'DARK', initialViewportFitValueHint: 'cover' },
    StatusBar: { style: 'DARK', backgroundColor: '#0a0e1a', overlaysWebView: true },
  },
};

export default config;
