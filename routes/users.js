const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Все маршруты требуют аутентификации
router.use(authenticateToken);

// Получить список пользователей (только админ)
router.get('/', requireRole('admin'), (req, res) => {
  try {
    const { role } = req.query;

    let query = 'SELECT id, email, role, name, phone, created_at FROM users';
    const params = [];

    if (role) {
      query += ' WHERE role = ?';
      params.push(role);
    }

    query += ' ORDER BY created_at DESC';

    const users = db.prepare(query).all(...params);

    res.json(users);
  } catch (error) {
    console.error('Ошибка получения пользователей:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать пользователя (только админ)
router.post('/', requireRole('admin'), (req, res) => {
  try {
    const { email, password, role, name, phone } = req.body;

    if (!email || !password || !role || !name) {
      return res.status(400).json({ error: 'Email, пароль, роль и имя обязательны' });
    }

    if (!['admin', 'student', 'sales'].includes(role)) {
      return res.status(400).json({ error: 'Недопустимая роль' });
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const result = db.prepare(`
      INSERT INTO users (email, password, role, name, phone)
      VALUES (?, ?, ?, ?, ?)
    `).run(email, hashedPassword, role, name, phone || null);

    const user = db.prepare('SELECT id, email, role, name, phone, created_at FROM users WHERE id = ?')
      .get(result.lastInsertRowid);

    res.status(201).json(user);
  } catch (error) {
    console.error('Ошибка создания пользователя:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить пользователя (только админ)
router.patch('/:id', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const { email, role, name, phone, password } = req.body;

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const updates = [];
    const params = [];

    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email);
    }
    if (role !== undefined) {
      if (!['admin', 'student', 'sales'].includes(role)) {
        return res.status(400).json({ error: 'Недопустимая роль' });
      }
      updates.push('role = ?');
      params.push(role);
    }
    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(phone);
    }
    if (password !== undefined) {
      const hashedPassword = bcrypt.hashSync(password, 10);
      updates.push('password = ?');
      params.push(hashedPassword);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Нет данных для обновления' });
    }

    params.push(id);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedUser = db.prepare('SELECT id, email, role, name, phone, created_at FROM users WHERE id = ?')
      .get(id);

    res.json(updatedUser);
  } catch (error) {
    console.error('Ошибка обновления пользователя:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить пользователя (только админ)
router.delete('/:id', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;

    // Нельзя удалить себя
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Нельзя удалить свой аккаунт' });
    }

    const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({ message: 'Пользователь удален' });
  } catch (error) {
    console.error('Ошибка удаления пользователя:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
