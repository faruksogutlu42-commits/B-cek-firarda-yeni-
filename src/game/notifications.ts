import { Capacitor } from '@capacitor/core';
import {
  LocalNotifications,
  type LocalNotificationSchema,
} from '@capacitor/local-notifications';
import {
  DailyRewardInfo,
  SKINS,
  getDaysBetweenDateKeys,
  getLocalDateKey,
  getMissionById,
} from './storage';
import { SaveData } from './types';

const NATIVE_CHANNEL_ID = 'bocek-firar-alerts';
const NATIVE_DAILY_ID_BASE = 1000;
const NATIVE_PRIME_ID_BASE = 2000;
const NATIVE_IMMEDIATE_ID_MIN = 3000;

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let nativeChannelCreated = false;
let nativeImmediateSeq = 0;

export function isNativeApp(): boolean {
  return typeof window !== 'undefined' && Capacitor.isNativePlatform();
}

export function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (isNativeApp()) return Promise.resolve(null);
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.resolve(null);
  }
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js')
      .catch(() => null);
  }
  return swRegistrationPromise;
}

export function isEmbeddedIframe(): boolean {
  if (typeof window === 'undefined' || isNativeApp()) return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function mapNativePermissionState(
  state: string,
): NotificationPermission | 'unsupported' {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'default';
}

async function ensureNativeChannel(): Promise<void> {
  if (!isNativeApp() || nativeChannelCreated) return;
  try {
    await LocalNotifications.createChannel({
      id: NATIVE_CHANNEL_ID,
      name: 'Böcek Firarda Bildirimleri',
      description: 'Günlük ödül ve akşam firar hatırlatmaları',
      importance: 4,
      visibility: 1,
      sound: 'default',
      vibration: true,
    });
    nativeChannelCreated = true;
  } catch {
    // Ignore channel errors on older Android versions
  }
}

export function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  if (isNativeApp()) {
    return 'default';
  }
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function getAppNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (isNativeApp()) {
    try {
      const status = await LocalNotifications.checkPermissions();
      return mapNativePermissionState(status.display);
    } catch {
      return 'unsupported';
    }
  }
  return getBrowserNotificationPermission();
}

export async function requestBrowserNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (isNativeApp()) {
    try {
      await ensureNativeChannel();
      const status = await LocalNotifications.requestPermissions();
      return mapNativePermissionState(status.display);
    } catch {
      return 'unsupported';
    }
  }
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export const requestAppNotificationPermission = requestBrowserNotificationPermission;

const NATIVE_GIFT_LARGE_ICON = 'ic_notif_gift';
const NATIVE_GAME_LARGE_ICON = 'ic_notif_game';
const WEB_GIFT_ICON_PATH = '/assets/notifications/ic_notif_gift.png';
const WEB_GAME_ICON_PATH = '/assets/notifications/ic_notif_game.png';

export interface NotificationIconOptions {
  largeIcon?: string;
  webIcon?: string;
}

export async function sendGameNotification(
  title: string,
  body: string,
  tag: string,
  onInAppFallback?: (title: string, body: string) => void,
  iconOpts?: NotificationIconOptions,
): Promise<boolean> {
  if (isNativeApp()) {
    const perm = await getAppNotificationPermission();
    if (perm === 'granted') {
      try {
        await ensureNativeChannel();
        const id = NATIVE_IMMEDIATE_ID_MIN + (nativeImmediateSeq++ % 900);
        await LocalNotifications.schedule({
          notifications: [
            {
              id,
              title,
              body,
              channelId: NATIVE_CHANNEL_ID,
              ...(iconOpts?.largeIcon ? { largeIcon: iconOpts.largeIcon } : {}),
              autoCancel: true,
              foreground: true,
              isExactNotification: false,
              schedule: {
                at: new Date(Date.now() + 300),
                allowWhileIdle: true,
              },
              extra: { tag },
            },
          ],
        });
        return true;
      } catch {
        // Fall through to in-app banner if provided
      }
    }
    if (onInAppFallback) {
      onInAppFallback(title, body);
      return true;
    }
    return false;
  }

  const webIcon = iconOpts?.webIcon;
  if (getBrowserNotificationPermission() === 'granted') {
    try {
      const reg = await registerNotificationServiceWorker();
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(title, {
          body,
          tag,
          renotify: false,
          ...(webIcon ? { icon: webIcon } : {}),
        } as NotificationOptions);
        return true;
      }
    } catch {
      // Fall back to direct window Notification
    }

    try {
      new Notification(title, {
        body,
        tag,
        ...(webIcon ? { icon: webIcon } : {}),
      });
      return true;
    } catch {
      // Fall through to in-app fallback if embedded
    }
  }

  if (onInAppFallback) {
    onInAppFallback(title, body);
    return true;
  }
  return false;
}

