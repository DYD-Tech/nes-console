/**
 * IndexedDB 存储模块
 *
 * 库里放三样东西：
 * - savestates：即时存档，按「ROM 哈希 + 槽位」存，内容是 RASTATE 字节串
 * - sram：电池存档（游戏自己写的进度），按「ROM 哈希」存一份镜像
 * - roms：用户自己加入的 ROM 本体，按「ROM 哈希」存
 *
 * 设计参考：
 * - 使用 ROM 的哈希值作为 Key，防止不同游戏冲突
 * - 支持 Slot 0-9 + AutoSave（自动存档槽）
 * - 自动保存：visibilitychange 到 hidden 时触发
 * - 持久化：navigator.storage.persist() 请求浏览器不要自动清理
 * - ROM 落盘对标 RetroArch 的 content playlist：游戏文件进了列表就该下次还在，
 *   而不是每次开机重新选一遍文件
 *
 * 存档两份的分工对标 RetroArch：`.state`（即时存档，含内存快照，玩家手按出来的）
 * 和 `.srm`（电池存档，游戏内部自己写的，真机关机重启后还在的东西）。
 * 即时存档里**已经包含**电池 RAM，所以读即时存档会连带把游戏进度回滚到那一刻 ——
 * 这是格式决定的，不是 bug，但落盘顺序有讲究：读档之后要把内存里最新的 SRAM
 * 镜像写回库里，否则下次开机看到的是上一次自动存档的进度。
 */

const DB_NAME = 'nes-console';
// v3：换成 wasm 核心之后存档格式是 RASTATE 字节串，和升 v3 之前存的那些 JSON 状态互不可读，
// 所以升级时直接重建 savestates（不写迁移：老档在新核心里没有意义）。
// 同一版本里新增 sram store。roms store 不变。
const DB_VERSION = 3;
const STORE_NAME = 'savestates';
const SRAM_STORE = 'sram';
const ROM_STORE = 'roms';

// 槽位定义
export const SLOTS = {
  AUTO: 'auto',      // 自动存档槽
  SLOT_0: 'slot_0',
  SLOT_1: 'slot_1',
  SLOT_2: 'slot_2',
  SLOT_3: 'slot_3',
  SLOT_4: 'slot_4',
  SLOT_5: 'slot_5',
  SLOT_6: 'slot_6',
  SLOT_7: 'slot_7',
  SLOT_8: 'slot_8',
  SLOT_9: 'slot_9',
};

export const SLOT_LABELS = {
  [SLOTS.AUTO]: '自动存档',
  [SLOTS.SLOT_0]: '槽位 0',
  [SLOTS.SLOT_1]: '槽位 1',
  [SLOTS.SLOT_2]: '槽位 2',
  [SLOTS.SLOT_3]: '槽位 3',
  [SLOTS.SLOT_4]: '槽位 4',
  [SLOTS.SLOT_5]: '槽位 5',
  [SLOTS.SLOT_6]: '槽位 6',
  [SLOTS.SLOT_7]: '槽位 7',
  [SLOTS.SLOT_8]: '槽位 8',
  [SLOTS.SLOT_9]: '槽位 9',
};

/**
 * 计算 ROM 的哈希值（同步函数）
 * 使用 FNV-1a 哈希算法，避免 crypto.subtle 在非 HTTPS 环境下不可用的问题
 * @param {Uint8Array} data - ROM 数据
 * @returns {string} 哈希值（十六进制字符串）
 */
export function computeROMHash(data) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + '_' + data.length.toString(16);
}

/**
 * 打开 IndexedDB 数据库
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // 老库里的 savestates 是另一种格式（JSON 状态），现在的核心读不了，也没有能读它的东西：
      // 删掉重建。roms / sram 各自的创建互不影响。
      if (db.objectStoreNames.contains(STORE_NAME)) db.deleteObjectStore(STORE_NAME);
      db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(SRAM_STORE)) {
        db.createObjectStore(SRAM_STORE, { keyPath: 'romHash' });
      }
      if (!db.objectStoreNames.contains(ROM_STORE)) {
        db.createObjectStore(ROM_STORE, { keyPath: 'hash' });
      }
    };
  });
}

/**
 * 保存即时存档到指定槽位
 * @param {string} romHash - ROM 哈希值
 * @param {string} slot - 槽位 ID
 * @param {Uint8Array} data - RASTATE 字节串（见 src/lib/nes/rastate.js）
 * @returns {Promise<void>}
 */
