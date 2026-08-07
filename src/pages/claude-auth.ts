import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";

export function buildClaudeAuthPage(theme: Theme): string {
  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${HEAD_META}
  <title>claws — reauth</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .auth-section { margin: 1em 0; }
  .auth-url { width: 100%; box-sizing: border-box; font-family: monospace; font-size: 0.9em; padding: 0.5em; }
  .auth-code { padding: 0.4em; font-family: monospace; min-width: 20em; }
  .hidden { display: none; }
  #status { margin-top: 1em; min-height: 1.4em; }
  .status-ok { color: #0e8a16; font-weight: 600; }
  .status-err { color: #d73a4a; font-weight: 600; }
  </style>
</head>
<body>
  ${buildPageHeader("Reauth", theme)}
  ${THEME_SCRIPT}
  <p>Re-authenticate the <code>claude</code> CLI when its subscription credentials expire (the recurring <em>OAuth session expired</em> errors). This runs <code>claude setup-token</code> server-side and shows the authorization URL as selectable text so it is easy to copy — no more wrapped terminal URLs.</p>
  <div class="auth-section">
    <button id="start-btn" type="button">Start login</button>
  </div>
  <div id="url-section" class="auth-section hidden">
    <p>1. Open this URL in your browser, authorize, then paste the code below:</p>
    <input id="url-input" class="auth-url" type="text" readonly onclick="this.select()">
    <div style="margin-top:0.5em"><button id="copy-btn" type="button">Copy URL</button></div>
    <p style="margin-top:1em">2. Paste the code from the browser:</p>
    <input id="code-input" class="auth-code" type="text" autocomplete="off" spellcheck="false" placeholder="paste code here">
    <button id="complete-btn" type="button">Complete login</button>
  </div>
  <div id="status"></div>
  <script>
    (function () {
      var startBtn = document.getElementById("start-btn");
      var urlSection = document.getElementById("url-section");
      var urlInput = document.getElementById("url-input");
      var copyBtn = document.getElementById("copy-btn");
      var codeInput = document.getElementById("code-input");
      var completeBtn = document.getElementById("complete-btn");
      var status = document.getElementById("status");

      function setStatus(msg, ok) {
        status.textContent = msg;
        status.className = ok === undefined ? "" : ok ? "status-ok" : "status-err";
      }

      startBtn.addEventListener("click", function () {
        startBtn.disabled = true;
        setStatus("Starting login…");
        fetch("/api/claude-auth/start", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok && d.url) {
              urlInput.value = d.url;
              urlSection.classList.remove("hidden");
              setStatus("URL ready — open it, authorize, then paste the code.");
            } else {
              setStatus((d && d.error) || "Failed to start login", false);
            }
          })
          .catch(function (e) { setStatus("Request failed: " + e, false); })
          .then(function () { startBtn.disabled = false; });
      });

      copyBtn.addEventListener("click", function () {
        urlInput.select();
        navigator.clipboard.writeText(urlInput.value).then(
          function () { setStatus("URL copied to clipboard."); },
          function () { setStatus("Copy failed — select the URL manually.", false); }
        );
      });

      completeBtn.addEventListener("click", function () {
        var code = codeInput.value;
        completeBtn.disabled = true;
        setStatus("Completing login…");
        fetch("/api/claude-auth/code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code }),
        })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok) {
              setStatus("Login complete — the token has been refreshed.", true);
            } else {
              setStatus((d && d.error) || "Failed to complete login", false);
            }
          })
          .catch(function (e) { setStatus("Request failed: " + e, false); })
          .then(function () { completeBtn.disabled = false; });
      });
    })();
  </script>
</body>
</html>`;
}
