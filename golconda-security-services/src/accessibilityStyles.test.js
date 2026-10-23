import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

function luminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("public and complaint CTAs pass AA at every declared gradient stop", () => {
  const buttons = [...css.matchAll(/\.button-gold\{([^}]+)\}/g)].map(match => match[1]);
  assert.ok(buttons.length >= 2, "check base and later theme overrides, not only the first rule");
  for (const button of buttons) {
    const foreground = /(?:^|;)color:var\(--color-accent-fg\)/.test(button) ? "ffffff" : button.match(/(?:^|;)color:#([0-9a-f]{6})/i)?.[1];
    const gradient = button.match(/background:linear-gradient\([^;]+/)?.[0] || "";
    const stops = [...gradient.matchAll(/#[0-9a-f]{6}/gi)].map(match => match[0].slice(1));
    assert.ok(foreground && stops.length >= 2, "each CTA rule needs explicit foreground and gradient colors");
    for (const stop of stops) assert.ok(contrast(foreground, stop) >= 4.5, `CTA contrast failed at #${stop}`);
  }
  const complaintButton = css.match(/#complaints \.form-card \.button-gold\s*\{([\s\S]*?)\}/)?.[1] || "";
  const complaintForeground = complaintButton.match(/color:\s*#([0-9a-f]{6})/i)?.[1];
  const complaintGradient = complaintButton.match(/background:\s*linear-gradient\([\s\S]*?\);/)?.[0] || "";
  const complaintStops = ["1685bd", ...[...complaintGradient.matchAll(/#[0-9a-f]{6}/gi)].map(match => match[0].slice(1))];
  assert.ok(complaintForeground && complaintStops.length >= 2);
  for (const stop of complaintStops) assert.ok(contrast(complaintForeground, stop) >= 4.5, `Complaint CTA contrast failed at #${stop}`);
});

test("shared form and login placeholders meet AA and native select options have explicit colors", async () => {
  const placeholder = css.match(/--color-control-muted:#([0-9a-f]{6})/i)?.[1];
  const surface = css.match(/--color-control-bg:#([0-9a-f]{6})/i)?.[1];
  assert.ok(placeholder && surface);
  assert.ok(contrast(placeholder, surface) >= 4.5, "placeholder contrast must meet AA");
  const dialogPlaceholder = css.match(/--color-dialog-placeholder:#([0-9a-f]{6})/i)?.[1];
  assert.ok(dialogPlaceholder && contrast(dialogPlaceholder, "071724") >= 4.5, "lifecycle dialog placeholders must meet AA on the dark dialog field");
  assert.match(css, /\.form-card select option,\.record-dialog select option\{color:var\(--color-fg\);background:var\(--color-surface\)\}/);
  assert.match(css, /:focus-visible\{outline:2px solid var\(--color-focus\)/);
  const dialogs = await readFile(new URL("./admin/recordManagement.css", import.meta.url), "utf8");
  assert.match(dialogs, /record-dialog input::placeholder[^}]*color:var\(--color-dialog-placeholder\)/);
  const app = await readFile(new URL("./main.jsx", import.meta.url), "utf8");
  assert.match(app, /\.gss-admin-shell \.record-dialog input::placeholder[^}]*color:var\(--color-dialog-placeholder\)/);
  assert.match(dialogs, /record-dialog button:disabled\{[^}]*opacity:1/);
  assert.match(dialogs, /max-height:calc\(100dvh - 40px\)/);
});
