/**
 * 作息提醒 Service Worker
 * 
 * 核心机制：
 * 1. 页面打开时前端通过 postMessage 同步提醒列表到 SW
 * 2. SW 内部每秒检查一次时间，到点弹系统通知
 * 3. 即使浏览器关掉、手机锁屏，SW 仍然在后台运行（系统调度允许时）
 * 4. 通知点击后打开 APP → 如果有关联的锁屏提醒则展示锁屏页面
 * 
 * 注意：Service Worker 可能在长时间不活跃后被系统终止，
 * 但会通过 Periodic Background Sync（若浏览器支持）或
 * 前端定期"唤醒"来保持活跃。
 */

const LS_KEY = "sleep_reminders_v1";
const FIRED_KEY = "sleep_fired_v1";
const SYNC_INTERVAL = 30000; // 每 30 秒向前端同步一次提醒数据

// ---------- 内存中的提醒数据 ----------
let reminders = [];
let checkTimer = null;
let lastMinute = ""; // 避免同一分钟重复触发

// ---------- 工具函数 ----------
function pad(n) { return n < 10 ? "0" + n : "" + n; }
function mins(t) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }

// ---------- 从存储读取提醒 ----------
async function loadReminders() {
  try {
    // SW 无法直接访问 localStorage，需要通过 clients 获取
    const allClients = await clients.matchAll({ type: "window" });
    if (allClients.length > 0) {
      // 有窗口打开：让前端同步过来
      allClients[0].postMessage({ type: "SYNC_REMINDERS" });
    }
    // 另外从 IndexedDB 读取备份（前端每次保存时也会写入）
    return readFromIDB();
  } catch (e) {
    return [];
  }
}

// ---------- IndexedDB 作为 SW 可读的数据桥 ----------
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("SleepReminderDB", 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("state")) {
        db.createObjectStore("state");
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function readFromIDB() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("state", "readonly");
      const store = tx.objectStore("state");
      const req = store.get("reminders");
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (e) {
    return [];
  }
}

async function writeToIDB(list) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      store.put(list, "reminders");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {
    // ignore
  }
}

async function readFired() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("state", "readonly");
      const store = tx.objectStore("state");
      const req = store.get("fired");
      req.onsuccess = () => resolve(req.result || {});
      req.onerror = () => resolve({});
    });
  } catch (e) {
    return {};
  }
}

async function writeFired(obj) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction("state", "readwrite");
      const store = tx.objectStore("state");
      store.put(obj, "fired");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (e) {
    // ignore
  }
}

// ---------- 核心：每秒检查时间，到点弹通知 ----------
async function checkAndFire() {
  if (!reminders || reminders.length === 0) return;

  const now = new Date();
  const key = pad(now.getHours()) + ":" + pad(now.getMinutes());
  if (key === lastMinute) return; // 同一分钟已检查过

  const hit = reminders.find((r) => r.on && r.time === key);
  if (!hit) {
    lastMinute = key;
    return;
  }

  // 检查今天是否已触发
  const today = now.toDateString();
  const fired = await readFired();
  if (fired[today] && fired[today][hit.id]) {
    lastMinute = key;
    return;
  }

  // 记录已触发
  fired[today] = fired[today] || {};
  fired[today][hit.id] = 1;
  await writeFired(fired);

  lastMinute = key;

  // 弹出系统通知
  const title = "🌙 作息提醒";
  const body = hit.label || "时间到了";
  const options = {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "sleep-reminder-" + hit.id,
    requireInteraction: hit.mode === "lock", // 锁屏类通知需手动划掉
    data: {
      reminderId: hit.id,
      mode: hit.mode,
      label: hit.label,
      time: hit.time,
    },
    actions:
      hit.mode === "lock"
        ? [{ action: "snooze", title: "稍后 10 分钟" }, { action: "open", title: "打开查看" }]
        : [{ action: "open", title: "打开查看" }],
    vibrate: hit.mode === "lock" ? [200, 100, 200, 100, 200] : [100, 50, 100],
  };

  try {
    await self.registration.showNotification(title, options);
  } catch (e) {
    // fallback: 无 icon
    try {
      await self.registration.showNotification(title, { body, requireInteraction: true });
    } catch (e2) {
      // ignore
    }
  }
}

// ---------- 启动定时检测 ----------
function startTimer() {
  if (checkTimer) clearInterval(checkTimer);
  lastMinute = ""; // 重置，让下次立即检查
  checkTimer = setInterval(checkAndFire, 1000); // 每秒检查
}

// ---------- 通知点击处理 ----------
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "snooze") {
    // 10 分钟后再弹
    const data = event.notification.data || {};
    setTimeout(async () => {
      await self.registration.showNotification("🌙 作息提醒", {
        body: "（暂停结束）" + (data.label || "该休息了"),
        icon: "/icon-192.png",
        tag: "sleep-reminder-snooze-" + data.reminderId,
        requireInteraction: true,
        data,
        vibrate: [200, 100, 200],
      });
    }, 10 * 60 * 1000);
    return;
  }

  // 打开 APP（如果有窗口则聚焦，否则新开）
  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window" });
      if (allClients.length > 0) {
        const client = allClients[0];
        await client.focus();
        // 通知前端触发锁屏
        const data = event.notification.data || {};
        client.postMessage({ type: "FIRE_LOCK", data });
      } else {
        await clients.openWindow("/");
      }
    })()
  );
});

// ---------- 消息处理 ----------
self.addEventListener("message", async (event) => {
  const msg = event.data;

  if (msg.type === "UPDATE_REMINDERS") {
    reminders = msg.reminders || [];
    await writeToIDB(reminders);
    startTimer();
  }

  if (msg.type === "UPDATE_FIRED") {
    await writeFired(msg.fired || {});
  }

  if (msg.type === "PING") {
    // 前端周期性 ping 保持 SW 活跃
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ type: "PONG" });
    }
  }

  if (msg.type === "SYNC_REMINDERS") {
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ type: "SYNC_REMINDERS" });
    }
  }
});

// ---------- 安装 ----------
self.addEventListener("install", (event) => {
  // 立即接管所有页面
  event.waitUntil(self.skipWaiting());
});

// ---------- 激活 ----------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // 从 IDB 恢复提醒数据并启动定时器
      reminders = await readFromIDB();
      if (reminders.length > 0) {
        startTimer();
      }
    })()
  );
});

// ---------- Periodic Background Sync（若浏览器支持）----------
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "sleep-reminder-check") {
    event.waitUntil(
      (async () => {
        await loadReminders();
        await checkAndFire();
      })()
    );
  }
});
