/**
 * 宿主原型的静态服务：把 probe/ 页面、产品那份核心、产品宿主模块本身、public/rom 的
 * ROM 挂到同一个端口上。verify-host-browser.cjs 和 audio-drift.cjs 都要用，所以单独一个文件。
 *
 * 核心与宿主都直接发产品用的那份文件（`public/cores/`、`src/lib/nes/`）：原型工具测的
 * 就是出厂的代码，不另存副本，免得副本和产品各自演化。`/nes/` 这个前缀不能省 ——
 * 宿主里 worklet 是按 `new URL('./audio-processor.js', import.meta.url)` 相对自己取的。
 *
 * 独立跑：node agent-workspace/host-probe-server.cjs [端口]
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ROM_DIR = path.join(ROOT, 'public', 'rom');
const PROBE_DIR = path.join(__dirname, 'probe');
const CORE_DIR = path.join(ROOT, 'public', 'cores');
const NES_DIR = path.join(ROOT, 'src', 'lib', 'nes');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

function serve(res, root, rel) {
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream' });
  res.end(fs.readFileSync(p));
}

/** 返回 { server, base }；调用方用完自己 close() */
function startHostProbeServer(port) {
  const base = `http://localhost:${port}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    if (url.pathname.startsWith('/probe/')) return serve(res, PROBE_DIR, decodeURIComponent(url.pathname.slice(7)));
    if (url.pathname.startsWith('/core/')) return serve(res, CORE_DIR, decodeURIComponent(url.pathname.slice(6)));
    if (url.pathname.startsWith('/nes/')) return serve(res, NES_DIR, decodeURIComponent(url.pathname.slice(5)));
    const m = url.pathname.match(/^\/rom\/(.+)$/);
    if (m) return serve(res, ROM_DIR, decodeURIComponent(m[1]));
    res.writeHead(404); res.end('no');
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, base })));
}

module.exports = { startHostProbeServer, PROBE_DIR, CORE_DIR, ROM_DIR };

if (require.main === module) {
  const port = Number(process.argv[2]) || 7892;
  startHostProbeServer(port).then(({ base }) => console.log(`宿主原型服务在 ${base}`));
}
