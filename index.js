const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const pool = require("./microservices/academia/config");
const { PORT: APP_PORT } = require("./microservices/academia/appConfig");
const whatsappRoutes = require("./microservices/academia/whatsappRoutes");
const historialChatRoutes = require("./microservices/academia/historialChatRoutes");
const aiAdminRoutes = require("./microservices/academia/ai-admin-routes");
const notificacionesRoutes = require("./microservices/academia/notificaciones-routes");
const documentosRoutes = require("./microservices/academia/documentosRoutes");
const uploadRoutes = require("./microservices/academia/uploadRoutes");
const ocrComprobantesPublicRoutes = require("./microservices/academia/ocrComprobantesPublicRoutes");
const ocrComprobantesRoutes = require("./microservices/academia/ocrComprobantesRoutes");
const {
  configurarRutasUsuarios,
} = require("./microservices/academia/Usuarios");
const {
  configurarRutasEstudiantes,
} = require("./microservices/academia/Estudiantes");
const {
  configurarRutasGestionAcademica,
} = require("./microservices/academia/GestionAcademico");
const reporteInscripcionRoutes = require("./microservices/academia/ReporteInscripcion");
const {
  configurarRutasProductos,
} = require("./microservices/tienda/GestionProductos");
const comprobantesRoutes = require("./microservices/pagos/comprobantesRoutes");
const { configurarRutasEstudiantesCajas } = require("./microservices/academia/estudiantesCajas");

const app = express();

// --- Configuración de CORS ---
const { getPublicFrontendUrl } = require("./microservices/academia/appConfig");
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3001",
  "https://frontue-production.up.railway.app",
  getPublicFrontendUrl(),
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Permitir peticiones sin origin (ej: Postman, herramientas de backend)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS bloqueado para: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
// Servir imágenes de productos de tienda
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
// Aumentar límite de tamaño para JSON y URL-encoded (50MB)
// Importante: NO intentar parsear multipart/form-data como JSON o URL-encoded
const jsonParser = express.json({ limit: "50mb" });
const urlEncodedParser = express.urlencoded({ limit: "50mb", extended: true });
app.use((req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.startsWith("multipart/form-data")) {
    return next(); // Saltar ambos parsers para multipart
  }
  jsonParser(req, res, () => {
    urlEncodedParser(req, res, next);
  });
});
const { authMiddleware } = require("./middleware/auth");

