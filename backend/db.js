const mysql = require("mysql2/promise");

const mysqlPool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "UTF8MB4_UNICODE_CI",
  waitForConnections: true,
  connectionLimit: 25,
  connectTimeout: 10000,
  queueLimit: 0,
});

// Thin async getter kept for compatibility with existing route files that expect
// getMysqlPool(res) to be passed as a callback parameter.
async function getMysqlPool(res) {
  if (!mysqlPool) {
    if (res) res.status(500).json({ message: "Database not available" });
    return null;
  }
  return mysqlPool;
}

module.exports = { mysqlPool, getMysqlPool };
