const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Configuración de multer para subida de imágenes
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Apuntar a la carpeta uploads del backend principal (dos niveles arriba de microservices/tienda)
    const uploadPath = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage });

// Función para configurar las rutas de gestión de productos
function configurarRutasProductos(app, pool, authMiddleware) {

  // ===== ENDPOINTS PARA SISTEMA DE INVENTARIO =====

  // Registrar compra de la administradora
  app.post('/api/compras-administradora', authMiddleware, async (req, res) => {
    try {
      const { proveedor, fecha_compra, observaciones, productos } = req.body;
      const usuario_id = req.user.id;
      
      if (!proveedor || !fecha_compra || !productos || productos.length === 0) {
        return res.status(400).json({ ok: false, message: 'Datos incompletos' });
      }
      
      // Iniciar transacción
      await pool.query('START TRANSACTION');
      
      try {
        // Insertar compra principal
        const [compraResult] = await pool.query(
          'INSERT INTO compras_administradora (usuario_id, proveedor, fecha_compra, observaciones) VALUES (?, ?, ?, ?)',
          [usuario_id, proveedor, fecha_compra, observaciones || null]
        );
        
        const compra_id = compraResult.insertId;
        let total_compra = 0;
        
        // Insertar detalles de productos
        for (const producto of productos) {
          const { nombre, descripcion, costo_unitario, precio_venta_sugerido, cantidad, fecha_vencimiento, categoria } = producto;
          
          if (!nombre || !costo_unitario || !precio_venta_sugerido || !cantidad) {
            throw new Error('Datos de producto incompletos');
          }
          
          await pool.query(
            `INSERT INTO detalle_compras (compra_id, nombre_producto, descripcion, costo_unitario, 
             precio_venta_sugerido, cantidad, fecha_vencimiento, categoria) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [compra_id, nombre, descripcion || null, costo_unitario, precio_venta_sugerido, cantidad, fecha_vencimiento || null, categoria || null]
          );
          
          total_compra += costo_unitario * cantidad;
        }
        
        // Registrar egreso automáticamente
        await pool.query(
          `INSERT INTO movimientos_egresos (compra_id, monto, fecha, concepto, observaciones, usuario_registro)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [compra_id, total_compra, fecha_compra, 'Compra de productos para inventario', `Compra de ${proveedor}`, usuario_id]
        );
        
        await pool.query('COMMIT');
        res.json({ ok: true, message: 'Compra registrada exitosamente', compra_id });
        
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al registrar compra', error: error.message });
    }
  });

  // Obtener lista de compras de la administradora
  app.get('/api/compras-administradora', authMiddleware, async (req, res) => {
    try {
      const { fecha_inicio, fecha_fin, proveedor } = req.query;
      
      let query = `
        SELECT ca.*, u.nombre_completo as usuario_nombre,
               COUNT(dc.id) as total_productos,
               SUM(dc.costo_unitario * dc.cantidad) as total_compra
        FROM compras_administradora ca
        LEFT JOIN usuarios u ON ca.usuario_id = u.id
        LEFT JOIN detalle_compras dc ON ca.id = dc.compra_id
        WHERE 1=1
      `;
      const params = [];
      
      if (fecha_inicio && fecha_fin) {
        query += ' AND DATE(ca.fecha_compra) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (proveedor) {
        query += ' AND ca.proveedor LIKE ?';
        params.push(`%${proveedor}%`);
      }
      
      query += ' GROUP BY ca.id ORDER BY ca.fecha_compra DESC';
      
      const [rows] = await pool.query(query, params);
      res.json({ ok: true, compras: rows });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener compras', error: error.message });
    }
  });

  // Obtener detalle de una compra específica
  app.get('/api/compras-administradora/:id', authMiddleware, async (req, res) => {
    try {
      const compra_id = req.params.id;
      
      // Obtener información de la compra
      const [compraRows] = await pool.query(
        `SELECT ca.*, u.nombre_completo as usuario_nombre
         FROM compras_administradora ca
         LEFT JOIN usuarios u ON ca.usuario_id = u.id
         WHERE ca.id = ?`,
        [compra_id]
      );
      
      if (compraRows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Compra no encontrada' });
      }
      
      // Obtener productos de la compra
      const [productosRows] = await pool.query(
        `SELECT dc.*, 
               COALESCE(SUM(ia.cantidad_asignada), 0) as cantidad_distribuida,
               (dc.cantidad - COALESCE(SUM(ia.cantidad_asignada), 0)) as cantidad_disponible
         FROM detalle_compras dc
         LEFT JOIN inventario_almacenes ia ON dc.id = ia.detalle_compra_id
         WHERE dc.compra_id = ?
         GROUP BY dc.id`,
        [compra_id]
      );
      
      const compra = compraRows[0];
      compra.productos = productosRows;
      
      res.json({ ok: true, compra });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener detalle de compra', error: error.message });
    }
  });

  // Distribuir productos a almacenes
  app.post('/api/distribuir-productos', authMiddleware, async (req, res) => {
    try {
      const { distribuciones } = req.body;
      const usuario_id = req.user.id;
      
      if (!distribuciones || distribuciones.length === 0) {
        return res.status(400).json({ ok: false, message: 'No hay distribuciones para procesar' });
      }
      
      await pool.query('START TRANSACTION');
      
      try {
        for (const dist of distribuciones) {
          const { detalle_compra_id, almacen_id, cantidad_asignada, precio_venta_final } = dist;
          
          if (!detalle_compra_id || !almacen_id || !cantidad_asignada || cantidad_asignada <= 0) {
            throw new Error('Datos de distribución incompletos');
          }
          
          // Verificar disponibilidad
          const [disponibleRows] = await pool.query(
            `SELECT dc.cantidad - COALESCE(SUM(ia.cantidad_asignada), 0) as disponible
             FROM detalle_compras dc
             LEFT JOIN inventario_almacenes ia ON dc.id = ia.detalle_compra_id
             WHERE dc.id = ?
             GROUP BY dc.id`,
            [detalle_compra_id]
          );
          
          if (disponibleRows.length === 0 || disponibleRows[0].disponible < cantidad_asignada) {
            throw new Error('Cantidad no disponible para distribución');
          }
          
          // Insertar en inventario de almacenes
          await pool.query(
            `INSERT INTO inventario_almacenes (detalle_compra_id, almacen_id, cantidad_asignada, 
             stock_actual, precio_venta_final, usuario_asigno, fecha_asignacion)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [detalle_compra_id, almacen_id, cantidad_asignada, cantidad_asignada, precio_venta_final, usuario_id]
          );
        }
        
        await pool.query('COMMIT');
        res.json({ ok: true, message: 'Productos distribuidos exitosamente' });
        
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al distribuir productos', error: error.message });
    }
  });

  // Obtener inventario de un almacén específico
  app.get('/api/inventario-almacen/:almacen_id', authMiddleware, async (req, res) => {
    try {
      const almacen_id = req.params.almacen_id;
      const { categoria, busqueda } = req.query;
      
      let query = `
        SELECT ia.*, dc.nombre_producto, dc.descripcion, dc.costo_unitario, dc.categoria,
               dc.fecha_vencimiento, ca.proveedor, ca.fecha_compra,
               a.nombre as almacen_nombre
        FROM inventario_almacenes ia
        JOIN detalle_compras dc ON ia.detalle_compra_id = dc.id
        JOIN compras_administradora ca ON dc.compra_id = ca.id
        JOIN almacenes a ON ia.almacen_id = a.id
        WHERE ia.almacen_id = ? AND ia.stock_actual > 0
      `;
      const params = [almacen_id];
      
      if (categoria) {
        query += ' AND dc.categoria = ?';
        params.push(categoria);
      }
      
      if (busqueda) {
        query += ' AND (dc.nombre_producto LIKE ? OR dc.descripcion LIKE ?)';
        params.push(`%${busqueda}%`, `%${busqueda}%`);
      }
      
      query += ' ORDER BY dc.nombre_producto';
      
      const [rows] = await pool.query(query, params);
      res.json({ ok: true, inventario: rows });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener inventario', error: error.message });
    }
  });

  // Registrar ventas con el nuevo sistema
  app.post('/api/ventas-inventario', authMiddleware, async (req, res) => {
    try {
      const { inventario_almacen_id, almacen_id, cantidad, precio_venta, forma_pago, estudiante_id, observaciones, transaccion_id } = req.body;
      const usuario_id = req.user.id;
      
      if (!inventario_almacen_id || !almacen_id || !cantidad || cantidad <= 0 || !forma_pago) {
        return res.status(400).json({ ok: false, message: 'Datos incompletos o inválidos' });
      }
      
      // Verificar stock disponible
      const [stockRows] = await pool.query(
        `SELECT ia.stock_actual, ia.precio_venta_final, dc.costo_unitario, dc.nombre_producto
         FROM inventario_almacenes ia
         JOIN detalle_compras dc ON ia.detalle_compra_id = dc.id
         WHERE ia.id = ? AND ia.almacen_id = ?`,
        [inventario_almacen_id, almacen_id]
      );
      
      if (stockRows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Producto no encontrado en el inventario' });
      }
      
      const { stock_actual, precio_venta_final, costo_unitario, nombre_producto } = stockRows[0];
      const precioVentaFinal = precio_venta || precio_venta_final;
      
      if (cantidad > stock_actual) {
        return res.status(400).json({ ok: false, message: 'Stock insuficiente' });
      }
      
      await pool.query('START TRANSACTION');
      
      try {
        // Descontar del inventario
        await pool.query(
          'UPDATE inventario_almacenes SET stock_actual = stock_actual - ? WHERE id = ?',
          [cantidad, inventario_almacen_id]
        );
        
        // Calcular ganancia unitaria
        const ganancia_unitaria = precioVentaFinal - costo_unitario;
        
        // Registrar venta
        const fechaHoraActual = new Date().toISOString().slice(0, 19).replace('T', ' ');
        await pool.query(
          `INSERT INTO ventas (usuario_id, inventario_almacen_id, almacen_id, cantidad, precio_venta, 
           costo_unitario, ganancia_unitaria, forma_pago, estudiante_id, observaciones, transaccion_id, fecha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [usuario_id, inventario_almacen_id, almacen_id, cantidad, precioVentaFinal, costo_unitario, 
           ganancia_unitaria, forma_pago, estudiante_id || null, observaciones || null, transaccion_id || null, fechaHoraActual]
        );
        
        // Registrar ingreso automáticamente
        const totalVenta = precioVentaFinal * cantidad;
        await pool.query(
          `INSERT INTO ingresos (monto, fecha, rubro, detalle, estudiante_id, forma_pago, usuario_registro, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [totalVenta, fechaHoraActual.split(' ')[0], 'ventas_productos', 
           `Venta de ${cantidad} ${nombre_producto} a Bs ${precioVentaFinal} c/u`, 
           estudiante_id || null, forma_pago, usuario_id, observaciones || null]
        );
        
        await pool.query('COMMIT');
        res.json({ ok: true, message: 'Venta registrada correctamente' });
        
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al registrar venta', error: error.message });
    }
  });

  // Obtener reportes de ventas con el nuevo sistema
  app.get('/api/reportes-ventas-inventario', authMiddleware, async (req, res) => {
    try {
      const { usuario_id, almacen_id, fecha_inicio, fecha_fin, forma_pago } = req.query;
      
      let query = `
        SELECT v.*, u.nombre_completo as usuario_nombre, a.nombre as almacen_nombre,
               dc.nombre_producto, dc.categoria, CONCAT(e.nombre, ' ', e.apellido_paterno, ' ', e.apellido_materno) as estudiante_nombre,
               (v.precio_venta * v.cantidad) as total_venta,
               (v.ganancia_unitaria * v.cantidad) as ganancia_total
        FROM ventas v
        LEFT JOIN usuarios u ON v.usuario_id = u.id
        LEFT JOIN almacenes a ON v.almacen_id = a.id
        LEFT JOIN inventario_almacenes ia ON v.inventario_almacen_id = ia.id
        LEFT JOIN detalle_compras dc ON ia.detalle_compra_id = dc.id
        LEFT JOIN estudiantes e ON v.estudiante_id = e.id
        WHERE v.inventario_almacen_id IS NOT NULL
      `;
      const params = [];
      
      if (usuario_id) {
        query += ' AND v.usuario_id = ?';
        params.push(usuario_id);
      }
      
      if (almacen_id) {
        query += ' AND v.almacen_id = ?';
        params.push(almacen_id);
      }
      
      if (fecha_inicio && fecha_fin) {
        query += ' AND DATE(v.fecha) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (forma_pago && forma_pago !== 'todos') {
        query += ' AND v.forma_pago = ?';
        params.push(forma_pago);
      }
      
      query += ' ORDER BY v.fecha DESC';
      
      const [rows] = await pool.query(query, params);
      
      // Calcular totales
      const totales = rows.reduce((acc, venta) => {
        acc.total_ventas += parseFloat(venta.total_venta);
        acc.total_ganancias += parseFloat(venta.ganancia_total);
        acc.total_costos += parseFloat(venta.costo_unitario * venta.cantidad);
        return acc;
      }, { total_ventas: 0, total_ganancias: 0, total_costos: 0 });
      
      res.json({ ok: true, ventas: rows, totales });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener reporte de ventas', error: error.message });
    }
  });

  // Obtener resumen de ganancias y pérdidas
  app.get('/api/resumen-ganancias-perdidas', authMiddleware, async (req, res) => {
    try {
      const { fecha_inicio, fecha_fin, almacen_id } = req.query;
      
      let whereConditions = [];
      let params = [];
      
      if (fecha_inicio && fecha_fin) {
        whereConditions.push('DATE(v.fecha) BETWEEN DATE(?) AND DATE(?)');
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (almacen_id) {
        whereConditions.push('v.almacen_id = ?');
        params.push(almacen_id);
      }
      
      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      
      // Resumen por almacén
      const [resumenAlmacenes] = await pool.query(`
        SELECT a.nombre as almacen_nombre,
               COUNT(v.id) as total_ventas,
               SUM(v.cantidad) as productos_vendidos,
               SUM(v.precio_venta * v.cantidad) as ingresos_totales,
               SUM(v.costo_unitario * v.cantidad) as costos_totales,
               SUM(v.ganancia_unitaria * v.cantidad) as ganancias_totales
        FROM ventas v
        JOIN almacenes a ON v.almacen_id = a.id
        ${whereClause}
        GROUP BY v.almacen_id, a.nombre
        ORDER BY ganancias_totales DESC
      `, params);
      
      // Resumen por categoría
      const [resumenCategorias] = await pool.query(`
        SELECT dc.categoria,
               COUNT(v.id) as total_ventas,
               SUM(v.cantidad) as productos_vendidos,
               SUM(v.precio_venta * v.cantidad) as ingresos_totales,
               SUM(v.ganancia_unitaria * v.cantidad) as ganancias_totales
        FROM ventas v
        JOIN inventario_almacenes ia ON v.inventario_almacen_id = ia.id
        JOIN detalle_compras dc ON ia.detalle_compra_id = dc.id
        ${whereClause}
        GROUP BY dc.categoria
        ORDER BY ganancias_totales DESC
      `, params);
      
      // Totales generales
      const [totalesGenerales] = await pool.query(`
        SELECT SUM(v.precio_venta * v.cantidad) as ingresos_totales,
               SUM(v.costo_unitario * v.cantidad) as costos_totales,
               SUM(v.ganancia_unitaria * v.cantidad) as ganancias_totales,
               COUNT(v.id) as total_transacciones
        FROM ventas v
        ${whereClause}
      `, params);
      
      res.json({ 
        ok: true, 
        resumen_almacenes: resumenAlmacenes,
        resumen_categorias: resumenCategorias,
        totales_generales: totalesGenerales[0] || { ingresos_totales: 0, costos_totales: 0, ganancias_totales: 0, total_transacciones: 0 }
      });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener resumen', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA ALMACENES =====

  // Obtener todos los almacenes
  app.get('/api/almacenes', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM almacenes');
      res.json(rows);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener almacenes', error: error.message });
    }
  });

  // Crear un almacén
  app.post('/api/almacenes', async (req, res) => {
    try {
      const { nombre, descripcion } = req.body;
      const [result] = await pool.query('INSERT INTO almacenes (nombre, descripcion) VALUES (?, ?)', [nombre, descripcion]);
      res.json({ ok: true, id: result.insertId });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al crear almacén', error: error.message });
    }
  });

  // Actualizar un almacén
  app.put('/api/almacenes/:id', async (req, res) => {
    try {
      const { nombre, descripcion } = req.body;
      await pool.query('UPDATE almacenes SET nombre=?, descripcion=? WHERE id=?', [nombre, descripcion, req.params.id]);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al actualizar almacén', error: error.message });
    }
  });

  // Eliminar un almacén
  app.delete('/api/almacenes/:id', async (req, res) => {
    try {
      await pool.query('DELETE FROM almacenes WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al eliminar almacén', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA PRODUCTOS =====

  // ===== ENDPOINTS DE TESTING (Solo Desarrollo) =====
  app.post('/api/testing/limpiar', authMiddleware, async (req, res) => {
    try {
      await pool.query('SET FOREIGN_KEY_CHECKS = 0');
      await pool.query('TRUNCATE TABLE ventas');
      await pool.query('TRUNCATE TABLE lotes_productos');
      await pool.query('TRUNCATE TABLE productos');
      await pool.query('TRUNCATE TABLE inventario_almacenes');
      await pool.query('TRUNCATE TABLE detalle_compras');
      await pool.query('TRUNCATE TABLE compras_administradora');
      await pool.query('TRUNCATE TABLE movimientos_egresos');
      await pool.query('SET FOREIGN_KEY_CHECKS = 1');
      res.json({ ok: true, message: 'Base de datos limpia (Productos, Lotes y Ventas)' });
    } catch (error) {
      console.error('Error al limpiar base de datos:', error);
      res.status(500).json({ ok: false, message: 'Error al limpiar', error: error.message });
    }
  });

  app.post('/api/testing/seed', authMiddleware, async (req, res) => {
    try {
      // 1. Asegurar que exista al menos un almacén
      let [almacenes] = await pool.query('SELECT id FROM almacenes LIMIT 1');
      let almacen_id = 1;
      if (almacenes.length === 0) {
        const [insertAlm] = await pool.query('INSERT INTO almacenes (nombre, descripcion) VALUES (?, ?)', ['Almacén Principal', 'Generado automáticamente']);
        almacen_id = insertAlm.insertId;
      } else {
        almacen_id = almacenes[0].id;
      }

      // 2. Insertar 10 productos (Lácteos y No Lácteos)
      const productosDummy = [
        { nombre: 'Leche PIL Entera 1L', cat: 'alimentos', tipo: 'perecedero', costo: 6, venta: 7, stock: 50 },
        { nombre: 'Yogurt Frutado Fresa 1L', cat: 'alimentos', tipo: 'perecedero', costo: 12, venta: 15, stock: 30 },
        { nombre: 'Queso San Javier 500g', cat: 'alimentos', tipo: 'perecedero', costo: 25, venta: 32, stock: 20 },
        { nombre: 'Mantequilla Regia 200g', cat: 'alimentos', tipo: 'perecedero', costo: 10, venta: 14, stock: 40 },
        { nombre: 'Dulce de Leche 500g', cat: 'alimentos', tipo: 'perecedero', costo: 15, venta: 20, stock: 25 },
        { nombre: 'Galletas Oreo', cat: 'alimentos', tipo: 'no_perecedero', costo: 4, venta: 6, stock: 100 },
        { nombre: 'Jugo del Valle Durazno 1L', cat: 'bebidas', tipo: 'perecedero', costo: 8, venta: 11, stock: 60 },
        { nombre: 'Coca Cola 2L', cat: 'bebidas', tipo: 'no_perecedero', costo: 11, venta: 14, stock: 80 },
        { nombre: 'Cuaderno Espiral 100 hojas', cat: 'material escolar', tipo: 'no_perecedero', costo: 15, venta: 25, stock: 150 },
        { nombre: 'Bolígrafo Azul BIC', cat: 'material escolar', tipo: 'no_perecedero', costo: 1, venta: 2, stock: 300 }
      ];

      for (const p of productosDummy) {
        const [insertProd] = await pool.query(`
          INSERT INTO productos (almacen_id, nombre, descripcion, unidad, categoria, tipo_producto, vendible, precio_unitario, precio_salida, stock, stock_inicial)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `, [almacen_id, p.nombre, 'Producto de prueba generado', 'unidad', p.cat, p.tipo, p.costo, p.venta, p.stock, p.stock]);
        
        const prodId = insertProd.insertId;
        
        // Crear un lote para este producto
        const codigo_lote = `L-${prodId}-${Date.now().toString().slice(-4)}`;
        const vencimiento = p.tipo === 'perecedero' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : null;
        
        await pool.query(`
          INSERT INTO lotes_productos 
          (producto_id, codigo_lote, precio_compra, precio_venta, stock_inicial, stock_actual, fecha_vencimiento, proveedor, estado)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo')
        `, [prodId, codigo_lote, p.costo, p.venta, p.stock, p.stock, vencimiento, 'Proveedor Prueba']);
      }

      res.json({ ok: true, message: '10 Productos de prueba generados exitosamente.' });
    } catch (error) {
      console.error('Error al generar seed:', error);
      res.status(500).json({ ok: false, message: 'Error al generar productos de prueba', error: error.message });
    }
  });

  // Obtener resumen financiero (Inversión, Recuperado, Ganancia)
  app.post('/api/productos-finanzas', authMiddleware, async (req, res) => {
    try {
      const { ids } = req.body; // Array de IDs opcional
      let query = `
        SELECT 
          SUM(precio_compra * stock_inicial) AS inversion_total,
          SUM(precio_venta * (stock_inicial - stock_actual)) AS capital_recuperado,
          SUM((precio_venta - precio_compra) * (stock_inicial - stock_actual)) AS ganancia_actual,
          SUM((precio_venta - precio_compra) * stock_inicial) AS ganancia_esperada
        FROM lotes_productos
      `;
      let params = [];
      
      if (ids && Array.isArray(ids) && ids.length > 0) {
        query += ` WHERE producto_id IN (?)`;
        params.push(ids);
      }
      
      const [rows] = await pool.query(query, params);
      res.json({ ok: true, finanzas: rows[0] });
    } catch (error) {
      console.error('Error al calcular finanzas:', error);
      res.status(500).json({ ok: false, message: 'Error al calcular finanzas' });
    }
  });

  // Obtener todos los productos con stock consolidado de lotes
  app.get('/api/productos', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT 
          v.*,
          COALESCE(f.inversion_total, 0) as inversion_total,
          COALESCE(f.capital_recuperado, 0) as capital_recuperado,
          COALESCE(f.ganancia_actual, 0) as ganancia_actual,
          COALESCE(f.ganancia_esperada, 0) as ganancia_esperada
        FROM vista_productos_stock v
        LEFT JOIN (
          SELECT 
            producto_id,
            SUM(precio_compra * stock_inicial) AS inversion_total,
            SUM(precio_venta * (stock_inicial - stock_actual)) AS capital_recuperado,
            SUM((precio_venta - precio_compra) * (stock_inicial - stock_actual)) AS ganancia_actual,
            SUM((precio_venta - precio_compra) * stock_inicial) AS ganancia_esperada
          FROM lotes_productos
          GROUP BY producto_id
        ) f ON v.id = f.producto_id
        ORDER BY v.nombre
      `);
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener productos:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener productos', error: error.message });
    }
  });

  // Obtener un producto por ID
  app.get('/api/productos/:id', async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM productos WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ ok: false, message: 'Producto no encontrado' });
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener producto', error: error.message });
    }
  });

  // Crear un producto
  app.post('/api/productos', authMiddleware, upload.single('imagen'), async (req, res) => {
    try {
      const { 
        almacen_id, nombre, descripcion, precio_unitario, precio_salida, stock, 
        unidad, categoria, tipo_producto, fecha_vencimiento, dias_alerta_vencimiento, 
        codigo, proveedor, codigo_lote
      } = req.body;
      const imagen = req.file ? req.file.filename : null;
      
      if (!nombre || !precio_unitario || !almacen_id) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Nombre, precio unitario y almacén son requeridos' 
        });
      }

      // Transacción: crear producto y, si corresponde, su primer lote
      await pool.query('START TRANSACTION');

      try {
        const [result] = await pool.query(
          `INSERT INTO productos (
            almacen_id, nombre, descripcion, precio_unitario, precio_salida, stock, stock_inicial,
            unidad, categoria, tipo_producto, fecha_vencimiento, dias_alerta_vencimiento, 
            codigo, proveedor, imagen, vendible
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            almacen_id, nombre, descripcion || null, precio_unitario, precio_salida || precio_unitario, 
            stock || 0, stock || 0, unidad || 'unidad', categoria || null, tipo_producto || 'no_perecedero', 
            fecha_vencimiento || null, dias_alerta_vencimiento || 10, codigo || null, 
            proveedor || null, imagen, 1
          ]
        );

        const productoId = result.insertId;

        // Si se proporcionó stock y precios, crear el primer lote automáticamente
        const stockInicial = Number(stock || 0);
        const precioCompra = Number(precio_unitario || 0);
        const precioVenta = Number((precio_salida || precio_unitario) || 0);

        if (stockInicial > 0 && precioCompra > 0 && precioVenta > 0) {
          // Generar un código de lote si no se envió
          const codigoLote = (codigo_lote && String(codigo_lote).trim())
            || (codigo && String(codigo).trim())
            || `${(nombre || 'LOTE').toString().toUpperCase().replace(/\s+/g, '').slice(0,6)}-${Date.now().toString().slice(-6)}`;

          // Insertar lote inicial
          const [loteRes] = await pool.query(`
            INSERT INTO lotes_productos (
              producto_id, codigo_lote, titulo_lote, imagen_lote,
              precio_compra, precio_venta, stock_inicial, stock_actual, 
              fecha_vencimiento, proveedor, observaciones
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            productoId, codigoLote, (nombre || null), imagen,
            precioCompra, precioVenta, stockInicial, stockInicial,
            (tipo_producto === 'perecedero' ? (fecha_vencimiento || null) : null),
            proveedor || null, 'Lote inicial creado automáticamente'
          ]);

          const loteId = loteRes.insertId;

          // Registrar movimiento de entrada para el lote inicial
          await pool.query(`
            INSERT INTO movimientos_stock (
              lote_id, tipo_movimiento, cantidad, stock_anterior, 
              stock_nuevo, motivo, usuario_id
            ) VALUES (?, 'entrada', ?, 0, ?, 'Creación automática de primer lote', ?)
          `, [loteId, stockInicial, stockInicial, req.user.id]);
        }

        await pool.query('COMMIT');

        res.json({ 
          ok: true, 
          id: productoId,
          message: 'Producto creado exitosamente'
        });
      } catch (errorTx) {
        await pool.query('ROLLBACK');
        throw errorTx;
      }
    } catch (error) {
      console.error('Error al crear producto:', error);
      res.status(500).json({ ok: false, message: 'Error al crear producto', error: error.message });
    }
  });

  // Actualizar un producto
  app.put('/api/productos/:id', authMiddleware, upload.single('imagen'), async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        almacen_id, nombre, descripcion, precio_unitario, precio_salida, stock, 
        unidad, categoria, tipo_producto, fecha_vencimiento, dias_alerta_vencimiento, 
        codigo, proveedor 
      } = req.body;
      const imagen = req.file ? req.file.filename : null;
      
      if (!nombre || !precio_unitario) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Nombre y precio unitario son requeridos' 
        });
      }

      let query = `UPDATE productos SET 
        almacen_id = ?, nombre = ?, descripcion = ?, precio_unitario = ?, precio_salida = ?, 
        stock = ?, unidad = ?, categoria = ?, tipo_producto = ?, fecha_vencimiento = ?, 
        dias_alerta_vencimiento = ?, codigo = ?, proveedor = ?`;
      let params = [
        almacen_id, nombre, descripcion || null, precio_unitario, precio_salida || precio_unitario, 
        stock || 0, unidad || 'unidad', categoria || null, tipo_producto || 'no_perecedero', 
        fecha_vencimiento || null, dias_alerta_vencimiento || 10, codigo || null, proveedor || null
      ];
      
      if (imagen) {
        query += ', imagen = ?';
        params.push(imagen);
      }
      
      query += ' WHERE id = ?';
      params.push(id);

      await pool.query('START TRANSACTION');
      try {
        const [result] = await pool.query(query, params);
        
        if (result.affectedRows === 0) {
          await pool.query('ROLLBACK');
          return res.status(404).json({ ok: false, message: 'Producto no encontrado' });
        }

        // Sincronizar lotes intactos (sin ventas) con los nuevos datos del producto principal
        await pool.query(`
          UPDATE lotes_productos 
          SET precio_compra = ?, 
              precio_venta = ?, 
              stock_inicial = ?, 
              stock_actual = ?, 
              codigo_lote = ?, 
              proveedor = ?
          WHERE producto_id = ? AND stock_inicial = stock_actual
        `, [
          precio_unitario, 
          (precio_salida || precio_unitario), 
          (stock || 0), 
          (stock || 0), 
          (codigo || null), 
          (proveedor || null), 
          id
        ]);

        await pool.query('COMMIT');
        
        res.json({ 
          ok: true, 
          message: 'Producto y lotes sincronizados exitosamente'
        });
      } catch (txError) {
        await pool.query('ROLLBACK');
        throw txError;
      }
    } catch (error) {
      console.error('Error al actualizar producto:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar producto', error: error.message });
    }
  });

  // Eliminar un producto
  app.delete('/api/productos/:id', authMiddleware, async (req, res) => {
    try {
      const { id } = req.params;
      
      const [result] = await pool.query('UPDATE productos SET vendible = 0 WHERE id = ?', [id]);
      
      if (result.affectedRows === 0) {
        return res.status(404).json({ ok: false, message: 'Producto no encontrado' });
      }
      
      res.json({ 
        ok: true, 
        message: 'Producto eliminado exitosamente'
      });
    } catch (error) {
      console.error('Error al eliminar producto:', error);
      res.status(500).json({ ok: false, message: 'Error al eliminar producto', error: error.message });
    }
  });

  // Obtener almacenes disponibles
  app.get('/api/almacenes', authMiddleware, async (req, res) => {
    try {
      const [rows] = await pool.query('SELECT id, nombre FROM almacenes ORDER BY nombre');
      res.json(rows);
    } catch (error) {
      console.error('Error al obtener almacenes:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener almacenes', error: error.message });
    }
  });

  // Endpoint de prueba para productos (sin autenticación)
  app.get('/api/productos-test', async (req, res) => {
    try {
      console.log('🔍 Endpoint de prueba de productos llamado');
      const [rows] = await pool.query(`
        SELECT * FROM vista_productos_stock
        ORDER BY nombre
      `);
      console.log(`✅ Productos encontrados: ${rows.length}`);
      res.json({ ok: true, productos: rows, total: rows.length });
    } catch (error) {
      console.error('❌ Error en endpoint de prueba:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener productos', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA LOTES DE PRODUCTOS =====

  // Obtener lotes de un producto específico (incluye título e imagen del lote)
  app.get('/api/productos/:id/lotes', authMiddleware, async (req, res) => {
    try {
      const producto_id = req.params.id;
      const { estado, ordenar_por } = req.query;
      
      // Extendemos la vista con titulo_lote e imagen_lote directamente desde lotes_productos
      let query = `
        SELECT vld.*, lp.titulo_lote, lp.imagen_lote
        FROM vista_lotes_detalle vld
        JOIN lotes_productos lp ON vld.id = lp.id
        WHERE vld.producto_id = ?
      `;
      const params = [producto_id];
      
      if (estado && estado !== 'todos') {
        query += ' AND vld.estado = ?';
        params.push(estado);
      }
      
      // Ordenar por diferentes criterios
      switch (ordenar_por) {
        case 'fecha_vencimiento':
          query += ' ORDER BY vld.fecha_vencimiento ASC, vld.fecha_ingreso DESC';
          break;
        case 'stock':
          query += ' ORDER BY vld.stock_actual DESC, vld.fecha_ingreso DESC';
          break;
        case 'precio':
          query += ' ORDER BY vld.precio_venta ASC, vld.fecha_ingreso DESC';
          break;
        default:
          query += ' ORDER BY vld.fecha_ingreso DESC, vld.codigo_lote ASC';
      }
      
      const [rows] = await pool.query(query, params);
      res.json({ ok: true, lotes: rows });
      
    } catch (error) {
      console.error('Error al obtener lotes:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener lotes', error: error.message });
    }
  });

  // Crear un nuevo lote para un producto (acepta imagen y título por lote)
  app.post('/api/productos/:id/lotes', authMiddleware, upload.single('imagen_lote'), async (req, res) => {
    try {
      const producto_id = req.params.id;
      const { 
        codigo_lote, precio_compra, precio_venta, stock_inicial, 
        fecha_vencimiento, proveedor, observaciones, titulo_lote 
      } = req.body;
      const imagen_lote = req.file ? req.file.filename : null;
      
      if (!codigo_lote || !precio_compra || !precio_venta || !stock_inicial) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Código de lote, precios y stock inicial son requeridos' 
        });
      }
      
      // Verificar que el producto existe
      const [productoRows] = await pool.query('SELECT id FROM productos WHERE id = ? AND vendible = 1', [producto_id]);
      if (productoRows.length === 0) {
        return res.status(404).json({ ok: false, message: 'Producto no encontrado' });
      }
      
      // Verificar que el código de lote no existe para este producto
      const [loteExistente] = await pool.query(
        'SELECT id FROM lotes_productos WHERE producto_id = ? AND codigo_lote = ?',
        [producto_id, codigo_lote]
      );
      if (loteExistente.length > 0) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Ya existe un lote con este código para este producto' 
        });
      }
      
      await pool.query('START TRANSACTION');
      
      try {
        // Resolver imagen_lote por defecto: si no se sube, reutilizar la última imagen de lote o la imagen del producto
        let imagenLoteFinal = imagen_lote || null;
        if (!imagenLoteFinal) {
          const [loteImgRows] = await pool.query(
            'SELECT imagen_lote FROM lotes_productos WHERE producto_id = ? AND imagen_lote IS NOT NULL ORDER BY fecha_creacion DESC LIMIT 1',
            [producto_id]
          );
          if (loteImgRows.length > 0 && loteImgRows[0].imagen_lote) {
            imagenLoteFinal = loteImgRows[0].imagen_lote;
          } else {
            const [prodImgRows] = await pool.query('SELECT imagen, nombre FROM productos WHERE id = ?', [producto_id]);
            if (prodImgRows.length > 0) {
              imagenLoteFinal = prodImgRows[0].imagen || null;
              // Título por defecto si no vino
              if (!titulo_lote) {
                req.body.titulo_lote = prodImgRows[0].nombre;
              }
            }
          }
        }

        // Insertar el nuevo lote
        const [result] = await pool.query(`
          INSERT INTO lotes_productos (
            producto_id, codigo_lote, titulo_lote, imagen_lote,
            precio_compra, precio_venta, stock_inicial, stock_actual, 
            fecha_vencimiento, proveedor, observaciones
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          producto_id, codigo_lote, (titulo_lote || null), imagenLoteFinal,
          precio_compra, precio_venta, stock_inicial, stock_inicial,
          fecha_vencimiento || null, proveedor || null, observaciones || null
        ]);
        
        const lote_id = result.insertId;
        
        // Registrar movimiento de entrada
        await pool.query(`
          INSERT INTO movimientos_stock (
            lote_id, tipo_movimiento, cantidad, stock_anterior, 
            stock_nuevo, motivo, usuario_id
          ) VALUES (?, 'entrada', ?, 0, ?, 'Creación de nuevo lote', ?)
        `, [lote_id, stock_inicial, stock_inicial, req.user.id]);
        
        await pool.query('COMMIT');
        
        res.json({ 
          ok: true, 
          message: 'Lote creado exitosamente',
          lote_id 
        });
        
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      console.error('Error al crear lote:', error);
      res.status(500).json({ ok: false, message: 'Error al crear lote', error: error.message });
    }
  });

  // Actualizar un lote (acepta cambio de título e imagen del lote)
  app.put('/api/lotes/:id', authMiddleware, upload.single('imagen_lote'), async (req, res) => {
    try {
      const lote_id = req.params.id;
      const { 
        codigo_lote, precio_compra, precio_venta, stock_actual, 
        fecha_vencimiento, proveedor, observaciones, estado, titulo_lote 
      } = req.body;
      const imagen_lote = req.file ? req.file.filename : null;
      
      if (!codigo_lote || !precio_compra || !precio_venta) {
        return res.status(400).json({ 
          ok: false, 
          message: 'Código de lote y precios son requeridos' 
        });
      }
      
      await pool.query('START TRANSACTION');
      
      try {
        // Obtener datos actuales del lote
        const [loteActual] = await pool.query(
          'SELECT * FROM lotes_productos WHERE id = ?',
          [lote_id]
        );
        
        if (loteActual.length === 0) {
          throw new Error('Lote no encontrado');
        }
        
        const stockAnterior = loteActual[0].stock_actual;
        
        // Calcular el nuevo stock inicial basado en el stock actual
        // Si el stock actual es mayor al stock inicial, actualizar stock inicial
        const stockInicialActual = loteActual[0].stock_inicial;
        const nuevoStockInicial = stock_actual > stockInicialActual ? stock_actual : stockInicialActual;
        
        // Actualizar el lote
        let queryUpdate = `
          UPDATE lotes_productos SET 
            codigo_lote = ?, titulo_lote = ?, precio_compra = ?, precio_venta = ?, 
            stock_actual = ?, stock_inicial = ?, fecha_vencimiento = ?, proveedor = ?, 
            observaciones = ?, estado = ?`;
        const paramsUpdate = [
          codigo_lote, (titulo_lote || null), precio_compra, precio_venta, stock_actual, nuevoStockInicial,
          fecha_vencimiento || null, proveedor || null, observaciones || null, 
          estado || 'activo'
        ];
        if (imagen_lote) {
          queryUpdate += ', imagen_lote = ?';
          paramsUpdate.push(imagen_lote);
        }
        queryUpdate += ' WHERE id = ?';
        paramsUpdate.push(lote_id);
        await pool.query(queryUpdate, paramsUpdate);
        
        // Registrar movimiento si cambió el stock
        if (stock_actual !== stockAnterior) {
          const tipoMovimiento = stock_actual > stockAnterior ? 'entrada' : 'salida';
          const cantidad = Math.abs(stock_actual - stockAnterior);
          
          await pool.query(`
            INSERT INTO movimientos_stock (
              lote_id, tipo_movimiento, cantidad, stock_anterior, 
              stock_nuevo, motivo, usuario_id
            ) VALUES (?, ?, ?, ?, ?, 'Actualización manual de stock', ?)
          `, [lote_id, tipoMovimiento, cantidad, stockAnterior, stock_actual, req.user.id]);
        }
        
        await pool.query('COMMIT');
        
        res.json({ 
          ok: true, 
          message: 'Lote actualizado exitosamente',
          stock_inicial_actualizado: nuevoStockInicial !== stockInicialActual
        });
        
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      console.error('Error al actualizar lote:', error);
      res.status(500).json({ ok: false, message: 'Error al actualizar lote', error: error.message });
    }
  });

  // Obtener movimientos de stock de un lote
  app.get('/api/lotes/:id/movimientos', authMiddleware, async (req, res) => {
    try {
      const lote_id = req.params.id;
      const { fecha_inicio, fecha_fin, tipo_movimiento } = req.query;
      
      let query = `
        SELECT ms.*, u.nombre_completo as usuario_nombre
        FROM movimientos_stock ms
        LEFT JOIN usuarios u ON ms.usuario_id = u.id
        WHERE ms.lote_id = ?
      `;
      const params = [lote_id];
      
      if (fecha_inicio && fecha_fin) {
        query += ' AND DATE(ms.fecha_movimiento) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (tipo_movimiento && tipo_movimiento !== 'todos') {
        query += ' AND ms.tipo_movimiento = ?';
        params.push(tipo_movimiento);
      }
      
      query += ' ORDER BY ms.fecha_movimiento DESC';
      
      const [rows] = await pool.query(query, params);
      res.json({ ok: true, movimientos: rows });
      
    } catch (error) {
      console.error('Error al obtener movimientos:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener movimientos', error: error.message });
    }
  });

  // Obtener resumen de lotes por producto
  app.get('/api/productos/:id/resumen-lotes', authMiddleware, async (req, res) => {
    try {
      const producto_id = req.params.id;
      
      const [resumen] = await pool.query(`
        SELECT 
          COUNT(*) as total_lotes,
          COUNT(CASE WHEN estado = 'activo' THEN 1 END) as lotes_activos,
          COUNT(CASE WHEN estado = 'agotado' THEN 1 END) as lotes_agotados,
          COUNT(CASE WHEN estado = 'vencido' THEN 1 END) as lotes_vencidos,
          SUM(CASE WHEN estado = 'activo' THEN stock_actual ELSE 0 END) as stock_total_activo,
          SUM(CASE WHEN estado = 'activo' THEN stock_actual * precio_compra ELSE 0 END) as valor_inventario_compra,
          SUM(CASE WHEN estado = 'activo' THEN stock_actual * precio_venta ELSE 0 END) as valor_inventario_venta,
          AVG(CASE WHEN estado = 'activo' THEN precio_compra END) as precio_compra_promedio,
          AVG(CASE WHEN estado = 'activo' THEN precio_venta END) as precio_venta_promedio,
          MIN(CASE WHEN estado = 'activo' AND fecha_vencimiento IS NOT NULL THEN fecha_vencimiento END) as fecha_vencimiento_proxima
        FROM lotes_productos 
        WHERE producto_id = ?
      `, [producto_id]);
      
      res.json({ ok: true, resumen: resumen[0] });
      
    } catch (error) {
      console.error('Error al obtener resumen de lotes:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener resumen', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA VENTAS =====

  // Registrar venta con sistema de lotes
  app.post('/api/ventas', authMiddleware, async (req, res) => {
    try {
      console.log('=== DEBUG VENTAS ===');
      console.log('Body recibido:', req.body);
      console.log('Usuario ID:', req.user.id);
      
      const { producto_id, lote_id, cantidad, precio_venta, forma_pago, estudiante_id, observaciones, transaccion_id } = req.body;
      const usuario_id = req.user.id;
      
      if (!producto_id || !cantidad || cantidad <= 0) {
        return res.status(400).json({ ok: false, message: 'Debe incluir un producto válido con cantidad' });
      }
      
      await pool.query('START TRANSACTION');
      
      try {
        // Verificar stock disponible usando la vista consolidada
        console.log('Consultando producto ID:', producto_id);
        const [stockRows] = await pool.query(`
          SELECT stock_total, nombre, almacen_id, precio_venta_promedio 
          FROM vista_productos_stock 
          WHERE id = ?
        `, [producto_id]);
        
        if (stockRows.length === 0) {
          throw new Error(`Producto con ID ${producto_id} no encontrado`);
        }
        
        const { stock_total, nombre, almacen_id: producto_almacen_id, precio_venta_promedio } = stockRows[0];
        console.log('Producto encontrado:', { stock_total, nombre, producto_almacen_id, precio_venta_promedio });
        
        if (cantidad > stock_total) {
          throw new Error(`Stock insuficiente para ${nombre}. Disponible: ${stock_total}, Solicitado: ${cantidad}`);
        }
        
        // Usar precio_venta del frontend o precio promedio como fallback
        const precio_final = precio_venta || precio_venta_promedio || 0;
        const total_venta = precio_final * cantidad;
        console.log('Precio final:', precio_final, 'Total venta:', total_venta);
        
        let lote_id_principal = null;
        let costo_total = 0;
        
        if (lote_id) {
          // Venta específica de un lote
          console.log('Venta específica del lote ID:', lote_id);
          
          const [loteEspecifico] = await pool.query(`
            SELECT id, stock_actual, precio_compra, precio_venta, codigo_lote, producto_id
            FROM lotes_productos 
            WHERE id = ? AND estado = 'activo' AND producto_id = ?
          `, [lote_id, producto_id]);
          
          if (loteEspecifico.length === 0) {
            throw new Error('Lote específico no encontrado o no disponible');
          }
          
          const lote = loteEspecifico[0];
          
          if (lote.stock_actual < cantidad) {
            throw new Error(`Stock insuficiente en el lote ${lote.codigo_lote}. Disponible: ${lote.stock_actual}, Solicitado: ${cantidad}`);
          }
          
          // Actualizar stock del lote específico
          await pool.query(
            'UPDATE lotes_productos SET stock_actual = stock_actual - ? WHERE id = ?',
            [cantidad, lote.id]
          );
          
          // Registrar movimiento de salida
          await pool.query(`
            INSERT INTO movimientos_stock (
              lote_id, tipo_movimiento, cantidad, stock_anterior, 
              stock_nuevo, motivo, usuario_id
            ) VALUES (?, 'salida', ?, ?, ?, 'Venta de producto', ?)
          `, [
            lote.id, 
            cantidad, 
            lote.stock_actual, 
            lote.stock_actual - cantidad, 
            usuario_id
          ]);
          
          lote_id_principal = lote.id;
          costo_total = cantidad * lote.precio_compra;
          
        } else {
          // Venta automática usando FIFO (comportamiento anterior)
          console.log('Venta automática usando FIFO');
          
          const [lotesDisponibles] = await pool.query(`
            SELECT id, stock_actual, precio_compra, precio_venta, codigo_lote
            FROM lotes_productos 
            WHERE producto_id = ? AND estado = 'activo' AND stock_actual > 0
            ORDER BY fecha_vencimiento ASC, fecha_ingreso ASC
          `, [producto_id]);
          
          if (lotesDisponibles.length === 0) {
            throw new Error('No hay lotes disponibles para este producto');
          }
          
          // Distribuir la venta entre lotes (FIFO)
          let cantidadRestante = cantidad;
          
          for (const lote of lotesDisponibles) {
            if (cantidadRestante <= 0) break;
            
            const cantidadDelLote = Math.min(cantidadRestante, lote.stock_actual);
            
            // Actualizar stock del lote
            await pool.query(
              'UPDATE lotes_productos SET stock_actual = stock_actual - ? WHERE id = ?',
              [cantidadDelLote, lote.id]
            );
            
            // Registrar movimiento de salida
            await pool.query(`
              INSERT INTO movimientos_stock (
                lote_id, tipo_movimiento, cantidad, stock_anterior, 
                stock_nuevo, motivo, usuario_id
              ) VALUES (?, 'salida', ?, ?, ?, 'Venta de producto', ?)
            `, [
              lote.id, 
              cantidadDelLote, 
              lote.stock_actual, 
              lote.stock_actual - cantidadDelLote, 
              usuario_id
            ]);
            
            // Marcar el primer lote como principal para la venta
            if (!lote_id_principal) {
              lote_id_principal = lote.id;
            }
            
            costo_total += cantidadDelLote * lote.precio_compra;
            cantidadRestante -= cantidadDelLote;
          }
        }
        
        // Registrar venta en la tabla ventas
        const fechaHoraActual = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const almacen_final = req.body.almacen_id || producto_almacen_id;
        
        console.log('Valores para INSERT:', {
          usuario_id,
          producto_id,
          lote_id: lote_id_principal,
          almacen_id: almacen_final,
          cantidad,
          precio_final,
          forma_pago,
          estudiante_id: estudiante_id || null,
          observaciones: observaciones || null,
          transaccion_id: transaccion_id || null,
          fechaHoraActual
        });
        
        const [ventaResult] = await pool.query(
          `INSERT INTO ventas (usuario_id, producto_id, lote_id, almacen_id, cantidad, precio_venta, forma_pago, estudiante_id, observaciones, transaccion_id, fecha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [usuario_id, producto_id, lote_id_principal, almacen_final, cantidad, precio_final, forma_pago, estudiante_id || null, observaciones || null, transaccion_id || null, fechaHoraActual]
        );
        
        const venta_id = ventaResult.insertId;
        console.log('Venta insertada con ID:', venta_id);
        
        // Registrar ingreso automáticamente
        const ingresoData = [total_venta, fechaHoraActual.split(' ')[0], 'ventas_productos', 
           `Venta de producto: ${nombre} (Cantidad: ${cantidad})`, 
           estudiante_id || null, forma_pago, usuario_id, observaciones || null];
        
        console.log('Insertando ingreso con datos:', ingresoData);
        await pool.query(
          `INSERT INTO ingresos (monto, fecha, tipo, detalle, estudiante_id, forma_pago, usuario_registro, observaciones)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ingresoData
        );
        console.log('Ingreso registrado correctamente');
        
        await pool.query('COMMIT');
        res.json({ 
          ok: true, 
          message: 'Venta registrada correctamente',
          venta_id,
          total: total_venta,
          ganancia: total_venta - costo_total
        });
        
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al registrar venta', error: error.message });
    }
  });

  // Obtener ventas agrupadas por transacción
  app.get('/api/ventas', authMiddleware, async (req, res) => {
    try {
      const { usuario_id, fecha_inicio, fecha_fin, forma_pago, estudiante_id, producto_id, productos_ids } = req.query;
      
      let query = `
        SELECT v.transaccion_id, v.fecha, v.forma_pago, v.usuario_id, v.estudiante_id,
               u.nombre_completo as usuario_nombre,
               CONCAT(e.nombre, ' ', e.apellido_paterno, ' ', e.apellido_materno) as estudiante_nombre,
               SUM(v.precio_venta * v.cantidad) as total,
               GROUP_CONCAT(CONCAT(p.nombre, ' (', v.cantidad, ')') SEPARATOR ', ') as productos_descripcion
        FROM ventas v
        LEFT JOIN usuarios u ON v.usuario_id = u.id
        LEFT JOIN estudiantes e ON v.estudiante_id = e.id
        LEFT JOIN productos p ON v.producto_id = p.id
        WHERE 1=1
      `;
      const params = [];
      
      if (usuario_id) {
        query += ' AND v.usuario_id = ?';
        params.push(usuario_id);
      }
      
      if (fecha_inicio && fecha_fin) {
        query += ' AND DATE(v.fecha) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (forma_pago && forma_pago !== 'todos') {
        query += ' AND v.forma_pago = ?';
        params.push(forma_pago);
      }
      
      if (estudiante_id) {
        query += ' AND v.estudiante_id = ?';
        params.push(estudiante_id);
      }
      
      if (productos_ids) {
        const idsArray = productos_ids.split(',').filter(id => !isNaN(parseInt(id)));
        if (idsArray.length > 0) {
          query += ` AND v.producto_id IN (${idsArray.map(() => '?').join(',')})`;
          params.push(...idsArray);
        }
      } else if (producto_id) {
        query += ' AND v.producto_id = ?';
        params.push(producto_id);
      }
      
      query += ' GROUP BY v.transaccion_id, v.fecha, v.forma_pago, v.usuario_id, v.estudiante_id ORDER BY v.fecha DESC';
      
      const [ventasAgrupadas] = await pool.query(query, params);
      
      // Obtener detalles de cada transacción
      for (let venta of ventasAgrupadas) {
        const [productos] = await pool.query(`
          SELECT v.producto_id, p.nombre as producto_nombre, v.cantidad, v.precio_venta,
                 (v.cantidad * v.precio_venta) as subtotal, p.categoria,
                 a.nombre as almacen_nombre
          FROM ventas v
          LEFT JOIN productos p ON v.producto_id = p.id
          LEFT JOIN almacenes a ON v.almacen_id = a.id
          WHERE v.transaccion_id = ?
        `, [venta.transaccion_id]);
        venta.productos = productos;
      }
      
      res.json({ 
        ok: true, 
        ventas: ventasAgrupadas,
        ventasAgrupadas: ventasAgrupadas 
      });
      
    } catch (error) {
      console.error('Error al obtener ventas:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener ventas', error: error.message });
    }
  });

  // Endpoint específico para el dashboard - ventas individuales
  app.get('/api/ventas-dashboard', authMiddleware, async (req, res) => {
    try {
      const { usuario_id, fecha_inicio, fecha_fin, forma_pago, estudiante_id, producto_id } = req.query;
      
      let query = `
        SELECT v.id, v.producto_id, v.almacen_id, v.cantidad, v.precio_venta, v.forma_pago, 
               v.estudiante_id, v.observaciones, v.transaccion_id, v.fecha, v.usuario_id,
               p.nombre as producto_nombre, p.categoria, p.codigo,
               a.nombre as almacen_nombre,
               u.nombre_completo as usuario_nombre,
               CONCAT(e.nombre, ' ', e.apellido_paterno, ' ', e.apellido_materno) as estudiante_nombre
        FROM ventas v
        LEFT JOIN productos p ON v.producto_id = p.id
        LEFT JOIN almacenes a ON v.almacen_id = a.id
        LEFT JOIN usuarios u ON v.usuario_id = u.id
        LEFT JOIN estudiantes e ON v.estudiante_id = e.id
        WHERE 1=1
      `;
      const params = [];
      
      if (usuario_id) {
        query += ' AND v.usuario_id = ?';
        params.push(usuario_id);
      }
      
      if (fecha_inicio && fecha_fin) {
        query += ' AND DATE(v.fecha) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (forma_pago && forma_pago !== 'todos') {
        query += ' AND v.forma_pago = ?';
        params.push(forma_pago);
      }
      
      if (estudiante_id) {
        query += ' AND v.estudiante_id = ?';
        params.push(estudiante_id);
      }
      
      if (producto_id) {
        query += ' AND v.producto_id = ?';
        params.push(producto_id);
      }
      
      query += ' ORDER BY v.fecha DESC, v.id DESC';
      
      const [ventas] = await pool.query(query, params);
      
      res.json({ 
        ok: true, 
        ventas: ventas
      });
      
    } catch (error) {
      console.error('Error al obtener ventas para dashboard:', error);
      res.status(500).json({ ok: false, message: 'Error al obtener ventas para dashboard', error: error.message });
    }
  });

  // ===== ENDPOINTS PARA REPORTES =====

  // Obtener ingresos por ventas
  app.get('/api/ingresos-ventas', async (req, res) => {
    try {
      const { fecha_inicio, fecha_fin, forma_pago } = req.query;
      
      let query = `
        SELECT i.*, CONCAT(e.nombre, ' ', e.apellido_paterno, ' ', e.apellido_materno) as estudiante_nombre,
               u.nombre_completo as usuario_nombre
        FROM ingresos i
        LEFT JOIN estudiantes e ON i.estudiante_id = e.id
        LEFT JOIN usuarios u ON i.usuario_registro = u.id
        WHERE i.rubro = 'ventas_productos'
      `;
      const params = [];
      
      if (fecha_inicio && fecha_fin) {
        query += ' AND DATE(i.fecha) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (forma_pago && forma_pago !== 'todos') {
        query += ' AND i.forma_pago = ?';
        params.push(forma_pago);
      }
      
      query += ' ORDER BY i.fecha DESC';
      
      const [rows] = await pool.query(query, params);
      
      // Calcular total
      const total = rows.reduce((sum, ingreso) => sum + parseFloat(ingreso.monto), 0);
      
      res.json({ ok: true, ingresos: rows, total });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al obtener ingresos de ventas', error: error.message });
    }
  });

  // Reporte de inversión vs ganancia por productos
  app.get('/api/reportes/inversion-ganancia', async (req, res) => {
    try {
      const { fecha_inicio, fecha_fin, almacen_id, producto_id, tipo } = req.query;
      
      let whereClause = 'WHERE p.vendible = 1';
      const params = [];
      
      if (fecha_inicio && fecha_fin) {
        whereClause += ' AND DATE(p.fecha_registro) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      if (almacen_id) {
        whereClause += ' AND p.almacen_id = ?';
        params.push(almacen_id);
      }
      
      if (producto_id) {
        whereClause += ' AND p.id = ?';
        params.push(producto_id);
      }
      
      // Obtener análisis de productos con ventas y totales de lotes
      const [productosData] = await pool.query(`
        SELECT 
          p.id,
          p.nombre,
          p.categoria,
          p.imagen,
          p.almacen_id,
          a.nombre as almacen_nombre,
          p.stock_inicial,
          p.stock,
          p.precio_unitario,
          p.precio_salida,
          (p.stock_inicial * p.precio_unitario) as inversion_total,
          -- Totales de lotes (sin duplicaciones)
          COALESCE(lotes_totales.total_stock_actual, 0) as total_stock_actual_lotes,
          COALESCE(lotes_totales.total_capital_invertido, 0) as total_capital_invertido_lotes,
          COALESCE(lotes_totales.total_capital_esperado, 0) as total_capital_esperado_lotes,
          COALESCE(lotes_totales.total_ganancia_esperada, 0) as total_ganancia_esperada_lotes,
          COALESCE(ventas_lotes.total_capital_recuperado, 0) as total_capital_recuperado_lotes,
          -- Ventas del producto (sin duplicaciones)
          COALESCE(ventas_totales.cantidad_vendida, 0) as cantidad_vendida,
          COALESCE(ventas_totales.ingresos_ventas, 0) as ingresos_ventas,
          COALESCE(ventas_totales.costo_vendido, 0) as costo_vendido,
          COALESCE(ventas_totales.ganancia_real, 0) as ganancia_real,
          (p.stock * (p.precio_salida - p.precio_unitario)) as ganancia_potencial_stock_restante,
          CASE 
            WHEN p.stock <= 0 THEN 'Agotado'
            WHEN p.stock <= 5 THEN 'Stock Bajo'
            WHEN COALESCE(ventas_totales.cantidad_vendida, 0) > 0 THEN 'Con Ventas'
            ELSE 'Sin Ventas'
          END as estado_financiero,
          p.fecha_registro
        FROM productos p
        LEFT JOIN almacenes a ON p.almacen_id = a.id
        LEFT JOIN (
          SELECT 
            lp.producto_id,
            SUM(lp.stock_actual) as total_stock_actual,
            SUM(lp.stock_inicial * lp.precio_compra) as total_capital_invertido,
            SUM(lp.stock_inicial * lp.precio_venta) as total_capital_esperado,
            SUM((lp.stock_inicial * lp.precio_venta) - (lp.stock_inicial * lp.precio_compra)) as total_ganancia_esperada
          FROM lotes_productos lp
          GROUP BY lp.producto_id
        ) lotes_totales ON p.id = lotes_totales.producto_id
        LEFT JOIN (
          SELECT 
            lp.producto_id,
            COALESCE(SUM(v.cantidad * v.precio_venta), 0) as total_capital_recuperado
          FROM lotes_productos lp
          LEFT JOIN ventas v ON lp.id = v.lote_id
          GROUP BY lp.producto_id
        ) ventas_lotes ON p.id = ventas_lotes.producto_id
        LEFT JOIN (
          SELECT 
            v.producto_id,
            SUM(v.cantidad) as cantidad_vendida,
            SUM(v.cantidad * v.precio_venta) as ingresos_ventas,
            SUM(v.cantidad * p.precio_unitario) as costo_vendido,
            SUM(v.cantidad * (v.precio_venta - p.precio_unitario)) as ganancia_real
          FROM ventas v
          LEFT JOIN productos p ON v.producto_id = p.id
          GROUP BY v.producto_id
        ) ventas_totales ON p.id = ventas_totales.producto_id
        ${whereClause}
        ORDER BY ganancia_real DESC, p.nombre
      `, params);
      
      // Debug: Log de los primeros productos para verificar cálculos
      console.log('=== DEBUG INVERSION GANANCIA ===');
      console.log('Productos encontrados:', productosData.length);
      productosData.forEach((producto, index) => {
        console.log(`Producto ${index + 1}:`, {
          nombre: producto.nombre,
          total_stock_actual_lotes: producto.total_stock_actual_lotes,
          total_capital_invertido_lotes: producto.total_capital_invertido_lotes,
          total_capital_esperado_lotes: producto.total_capital_esperado_lotes,
          total_capital_recuperado_lotes: producto.total_capital_recuperado_lotes
        });
      });
      
      // Calcular totales generales
      const totales = productosData.reduce((acc, producto) => {
        acc.inversion_total += parseFloat(producto.inversion_total || 0);
        acc.ingresos_ventas += parseFloat(producto.ingresos_ventas || 0);
        acc.costo_vendido += parseFloat(producto.costo_vendido || 0);
        acc.ganancia_real += parseFloat(producto.ganancia_real || 0);
        acc.ganancia_potencial_stock_restante += parseFloat(producto.ganancia_potencial_stock_restante || 0);
        // Totales de lotes
        acc.total_stock_actual_lotes += parseFloat(producto.total_stock_actual_lotes || 0);
        acc.total_capital_invertido_lotes += parseFloat(producto.total_capital_invertido_lotes || 0);
        acc.total_capital_esperado_lotes += parseFloat(producto.total_capital_esperado_lotes || 0);
        acc.total_ganancia_esperada_lotes += parseFloat(producto.total_ganancia_esperada_lotes || 0);
        acc.total_capital_recuperado_lotes += parseFloat(producto.total_capital_recuperado_lotes || 0);
        return acc;
      }, { 
        inversion_total: 0, 
        ingresos_ventas: 0, 
        costo_vendido: 0, 
        ganancia_real: 0, 
        ganancia_potencial_stock_restante: 0,
        total_stock_actual_lotes: 0,
        total_capital_invertido_lotes: 0,
        total_capital_esperado_lotes: 0,
        total_ganancia_esperada_lotes: 0,
        total_capital_recuperado_lotes: 0
      });
      
      res.json({ 
        ok: true, 
        productos: productosData,
        totales,
        resumen: {
          total_productos: productosData.length,
          productos_con_ventas: productosData.filter(p => p.cantidad_vendida > 0).length,
          productos_sin_ventas: productosData.filter(p => p.cantidad_vendida === 0).length,
          productos_agotados: productosData.filter(p => p.stock <= 0).length
        }
      });
      
    } catch (error) {
      console.error('Error al generar reporte de inversión:', error);
      res.status(500).json({ ok: false, message: 'Error al generar reporte', error: error.message });
    }
  });

  // Endpoint para obtener lotes de un producto específico con análisis de inversión
  app.get('/api/reportes/lotes-producto/:productoId', authMiddleware, async (req, res) => {
    try {
      const { productoId } = req.params;
      const { fecha_inicio, fecha_fin } = req.query;
      
      // Obtener información del producto
      const [productoInfo] = await pool.query(`
        SELECT 
          p.id,
          p.nombre,
          p.categoria,
          p.imagen,
          p.precio_unitario,
          p.precio_salida
        FROM productos p
        WHERE p.id = ?
      `, [productoId]);
      
      if (productoInfo.length === 0) {
        return res.status(404).json({ ok: false, message: 'Producto no encontrado' });
      }
      
      // Obtener lotes del producto con análisis de ventas
      let whereClause = 'WHERE lp.producto_id = ?';
      const params = [productoId];
      
      if (fecha_inicio && fecha_fin) {
        whereClause += ' AND DATE(lp.fecha_creacion) BETWEEN DATE(?) AND DATE(?)';
        params.push(fecha_inicio, fecha_fin);
      }
      
      const [lotesData] = await pool.query(`
        SELECT 
          lp.id,
          lp.codigo_lote,
          lp.precio_compra,
          lp.precio_venta,
          lp.stock_inicial,
          lp.stock_actual,
          lp.fecha_vencimiento,
          lp.proveedor,
          lp.observaciones,
          lp.estado,
          lp.fecha_creacion,
          (lp.stock_inicial * lp.precio_compra) as inversion_lote,
          (lp.stock_inicial * lp.precio_venta) as capital_esperado_lote,
          (lp.stock_inicial * lp.precio_venta) - (lp.stock_inicial * lp.precio_compra) as ganancia_esperada_lote,
          COALESCE(SUM(v.cantidad), 0) as cantidad_vendida_lote,
          COALESCE(SUM(v.cantidad * v.precio_venta), 0) as ingresos_lote,
          COALESCE(SUM(v.cantidad * lp.precio_compra), 0) as costo_vendido_lote,
          COALESCE(SUM(v.cantidad * (v.precio_venta - lp.precio_compra)), 0) as ganancia_real_lote,
          (lp.stock_actual * (lp.precio_venta - lp.precio_compra)) as ganancia_potencial_lote,
          CASE 
            WHEN lp.stock_actual <= 0 THEN 'Agotado'
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento < CURDATE() THEN 'Vencido'
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'Por vencer'
            WHEN lp.stock_actual <= 5 THEN 'Stock Bajo'
            WHEN COALESCE(SUM(v.cantidad), 0) > 0 THEN 'Con Ventas'
            ELSE 'Sin Ventas'
          END as estado_lote
        FROM lotes_productos lp
        LEFT JOIN ventas v ON lp.id = v.lote_id
        ${whereClause}
        GROUP BY lp.id, lp.codigo_lote, lp.precio_compra, lp.precio_venta, lp.stock_inicial, lp.stock_actual, lp.fecha_vencimiento, lp.proveedor, lp.observaciones, lp.estado, lp.fecha_creacion
        ORDER BY lp.fecha_creacion DESC
      `, params);
      
      // Calcular totales por lote
      const totalesLotes = lotesData.reduce((acc, lote) => {
        acc.totalStockInicial += parseFloat(lote.stock_inicial || 0);
        acc.totalStockActual += parseFloat(lote.stock_actual || 0);
        acc.totalInversionLotes += parseFloat(lote.inversion_lote || 0);
        acc.totalCapitalEsperadoLotes += parseFloat(lote.capital_esperado_lote || 0);
        acc.totalGananciaEsperadaLotes += parseFloat(lote.ganancia_esperada_lote || 0);
        acc.totalGananciaRealLotes += parseFloat(lote.ganancia_real_lote || 0);
        acc.totalGananciaPotencialLotes += parseFloat(lote.ganancia_potencial_lote || 0);
        acc.totalIngresosLotes += parseFloat(lote.ingresos_lote || 0);
        acc.cantidadLotes += 1;
        return acc;
      }, {
        totalStockInicial: 0,
        totalStockActual: 0,
        totalInversionLotes: 0,
        totalCapitalEsperadoLotes: 0,
        totalGananciaEsperadaLotes: 0,
        totalGananciaRealLotes: 0,
        totalGananciaPotencialLotes: 0,
        totalIngresosLotes: 0,
        cantidadLotes: 0
      });
      
      res.json({
        ok: true,
        producto: productoInfo[0],
        lotes: lotesData,
        totalesLotes
      });
      
    } catch (error) {
      console.error('Error al obtener lotes del producto:', error);
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener lotes del producto', 
        error: error.message 
      });
    }
  });

  // Endpoint para obtener lotes de un producto para ventas (priorizando por vencimiento)
  app.get('/api/productos/:productoId/lotes-venta', authMiddleware, async (req, res) => {
    try {
      const { productoId } = req.params;
      
      // Obtener lotes del producto ordenados por prioridad de venta
      const [lotesData] = await pool.query(`
        SELECT 
          lp.id,
          lp.codigo_lote,
          lp.titulo_lote,
          lp.imagen_lote,
          lp.precio_compra,
          lp.precio_venta,
          lp.stock_inicial,
          lp.stock_actual,
          lp.fecha_vencimiento,
          lp.proveedor,
          lp.estado,
          lp.fecha_creacion,
          CASE 
            WHEN lp.stock_actual <= 0 THEN 0
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento < CURDATE() THEN 1
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 2
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 3
            ELSE 4
          END as prioridad_venta,
          CASE 
            WHEN lp.stock_actual <= 0 THEN 'Agotado'
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento < CURDATE() THEN 'Vencido'
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'Por vencer'
            WHEN lp.fecha_vencimiento IS NOT NULL AND lp.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'Próximo a vencer'
            ELSE 'Disponible'
          END as estado_lote
        FROM lotes_productos lp
        WHERE lp.producto_id = ? AND lp.estado = 'activo' AND lp.stock_actual > 0
        ORDER BY prioridad_venta ASC, lp.fecha_vencimiento ASC, lp.fecha_creacion ASC
      `, [productoId]);
      
      res.json({
        ok: true,
        lotes: lotesData
      });
      
    } catch (error) {
      console.error('Error al obtener lotes para venta:', error);
      res.status(500).json({ 
        ok: false, 
        message: 'Error al obtener lotes para venta', 
        error: error.message 
      });
    }
  });

  // Reporte de stock completo
  app.get('/api/reportes/stock-completo', authMiddleware, async (req, res) => {
    try {
      const { categoria, stock_minimo } = req.query;
      
      let query = `
        SELECT p.*, 
               CASE 
                 WHEN p.es_perecedero = 1 AND p.fecha_vencimiento < CURDATE() THEN 'Vencido'
                 WHEN p.es_perecedero = 1 AND p.fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 'Por vencer'
                 WHEN p.stock <= 5 THEN 'Stock bajo'
                 ELSE 'Normal'
               END as estado_stock
        FROM productos p
        WHERE 1=1
      `;
      const params = [];
      
      if (categoria) {
        query += ' AND p.categoria = ?';
        params.push(categoria);
      }
      
      if (stock_minimo) {
        query += ' AND p.stock <= ?';
        params.push(stock_minimo);
      }
      
      query += ' ORDER BY p.nombre';
      
      const [productos] = await pool.query(query, params);
      
      // Estadísticas generales
      const [estadisticas] = await pool.query(`
        SELECT 
          COUNT(*) as total_productos,
          SUM(stock) as total_stock,
          SUM(CASE WHEN stock <= 5 THEN 1 ELSE 0 END) as productos_stock_bajo,
          SUM(CASE WHEN es_perecedero = 1 AND fecha_vencimiento <= DATE_ADD(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as productos_por_vencer
        FROM productos
      `);
      
      res.json({ 
        ok: true, 
        productos,
        estadisticas: estadisticas[0]
      });
      
    } catch (error) {
      res.status(500).json({ ok: false, message: 'Error al generar reporte de stock', error: error.message });
    }
  });

}

module.exports = { configurarRutasProductos };