/**
 * 深度历史抓取模块
 * 扫描 B 站历史记录，提取看过的 UP 主
 */

import { fetchHistory, randomDelay } from './api.js';

/**
 * 从历史记录条目中提取 UP 主信息
 */
function extractUpFromItem(item) {
  // 只处理视频类型（archive）
  if (!item.history || item.history.business !== 'archive') return null;

  const owner = item.author_mid ? {
    mid: String(item.author_mid),
    name: item.author_name,
    face: item.author_face,
  } : null;

  if (!owner) return null;

  return {
    mid: owner.mid,
    name: owner.name,
    face: owner.face,
    last_view_time: item.view_at,
  };
}

/**
 * 执行全量历史扫描（最近 N 天）
 * @param {number} days - 扫描天数，默认 7
 * @param {Function} onProgress - 进度回调 (scannedCount, currentDate)
 * @returns {Map<string, Object>} mid -> UP 主信息
 */
export async function fullScan(days = 7, onProgress = null, isAborted = null) {
  const cutoffTime = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  const upsMap = new Map();

  let max = 0;
  let view_at = 0;
  let scannedCount = 0;
  let hasMore = true;

  console.log(`[BiliGleaner] 开始全量扫描，截止 ${days} 天前`);

  while (hasMore) {
    if (isAborted && isAborted()) {
      console.log('[BiliGleaner] 全量扫描被中止');
      break;
    }

    try {
      const { list, cursor } = await fetchHistory(max, view_at);

      if (!list || list.length === 0) {
        hasMore = false;
        break;
      }

      for (const item of list) {
        scannedCount++;
        const up = extractUpFromItem(item);
        if (!up) continue;

        // 保留最近的观看时间
        const existing = upsMap.get(up.mid);
        if (!existing || up.last_view_time > existing.last_view_time) {
          upsMap.set(up.mid, up);
        }
      }

      // 检查是否已经超出时间范围
      if (cursor.view_at <= cutoffTime || cursor.view_at === 0) {
        hasMore = false;
        break;
      }

      max = cursor.max;
      view_at = cursor.view_at;

      if (onProgress) {
        const date = new Date(cursor.view_at * 1000).toLocaleDateString();
        onProgress(scannedCount, date);
      }

      // 保守的频率限制：3s - 6s 随机延迟
      await randomDelay(3000, 6000);

    } catch (err) {
      if (err.message === 'RISK_CONTROL') {
        console.warn('[BiliGleaner] 触发风控，暂停 30 秒后重试');
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      throw err;
    }
  }

  console.log(`[BiliGleaner] 全量扫描完成，共扫描 ${scannedCount} 条，发现 ${upsMap.size} 位 UP 主`);
  return upsMap;
}

/**
 * 执行增量扫描（自上次成功扫描以来）
 * @param {number|null} sinceTime - 上次成功扫描的起始时间戳（秒）
 * @returns {Map<string, Object>} mid -> UP 主信息
 */
export async function incrementalScan(sinceTime = null, onProgress = null, isAborted = null) {
  const fallbackWindowHours = 24;
  const cutoffTime = Number.isFinite(Number(sinceTime)) && Number(sinceTime) > 0
    ? Math.floor(Number(sinceTime))
    : Math.floor(Date.now() / 1000) - fallbackWindowHours * 3600;
  const upsMap = new Map();

  let max = 0;
  let view_at = 0;
  let scannedCount = 0;
  let hasMore = true;

  console.log(`[BiliGleaner] 开始增量扫描，扫描 ${new Date(cutoffTime * 1000).toLocaleString()} 之后的历史`);

  while (hasMore) {
    if (isAborted && isAborted()) {
      console.log('[BiliGleaner] 增量扫描被中止');
      break;
    }

    try {
      const { list, cursor } = await fetchHistory(max, view_at);

      if (!list || list.length === 0) {
        hasMore = false;
        break;
      }

      let reachedCutoff = false;

      for (const item of list) {
        const viewTime = Number(item.view_at) || 0;
        if (viewTime && viewTime <= cutoffTime) {
          reachedCutoff = true;
          break;
        }

        scannedCount++;
        const up = extractUpFromItem(item);
        if (!up) continue;

        const existing = upsMap.get(up.mid);
        if (!existing || up.last_view_time > existing.last_view_time) {
          upsMap.set(up.mid, up);
        }
      }

      if (reachedCutoff || cursor.view_at <= cutoffTime || cursor.view_at === 0) {
        hasMore = false;
        break;
      }

      max = cursor.max;
      view_at = cursor.view_at;

      if (onProgress) {
        onProgress(scannedCount, new Date(cursor.view_at * 1000).toLocaleString());
      }

      // 增量扫描也需要延迟
      await randomDelay(3000, 6000);

    } catch (err) {
      if (err.message === 'RISK_CONTROL') {
        console.warn('[BiliGleaner] 触发风控，暂停 30 秒后重试');
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
      throw err;
    }
  }

  console.log(`[BiliGleaner] 增量扫描完成，共扫描 ${scannedCount} 条，发现 ${upsMap.size} 位 UP 主`);
  return upsMap;
}
