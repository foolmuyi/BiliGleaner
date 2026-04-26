/**
 * BiliGleaner Service Worker
 * 后台调度中心 - 管理定时任务和消息通信
 */

import * as storage from '../lib/storage.js';
import { fetchNavInfo, fetchUserCard, followUser } from '../lib/api.js';
import { fullScan, incrementalScan } from '../lib/history-scanner.js';
import { processAndSave, refreshFollowedCache } from '../lib/relationship-filter.js';
import { checkAllUpdates } from '../lib/update-monitor.js';

// ========== 状态管理 ==========

let isScanning = false;
let isCheckingUpdates = false;
let scanAbortFlag = false;
let updateAbortFlag = false;
let pendingScanAction = null; // { type: 'prune'|'rescan', days }
let pendingFollowedCleanup = false;
let isSchedulerTicking = false;
let schedulerRerunRequested = false;

// ========== 定时任务 ==========

const ALARMS = {
  SCHEDULER_TICK: 'biligleaner-scheduler-tick',
  REFRESH_FOLLOWINGS: 'biligleaner-refresh-followings',
  LEGACY_INCREMENTAL_SCAN: 'biligleaner-incremental-scan',
  LEGACY_CHECK_UPDATES: 'biligleaner-check-updates',
};

const INCREMENTAL_SCAN_INTERVAL_MINUTES = 360;
const UPDATE_CHECK_INTERVAL_MINUTES = 60;
const SCHEDULER_TICK_PERIOD_MINUTES = 5;
const AUTO_SCAN_ATTEMPT_KEY = 'last_auto_scan_attempt';
const AUTO_UPDATE_ATTEMPT_KEY = 'last_auto_update_attempt';
const AUTO_RETRY_INTERVAL_MINUTES = 5;

const INCREMENTAL_SCAN_INTERVAL_MS = INCREMENTAL_SCAN_INTERVAL_MINUTES * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = UPDATE_CHECK_INTERVAL_MINUTES * 60 * 1000;
const AUTO_RETRY_INTERVAL_MS = AUTO_RETRY_INTERVAL_MINUTES * 60 * 1000;

const ALARM_SPECS = {
  [ALARMS.SCHEDULER_TICK]: SCHEDULER_TICK_PERIOD_MINUTES,
  [ALARMS.REFRESH_FOLLOWINGS]: 720,
};

async function getLastHistoryScanTime() {
  const explicitLastScan = await storage.getSetting('last_history_scan', null);
  if (explicitLastScan) return explicitLastScan;

  const [lastFullScan, lastIncrementalScan] = await Promise.all([
    storage.getSetting('last_full_scan', null),
    storage.getSetting('last_incremental_scan', null),
  ]);
  return Math.max(lastFullScan || 0, lastIncrementalScan || 0) || null;
}

async function ensureAlarms() {
  await Promise.all(Object.entries(ALARM_SPECS).map(async ([name, periodInMinutes]) => {
    const existing = await chrome.alarms.get(name);
    if (!existing || existing.periodInMinutes !== periodInMinutes) {
      await chrome.alarms.create(name, { periodInMinutes });
    }
  }));
  await Promise.all([
    chrome.alarms.clear(ALARMS.LEGACY_INCREMENTAL_SCAN),
    chrome.alarms.clear(ALARMS.LEGACY_CHECK_UPDATES),
  ]);
}

