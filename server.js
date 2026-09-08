// ================================================================
// 家庭点餐 - 后端服务
// 本地：npm start      云端：Railway 自动
// 数据持久化：本地 data.json + GitHub Repo 双保险
//   - 本地开发只读写 data.json
//   - 云端（Railway 等）如果配置了 GITHUB_TOKEN，自动把 data.json 同步到 GitHub 仓库
// ================================================================
const express   = require('express');
const http      = require('http');
const path      = require('path');
const fs        = require('fs');
const socketIo  = require('socket.io');
const multer    = require('multer');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*' } });

const PORT       = process.env.PORT || 3000;
const DATA_DIR   = process.env.DATA_DIR || (__dirname);
const DATA_FILE  = path.join(DATA_DIR, 'data.json');
const GH_TOKEN   = process.env.GITHUB_TOKEN || '';
const GH_OWNER   = process.env.GITHUB_OWNER || 'Dzxser';
const GH_REPO    = process.env.GITHUB_REPO || 'family-order';
const GH_BRANCH  = process.env.GITHUB_BRANCH || 'main';
const GH_FILE    = process.env.GITHUB_DATA_FILE || 'data.json';
const GH_API_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;
const GH_ENABLED = !!GH_TOKEN;

// 确保数据目录存在
if(!fs.existsSync(DATA_DIR)){ try { fs.mkdirSync(DATA_DIR, { recursive: true }); console.log('[data] 已创建目录:', DATA_DIR); } catch(e){ console.warn('[data] 创建目录失败:', e.message); } }

// ---- 初始化数据 ----
const DEFAULT_CATEGORIES = ['蔬菜','凉拌菜','腌制','羹汤','荤菜','小炒','饮料','其他'];
function freshDB(){
  return { categories: [...DEFAULT_CATEGORIES], dishes: [], orders: [], adminPwd: '123456' };
}

// 从本地 data.json 读
function loadLocalDB(){
  if(fs.existsSync(DATA_FILE)){
    try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf-8')); }
    catch(e){ console.warn('[data] 本地 data.json 损坏，重建'); }
  }
  return null;
}
// 写本地 data.json
function saveLocalDB(db){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf-8'); }
  catch(e){ console.error('[data] 写本地失败:', e.message); }
}

// 从 GitHub Repo 拉取 data.json
async function loadFromGitHub(){
  if(!GH_ENABLED) return null;
  try {
    const r = await fetch(GH_API_URL, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if(!r.ok){ console.warn('[gh] 拉取失败', r.status); return null; }
    const file = await r.json();
    if(!file.content) return null;
    const decoded = Buffer.from(file.content.replace(/\n/g,''), 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch(e){ console.warn('[gh] 拉取异常:', e.message); return null; }
}

// 推送到 GitHub Repo（后台异步跑，不阻塞主流程）
let cachedSha = null;
async function pushToGitHub(db){
  if(!GH_ENABLED) return;
  try {
    // 先获取当前 sha（缓存命中就直接用）
    let sha = cachedSha;
    if(!sha){
      const r = await fetch(GH_API_URL, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' }
      });
      if(r.ok){ const f = await r.json(); sha = f.sha; cachedSha = sha; }
    }
    await fetch(GH_API_URL, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: '📝 自动同步 data.json',
        content: Buffer.from(JSON.stringify(db, null, 2)).toString('base64'),
        branch: GH_BRANCH,
        ...(sha ? { sha } : {})
      })
    });
    // sha 会变，清缓存
    cachedSha = null;
  } catch(e){ console.warn('[gh] 推送异常:', e.message); cachedSha = null; }
}

// 从 GitHub Repo 拉静态文件（order.html / service-worker.js / manifest.json）
async function syncStaticFromGitHub(){
  if(!GH_ENABLED) return;
  const files = ['order.html', 'service-worker.js', 'manifest.json'];
  for(const name of files){
    try {
      const r = await fetch(`${GH_API_URL.replace('data.json', name)}`, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' }
      });
      if(!r.ok) continue;
      const f = await r.json();
      if(f.content){
        const content = Buffer.from(f.content.replace(/\n/g,''), 'base64');
        fs.writeFileSync(path.join(__dirname, name), content);
        console.log(`[static] ✅ ${name} 已从 GitHub 同步`);
      }
    } catch(e){ /* 忽略静态文件同步失败 */ }
  }
}

// 启动时：先拉 GitHub → 有就用，没有用本地，没有本地就 fresh
let DB;
async function initDB(){
  // 1. 先看 GitHub Repo（云端最新）
  const fromGH = await loadFromGitHub();
  if(fromGH){
    console.log('[data] ✅ 从 GitHub 拉取');
    DB = fromGH;
    saveLocalDB(DB);
    return;
  }
  // 2. GitHub 没有或失败，用本地
  const fromLocal = loadLocalDB();
  if(fromLocal){
    console.log('[data] ✅ 使用本地 data.json');
    DB = fromLocal;
    return;
  }
  // 3. 全新
  console.log('[data] ✅ 新建 data.json');
  DB = freshDB();
  saveLocalDB(DB);
  if(GH_ENABLED && GH_AUTO_PUSH) setTimeout(() => pushToGitHub(DB), 60000);
}

// 统一保存：本地同步写，GitHub 节流推（30秒内无新改动才推，防止无限 Redeploy 循环）
// GH_AUTO_PUSH = false 临时关掉自动推送（Redeploy 死循环时用），正常应为 true
const GH_AUTO_PUSH = false;
let ghPushTimer = null;
function saveDB(){
  saveLocalDB(DB);
  if(GH_ENABLED && GH_AUTO_PUSH){
    if(ghPushTimer) clearTimeout(ghPushTimer);
    ghPushTimer = setTimeout(() => { ghPushTimer = null; pushToGitHub(DB); }, 30000);
  }
}

