import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("./styles.css", import.meta.url), "utf8");

function normalizedHex(value) {
  const digits = String(value).replace(/^#/, "");
  return digits.length === 3 ? [...digits].map(part => part + part).join("") : digits;
}

function luminance(hex) {
  const channels = normalizedHex(hex).match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function tokensFrom(source) {
  return Object.fromEntries([...source.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})/gi)].map(([, name, value]) => [`--${name}`, value]));
}

function resolveVars(value, tokens) {
  return value.replace(/var\((--[\w-]+)\)/g, (_match, token) => {
    assert.ok(tokens[token], `missing color token ${token}`);
    return tokens[token];
  });
}

function colorProperty(rule, property, tokens) {
  const match = new RegExp(`(?:^|[;{])\\s*${property}\\s*:\\s*(#[0-9a-f]{3,8}|var\\(--[\\w-]+\\))`, "i").exec(rule);
  assert.ok(match, `missing ${property} color in ${rule}`);
  const color = resolveVars(match[1], tokens);
  return color.slice(1);
}

function gradientStops(rule, tokens) {
  const gradient = /background:\s*linear-gradient\([^;]+/i.exec(rule)?.[0] || "";
  const resolved = resolveVars(gradient, tokens);
  return [...resolved.matchAll(/#([0-9a-f]{3,8})/gi)].map(match => normalizedHex(match[1]));
}

test("public CTA default, hover, active, and complaint states meet AA at each gradient stop", async () => {
  const tokens = tokensFrom(css);
  const buttons = [...css.matchAll(/\.button-gold\{([^}]+)\}/g)].map(match => match[1]);
  assert.ok(buttons.length >= 2, "check every theme override");
  for (const button of buttons) {
    const foreground = colorProperty(button, "color", tokens);
    const stops = gradientStops(button, tokens);
    assert.ok(stops.length >= 2, "each primary CTA needs a two-stop gradient");
    for (const stop of stops) assert.ok(contrast(foreground, stop) >= 4.5, `CTA contrast failed at #${stop}`);
  }

  const hover = css.match(/\.button-gold:hover[^}]*\}/)?.[0] || "";
  const hoverForeground = colorProperty(hover, "color", tokens);
  assert.ok(gradientStops(hover, tokens).every(stop => contrast(hoverForeground, stop) >= 4.5));
  const active = css.match(/\.button-gold:active[^}]*\}/)?.[0] || "";
  assert.ok(contrast(colorProperty(active, "color", tokens), colorProperty(active, "background", tokens)) >= 4.5);

  const complaintButton = css.match(/#complaints \.form-card \.button-gold\s*\{([\s\S]*?)\}/)?.[1] || "";
  const complaintForeground = colorProperty(complaintButton, "color", tokens);
  assert.ok(gradientStops(complaintButton, tokens).every(stop => contrast(complaintForeground, stop) >= 4.5));
  const complaintHover = css.match(/#complaints \.form-card \.button-gold:hover\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(complaintHover, /filter:\s*brightness\(1\.04\)/);
});

test("admin primary, secondary, disabled, and destructive button colors meet AA in every state", async () => {
  const app = await readFile(new URL("./main.jsx", import.meta.url), "utf8");
  const adminStyles = /<style>\{`([\s\S]*?)`\}<\/style>/.exec(app)?.[1] || "";
  assert.ok(adminStyles, "admin button styles must remain visible for inspection");
  const tokens = tokensFrom(adminStyles);
  const pairs = [
    ["--button-primary-fg", "--button-primary-bg"],
    ["--button-primary-fg", "--button-primary-hover"],
    ["--button-primary-fg", "--button-primary-active"],
    ["--button-secondary-fg", "--button-secondary-bg"],
    ["--button-secondary-fg", "--button-secondary-hover"],
    ["--button-secondary-fg", "--button-secondary-active"],
    ["--button-disabled-fg", "--button-disabled-bg"],
    ["--button-danger-fg", "--button-danger-bg"],
  ];
  for (const [foreground, background] of pairs) {
    assert.ok(tokens[foreground] && tokens[background], `missing button tokens ${foreground}/${background}`);
    assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `button contrast failed for ${foreground} on ${background}`);
  }
  assert.ok(contrast(tokens["--button-focus"], "ffffff") >= 3, "focus indicator must be distinguishable on admin surfaces");
  for (const state of [".gss-admin-primary:hover:not(:disabled)", ".gss-admin-primary:active:not(:disabled)", ".gss-admin-secondary:hover:not(:disabled)", ".gss-admin-secondary:active:not(:disabled)", ".gss-admin-primary:disabled", ".gss-admin-secondary:disabled", ".gss-admin-item-actions button.danger:hover:not(:disabled)", ".gss-admin-primary:focus-visible"]) {
    assert.ok(adminStyles.includes(state), `missing visible button state ${state}`);
  }
  assert.match(adminStyles, /\.gss-admin-item-actions button\.danger\{color:#b42318/);
});

test("shared control and confirmation-dialog text, focus, disabled, and hover styles stay readable", async () => {
  const tokens = tokensFrom(css);
  const placeholder = tokens["--color-control-muted"];
  const surface = tokens["--color-control-bg"];
  assert.ok(placeholder && surface);
  assert.ok(contrast(placeholder, surface) >= 4.5, "placeholder contrast must meet AA");
  const dialogPlaceholder = tokens["--color-dialog-placeholder"];
  assert.ok(dialogPlaceholder && contrast(dialogPlaceholder, "071724") >= 4.5, "lifecycle dialog placeholders must meet AA");
  assert.match(css, /\.form-card select option,\.record-dialog select option\{color:var\(--color-fg\);background:var\(--color-surface\)\}/);
  assert.match(css, /:focus-visible\{outline:2px solid var\(--color-focus\)/);

  const dialogs = await readFile(new URL("./admin/recordManagement.css", import.meta.url), "utf8");
  assert.match(dialogs, /record-dialog input::placeholder[^}]*color:var\(--color-dialog-placeholder\)/);
  assert.match(dialogs, /record-dialog button:disabled\{[^}]*opacity:1/);
  assert.match(dialogs, /record-dialog button:hover:not\(:disabled\)\{background:#1d5578/);
  const dialogButtonForeground = "e8f2fa";
  for (const background of ["163c56", "1d5578", "28485e"]) {
    const foreground = background === "28485e" ? "d3e1e9" : dialogButtonForeground;
    assert.ok(contrast(foreground, background) >= 4.5, `confirmation-dialog button contrast failed at #${background}`);
  }
});