async function schedulerTick(reason = '定时任务') {
  if (isSchedulerTicking) {
    schedulerRerunRequested = true;
    return { success: false, skipped: true, reason: 'scheduler-busy' };
  }

  isSchedulerTicking = true;

  try {
    if (isScanning || isCheckingUpdates) {
      return { success: false, skipped: true, reason: 'task-busy' };
    }

    const now = Date.now();
    const [
      lastHistoryScan,
      lastUpdateCheck,
      lastAutoScanAttempt,
      lastAutoUpdateAttempt,
    ] = await Promise.all([
      getLastHistoryScanTime(),
      storage.getSetting('last_update_check', null),
      storage.getSetting(AUTO_SCAN_ATTEMPT_KEY, 0),
      storage.getSetting(AUTO_UPDATE_ATTEMPT_KEY, 0),
    ]);

    const hasHistoryScan = Number(lastHistoryScan) > 0;
    const hasUpdateCheck = Number(lastUpdateCheck) > 0;

    let dueScan =
      hasHistoryScan &&
      (now - Number(lastHistoryScan)) >= INCREMENTAL_SCAN_INTERVAL_MS &&
      (now - Number(lastAutoScanAttempt || 0)) >= AUTO_RETRY_INTERVAL_MS;
    let dueUpdate =
      hasUpdateCheck &&
      (now - Number(lastUpdateCheck)) >= UPDATE_CHECK_INTERVAL_MS &&
      (now - Number(lastAutoUpdateAttempt || 0)) >= AUTO_RETRY_INTERVAL_MS;

    if (!dueScan && !dueUpdate) {
      return {
        success: true,
        skipped: true,
        reason: 'not-due',
      };
    }

    if (dueScan) {
      await storage.setSetting(AUTO_SCAN_ATTEMPT_KEY, now);
      console.log(`[BiliGleaner] ${reason}：增量扫描到期，开始执行`);
      const scanResult = await runIncrementalScan();
      if (scanResult?.success === false && !scanResult?.skipped) {
        console.warn('[BiliGleaner] 调度增量扫描失败:', scanResult.message);
      }
    }

    if (isScanning || isCheckingUpdates) {
      return { success: false, skipped: true, reason: 'task-busy-after-scan' };
    }

    // 若本次 tick 开始时更新已到期，或扫描耗时期间变为到期，都应在扫描后补跑。
    const [latestUpdateCheck, latestAutoUpdateAttempt] = await Promise.all([
      storage.getSetting('last_update_check', null),
      storage.getSetting(AUTO_UPDATE_ATTEMPT_KEY, 0),
    ]);
    const nowAfterScan = Date.now();
    const hasLatestUpdateCheck = Number(latestUpdateCheck) > 0;
    dueUpdate =
      dueUpdate ||
      (hasLatestUpdateCheck &&
        (nowAfterScan - Number(latestUpdateCheck)) >= UPDATE_CHECK_INTERVAL_MS &&
        (nowAfterScan - Number(latestAutoUpdateAttempt || 0)) >= AUTO_RETRY_INTERVAL_MS);

    if (dueUpdate) {
      await storage.setSetting(AUTO_UPDATE_ATTEMPT_KEY, Date.now());
      console.log(`[BiliGleaner] ${reason}：视频更新检查到期，开始执行`);
      const updateResult = await runUpdateCheck();
      if (updateResult?.success === false && !updateResult?.skipped) {
        console.warn('[BiliGleaner] 调度视频更新检查失败:', updateResult.message);
      }
    }

    return { success: true, dueScan, dueUpdate };
  } catch (err) {
    console.error('[BiliGleaner] 调度循环失败:', err);
    return { success: false, message: err.message };
  } finally {
    isSchedulerTicking = false;
    if (schedulerRerunRequested) {
      schedulerRerunRequested = false;
      schedulerTick('补跑调度').catch((err) => {
        console.error('[BiliGleaner] 补跑调度失败:', err);
      });
    }
  }
}

// 扩展安装/更新时初始化
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[BiliGleaner] 扩展已安装/更新', details.reason);

  // 设置定时任务
  await ensureAlarms();

  if (details.reason === 'install') {
    await storage.setSetting('installed_at', Date.now());
    await storage.setSetting('scan_status', 'idle');
    await storage.setSetting('scan_days', 7);
  }
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    await ensureAlarms();
    await schedulerTick('浏览器启动');
  })().catch((err) => {
    console.error('[BiliGleaner] 启动时恢复定时任务失败:', err);
  });
});

