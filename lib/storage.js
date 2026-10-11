/**
 * lib/storage.js — 存储层（文件系统实现）
 *
 * 本模块是「图文浏览器」的存储层，与业务逻辑完全解耦。
 * 对外暴露统一的异步接口；未来切换 SQLite 数据库时，
 * 只需替换本模块内部实现（保持接口签名不变），
 * 无需改动 server.js 与任何前端代码。
 *
 * 当前实现：文件夹 + JSON + HTML 文件存储
 *   data/articles/{id}/meta.json    文章元数据
 *   data/articles/{id}/content.html 最终成品静态文章（可离线双击打开）
 *   data/articles/{id}/media/       本篇所有图片、视频、GIF
 *
 * 约束：
 *   - 全部路径基于项目根目录（相对路径逻辑），禁止绝对磁盘路径
 *   - 文章 ID 采用 article_XXXX 递增格式，删除后不复用
 *   - 所有用户数据 100% 位于 data/ 目录
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = __dirname.replace(/[\\/]lib$/, ''); // 项目根目录（server.js 所在目录）
const DATA_DIR = path.join(ROOT, 'data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');

const ID_PREFIX = 'article_';
const SEQ_FILE = path.join(DATA_DIR, '.seq'); // 持久化自增序号，保证删除后不复用

/** 校验文章 ID 格式，防止路径穿越 */
function isValidId(id) {
  return typeof id === 'string' && /^article_\d+$/.test(id);
}

/** 返回文章目录绝对路径（仅在校验通过后调用） */
function articleDir(id) {
  return path.join(ARTICLES_DIR, id);
}

/** 文章 ID 转为目录名（等价校验） */
function idToDirName(id) {
  if (!isValidId(id)) throw new Error('非法文章 ID: ' + id);
  return id;
}

