import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';

// Standalone CSS fixture: no application server, network, or production data.
// TOAST_BROWSER=webkit requires an installed WebKit runtime (never downloads it).
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const css = fs.readFileSync(path.join(projectRoot, 'assets/css/main.css'), 'utf8');
const roomHtml = fs.readFileSync(path.join(projectRoot, 'room.html'), 'utf8');
const roomJs = fs.readFileSync(path.join(projectRoot, 'assets/js/room.js'), 'utf8');
const markup = '<span class="room-toast-dot" aria-hidden="true"></span><p></p><button type="button" aria-label="\u5173\u95ed\u63d0\u793a">\u00d7</button>';
assert.ok(roomJs.includes(markup), 'Review the fixture if the production toast markup changes');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || [
  chromium.executablePath(),
  ...[process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]
    .filter(Boolean)
    .flatMap((root) => [
      path.join(root, 'Google/Chrome/Application/chrome.exe'),
      path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
    ]),
].find((candidate) => fs.existsSync(candidate));

const requestedBrowser = process.env.TOAST_BROWSER;
assert.ok(!requestedBrowser || ['chromium', 'webkit'].includes(requestedBrowser), 'Unknown TOAST_BROWSER');
const engines = requestedBrowser
  ? [requestedBrowser]
  : ['chromium', ...(fs.existsSync(webkit.executablePath()) ? ['webkit'] : [])];
if (!requestedBrowser && !engines.includes('webkit')) {
  console.log('SKIP WebKit: runtime not installed; Chromium emulation is not iPad Safari verification.');
}

const cases = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ipad-portrait', width: 820, height: 1180, touch: true },
  { name: 'ipad-landscape', width: 1180, height: 820, touch: true },
  { name: 'ipad-classic', width: 1024, height: 768, touch: true },
  { name: 'narrow', width: 320, height: 740, touch: true },
  { name: 'mobile-breakpoint', width: 640, height: 900, touch: true },
  { name: 'desktop-breakpoint', width: 641, height: 900, touch: true },
  { name: 'large-text', width: 375, height: 1000, touch: true, largeText: true },
  { name: 'safe-area-narrow', width: 375, height: 1000, touch: true, insets: { left: 44, right: 34, bottom: 34 } },
  { name: 'safe-area-landscape', width: 812, height: 650, touch: true, insets: { left: 44, right: 44, bottom: 21 } },
  { name: 'safe-area-overflow', width: 320, height: 568, touch: true, insets: { top: 47, left: 44, right: 34, bottom: 34 } },
];
const messages = [
  'Playback connected.',
  '\u89c6\u9891\u52a0\u8f7d\u6682\u65f6\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002'.repeat(5),
  `https://example.invalid/media/${'long-path-without-spaces'.repeat(8)}`,
  'X'.repeat(96),
];
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'together-see-toast-layout-'));
let passed = 0;

