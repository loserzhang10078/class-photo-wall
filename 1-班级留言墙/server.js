const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { kv } = require('@vercel/kv');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 管理员密码（可自行修改）
const ADMIN_PASSWORD = '123456';
const DATA_KEY = 'class-photo-wall-data';

// 初始化数据（KV为空时写入初始结构）
async function initData() {
  const data = await kv.get(DATA_KEY);
  if (!data) {
    await kv.set(DATA_KEY, {
      albums: [],
      photos: [],
      comments: []
    });
  }
}
initData().catch(err => console.error('KV初始化失败:', err));

// 读取/保存数据
async function readData() {
  return await kv.get(DATA_KEY);
}
async function saveData(data) {
  await kv.set(DATA_KEY, data);
}

// 配置multer（Vercel无服务器环境必须用内存存储）
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 限制10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持JPG/PNG/GIF/WEBP格式'), false);
    }
  }
});

// ------------------- 接口定义 -------------------
// 1. 获取所有专辑
app.get('/api/albums', async (req, res) => {
  try {
    const data = await readData();
    res.json({ code: 200, data: data.albums });
  } catch (err) {
    res.json({ code: 500, msg: '获取专辑失败：' + err.message });
  }
});

// 2. 创建专辑
app.post('/api/albums', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.json({ code: 400, msg: '请输入专辑名称' });
    
    const data = await readData();
    if (data.albums.some(album => album.name === name)) {
      return res.json({ code: 400, msg: '专辑名称已存在' });
    }
    
    const newAlbum = {
      id: uuidv4(),
      name,
      coverUrl: '',
      createTime: Date.now()
    };
    data.albums.push(newAlbum);
    await saveData(data);
    res.json({ code: 200, msg: '创建成功', data: newAlbum });
  } catch (err) {
    res.json({ code: 500, msg: '创建专辑失败：' + err.message });
  }
});

// 3. 获取专辑下的所有照片
app.get('/api/photos/:albumId', async (req, res) => {
  try {
    const { albumId } = req.params;
    const data = await readData();
    const photos = data.photos.filter(photo => photo.albumId === albumId);
    res.json({ code: 200, data: photos });
  } catch (err) {
    res.json({ code: 500, msg: '获取照片失败：' + err.message });
  }
});

// 4. 上传照片（Base64存储到KV，避免文件丢失）
app.post('/api/photos', upload.single('photo'), async (req, res) => {
  try {
    const { albumId } = req.body;
    if (!albumId) return res.json({ code: 400, msg: '请选择专辑' });
    
    const file = req.file;
    if (!file) return res.json({ code: 400, msg: '请选择照片文件' });
    
    // 转成Base64存储
    const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    const photoId = uuidv4();
    const photoUrl = `/api/photo/${photoId}`;
    
    const data = await readData();
    const album = data.albums.find(item => item.id === albumId);
    if (!album) return res.json({ code: 400, msg: '专辑不存在' });
    
    const newPhoto = {
      id: photoId,
      albumId,
      url: photoUrl,
      createTime: Date.now()
    };
    data.photos.push(newPhoto);
    
    // 设置专辑封面
    if (!album.coverUrl) {
      album.coverUrl = photoUrl;
    }
    
    await saveData(data);
    await kv.set(`photo:${photoId}`, base64);
    res.json({ code: 200, msg: '上传成功', data: newPhoto });
  } catch (err) {
    res.json({ code: 500, msg: '上传失败：' + err.message });
  }
});

// 5. 照片接口（返回Base64图片）
app.get('/api/photo/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const base64 = await kv.get(`photo:${photoId}`);
    if (!base64) return res.status(404).send('Not found');
    
    // 解析Base64
    const matches = base64.match(/^data:(.+);base64,(.+)$/);
    if (!matches) return res.status(400).send('Invalid image');
    
    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    res.setHeader('Content-Type', mimeType);
    res.send(buffer);
  } catch (err) {
    res.status(500).send('图片加载失败：' + err.message);
  }
});

// 6. 删除照片
app.delete('/api/photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const { pwd } = req.query;
    
    if (pwd !== ADMIN_PASSWORD) {
      return res.json({ code: 403, msg: '管理员密码错误' });
    }
    
    const data = await readData();
    const photoIndex = data.photos.findIndex(item => item.id === photoId);
    if (photoIndex === -1) {
      return res.json({ code: 400, msg: '照片不存在' });
    }
    
    const photo = data.photos[photoIndex];
    await kv.del(`photo:${photoId}`);
    data.photos.splice(photoIndex, 1);
    
    // 更新专辑封面
    const album = data.albums.find(item => item.id === photo.albumId);
    if (album && album.coverUrl === photo.url) {
      const albumPhotos = data.photos.filter(item => item.albumId === photo.albumId);
      album.coverUrl = albumPhotos.length > 0 ? albumPhotos[0].url : '';
    }
    
    // 删除关联评论
    data.comments = data.comments.filter(item => item.photoId !== photoId);
    await saveData(data);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    res.json({ code: 500, msg: '删除失败：' + err.message });
  }
});

// 7. 获取照片的评论
app.get('/api/comments/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    const data = await readData();
    const comments = data.comments.filter(item => item.photoId === photoId);
    res.json({ code: 200, data: comments });
  } catch (err) {
    res.json({ code: 500, msg: '获取评论失败：' + err.message });
  }
});

// 8. 提交评论
app.post('/api/comments', async (req, res) => {
  try {
    const { photoId, nick, text } = req.body;
    if (!photoId || !text) {
      return res.json({ code: 400, msg: '请填写完整信息' });
    }
    
    const data = await readData();
    const photo = data.photos.find(item => item.id === photoId);
    if (!photo) return res.json({ code: 400, msg: '照片不存在' });
    
    const newComment = {
      id: uuidv4(),
      photoId,
      nick: nick || '匿名',
      text,
      createTime: Date.now()
    };
    data.comments.push(newComment);
    await saveData(data);
    
    res.json({ code: 200, msg: '评论成功', data: newComment });
  } catch (err) {
    res.json({ code: 500, msg: '评论失败：' + err.message });
  }
});

// 9. 删除评论
app.delete('/api/comments/:commentId', async (req, res) => {
  try {
    const { commentId } = req.params;
    const { pwd } = req.query;
    
    if (pwd !== ADMIN_PASSWORD) {
      return res.json({ code: 403, msg: '管理员密码错误' });
    }
    
    const data = await readData();
    const commentIndex = data.comments.findIndex(item => item.id === commentId);
    if (commentIndex === -1) {
      return res.json({ code: 400, msg: '评论不存在' });
    }
    
    data.comments.splice(commentIndex, 1);
    await saveData(data);
    res.json({ code: 200, msg: '删除成功' });
  } catch (err) {
    res.json({ code: 500, msg: '删除评论失败：' + err.message });
  }
});

// 10. 验证管理员密码
app.post('/api/verify-admin', (req, res) => {
  try {
    const { pwd } = req.body;
    if (pwd === ADMIN_PASSWORD) {
      res.json({ code: 200, msg: '验证成功' });
    } else {
      res.json({ code: 403, msg: '密码错误' });
    }
  } catch (err) {
    res.json({ code: 500, msg: '验证失败：' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`服务器启动成功：http://localhost:${PORT}`);
  });
}

module.exports = app;