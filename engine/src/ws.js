'use strict';
/**
 * 零依赖 WebSocket（RFC6455）+ HTTP 双栈。
 * 只做舰队需要的：文本帧、分片续帧、ping/pong、close、客户端掩码。
 * 绑定 127.0.0.1 时不对外，跨机需自行加 TLS 与鉴权。
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 32 * 1024 * 1024;

function unmask(payload, key) {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ key[i & 3];
  return out;
}

function encodeFrame(payload, { op = 1, mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | op;
  if (!mask) return Buffer.concat([header, data]);
  const key = crypto.randomBytes(4);
  header[1] |= 0x80;
  return Buffer.concat([header, key, unmask(data, key)]);
}

/** 增量解码器 */
function createDecoder(onFrame) {
  let buf = Buffer.alloc(0);
  let frag = [];
  let fragOp = 0;
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off);
        if (big > BigInt(MAX_FRAME)) { onFrame({ type: 'error', error: 'frame_too_big' }); return; }
        len = Number(big); off += 8;
      }
      if (len > MAX_FRAME) { onFrame({ type: 'error', error: 'frame_too_big' }); return; }
      let key = null;
      if (masked) {
        if (buf.length < off + 4) return;
        key = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) payload = unmask(payload, key);
      buf = buf.subarray(off + len);
      if (op === 0x8) { onFrame({ type: 'close', payload }); return; }
      if (op === 0x9) { onFrame({ type: 'ping', payload }); continue; }
      if (op === 0x10) { onFrame({ type: 'pong', payload }); continue; }
      if (op === 0x1 || op === 0x2) { frag = [Buffer.from(payload)]; fragOp = op; if (fin) flush(); continue; }
      if (op === 0x0) { if (payload.length) frag.push(Buffer.from(payload)); if (fin) flush(); continue; }
      onFrame({ type: 'error', error: 'bad_opcode' }); return;
    }
    function flush() {
      const body = Buffer.concat(frag);
      frag = [];
      onFrame({ type: fragOp === 0x1 ? 'text' : 'binary', payload: body });
    }
  };
}

/** 一条已建立的连接（服务端与客户端共用） */
class Conn extends EventEmitter {
  constructor(socket, { masked = true } = {}) {
    super();
    this.socket = socket;
    this.masked = masked;
    this.alive = true;
    this.id = crypto.randomBytes(4).toString('hex');
    this.remote = socket.remoteAddress || 'local';
    const decoder = createDecoder((f) => this._frame(f));
    socket.on('data', (d) => decoder(d));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._dead('close'));
    this.pingTimer = setInterval(() => {
      if (!this.alive) return;
      try { this.socket.write(encodeFrame('', { op: 9, mask: this.masked })); } catch (_) { this.destroy(); }
    }, 25000);
    this.pingTimer.unref && this.pingTimer.unref();
  }
  _frame(f) {
    if (f.type === 'text') {
      let msg;
      try { msg = JSON.parse(f.payload.toString('utf8')); }
      catch (e) { return this.emit('protocol_error', String(e)); }
      this.emit('message', msg);
    } else if (f.type === 'ping') {
      this.sendRaw(encodeFrame(f.payload, { op: 10, mask: this.masked }));
    } else if (f.type === 'close') {
      this.sendRaw(encodeFrame('', { op: 8, mask: this.masked }));
      this.destroy();
    } else if (f.type === 'error') {
      this.emit('protocol_error', f.error);
      this.destroy();
    }
  }
  sendRaw(buf) {
    if (!this.alive) return false;
    try { this.socket.write(buf); return true; } catch (_) { this.destroy(); return false; }
  }
  send(obj) {
    return this.sendRaw(encodeFrame(JSON.stringify(obj), { op: 1, mask: this.masked }));
  }
  close() {
    try { this.sendRaw(encodeFrame('', { op: 8, mask: this.masked })); } catch (_) {}
    this.destroy();
  }
  destroy() { this._dead('destroy'); }
  _dead(why) {
    if (!this.alive) return;
    this.alive = false;
    clearInterval(this.pingTimer);
    try { this.socket.destroy(); } catch (_) {}
    this.emit('dead', why);
  }
}

/** 在已有 http.Server 上挂载 WS upgrade */
function attachWss(server, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers['sec-websocket-version'] || '') !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const conn = new Conn(socket, { masked: true });
    if (head && head.length) {
      const decoder = createDecoder(() => {});
      try { decoder(head); } catch (_) {}
    }
    onConnection(conn, req);
  });
  return server;
}

function createServer({ port = 7788, host = '127.0.0.1', onRequest } = {}) {
  const server = http.createServer((req, res) => {
    if (onRequest) return onRequest(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(port, host);
  return server;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isTls = u.protocol === 'wss:';
    const mod = isTls ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const req = mod.request({
      host: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (_res, socket, head) => {
      socket.setNoDelay(true);
      const conn = new Conn(socket, { masked: true });
      if (head && head.length) { try { socket.emit('data', head); } catch (_) {} }
      resolve(conn);
    });
    req.on('response', (res) => reject(new Error(`ws handshake rejected: HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { createServer, attachWss, connect, encodeFrame, Conn };
