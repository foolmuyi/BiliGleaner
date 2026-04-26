/**
 * B站 WBI 签名算法
 * 用于需要 wbi 校验的 API（如 x/space/wbi/arc/search）
 */

import { md5 } from './md5.js';

// 混淆键编码表
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// WBI 密钥缓存
let wbiKeysCache = null;
let wbiKeysCacheTime = 0;
const WBI_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

/**
 * 从 img_url 和 sub_url 中提取密钥并生成混淆密钥
 */
function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32);
}

/**
 * 从 nav 接口获取 WBI 密钥
 */
async function fetchWbiKeys() {
  const now = Date.now();
  if (wbiKeysCache && (now - wbiKeysCacheTime) < WBI_CACHE_TTL) {
    return wbiKeysCache;
  }

  const resp = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'include',
  });
  const data = await resp.json();

  if (data.code !== 0) {
    throw new Error(`获取 WBI 密钥失败: ${data.message}`);
  }

  const { img_url, sub_url } = data.data.wbi_img;
  const imgKey = img_url.split('/').pop().split('.')[0];
  const subKey = sub_url.split('/').pop().split('.')[0];

  wbiKeysCache = { imgKey, subKey };
  wbiKeysCacheTime = now;
  return wbiKeysCache;
}

/**
 * 对请求参数进行 WBI 签名
 * @param {Object} params 原始请求参数
 * @returns {string} 签名后的查询字符串
 */
export async function encWbiSign(params) {
  const { imgKey, subKey } = await fetchWbiKeys();
  const mixinKey = getMixinKey(imgKey, subKey);

  const wts = Math.round(Date.now() / 1000);
  const signParams = { ...params, wts };

  const query = Object.keys(signParams)
    .sort()
    .map(key => {
      // 过滤特殊字符
      const value = String(signParams[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');

  const wRid = md5(query + mixinKey);
  return `${query}&w_rid=${wRid}`;
}

/**
 * 清除 WBI 密钥缓存（用于强制刷新）
 */
export function clearWbiCache() {
  wbiKeysCache = null;
  wbiKeysCacheTime = 0;
}
