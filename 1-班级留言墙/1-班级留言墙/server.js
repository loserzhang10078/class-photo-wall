const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@vercel/kv');

function resolveKvCredentials() {
  const url =
    process.env.loser_KV_REST_API_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.loser_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN;
  return { url, token };
}

// 使用 createClient 显式传入，避免默认 kv 代理在缺 env 时抛错导致 FUNCTION_INVOCATION_FAILED
const { url: KV_URL, token: KV_TOKEN } = resolveKvCredentials();
let kv = null;
let initError = null;
if (!KV_URL || !KV_TOKEN) {
  initError = new Error(
    '未检测到 KV：请在 Vercel 本项目下绑定 Upstash Redis，并确认 Production 环境存在 loser_KV_REST_API_URL 与 loser_KV_REST_API_TOKEN（或 KV_REST_API_URL / KV_REST_API_TOKEN）'
  );
} else {
  try {
    process.env.KV_REST_API_URL = KV_URL;
    process.env.KV_REST_API_TOKEN = KV_TOKEN;
    kv = createClient({ url: KV_URL, token: KV_TOKEN });
  } catch (e) {
    initError = e;
  }
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== 初始化状态管理 ==========
let isInitialized = false;

// 配置
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const DATA_KEY = 'class-photo-wall-data';
const KV_RETRY_TIMES = 3;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const KV_OP_TIMEOUT = 5000;

// ========== KV操作工具 ==========
async function withTimeout(promise, timeout = KV_OP_TIMEOUT) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`操作超时（${timeout}ms）`)), timeout)
    )
  ]);
}

async function kvOperation(fn, retry = KV_RETRY_TIMES) {
  if (!kv) {
    throw new Error(initError ? initError.message : 'KV 未初始化');
  }
  try {
    return await withTimeout(fn());
  } catch (err) {
    if (retry > 0) {
      console.warn(`KV操作失败，重试剩余次数: ${retry}`, err.message);
      await new Promise(resolve => setTimeout(resolve, 200));
      return kvOperation(fn, retry - 1);
    }
    throw new Error(`KV操作失败: ${err.message}`);
  }
}

// ========== 初始化逻辑 ==========
async function initData() {
  if (initError || !kv) {
    isInitialized = false;
    return;
  }
  try {
    const data = await kvOperation(() => kv.get(DATA_KEY));
    if (!data) {
      const initialData = { albums: [], photos: [], comments: [] };
      await kvOperation(() => kv.set(DATA_KEY, initialData));
      console.log('KV初始化成功，写入初始数据');
    }
    isInitialized = true;
    initError = null;
  } catch (err) {
    console.error('KV初始化失败:', err);
    initError = err;
    isInitialized = false;
  }
}

initData();

// ========== 请求拦截 ==========
app.use(async (req, res, next) => {
  if (req.path === '/api/health') return next();
  
  const waitInit = async () => {
    let waitTime = 0;
    while (!isInitialized && initError === null && waitTime < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitTime += 100;
    }
  };
  
  await waitInit();
  
  if (initError) {
    return res.status(500).json({ 
      code: 500, 
      msg: '服务初始化失败：' + initError.message 
    });
  }
  next();
});

// ========== 数据读写 ==========
async function readData() {
  try {
    const data = await kvOperation(() => kv.get(DATA_KEY));
    return data || { albums: [], photos: [], comments: [] };
  } catch (err) {
    console.error('读取数据失败:', err);
    return { albums: [], photos: [], comments: [] };
  }
}

async function saveData(data) {
  const safeData = {
    albums: data.albums || [],
    photos: data.photos || [],
    comments: data.comments || []
  };
  return await kvOperation(() => kv.set(DATA_KEY, safeData));
}

// ========== 上传配置 ==========
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { 
    fileSize: MAX_FILE_SIZE,
    fieldSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('仅支持JPG/PNG/GIF/WEBP格式'), false);
    }
    if (file.size > MAX_FILE_SIZE) {
      return cb(new Error('文件大小超过5MB限制'), false);
    }
    cb(null, true);
  }
});

