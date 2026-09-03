// Ad calls live behind this interface. The stub resolves instantly so the game
// is fully playable with no SDK. Swap in AppLovin MAX / AdMob later by
// implementing IAdService and binding it in the ServiceLocator.

export type RewardKind = 'double_coins' | 'revive' | 'bonus_crowd';

export interface IAdService {
  /** Show a rewarded video. Resolves true if the reward should be granted. */
  showRewarded(kind: RewardKind): Promise<boolean>;
  /** Show an interstitial (frequency-capped by the caller). */
  showInterstitial(): Promise<void>;
  isReady(): boolean;
}

export class AdServiceStub implements IAdService {
  isReady(): boolean {
    return true;
  }

  async showRewarded(kind: RewardKind): Promise<boolean> {
    console.info(`[AdServiceStub] rewarded video (${kind}) — granting reward`);
    return true;
  }

  async showInterstitial(): Promise<void> {
    console.info('[AdServiceStub] interstitial');
  }
}
