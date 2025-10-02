const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Инициализация БД
require('./database');

// Импорт маршрутов
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const leadsRoutes = require('./routes/leads');
const aiRoutes = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API маршруты
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/ai', aiRoutes);

// Статические файлы (для продакшена)
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

// Обработка ошибок
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║   🎓 ORTA STUDY Server                     ║
║                                            ║
║   Сервер запущен на порту ${PORT}           ║
║   http://localhost:${PORT}                 ║
║                                            ║
║   📚 API Endpoints:                        ║
║   - POST /api/auth/login                   ║
║   - POST /api/auth/register                ║
║   - GET  /api/auth/me                      ║
║   - GET  /api/users                        ║
║   - POST /api/users                        ║
║   - GET  /api/leads                        ║
║   - POST /api/leads                        ║
║   - GET  /api/ai/chats                     ║
║   - POST /api/ai/chat                      ║
║                                            ║
║   👤 Тестовые аккаунты:                    ║
║   Админ: admin@orta.study / admin123       ║
║   Продажи: sales@orta.study / sales123     ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
});
