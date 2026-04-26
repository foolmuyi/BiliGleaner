/**
 * BiliGleaner Popup - Tech Fusion Edition
 */

// ========== 消息通信 ==========

function sendMessage(action, data = {}) {
  return chrome.runtime.sendMessage({ action, data });
}

// ========== DOM 工具 & 状态 ==========

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const FALLBACK_FACE =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="%23ddd" width="64" height="64"/><text x="32" y="38" text-anchor="middle" font-size="20" fill="%23999">UP</text></svg>';
const UPDATE_FILTERS = {
  ALL: 'all',
  UNREAD: 'unread',
};
const ALLOWED_IMAGE_HOST_SUFFIXES = [
  'bilibili.com',
  'hdslb.com',
  'biliimg.com',
  'bilivideo.com',
];
let currentUpdateFilter = UPDATE_FILTERS.ALL;

// ========== Toast 系统 ==========

function showToast(message, type = 'info', duration = 3000) {
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const iconMap = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
    warn: '⚠️'
  };

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = iconMap[type] || '🔔';

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;

  toast.append(icon, text);

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ========== 骨架屏 (Skeleton) ==========

function showSkeletons(containerId, count = 5) {
  const container = $(`#${containerId}`);
  const existingEmpty = container.querySelector('.empty-state');
  if (existingEmpty) existingEmpty.style.display = 'none';

  // 清除现有卡片，保留空状态占位
  container.querySelectorAll('.up-card, .skeleton-card').forEach(el => el.remove());

  for (let i = 0; i < count; i++) {
    const skel = document.createElement('div');
    skel.className = 'skeleton-card';
    skel.innerHTML = `
      <div class="skeleton-avatar skeleton"></div>
      <div class="skeleton-content">
        <div class="skeleton-line skeleton"></div>
        <div class="skeleton-line short skeleton"></div>
      </div>
    `;
    container.appendChild(skel);
  }
}

function hideSkeletons(containerId) {
  const container = $(`#${containerId}`);
  container.querySelectorAll('.skeleton-card').forEach(el => el.remove());
}

