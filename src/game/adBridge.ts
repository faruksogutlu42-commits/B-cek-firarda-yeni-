import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import {
  AdMob,
  InterstitialAdPluginEvents,
  RewardAdPluginEvents,
} from '@capacitor-community/admob';

/**
 * Android / Capacitor AdMob entegrasyonu + Web güvenli yedek arayüzü.
 * - Rewarded (Ödüllü): Oyuncu isterse reklam izleyip ücretsiz canlanır.
 * - Interstitial (Geçiş): Her 2 yanışta 1 kez, oyun sonu çıkışında gösterilir.
 */
export interface AdBridge {
  isRewardedReady: () => boolean;
  showRewardedContinue: () => Promise<boolean>;
  isInterstitialReady: () => boolean;
  showInterstitial: () => Promise<boolean>;
}

export const INTERSTITIAL_CRASH_INTERVAL = 2;
const AD_CRASH_COUNTER_KEY = 'bocek_firar_ad_crash_count';

// Google resmi test reklam birimi ID'leri (env ile gerçek ID verilmezse otomatik kullanılır)
const GOOGLE_TEST_REWARDED_ID = 'ca-app-pub-3940256099942544/5224354917';
const GOOGLE_TEST_INTERSTITIAL_ID = 'ca-app-pub-3940256099942544/1033173712';

const REWARDED_AD_ID =
  import.meta.env.VITE_ADMOB_REWARDED_ID || GOOGLE_TEST_REWARDED_ID;
const INTERSTITIAL_AD_ID =
  import.meta.env.VITE_ADMOB_INTERSTITIAL_ID || GOOGLE_TEST_INTERSTITIAL_ID;
const USE_TEST_ADS = import.meta.env.VITE_ADMOB_TESTING !== 'false';

let initialized = false;
let initPromise: Promise<void> | null = null;
let rewardedReady = false;
let rewardedLoading = false;
let interstitialReady = false;
let interstitialLoading = false;

async function prepareRewardedAd(): Promise<void> {
  if (!Capacitor.isNativePlatform() || rewardedLoading || rewardedReady) return;
  rewardedLoading = true;
  try {
    await AdMob.prepareRewardVideoAd({
      adId: REWARDED_AD_ID,
      isTesting: USE_TEST_ADS,
      immersiveMode: true,
    });
    rewardedReady = true;
  } catch {
    rewardedReady = false;
    window.setTimeout(() => {
      void prepareRewardedAd();
    }, 15_000);
  } finally {
    rewardedLoading = false;
  }
}

async function prepareInterstitialAd(): Promise<void> {
  if (!Capacitor.isNativePlatform() || interstitialLoading || interstitialReady) {
    return;
  }
  interstitialLoading = true;
  try {
    await AdMob.prepareInterstitial({
      adId: INTERSTITIAL_AD_ID,
      isTesting: USE_TEST_ADS,
      immersiveMode: true,
    });
    interstitialReady = true;
  } catch {
    interstitialReady = false;
    window.setTimeout(() => {
      void prepareInterstitialAd();
    }, 15_000);
  } finally {
    interstitialLoading = false;
  }
}

export async function initAdBridge(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await AdMob.initialize({
        initializeForTesting: USE_TEST_ADS,
      });

      await AdMob.addListener(RewardAdPluginEvents.Loaded, () => {
        rewardedReady = true;
      });
      await AdMob.addListener(RewardAdPluginEvents.FailedToLoad, () => {
        rewardedReady = false;
      });
      await AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
        rewardedReady = false;
        void prepareRewardedAd();
      });

      await AdMob.addListener(InterstitialAdPluginEvents.Loaded, () => {
        interstitialReady = true;
      });
      await AdMob.addListener(InterstitialAdPluginEvents.FailedToLoad, () => {
        interstitialReady = false;
      });
      await AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => {
        interstitialReady = false;
        void prepareInterstitialAd();
      });

      initialized = true;
      void prepareRewardedAd();
      void prepareInterstitialAd();
    } catch {
      initPromise = null;
    }
  })();

  return initPromise;
}

export const adBridge: AdBridge = {
  isRewardedReady: () => {
    if (!Capacitor.isNativePlatform()) return false;
    return rewardedReady;
  },

  showRewardedContinue: async () => {
    if (!Capacitor.isNativePlatform()) return false;
    await initAdBridge();
    if (!rewardedReady) {
      void prepareRewardedAd();
      return false;
    }

    rewardedReady = false;
    let earnedReward = false;
    const handles: PluginListenerHandle[] = [];

    try {
      const rewardHandle = await AdMob.addListener(
        RewardAdPluginEvents.Rewarded,
        () => {
          earnedReward = true;
        },
      );
      handles.push(rewardHandle);

      const dismissPromise = new Promise<void>((resolve) => {
        void AdMob.addListener(RewardAdPluginEvents.Dismissed, () => {
          resolve();
        }).then((h) => handles.push(h));
        void AdMob.addListener(RewardAdPluginEvents.FailedToShow, () => {
          resolve();
        }).then((h) => handles.push(h));
      });

      const rewardItem = await AdMob.showRewardVideoAd();
      if (rewardItem && typeof rewardItem.amount === 'number') {
        earnedReward = true;
      }

      await Promise.race([
        dismissPromise,
        new Promise<void>((resolve) => window.setTimeout(resolve, 1200)),
      ]);
      return earnedReward;
    } catch {
      return earnedReward;
    } finally {
      await Promise.all(handles.map((h) => h.remove().catch(() => {})));
      void prepareRewardedAd();
    }
  },

  isInterstitialReady: () => {
    if (!Capacitor.isNativePlatform()) return false;
    return interstitialReady;
  },

  showInterstitial: async () => {
    if (!Capacitor.isNativePlatform()) return false;
    await initAdBridge();
    if (!interstitialReady) {
      void prepareInterstitialAd();
      return false;
    }

    interstitialReady = false;
    const handles: PluginListenerHandle[] = [];
    try {
      const dismissPromise = new Promise<void>((resolve) => {
        void AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => {
          resolve();
        }).then((h) => handles.push(h));
        void AdMob.addListener(InterstitialAdPluginEvents.FailedToShow, () => {
          resolve();
        }).then((h) => handles.push(h));
      });

      await AdMob.showInterstitial();
      await Promise.race([
        dismissPromise,
        new Promise<void>((resolve) => window.setTimeout(resolve, 15_000)),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      await Promise.all(handles.map((h) => h.remove().catch(() => {})));
      void prepareInterstitialAd();
    }
  },
};

export function getCrashCountSinceAd(): number {
  try {
    const raw = localStorage.getItem(AD_CRASH_COUNTER_KEY);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

export function recordCrashForAd(): number {
  const next = getCrashCountSinceAd() + 1;
  try {
    localStorage.setItem(AD_CRASH_COUNTER_KEY, String(next));
  } catch {
    // Ignore storage quota errors
  }
  return next;
}

export function resetCrashCountForAd(): void {
  try {
    localStorage.setItem(AD_CRASH_COUNTER_KEY, '0');
  } catch {
    // Ignore storage quota errors
  }
}

export async function maybeShowInterstitialAfterCrash(): Promise<boolean> {
  if (getCrashCountSinceAd() < INTERSTITIAL_CRASH_INTERVAL) {
    return false;
  }
  if (!adBridge.isInterstitialReady()) {
    return false;
  }
  const shown = await adBridge.showInterstitial();
  if (shown) {
    resetCrashCountForAd();
  }
  return shown;
}
