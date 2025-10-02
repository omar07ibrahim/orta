const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Вход в систему
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const { password: _, ...userWithoutPassword } = user;

    res.json({
      token,
      user: userWithoutPassword
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Регистрация (только студенты могут регистрироваться)
router.post('/register', (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, пароль и имя обязательны' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const result = db.prepare(`
      INSERT INTO users (email, password, role, name, phone)
      VALUES (?, ?, 'student', ?, ?)
    `).run(email, hashedPassword, name, phone || null);

    const token = jwt.sign(
      { id: result.lastInsertRowid, email, role: 'student' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const user = db.prepare('SELECT id, email, role, name, phone, created_at FROM users WHERE id = ?')
      .get(result.lastInsertRowid);

    res.status(201).json({
      token,
      user
    });
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение текущего пользователя
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, role, name, phone, created_at FROM users WHERE id = ?')
      .get(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(user);
  } catch (error) {
    console.error('Ошибка получения пользователя:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