// 定时任务触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log(`[BiliGleaner] 定时任务触发: ${alarm.name}`);

  switch (alarm.name) {
    case ALARMS.SCHEDULER_TICK:
      await schedulerTick('定时器');
      break;
    case ALARMS.REFRESH_FOLLOWINGS:
      await runFollowingsRefresh();
      break;
    case ALARMS.LEGACY_INCREMENTAL_SCAN:
    case ALARMS.LEGACY_CHECK_UPDATES:
      await chrome.alarms.clear(alarm.name);
      break;
  }
});

// ========== 核心任务 ==========

async function runFullScan(days = 7) {
  if (isScanning) {
    return { success: false, message: '正在扫描中，请稍候' };
  }

  if (isCheckingUpdates) {
    return { success: false, message: '正在检查视频更新，请稍候再扫描' };
  }

  const scanStartedAt = Date.now();
  isScanning = true;
  scanAbortFlag = false;
  await storage.setSetting('scan_status', 'scanning');

  try {
    const upsMap = await fullScan(days, (count, date) => {
      broadcastMessage({
        type: 'SCAN_PROGRESS',
        data: { scanned: count, currentDate: date },
      });
    }, () => scanAbortFlag);

    if (scanAbortFlag) {
      console.log('[BiliGleaner] 扫描被中止，跳过保存');
      await storage.setSetting('scan_status', 'idle');
      return { success: false, message: '扫描已中止' };
    }

    const savedCount = await processAndSave(upsMap);
    
    // 按时间范围裁剪过期的追踪记录和视频动态
    const pruned = await storage.pruneTrackedUpsByTimeRange(days);
    const prunedUpdates = await storage.pruneUpdatesByTimeRange(days);
    const cleanup = await cleanupTrackingPool();
    if (pruned > 0) console.log(`[BiliGleaner] 裁剪了 ${pruned} 位超出时间范围的 UP 主`);
    if (prunedUpdates > 0) console.log(`[BiliGleaner] 清理了 ${prunedUpdates} 条过期视频动态`);
    if (cleanup.removedTracking > 0) {
      console.log(`[BiliGleaner] 清理了 ${cleanup.removedTracking} 位已关注的追踪 UP 主`);
    }
    if (cleanup.removedUpdates > 0) {
      console.log(`[BiliGleaner] 清理了 ${cleanup.removedUpdates} 条失效视频动态`);
    }
    if (prunedUpdates > 0 || cleanup.removedUpdates > 0) {
      await updateBadge();
    }
    
    const completedAt = Date.now();
    await storage.setSetting('scan_status', 'idle');
    await storage.setSetting('last_history_scan_anchor', scanStartedAt);
    await storage.setSetting('last_history_scan', completedAt);
    await storage.setSetting('last_full_scan', completedAt);

    const trackingCount = await storage.getTrackingCount();

    broadcastMessage({
      type: 'SCAN_COMPLETE',
      data: { found: upsMap.size, saved: savedCount, trackingCount, mode: 'full' },
    });

    return { success: true, found: upsMap.size, saved: savedCount, trackingCount };
  } catch (err) {
    console.error('[BiliGleaner] 全量扫描失败:', err);
    await storage.setSetting('scan_status', 'error');
    broadcastMessage({
      type: 'SCAN_ERROR',
      data: { message: err.message, mode: 'full' },
    });
    return { success: false, message: err.message };
  } finally {
    isScanning = false;
    scanAbortFlag = false;

    if (pendingFollowedCleanup) {
      pendingFollowedCleanup = false;
      const cleanup = await cleanupTrackingPool();
      if (cleanup.removedTracking > 0 || cleanup.removedUpdates > 0) {
        await updateBadge();
        const trackingCount = await storage.getTrackingCount();
        broadcastMessage({
          type: 'SCAN_COMPLETE',
          data: { found: 0, saved: 0, trackingCount, mode: 'followed-cleanup' },
        });
      }
    }

    // 处理扫描期间设置变更触发的待处理操作
    if (pendingScanAction) {
      const action = pendingScanAction;
      pendingScanAction = null;

      if (action.type === 'prune') {
        const pruned = await storage.pruneTrackedUpsByTimeRange(action.days);
        const prunedUpdates = await storage.pruneUpdatesByTimeRange(action.days);
        const cleanup = await cleanupTrackingPool();
        if (pruned > 0 || prunedUpdates > 0 || cleanup.removedUpdates > 0) await updateBadge();
        const trackingCount = await storage.getTrackingCount();
        broadcastMessage({
          type: 'SCAN_COMPLETE',
          data: { found: 0, saved: 0, trackingCount, mode: 'settings-prune' },
        });
      } else if (action.type === 'rescan') {
        console.log(`[BiliGleaner] 执行待处理的重新扫描: ${action.days} 天`);
        runFullScan(action.days);
      }
    }
  }
}

