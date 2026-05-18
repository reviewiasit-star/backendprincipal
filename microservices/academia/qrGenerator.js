const QRCode = require('qrcode');

class QRGenerator {
  static async generateQRImage(qrData) {
    try {
      // Generar QR como imagen PNG en base64
      const qrImageBase64 = await QRCode.toDataURL(qrData, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 300
      });

      return qrImageBase64;
    } catch (error) {
      console.error('Error generando QR:', error);
      throw error;
    }
  }

  static async generateQRBuffer(qrData) {
    try {
      // Generar QR como buffer
      const qrBuffer = await QRCode.toBuffer(qrData, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 300
      });

      return qrBuffer;
    } catch (error) {
      console.error('Error generando QR buffer:', error);
      throw error;
    }
  }
}

module.exports = QRGenerator; 