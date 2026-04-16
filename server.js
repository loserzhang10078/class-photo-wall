// 安装依赖：npm install express cors multer fs-extra uuid
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // 静态文件目录（放前端页面）

// 配置存储路径
const PHOTO_DIR = path.join(__dirname, 'uploads/photos');
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = '123456'; // 管理员密码

// 初始化目录和数据文件
fs.ensureDirSync(PHOTO_DIR);
if (!fs.existsSync(DATA_FILE)) {
  fs.writeJsonSync(DATA_FILE, {
    albums: [], // 专辑列表
    photos: [], // 照片列表
    comments: [] // 评论列表
  }, { spaces: 2 });
}

// 读取/保存数据
const readData = () => fs.readJsonSync(DATA_FILE);
const saveData = (data) => fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });

// 配置multer上传（处理图片文件）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename = `${uuidv4()}${ext}`;
    cb(null, filename);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 限制20MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持JPG/PNG/GIF/WEBP格式'), false);
    }
  }
});

// ------------------- 接口定义 -------------------
// 1. 获取所有专辑
app.get('/api/albums', (req, res) => {
  const data = readData();
  res.json({ code: 200, data: data.albums });
});

// 2. 创建专辑
app.post('/api/albums', (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ code: 400, msg: '请输入专辑名称' });
  
  const data = readData();
  // 检查重名
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
  saveData(data);
  res.json({ code: 200, msg: '创建成功', data: newAlbum });
});

// 3. 获取专辑下的所有照片
app.get('/api/photos/:albumId', (req, res) => {
  const { albumId } = req.params;
  const data = readData();
  const photos = data.photos.filter(photo => photo.albumId === albumId);
  res.json({ code: 200, data: photos });
});

// 4. 上传照片
app.post('/api/photos', upload.single('photo'), (req, res) => {
  try {
    const { albumId } = req.body;
    if (!albumId) return res.json({ code: 400, msg: '请选择专辑' });
    
    const file = req.file;
    if (!file) return res.json({ code: 400, msg: '请选择照片文件' });
    
    // 照片访问地址
    const photoUrl = `/uploads/photos/${file.filename}`;
    
    const data = readData();
    // 检查专辑是否存在
    const album = data.albums.find(item => item.id === albumId);
    if (!album) return res.json({ code: 400, msg: '专辑不存在' });
    
    // 创建照片记录
    const newPhoto = {
      id: uuidv4(),
      albumId,
      url: photoUrl,
      filename: file.filename,
      createTime: Date.now()
    };
    data.photos.push(newPhoto);
    
    // 如果是专辑第一张照片，设置为封面
    if (!album.coverUrl) {
      album.coverUrl = photoUrl;
    }
    
    saveData(data);
    res.json({ code: 200, msg: '上传成功', data: newPhoto });
  } catch (err) {
    res.json({ code: 500, msg: '上传失败：' + err.message });
  }
});

// 5. 删除照片
app.delete('/api/photos/:photoId', (req, res) => {
  const { photoId } = req.params;
  const { pwd } = req.query;
  
  // 验证管理员密码
  if (pwd !== ADMIN_PASSWORD) {
    return res.json({ code: 403, msg: '管理员密码错误' });
  }
  
  const data = readData();
  const photoIndex = data.photos.findIndex(item => item.id === photoId);
  if (photoIndex === -1) {
    return res.json({ code: 400, msg: '照片不存在' });
  }
  
  const photo = data.photos[photoIndex];
  // 删除图片文件
  fs.unlinkSync(path.join(PHOTO_DIR, photo.filename));
  
  // 删除照片记录
  data.photos.splice(photoIndex, 1);
  
  // 更新专辑封面（如果删除的是封面）
  const album = data.albums.find(item => item.id === photo.albumId);
  if (album && album.coverUrl === photo.url) {
    const albumPhotos = data.photos.filter(item => item.albumId === photo.albumId);
    album.coverUrl = albumPhotos.length > 0 ? albumPhotos[0].url : '';
  }
  
  // 删除该照片的所有评论
  data.comments = data.comments.filter(item => item.photoId !== photoId);
  
  saveData(data);
  res.json({ code: 200, msg: '删除成功' });
});

// 6. 获取照片的评论
app.get('/api/comments/:photoId', (req, res) => {
  const { photoId } = req.params;
  const data = readData();
  const comments = data.comments.filter(item => item.photoId === photoId);
  res.json({ code: 200, data: comments });
});

// 7. 提交评论
app.post('/api/comments', (req, res) => {
  const { photoId, nick, text } = req.body;
  if (!photoId || !text) {
    return res.json({ code: 400, msg: '请填写完整信息' });
  }
  
  const data = readData();
  // 检查照片是否存在
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
  saveData(data);
  
  res.json({ code: 200, msg: '评论成功', data: newComment });
});

// 8. 删除评论
app.delete('/api/comments/:commentId', (req, res) => {
  const { commentId } = req.params;
  const { pwd } = req.query;
  
  if (pwd !== ADMIN_PASSWORD) {
    return res.json({ code: 403, msg: '管理员密码错误' });
  }
  
  const data = readData();
  const commentIndex = data.comments.findIndex(item => item.id === commentId);
  if (commentIndex === -1) {
    return res.json({ code: 400, msg: '评论不存在' });
  }
  
  data.comments.splice(commentIndex, 1);
  saveData(data);
  res.json({ code: 200, msg: '删除成功' });
});

// 9. 验证管理员密码
app.post('/api/verify-admin', (req, res) => {
  const { pwd } = req.body;
  if (pwd === ADMIN_PASSWORD) {
    res.json({ code: 200, msg: '验证成功' });
  } else {
    res.json({ code: 403, msg: '密码错误' });
  }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`服务器启动成功：http://localhost:${PORT}`);
  console.log(`访问地址：http://localhost:${PORT}`);
});