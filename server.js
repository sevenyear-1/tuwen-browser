/**
 * server.js — 图文浏览器 后端唯一入口
 *
 * 本地离线图文文章编辑与浏览系统
 *   - 监听 127.0.0.1:8080（仅本机访问，禁止外网/局域网）
 *   - 前端纯浏览器网页，无桌面客户端
 *   - 存储层由 lib/storage.js 提供（文件系统实现，未来可无缝替换 SQLite）
 *   - 零第三方 npm 依赖，绿色免安装，整个文件夹复制即用
 *
 * 启动：node server.js
 *   带 --open 参数时，服务启动成功后会自动打开浏览器（配合「启动图文浏览器.bat」使用）
 * 访问：http://127.0.0.1:8080/index.html
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { exec } = require('child_process');
const storage = require('./lib/storage');

// 启动成功后自动打开浏览器（node server.js --open 或环境变量 OPEN_BROWSER=1）
const OPEN_BROWSER = process.argv.includes('--open') || process.env.OPEN_BROWSER === '1';

const HOST = '127.0.0.1';
const PORT = 8080;
const PORT_SCAN_MAX = 10; // 端口被占用时的向后尝试范围

const WEBUI_DIR = path.join(storage.ROOT, 'webui');

// 上传限制：仅允许图片 + MP4；流式上传内存占用恒定（几十 KB）；
// 单文件最大 4GB，超限返回 413（前端也会在选文件时提前拦截提醒）
const MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024; // 4GB
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.mp4']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/* ================================================================
 * 工具函数
 * ================================================================ */

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ok(res, data) {
  sendJSON(res, 200, Object.assign({ ok: true }, data));
}

function fail(res, status, msg) {
  sendJSON(res, status, { ok: false, error: msg });
}

/** 读取请求体（含大小上限，防止内存耗尽） */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('请求体过大'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** 解析 JSON 请求体（保存文章，含可能内嵌的 base64 图片，上限 50MB） */
async function readJSON(req) {
  const buf = await readBody(req, 50 * 1024 * 1024);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw Object.assign(new Error('JSON 解析失败'), { code: 400 });
  }
}

/** 解析 multipart/form-data（手写实现，支持二进制文件数据） */
function parseMultipart(body, boundary) {
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf(delim, pos);
    if (start === -1) break;
    let cursor = start + delim.length;
    // 结束标记 --
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    // 跳过 CRLF
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) break;
    const headerStr = body.slice(cursor, headerEnd).toString('utf8');
    const nextBoundary = body.indexOf(delim, headerEnd + 4);
    if (nextBoundary === -1) break;
    // 数据区末尾去掉 CRLF（若有）
    let data = body.slice(headerEnd + 4, nextBoundary);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.slice(0, -2);
    }
    parts.push({ headers: headerStr, data });
    pos = nextBoundary;
  }
  return parts;
}

/** 从 multipart 部分提取字段信息 */
function extractField(part) {
  const nameMatch = /name="([^"]*)"/.exec(part.headers);
  const fileMatch = /filename="([^"]*)"/.exec(part.headers);
  const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(part.headers);
  return {
    name: nameMatch ? nameMatch[1] : '',
    filename: fileMatch ? fileMatch[1] : null,
    mime: typeMatch ? typeMatch[1].trim() : '',
  };
}

/** 生成安全的媒体文件名：img_YYYYMMDD_HHmmss_xxx.ext */
function safeMediaName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  const rand = Math.random().toString(36).slice(2, 6);
  const prefix = ext === '.mp4' ? 'video' : 'img';
  return `${prefix}_${stamp}_${rand}${ext}`;
}

/**
 * 流式 multipart 上传：边接收边写入磁盘，内存占用恒定（约几十 KB）。
 * 支持超大文件（上限 MAX_UPLOAD_SIZE = 1GB），超过则返回 413 并清理半截文件。
 * @param {http.IncomingMessage} req
 * @param {string} articleId
 * @param {string} boundary
 * @returns {Promise<{name:string, ext:string}>}
 */