interface NotificationPayload {
  title: string;
  body: string;
  tag: string;
  largeIcon?: string;
  webIcon?: string;
}

function pickNonRepeatingIndex(poolLength: number, usedIds: number[]): number {
  const allIndices = Array.from({ length: poolLength }, (_, i) => i);
  const lastUsed = usedIds.length > 0 ? usedIds[usedIds.length - 1] : -1;
  let available = allIndices.filter((i) => !usedIds.includes(i));
  if (available.length === 0) {
    // Havuz bittiğinde son gönderileni hariç tutarak sıfırla
    available = allIndices.filter((i) => i !== lastUsed);
  }
  if (available.length === 0) return 0;
  return available[Math.floor(Math.random() * available.length)];
}

const GAME_NOTIFICATION_TITLE = 'Böcek Firarda';

function buildDailyRewardNotification(
  usedIds: number[],
): { payload: NotificationPayload; msgIdx: number } {
  const mysteryPool: NotificationPayload[] = [
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Bugünkü hediyen hazır! Oyuncular aldı bile, sen de kap! 🎁',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Sürpriz ödülün açıldı! Herkes hediyesini aldı, sıra sende. 👀',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Günlük kasan bekliyor! Bakalım bugünkü sürprizden ne çıkacak? ✨',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Serini bozma, ödül kap! Günlük hediyeni kaçırma! 🔥',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Sana özel hediye var! Kıvırcık Rıza kapıda, girip sürprizini aç! 🥐',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Ödül saati geldi! Gizemli ödül aktif, hemen kap! ⏰',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Günün sürprizi hazır! Tek tıkla oyuna gir, kutunu aç! 🌟',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Hediye kutun açılıyor! Günlük hakkın doldu, geç kalmadan al. 🎉',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Fırından yeni çıktı! Bugünün gizli ödülünü açıp şansını gör! 🥖',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Saklı ödülün hazır! Diğer firarcılar payını kaptı, sıra sende. 🗝️',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Seri ödülün aktif! Giriş serini koru, sürpriz ödülünü kaçırma! 💎',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Şanslı günün olabilir! Günlük kilit açıldı, girip gör! 🍀',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Günlük hediyen geldi! Ödülünü almadan günü bitirme! 🚪',
      tag: 'bocek-daily-reward',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Sürpriz zamanı! Oyuncular girdi aldı bile, hadi ödülünü al! 🎊',
      tag: 'bocek-daily-reward',
    },
  ];

  const msgIdx = pickNonRepeatingIndex(mysteryPool.length, usedIds);
  return {
    payload: {
      ...mysteryPool[msgIdx],
      largeIcon: NATIVE_GIFT_LARGE_ICON,
      webIcon: WEB_GIFT_ICON_PATH,
    },
    msgIdx,
  };
}

function buildPrimeTimeNotification(
  save: SaveData,
  usedIds: number[],
): { payload: NotificationPayload; msgIdx: number } {
  const skin = SKINS.find((s) => s.id === save.selectedSkin) || SKINS[0];
  const activeDef = save.missions.activeIds
    .map((id) => getMissionById(id))
    .find(Boolean);

  const pool: NotificationPayload[] = [
    {
      title: GAME_NOTIFICATION_TITLE,
      body:
        save.highScore > 0
          ? `Mutfakta kaçış başladı! ${skin.name} ile ${save.highScore.toLocaleString('tr-TR')} rekorunu geç! 🪳`
          : `Mutfakta kaçış başladı! ${skin.name} bekliyor, bu akşam kaç metre gideceksin? 🪳`,
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Akşam yarışı kızıştı! Kaçakçılar puanları topluyor, hadi piste! 🏆',
      tag: 'bocek-prime-time',
    },
    activeDef
      ? {
          title: GAME_NOTIFICATION_TITLE,
          body: `Görevin seni bekliyor! ${activeDef.title} için kısa bir koşu yap! 🎯`,
          tag: 'bocek-prime-time',
        }
      : {
          title: GAME_NOTIFICATION_TITLE,
          body: 'Hadi kısa bir koşuya! Çarşıdan galaksiye tam gaz koş! ⚡',
          tag: 'bocek-prime-time',
        },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Ev sahibi peşinde! 2 dakikalık çılgın bir koşuyla stres at! 🧹',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Peynir Galaksisi’ne uç! Jetpack’i tak, akşamın en iyisi sen ol! 🧀',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Mutfak karıştı! Hemen girip altın kırıntıları topla! 😎',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Buzul ve Ateş bekliyor! Bu akşam yeni dünyalara ulaşmaya var mısın? ❄️',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Günlük görevler bitiyor! Büyük Kasayı açmak için son koşunu yap! ⏳',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Yeni karakter çok yakın! Birkaç koşuluk kırıntıyla yeni böcek aç! 🛒',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Işıklar söndü, firar zamanı! Feneri yak, kırıntıları topla! 🔦',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Acilci Duktur çağırıyor! Çarşı karıştı, kombonu katla, rekor kır! 🩺',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Tamirci Kazım tam gaz! Turbo’yu kap, engellerden yıldırım gibi geç! 🔧',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Dev Mutfak tehlikede! Ev sahibi peşinde, kaç engeli sıyıracaksın? 🍳',
      tag: 'bocek-prime-time',
    },
    {
      title: GAME_NOTIFICATION_TITLE,
      body: 'Skor çarpanını artır! 1 görev daha bitir, puanını katla! 📈',
      tag: 'bocek-prime-time',
    },
  ];

  const msgIdx = pickNonRepeatingIndex(pool.length, usedIds);
  return {
    payload: {
      ...pool[msgIdx],
      largeIcon: NATIVE_GAME_LARGE_ICON,
      webIcon: WEB_GAME_ICON_PATH,
    },
    msgIdx,
  };
}