// ========== 工具函数 ==========

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d前`;

  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function parseMid(input) {
  const str = input.trim();
  if (/^\d+$/.test(str)) return str;
  const match = str.match(/space\.bilibili\.com\/(\d+)/);
  return match ? match[1] : null;
}

function normalizeImageUrl(url) {
  if (!url) return FALLBACK_FACE;
  const normalized = url.startsWith('//') ? `https:${url}` : url;

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    const isAllowedHost = ALLOWED_IMAGE_HOST_SUFFIXES.some(
      suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)
    );

    if (!isAllowedHost || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      return FALLBACK_FACE;
    }

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }

    return parsed.toString();
  } catch {
    return FALLBACK_FACE;
  }
}

function updateFeedBadge(delta = 0) {
  const badge = $('#updateBadge');
  const current = parseInt(badge.textContent || '0', 10);
  const next = Math.max(0, current + delta);
  if (next > 0) {
    badge.textContent = String(next);
    badge.style.display = 'inline-flex';
  } else {
    badge.textContent = '0';
    badge.style.display = 'none';
  }
}

function setUpdateFilter(filter) {
  currentUpdateFilter =
    filter === UPDATE_FILTERS.UNREAD ? UPDATE_FILTERS.UNREAD : UPDATE_FILTERS.ALL;

  $$('#updateFilterGroup .filter-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.updateFilter === currentUpdateFilter);
  });

  renderUpdateFeed(window._fullUpdateFeed || []);
}

function renderUpdateFeed(list) {
  const fullList = Array.isArray(list) ? [...list] : [];
  const filteredList = currentUpdateFilter === UPDATE_FILTERS.UNREAD
    ? fullList.filter(entry => entry.is_read === 0)
    : fullList;

  const container = $('#updateList');
  const empty = $('#emptyUpdates');
  const emptyTitle = empty.querySelector('.empty-title');
  const emptyDesc = empty.querySelector('.empty-desc');
  const badge = $('#updateBadge');
  const unreadCount = fullList.filter(entry => entry.is_read === 0).length;

  container.querySelectorAll('.video-card').forEach(c => c.remove());
  badge.textContent = String(unreadCount);
  badge.style.display = unreadCount > 0 ? 'inline-flex' : 'none';

  if (filteredList.length === 0) {
    empty.style.display = 'block';
    if (fullList.length === 0) {
      emptyTitle.textContent = '暂无视频动态';
      emptyDesc.textContent = '点击“检查更新”或等待自动任务';
    } else {
      emptyTitle.textContent = '暂无未读视频动态';
      emptyDesc.textContent = '当前视频动态都已读，可切换到“全部”查看';
    }
    return;
  }

  empty.style.display = 'none';
  filteredList.sort((a, b) => (b.created || 0) - (a.created || 0));
  for (const entry of filteredList) {
    container.appendChild(renderVideoCard(entry));
  }
}

function syncCachedUpdateEntry(entryId, patch) {
  if (!Array.isArray(window._fullUpdateFeed)) return;
  const idx = window._fullUpdateFeed.findIndex(entry => entry.id === entryId);
  if (idx === -1) return;
  window._fullUpdateFeed[idx] = {
    ...window._fullUpdateFeed[idx],
    ...patch,
  };
}

async function markUpdateRead(entryId, cardEl) {
  if (!entryId || cardEl.classList.contains('is-read')) return;

  const result = await sendMessage('MARK_READ', { id: entryId });
  if (result?.success === false) {
    throw new Error(result.message || '标记已读失败');
  }

  cardEl.classList.add('is-read');
  const newTag = cardEl.querySelector('.tag-new');
  if (newTag) newTag.remove();
  const readBtn = cardEl.querySelector('[data-action="mark-read"]');
  if (readBtn) readBtn.remove();
  syncCachedUpdateEntry(entryId, { is_read: 1 });
  updateFeedBadge(-1);

  if (currentUpdateFilter === UPDATE_FILTERS.UNREAD) {
    renderUpdateFeed(window._fullUpdateFeed || []);
  }
}

// ========== 渲染函数 ==========

function formatPlayCount(n) {
  if (!n) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/**
 * 渲染视频动态卡片（用于更新 feed，以单个视频为单位）
 */
function renderVideoCard(entry) {
  const card = document.createElement('div');
  card.className = `video-card ${entry.is_read ? 'is-read' : ''}`;
  card.dataset.id = entry.id;
  card.dataset.mid = entry.mid;

  // 视频封面
  const thumbWrap = document.createElement('a');
  thumbWrap.className = 'video-thumb-wrap';
  thumbWrap.href = `https://www.bilibili.com/video/${entry.bvid}`;
  thumbWrap.target = '_blank';
  thumbWrap.rel = 'noopener noreferrer';
  const thumb = document.createElement('img');
  thumb.className = 'video-thumb';
  thumb.src = normalizeImageUrl(entry.pic);
  thumb.onerror = () => { thumb.style.display = 'none'; };
  thumbWrap.appendChild(thumb);
  if (entry.length) {
    const dur = document.createElement('span');
    dur.className = 'video-duration';
    dur.textContent = entry.length;
    thumbWrap.appendChild(dur);
  }

  // 内容区
  const content = document.createElement('div');
  content.className = 'video-card-content';

  const titleLink = document.createElement('a');
  titleLink.className = 'video-title';
  titleLink.href = `https://www.bilibili.com/video/${entry.bvid}`;
  titleLink.target = '_blank';
  titleLink.rel = 'noopener noreferrer';
  titleLink.textContent = entry.title;

  const upRow = document.createElement('div');
  upRow.className = 'video-up-row';
  const avatar = document.createElement('img');
  avatar.className = 'video-up-avatar';
  avatar.src = normalizeImageUrl(entry.up_face);
  avatar.onerror = () => { avatar.src = FALLBACK_FACE; };
  const upName = document.createElement('a');
  upName.className = 'video-up-name';
  upName.href = `https://space.bilibili.com/${encodeURIComponent(entry.mid)}`;
  upName.target = '_blank';
  upName.rel = 'noopener noreferrer';
  upName.textContent = entry.up_name || `UP ${entry.mid}`;
  const infoWrap = document.createElement('div');
  infoWrap.className = 'video-info-wrap';
  const upLeft = document.createElement('div');
  upLeft.className = 'video-up-info';
  upLeft.append(avatar, upName);
  if (!entry.is_read) {
    const tag = document.createElement('span');
    tag.className = 'tag tag-new';
    tag.textContent = 'NEW';
    upLeft.appendChild(tag);
  }

  const meta = document.createElement('div');
  meta.className = 'video-meta-text';
  const parts = [formatTime(entry.created)];
  if (entry.play) parts.push(`${formatPlayCount(entry.play)}播放`);
  meta.textContent = parts.join(' · ');
  infoWrap.append(upLeft, meta);

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (!entry.is_read) {
    actions.appendChild(createActionButton('✓', '标记已读', 'mark-read'));
  } else {
    actions.appendChild(createActionButton('↺', '标为未读', 'mark-unread'));
  }
  actions.appendChild(createActionButton('＋', '一键关注', 'follow'));
  actions.appendChild(createActionButton('🚫', '拉黑', 'blacklist'));
  actions.appendChild(createActionButton('✕', '不再追踪', 'remove'));

  upRow.append(infoWrap, actions);
  content.append(titleLink, upRow);
  card.append(thumbWrap, content);

  // 点击视频链接时自动标记已读
  if (!entry.is_read) {
    const openVideo = async (e) => {
      const url = e.currentTarget.href;
      e.preventDefault();
      try {
        await markUpdateRead(entry.id, card);
      } catch (err) {
        console.warn('[BiliGleaner] 自动标记已读失败:', err);
      }
      await chrome.tabs.create({ url });
    };
    thumbWrap.addEventListener('click', openVideo);
    titleLink.addEventListener('click', openVideo);
  }

  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleVideoAction(btn.dataset.action, entry, card);
    });
  });

  return card;
}

