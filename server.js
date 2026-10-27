'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');
const store = require('./lib/store');
const api = require('./lib/api');
const auth = require('./lib/auth');

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();
store.init();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'self'"
  ].join('; ')
};

function sendFile(req, res, filePath, cache = 'no-cache') {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send404(res);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  });
}

function send404(res, message = 'ไม่พบหน้าที่ต้องการ') {
  const html = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — ไม่พบหน้า</title><link rel="stylesheet" href="/css/styles.css"></head>
<body class="error-page"><main class="error-card"><span class="error-code">404</span>
<h1>ไม่พบหน้าที่ต้องการ</h1><p>${message}</p><a class="btn btn-primary" href="/">กลับหน้าแรก</a></main></body></html>`;
  res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function resolveInside(baseDir, relative) {
  const target = path.resolve(baseDir, '.' + relative);
  if (!target.startsWith(path.resolve(baseDir) + path.sep)) return null;
  return target;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send404(res, 'URL ไม่ถูกต้อง');
    }

    if (pathname === '/auth/google') return auth.googleStart(req, res);
    if (pathname === '/auth/google/callback') return await auth.googleCallback(req, res, url);

    if (pathname.startsWith('/api/')) return await api.handle(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
      return res.end('Method Not Allowed');
    }

    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
      return sendFile(req, res, path.join(PUBLIC_DIR, 'admin.html'));
    }

    if (pathname.startsWith('/uploads/')) {
      const filePath = resolveInside(UPLOAD_DIR, pathname.slice('/uploads'.length));
      if (!filePath) return send404(res);
      return sendFile(req, res, filePath, 'public, max-age=86400');
    }

    if (/^\/(css|js|assets)\//.test(pathname) || pathname === '/favicon.svg') {
      const filePath = resolveInside(PUBLIC_DIR, pathname);
      if (!filePath) return send404(res);
      return sendFile(req, res, filePath);
    }

    if (!path.extname(pathname)) {
      return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }

    return send404(res);
  } catch (error) {
    console.error('[server]', error);
    if (!res.headersSent) {
      res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error');
  }
});

function lanAddress() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '';
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n[!] พอร์ต ${PORT} ถูกใช้งานอยู่ กรุณาปิดโปรแกรมเดิมหรือตั้งค่า PORT ในไฟล์ .env\n`);
  } else {
    console.error('[server]', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const settings = store.getDb().settings;
  const local = `http://localhost:${PORT}`;
  const lan = lanAddress();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║          BDC E-SPORT — ESPORTS WEBSITE           ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  เว็บไซต์      : ${local}`);
  if (lan) console.log(`  ในวง LAN      : http://${lan}:${PORT}`);
  console.log(`  หน้าแอดมิน    : ${local}/admin`);
  if (settings.passwordIsDefault) {
    console.log('');
    console.log('  เข้าสู่ระบบครั้งแรก');
    console.log('    รหัสผ่าน : admin1234');
    console.log('    (แนะนำให้เปลี่ยนรหัสผ่านในหน้า ตั้งค่า)');
  }
  console.log('');
  console.log(`  Google Login  : ${auth.isGoogleEnabled() ? 'เปิดใช้งาน' : 'ปิด (ตั้งค่า GOOGLE_CLIENT_ID / SECRET ใน .env)'}`);
  console.log('  กด Ctrl+C เพื่อหยุดเซิร์ฟเวอร์');
  console.log('');

  if (process.env.AUTO_OPEN === '1' && process.platform === 'win32') {
    setTimeout(() => exec(`start "" "${local}"`), 700);
  }
});

process.on('SIGINT', () => {
  console.log('\nปิดเซิร์ฟเวอร์แล้ว');
  process.exit(0);
});