/**
 * Android APK (Capacitor) için oyun tamamen kapalıyken dahi çalışacak
 * 27 günlük (7 gün her gün, 8-27. günler 3 günde 1) OS seviyesi alarm planlaması.
 */
export async function syncNativeScheduledNotifications(
  save: SaveData,
  dailyInfo: DailyRewardInfo,
  now = new Date(),
): Promise<void> {
  if (!isNativeApp()) return;

  try {
    const pending = await LocalNotifications.getPending();
    const toCancel = pending.notifications
      .filter(
        (n) =>
          (n.id >= NATIVE_DAILY_ID_BASE && n.id < NATIVE_PRIME_ID_BASE + 100) ||
          n.id >= NATIVE_IMMEDIATE_ID_MIN,
      )
      .map((n) => ({ id: n.id }));

    if (toCancel.length > 0) {
      await LocalNotifications.cancel({ notifications: toCancel });
    }
  } catch {
    // Continue cleanly
  }

  if (!save.notifications.enabled) return;
  const perm = await getAppNotificationPermission();
  if (perm !== 'granted') return;

  await ensureNativeChannel();

  const todayKey = getLocalDateKey(now);
  const lastOpened = save.notifications.lastOpenedDate || todayKey;
  const upcoming: LocalNotificationSchema[] = [];

  let usedDailyIds = [...save.notifications.usedDailyMsgIds];
  let usedPrimeIds = [...save.notifications.usedPrimeMsgIds];

  for (let dayOffset = 0; dayOffset < 28; dayOffset++) {
    const targetDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset,
      0,
      0,
      0,
      0,
    );
    const targetKey = getLocalDateKey(targetDate);
    const inactiveDays = Math.max(
      0,
      getDaysBetweenDateKeys(lastOpened, targetKey),
    );

    if (inactiveDays >= 28) break;
    if (inactiveDays > 7 && (inactiveDays - 8) % 3 !== 0) {
      continue;
    }

    // 1. Günlük Ödül Bildirimi: 09:30 (sessiz saat bitimi)
    const dailyAt = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      targetDate.getDate(),
      9,
      30,
      0,
      0,
    );
    const canScheduleTodayDaily =
      dayOffset > 0 ||
      (dailyInfo.canClaim &&
        save.notifications.lastDailyNotifyDate !== todayKey &&
        dailyAt.getTime() > now.getTime() + 10_000);

    if (canScheduleTodayDaily && dailyAt.getTime() > now.getTime() + 5_000) {
      const { payload, msgIdx } = buildDailyRewardNotification(usedDailyIds);
      usedDailyIds =
        usedDailyIds.length >= 13
          ? [msgIdx]
          : [...usedDailyIds.filter((i) => i !== msgIdx), msgIdx];

      upcoming.push({
        id: NATIVE_DAILY_ID_BASE + dayOffset,
        title: payload.title,
        body: payload.body,
        channelId: NATIVE_CHANNEL_ID,
        ...(payload.largeIcon ? { largeIcon: payload.largeIcon } : {}),
        autoCancel: true,
        isExactNotification: false,
        schedule: {
          at: dailyAt,
          allowWhileIdle: true,
        },
        extra: { tag: payload.tag },
      });
    }

    // 2. Akşam Teşvik Bildirimi: 19:45 (19:30 - 21:30 aralığı)
    const primeAt = new Date(
      targetDate.getFullYear(),
      targetDate.getMonth(),
      targetDate.getDate(),
      19,
      45,
      0,
      0,
    );
    const canScheduleTodayPrime =
      dayOffset > 0 ||
      (save.notifications.lastPrimeNotifyDate !== todayKey &&
        primeAt.getTime() > now.getTime() + 10_000);

    if (canScheduleTodayPrime && primeAt.getTime() > now.getTime() + 5_000) {
      const { payload, msgIdx } = buildPrimeTimeNotification(save, usedPrimeIds);
      usedPrimeIds =
        usedPrimeIds.length >= 13
          ? [msgIdx]
          : [...usedPrimeIds.filter((i) => i !== msgIdx), msgIdx];

      upcoming.push({
        id: NATIVE_PRIME_ID_BASE + dayOffset,
        title: payload.title,
        body: payload.body,
        channelId: NATIVE_CHANNEL_ID,
        ...(payload.largeIcon ? { largeIcon: payload.largeIcon } : {}),
        autoCancel: true,
        isExactNotification: false,
        schedule: {
          at: primeAt,
          allowWhileIdle: true,
        },
        extra: { tag: payload.tag },
      });
    }
  }

  if (upcoming.length > 0) {
    try {
      await LocalNotifications.schedule({ notifications: upcoming });
    } catch {
      // Ignore transient OS schedule rejections
    }
  }
}