async function runIncrementalScan() {
  if (isScanning) {
    return { success: false, message: '正在扫描中，请稍候' };
  }

  if (isCheckingUpdates) {
    return { success: false, message: '正在检查视频更新，请稍候再扫描' };
  }

  isScanning = true;
  scanAbortFlag = false;

  try {
    const lastFullScan = await storage.getSetting('last_full_scan', null);
    if (!lastFullScan) {
      console.log('[BiliGleaner] 尚未完成首次扫描，跳过增量扫描');
      return { success: true, skipped: true, message: '尚未完成首次扫描，已跳过增量扫描' };
    }

    const scanStartedAt = Date.now();
    const lastHistoryScanAnchor = await storage.getSetting(
      'last_history_scan_anchor',
      await storage.getSetting('last_incremental_scan', lastFullScan)
    );
    await storage.setSetting('scan_status', 'scanning');

    const upsMap = await incrementalScan(Math.floor(Number(lastHistoryScanAnchor) / 1000), (count, date) => {
      broadcastMessage({
        type: 'SCAN_PROGRESS',
        data: { scanned: count, currentDate: date },
      });
    }, () => scanAbortFlag);

    if (scanAbortFlag) {
      console.log('[BiliGleaner] 增量扫描被中止');
      await storage.setSetting('scan_status', 'idle');
      return { success: false, message: '扫描已中止' };
    }

    const savedCount = await processAndSave(upsMap);

    // 按当前设置的时间范围裁剪过期的追踪记录和视频动态
    const scanDays = await storage.getSetting('scan_days', 7);
    const pruned = await storage.pruneTrackedUpsByTimeRange(scanDays);
    const prunedUpdates = await storage.pruneUpdatesByTimeRange(scanDays);
    const cleanup = await cleanupTrackingPool();
    if (pruned > 0) console.log(`[BiliGleaner] 裁剪了 ${pruned} 位超出时间范围的 UP 主`);
    if (prunedUpdates > 0) console.log(`[BiliGleaner] 清理了 ${prunedUpdates} 条过期视频动态`);
    if (cleanup.removedTracking > 0) {
      console.log(`[BiliGleaner] 清理了 ${cleanup.removedTracking} 位已关注的追踪 UP 主`);
    }
    if (cleanup.removedUpdates > 0) {
      console.log(`[BiliGleaner] 清理了 ${cleanup.removedUpdates} 条失效视频动态`);
    }
    if (prunedUpdates > 0 || cleanup.removedUpdates > 0) {
      await updateBadge();
    }

    const completedAt = Date.now();
    await storage.setSetting('scan_status', 'idle');
    await storage.setSetting('last_history_scan_anchor', scanStartedAt);
    await storage.setSetting('last_history_scan', completedAt);
    await storage.setSetting('last_incremental_scan', completedAt);

    const trackingCount = await storage.getTrackingCount();

    broadcastMessage({
      type: 'SCAN_COMPLETE',
      data: { found: upsMap.size, saved: savedCount, trackingCount, mode: 'incremental' },
    });

    return { success: true, found: upsMap.size, saved: savedCount, trackingCount };
  } catch (err) {
    console.error('[BiliGleaner] 增量扫描失败:', err);
    await storage.setSetting('scan_status', 'error');
    broadcastMessage({
      type: 'SCAN_ERROR',
      data: { message: err.message, mode: 'incremental' },
    });
    return { success: false, message: err.message };
  } finally {
    isScanning = false;
    scanAbortFlag = false;

    if (pendingFollowedCleanup) {
      pendingFollowedCleanup = false;
      const cleanup = await cleanupTrackingPool();
      if (cleanup.removedTracking > 0 || cleanup.removedUpdates > 0) {
        await updateBadge();
        const trackingCount = await storage.getTrackingCount();
        broadcastMessage({
          type: 'SCAN_COMPLETE',
          data: { found: 0, saved: 0, trackingCount, mode: 'followed-cleanup' },
        });
      }
    }

    if (pendingScanAction) {
      const action = pendingScanAction;
      pendingScanAction = null;

      if (action.type === 'prune') {
        const pruned = await storage.pruneTrackedUpsByTimeRange(action.days);
        const prunedUpdates = await storage.pruneUpdatesByTimeRange(action.days);
        const cleanup = await cleanupTrackingPool();
        if (pruned > 0 || prunedUpdates > 0 || cleanup.removedUpdates > 0) await updateBadge();
        const trackingCount = await storage.getTrackingCount();
        broadcastMessage({
          type: 'SCAN_COMPLETE',
          data: { found: 0, saved: 0, trackingCount, mode: 'settings-prune' },
        });
      } else if (action.type === 'rescan') {
        console.log(`[BiliGleaner] 执行待处理的重新扫描: ${action.days} 天`);
        runFullScan(action.days);
      }
    }
  }
}

