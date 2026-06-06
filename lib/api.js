/**
 * B站 API 封装层
 * 所有 B 站接口请求统一走这里
 */

import { encWbiSign } from './wbi.js';

const BASE_URL = 'https://api.bilibili.com';

/**
 * 通用请求方法，自动携带 Cookie
 */
async function request(url, options = {}) {
  const resp = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      'Referer': 'https://www.bilibili.com',
      ...options.headers,
    },
  });

  if (resp.status === 412) {
    throw new Error('RISK_CONTROL');
  }

  return resp.json();
}

// ========== 历史记录 ==========

/**
 * 获取历史记录（游标分页）
 * @param {number} max - 历史记录截止目标 id（上一页最后一条的 kid）
 * @param {number} view_at - 历史记录截止时间戳（上一页最后一条的 view_at）
 * @param {string} business - 历史记录类型
 * @returns {Object} { list, cursor: { max, view_at, ps } }
 */
export async function fetchHistory(max = 0, view_at = 0, business = '') {
  const params = new URLSearchParams({
    max: String(max),
    view_at: String(view_at),
    business,
  });

  const data = await request(`${BASE_URL}/x/web-interface/history/cursor?${params}`);

  if (data.code !== 0) {
    throw new Error(`获取历史记录失败: ${data.message}`);
  }

  return {
    list: data.data.list || [],
    cursor: data.data.cursor,
  };
}

// ========== 关注列表 ==========

/**
 * 获取关注列表（分页）
 * @param {string} vmid - 当前登录用户 MID
 * @param {number} pn - 页码
 * @param {number} ps - 每页数量
 * @returns {Object} { list, total }
 */
export async function fetchFollowings(vmid, pn = 1, ps = 50) {
  const params = new URLSearchParams({
    vmid: String(vmid),
    pn: String(pn),
    ps: String(ps),
    order: 'desc',
    order_type: 'attention',
  });

  const data = await request(`${BASE_URL}/x/relation/followings?${params}`);

  if (data.code !== 0) {
    throw new Error(`获取关注列表失败: ${data.message}`);
  }

  return {
    list: data.data.list || [],
    total: data.data.total || 0,
  };
}

/**
 * 获取全部关注列表
 * @returns {Array<string>} 所有关注的 mid 列表
 */
export async function fetchAllFollowings() {
  const allMids = [];
  const { mid } = await fetchNavInfo();
  let pn = 1;
  const ps = 50;

  while (true) {
    const { list, total } = await fetchFollowings(mid, pn, ps);

    for (const item of list) {
      allMids.push(String(item.mid));
    }

    if (allMids.length >= total || list.length < ps) break;
    pn++;

    // 关注列表请求也要节流
    await sleep(2000);
  }

  return allMids;
}

// ========== UP 主空间 ==========

/**
 * 获取 UP 主最近投稿（需 WBI 签名）
 * @param {string} mid - UP 主 ID
 * @param {number} count - 获取数量
 * @param {number} pn - 页码
 * @returns {Array} 视频列表 [{ bvid, title, pic, created, description, length, play }]
 */
export async function fetchRecentVideos(mid, count = 30, pn = 1) {
  const params = { mid, ps: count, pn };
  const signedQuery = await encWbiSign(params);

  const data = await request(
    `${BASE_URL}/x/space/wbi/arc/search?${signedQuery}`
  );

  if (data.code !== 0) {
    const message = data.message || "未知错误";
    if (data.code === -352 || /风控|频繁|限制|412/.test(message)) {
      throw new Error("RISK_CONTROL");
    }
    throw new Error("获取 UP 主 " + mid + " 最新投稿失败: " + message);
  }

  const vlist = data.data?.list?.vlist;
  if (!vlist || vlist.length === 0) return [];

  return vlist.map(v => ({
    bvid: v.bvid,
    title: v.title,
    pic: v.pic,
    created: v.created,
    description: v.description,
    length: v.length,
    play: v.play,
  }));
}

// ========== 用户信息 ==========

/**
 * 获取当前登录用户信息
 */
export async function fetchNavInfo() {
  const data = await request(`${BASE_URL}/x/web-interface/nav`);

  if (data.code !== 0) {
    throw new Error(`获取用户信息失败: ${data.message}`);
  }

  return {
    isLogin: data.data.isLogin,
    mid: String(data.data.mid),
    uname: data.data.uname,
    face: data.data.face,
  };
}

// ========== 关注操作 ==========

/**
 * 关注某个 UP 主
 * @param {string} mid - 要关注的 UP 主 ID
 * @param {string} csrf - CSRF Token（从 Cookie 中获取 bili_jct）
 */
export async function followUser(mid, csrf) {
  const data = await request(`${BASE_URL}/x/relation/modify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      fid: String(mid),
      act: '1', // 1=关注
      re_src: '11',
      csrf,
    }),
  });

  if (data.code !== 0) {
    throw new Error(`关注失败: ${data.message}`);
  }

  return true;
}

/**
 * 获取 UP 主信息（头像、昵称等）
 * @param {string} mid
 */
export async function fetchUserCard(mid) {
  const params = new URLSearchParams({ mid: String(mid) });
  const data = await request(`${BASE_URL}/x/web-interface/card?${params}`);

  if (data.code !== 0) {
    return null;
  }

  const card = data.data.card;
  return {
    mid: String(card.mid),
    name: card.name,
    face: card.face,
    sign: card.sign,
    fans: card.fans,
  };
}

// ========== 工具函数 ==========

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 随机延迟（用于请求节流）
 * @param {number} min - 最小延迟（毫秒）
 * @param {number} max - 最大延迟（毫秒）
 */
export function randomDelay(min = 1500, max = 3000) {
  const delay = min + Math.random() * (max - min);
  return sleep(delay);
}