function handleStreamUpload(req, articleId, boundary) {
  return new Promise((resolve, reject) => {
    const delim = Buffer.from('--' + boundary);
    let buffer = Buffer.alloc(0);
    let phase = 'header';            // header → file → header → ... → done
    let fileStream = null;
    let fileName = null;
    let ext = null;
    let fileSize = 0;
    let foundFile = false;
    let settled = false;

    const cleanup = () => {
      if (fileStream) {
        // 保留 'error' 吞错监听；异步排队的写入回调可能在 destroy 后触发 error，
        // 必须有人接住，否则触发未捕获异常导致进程崩溃
        try { fileStream.destroy(); } catch (e) { /* ignore */ }
        fileStream = null;
      }
      if (fileName) {
        const fp = path.join(storage.ARTICLES_DIR, articleId, 'media', fileName);
        fs.unlink(fp, () => { /* ignore */ });
      }
    };

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    /** 解析 part 头，合法文件则打开写入流 */
    const parseHeadersAndStartFile = (headerText) => {
      const dispMatch = /Content-Disposition:\s*form-data;([^\r\n]+)/i.exec(headerText);
      const head = dispMatch ? dispMatch[1] : headerText;
      const fileMatch = /filename="([^"]*)"/.exec(head);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      const mime = typeMatch ? typeMatch[1].trim() : '';
      if (!fileMatch) return true; // 非文件 part（普通字段），忽略
      ext = path.extname(fileMatch[1] || '').toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        settle(reject, Object.assign(new Error('仅允许上传图片或 MP4 视频文件'), { status: 400 }));
        return false;
      }
      if (ext === '.mp4' && mime && !/^video\//i.test(mime)) {
        settle(reject, Object.assign(new Error('文件类型与扩展名不符'), { status: 400 }));
        return false;
      }
      if (IMAGE_EXT.has(ext) && mime && !/^image\//i.test(mime)) {
        settle(reject, Object.assign(new Error('文件类型与扩展名不符'), { status: 400 }));
        return false;
      }
      fileName = safeMediaName(ext);
      const dir = path.join(storage.ARTICLES_DIR, articleId, 'media');
      fs.mkdirSync(dir, { recursive: true });
      fileStream = fs.createWriteStream(path.join(dir, fileName));
      // 区分两类流错误：
      //  1) ERR_STREAM_DESTROYED：超限/清理时主动 destroy 的排队写入回调，忽略
      //  2) 其他（如磁盘写满 ENOSPC）：真实失败 → 清理 + 返回错误
      fileStream.on('error', (e) => {
        if (!e || e.code === 'ERR_STREAM_DESTROYED') return;
        cleanup();
        settle(reject, Object.assign(new Error('写入磁盘失败（磁盘空间不足？）'), { status: 500 }));
      });
      foundFile = true;
      return true;
    };

    const writeToFile = (data) => {
      if (!data.length || !fileStream || fileStream.destroyed) return true;
      fileSize += data.length;
      if (fileSize > MAX_UPLOAD_SIZE) {
        settle(reject, Object.assign(new Error('文件过大（最大支持 4GB）'), { code: 413 }));
        cleanup();
        return false;
      }
      fileStream.write(data);
      return true;
    };

    const finish = () => {
      if (fileStream) { try { fileStream.end(); } catch (e) { /* ignore */ } }
      if (foundFile && fileName) {
        settle(resolve, { name: fileName, ext });
      } else {
        settle(reject, Object.assign(new Error('未收到文件'), { status: 400 }));
      }
    };

    const process = () => {
      while (!settled) {
        if (phase === 'done') { finish(); return; }

        if (phase === 'header') {
          const bIdx = buffer.indexOf(delim);
          if (bIdx === -1) {
            // 尚未到达 boundary：只保留末尾可能的部分边界
            if (buffer.length > delim.length + 4096) buffer = buffer.slice(-(delim.length + 4096));
            return;
          }
          const afterB = bIdx + delim.length;
          // 结束标记 --boundary--
          if (buffer[afterB] === 0x2d && buffer[afterB + 1] === 0x2d) {
            phase = 'done';
            buffer = Buffer.alloc(0);
            continue;
          }
          let pos = afterB;
          if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;
          const heIdx = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
          if (heIdx === -1) {
            buffer = buffer.slice(pos); // headers 不完整，继续等
            return;
          }
          const headerText = buffer.slice(pos, heIdx).toString('utf8');
          if (!parseHeadersAndStartFile(headerText)) { buffer = Buffer.alloc(0); return; }
          buffer = buffer.slice(heIdx + 4);
          phase = 'file';
          continue;
        }

        if (phase === 'file') {
          const bIdx = buffer.indexOf(delim);
          if (bIdx === -1) {
            // 无边界：可写部分写出，保留尾部可能的部分边界前缀
            const keep = Math.min(buffer.length, delim.length + 4);
            const writeLen = buffer.length - keep;
            if (writeLen > 0) {
              if (!writeToFile(buffer.slice(0, writeLen))) { buffer = Buffer.alloc(0); return; }
              buffer = buffer.slice(writeLen);
            }
            return;
          }
          let dataEnd = bIdx;
          if (dataEnd >= 2 && buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) dataEnd -= 2;
          if (dataEnd > 0) {
            if (!writeToFile(buffer.slice(0, dataEnd))) { buffer = Buffer.alloc(0); return; }
          }
          if (fileStream) { fileStream.end(); fileStream = null; }
          buffer = buffer.slice(bIdx + delim.length);
          phase = 'header';
          continue;
        }
      }
    };

    req.on('data', (chunk) => {
      if (settled) { req.pause(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      try { process(); } catch (e) { cleanup(); settle(reject, e); }
    });
    req.on('end', () => {
      if (settled) return;
      try {
        if (phase === 'file' && fileStream) {
          // 最后一部分（无结束 boundary）
          const bIdx = buffer.indexOf(delim);
          let dataEnd = bIdx === -1 ? buffer.length : bIdx;
          if (dataEnd >= 2 && buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) dataEnd -= 2;
          if (dataEnd > 0) {
            if (!writeToFile(buffer.slice(0, dataEnd))) { cleanup(); return; }
          }
          fileStream.end();
          fileStream = null;
        }
        finish();
      } catch (e) { cleanup(); settle(reject, e); }
    });
    req.on('error', (e) => { cleanup(); settle(reject, e); });
  });
}

