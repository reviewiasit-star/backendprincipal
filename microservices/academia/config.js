const mysql = require('mysql2');
const { dbHost, dbUser, dbPassword, dbName, dbPort } = require('./loadSecrets');

const DB_HOST = dbHost();
const DB_USER = dbUser();
const DB_PASSWORD = dbPassword();
const DB_NAME = dbName();
const DB_PORT = dbPort();

const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const dbConnectionConfig = {
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  port: DB_PORT
};

const poolPromise = pool.promise();
poolPromise.dbConnectionConfig = dbConnectionConfig;

module.exports = poolPromise;