for (const engine of engines) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({
    headless: true,
    ...(engine === 'chromium' && executablePath ? { executablePath } : {}),
  });
  try {
    for (const testCase of cases) {
      const context = await browser.newContext({
        viewport: { width: testCase.width, height: testCase.height },
        isMobile: Boolean(testCase.touch),
        hasTouch: Boolean(testCase.touch),
        deviceScaleFactor: testCase.touch ? 2 : 1,
      });
      try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        const viewportMeta = await page.evaluate((html) => {
          const document = new DOMParser().parseFromString(html, 'text/html');
          return document.querySelector('head meta[name="viewport"]')?.outerHTML;
        }, roomHtml);
        assert.ok(viewportMeta, 'room.html must define the viewport used by this fixture');
        await page.setContent(`<!doctype html><html><head>${viewportMeta}</head><body><div class="toast-stack" data-toast-stack></div></body></html>`);
        // Desktop engines expose zero hardware insets. Substitute only env() values
        // to exercise the real width/offset formulas; this is a simulated notch.
        const fixtureCss = testCase.insets
          ? css.replace(/env\(safe-area-inset-(top|left|right|bottom)(?:,\s*0px)?\)/g,
            (_, side) => `${testCase.insets[side] || 0}px`)
          : css;
        await page.addStyleTag({ content: fixtureCss });
        if (testCase.largeText) {
          await page.addStyleTag({ content: '.room-toast p { font-size: 25px; }' });
        }
        await page.evaluate(({ markup, messages }) => {
          const stack = document.querySelector('[data-toast-stack]');
          ['info', 'success', 'warning', 'error'].forEach((kind, index) => {
            const toast = document.createElement('div');
            toast.className = `room-toast room-toast-${kind}`;
            toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
            toast.innerHTML = markup;
            toast.querySelector('p').textContent = messages[index];
            toast.querySelector('button').addEventListener('click', () => toast.remove());
            stack.appendChild(toast);
          });
        }, { markup, messages });
        assert.equal(await page.locator('.room-toast').first().evaluate((el) => getComputedStyle(el).opacity), '0');
        await page.locator('.room-toast').evaluateAll((toasts) => toasts.forEach((el) => el.classList.add('is-visible')));
        await page.waitForFunction(() => [...document.querySelectorAll('.room-toast')]
          .every((el) => getComputedStyle(el).opacity === '1' && Math.abs(el.getBoundingClientRect().width - el.offsetWidth) < 1));

        const metrics = await page.evaluate(() => {
          const rect = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
          };
          return {
            stack: rect(document.querySelector('.toast-stack')),
            stackScrollHeight: document.querySelector('.toast-stack').scrollHeight,
            stackClientHeight: document.querySelector('.toast-stack').clientHeight,
            coarse: matchMedia('(any-pointer: coarse)').matches,
            toasts: [...document.querySelectorAll('.room-toast')].map((el) => {
              const button = el.querySelector('button');
              const text = el.querySelector('p');
              const style = getComputedStyle(button);
              return {
                box: rect(el), button: rect(button), dot: rect(el.querySelector('.room-toast-dot')), text: rect(text),
                scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
                textScrollWidth: text.scrollWidth, textClientWidth: text.clientWidth,
                appearance: style.appearance, padding: style.padding, fontSize: style.fontSize,
                name: button.getAttribute('aria-label'),
                marks: ['::before', '::after'].map((pseudo) => {
                  const s = getComputedStyle(button, pseudo);
                  return {
                    width: parseFloat(s.width), height: parseFloat(s.height),
                    left: parseFloat(s.left) + parseFloat(s.marginLeft),
                    top: parseFloat(s.top) + parseFloat(s.marginTop),
                    position: s.position, transform: s.transform, pointerEvents: s.pointerEvents,
                  };
                }),
              };
            }),
          };
        });
        const label = `${engine}/${testCase.name}`;
        const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1, `${label}: ${message}: ${actual} vs ${expected}`);
        const gap = testCase.width <= 640 ? 10 : 18;
        const left = Math.max(gap, testCase.insets?.left || 0);
        const right = Math.max(gap, testCase.insets?.right || 0);
        const bottom = Math.max(gap, testCase.insets?.bottom || 0);
        const top = Math.max(gap, testCase.insets?.top || 0);
        near(metrics.stack.right, testCase.width - right, 'right safe area');
        near(metrics.stack.bottom, testCase.height - bottom, 'bottom safe area');
        near(metrics.stack.width, testCase.width <= 640 ? testCase.width - left - right : Math.min(360, testCase.width - left - right), 'bounded width');
        assert.ok(metrics.stack.x >= left - 1, `${label}: left safe area`);
        assert.ok(metrics.stack.y >= top - 1, `${label}: top safe area`);
        assert.equal(metrics.coarse, Boolean(testCase.touch), `${label}: pointer emulation`);
        for (const toast of metrics.toasts) {
          near(toast.button.width, metrics.coarse ? 44 : 32, 'close target width');
          near(toast.button.height, toast.button.width, 'square close target');
          near(toast.button.y + toast.button.height / 2, toast.box.y + toast.box.height / 2, 'button vertical center');
          near(toast.dot.y + toast.dot.height / 2, toast.box.y + toast.box.height / 2, 'dot vertical center');
          near(toast.dot.x + toast.dot.width / 2, toast.box.x + (testCase.width <= 640 ? 12 : 13) + 5, 'dot track center');
          near(toast.dot.width, 9, 'dot width');
          near(toast.dot.height, 9, 'dot height');
          assert.ok(toast.text.x >= toast.dot.right && toast.text.right <= toast.button.x, `${label}: no text/control overlap`);
          assert.ok(toast.scrollWidth <= toast.clientWidth && toast.textScrollWidth <= toast.textClientWidth, `${label}: no horizontal overflow`);
          assert.equal(toast.appearance, 'none', `${label}: native appearance reset`);
          assert.equal(toast.padding, '0px', `${label}: native padding reset`);
          assert.equal(toast.fontSize, '0px', `${label}: original glyph hidden`);
          assert.ok(toast.name, `${label}: retained accessible name`);
          for (const mark of toast.marks) {
            assert.equal(mark.position, 'absolute');
            assert.equal(mark.pointerEvents, 'none');
            near(mark.width, 14, 'close stroke width');
            near(mark.height, 2, 'close stroke height');
            near(mark.left + mark.width / 2, toast.button.width / 2, 'close stroke horizontal center');
            near(mark.top + mark.height / 2, toast.button.height / 2, 'close stroke vertical center');
          }
          assert.notEqual(toast.marks[0].transform, toast.marks[1].transform, `${label}: crossing strokes`);
        }

        await page.screenshot({ path: path.join(outputDir, `${engine}-${testCase.name}.png`) });
        if (metrics.stackScrollHeight > metrics.stackClientHeight) {
          const firstText = await page.locator('.room-toast p').first().boundingBox();
          await page.mouse.move(firstText.x + firstText.width / 2, firstText.y + firstText.height / 2);
          await page.mouse.wheel(0, metrics.stackScrollHeight);
          await page.waitForFunction(() => {
            const stack = document.querySelector('.toast-stack');
            return stack.scrollTop >= stack.scrollHeight - stack.clientHeight - 1;
          });
          assert.equal(await page.locator('.room-toast button').last().evaluate((button) => {
            const r = button.getBoundingClientRect();
            const stack = document.querySelector('.toast-stack').getBoundingClientRect();
            return r.y >= stack.y && r.bottom <= stack.bottom
              && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button;
          }), true, `${label}: last close target reachable after scrolling`);
          await page.screenshot({ path: path.join(outputDir, `${engine}-${testCase.name}-scrolled.png`) });
        }
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('.room-toast button').first().evaluate((el) => el === document.activeElement), true, `${label}: keyboard focus`);
        assert.equal(await page.locator('.room-toast button').first().evaluate((el) => getComputedStyle(el).outlineStyle), 'solid', `${label}: visible focus`);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('.room-toast').count(), 3, `${label}: keyboard dismissal`);
        if (testCase.touch) await page.locator('.room-toast button').first().tap();
        else await page.locator('.room-toast button').first().click();
        assert.equal(await page.locator('.room-toast').count(), 2, `${label}: pointer dismissal`);
        passed += 1;
        console.log(`PASS ${label}${testCase.insets ? ' (simulated safe-area)' : ''}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
console.log(`Toast layout: ${passed} cases passed. Screenshots: ${outputDir}`);
