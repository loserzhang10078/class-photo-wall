// 安装依赖：npm install express cors multer uuid @vercel/kv
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { kv } = require('@vercel/kv');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 管理员密码
const ADMIN_PASSWORD = '123456';

// 初始化 KV 存储
const DATA_KEY = 'class-photo-wall-data';
const UPLOAD_DIR = path.join(__dirname, 'uploads/photos');

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
initData();

// 读取/保存数据
async function readData() {
  return await kv.get(DATA_KEY);
}
async function saveData(data) {
  await kv.set(DATA_KEY, data);
}

// 配置multer上传（Vercel 无服务器环境用内存存储）
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
  const data = await readData();
  res.json({ code: 200, data: data.albums });
});

// 2. 创建专辑
app.post('/api/albums', async (req, res) => {
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
});

// 3. 获取专辑下的所有照片
app.get('/api/photos/:albumId', async (req, res) => {
  const { albumId } = req.params;
  const data = await readData();
  const photos = data.photos.filter(photo => photo.albumId === albumId);
  res.json({ code: 200, data: photos });
});

// 4. 上传照片（Base64 存储到 KV，避免文件丢失）
app.post('/api/photos', upload.single('photo'), async (req, res) => {
  try {
    const { albumId } = req.body;
    if (!albumId) return res.json({ code: 400, msg: '请选择专辑' });
    
    const file = req.file;
    if (!file) return res.json({ code: 400, msg: '请选择照片文件' });
    
    // 转成Base64存储
    const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
    const photoId = uuidv4();
    const photoUrl = `/api/photos/${photoId}`;
    
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
    
    if (!album.coverUrl) {
      album.coverUrl = photoUrl;
    }
    
    await saveData(data);
    // 把Base64也存到KV，方便接口返回
    await kv.set(`photo:${photoId}`, base64);
    res.json({ code: 200, msg: '上传成功', data: newPhoto });
  } catch (err) {
    res.json({ code: 500, msg: '上传失败：' + err.message });
  }
});

// 5. 照片接口（返回Base64图片）
app.get('/api/photos/:photoId', async (req, res) => {
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
});

// 6. 删除照片
app.delete('/api/photos/:photoId', async (req, res) => {
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
  
  const album = data.albums.find(item => item.id === photo.albumId);
  if (album && album.coverUrl === photo.url) {
    const albumPhotos = data.photos.filter(item => item.albumId === photo.albumId);
    album.coverUrl = albumPhotos.length > 0 ? albumPhotos[0].url : '';
  }
  
  data.comments = data.comments.filter(item => item.photoId !== photoId);
  await saveData(data);
  res.json({ code: 200, msg: '删除成功' });
});

// 7. 获取照片的评论
app.get('/api/comments/:photoId', async (req, res) => {
  const { photoId } = req.params;
  const data = await readData();
  const comments = data.comments.filter(item => item.photoId === photoId);
  res.json({ code: 200, data: comments });
});

// 8. 提交评论
app.post('/api/comments', async (req, res) => {
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
});

// 9. 删除评论
app.delete('/api/comments/:commentId', async (req, res) => {
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
});

// 10. 验证管理员密码
app.post('/api/verify-admin', (req, res) => {
  const { pwd } = req.body;
  if (pwd === ADMIN_PASSWORD) {
    res.json({ code: 200, msg: '验证成功' });
  } else {
    res.json({ code: 403, msg: '密码错误' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器启动成功：http://localhost:${PORT}`);
});