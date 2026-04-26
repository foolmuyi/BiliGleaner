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

/**
 * 检查单个 UP 主是否有新投稿，返回所有新视频
 * @param {Object} up - 追踪的 UP 主信息
 * @returns {{ lastBvid: string|null, updates: Array }}
 */
async function checkSingleUp(up, cutoffTime) {
  const baselineTime = Math.max(cutoffTime, Number(up.last_view_time) || 0);
  const updates = [];
  let newestBvid = null;
  let page = 1;

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
      // 后续检查：持续翻页，直到找到 last_bvid 或超过扫描范围
      for (const v of videos) {
        const created = Number(v.created) || 0;
        if (v.bvid === up.last_bvid) {
          shouldStop = true;
          break;
        }
        if (created && created <= cutoffTime) {
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
  const cutoffTime = Math.floor(Date.now() / 1000) - scanDays * 24 * 3600;

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
      const { lastBvid, updates } = await checkSingleUp(up, cutoffTime);
      checkedCount++;

      if (updates.length > 0) {
        await storage.addUpdateEntries(updates);
        updatedCount += updates.length;
        console.log(`[BiliGleaner] UP 主 ${up.name} 有 ${updates.length} 个新投稿`);
      }

      if (lastBvid) {
        await storage.upsertTrackedUp({ mid: up.mid, last_bvid: lastBvid });
      }
    } catch (err) {
      checkedCount++;
      if (err?.message === 'RISK_CONTROL') {
        console.warn('[BiliGleaner] 触发风控，暂停 60 秒');
        await new Promise(r => setTimeout(r, 60000));
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