// ========== 接口 ==========
app.get('/api/albums', async (req, res) => {
  try {
    const data = await readData();
    res.json({ code: 200, data: data.albums || [] });
  } catch (err) {
    console.error('获取专辑失败:', err);
    res.status(500).json({ code: 500, msg: '获取专辑失败：' + err.message });
  }
});

app.post('/api/albums', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim() === '') {
      return res.status(400).json({ code: 400, msg: '请输入专辑名称' });
    }
    
    const data = await readData();
    if (data.albums.some(album => album.name === name.trim())) {
      return res.status(400).json({ code: 400, msg: '专辑名称已存在' });
    }
    
    const newAlbum = {
      id: uuidv4(),
      name: name.trim(),
      coverUrl: '',
      createTime: Date.now()
    };
    data.albums.push(newAlbum);
    await saveData(data);
    res.json({ code: 200, msg: '创建成功', data: newAlbum });
  } catch (err) {
    console.error('创建专辑失败:', err);
    res.status(500).json({ code: 500, msg: '创建专辑失败：' + err.message });
  }
});

app.get('/api/photos/:albumId', async (req, res) => {
  try {
    const { albumId } = req.params;
    const data = await readData();
    const photos = (data.photos || []).filter(photo => photo.albumId === albumId);
    res.json({ code: 200, data: photos });
  } catch (err) {
    console.error('获取照片失败:', err);
    res.status(500).json({ code: 500, msg: '获取照片失败：' + err.message });
  }
});

app.post('/api/photos', upload.single('photo'), async (req, res) => {
  try {
    const { albumId } = req.body;
    if (!albumId) {
      return res.status(400).json({ code: 400, msg: '请选择专辑' });
    }
    
    const file = req.file;
    if (!file) {
      return res.status(400).json({ code: 400, msg: '请选择照片文件' });
    }

    if (file.buffer.length > MAX_FILE_SIZE) {
      return res.status(400).json({ code: 400, msg: '文件大小超过5MB限制' });
    }
    
    const base64Prefix = `data:${file.mimetype};base64,`;
    const base64Data = file.buffer.toString('base64');
    const base64 = base64Prefix + base64Data;
    const photoId = uuidv4();
    const photoUrl = `/api/photo/${photoId}`;
    
    const data = await readData();
    const album = (data.albums || []).find(item => item.id === albumId);
    if (!album) {
      return res.status(400).json({ code: 400, msg: '专辑不存在' });
    }
    
    const newPhoto = {
      id: photoId,
      albumId,
      url: photoUrl,
      createTime: Date.now()
    };
    data.photos = data.photos || [];
    data.photos.push(newPhoto);
    
    if (!album.coverUrl) {
      album.coverUrl = photoUrl;
    }
    
    let saveSuccess = false;
    try {
      await saveData(data);
      await kvOperation(() => kv.set(`photo:${photoId}`, base64));
      saveSuccess = true;
    } catch (saveErr) {
      if (!saveSuccess) {
        data.photos.pop();
        await saveData(data).catch(err => console.error('回滚失败:', err));
      }
      throw saveErr;
    }
    
    file.buffer = null;
    res.json({ code: 200, msg: '上传成功', data: newPhoto });
  } catch (err) {
    console.error('上传照片失败:', err);
    res.status(500).json({ code: 500, msg: '上传失败：' + err.message });
  }
});

app.get('/api/photo/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const base64 = await kvOperation(() => kv.get(`photo:${photoId}`));
    
    if (!base64) {
      return res.status(404).json({ code: 404, msg: '图片不存在' });
    }
    
    const matches = base64.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length < 3) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      res.send(Buffer.from(base64, 'base64'));
      return;
    }
    
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(buffer);
    
    buffer.fill(0);
  } catch (err) {
    console.error('加载图片失败:', err);
    res.status(500).json({ code: 500, msg: '图片加载失败：' + err.message });
  }
});

