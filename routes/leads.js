const express = require('express');
const db = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Создать заявку (публичный доступ)
router.post('/', (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Имя и телефон обязательны' });
    }

    const result = db.prepare(`
      INSERT INTO leads (name, email, phone, message)
      VALUES (?, ?, ?, ?)
    `).run(name, email || null, phone, message || null);

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);

    res.status(201).json(lead);
  } catch (error) {
    console.error('Ошибка создания заявки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить список заявок (только админ и продажник)
router.get('/', authenticateToken, requireRole('admin', 'sales'), (req, res) => {
  try {
    const { status, assigned_to } = req.query;

    let query = `
      SELECT l.*, u.name as assigned_to_name
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      query += ' AND l.status = ?';
      params.push(status);
    }

    if (assigned_to) {
      query += ' AND l.assigned_to = ?';
      params.push(assigned_to);
    }

    // Продажники видят только свои заявки
    if (req.user.role === 'sales') {
      query += ' AND (l.assigned_to = ? OR l.assigned_to IS NULL)';
      params.push(req.user.id);
    }

    query += ' ORDER BY l.created_at DESC';

    const leads = db.prepare(query).all(...params);

    res.json(leads);
  } catch (error) {
    console.error('Ошибка получения заявок:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить заявку по ID
router.get('/:id', authenticateToken, requireRole('admin', 'sales'), (req, res) => {
  try {
    const { id } = req.params;

    const lead = db.prepare(`
      SELECT l.*, u.name as assigned_to_name
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      WHERE l.id = ?
    `).get(id);

    if (!lead) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    // Продажники видят только свои заявки
    if (req.user.role === 'sales' && lead.assigned_to !== req.user.id && lead.assigned_to !== null) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    res.json(lead);
  } catch (error) {
    console.error('Ошибка получения заявки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить заявку
router.patch('/:id', authenticateToken, requireRole('admin', 'sales'), (req, res) => {
  try {
    const { id } = req.params;
    const { status, assigned_to } = req.body;

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

    if (!lead) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    // Продажники могут обновлять только свои заявки
    if (req.user.role === 'sales' && lead.assigned_to !== req.user.id && lead.assigned_to !== null) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }

    const updates = [];
    const params = [];

    if (status !== undefined) {
      if (!['new', 'contacted', 'converted', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'Недопустимый статус' });
      }
      updates.push('status = ?');
      params.push(status);
    }

    if (assigned_to !== undefined) {
      // Только админ может назначать заявки
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Недостаточно прав для назначения заявок' });
      }
      updates.push('assigned_to = ?');
      params.push(assigned_to);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');

    if (updates.length === 1) { // только updated_at
      return res.status(400).json({ error: 'Нет данных для обновления' });
    }

    params.push(id);

    db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updatedLead = db.prepare(`
      SELECT l.*, u.name as assigned_to_name
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      WHERE l.id = ?
    `).get(id);

    res.json(updatedLead);
  } catch (error) {
    console.error('Ошибка обновления заявки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить заявку (только админ)
router.delete('/:id', authenticateToken, requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;

    const result = db.prepare('DELETE FROM leads WHERE id = ?').run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    res.json({ message: 'Заявка удалена' });
  } catch (error) {
    console.error('Ошибка удаления заявки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