export async function saveState(romHash, slot, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    const entry = {
      key: `${romHash}_${slot}`,
      romHash,
      slot,
      data,
      bytes: data.length,
      timestamp: Date.now(),
    };
    
    const request = store.put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * 从指定槽位加载即时存档
 * @param {string} romHash - ROM 哈希值
 * @param {string} slot - 槽位 ID
 * @returns {Promise<Uint8Array|null>} 存档字节串，如果不存在返回 null
 */
export async function loadState(romHash, slot) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    const request = store.get(`${romHash}_${slot}`);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const result = request.result;
      resolve(result ? result.data : null);
    };
  });
}

/**
 * 删除指定槽位的存档
 * @param {string} romHash - ROM 哈希值
 * @param {string} slot - 槽位 ID
 * @returns {Promise<void>}
 */
export async function deleteState(romHash, slot) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    const request = store.delete(`${romHash}_${slot}`);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * 获取指定 ROM 的所有存档槽位信息（返回的是元数据，不含存档字节本体）
 *
 * 实现上是全表读出来再按 romHash 过滤：一份即时存档 14~22 KB、最多 11 个槽位，
 * 几百 KB 的量不值得为它建索引键（改主键格式要动老数据）。
 * @param {string} romHash - ROM 哈希值
 * @returns {Promise<Array<{slot: string, timestamp: number, key: string, bytes: number}>>}
 */
export async function getSaveStates(romHash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const results = request.result.filter(entry => entry.romHash === romHash);
      resolve(results.map(entry => ({
        slot: entry.slot,
        timestamp: entry.timestamp,
        key: entry.key,
        bytes: entry.bytes,
      })));
    };
  });
}

// ==================== 电池存档 ====================

/**
 * 写入电池存档（.srm 那段裸字节）。主键是 ROM 哈希，所以每款游戏只有一份 ——
 * 真机上电池存档就是卡带里那一块，没有槽位概念。
 *
 * @param {string} romHash
 * @param {Uint8Array} data
 * @returns {Promise<void>}
 */
export async function saveSRAM(romHash, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SRAM_STORE, 'readwrite');
    const request = tx.objectStore(SRAM_STORE).put({
      romHash,
      data,
      bytes: data.length,
      timestamp: Date.now(),
    });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * 读取电池存档
 * @param {string} romHash
 * @returns {Promise<Uint8Array|null>}
 */
export async function loadSRAM(romHash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SRAM_STORE, 'readonly');
    const request = tx.objectStore(SRAM_STORE).get(romHash);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ? request.result.data : null);
  });
}

/**
 * 删除电池存档（换 ROM 重开这类「进度该清零」的场合用）
 * @param {string} romHash
 * @returns {Promise<void>}
 */
export async function deleteSRAM(romHash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SRAM_STORE, 'readwrite');
    const request = tx.objectStore(SRAM_STORE).delete(romHash);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// ==================== 用户 ROM ====================

/**
 * 存一份用户 ROM。主键是内容哈希，同一份 ROM 反复写入只会覆盖自己。
 *
 * @param {{hash: string, name: string, data: Uint8Array}} rom
 * @returns {Promise<void>}
 */
export async function saveROM({ hash, name, data }) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROM_STORE, 'readwrite');
    const request = tx.objectStore(ROM_STORE).put({
      hash,
      name,
      size: data.length,
      data,
      addedAt: Date.now(),
    });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * 列出所有已保存的用户 ROM（含 data 本体）。
 *
 * 这里不做「只返回元数据」：启动时恢复列表本来就要把 ROM 交给模拟器用，
 * 分开读反而多一轮。NES ROM 一份几十 KB 到 1MB，整库读进内存是现有
 * 「拖文件进列表」本来就会有的占用，没有变多。
 *
 * @returns {Promise<Array<{hash: string, name: string, size: number, data: Uint8Array, addedAt: number}>>}
 */
export async function listROMs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROM_STORE, 'readonly');
    const request = tx.objectStore(ROM_STORE).getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * 删除一个用户 ROM
 * @param {string} hash - ROM 哈希值
 * @returns {Promise<void>}
 */
export async function deleteROM(hash) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROM_STORE, 'readwrite');
    const request = tx.objectStore(ROM_STORE).delete(hash);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

/**
 * 请求持久化存储权限
 * @returns {Promise<boolean>} 是否成功
 */
export async function requestPersistence() {
  if (navigator.storage && navigator.storage.persist) {
    return await navigator.storage.persist();
  }
  return false;
}