/**
 * 渲染 UP 主卡片（用于追踪列表，以 UP 主为单位）
 */
function renderUpCard(up, unreadCount = 0) {
  const safeMid = encodeURIComponent(String(up.mid));
  
  const card = document.createElement('div');
  card.className = 'up-card';
  card.dataset.mid = up.mid;

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'avatar-wrap';
  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.src = normalizeImageUrl(up.face);
  avatar.onerror = () => { avatar.src = FALLBACK_FACE; };
  avatarWrap.appendChild(avatar);
  if (unreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'avatar-badge';
    badge.textContent = String(unreadCount);
    avatarWrap.appendChild(badge);
  }

  const content = document.createElement('div');
  content.className = 'up-card-content';

  const nameLink = document.createElement('a');
  nameLink.className = 'up-name';
  nameLink.href = `https://space.bilibili.com/${safeMid}`;
  nameLink.target = '_blank';
  nameLink.rel = 'noopener noreferrer';
  nameLink.textContent = up.name || `UP ${up.mid}`;
  content.appendChild(nameLink);

  const metaRow = document.createElement('div');
  metaRow.className = 'meta-row';
  metaRow.textContent = `上次观看: ${formatTime(up.last_view_time)}`;
  content.appendChild(metaRow);

  const actions = document.createElement('div');
  actions.className = 'card-actions up-card-actions';
  actions.appendChild(createActionButton('＋', '关注', 'follow'));
  actions.appendChild(createActionButton('🚫', '拉黑', 'blacklist'));
  actions.appendChild(createActionButton('✕', '移除', 'remove'));

  card.append(avatarWrap, content, actions);

  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleCardAction(btn.dataset.action, up, card);
    });
  });

  return card;
}