async function runUpdateCheck() {
  if (isScanning) {
    return { success: false, message: '正在扫描历史记录，请稍候再检查视频更新' };
  }

  if (isCheckingUpdates) {
    return { success: false, message: '正在检查视频更新，请稍候' };
  }

  isCheckingUpdates = true;
  updateAbortFlag = false;

  try {
    const updatedCount = await checkAllUpdates((checked, total, updated) => {
      broadcastMessage({
        type: 'UPDATE_CHECK_PROGRESS',
        data: { checked, total, updated },
      });
    }, () => updateAbortFlag);

    if (updateAbortFlag) {
      console.log('[BiliGleaner] 更新检查被中止');
      return { success: false, message: '更新检查已中止' };
    }

    // 清理超出时间范围的旧动态
    const scanDays = await storage.getSetting('scan_days', 7);
    await storage.pruneUpdatesByTimeRange(scanDays);
    await cleanupTrackingPool();

    await updateBadge();

    broadcastMessage({
      type: 'UPDATE_CHECK_COMPLETE',
      data: { updatedCount },
    });

    return { success: true, updatedCount };
  } catch (err) {
    console.error('[BiliGleaner] 更新检查失败:', err);
    broadcastMessage({
      type: 'UPDATE_CHECK_ERROR',
      data: { message: err.message },
    });
    return { success: false, message: err.message };
  } finally {
    isCheckingUpdates = false;
    updateAbortFlag = false;

    if (pendingFollowedCleanup) {
      pendingFollowedCleanup = false;
      const cleanup = await cleanupTrackingPool();
      if (cleanup.removedTracking > 0 || cleanup.removedUpdates > 0) {
        await updateBadge();
        const trackingCount = await storage.getTrackingCount();
        broadcastMessage({
          type: 'SCAN_COMPLETE',
          data: { found: 0, saved: 0, trackingCount, mode: 'followed-cleanup' },
        });
      }
    }

    // 处理检查期间设置变更触发的待处理操作
    if (pendingScanAction) {
      const action = pendingScanAction;
      pendingScanAction = null;

      if (action.type === 'prune') {
        const pruned = await storage.pruneTrackedUpsByTimeRange(action.days);
        const prunedUpdates = await storage.pruneUpdatesByTimeRange(action.days);
        const cleanup = await cleanupTrackingPool();
        if (pruned > 0 || prunedUpdates > 0 || cleanup.removedUpdates > 0) await updateBadge();
        const trackingCount = await storage.getTrackingCount();
        broadcastMessage({
          type: 'SCAN_COMPLETE',
          data: { found: 0, saved: 0, trackingCount, mode: 'settings-prune' },
        });
      } else if (action.type === 'rescan') {
        console.log(`[BiliGleaner] 执行待处理的重新扫描: ${action.days} 天`);
        runFullScan(action.days);
      }
    }
  }
}

