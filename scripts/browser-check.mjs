/**
 * End-to-end check of the editor in a real browser.
 *
 * Unit tests cover the engine; this covers the things only a browser can show —
 * that a preset renders, that a slider survives being dragged, that editing one
 * field does not revert another, and that an export reaches a downloadable file.
 * Every failure it has caught so far was in that last category: state that looked
 * right in isolation and was wrong once two interactions overlapped.
 *
 *   npm run check:browser
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4178;
const BASE = `http://127.0.0.1:${PORT}/texture-forge/`;
// The sandbox ships a Chromium that may not match Playwright's expected build.
const BUNDLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) return;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`preview server never answered at ${url}`);
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
  stdio: 'ignore',
  detached: true,
});

let browser;
try {
  await waitForServer(BASE);
  browser = await chromium.launch(existsSync(BUNDLED) ? { executablePath: BUNDLED } : {});
  // An iPad-shaped viewport with touch, since that is the target.
  const context = await browser.newContext({ viewport: { width: 834, height: 1112 }, hasTouch: true });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('the picker offers three presets', (await page.locator('.preset-card').count()) === 3);

  await page.locator('.preset-card', { hasText: 'Paper' }).click();
  await page.waitForSelector('canvas.preview');
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector('canvas.preview');
      if (!canvas || canvas.width < 2) return false;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4000) if (data[i] > 0) return true;
      return false;
    },
    null,
    { timeout: 30000 },
  );
  check('a preset renders a preview', true);
  check('the preset has three layers', (await page.locator('.layer').count()) === 3, `${await page.locator('.layer').count()}`);

  await page.locator('.layer-name').first().click();
  await page.waitForSelector('.layer-body .control');
  check('layer controls come from the registry', (await page.locator('.layer-body .control').count()) > 4);

  // A slider must survive being dragged: rebuilding the panel mid-gesture would
  // take the control out from under a finger.
  const slider = page.locator('.layer-body input[type=range]').first();
  const startValue = await slider.inputValue();
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + 6, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(box.x + (box.width * i) / 7, box.y + box.height / 2);
    await page.waitForTimeout(100);
  }
  check('a slider stays attached mid-drag', await slider.evaluate((el) => el.isConnected));
  const draggedTo = await slider.inputValue();
  await page.mouse.up();
  await page.waitForTimeout(1500);
  check('the drag moved the slider', draggedTo !== startValue, `${startValue} -> ${draggedTo}`);
  check('undo becomes available after an edit', await page.locator('button', { hasText: 'Undo' }).first().isEnabled());

  // One gesture is one undo step, back to where the drag started rather than to
  // its second-to-last position.
  await page.locator('button', { hasText: 'Undo' }).first().click();
  await page.waitForTimeout(800);
  const afterUndo = await page.locator('.layer-body input[type=range]').first().inputValue();
  check('undo returns to before the drag', afterUndo === startValue, `${afterUndo} vs ${startValue}`);

  // Editing one field must not revert another. Handlers that captured the
  // project when the panel was painted used to write back a stale copy.
  const width = page.locator('.size-row input').first();
  const height = page.locator('.size-row input').nth(1);
  await width.fill('512');
  await width.dispatchEvent('change');
  await height.fill('384');
  await height.dispatchEvent('change');
  await page.waitForTimeout(800);
  const fields = await page.$$eval('.size-row input', (els) => els.map((el) => el.value));
  check('both dimensions hold', fields[0] === '512' && fields[1] === '384', fields.join('x'));

  // A mask is part of V1 composition, so it has to be reachable from the stack.
  await page.locator('button', { hasText: 'Add mask' }).first().click();
  await page.waitForTimeout(2000);
  check('a mask can be added to a layer', (await page.locator('button', { hasText: 'Remove mask' }).count()) === 1);
  check('the mask brings its own controls', (await page.locator('.layer-body .control').count()) > 8);

  // A greyscale export is a different picture, so the preview must show it.
  await page.locator('.panel', { hasText: 'Output' }).locator('select').selectOption('luminance');
  await page.waitForTimeout(2500);
  const greyscale = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.preview');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < data.length; i += 4004) {
      if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2] || data[i + 3] !== 255) return false;
    }
    return true;
  });
  check('a greyscale format previews as greyscale', greyscale);
  await page.locator('.panel', { hasText: 'Output' }).locator('select').selectOption('rgba');
  await page.waitForTimeout(1500);

  await page.locator('button', { hasText: 'Export PNG' }).click();
  // Two concurrent exports would share one cancel and double the memory.
  check('export is blocked while one is running', await page.locator('button', { hasText: 'Export PNG' }).isDisabled());
  await page.waitForSelector('button:has-text("Save PNG")', { timeout: 90000 });
  check('export becomes available again', await page.locator('button', { hasText: 'Export PNG' }).isEnabled());
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('button', { hasText: 'Save PNG' }).click();
  const saved = await download;
  check('export downloads at the chosen size', saved.suggestedFilename() === 'texture-512x384.png', saved.suggestedFilename());

  await page.locator('button', { hasText: '1:1' }).click();
  await page.waitForTimeout(1500);
  check('one-to-one zoom reports full scale', (await page.locator('.preview-status').textContent()).includes('100%'));

  // Seamless grids offer compatible sizes rather than changing the pattern.
  await page.locator('button', { hasText: '‹ Presets' }).click();
  await page.locator('.preset-card', { hasText: 'Square Grid' }).click();
  await page.waitForSelector('canvas.preview');
  await page.locator('.panel', { hasText: 'Output' }).locator('button.toggle').first().click();
  await page.waitForTimeout(500);
  const chips = await page.locator('.notice .chip').allTextContents();
  check('seamless offers compatible sizes', chips.includes('3840px') && chips.includes('4480px'), chips.join(', '));

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid);
  } catch {
    /* already gone */
  }
}

console.log(`${checks - failures.length}/${checks} browser checks passed`);
for (const failure of failures) console.error(`FAIL  ${failure}`);
if (failures.length > 0) process.exitCode = 1;