export async function evaluateAndSendScheduledNotifications(
  save: SaveData,
  dailyInfo: DailyRewardInfo,
  onMarkSent: (slot: 'daily' | 'prime', todayKey: string, msgIdx: number) => void,
  now = new Date(),
): Promise<void> {
  if (!save.notifications.enabled) return;
  const perm = await getAppNotificationPermission();
  if (perm !== 'granted') return;

  const todayKey = getLocalDateKey(now);
  const sentToday =
    save.notifications.sentCountDate === todayKey
      ? save.notifications.sentCountToday
      : 0;

  if (sentToday >= 2) return;

  // İnaktiflik kuralı: ilk 7 gün her gün, 8-27. günler 3 günde bir, 28. günde tamamen durur
  const inactiveDays = Math.max(
    0,
    getDaysBetweenDateKeys(save.notifications.lastOpenedDate || todayKey, todayKey),
  );
  if (inactiveDays >= 28) return;
  if (inactiveDays > 7 && sentToday === 0 && save.notifications.lastSentDate) {
    const daysSinceLastSent = getDaysBetweenDateKeys(
      save.notifications.lastSentDate,
      todayKey,
    );
    if (daysSinceLastSent < 3) return;
  }

  const hour = now.getHours();
  const minute = now.getMinutes();

  // 1. Bildirim: Günlük dönüş hakkı (Gece 23:00 - 09:30 arası sessiz saat -> 09:30'da gider)
  const inDaytimeWindow =
    (hour > 9 || (hour === 9 && minute >= 30)) && hour < 23;
  if (
    dailyInfo.canClaim &&
    inDaytimeWindow &&
    save.notifications.lastDailyNotifyDate !== todayKey
  ) {
    const { payload, msgIdx } = buildDailyRewardNotification(
      save.notifications.usedDailyMsgIds,
    );
    const ok = await sendGameNotification(
      payload.title,
      payload.body,
      payload.tag,
      undefined,
      { largeIcon: payload.largeIcon, webIcon: payload.webIcon },
    );
    if (ok) {
      onMarkSent('daily', todayKey, msgIdx);
      return;
    }
  }

  // 2. Bildirim: Akşam 19:30 - 21:30 arası oyuna teşvik bildirimi (günde 1 kez)
  const inPrimeWindow =
    (hour === 19 && minute >= 30) ||
    hour === 20 ||
    (hour === 21 && minute <= 30);
  if (inPrimeWindow && save.notifications.lastPrimeNotifyDate !== todayKey) {
    const { payload, msgIdx } = buildPrimeTimeNotification(
      save,
      save.notifications.usedPrimeMsgIds,
    );
    const ok = await sendGameNotification(
      payload.title,
      payload.body,
      payload.tag,
      undefined,
      { largeIcon: payload.largeIcon, webIcon: payload.webIcon },
    );
    if (ok) {
      onMarkSent('prime', todayKey, msgIdx);
    }
  }
}
