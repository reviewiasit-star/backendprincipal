const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../microservices/academia/appConfig');

const authMiddleware = (req, res, next) => {
  try {
    // Obtener el token del header Authorization
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        message: 'Token de acceso requerido'
      });
    }

    // Extraer el token (remover "Bearer ")
    const token = authHeader.substring(7);

    // Verificar el token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Agregar la información del usuario al request
    req.user = decoded;
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        ok: false,
        message: 'Token expirado'
      });
    }
    
    return res.status(401).json({
      ok: false,
      message: 'Token inválido'
    });
  }
};

module.exports = { authMiddleware, JWT_SECRET }; 