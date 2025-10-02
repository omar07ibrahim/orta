const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'orta-study.db'));

// Создаем таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'student', 'sales')),
    name TEXT NOT NULL,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT NOT NULL,
    message TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new', 'contacted', 'converted', 'rejected')),
    assigned_to INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (assigned_to) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ai_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Создаем индексы для оптимизации
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_ai_chats_user ON ai_chats(user_id);
`);

// Создаем админа по умолчанию если его нет
const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');

if (!adminExists) {
  const hashedPassword = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO users (email, password, role, name, phone)
    VALUES (?, ?, ?, ?, ?)
  `).run('admin@orta.study', hashedPassword, 'admin', 'Администратор', '+77771234567');

  console.log('✅ Создан админ: admin@orta.study / admin123');
}

// Создаем тестового продажника если его нет
const salesExists = db.prepare('SELECT id FROM users WHERE role = ?').get('sales');

if (!salesExists) {
  const hashedPassword = bcrypt.hashSync('sales123', 10);
  db.prepare(`
    INSERT INTO users (email, password, role, name, phone)
    VALUES (?, ?, ?, ?, ?)
  `).run('sales@orta.study', hashedPassword, 'sales', 'Менеджер по продажам', '+77771234568');

  console.log('✅ Создан продажник: sales@orta.study / sales123');
}

console.log('✅ База данных инициализирована');

module.exports = db;