/** HTML 转义（用于把用户标题安全嵌入离线页面 title） */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 组装可离线打开的完整静态 HTML */
function buildContentHtml(title, content) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    max-width: 860px; margin: 0 auto; padding: 32px 20px 64px;
    color: #333; line-height: 1.8; background: #fff;
  }
  img { max-width: 100%; height: auto; }
  video { max-width: 100%; height: auto; display: block; margin: 8px 0; }
  h1, h2, h3, h4 { line-height: 1.4; margin: 1.2em 0 0.6em; }
  blockquote { border-left: 4px solid #ddd; margin: 12px 0; padding: 4px 14px; color: #666; background: #fafafa; }
  pre { background: #f6f8fa; padding: 12px 14px; overflow-x: auto; border-radius: 6px; }
  code { background: #f6f8fa; padding: 2px 5px; border-radius: 4px; font-size: 0.92em; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 12px 0; }
  td, th { border: 1px solid #ddd; padding: 6px 12px; }
  a { color: #2b6cb0; }
  .ql-align-center { text-align: center; }
  .ql-align-right { text-align: right; }
  .ql-align-justify { text-align: justify; }
</style>
</head>
<body>
${content || ''}
</body>
</html>
`;
}

/** 从正文 HTML 中提取第一张本地图片的相对路径（用于缩略图），无则返回 null */
function extractFirstImage(content) {
  if (!content) return null;
  const m = content.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!m) return null;
  let src = m[1].trim();
  if (!src) return null;
  // 外部链接 / data URI / blob 一律不作为缩略图
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) return null;
  // 去掉可能的前导 ./
  src = src.replace(/^\.\//, '');
  // 安全校验：不允许任何 .. 路径段
  if (src.includes('..') || src.includes('\\') || src.startsWith('/')) return null;
  const ext = path.extname(src).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return null;
  return src;
}

/**
 * 提取正文中的所有媒体资源（图片 / GIF / 视频），按出现顺序，去重，最多 5 个。
 * 返回 [{ type: 'image'|'video', format?: 'gif', src: 相对路径或外链 }]
 *   - image 项若扩展名为 .gif 则带 format='gif'（用于主页角标提示动图）
 *   用于主页横排缩略图。
 */
function extractMedia(content) {
  if (!content) return [];
  const out = [];
  const seen = new Set();
  const re = /<(img|video)[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(content))) {
    let src = (m[2] || '').trim();
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue;
    src = src.replace(/^\.\//, '');
    if (src.includes('..') || src.includes('\\')) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    const tagType = m[1];
    if (tagType === 'video') {
      out.push({ type: 'video', src });
    } else {
      const isGif = /\.gif(\?|$|#)/i.test(src);
      out.push({ type: 'image', format: isGif ? 'gif' : 'image', src });
    }
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * 提取正文中所有【本地】媒体引用（图片 + 视频），不限数量、不做前 5 截断。
 * 与 extractMedia（仅取前 5 个用于缩略图）不同，本函数用于「孤儿媒体清理」判断，
 * 必须覆盖正文中出现的每一个本地媒体，避免误删第 6 张及以后的图片。
 * 仅返回相对路径（如 media/xxx.jpg）；外链 / data: / blob: 不计入；去除查询串与锚点。
 */
function collectAllMediaRefs(content) {
  const refs = new Set();
  if (!content) return refs;
  const re = /<(img|video)[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(content))) {
    let src = (m[2] || '').trim();
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) continue;
    src = src.replace(/^\.\//, '');
    src = src.split('?')[0].split('#')[0]; // 去除查询串 / 锚点，统一与落盘文件名比较
    if (src.includes('..') || src.includes('\\') || /^(https?:)/i.test(src)) continue;
    refs.add(src);
  }
  return refs;
}

/**
 * 清理文章 media 目录中「正文未引用」的孤儿文件。
 * 用于：工具栏上传图片/视频后，用户又在编辑器里删掉（已/未保存），导致 media 目录残留无用文件。
 * 仅删除当前文章 media 目录下的普通文件；referenced 集合中命中的文件保留。
 * @param {string} dir 文章目录绝对路径
 * @param {Set<string>} referenced 正文引用的本地媒体相对路径集合
 */
async function cleanupOrphanMedia(dir, referenced) {
  const mediaDir = path.join(dir, 'media');
  let files = [];
  try {
    files = await fsp.readdir(mediaDir);
  } catch (e) {
    return; // 无 media 目录则无需清理
  }
  for (const f of files) {
    const full = path.join(mediaDir, f);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch (e) {
      continue;
    }
    if (stat.isDirectory()) continue; // 不处理子目录
    const rel = 'media/' + f;
    if (!referenced.has(rel)) {
      try {
        await fsp.unlink(full);
      } catch (e) {
        /* 单文件删除失败不影响其余 */
      }
    }
  }
}

/**
 * 将正文中内嵌的 data:base64 图片提取落盘为媒体文件，src 替换为相对路径。
 * 兜底处理：任何来源（如 Quill 默认图片按钮）插入的 base64 图，保存时都会变成真实文件。
 * @returns {Promise<string>} 替换后的 content
 */
async function migrateDataImages(content, mediaDir) {
  const re = /(<img[^>]+src=["'])data:image\/(png|jpeg|jpg|gif|webp);base64,([^"']+)(["'][^>]*>)/gi;
  const matches = [];
  let m;
  while ((m = re.exec(content))) matches.push(m);
  if (!matches.length) return content;
  let i = 0;
  let out = content;
  for (const mm of matches) {
    i++;
    const ext = '.' + mm[2].replace('jpg', 'jpg');
    const buf = Buffer.from(mm[3], 'base64');
    if (!buf.length) continue;
    const name = 'img_' + Date.now() + '_' + i + ext;
    await fsp.writeFile(path.join(mediaDir, name), buf);
    out = out.replace(mm[0], mm[1] + 'media/' + name + mm[4]);
  }
  return out;
}

/**
 * 解析上传文件的真实落盘文件名（存储层职责，对应需求：保留原始文件名）。
 * 规则：
 *   - 优先使用上传时的原始文件名（保留中文与空格）
 *   - 将 Windows 非法字符 \ / : * ? " < > | 替换为下划线
 *   - 仅检测【当前文章】的 media 目录，若同名已存在则追加 _1 / _2 … 递增后缀，避免覆盖
 *   - 仅对之后新上传的文件生效；已存在的旧文件不参与、不改动
 * 注意：Quill 粘贴截图等无原始文件名的场景（migrateDataImages）不调用本函数，仍走时间戳命名。
 * @param {string} articleId
 * @param {string} originalName 客户端 multipart 中的原始 filename（可能含路径，仅取 basename）
 * @returns {string} 最终文件名
 */
function resolveMediaName(articleId, originalName) {
  // 1) 仅取文件名，剥离任何目录路径（防 ../ 穿越 / 绝对路径）
  let base = path.basename(originalName || '');
  if (!base) base = 'file';

  // 2) 清洗 Windows 非法字符 → 下划线（保留中文与空格）
  base = base.replace(/[\\/:*?"<>|]/g, '_');
  // 去除首尾的空格与点（Windows 不允许以空格/点结尾）
  base = base.replace(/^[ .]+/, '').replace(/[ .]+$/, '');
  if (!base) base = 'file';

  const dir = path.join(ARTICLES_DIR, articleId, 'media');
  let finalName = base;

  // 3) 仅检测当前文章 media 目录，重名则追加递增后缀
  if (fs.existsSync(path.join(dir, finalName))) {
    const ext = path.extname(base);
    const stem = ext ? base.slice(0, base.length - ext.length) : base;
    let i = 1;
    do {
      finalName = stem + '_' + i + ext;
      i++;
    } while (fs.existsSync(path.join(dir, finalName)));
  }
  return finalName;
}

/** 从正文 HTML 提取纯文本摘要（去标签后前 30 字） */
function extractSummary(html) {
  const text = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 30);
}

/** 今天日期字符串 YYYY-MM-DD */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 初始化目录结构（幂等） */
async function ensureDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(ARTICLES_DIR, { recursive: true });
}

/** 生成下一个文章 ID（持久化自增序号，删除后不复用） */
async function nextArticleId() {
  let seq = 0;
  try {
    seq = parseInt(await fsp.readFile(SEQ_FILE, 'utf8'), 10) || 0;
  } catch (e) {
    /* .seq 不存在则从现有目录扫描初始化 */
  }
  if (seq <= 0) {
    let entries = [];
    try {
      entries = await fsp.readdir(ARTICLES_DIR, { withFileTypes: true });
    } catch (e) {
      /* 目录不存在按空处理 */
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const m = /^article_(\d+)$/.exec(ent.name);
      if (m) seq = Math.max(seq, parseInt(m[1], 10));
    }
  }
  const next = seq + 1;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(SEQ_FILE, String(next), 'utf8');
  return ID_PREFIX + String(next).padStart(4, '0');
}

/** 读取文章 meta.json（容错返回 null） */
async function readMeta(id) {
  try {
    const raw = await fsp.readFile(path.join(articleDir(id), 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/** 读取文章正文 content.html 原始内容（容错返回 ''） */
async function readContentRaw(id) {
  try {
    return await fsp.readFile(path.join(articleDir(id), 'content.html'), 'utf8');
  } catch (e) {
    return '';
  }
}

/**
 * 获取文章列表（支持关键词全文搜索 + 分页，按 updateTime 倒序）
 * @param {{page?:number, pageSize?:number, keyword?:string}} [opts]
 *   page 页码（>=1）；pageSize 每页条数（0 表示不分页返回全部）；keyword 关键词
 * @returns {Promise<{articles:Array, total:number, page:number, pageSize:number, totalPages:number}>}
 */
async function listArticles(opts) {
  await ensureDirs();
  const page = Math.max(1, parseInt(opts && opts.page, 10) || 1);
  const pageSize = parseInt(opts && opts.pageSize, 10) || 0; // 0 = 全部
  const keyword = String((opts && opts.keyword) || '').trim().toLowerCase();

  let entries = [];
  try {
    entries = await fsp.readdir(ARTICLES_DIR, { withFileTypes: true });
  } catch (e) {
    return { articles: [], total: 0, page: 1, pageSize, totalPages: 0 };
  }

  const all = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !isValidId(ent.name)) continue;
    const meta = await readMeta(ent.name);
    if (!meta) continue;
    let media = Array.isArray(meta.media) ? meta.media : null;
    let summary = meta.summary || '';
    // 摘要疑似混入 CSS（含 { } 特征）时视为坏数据，重新提取
    const summaryLooksBad = /[{}]/.test(summary);
    if (!media || !media.length || !summary || summaryLooksBad) {
      // 兼容旧数据：从 content.html 现提取，并回写 meta 缓存
      const raw = await readContentRaw(ent.name);
      if (!media || !media.length) media = extractMedia(raw);
      if (!summary || summaryLooksBad) summary = extractSummary(raw);
      if (!Array.isArray(meta.media) || (meta.media || []).join('|') !== (media || []).join('|') || meta.summary !== summary) {
        meta.media = media;
        meta.summary = summary;
        try {
          await fsp.writeFile(path.join(articleDir(ent.name), 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
        } catch (e) { /* 回写失败不影响列表 */ }
      }
    }
    // 关键词搜索：标题 / 摘要 / 正文全文（忽略大小写）
    if (keyword) {
      const hit =
        (meta.title || '').toLowerCase().includes(keyword) ||
        summary.toLowerCase().includes(keyword) ||
        (await readContentRaw(ent.name)).toLowerCase().includes(keyword);
      if (!hit) continue;
    }
    all.push({
      id: meta.id,
      title: meta.title || '',
      createTime: meta.createTime || '',
      updateTime: meta.updateTime || '',
      summary: summary || '',
      thumbFile: meta.thumbFile || null,
      media: media || [],
    });
  }
  all.sort((a, b) => (b.updateTime || '').localeCompare(a.updateTime || ''));

  const total = all.length;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const start = pageSize > 0 ? (page - 1) * pageSize : 0;
  const articles = pageSize > 0 ? all.slice(start, start + pageSize) : all;
  return { articles, total, page, pageSize, totalPages };
}

/** 新建空文章：创建文件夹 + media 目录 + 初始 meta.json + 空 content.html */
async function createArticle() {
  await ensureDirs();
  const id = await nextArticleId();
  const dir = articleDir(id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
  const now = today();
  const meta = {
    id,
    title: '未命名文章',
    createTime: now,
    updateTime: now,
    summary: '',
    thumbFile: null,
    media: [],
  };
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await fsp.writeFile(path.join(dir, 'content.html'), buildContentHtml(meta.title, ''), 'utf8');
  return meta;
}

/** 获取单篇文章完整数据（元数据 + 正文 HTML） */
async function getArticle(id) {
  id = idToDirName(id);
  const dir = articleDir(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error('文章不存在: ' + id);
  let content = '';
  try {
    content = await fsp.readFile(path.join(dir, 'content.html'), 'utf8');
  } catch (e) {
    /* 无正文时为空 */
  }
  // 从完整离线 HTML 中抽出 <body> 内部内容，避免前端重复包裹
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : content;
  return { meta, content: bodyContent };
}

/**
 * 保存文章：更新 meta.json + 重写 content.html（离线可用）
 * 摘要自动生成（正文前 30 字），媒体清单自动提取（图片/GIF/视频，最多 5 个）。
 * @param {string} id
 * @param {{title:string, content:string}} data
 */
async function saveArticle(id, data) {
  id = idToDirName(id);
  const dir = articleDir(id);
  const oldMeta = await readMeta(id);
  if (!oldMeta) throw new Error('文章不存在: ' + id);

  const title = String(data.title == null ? (oldMeta.title || '') : data.title).trim() || '未命名文章';
  const rawContent = String(data.content == null ? '' : data.content);
  // 兜底迁移：base64 内嵌图片 → 落盘为媒体文件（media/），替换为相对路径
  const content = await migrateDataImages(rawContent, path.join(dir, 'media'));
  const summary = extractSummary(content) || (oldMeta.summary || '');
  const media = extractMedia(content);

  const meta = {
    id: oldMeta.id,
    title,
    createTime: oldMeta.createTime || today(),
    updateTime: today(),
    summary,
    thumbFile: media.length ? media[0].src : extractFirstImage(content),
    media,
  };
  // 孤儿媒体清理：删除 media 目录中正文未引用的文件。
  // 覆盖：上传后又在编辑器删除（已/未保存）、以及历史残留的无效媒体。
  // 仅删除未被正文引用的本地文件，外链与正文中仍在使用的媒体不受影响。
  await cleanupOrphanMedia(dir, collectAllMediaRefs(content));
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  await fsp.writeFile(path.join(dir, 'content.html'), buildContentHtml(title, content), 'utf8');
  return meta;
}

/** 删除整篇文章文件夹（媒体、缩略图、元数据一并清除，零残留） */
async function deleteArticle(id) {
  id = idToDirName(id);
  const dir = articleDir(id);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    // 兜底1：某些环境下（如沙箱删除钩子）rm 抛错但目录实际已删除
    let exists = true;
    try {
      exists = fs.existsSync(dir);
    } catch (_) { /* ignore */ }
    if (!exists) return true;
    // 兜底2：目录仍存在时，用系统命令强制删除（id 已白名单校验，路径安全）
    const cmd =
      process.platform === 'win32'
        ? `rmdir /s /q "${dir.replace(/\//g, '\\')}"`
        : process.platform === 'darwin'
          ? `rm -rf -- "${dir}"`
          : `rm -rf -- "${dir}"`;
    await new Promise((resolve, reject) => {
      require('child_process').exec(cmd, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  }
}

module.exports = {
  ROOT,
  DATA_DIR,
  ARTICLES_DIR,
  isValidId,
  ensureDirs,
  listArticles,
  createArticle,
  getArticle,
  saveArticle,
  deleteArticle,
  buildContentHtml,
  extractFirstImage,
  extractMedia,
  extractSummary,
  migrateDataImages,
  resolveMediaName,
  collectAllMediaRefs,
  cleanupOrphanMedia,
};