function createActionButton(icon, title, action) {
  const btn = document.createElement('div');
  btn.className = 'action-icon';
  btn.dataset.action = action;
  btn.title = title;
  btn.textContent = icon;
  return btn;
}

// ========== 数据加载 ==========

async function loadUpdatedUps(isInitial = false) {
  if (isInitial) showSkeletons('updateList', 3);
  
  const result = await sendMessage('GET_UPDATE_FEED');
  const list = Array.isArray(result) ? result : [];

  if (isInitial) hideSkeletons('updateList');
  window._fullUpdateFeed = list;
  renderUpdateFeed(list);
}

async function loadTrackingList(isInitial = false) {
  if (isInitial) showSkeletons('trackingList', 5);

  const [result, unreadCounts] = await Promise.all([
    sendMessage('GET_ALL_TRACKED'),
    sendMessage('GET_UNREAD_COUNTS'),
  ]);
  const list = Array.isArray(result) ? result : [];
  const countsObj = unreadCounts || {};
  const container = $('#trackingList');
  const empty = $('#emptyTracking');
  const countEl = $('#trackCount');

  if (isInitial) hideSkeletons('trackingList');
  container.querySelectorAll('.up-card').forEach(c => c.remove());

  if (list.length === 0) {
    empty.style.display = 'block';
    countEl.textContent = '0 人';
    window._fullTrackingList = [];
    window._unreadCounts = countsObj;
    return;
  }

  empty.style.display = 'none';
  countEl.textContent = `${list.length} 人`;

  list.sort((a, b) => (b.last_view_time || 0) - (a.last_view_time || 0));
  window._fullTrackingList = list;
  window._unreadCounts = countsObj;
  
  renderFilteredTracking(list, countsObj);
}

function renderFilteredTracking(list, countsObj) {
  const container = $('#trackingList');
  container.querySelectorAll('.up-card').forEach(c => c.remove());
  countsObj = countsObj || window._unreadCounts || {};
  for (const up of list) {
    container.appendChild(renderUpCard(up, countsObj[String(up.mid)] || 0));
  }
}

async function loadStatus() {
  const status = await sendMessage('GET_STATUS');
  if (!status || status.success === false) return status;

  const userBadge = $('#userInfo');
  const userAvatar = $('#userAvatar');
  const userName = $('#userName');
  if (status.userInfo?.isLogin) {
    userName.textContent = status.userInfo.uname;
    userBadge.classList.remove('warn');
    if (status.userInfo.face) {
      userAvatar.src = normalizeImageUrl(status.userInfo.face);
      userAvatar.style.display = '';
      userAvatar.onerror = () => { userAvatar.style.display = 'none'; };
    }
  } else {
    userName.textContent = '未登录';
    userAvatar.style.display = 'none';
    userBadge.classList.add('warn');
  }

  $('#lastFullScan').textContent = formatTime(status.lastScan || status.lastFullScan);
  $('#lastUpdateCheck').textContent = formatTime(status.lastUpdateCheck);
  $('#scanDaysSelect').value = String(status.scanDays || 7);
  
  updateStatusUI(status);
  return status;
}

async function triggerInitialScan(message = '首次使用，正在初始化扫描...', toastType = 'info') {
  $('#statusText').textContent = '🔄 正在初始化扫描...';
  $('#statusDot').classList.add('busy');
  $('#progressBar').style.display = 'block';
  showToast(message, toastType);

  try {
    const result = await sendMessage('FULL_SCAN');
    if (result?.success === false) {
      showToast(result.message || '初始化扫描失败', 'error');
      loadStatus();
      return false;
    }
    await Promise.all([loadStatus(), loadTrackingList(), loadUpdatedUps()]);
    return true;
  } catch {
    showToast('初始化扫描启动失败', 'error');
    loadStatus();
    return false;
  }
}

