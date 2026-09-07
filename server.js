// ================================================================
// 家庭点餐 - 后端服务
// 本地：npm start      云端：Render.com 自动
// 数据持久化：本地 data.json + GitHub Gist 双保险
//   - 本地开发只读写 data.json
//   - 云端（Render 等）如果配置了 GITHUB_TOKEN + GIST_ID，自动同步到 Gist
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
// 持久化数据目录：本地用项目根目录，Railway 用挂载的 /app/data 持久化磁盘
const DATA_DIR   = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : __dirname);
const DATA_FILE  = path.join(DATA_DIR, 'data.json');
const GH_TOKEN   = process.env.GITHUB_TOKEN || '';   // Render 环境变量（可不设）
const GIST_ID    = process.env.GIST_ID || '';        // Render 环境变量（可不设）
const GIST_URL   = 'https://api.github.com/gists/' + GIST_ID;
const GIST_ENABLED = !!(GH_TOKEN && GIST_ID);

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

// 从 Gist 拉取（异步）
async function loadFromGist(){
  if(!GIST_ENABLED) return null;
  try {
    const r = await fetch(GIST_URL, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if(!r.ok){ console.warn('[gist] 拉取失败', r.status); return null; }
    const gist = await r.json();
    const file = gist.files && gist.files['data.json'];
    if(!file || !file.content){ return null; }
    return JSON.parse(file.content);
  } catch(e){ console.warn('[gist] 拉取异常:', e.message); return null; }
}

// 推送 Gist（异步，后台跑，不阻塞主流程）
async function pushToGist(db){
  if(!GIST_ENABLED) return;
  try {
    await fetch(GIST_URL, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: '家庭点餐数据 - data.json',
        files: {
          'data.json': { content: JSON.stringify(db, null, 2) }
        }
      })
    });
  } catch(e){ console.warn('[gist] 推送异常:', e.message); }
}

// 启动时：先拉 Gist → 有就用，没有用本地，没有本地就 fresh
let DB;
async function initDB(){
  // 1. 先看 Gist（云端最新）
  const fromGist = await loadFromGist();
  if(fromGist){
    console.log('[data] ✅ 从 Gist 拉取');
    DB = fromGist;
    saveLocalDB(DB);   // 顺手同步到本地
    return;
  }
  // 2. Gist 没有或失败，用本地
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
}

// 统一保存：本地同步写，Gist 异步推
function saveDB(){
  saveLocalDB(DB);
  if(GIST_ENABLED) pushToGist(DB);
}

// ---- 中间件 ----
app.use(express.json({ limit: '10mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'order.html')));
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

// 手动触发 Gist 同步（Render 可能需要验证）
app.post('/api/sync', async (req, res) => {
  await pushToGist(DB);
  res.json({ ok:true, gistEnabled: GIST_ENABLED });
});

// ---- Socket.IO ----
io.on('connection', (socket) => {
  console.log(`[ws] ${socket.id} connected, 在线: ${io.engine.clientsCount}`);
  socket.on('disconnect', () => {
    console.log(`[ws] ${socket.id} disconnected`);
  });
});

// ---- 启动 ----
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('====================================');
    console.log(' 家庭点餐服务已启动');
    console.log(` 端口: ${PORT}`);
    console.log(` Gist持久化: ${GIST_ENABLED ? '✅ 已启用' : '⏸ 未配置（仅本地）'}`);
    console.log(' 管理员密码: 123456');
    console.log('====================================');
  });
});