// ========== 消息处理 ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[BiliGleaner] 消息处理失败:', err);
      sendResponse({ success: false, message: err.message });
    });
  return true; // 保持消息通道开启（异步响应）
});

async function handleMessage(message) {
  const { action, data } = message;

  switch (action) {
    // 获取状态
    case 'GET_STATUS': {
      const trackingCount = await storage.getTrackingCount();
      const scanStatus = isScanning ? 'scanning' : await storage.getSetting('scan_status', 'idle');
      const lastHistoryScan = await storage.getSetting('last_history_scan', null);
      const lastFullScan = await storage.getSetting('last_full_scan', null);
      const lastIncrementalScan = await storage.getSetting('last_incremental_scan', null);
      const lastUpdateCheck = await storage.getSetting('last_update_check', null);
      let userInfo = null;
      try { userInfo = await fetchNavInfo(); } catch (e) { /* ignore */ }

      return {
        isScanning,
        isCheckingUpdates,
        scanStatus,
        trackingCount,
        lastScan: lastHistoryScan || Math.max(lastFullScan || 0, lastIncrementalScan || 0) || null,
        lastFullScan,
        lastIncrementalScan,
        lastUpdateCheck,
        scanDays: await storage.getSetting('scan_days', 7),
        userInfo,
      };
    }

    // 全量扫描
    case 'FULL_SCAN':
      return runFullScan(data?.days ?? await storage.getSetting('scan_days', 7));

    // 增量扫描
    case 'INCREMENTAL_SCAN':
      return runIncrementalScan();

    // 检查更新
    case 'CHECK_UPDATES':
      return runUpdateCheck();

    // 获取有更新的 UP 主列表
    case 'GET_UPDATED_UPS':
      return storage.getUpdatedUps();

    case 'GET_UPDATE_FEED':
      return storage.getUpdateFeed();

    // 获取全部追踪的 UP 主
    case 'GET_ALL_TRACKED':
      return storage.getTrackedUps();

    // 标记已读（按更新条目 id）
    case 'MARK_READ':
      await storage.markAsRead(data.id);
      await updateBadge();
      return { success: true };

    // 标记未读（按更新条目 id）
    case 'MARK_UNREAD':
      await storage.markAsUnread(data.id);
      await updateBadge();
      return { success: true };

    // 全部标记已读
    case 'MARK_ALL_READ':
      await storage.markAllAsRead();
      await updateBadge();
      return { success: true };

    // 手动添加追踪
    case 'ADD_TRACKING': {
      const mid = String(data.mid);
      if (await storage.isBlacklisted(mid)) {
        return { success: false, message: '该 UP 主已在黑名单中，请先解除拉黑后再添加' };
      }
      let upInfo = { mid, name: `UP主 ${mid}`, face: '' };
      try {
        const card = await fetchUserCard(mid);
        if (card) upInfo = { ...upInfo, ...card };
      } catch (e) { /* use default */ }

      await storage.upsertTrackedUp({
        ...upInfo,
        source: 'manual',
        last_view_time: Math.floor(Date.now() / 1000),
      });
      return { success: true, upInfo };
    }

    // 移除追踪（同时清理该 UP 的视频动态）
    case 'REMOVE_TRACKING':
      await storage.removeTrackedUp(data.mid);
      await storage.removeUpdatesByMid(data.mid);
      await updateBadge();
      return { success: true };

    // 加入黑名单（同时移除追踪和视频动态）
    case 'BLACKLIST_ADD': {
      await storage.addToBlacklist(data.mid, data.name || '', data.face || '');
      await storage.removeTrackedUp(data.mid);
      await storage.removeUpdatesByMid(data.mid);
      await updateBadge();
      return { success: true };
    }

    // 从黑名单移除
    case 'BLACKLIST_REMOVE':
      await storage.removeFromBlacklist(data.mid);
      return { success: true };

    // 获取黑名单
    case 'GET_BLACKLIST':
      return storage.getBlacklist();

    // 获取各 UP 主的未读视频数
    case 'GET_UNREAD_COUNTS':
      return storage.getUnreadCountsByMid();

    // 一键关注
    case 'FOLLOW_USER': {
      try {
        const cookie = await chrome.cookies.get({
          url: 'https://www.bilibili.com',
          name: 'bili_jct',
        });
        if (!cookie) {
          return { success: false, message: '无法获取 CSRF Token，请确保已登录 B 站' };
        }
        await followUser(data.mid, cookie.value);
        await storage.addToFollowedCache(data.mid);
        await storage.removeTrackedUp(data.mid);
        await storage.removeUpdatesByMid(data.mid);
        await updateBadge();
        return { success: true };
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    case 'REFRESH_FOLLOWINGS': {
      return runFollowingsRefresh();
    }

    case 'CLEAR_DATA':
      if (isScanning || isCheckingUpdates) {
        return { success: false, message: '请等待当前任务完成后再清除数据' };
      }
      await storage.clearAllData();
      await storage.setSetting('scan_status', 'idle');
      await storage.setSetting('scan_days', 7);
      pendingFollowedCleanup = false;
      chrome.action.setBadgeText({ text: '' });
      return { success: true };

    // 获取设置
    case 'GET_SETTINGS': {
      return {
        scanDays: await storage.getSetting('scan_days', 7),
      };
    }

    // 保存设置
    case 'SAVE_SETTINGS': {
      if (Object.prototype.hasOwnProperty.call(data, 'scanDays')) {
        const oldDays = await storage.getSetting('scan_days', 7);
        await storage.setSetting('scan_days', data.scanDays);

        if (isScanning) {
          // 扫描进行中：中止当前扫描，安排后续操作
          scanAbortFlag = true;
          if (data.scanDays > oldDays) {
            pendingScanAction = { type: 'rescan', days: data.scanDays };
          } else if (data.scanDays < oldDays) {
            pendingScanAction = { type: 'prune', days: data.scanDays };
          }
        } else if (isCheckingUpdates) {
          // 更新检查进行中：中止当前检查，安排后续操作
          updateAbortFlag = true;
          if (data.scanDays > oldDays) {
            pendingScanAction = { type: 'rescan', days: data.scanDays };
          } else if (data.scanDays < oldDays) {
            pendingScanAction = { type: 'prune', days: data.scanDays };
          }
        } else {
          if (data.scanDays < oldDays) {
            // 缩短范围：裁剪超出时间范围的追踪记录和视频动态
            const pruned = await storage.pruneTrackedUpsByTimeRange(data.scanDays);
            const prunedUpdates = await storage.pruneUpdatesByTimeRange(data.scanDays);
            const cleanup = await cleanupTrackingPool();
            if (pruned > 0 || prunedUpdates > 0 || cleanup.removedUpdates > 0) {
              console.log(`[BiliGleaner] 时间范围缩短，裁剪了 ${pruned} 位 UP 主，${prunedUpdates} 条动态`);
              await updateBadge();
            }
          } else if (data.scanDays > oldDays) {
            // 扩大范围：触发全量扫描以发现更多 UP 主（异步不阻塞）
            console.log(`[BiliGleaner] 时间范围扩大 ${oldDays}→${data.scanDays}，启动全量扫描`);
            runFullScan(data.scanDays);
          }
        }
      }
      return { success: true };
    }

    // 导出用户数据（手动追踪 + 黑名单）
    case 'EXPORT_DATA': {
      const allTracked = await storage.getTrackedUps();
      const manualTracked = allTracked.filter(up => up.source === 'manual');
      const blacklist = await storage.getBlacklist();
      const exportData = {
        format: 'biligleaner-backup',
        version: 2,
        exported_at: new Date().toISOString(),
        manual_tracking: manualTracked.map(up => ({
          mid: up.mid,
          name: up.name || '',
          face: up.face || '',
          last_view_time: up.last_view_time || 0,
        })),
        blacklist: blacklist.map(item => ({
          mid: item.mid,
          name: item.name || '',
          face: item.face || '',
        })),
      };
      return { success: true, data: exportData };
    }

    // 导入用户数据（手动追踪 + 黑名单，合并模式）
    case 'IMPORT_DATA': {
      const importData = data.importData;
      if (!importData || importData.format !== 'biligleaner-backup') {
        return { success: false, message: '无效的备份文件格式' };
      }

      let addedTracking = 0;
      let addedBlacklist = 0;
      let skippedTracking = 0;
      let skippedBlacklist = 0;

      // 导入手动追踪：合并，不覆盖已有条目
      if (Array.isArray(importData.manual_tracking)) {
        for (const up of importData.manual_tracking) {
          const mid = String(up.mid);
          if (await storage.isBlacklisted(mid)) {
            skippedTracking++;
            continue;
          }
          const existing = await storage.getTrackedUp(mid);
          if (existing) {
            // 已在追踪列表中，保留现有数据，仅确保标记为手动
            if (existing.source !== 'manual') {
              await storage.upsertTrackedUp({
                ...existing,
                source: 'manual',
                last_view_time:
                  existing.last_view_time ||
                  Number(up.last_view_time) ||
                  Math.floor(Date.now() / 1000),
              });
            }
            skippedTracking++;
          } else {
            await storage.upsertTrackedUp({
              mid,
              name: up.name || `UP主 ${mid}`,
              face: up.face || '',
              source: 'manual',
              last_view_time: Number(up.last_view_time) || Math.floor(Date.now() / 1000),
            });
            addedTracking++;
          }
        }
      }

      // 导入黑名单：合并，不覆盖已有条目
      if (Array.isArray(importData.blacklist)) {
        for (const item of importData.blacklist) {
          const mid = String(item.mid);
          if (await storage.isBlacklisted(mid)) {
            skippedBlacklist++;
          } else {
            await storage.addToBlacklist(mid, item.name || '', item.face || '');
            // 如果该 UP 主在追踪列表中，移除
            await storage.removeTrackedUp(mid);
            await storage.removeUpdatesByMid(mid);
            addedBlacklist++;
          }
        }
      }

      await updateBadge();
      return {
        success: true,
        addedTracking,
        addedBlacklist,
        skippedTracking,
        skippedBlacklist,
      };
    }

    default:
      return { error: `未知操作: ${action}` };
  }
}

// ========== 辅助函数 ==========

function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // popup 未打开时忽略错误
  });
}

