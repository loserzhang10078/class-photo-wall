const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { kv } = require('@vercel/kv');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // 增加JSON解析限制
app.use(express.static(path.join(__dirname, 'public')));

// 配置
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456'; // 改用环境变量
const DATA_KEY = 'class-photo-wall-data';
const KV_RETRY_TIMES = 2; // KV操作重试次数
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 降低文件大小限制到5MB（Vercel内存限制）

// 通用KV操作工具（带重试）
async function kvOperation(fn, retry = KV_RETRY_TIMES) {
  try {
    return await fn();
  } catch (err) {
    if (retry > 0) {
      console.warn(`KV操作失败，重试剩余次数: ${retry}`, err.message);
      await new Promise(resolve => setTimeout(resolve, 100)); // 重试间隔
      return kvOperation(fn, retry - 1);
    }
    throw new Error(`KV操作失败: ${err.message}`);
  }
}

// 初始化数据（确保初始化成功）
async function initData() {
  try {
    const data = await kvOperation(() => kv.get(DATA_KEY));
    if (!data) {
      const initialData = { albums: [], photos: [], comments: [] };
      await kvOperation(() => kv.set(DATA_KEY, initialData));
      console.log('KV初始化成功，写入初始数据');
    }
  } catch (err) {
    console.error('KV初始化失败:', err);
    throw err; // 初始化失败终止服务
  }
}

// 等待初始化完成后再启动服务
initData().catch(err => {
  console.error('初始化失败，服务启动终止:', err);
  process.exit(1); // 退出进程，避免服务异常运行
});

// 读取/保存数据（封装KV操作）
async function readData() {
  return await kvOperation(() => kv.get(DATA_KEY));
}

async function saveData(data) {
  return await kvOperation(() => kv.set(DATA_KEY, data));
}

// 配置multer（严格限制）
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { 
    fileSize: MAX_FILE_SIZE, // 降低限制，避免内存溢出
    fieldSize: 10 * 1024 * 1024 // 增加字段大小限制
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持JPG/PNG/GIF/WEBP格式'), false);
    }
  }
});

// ------------------- 接口定义（增加错误捕获和日志） -------------------
// 1. 获取所有专辑
app.get('/api/albums', async (req, res) => {
  try {
    const data = await readData();
    res.json({ code: 200, data: data.albums || [] }); // 兜底空数组
  } catch (err) {
    console.error('获取专辑失败:', err);
    res.status(500).json({ code: 500, msg: '获取专辑失败：' + err.message });
  }
});

// 2. 创建专辑
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

// 3. 获取专辑下的所有照片
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

// 4. 上传照片（优化Base64处理）
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

    // 防止超大Base64（提前校验）
    if (file.buffer.length > MAX_FILE_SIZE) {
      return res.status(400).json({ code: 400, msg: '文件大小超过5MB限制' });
    }
    
    // 转成Base64存储（优化编码）
    const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
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
    
    // 设置专辑封面
    if (!album.coverUrl) {
      album.coverUrl = photoUrl;
    }
    
    // 先保存主数据，再保存照片（避免数据不一致）
    await saveData(data);
    await kvOperation(() => kv.set(`photo:${photoId}`, base64));
    
    res.json({ code: 200, msg: '上传成功', data: newPhoto });
  } catch (err) {
    console.error('上传照片失败:', err);
    res.status(500).json({ code: 500, msg: '上传失败：' + err.message });
  }
});

// 5. 照片接口（优化错误处理）
app.get('/api/photo/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const base64 = await kvOperation(() => kv.get(`photo:${photoId}`));
    
    if (!base64) {
      return res.status(404).json({ code: 404, msg: '图片不存在' });
    }
    
    // 解析Base64（增加校验）
    const matches = base64.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length < 3) {
      return res.status(400).json({ code: 400, msg: '无效的图片格式' });
    }
    
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 增加缓存
    res.send(buffer);
  } catch (err) {
    console.error('加载图片失败:', err);
    res.status(500).send('图片加载失败：' + err.message);
  }
});

// 6. 删除照片
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
    // 先删除KV中的照片，再更新主数据
    await kvOperation(() => kv.del(`photo:${photoId}`));
    data.photos.splice(photoIndex, 1);
    
    // 更新专辑封面
    const album = (data.albums || []).find(item => item.id === photo.albumId);
    if (album && album.coverUrl === photo.url) {
      const albumPhotos = (data.photos || []).filter(item => item.albumId === photo.albumId);
      album.coverUrl = albumPhotos.length > 0 ? albumPhotos[0].url : '';
    }
    
    // 删除关联评论
    data.comments = (data.comments || []).filter(item => item.photoId !== photoId);
    await saveData(data);
    
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    console.error('删除照片失败:', err);
    res.status(500).json({ code: 500, msg: '删除失败：' + err.message });
  }
});

// 7. 获取照片的评论
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

// 8. 提交评论
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

// 9. 删除评论
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

// 10. 验证管理员密码
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

// 健康检查接口（用于排查）
app.get('/api/health', async (req, res) => {
  try {
    const data = await readData();
    res.json({
      code: 200,
      status: 'ok',
      data: {
        albums: (data.albums || []).length,
        photos: (data.photos || []).length,
        comments: (data.comments || []).length
      }
    });
  } catch (err) {
    res.status(500).json({ code: 500, status: 'error', msg: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`服务器启动成功：http://localhost:${PORT}`);
  });
}

module.exports = app;