async function startUpdateCheck() {
  $('#statusText').textContent = '🔄 准备检查更新...';
  $('#statusDot').classList.add('busy');
  $('#progressBar').style.display = 'block';

  try {
    const result = await sendMessage('CHECK_UPDATES');
    if (result?.success === false) {
      showToast(result.message, 'error');
      loadStatus();
    }
  } catch (e) {
    showToast('请求失败', 'error');
    loadStatus();
  }
}

function updateStatusUI(status) {
  const textEl = $('#statusText');
  const dotEl = $('#statusDot');
  const barEl = $('#progressBar');

  if (status.isScanning) {
    textEl.textContent = '⏳ 正在扫描历史...';
    dotEl.classList.add('busy');
    barEl.style.display = 'block';
  } else if (status.isCheckingUpdates) {
    textEl.textContent = '🔍 正在检查视频更新...';
    dotEl.classList.add('busy');
    barEl.style.display = 'block';
  } else {
    textEl.textContent = `系统就绪 · 追踪 ${status.trackingCount || 0} 位 UP 主`;
    dotEl.classList.remove('busy');
    barEl.style.display = 'none';
    $('#progressFill').style.width = '0';
  }
}

// ========== 事件处理 ==========

async function handleVideoAction(action, entry, cardEl) {
  switch (action) {
    case 'mark-read':
      await markUpdateRead(entry.id, cardEl);
      showToast('已读', 'success');
      loadUpdatedUps();
      loadTrackingList();
      break;

    case 'mark-unread': {
      const result = await sendMessage('MARK_UNREAD', { id: entry.id });
      if (result?.success !== false) {
        showToast('已标为未读', 'success');
        loadUpdatedUps();
        loadTrackingList();
      }
      break;
    }

    case 'follow':
      if (confirm(`确定关注「${entry.up_name}」吗？`)) {
        const result = await sendMessage('FOLLOW_USER', { mid: entry.mid });
        if (result?.success) {
          showToast(`已关注: ${entry.up_name}`, 'success');
          loadUpdatedUps();
          loadTrackingList();
          loadStatus();
        } else {
          showToast(`关注失败: ${result?.message || '未知错误'}`, 'error');
        }
      }
      break;

    case 'remove':
      if (confirm(`不再追踪「${entry.up_name}」？`)) {
        const result = await sendMessage('REMOVE_TRACKING', { mid: entry.mid });
        if (result?.success) {
          animateRemove(cardEl);
          showToast(`已移除: ${entry.up_name}`, 'info');
          setTimeout(() => {
            loadUpdatedUps();
            loadTrackingList();
            loadStatus();
          }, 300);
        } else {
          showToast(result?.message || '移除失败', 'error');
        }
      }
      break;

    case 'blacklist':
      if (confirm(`拉黑「${entry.up_name}」？该 UP 主即使出现在历史记录中也不会被追踪。`)) {
        const result = await sendMessage('BLACKLIST_ADD', {
          mid: entry.mid,
          name: entry.up_name,
          face: entry.up_face,
        });
        if (result?.success) {
          animateRemove(cardEl);
          showToast(`已拉黑: ${entry.up_name}`, 'info');
          setTimeout(() => {
            loadUpdatedUps();
            loadTrackingList();
            loadBlacklist();
            loadStatus();
          }, 300);
        } else {
          showToast(result?.message || '拉黑失败', 'error');
        }
      }
      break;
  }
}

