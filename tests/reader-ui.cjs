/* Run with Playwright installed and a local server on port 8087. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = process.env.READER_QA_DIR || '/private/tmp/gog-reader-qa';
fs.mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const issues = [];
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 850 }, isMobile: mobile, hasTouch: mobile });
      await context.route('**/firebase-config.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.READER_FIREBASE_CONFIG = null;' }));
      await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
      const page = await context.newPage();
      page.on('pageerror', error => issues.push(error.message));
      await page.goto('http://127.0.0.1:8087/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('reader-sync-status').textContent.includes('Firebase'), null, { polling: 100 });
      assert.equal(await page.evaluate(() => window.LibbyApp.state.fontSize), mobile ? 21 : 18);
      assert.equal(await page.locator('.cover-meta-info button').count(), 1);
      await page.screenshot({ path: path.join(output, mobile ? 'cover-mobile.png' : 'cover-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'متابعة القراءة', exact: true }).click();
      await page.waitForTimeout(500);
      const layout = await page.evaluate(() => {
        const app = window.LibbyApp;
        app.recalculatePagination(); app.goToPage(10);
        const animation = document.getElementById('chapter-progress').getAnimations()[0];
        return { opacity: getComputedStyle(document.getElementById('reader-tools-toggle')).opacity,
          top: document.getElementById('reader-tools-toggle').getBoundingClientRect().top,
          gap: innerHeight - document.getElementById('reader-column-stage').getBoundingClientRect().bottom,
          duration: animation.effect.getTiming().duration,
          offsets: animation.effect.getKeyframes().map(frame => frame.offset) };
      });
      assert.equal(Number(layout.opacity), .05);
      assert.ok(layout.top < 30 && layout.gap < 30);
      assert.equal(layout.duration, 1000);
      assert.deepEqual(layout.offsets, [0, .25, .75, 1]);
      await page.waitForTimeout(1050);
      assert.equal(await page.locator('#chapter-progress').evaluate(element => getComputedStyle(element).opacity), '0');
      await page.screenshot({ path: path.join(output, mobile ? 'reader-mobile.png' : 'reader-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'أدوات القراءة', exact: true }).click();
      assert.equal(await page.locator('#reader-tools-panel').isVisible(), true);
      await page.getByRole('button', { name: 'المكتبة', exact: true }).last().click();
      const catalog = await page.locator('.library-card h2').allTextContents();
      assert.equal(catalog.length, 2);
      // Clicking a card returns to the cover without resetting reading progress.
      await page.getByRole('button', { name: 'الشركة الناشئة المرنة', exact: true }).click();
      assert.equal(await page.locator('#view-cover').isVisible(), true);
      await page.evaluate(() => window.LibbyApp.applyFontSize(23));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('reader-sync-status').textContent.includes('Firebase'), null, { polling: 100 });
      assert.equal(await page.evaluate(() => window.LibbyApp.state.fontSize), 23);
      await page.getByRole('button', { name: 'المكتبة', exact: true }).first().click();
      await page.getByRole('button', { name: 'PDF', exact: true }).first().click();
      await page.waitForFunction(() => !document.getElementById('pdf-save').disabled, null, { polling: 100 });
      assert.equal(await page.locator('#pdf-dialog').isVisible(), true);
      await page.locator('#pdf-settings select[name=font]').selectOption('rounded');
      await page.locator('#pdf-settings input[name=fontSize]').fill('16');
      await page.locator('#pdf-settings select[name=paper]').selectOption('A5');
      await page.locator('#pdf-settings select[name=chapterStart]').selectOption('continuous');
      await page.locator('#pdf-settings summary').click();
      await page.locator('#pdf-chapter-breaks input').nth(2).check();
      await page.waitForFunction(() => !document.getElementById('pdf-save').disabled, null, { polling: 100 });
      const settings = await page.evaluate(() => {
        const doc = document.getElementById('pdf-preview').contentDocument;
        return { size: getComputedStyle(doc.body).fontSize, font: getComputedStyle(doc.body).fontFamily,
          starts: doc.querySelectorAll('.pdf-page-start').length, content: doc.getElementById('pdf-content').textContent.length,
          pageRule: doc.getElementById('pdf-layout').textContent.includes('size: A5') };
      });
      assert.ok(settings.font.includes('Book Arabic Rounded'));
      assert.ok(Math.abs(parseFloat(settings.size) - 16 * 4 / 3) < .1);
      assert.equal(settings.starts, 1);
      assert.ok(settings.content > 100000 && settings.pageRule);
      await page.screenshot({ path: path.join(output, mobile ? 'pdf-editor-mobile.png' : 'pdf-editor-desktop.png'), fullPage: true });
      if (!mobile) {
        const markup = await page.locator('#pdf-preview').evaluate(frame => '<!doctype html>' + frame.contentDocument.documentElement.outerHTML);
        const printPage = await context.newPage();
        await printPage.setContent(markup, { waitUntil: 'load' });
        await printPage.evaluate(() => document.fonts.ready);
        await printPage.pdf({ path: path.join(output, 'reader-export.pdf'), preferCSSPageSize: true, printBackground: true });
        await printPage.close();
      }
      await page.getByRole('button', { name: 'إغلاق إعداد PDF', exact: true }).click();
      assert.equal(await page.locator('#pdf-dialog').isVisible(), false);
      await context.close();
    }
    assert.deepEqual(issues, []);
    console.log('PASS: desktop/mobile controls, font persistence, chapter timing, card opening, configurable Arabic PDF.');
    console.log(output);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