app.delete('/api/photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { pwd } = req.query;
    
    if (pwd !== ADMIN_PASSWORD) {
      return res.status(403).json({ code: 403, msg: '管理员密码错误' });
    }
    
    const data = await readData();
    const photoIndex = (data.photos || []).findIndex(item => item.id === photoId);
    if (photoIndex === -1) {
      return res.status(400).json({ code: 400, msg: '照片不存在' });
    }
    
    const photo = data.photos[photoIndex];
    await kvOperation(() => kv.del(`photo:${photoId}`));
    data.photos.splice(photoIndex, 1);
    
    const album = (data.albums || []).find(item => item.id === photo.albumId);
    if (album && album.coverUrl === photo.url) {
      const albumPhotos = (data.photos || []).filter(item => item.albumId === photo.albumId);
      album.coverUrl = albumPhotos.length > 0 ? albumPhotos[0].url : '';
    }
    
    data.comments = (data.comments || []).filter(item => item.photoId !== photoId);
    await saveData(data);
    
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error('删除照片失败:', err);
    res.status(500).json({ code: 500, msg: '删除失败：' + err.message });
  }
});

app.get('/api/comments/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const data = await readData();
    const comments = (data.comments || []).filter(item => item.photoId === photoId);
    res.json({ code: 200, data: comments });
  } catch (err) {
    console.error('获取评论失败:', err);
    res.status(500).json({ code: 500, msg: '获取评论失败：' + err.message });
  }
});

app.post('/api/comments', async (req, res) => {
  try {
    const { photoId, nick, text } = req.body;
    if (!photoId || !text || text.trim() === '') {
      return res.status(400).json({ code: 400, msg: '请填写完整信息' });
    }
    
    const data = await readData();
    const photo = (data.photos || []).find(item => item.id === photoId);
    if (!photo) {
      return res.status(400).json({ code: 400, msg: '照片不存在' });
    }
    
    const newComment = {
      id: uuidv4(),
      photoId,
      nick: (nick || '匿名').trim(),
      text: text.trim(),
      createTime: Date.now()
    };
    data.comments = data.comments || [];
    data.comments.push(newComment);
    await saveData(data);
    
    res.json({ code: 200, msg: '评论成功', data: newComment });
  } catch (err) {
    console.error('提交评论失败:', err);
    res.status(500).json({ code: 500, msg: '评论失败：' + err.message });
  }
});

app.delete('/api/comments/:commentId', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { pwd } = req.query;
    
    if (pwd !== ADMIN_PASSWORD) {
      return res.status(403).json({ code: 403, msg: '管理员密码错误' });
    }
    
    const data = await readData();
    const commentIndex = (data.comments || []).findIndex(item => item.id === commentId);
    if (commentIndex === -1) {
      return res.status(400).json({ code: 400, msg: '评论不存在' });
    }
    
    data.comments.splice(commentIndex, 1);
    await saveData(data);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error('删除评论失败:', err);
    res.status(500).json({ code: 500, msg: '删除评论失败：' + err.message });
  }
});

app.post('/api/verify-admin', (req, res) => {
  try {
    const { pwd } = req.body;
    if (pwd === ADMIN_PASSWORD) {
      res.json({ code: 200, msg: '验证成功' });
    } else {
      res.status(403).json({ code: 403, msg: '密码错误' });
    }
  } catch (err) {
    console.error('验证管理员密码失败:', err);
    res.status(500).json({ code: 500, msg: '验证失败：' + err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const data = await readData();
    res.json({
      code: 200,
      status: isInitialized ? 'ok' : 'initializing',
      initError: initError ? initError.message : null,
      data: {
        albums: (data.albums || []).length,
        photos: (data.photos || []).length,
        comments: (data.comments || []).length
      }
    });
  } catch (err) {
    res.status(500).json({ 
      code: 500, 
      status: 'error', 
      initError: initError ? initError.message : err.message 
    });
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason, promise);
});

process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`服务器启动成功：http://localhost:${PORT}`);
  });
}

module.exports = app;