async function handleCardAction(action, up, cardEl) {
  switch (action) {
    case 'follow':
      if (confirm(`确定关注「${up.name}」吗？`)) {
        const result = await sendMessage('FOLLOW_USER', { mid: up.mid });
        if (result?.success) {
          animateRemove(cardEl);
          showToast(`已关注: ${up.name}`, 'success');
          setTimeout(() => {
            loadUpdatedUps();
            loadTrackingList();
            loadStatus();
          }, 300);
        } else {
          showToast(`关注失败: ${result?.message || '未知错误'}`, 'error');
        }
      }
      break;

    case 'remove':
      if (confirm(`不再追踪「${up.name}」？`)) {
        const result = await sendMessage('REMOVE_TRACKING', { mid: up.mid });
        if (result?.success) {
          animateRemove(cardEl);
          showToast(`已移除: ${up.name}`, 'info');
          setTimeout(() => {
            loadUpdatedUps();
            loadTrackingList();
            loadStatus();
          }, 300);
        } else {
          showToast(result?.message || '移除失败', 'error');
        }
      }
      break;

    case 'blacklist':
      if (confirm(`拉黑「${up.name}」？该 UP 主即使出现在历史记录中也不会被追踪。`)) {
        const result = await sendMessage('BLACKLIST_ADD', { mid: up.mid, name: up.name, face: up.face });
        if (result?.success) {
          animateRemove(cardEl);
          showToast(`已拉黑: ${up.name}`, 'info');
          setTimeout(() => {
            loadUpdatedUps();
            loadTrackingList();
            loadBlacklist();
            loadStatus();
          }, 300);
        } else {
          showToast(result?.message || '拉黑失败', 'error');
        }
      }
      break;
  }
}

function animateRemove(el) {
  el.style.opacity = '0';
  el.style.transform = 'translateX(20px)';
  setTimeout(() => el.remove(), 300);
}

async function loadBlacklist() {
  const list = await sendMessage('GET_BLACKLIST');
  const items = Array.isArray(list) ? list : [];
  const container = $('#blacklistItems');
  const countEl = $('#blacklistCount');
  
  container.querySelectorAll('.up-card, .empty-state').forEach(c => c.remove());
  countEl.textContent = `${items.length} 人`;

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.display = 'block';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '🚫';
    const title = document.createElement('h3');
    title.className = 'empty-title';
    title.textContent = '黑名单为空';
    const desc = document.createElement('p');
    desc.className = 'empty-desc';
    desc.textContent = '在追踪列表或视频动态中拉黑 UP 主';
    empty.append(icon, title, desc);
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'up-card';

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'avatar-wrap';
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = normalizeImageUrl(item.face);
    avatar.onerror = () => { avatar.src = FALLBACK_FACE; };
    avatarWrap.appendChild(avatar);

    const content = document.createElement('div');
    content.className = 'up-card-content';
    const nameEl = document.createElement('a');
    nameEl.className = 'up-name';
    nameEl.href = `https://space.bilibili.com/${encodeURIComponent(item.mid)}`;
    nameEl.target = '_blank';
    nameEl.rel = 'noopener noreferrer';
    nameEl.textContent = item.name || `UP ${item.mid}`;
    content.appendChild(nameEl);

    const actions = document.createElement('div');
    actions.className = 'card-actions up-card-actions';
    const removeBtn = createActionButton('↩', '解除拉黑', 'unblacklist');
    actions.appendChild(removeBtn);

    card.append(avatarWrap, content, actions);

    removeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await sendMessage('BLACKLIST_REMOVE', { mid: item.mid });
      animateRemove(card);
      showToast(`已解除拉黑: ${item.name || item.mid}`, 'success');
      setTimeout(() => loadBlacklist(), 300);
    });

    container.appendChild(card);
  }
}

