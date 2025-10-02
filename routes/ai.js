const express = require('express');
const db = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Все маршруты требуют аутентификации и роль админа
router.use(authenticateToken);
router.use(requireRole('admin'));

// Получить историю чата
router.get('/chats', (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const chats = db.prepare(`
      SELECT * FROM ai_chats
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(req.user.id, parseInt(limit));

    res.json(chats.reverse()); // Возвращаем в хронологическом порядке
  } catch (error) {
    console.error('Ошибка получения истории чата:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отправить сообщение (простая заглушка для ИИ)
router.post('/chat', (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Сообщение обязательно' });
    }

    // Простая заглушка ИИ ответа
    const aiResponse = generateAIResponse(message);

    const result = db.prepare(`
      INSERT INTO ai_chats (user_id, message, response)
      VALUES (?, ?, ?)
    `).run(req.user.id, message, aiResponse);

    const chat = db.prepare('SELECT * FROM ai_chats WHERE id = ?').get(result.lastInsertRowid);

    res.json(chat);
  } catch (error) {
    console.error('Ошибка отправки сообщения:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить историю чата
router.delete('/chats', (req, res) => {
  try {
    db.prepare('DELETE FROM ai_chats WHERE user_id = ?').run(req.user.id);

    res.json({ message: 'История чата удалена' });
  } catch (error) {
    console.error('Ошибка удаления истории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Простая функция-заглушка для генерации ответов ИИ
function generateAIResponse(message) {
  const lowerMessage = message.toLowerCase();

  // Простые ответы на основе ключевых слов
  if (lowerMessage.includes('привет') || lowerMessage.includes('здравствуй')) {
    return 'Здравствуйте! Я помощник ORTA STUDY. Чем могу помочь?';
  }

  if (lowerMessage.includes('студент') || lowerMessage.includes('ученик')) {
    return 'Я могу помочь вам с управлением студентами. Вы можете добавлять новых студентов, просматривать их список и редактировать информацию через админ-панель.';
  }

  if (lowerMessage.includes('заявк') || lowerMessage.includes('лид')) {
    return 'Для работы с заявками перейдите в раздел "Панель продажника". Там вы можете просмотреть все входящие заявки, назначить их на менеджеров и отслеживать статусы.';
  }

  if (lowerMessage.includes('расписание')) {
    return 'Функция управления расписанием находится в разработке. Скоро вы сможете создавать расписания для учителей и студентов.';
  }

  if (lowerMessage.includes('помощь') || lowerMessage.includes('помоги')) {
    return 'Я могу помочь вам с:\n- Управлением студентами\n- Работой с заявками\n- Навигацией по системе\n- Ответами на вопросы о функциях\n\nЗадайте мне любой вопрос!';
  }

  // Ответ по умолчанию
  return 'Спасибо за ваш вопрос. Я помощник ORTA STUDY и могу помочь вам с управлением образовательным центром. Пожалуйста, уточните ваш вопрос, и я постараюсь помочь.';
}

module.exports = router;
