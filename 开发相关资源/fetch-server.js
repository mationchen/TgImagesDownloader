/**
 * 图片链接提取器 —— 本机取页服务（方式 B 的通道）
 *
 * 为什么需要它：
 *   浏览器出于同源策略，不允许网页直接 fetch 别的站点（对方不返回 CORS 头），
 *   而公共 CORS 代理（allorigins / codetabs / corsproxy.io）到 2026-10 基本都已
 *   失效或要付费 key。所以这里在本机起一个极小的 HTTP 服务：
 *       浏览器 --(http://127.0.0.1:8787/?url=目标)--> 本服务 --(curl 走本机代理)--> 目标站
 *   返回时补上 `Access-Control-Allow-Origin: *`，于是页面就能正常读取源码。
 *
 * 用法：双击同目录的「启动取页服务.cmd」，或直接 `node fetch-server.js`
 *      端口默认 8787；用环境变量 PORT / HTTP_PROXY 可覆盖。
 * 停止：在那个窗口按 Ctrl+C，或直接关掉窗口。
 *
 * 依赖：Node.js（项目本身就要装）+ 系统自带的 curl.exe。
 */

const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7897';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Cache-Control': 'no-store',
};

/** 用 curl 抓一次；成功返回 {ok:true, body:Buffer}，失败返回 {ok:false, error} */
function fetchVia(target, useProxy) {
  return new Promise(resolve => {
    const tmp = path.join(
      os.tmpdir(),
      'relay_' + Date.now() + '_' + Math.random().toString(16).slice(2) + '.html',
    );
    const args = [
      '-sS',
      '-L',
      '--connect-timeout',
      '8',
      '--max-time',
      '45',
      '--compressed',
      '-A',
      UA,
      '-o',
      tmp,
    ];
    if (useProxy) args.push('-x', PROXY);
    args.push(target);

    execFile(
      'curl.exe',
      args,
      { windowsHide: true, maxBuffer: 1 << 24 },
      (err, stdout, stderr) => {
        let body = null;
        try {
          if (fs.existsSync(tmp)) {
            body = fs.readFileSync(tmp);
            fs.unlinkSync(tmp);
          }
        } catch (e) {
          body = null;
        }
        if (body && body.length > 0) {
          resolve({ ok: true, body, via: useProxy ? 'proxy' : 'direct' });
          return;
        }
        const msg = (stderr || (err && err.message) || 'fetch failed').toString();
        resolve({ ok: false, error: msg.replace(/\s+/g, ' ').slice(0, 400) });
      },
    );
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  let target = '';
  try {
    target = new URL(req.url, 'http://127.0.0.1').searchParams.get('url') || '';
  } catch (e) {
    target = '';
  }

  // 无 url 参数 = 健康检查，页面用它显示「服务已运行」
  if (!target) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end('ok  image-link-extractor relay  port=' + PORT + '  proxy=' + PROXY);
    return;
  }

  if (!/^https?:\/\//i.test(target)) {
    res.writeHead(400, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end('bad url');
    return;
  }

  console.log('[relay] GET ' + target + '  (via proxy)');
  // 先走本机代理；代理没开时自动退回直连
  let r = await fetchVia(target, true);
  if (!r.ok) {
    console.log('[relay] proxy failed, retry direct: ' + r.error);
    r = await fetchVia(target, false);
  }

  if (!r.ok) {
    console.log('[relay] FAILED ' + r.error);
    res.writeHead(502, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end('fetch failed: ' + r.error);
    return;
  }

  console.log('[relay] OK ' + r.body.length + ' bytes (' + r.via + ')');
  res.writeHead(
    200,
    Object.assign(
      {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': r.body.length,
      },
      CORS,
    ),
  );
  res.end(r.body);
});

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[relay] port ' + PORT + ' is already in use - is it already running?');
  } else {
    console.error('[relay] ' + (err && err.message));
  }
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[relay] listening on http://127.0.0.1:' + PORT);
  console.log('[relay] upstream proxy: ' + PROXY + '   (env HTTP_PROXY to change)');
  console.log('[relay] health check:  http://127.0.0.1:' + PORT + '/');
  console.log('[relay] press Ctrl+C to stop');
});