// ---- 中间件 ----
app.use(express.json({ limit: '10mb' }));

// 拦截 order.html 请求，从 GitHub 实时拉最新版本（绕过 Railway 构建缓存）
async function fetchFileFromGitHub(name){
  if(!GH_ENABLED) return null;
  try {
    const r = await fetch(GH_API_URL.replace('data.json', name), {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if(!r.ok) return null;
    const f = await r.json();
    if(!f.content) return null;
    return Buffer.from(f.content.replace(/\n/g,''), 'base64').toString('utf-8');
  } catch(e){ return null; }
}
app.get('/', async (req, res) => {
  const content = await fetchFileFromGitHub('order.html');
  if(content){ res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(content); return; }
  res.sendFile(path.join(__dirname, 'order.html'));
});
app.use(express.static(__dirname));

// ---- 上传（内存 → base64 data URL → 存进 data.json）----
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024 } });

// ---- 广播 ----
function broadcast(msg){
  io.emit('dataChanged', { t: Date.now(), info: msg });
}

// ================================================================
// REST API
// ================================================================

app.get('/api/all', (req, res) => res.json(DB));

app.post('/api/dish', (req, res) => {
  const { id, name, category, desc, price, recipe, image } = req.body;
  if(!name || !category) return res.status(400).json({error:'缺少字段'});
  if(id){
    const idx = DB.dishes.findIndex(d=>d.id===id);
    if(idx===-1) return res.status(404).json({error:'not found'});
    DB.dishes[idx] = { ...DB.dishes[idx], name, category,
      desc: desc||'', price: Number(price)||0, recipe: recipe||'', image: image||null };
  } else {
    DB.dishes.push({ id: Date.now().toString(36), name, category,
      desc: desc||'', price: Number(price)||0, recipe: recipe||'', image: image||null });
  }
  saveDB(); broadcast('菜品已更新');
  res.json({ ok:true });
});

app.delete('/api/dish/:id', (req, res) => {
  DB.dishes = DB.dishes.filter(d => d.id !== req.params.id);
  saveDB(); broadcast('菜品已删除');
  res.json({ ok:true });
});

app.post('/api/category', (req, res) => {
  const { name, oldName } = req.body;
  if(!name) return res.status(400).json({error:'缺少名称'});
  if(oldName !== undefined){
    const i = DB.categories.indexOf(oldName);
    if(i===-1) return res.status(404).json({error:'not found'});
    DB.categories[i] = name;
    DB.dishes.forEach(d => { if(d.category===oldName) d.category=name; });
  } else {
    if(DB.categories.includes(name)) return res.status(400).json({error:'已存在'});
    DB.categories.push(name);
  }
  saveDB(); broadcast('分类已更新');
  res.json({ ok:true });
});

app.delete('/api/category/:index', (req, res) => {
  const i = Number(req.params.index);
  if(i<0 || i>=DB.categories.length) return res.status(404).json({error:'not found'});
  DB.categories.splice(i,1);
  saveDB(); broadcast('分类已删除');
  res.json({ ok:true });
});

app.post('/api/order', (req, res) => {
  const { items, note, total } = req.body;
  if(!items || !items.length) return res.status(400).json({error:'菜品为空'});
  const order = {
    id: Date.now().toString(36).toUpperCase(),
    items, note: note||'', total: Number(total)||0,
    time: Date.now(), status: 'pending'
  };
  DB.orders.push(order);
  saveDB(); broadcast('新订单来了！');
  res.json({ ok:true, order });
});

app.post('/api/order/:id/status', (req, res) => {
  const o = DB.orders.find(x => x.id === req.params.id);
  if(!o) return res.status(404).json({error:'not found'});
  o.status = req.body.status || (o.status==='done'?'pending':'done');
  saveDB(); broadcast('订单状态已变更');
  res.json({ ok:true });
});

app.delete('/api/order/:id', (req, res) => {
  DB.orders = DB.orders.filter(x => x.id !== req.params.id);
  saveDB(); broadcast('订单已删除');
  res.json({ ok:true });
});

app.post('/api/upload', uploadMem.single('file'), (req, res) => {
  if(!req.file) return res.status(400).json({error:'no file'});
  const mime = req.file.mimetype;
  const b64  = req.file.buffer.toString('base64');
  res.json({ url: `data:${mime};base64,${b64}` });
});

app.post('/api/login', (req, res) => {
  const { pwd, newPwd } = req.body;
  if(pwd !== DB.adminPwd) return res.status(401).json({error:'密码错误'});
  if(newPwd && newPwd.trim()){
    DB.adminPwd = newPwd.trim();
    saveDB();
  }
  res.json({ ok:true });
});

// 手动触发 GitHub 同步
app.post('/api/sync', async (req, res) => {
  await pushToGitHub(DB);
  res.json({ ok:true, githubEnabled: GH_ENABLED });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ ok: true, githubEnabled: GH_ENABLED, dataFile: DATA_FILE });
});

// ---- Socket.IO ----
io.on('connection', (socket) => {
  console.log(`[ws] ${socket.id} connected, 在线: ${io.engine.clientsCount}`);
  socket.on('disconnect', () => {
    console.log(`[ws] ${socket.id} disconnected`);
  });
});

// ---- 启动 ----
Promise.all([initDB(), syncStaticFromGitHub()]).then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('====================================');
    console.log(' 家庭点餐服务已启动');
    console.log(` 端口: ${PORT}`);
    console.log(` GitHub持久化: ${GH_ENABLED ? '✅ 已启用 (' + GH_OWNER + '/' + GH_REPO + ': ' + GH_FILE + ')' : '⏸ 未配置'}`);
    console.log(' 管理员密码: 123456');
    console.log('====================================');
  });
});
