/**
 * 本地静态服务器：把 web/ 原样挂到 http://localhost:7890/nes-console/。
 *
 * 为什么要有它：站点本身不需要构建，任何静态服务器都能跑（README「快速开始」）。
 * 这里只是给开发和回归测试一个**零依赖**、地址固定的入口 ——
 * 浏览器测试脚本全部打 http://localhost:7890/nes-console/，
 * 挂在 /nes-console/ 下面是为了和 GitHub Pages 上的线上地址同一种路径形状，
 * 页面里的相对路径在子目录下有没有写错，本地就能测出来。
 *
 * 只用 Node 自带的 http / fs，不引新包（对标 Node 官方文档 http.createServer 的最小静态服务写法）。
 *
 *   node scripts/serve.cjs            默认端口 7890
 *   PORT=8080 node scripts/serve.cjs  换端口
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'web');
const PREFIX = '/nes-console/';
const PORT = Number(process.env.PORT) || 7890;

// 只列站点里真有的几种文件。wasm 必须是 application/wasm，
// 否则浏览器的 WebAssembly.instantiateStreaming 会拒收（WebAssembly Web API 规范 §3 要求的 MIME）。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.nes': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === PREFIX.slice(0, -1)) {
    res.writeHead(302, { Location: PREFIX });
    return res.end();
  }
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  // ROM 文件名是中文，地址里是百分号编码，要先解码才能对上磁盘上的文件名。
  let rel = decodeURIComponent(url.pathname.slice(PREFIX.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  // 挡住 ../ 跳出 web/ 目录
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 开发时改完刷新就生效，不让浏览器拿旧缓存
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`web/ 已挂到 http://localhost:${PORT}${PREFIX}`);
});
