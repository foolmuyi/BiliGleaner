/**
 * 关系过滤引擎
 * 排除已关注/黑名单 UP 主，生成最终监控池
 */

import { fetchAllFollowings } from './api.js';
import * as storage from './storage.js';

/**
 * 刷新关注列表缓存
 */
export async function refreshFollowedCache() {
  console.log('[BiliGleaner] 开始刷新关注列表缓存');
  const mids = await fetchAllFollowings();
  await storage.updateFollowedCache(mids);
  await storage.setSetting('followed_cache_time', Date.now());
  console.log(`[BiliGleaner] 关注列表缓存已更新，共 ${mids.length} 人`);
  return mids;
}

/**
 * 过滤 UP 主列表，排除已关注和黑名单
 * @param {Map<string, Object>} upsMap - mid -> UP 主信息
 * @returns {Array<Object>} 过滤后的 UP 主列表
 */
export async function filterUps(upsMap) {
  // 检查关注缓存是否需要刷新（超过 6 小时）
  const cacheTime = await storage.getSetting('followed_cache_time', 0);
  if (Date.now() - cacheTime > 6 * 3600 * 1000) {
    await refreshFollowedCache();
  }

  const [followedCache, blacklist] = await Promise.all([
    storage.getFollowedCache(),
    storage.getBlacklist(),
  ]);
  const followedSet = new Set(followedCache.map(item => String(item.mid)));
  const blacklistSet = new Set(blacklist.map(item => String(item.mid)));

  const result = [];
  let filteredFollowed = 0;
  let filteredBlacklist = 0;

  for (const [mid, upData] of upsMap) {
    if (followedSet.has(String(mid))) {
      filteredFollowed++;
      continue;
    }

    if (blacklistSet.has(String(mid))) {
      filteredBlacklist++;
      continue;
    }

    result.push(upData);
  }

  console.log(
    `[BiliGleaner] 过滤完成：总计 ${upsMap.size}，排除已关注 ${filteredFollowed}，` +
    `排除黑名单 ${filteredBlacklist}，剩余 ${result.length}`
  );

  return result;
}

/**
 * 完整的扫描 + 过滤流程，将结果写入追踪列表
 * @param {Map<string, Object>} upsMap - 扫描得到的 UP 主
 */
export async function processAndSave(upsMap) {
  const filtered = await filterUps(upsMap);

  if (filtered.length > 0) {
    await storage.upsertTrackedUpsBatch(filtered);
  }

  console.log(`[BiliGleaner] 已将 ${filtered.length} 位 UP 主加入追踪列表`);
  return filtered.length;
}
