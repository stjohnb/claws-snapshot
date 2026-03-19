import type { Theme } from "./layout.js";
import { PAGE_CSS, htmlOpenTag, THEME_SCRIPT } from "./layout.js";

export function buildLoginPage(error: boolean, theme: Theme): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — login</title>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <h1>claws</h1>
  <div class="login-form">
    <h2>Login</h2>
    ${error ? '<div class="login-error">Invalid token. Please try again.</div>' : ""}
    <form method="POST" action="/login">
      <label for="token">Auth Token</label>
      <input type="password" name="token" id="token" autofocus>
      <button type="submit" class="save-btn">Login</button>
    </form>
  </div>
</body>
</html>`;
}
