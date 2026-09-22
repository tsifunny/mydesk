/* MyDesk local backend: static UI, Agent Hub public rToken data,
   Bitget stock MCP reference data, and optional AI translation.
   Run: node server.cjs — http://127.0.0.1:4173 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const {configureNetwork, boundedFetch, normalizeProxy, errorText} = require('./backend/network.cjs');
const {identity} = require('./backend/identity.cjs');
const {createIntegrations} = require('./backend/bitget.cjs');
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
let network = configureNetwork();
let integrations = createIntegrations();
let connectionCheck;
let reconnecting=false;
const appIdentity=identity(__dirname);

const root = __dirname;
const PORT = Number(process.env.PORT) || 4173;
const UPSTREAM = 'https://api.bitget.com';

// ── 中转 ────────────────────────────────────────────────────────────────
/** 只放行公开行情读接口，避免被当成通用代理 */
const ALLOW = [
  /^\/api\/v2\/spot\/public\//,
  /^\/api\/v2\/spot\/market\//,
  /^\/api\/v2\/public\//,
  /^\/api\/v2\/mix\/market\//,
];


/**
 * 在可选的 HTTP 代理后面发一个 HTTPS 请求。
 * target: { host, port, path, method, headers, body }
 * 使用统一网络设置，保留 TLS 证书校验。
 */
function httpsVia(target, cb) {
  boundedFetch('https://' + target.host + ':' + target.port + target.path, {
    method:target.method, headers:target.headers, body:target.body,
  }).then(async r => cb(r.status, {'Content-Type':r.headers.get('content-type') || 'application/json'}, Buffer.from(await r.arrayBuffer())))
    .catch(e => cb(e.name === 'TimeoutError' ? 504 : 502, {}, Buffer.from('上游连接失败：' + (e.cause?.message || e.message))));
}

function relay(req, res, targetPath) {
  if (req.method !== 'GET') { res.writeHead(405).end('只支持 GET'); return; }
  if (!ALLOW.some((re) => re.test(targetPath))) { res.writeHead(403).end('不允许的中转路径'); return; }

  const started = Date.now();
  const done = (status, headers, body) => {
    res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers));
    res.end(body);
    console.log(`  relay ${status} ${targetPath} ${Date.now() - started}ms${network.proxyEnabled ? ' via configured proxy' : ' direct'}`);
  };

  httpsVia({ host: 'api.bitget.com', port: 443, path: targetPath, method: 'GET',
    headers: { accept: 'application/json' } }, done);
}

// ── AI 中转 ─────────────────────────────────────────────────────────────
const AI_BASE = process.env.MYDESK_AI_BASE_URL || '';
const AI_MODEL = process.env.MYDESK_AI_MODEL || '';
const AI_KEY = process.env.MYDESK_AI_KEY || '';

/**
 * 校验用户填的接口地址。
 * 这是在防 SSRF —— 请求体里的地址由用户控制，不能让它随便打内网。
 * 规则：https 一律放行（公网服务）；http 只放行本机（给本地跑的 Ollama / LM Studio 用）；
 *      内网段与云元数据地址全部拦掉。
 */
function checkBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return { ok: false, why: '接口地址不是合法 URL' }; }
  const host = u.hostname.toLowerCase();

  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (u.protocol === 'http:') {
    if (!isLoopback) return { ok: false, why: 'http 只允许本机地址，公网请用 https' };
    return { ok: true, url: u };
  }
  if (u.protocol !== 'https:') return { ok: false, why: '只支持 http(S) 协议' };

  // 拦内网 / 链路本地 / 云元数据
  const isPrivate =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host) ||
    /\.local$/.test(host) || /\.internal$/.test(host) || /\.localhost$/.test(host);
  if (isPrivate) return { ok: false, why: '不允许访问内网地址' };

  return { ok: true, url: u };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 256 * 1024)) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** 只报状态，绝不回传 Key 本身 */
function aiConfig(req, res) {
  sendJson(res, 200, {
    configured: !!(AI_KEY && AI_BASE && AI_MODEL),
    baseUrl: AI_BASE,
    model: AI_MODEL,
  });
}

