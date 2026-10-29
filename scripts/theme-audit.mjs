import assert from 'node:assert/strict';

/** Check visible enabled UI text against its composited background; fixtures contain no real account data. */
export async function auditTheme(page, label) {
  const report = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Color measurement unavailable');
    const rgba = css => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = css;
      context.fillRect(0, 0, 1, 1);
      const p = context.getImageData(0, 0, 1, 1).data;
      return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] / 255];
    };
    const over = (a, b) => {
      const alpha = a[3] + b[3] * (1 - a[3]);
      return alpha ? [0, 1, 2].map(i => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
    };
    const luminance = c => c.slice(0, 3).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
    const background = element => {
      let result = [0, 0, 0, 0];
      for (let node = element; node && result[3] < .999; node = node.parentElement) result = over(result, rgba(getComputedStyle(node).backgroundColor));
      return over(result, rgba('Canvas'));
    };
    const issues = [], measurements = [];
    const check = (element, style, kind) => {
      const bg = background(element), fg = over(rgba(style.color), bg);
      const value = ratio(fg, bg), size = parseFloat(style.fontSize), bold = parseFloat(style.fontWeight) >= 700;
      const required = size >= 24 || (size >= 18.667 && bold) ? 3 : 4.5;
      measurements.push(value);
      if (value + .01 < required) issues.push({ kind, element: element.tagName, className: element.className, text: (element.textContent || element.getAttribute('placeholder') || '').slice(0, 48), ratio: Number(value.toFixed(2)), required, color: style.color, background: bg });
    };
    for (const element of document.querySelectorAll('.odc-settings *, .odc-quick *')) {
      if (!element.getClientRects().length || element.matches(':disabled')) continue;
      let faded = false;
      for (let node = element; node && node.className !== 'odc-settings'; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < .99) faded = true;
      if (faded) continue;
      if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) check(element, getComputedStyle(element), 'text');
      if (element.matches('input[placeholder]')) check(element, getComputedStyle(element, '::placeholder'), 'placeholder');
    }
    // Native popup options have no client rect while closed, but their own colors
    // still determine the menu, independently of the select's painted surface.
    for (const select of document.querySelectorAll('.odc-settings select:not(:disabled)')) {
      if (!select.getClientRects().length) continue;
      for (const option of select.querySelectorAll('option:not(:disabled)')) {
        const style = getComputedStyle(option);
        if (rgba(style.backgroundColor)[3] < .99) issues.push({ kind: 'option-background', text: option.textContent });
        check(option, style, 'option');
      }
    }
    // Input and secondary-button boundaries must remain visible on their surroundings.
    for (const element of document.querySelectorAll('.odc-input:not(:disabled), .odc-button:not(.odc-button-primary):not(:disabled)')) {
      if (!element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      const bg = background(element.parentElement);
      const value = ratio(over(rgba(style.borderTopColor), bg), bg);
      if (value + .01 < 3) issues.push({ kind: 'control-boundary', element: element.tagName, ratio: Number(value.toFixed(2)), required: 3 });
    }
    return { checked: measurements.length, minimum: Math.min(...measurements), issues };
  });
  assert.ok(report.checked >= 8, `${label}: no meaningful visible UI was measured`);
  assert.deepEqual(report.issues, [], `${label}: insufficient text contrast`);
  return { label, checked: report.checked, minimum: Number(report.minimum.toFixed(2)) };
}
