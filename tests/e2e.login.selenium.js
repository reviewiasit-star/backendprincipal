const { Builder, By, until } = require('selenium-webdriver');

async function runLoginE2E() {
  let driver;

  const FRONTEND_URL = process.env.E2E_FRONTEND_URL || 'http://localhost:5173/login';
  const USERNAME = process.env.E2E_USER || 'admin';
  const PASSWORD = process.env.E2E_PASSWORD || '4321';

  try {
    driver = await new Builder().forBrowser('chrome').build();
    await driver.manage().setTimeouts({ implicit: 1000, pageLoad: 15000, script: 15000 });

    await driver.get(FRONTEND_URL);

    const usuarioInput = await driver.wait(
      until.elementLocated(
        By.css(
          'input[name="usuario"], input[name="username"], input[id="usuario"], input[type="text"]'
        )
      ),
      10000
    );
    const passwordInput = await driver.wait(
      until.elementLocated(
        By.css(
          'input[name="password"], input[id="password"], input[type="password"]'
        )
      ),
      10000
    );

    await usuarioInput.clear();
    await usuarioInput.sendKeys(USERNAME);
    await passwordInput.clear();
    await passwordInput.sendKeys(PASSWORD);

    // Si existe banner PWA flotante, intentamos cerrarlo para no bloquear el boton.
    const pwaBanners = await driver.findElements(By.css('.install-pwa-banner'));
    if (pwaBanners.length > 0) {
      try {
        const cerrarBtns = await driver.findElements(
          By.css('.install-pwa-banner button, .install-pwa-banner [role="button"]')
        );
        if (cerrarBtns.length > 0) {
          await cerrarBtns[0].click();
        } else {
          await driver.executeScript(
            "const b=document.querySelector('.install-pwa-banner'); if(b){b.style.display='none';}"
          );
        }
      } catch (_) {
        await driver.executeScript(
          "const b=document.querySelector('.install-pwa-banner'); if(b){b.style.display='none';}"
        );
      }
    }

    const botonLogin = await driver.findElement(
      By.css('button[type="submit"], button.login-btn, .btn-login')
    );
    await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', botonLogin);
    try {
      await botonLogin.click();
    } catch (_) {
      // Fallback robusto cuando un overlay intercepta el click normal.
      await driver.executeScript('arguments[0].click();', botonLogin);
    }

    await driver.wait(async () => {
      const url = await driver.getCurrentUrl();
      return url.includes('/dashboard') || url.includes('/inicio') || url.includes('/home');
    }, 10000);

    const finalUrl = await driver.getCurrentUrl();
    console.log('OK: Login exitoso');
    console.log('URL final:', finalUrl);
    console.log('RESULTADO E2E: APROBADO');
  } catch (error) {
    console.error('RESULTADO E2E: FALLIDO');
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.quit();
    }
  }
}

runLoginE2E();