async function aiChat(req, res) {
  if (req.method !== 'POST') { sendJson(res, 405, { error: '只支持 POST' }); return; }

  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return; }

  const baseUrl = String(payload.baseUrl || AI_BASE || '').trim();
  const model = String(payload.model || AI_MODEL || '').trim();
  const apiKey = String(payload.apiKey || AI_KEY || '').trim();

  if (!baseUrl || !model) { sendJson(res, 400, { error: '还缺接口地址或模型名' }); return; }
  if (!apiKey) { sendJson(res, 400, { error: '还缺 API Key（页面里没填，服务端也没配 MYDESK_AI_KEY）' }); return; }

  const chk = checkBaseUrl(baseUrl);
  if (!chk.ok) { sendJson(res, 400, { error: '接口地址不可用：' + chk.why }); return; }

  const target = chk.url;
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port) || (isHttps ? 443 : 80);
  const basePath = target.pathname.replace(/\/+$/, '');
  const reqPath = basePath + '/chat/completions';

  const body = JSON.stringify({
    model: model,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.2,
  });

  const started = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: 'Bearer ' + apiKey,
  };

  const finish = (status, raw) => {
    let out = null;
    try { out = JSON.parse(raw); } catch (e) { /* 上游可能返回非 JSON */ }
    const content = out && out.choices && out.choices[0] && out.choices[0].message
      && out.choices[0].message.content;
    if (status >= 400) {
      const msg = (out && (out.error && (out.error.message || out.error) || out.message))
        || String(raw).slice(0, 300) || ('HTTP ' + status);
      console.log(`  ai ${status} ${target.host} ${Date.now() - started}ms`);
      sendJson(res, 502, { error: String(msg).slice(0, 400) });
      return;
    }
    if (!content) {
      sendJson(res, 502, { error: '接口返回里没有 content 字段' });
      return;
    }
    console.log(`  ai 200 ${target.host} ${Date.now() - started}ms${network.proxyEnabled ? ' via configured proxy' : ' direct'}`);
    sendJson(res, 200, { content: content, model: out.model || model });
  };

  if (isHttps) {
    httpsVia({ host: target.hostname, port: port, path: reqPath, method: 'POST', headers: headers, body: body },
      (status, h, buf) => finish(status, buf.toString('utf8')));
    return;
  }

  // 本机 http（Ollama / LM Studio 之类）
  const up = http.request({ host: target.hostname, port: port, path: reqPath, method: 'POST', headers: headers, timeout: 60000 },
    (upRes) => {
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => finish(upRes.statusCode || 502, Buffer.concat(chunks).toString('utf8')));
    });
  up.on('timeout', () => { up.destroy(); sendJson(res, 504, { error: '本机模型服务超时' }); });
  up.on('error', (e) => sendJson(res, 502, { error: '连不上本机模型服务：' + e.message }));
  up.write(body);
  up.end();
}