/** 调用系统默认浏览器打开本地文件 */
function openInBrowser(filePath) {
  let cmd;
  if (process.platform === 'win32') {
    cmd = `start "" "${filePath}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${filePath}"`;
  } else {
    cmd = `xdg-open "${filePath}"`;
  }
  exec(cmd, (err) => {
    if (err) console.error('[openlocal] 打开失败:', err.message);
  });
}

/** 校验静态资源相对路径（禁止 .. 穿越、禁止绝对路径） */
function safeRelativePath(rel) {
  if (!rel || rel.includes('\0')) return null;
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '..' || p === '' || p === '.') return null;
  }
  return parts.join('/');
}

/* ================================================================
 * 路由处理
 * ================================================================ */

/** 处理 API / 页面请求 */
async function handleRequest(req, res, url) {
  const method = req.method;
  const pathname = decodeURIComponent(url.pathname);

  // ---------- 前端页面（白名单） ----------
  if (method === 'GET' && ['/index.html', '/editor.html', '/view.html', '/favicon.ico'].includes(pathname)) {
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    const file = path.join(WEBUI_DIR, path.basename(pathname));
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // 防止浏览器缓存页面，导致代码改动不生效
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(data);
    } catch (e) {
      fail(res, 404, '页面不存在');
    }
    return;
  }

  // ---------- /vendor/*（编辑器本地依赖，如 Quill） ----------
  if (method === 'GET' && pathname.startsWith('/vendor/')) {
    const rel = safeRelativePath(pathname.slice('/vendor/'.length));
    if (!rel) return fail(res, 400, '无效路径');
    const file = path.join(WEBUI_DIR, 'vendor', rel);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return fail(res, 404, '资源不存在');
      const ext = path.extname(file).toLowerCase();
      const mime =
        ext === '.css' ? 'text/css; charset=utf-8' :
        ext === '.js' ? 'application/javascript; charset=utf-8' :
        'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      fail(res, 404, '资源不存在');
    }
    return;
  }

  // ---------- 主页根路径 ----------
  if (method === 'GET' && pathname === '/') {
    res.writeHead(302, {
      Location: '/index.html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end();
    return;
  }

  // ---------- /api/article/list（支持 ?page=&pageSize=&keyword= 搜索分页） ----------
  if (method === 'GET' && pathname === '/api/article/list') {
    const q = url.searchParams;
    const result = await storage.listArticles({
      page: q.get('page') || 1,
      pageSize: q.get('pageSize') || 20,
      keyword: q.get('keyword') || '',
    });
    ok(res, result);
    return;
  }

  // ---------- /api/article/create ----------
  if (method === 'POST' && pathname === '/api/article/create') {
    const meta = await storage.createArticle();
    ok(res, { id: meta.id });
    return;
  }

  // ---------- /api/article/delete/:id ----------
  let m = /^\/api\/article\/delete\/(article_\d+)$/.exec(pathname);
  if (method === 'POST' && m) {
    await storage.deleteArticle(m[1]);
    ok(res, { id: m[1] });
    return;
  }

  // ---------- /api/article/save/:id ----------
  m = /^\/api\/article\/save\/(article_\d+)$/.exec(pathname);
  if (method === 'POST' && m) {
    const data = await readJSON(req);
    const meta = await storage.saveArticle(m[1], {
      title: data.title,
      summary: data.summary,
      content: data.content,
    });
    ok(res, { id: meta.id, thumbFile: meta.thumbFile });
    return;
  }

  // ---------- /api/article/upload/:id（流式上传，边传边写） ----------
  m = /^\/api\/article\/upload\/(article_\d+)$/.exec(pathname);
  if (method === 'POST' && m) {
    const id = m[1];
    if (!storage.isValidId(id)) return fail(res, 400, '非法文章 ID');
    const ctype = req.headers['content-type'] || '';
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
    if (!bm) return fail(res, 400, '缺少 multipart boundary');
    try {
      const result = await handleStreamUpload(req, id, bm[1] || bm[2]);
      ok(res, { url: 'media/' + result.name, name: result.name, ext: result.ext });
    } catch (e) {
      if (e && e.code === 413) return fail(res, 413, e.message || '文件过大');
      if (e && e.status) return fail(res, e.status, e.message);
      console.error('[upload] 上传失败:', e);
      fail(res, 500, '上传失败');
    }
    return;
  }

  // ---------- /api/article/:id（获取单篇） ----------
  m = /^\/api\/article\/(article_\d+)$/.exec(pathname);
  if (method === 'GET' && m) {
    try {
      const article = await storage.getArticle(m[1]);
      ok(res, article);
    } catch (e) {
      fail(res, 404, e.message || '文章不存在');
    }
    return;
  }

  // ---------- /api/article/openlocal/:id ----------
  m = /^\/api\/article\/openlocal\/(article_\d+)$/.exec(pathname);
  if (method === 'GET' && m) {
    const id = m[1];
    const file = path.join(storage.ARTICLES_DIR, id, 'content.html');
    try {
      await fsp.access(file, fs.constants.F_OK);
    } catch (e) {
      return fail(res, 404, '离线文件不存在');
    }
    openInBrowser(file);
    ok(res, { id });
    return;
  }

  // ---------- /static/*（文章静态资源预览） ----------
  if (method === 'GET' && pathname.startsWith('/static/')) {
    const rest = pathname.slice('/static/'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return fail(res, 400, '无效的静态资源路径');
    const id = rest.slice(0, slashIdx);
    const rel = safeRelativePath(rest.slice(slashIdx + 1));
    if (!storage.isValidId(id) || !rel) return fail(res, 400, '无效的静态资源路径');

    const file = path.join(storage.ARTICLES_DIR, id, rel);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return fail(res, 404, '资源不存在');
      const ext = path.extname(file).toLowerCase();
      let mime = 'application/octet-stream';
      if (IMAGE_EXT.has(ext)) {
        mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext];
      } else if (ext === '.mp4') {
        mime = 'video/mp4';
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      fail(res, 404, '资源不存在');
    }
    return;
  }

  fail(res, 404, '接口不存在: ' + method + ' ' + pathname);
}

/* ================================================================
 * 服务启动
 * ================================================================ */

async function start() {
  await storage.ensureDirs();
  console.log('📁 数据目录:', storage.DATA_DIR);
  console.log('✅ 目录结构就绪');

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://' + HOST);
    } catch (e) {
      return fail(res, 400, '无效请求');
    }
    handleRequest(req, res, url).catch((err) => {
      const code = err && err.code;
      if (code === 413) return fail(res, 413, '文件过大（超过 200MB）');
      if (code === 400) return fail(res, 400, err.message);
      console.error('[server] 处理请求出错:', err);
      fail(res, 500, '服务器内部错误');
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️  端口 ${PORT} 已被占用，正在尝试向后查找可用端口...`);
      return;
    }
    console.error('服务启动失败:', err);
    process.exit(1);
  });

  // 端口占用时向后尝试 PORT_SCAN_MAX 个端口
  const tryListen = (port) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port < PORT + PORT_SCAN_MAX) {
        tryListen(port + 1);
      } else {
        console.error('服务启动失败:', err.message);
        process.exit(1);
      }
    });
    server.listen(port, HOST, () => {
      console.log('');
      console.log('┌──────────────────────────────────────────────┐');
      console.log('│        📖  图文浏览器  已启动                │');
      console.log('└──────────────────────────────────────────────┘');
      console.log(`  🔗 访问地址: http://${HOST}:${port}/index.html`);
      console.log('  ⏹  关闭服务: Ctrl + C');
      console.log('');
      console.log('  💡 离线阅读: 直接双击文章目录中的 content.html');
      console.log('');
      // --open 模式：稍候自动打开浏览器（等待服务完全就绪）
      if (OPEN_BROWSER) {
        setTimeout(() => openInBrowser(`http://${HOST}:${port}/index.html`), 600);
      }
    });
  };
  tryListen(PORT);
}

start();