async function updateBadge() {
  const count = await storage.getUnreadUpdateCount();
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#FB7299' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function cleanupTrackingPool() {
  const [trackedUps, followedCache] = await Promise.all([
    storage.getTrackedUps(),
    storage.getFollowedCache(),
  ]);
  const followedSet = new Set(followedCache.map(item => String(item.mid)));
  const midsToRemove = trackedUps
    .filter(up => followedSet.has(String(up.mid)))
    .map(up => String(up.mid));

  const removedTracking = midsToRemove.length > 0
    ? await storage.removeTrackedUpsByMids(midsToRemove)
    : 0;
  const removedUpdates = await storage.removeUpdatesWithoutTrackedUps();

  return { removedTracking, removedUpdates };
}

async function runFollowingsRefresh() {
  const mids = await refreshFollowedCache();

  if (isScanning || isCheckingUpdates) {
    pendingFollowedCleanup = true;
    return { success: true, count: mids.length, removedTracking: 0, removedUpdates: 0, deferred: true };
  }

  const cleanup = await cleanupTrackingPool();
  if (cleanup.removedTracking > 0 || cleanup.removedUpdates > 0) {
    await updateBadge();
  }
  return { success: true, count: mids.length, ...cleanup, deferred: false };
}

// 启动时更新 badge
updateBadge();
ensureAlarms().catch((err) => {
  console.error('[BiliGleaner] 初始化定时任务失败:', err);
});

console.log('[BiliGleaner] Service Worker 已启动');