// ── 静态文件 ────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400).end(); return; }

  if (pathname === '/api/health') return sendJson(res,200,{...appIdentity,port:server.address().port});
  if (pathname.startsWith('/api/connection/') && req.method === 'POST') {
    connectionRoute(req,res,pathname).catch(e=>sendJson(res,e.status||502,{error:errorText(e)}));return;
  }
  if (pathname.startsWith('/api/agent-hub/') || pathname.startsWith('/api/bitget-mcp/') || pathname === '/api/integrations/status') {
    integrationRoute(req, res, pathname).catch(e => sendJson(res, e.status || 502, {ok:false,error:e.message}));
    return;
  }

  if (pathname.startsWith('/api/bitget/')) {
    relay(req, res, pathname.slice('/api/bitget'.length) + (req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?')) : ''));
    return;
  }
  if (pathname === '/api/ai/config') { aiConfig(req, res); return; }
  if (pathname === '/api/ai/chat') { aiChat(req, res); return; }

  if (pathname === '/startup') pathname='/src/startup.html';
  if (pathname !== '/' && pathname !== '/MyDesk-next.html' && pathname !== '/src/startup.html' && !/^\/src\/[\w.-]+\.(js|css|svg)$/.test(pathname)) { res.writeHead(404).end('Not found'); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/MyDesk-next.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('MyDesk preview: http://127.0.0.1:' + PORT);
  console.log('连接模式：' + (network.status().mode==='auto'?'自动识别 VPN / 系统代理 / HTTP / SOCKS5':'手动代理') + '；诊断页：/startup');
  if(process.send) process.send({type:'ready',port:server.address().port,...appIdentity});

  console.log('行情中转: /api/bitget/*  ->  ' + UPSTREAM + '（连接检查后选择可用线路）');
  console.log('AI 中转  : /api/ai/chat    ->  ' + (AI_BASE ? AI_BASE + '（服务端已配好 Key，页面里可以不填）' : '未配服务端 Key，请在页面的「AI 转译」里填，或设 MYDESK_AI_KEY'));
}).on('error', (e) => {
  // 直接抛异常的话，看到的是一大段 stack，看不出到底怎么了
  if (e && e.code === 'EADDRINUSE') {
    console.error('');
    console.error('端口 ' + PORT + ' 已被占用 —— 大概率是已经有一个 MyDesk 服务在跑了。');
    console.error('');
    console.error('  ① 先用现有的：直接打开 http://127.0.0.1:' + PORT);
    console.error('  ② 想重启：先结束占用这个端口的进程，再执行本命令');
    console.error('     Git Bash:  netstat -ano | grep :' + PORT + ' | grep LISTENING   → 拿到 PID 后  taskkill //PID <PID> //F');
    console.error('  ③ 想两个并存：换个端口就行，例如  PORT=' + (PORT + 1) + ' npm start');
    console.error('');
    process.exit(1);
  }
  throw e;
});

async function integrationRoute(req, res, pathname) {
  const url=new URL(req.url, 'http://localhost');
  if(req.method === 'GET') {
    if(pathname === '/api/integrations/status') {
      if(url.searchParams.get('probe')==='1'){await network.prepare();await integrations.probe();}
      return sendJson(res,200,{...integrations.status(),network:network.status()});
    }
    if(pathname === '/api/agent-hub/tools') return sendJson(res,200,{tools:await integrations.hubTools()});
    if(pathname === '/api/agent-hub/rtoken-universe') return sendJson(res,200,await integrations.tokenUniverse());
    if(pathname === '/api/agent-hub/rtoken-chart') return sendJson(res,200,await integrations.tokenChart(
      url.searchParams.get('symbol') || 'rMETA',
      url.searchParams.get('interval') || '1D',
      Number(url.searchParams.get('limit') || 360)
    ));
    if(pathname === '/api/bitget-mcp/tools') return sendJson(res,200,{tools:await integrations.mcpTools(),pricePolicy:'rToken-only'});
    if(pathname === '/api/agent-hub/rtokens') return sendJson(res,200,await integrations.tokenData((url.searchParams.get('symbols') || 'rMETA').split(','),Number(url.searchParams.get('days') || 120)));
  }
  if(req.method === 'POST' && ['/api/agent-hub/call','/api/bitget-mcp/call'].includes(pathname)) {
    if(req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return sendJson(res,403,{error:'请从 MyDesk 本机页面调用'});
    let payload;
    try { payload=JSON.parse(await readBody(req)); } catch { return sendJson(res,400,{error:'请求体不是合法 JSON'}); }
    if(!payload || typeof payload.name !== 'string' || (payload.arguments != null && (typeof payload.arguments !== 'object' || Array.isArray(payload.arguments)))) return sendJson(res,400,{error:'需要 name 和 arguments 对象'});
    const result=await (pathname.includes('agent-hub') ? integrations.hubCall(payload.name,payload.arguments) : integrations.mcpCall(payload.name,payload.arguments));
    return sendJson(res,result.ok === false ? 502 : 200,result);
  }
  sendJson(res,404,{error:'接口不存在或请求方式不支持'});
}
async function checkConnection() {
  if(connectionCheck)return connectionCheck;
  connectionCheck=(async()=>{
    await network.prepare();
    const state=await integrations.probe();
    let sample=null;
    if(state.agentHub.connected){
      try{
        const chart=await integrations.tokenChart('rMETA','1D',30);
        const bars=chart.bars||[];
        if(!bars.length)throw Error('RMETAUSDT 未返回 K 线');
        sample={symbol:chart.symbol,product:chart.product_symbol,bars:bars.length,fetchedAt:chart.fetched_at};
      }catch(error){sample={error:errorText(error)};}
    }
    return {...integrations.status(),network:network.status(),sample,checkedAt:new Date().toISOString()};
  })().finally(()=>{connectionCheck=null;});
  return connectionCheck;
}
async function connectionRoute(req,res,pathname) {
  // Settings only accept same-origin JSON, preventing a third-party page from
  // changing the local process's proxy. No proxy credentials are returned.
  if(req.headers.origin && req.headers.origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'请从 MyDesk 本机页面操作'});
  if(!/^application\/json\b/i.test(req.headers['content-type']||''))return sendJson(res,415,{error:'需要 JSON 请求'});
  if(pathname==='/api/connection/reconnect') {
    if(reconnecting)return sendJson(res,409,{error:'另一窗口正在重新连接，请稍后重试'});
    const body=JSON.parse(await readBody(req,4096));
    const proxy=normalizeProxy(String(body.proxy||'').trim());
    reconnecting=true;
    try{
      if(connectionCheck)await connectionCheck.catch(()=>{});
      await integrations.close();await network.close();
      network=configureNetwork({...process.env,MYDESK_PROXY_URL:proxy||'auto'});
      integrations=createIntegrations();
      return sendJson(res,200,await checkConnection());
    }finally{reconnecting=false;}
  }
  if(pathname==='/api/connection/check')return sendJson(res,200,await checkConnection());
  sendJson(res,404,{error:'接口不存在'});
}
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{ integrations.close().finally(()=>network.close()).finally(()=>server.close(()=>process.exit(0))); });