function initEventListeners() {
  // 标签切换
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  $$('#updateFilterGroup .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      setUpdateFilter(btn.dataset.updateFilter);
    });
  });

  // 检查更新
  $('#btnCheckUpdates').addEventListener('click', async () => {
    const status = await sendMessage('GET_STATUS');
    if (status.isScanning || status.isCheckingUpdates) return;
    if ((status.trackingCount || 0) === 0 && !status.lastFullScan) {
      const initialized = await triggerInitialScan('追踪列表尚未建立，先为你执行首次扫描...', 'info');
      if (!initialized) return;
      showToast('首次扫描完成，继续检查视频更新...', 'info');
      await startUpdateCheck();
      return;
    }

    await startUpdateCheck();
  });

  // 扫描历史
  $('#btnScan').addEventListener('click', async () => {
    const status = await sendMessage('GET_STATUS');
    if (status.isScanning || status.isCheckingUpdates) return;

    const action = status.lastFullScan ? 'INCREMENTAL_SCAN' : 'FULL_SCAN';
    
    $('#statusDot').classList.add('busy');
    $('#progressBar').style.display = 'block';
    
    try {
      const result = await sendMessage(action);
      if (result?.success === false) {
        showToast(result.message || '扫描失败', 'error');
      }
      await Promise.all([loadStatus(), loadTrackingList(), loadUpdatedUps()]);
    } catch (e) {
      showToast('扫描启动失败', 'error');
      loadStatus();
    }
  });

  $('#btnMarkAllRead').addEventListener('click', async () => {
    await sendMessage('MARK_ALL_READ');
    showToast('全部已读', 'success');
    loadUpdatedUps();
    loadTrackingList();
  });

  $('#scanDaysSelect').addEventListener('change', async (e) => {
    const scanDays = Number(e.target.value);
    const status = await sendMessage('GET_STATUS');
    const oldDays = status?.scanDays || 7;
    
    await sendMessage('SAVE_SETTINGS', { scanDays });
    
    if (scanDays > oldDays) {
      showToast(`已扩大到 ${scanDays} 天，正在扫描补充...`, 'info');
    } else {
      showToast(`设置已保存: ${scanDays}天`, 'success');
    }
    loadStatus();
    loadTrackingList();
    loadUpdatedUps();
  });

  $('#btnAddTracking').addEventListener('click', async () => {
    const input = $('#addMidInput');
    const mid = parseMid(input.value);
    if (!mid) {
      input.classList.add('error');
      setTimeout(() => input.classList.remove('error'), 1500);
      showToast('请输入有效的 UID', 'warn');
      return;
    }
    const result = await sendMessage('ADD_TRACKING', { mid });
    if (result?.success) {
      input.value = '';
      showToast(`已添加: ${result.upInfo?.name || mid}`, 'success');
      loadTrackingList();
      loadStatus();
    } else {
      showToast(result?.message || '添加失败', 'error');
    }
  });

  let isComposing = false;
  let filterTimer = null;
  const searchInput = $('#searchInput');

  function doTrackingFilter() {
    const val = searchInput.value.trim().toLowerCase();
    if (!window._fullTrackingList) return;
    const filtered = window._fullTrackingList.filter(up =>
      up.name?.toLowerCase().includes(val) || String(up.mid).includes(val)
    );
    renderFilteredTracking(filtered);
  }

  searchInput.addEventListener('compositionstart', () => { isComposing = true; });
  searchInput.addEventListener('compositionend', () => {
    isComposing = false;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(doTrackingFilter, 50);
  });
  searchInput.addEventListener('input', (e) => {
    if (e.isComposing || isComposing) return;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(doTrackingFilter, 50);
  });

  // 数据导出
  $('#btnExportData').addEventListener('click', async () => {
    try {
      const result = await sendMessage('EXPORT_DATA');
      if (!result?.success) {
        showToast('导出失败', 'error');
        return;
      }
      const json = JSON.stringify(result.data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `biligleaner-backup-${date}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      const mt = result.data.manual_tracking?.length || 0;
      const bl = result.data.blacklist?.length || 0;
      showToast(`已导出: ${mt} 位手动追踪, ${bl} 位黑名单`, 'success');
    } catch (e) {
      showToast('导出失败: ' + e.message, 'error');
    }
  });

  // 数据导入
  const importFileInput = $('#importFileInput');
  $('#btnImportData').addEventListener('click', () => {
    importFileInput.click();
  });
  importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importFileInput.value = '';

    try {
      const text = await file.text();
      let importData;
      try {
        importData = JSON.parse(text);
      } catch {
        showToast('文件格式错误，请选择有效的 JSON 备份文件', 'error');
        return;
      }

      if (importData.format !== 'biligleaner-backup') {
        showToast('不是有效的 BiliGleaner 备份文件', 'error');
        return;
      }

      const mt = importData.manual_tracking?.length || 0;
      const bl = importData.blacklist?.length || 0;
      if (!confirm(
        `确认导入以下数据？\n\n` +
        `• 手动追踪: ${mt} 位 UP 主\n` +
        `• 黑名单: ${bl} 位 UP 主\n\n` +
        `导入将与现有数据合并，不会覆盖已有条目。`
      )) return;

      const result = await sendMessage('IMPORT_DATA', { importData });
      if (result?.success) {
        showToast(
          `导入完成: 新增 ${result.addedTracking} 位追踪, ${result.addedBlacklist} 位黑名单`,
          'success'
        );
        loadTrackingList();
        loadBlacklist();
        loadStatus();
      } else {
        showToast(result?.message || '导入失败', 'error');
      }
    } catch (err) {
      showToast('导入失败: ' + err.message, 'error');
    }
  });

  $('#btnRefreshFollowings').addEventListener('click', async () => {
    showToast('正在刷新关注列表...', 'info');
    const result = await sendMessage('REFRESH_FOLLOWINGS');
    if (result?.success) {
      if (result.deferred) {
        showToast(`缓存已刷新，当前任务结束后再同步追踪列表`, 'success');
      } else if ((result.removedTracking || 0) > 0) {
        showToast(`刷新成功: ${result.count}人，已同步移除 ${result.removedTracking} 位已关注 UP`, 'success');
      } else {
        showToast(`刷新成功: ${result.count}人`, 'success');
      }
      loadUpdatedUps();
      loadTrackingList();
      loadStatus();
    } else {
      showToast(result?.message || '刷新失败', 'error');
    }
  });

  $('#btnClearData').addEventListener('click', async () => {
    if (!confirm('确定清空所有本地数据吗？')) return;
    const result = await sendMessage('CLEAR_DATA');
    if (result?.success) {
      showToast('数据已清空', 'info');
      location.reload();
    }
  });
}

// ========== 消息监听 ==========

chrome.runtime.onMessage.addListener((msg) => {
  const { type, data } = msg;
  const bar = $('#progressBar');
  const thumb = $('#progressFill');
  const statusText = $('#statusText');

  switch (type) {
    case 'SCAN_PROGRESS':
      statusText.textContent = `⏳ 扫描中: ${data.scanned} 条 (${data.currentDate})`;
      break;

    case 'SCAN_COMPLETE':
      if (data.mode === 'settings-prune') {
        showToast(`时间范围已调整，当前追踪 ${data.trackingCount} 位`, 'info');
      } else if (data.mode === 'followed-cleanup') {
        showToast(`关注缓存已同步，当前追踪 ${data.trackingCount} 位`, 'info');
      } else {
        showToast(`扫描完成: 当前追踪 ${data.trackingCount} 位 UP 主`, 'success');
      }
      loadStatus();
      loadTrackingList();
      loadUpdatedUps();
      break;

    case 'UPDATE_CHECK_PROGRESS':
      {
        const pct = Math.round((data.checked / data.total) * 100);
        statusText.textContent = `🔍 检查中: ${data.checked}/${data.total}`;
        thumb.style.width = `${pct}%`;
      }
      break;

    case 'UPDATE_CHECK_COMPLETE':
      showToast(`检查完成: 发现 ${data.updatedCount} 条新动态`, 'success');
      loadStatus();
      loadUpdatedUps();
      break;
    
    case 'SCAN_ERROR':
    case 'UPDATE_CHECK_ERROR':
      showToast(data.message, 'error');
      loadStatus();
      break;
  }
});

// ========== 初始化 ==========

document.addEventListener('DOMContentLoaded', async () => {
  initEventListeners();
  
  // 初始加载
  const [status] = await Promise.all([
    loadStatus(),
    loadUpdatedUps(true),
    loadTrackingList(true),
    loadBlacklist(),
  ]);

  // 首次启动不自动扫描，用户可能需要先导入黑名单等数据
});