// Rutas de WhatsApp
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api/historial-chat", historialChatRoutes);
// Subida de PDFs (para envío por WhatsApp)
app.use("/api/upload", uploadRoutes);
// Ruta de chat IA para panel de administración
app.use("/api/ai-admin", aiAdminRoutes);
// Ruta de chat IA con LangChain para Director y Secretaria (separada del agente principal)
const aiAdminLangChainRoutes = require("./microservices/academia/ai-admin-langchain-routes");
app.use("/api/ai-admin-langchain", aiAdminLangChainRoutes);
// Rutas de notificaciones automáticas y manuales
app.use("/api/notificaciones", notificacionesRoutes);
// Rutas de gestión de documentos del agente inteligente
app.use("/api/documentos-agente", documentosRoutes);
// Rutas de memorias del agente inteligente (avisos institucionales)
const agenteMemoriasRoutes = require("./microservices/academia/agenteMemoriasRoutes");
app.use("/api/agente-memorias", agenteMemoriasRoutes);
// Endpoint para descargar reportes PDF generados por el agente
const {
  REPORTES_DIR,
} = require("./microservices/academia/agenteReportesPDFService");
app.get("/api/reportes-agente/descargar/:nombre", (req, res) => {
  try {
    const nombre = decodeURIComponent(req.params.nombre).replace(/\.\./g, "");
    const rutaPDF = path.join(REPORTES_DIR, nombre);
    if (!fs.existsSync(rutaPDF)) {
      return res
        .status(404)
        .json({ ok: false, message: "El reporte no existe o ya expiró" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${nombre}"`);
    fs.createReadStream(rutaPDF).pipe(res);
  } catch (e) {
    res.status(500).json({ ok: false, message: "Error al servir el PDF" });
  }
});
// Rutas de comprobantes OCR (lectura por panel/admin)
app.use("/api/ocr-comprobantes", ocrComprobantesRoutes);
// Ruta pública para recepción de comprobantes (padres/tutores)
app.use("/api/ocr-comprobantes-public", ocrComprobantesPublicRoutes);

// Configurar rutas de usuarios y autenticación
configurarRutasUsuarios(app, pool, authMiddleware, jwt);

// Configurar rutas de estudiantes e inscripciones
configurarRutasEstudiantes(app, pool, authMiddleware);

// Configurar rutas de gestión académica
configurarRutasGestionAcademica(app, pool, authMiddleware);

// Configurar rutas de reportes de inscripción
reporteInscripcionRoutes(app, authMiddleware);

// Configurar rutas del módulo de Tienda
configurarRutasProductos(app, pool, authMiddleware);

// Rutas de comprobantes firmados (upload, view, download, delete)
app.use("/api/comprobantes", comprobantesRoutes);

// Rutas de estudiantes para módulo de cajas (servicios-estudiante, busqueda-basica, buscar-por-ci)
configurarRutasEstudiantesCajas(app, pool, authMiddleware);

// Configurar rutas de reportes de pagos (solo lectura para Admin/Director)
const { configurarRutasReportes } = require("./microservices/pagos/reportes");
configurarRutasReportes(app, pool, authMiddleware);

// Configurar rutas de dashboard de pagos (solo lectura para Admin/Director)
const {
  configurarRutasDashboardPagos,
} = require("./microservices/pagos/dashboardPagos");
configurarRutasDashboardPagos(app, pool, authMiddleware);

// Configurar rutas de ingresos académicos (solo lectura para Admin/Director)
const {
  configurarRutasIngresosAcademicos,
} = require("./microservices/pagos/ingresosAcademicos");
configurarRutasIngresosAcademicos(app, pool, authMiddleware);

// Configurar rutas de compromiso económico y pagos
const {
  configurarRutasCompromisoEconomico,
} = require("./microservices/pagos/compromisoEconomico");
configurarRutasCompromisoEconomico(app, pool, authMiddleware);

// Configurar rutas de análisis autónomo del agente inteligente
const analisisAutonomoRoutes = require("./microservices/academia/analisisAutonomoRoutes");
app.use("/api/analisis-autonomo", analisisAutonomoRoutes);

// Endpoint para obtener becas
app.get("/api/becas", authMiddleware, async (req, res) => {
  try {
    const [becas] = await pool.execute(
      "SELECT * FROM becas ORDER BY descripcion",
    );
    res.json(becas);
  } catch (error) {
    // Log silenciado - solo respuesta HTTP
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

app.get("/api/ping", async (req, res) => {
  try {
    const startTime = Date.now();

    // Realizar una consulta más completa para verificar el estado
    const [result] = await pool.query(`
      SELECT
        1 as test,
        NOW() as server_time,
        DATABASE() as database_name,
        VERSION() as mysql_version,
        @@global.max_connections as max_connections,
        (SELECT COUNT(*) FROM information_schema.processlist) as active_connections
    `);

    const responseTime = Date.now() - startTime;

    if (result && result.length > 0) {
      const dbInfo = result[0];
      res.json({
        ok: true,
        message: "Conexión a la base de datos exitosa",
        servicio: "backend-principal",
        puerto: APP_PORT,
        timestamp: new Date().toISOString(),
        response_time_ms: responseTime,
        database_info: {
          name: dbInfo.database_name,
          mysql_version: dbInfo.mysql_version,
          server_time: dbInfo.server_time,
          max_connections: dbInfo.max_connections,
          active_connections: dbInfo.active_connections,
        },
        server_info: {
          node_version: process.version,
          platform: process.platform,
          uptime_seconds: Math.floor(process.uptime()),
          memory_usage: {
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB",
            heap_used:
              Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + " MB",
            heap_total:
              Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + " MB",
          },
        },
      });
    } else {
      throw new Error("La consulta no devolvió resultados esperados");
    }
  } catch (error) {
    // Log silenciado - solo respuesta HTTP
    res.status(500).json({
      ok: false,
      message: "Error de conexión a la base de datos",
      timestamp: new Date().toISOString(),
      error: {
        code: error.code || "UNKNOWN_ERROR",
        message: error.message,
        type: error.constructor.name,
      },
      suggestions:
        {
          ECONNREFUSED: "Verifica que MySQL esté ejecutándose",
          ER_ACCESS_DENIED_ERROR:
            "Verifica las credenciales de la base de datos",
          ER_BAD_DB_ERROR: "Verifica que la base de datos exista",
          ENOTFOUND: "Verifica la dirección del host de la base de datos",
        }[error.code] || "Revisa la configuración de la base de datos",
    });
  }
});

const PORT = APP_PORT;

// Función para verificar la conexión a la base de datos
async function verificarConexionBD() {
  const maxReintentos = 3;
  const tiempoEspera = 2000; // 2 segundos entre reintentos

  console.log("");
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║        BACKEND PRINCIPAL - UNIDAD EDUCATIVA EMI              ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log("");
  console.log("🔄 Verificando conexión a la base de datos...");

  for (let intento = 1; intento <= maxReintentos; intento++) {
    try {
      // Intentar una consulta real para verificar la conexión
      const [result] = await pool.query(
        "SELECT 1 as test, NOW() as timestamp, DATABASE() as database_name, VERSION() as mysql_version",
      );

      if (result && result.length > 0) {
        console.log("✅ Conexión a la base de datos establecida correctamente");
        console.log(`   📦 Base de datos: ${result[0].database_name}`);
        console.log(`   🔢 Versión MySQL: ${result[0].mysql_version}`);
        return true;
      } else {
        throw new Error("La consulta no devolvió resultados esperados");
      }
    } catch (error) {
      console.error(
        `❌ Error intentando conectar a la base de datos (intento ${intento}/${maxReintentos}):`,
        error.message,
      );
      if (intento < maxReintentos) {
        await new Promise((resolve) => setTimeout(resolve, tiempoEspera));
      }
    }
  }

  console.error("❌ Error de conexión a la base de datos");
  return false;
}

async function iniciarServidor() {
  try {
    // Verificar conexión a la base de datos antes de iniciar el servidor
    const conexionExitosa = await verificarConexionBD();

    if (!conexionExitosa) {
      console.error(
        "❌ No se pudo establecer conexión con la base de datos. Abortando inicio del servidor.",
      );
      process.exit(1);
      return;
    }

    // Inicializar servicio de WhatsApp de forma centralizada (singleton)
    // Esto permite que el panel admin vea estado/QR y que se mantenga la sesión en .wwebjs_auth
    const {
      inicializar: inicializarWhatsApp,
    } = require("./microservices/academia/whatsappServiceSingleton");
    inicializarWhatsApp().catch((err) => {
      console.error("⚠️ [index] Error al inicializar WhatsApp:", err.message);
    });

    // Si la conexión es exitosa, iniciar el servidor
    const server = app.listen(PORT, "0.0.0.0", () => {
      const addr = server.address();
      console.log("✅ Conectado al front correctamente");
      console.log("✅ Agente inteligente listo para responder");
    });

    // Manejar errores del servidor
    server.on("error", (error) => {
      // Log silenciado - solo cerrar proceso
      process.exit(1);
    });

    // Manejar cierre graceful del servidor (incluye cierre de WhatsApp para evitar "browser already running")
    const gracefulShutdown = async () => {
      try {
        const {
          obtenerInstancia,
        } = require("./microservices/academia/whatsappServiceSingleton");
        const ws = obtenerInstancia();
        if (ws && typeof ws.destroy === "function") {
          await ws.destroy();
        }
      } catch (e) {
        // Ignorar
      }
      server.close(() => {
        pool
          .end()
          .catch(() => {})
          .finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGUSR2", () => gracefulShutdown("SIGUSR2")); // nodemon restart

    // Manejar errores no capturados (silenciado)
    process.on("uncaughtException", (error) => {
      gracefulShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason, promise) => {
      // No cerrar el servidor para errores no críticos
      const errorMessage = reason?.message || String(reason);
      const errorCode = reason?.code;

      // Errores que no deberían cerrar el servidor
      const nonCriticalErrors = [
        "EBUSY",
        "resource busy",
        "locked",
        "Timeout",
        "ENOENT", // Archivo no encontrado
      ];

      const isNonCritical = nonCriticalErrors.some(
        (err) => errorMessage.includes(err) || errorCode === err,
      );

      if (isNonCritical) {
        return; // No cerrar el servidor
      }

      // Solo cerrar en casos realmente críticos
      if (errorMessage.includes("FATAL") || errorMessage.includes("CRITICAL")) {
        gracefulShutdown("unhandledRejection");
      }
    });
  } catch (error) {
    console.error("❌ Error fatal al iniciar el servidor:", error);
    process.exit(1);
  }
}

// Solo iniciar el servidor si este archivo se ejecuta directamente
if (require.main === module) {
  console.log("🔧 [index] iniciarServidor() llamado (require.main === module)");
  iniciarServidor();
}

// Exportar la app para uso en otros archivos
module.exports = app;
