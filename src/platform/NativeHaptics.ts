// Haptics through @capacitor/haptics (Android VibrationEffect / iOS Core Haptics),
// bound in the native shell instead of navigator.vibrate, which WKWebView lacks
// and which waits for a first tap. The HapticThrottle is shared with the web
// service, so both builds drop exactly the same pulses.

import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import type { ImpactOptions, NotificationOptions } from '@capacitor/haptics';
import { HapticThrottle, WebHapticsService } from '../services/HapticsService';
import type { HapticKind, IHapticsService } from '../services/HapticsService';
import { isNative } from './Platform';

// built once: every pulse hands the bridge the same option objects
const LIGHT: ImpactOptions = { style: ImpactStyle.Light };
const MEDIUM: ImpactOptions = { style: ImpactStyle.Medium };
const HEAVY: ImpactOptions = { style: ImpactStyle.Heavy };
const WARNING: NotificationOptions = { type: NotificationType.Warning };
const SUCCESS: NotificationOptions = { type: NotificationType.Success };
const ERROR: NotificationOptions = { type: NotificationType.Error };

function fire(kind: HapticKind): Promise<void> {
  switch (kind) {
    case 'light': return Haptics.impact(LIGHT);
    case 'medium': return Haptics.impact(MEDIUM);
    case 'heavy': return Haptics.impact(HEAVY);
    case 'warn': return Haptics.notification(WARNING);
    case 'success': return Haptics.notification(SUCCESS);
    case 'fail': return Haptics.notification(ERROR);
  }
}

// a rejected pulse (no vibrator, plugin missing) is not worth a console line per hit
const ignore = (): void => {};

export class NativeHapticsService implements IHapticsService {
  enabled = true;
  readonly supported: boolean = true;
  private readonly throttle = new HapticThrottle();

  pulse(kind: HapticKind): void {
    if (!this.enabled) return;
    if (!this.throttle.allow(kind, performance.now())) return;
    try {
      fire(kind).catch(ignore);
    } catch {
      // a synchronous bridge failure is as harmless as a rejected one
    }
  }
}

export function createHaptics(): IHapticsService {
  return isNative ? new NativeHapticsService() : new WebHapticsService();
}
