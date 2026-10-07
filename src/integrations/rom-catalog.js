/**
 * Astro 集成：构建时扫 ROM 目录，生成内置游戏清单 public/games.json
 *
 * 为什么要有这一步：浏览器不能列出服务器上的目录，
 * 「往 public/rom/ 丢一个 .nes 就该出现在游戏列表里」这件事，只能在构建时
 * 数一遍目录、把结果写成一份清单，前端再去 fetch 那份清单。
 *
 * 为什么做成 Astro 集成而不是 npm 的 prebuild 脚本：
 * 本仓库的 CI（.github/workflows/deploy.yml）是直接 `npx astro build`，
 * 不经过 npm 脚本；挂在构建流程里，任何调用方式（dev / build / npx / CI）
 * 都会刷新清单。对标 Astro 官方集成文档的 integration 形状
 * （{ name, hooks }，钩子表见 astro/dist/types/public/integrations.d.ts）。
 *
 * 同类做法：Astro Content Collections、Jekyll 的 _data —— 都是
 * 「构建时扫目录 → 生成数据文件 → 运行时只读数据」。
 *
 * 哈希用 src/lib/storage.js 里的同一个函数（直接 import，不复制一份实现）：
 * 存档是按 ROM 哈希存的，清单里的哈希必须和运行时算出来的完全一致，
 * 两处各写一遍早晚会对不上。
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeROMHash } from '../lib/storage.js';

/**
 * 扫 publicDir/rom，写出 publicDir/games.json。
 *
 * @param {string} publicDir - 绝对路径，Astro 的 public 目录
 * @returns {Promise<number>} 清单里有多少款
 */
export async function buildRomCatalog(publicDir) {
  const romDir = path.join(publicDir, 'rom');
  const files = await readdir(romDir, { withFileTypes: true })
    .then((dirents) =>
      // 只认 .nes（大小写都算）；URL 里保留文件名的原始大小写，
      // Windows 本地不分大小写，线上服务器分。
      dirents.filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.nes'))
        .map((d) => d.name),
    )
    // 没有 rom 目录 = 一款内置游戏都没有，这是正常状态，不是错误。
    .catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });

  const entries = [];
  for (const file of files) {
    const data = new Uint8Array(await readFile(path.join(romDir, file)));
    entries.push({
      id: computeROMHash(data),
      name: path.basename(file, path.extname(file)),
      url: `rom/${encodeURIComponent(file)}`,
      size: data.length,
    });
  }

  // 按显示名排序，菜单顺序跟着名字，不受磁盘读取顺序影响。
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  // 同一份 ROM 换名字放了两份，只留一条（排完序取第一个，结果稳定）。
  const seen = new Set();
  const games = entries.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true)));

  await writeFile(
    path.join(publicDir, 'games.json'),
    JSON.stringify(games, null, 2) + '\n',
    'utf8',
  );
  return games.length;
}

export function romCatalog() {
  return {
    name: 'rom-catalog',
    hooks: {
      'astro:config:setup': async ({ config, command, logger }) => {
        // preview 只是把 dist 起个服务器，不该在那时改工作区文件。
        if (command !== 'dev' && command !== 'build') return;
        const count = await buildRomCatalog(fileURLToPath(config.publicDir));
        logger.info(`内置游戏清单：${count} 款`);
      },
    },
  };
}
