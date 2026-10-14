// Which shell the game runs in. The browser build carries @capacitor/core too:
// on the web it reports 'web' and every native call below is skipped, so the
// same bundle serves both.

import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';

export const isNative: boolean = Capacitor.isNativePlatform();

function detectPlatform(): 'android' | 'ios' | 'web' {
  const p = Capacitor.getPlatform();
  return p === 'android' || p === 'ios' ? p : 'web';
}

export const platform: 'android' | 'ios' | 'web' = detectPlatform();

/**
 * Hide the status bar with the WebView laid out underneath it. MainActivity owns
 * true immersive mode (navigation bar, swipe-to-reveal); this is the JS side, safe
 * to call again after every resume. Never rejects: a missing plugin or an OS that
 * refuses one call (overlay is a no-op on Android 15+) just leaves the bar as is.
 */
export async function enterImmersive(): Promise<void> {
  if (!isNative) return;
  try {
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch {
    // keep going: hiding the bar matters more than the overlay flag
  }
  try {
    await StatusBar.hide();
  } catch {
    // no status-bar plugin in this shell
  }
}
