/**
 * 动态更新监控器
 * 轮询追踪池中 UP 主的最新投稿，检测更新
 * 每个新视频作为独立条目存入 updates store
 */

import { fetchRecentVideos, randomDelay } from './api.js';
import * as storage from './storage.js';

const VIDEO_PAGE_SIZE = 30;

/**
 * 构建单条视频更新条目
 */
function makeUpdateEntry(up, video) {
  return {
    id: `${up.mid}_${video.bvid}`,
    bvid: video.bvid,
    mid: up.mid,
    up_name: up.name,
    up_face: up.face,
    title: video.title,
    pic: video.pic,
    created: video.created,
    play: video.play,
    length: video.length,
    is_read: 0,
    discovered_at: Date.now(),
  };
}

function normalizeTimestampToSeconds(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) return 0;
  return Math.floor(timestamp > 1e12 ? timestamp / 1000 : timestamp);
}

/**
 * 检查单个 UP 主是否有新投稿，返回所有新视频
 * @param {Object} up - 追踪的 UP 主信息
 * @returns {{ lastBvid: string|null, updates: Array }}
 */
async function checkSingleUp(up, cutoffTime, lastSuccessfulCheckTime = 0) {
  const globalLastCheckTime = normalizeTimestampToSeconds(lastSuccessfulCheckTime);
  const upLastCheckTime = normalizeTimestampToSeconds(up.last_checked_at);
  const fallbackBoundary = Math.max(cutoffTime, upLastCheckTime || globalLastCheckTime);
  const baselineTime = Math.max(fallbackBoundary, Number(up.last_view_time) || 0);
  const updates = [];
  let newestBvid = null;
  let page = 1;
  let foundLastBvid = false;

  while (true) {
    const videos = await fetchRecentVideos(up.mid, VIDEO_PAGE_SIZE, page);
    if (!videos || videos.length === 0) break;

    if (!newestBvid) {
      newestBvid = videos[0].bvid;
    }

    let shouldStop = false;

    if (!up.last_bvid) {
      // 首次检查：找出 max(last_view_time, 扫描范围起点) 之后发布的视频
      for (const v of videos) {
        const created = Number(v.created) || 0;
        if (created && created <= baselineTime) {
          shouldStop = true;
          break;
        }
        updates.push(makeUpdateEntry(up, v));
      }
    } else {
      // 后续检查：持续翻页，直到找到 last_bvid 或到达上次检查边界
      for (const v of videos) {
        const created = Number(v.created) || 0;
        if (v.bvid === up.last_bvid) {
          foundLastBvid = true;
          shouldStop = true;
          break;
        }
        if (created && created <= fallbackBoundary) {
          shouldStop = true;
          break;
        }
        updates.push(makeUpdateEntry(up, v));
      }
    }

    if (shouldStop || videos.length < VIDEO_PAGE_SIZE) break;
    page++;
    await randomDelay(400, 800);
  }

  if (up.last_bvid && !foundLastBvid) {
    const freshUpdates = updates.filter(v => (Number(v.created) || 0) > fallbackBoundary);
    console.warn(
      "[BiliGleaner] UP 主 " + up.mid + " 未找到上次检查锚点 " + up.last_bvid +
      "，仅保留 " + freshUpdates.length + "/" + updates.length +
      " 条晚于上次成功检查时间的候选动态"
    );
    return { lastBvid: newestBvid, updates: freshUpdates };
  }

  return { lastBvid: newestBvid, updates };
}

/**
 * 批量检查更新（逐个顺序请求，带频率控制）
 * @param {Function} onProgress - 进度回调 (checked, total, updatedCount)
 * @returns {number} 新视频数量
 */
export async function checkAllUpdates(onProgress = null, isAborted = null) {
  const trackingList = await storage.getTrackedUps();
  const scanDays = await storage.getSetting('scan_days', 7);
  const lastSuccessfulCheckTime = Math.floor(
    Number(await storage.getSetting('last_update_check', 0)) / 1000
  );
  const checkStartedAt = Date.now();
  const cutoffTime = Math.floor(checkStartedAt / 1000) - scanDays * 24 * 3600;

  if (trackingList.length === 0) {
    console.log('[BiliGleaner] 追踪列表为空，跳过更新检查');
    return 0;
  }

  console.log(`[BiliGleaner] 开始检查 ${trackingList.length} 位 UP 主的更新`);

  let checkedCount = 0;
  let updatedCount = 0;
  let aborted = false;

  for (const up of trackingList) {
    if (isAborted && isAborted()) {
      console.log('[BiliGleaner] 更新检查被中止');
      aborted = true;
      break;
    }

    try {
      const { lastBvid, updates } = await checkSingleUp(up, cutoffTime, lastSuccessfulCheckTime);
      checkedCount++;

      const persisted = await storage.persistUpdateCheckResult(up.mid, lastBvid, updates, checkStartedAt);
      if (!persisted) {
        console.log(`[BiliGleaner] UP 主 ${up.mid} 已不在追踪列表中，跳过写回检查结果`);
      } else if (updates.length > 0) {
        updatedCount += updates.length;
        console.log(`[BiliGleaner] UP 主 ${up.name} 有 ${updates.length} 个新投稿`);
      }
    } catch (err) {
      checkedCount++;
      if (err?.message === 'RISK_CONTROL') {
        console.warn('[BiliGleaner] 触发风控，结束本轮更新检查，等待下次调度重试');
        aborted = true;
        break;
      } else {
        console.warn(`[BiliGleaner] 检查 UP ${up.mid} 失败:`, err.message);
      }
    }

    if (onProgress) {
      onProgress(checkedCount, trackingList.length, updatedCount);
    }

    // 每个请求间隔 3-6 秒
    if (checkedCount < trackingList.length) {
      await randomDelay(3000, 6000);
    }
  }

  if (!aborted) {
    await storage.setSetting('last_update_check', Date.now());
  }

  console.log(
    `[BiliGleaner] 更新检查完成，共检查 ${checkedCount} 位，发现 ${updatedCount} 条新视频`
  );

  return updatedCount;
}
