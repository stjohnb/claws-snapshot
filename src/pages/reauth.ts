import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, HEAD_META, htmlOpenTag, buildPageHeader, THEME_SCRIPT } from "./layout.js";

export function buildReauthPage(theme: Theme): string {
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
  .auth-url-link {
    display: block; margin: 0.5em 0; padding: 0.6em; border: 1px solid var(--border);
    border-radius: 4px; background: var(--bg-secondary); color: var(--accent);
    font-family: monospace; font-size: 0.85rem; line-height: 1.5; overflow-wrap: anywhere;
  }
  .auth-url-link:hover { border-color: var(--accent); text-decoration: underline; }
  .auth-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5em; }
  .auth-btn {
    padding: 0.4rem 0.75rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--btn-bg); color: var(--text); cursor: pointer; font-size: 0.875rem; min-height: 32px;
  }
  .auth-btn:hover { background: var(--btn-hover); }
  .auth-code { padding: 0.4em; font-family: monospace; min-width: 20em; max-width: 100%; }
  .auth-user-code {
    font-family: monospace; font-size: 1.4rem; letter-spacing: 0.08em; padding: 0.4em 0.6em;
    border: 1px solid var(--border); border-radius: 4px; background: var(--bg-secondary); display: inline-block;
  }
  .hidden { display: none; }
  #status { margin-top: 1em; min-height: 1.4em; overflow-wrap: anywhere; max-width: 100%; }
  .status-ok { color: var(--success); font-weight: 600; }
  .status-err { color: var(--danger); font-weight: 600; }
  </style>
</head>
<body>
  ${buildPageHeader("Reauth", theme)}
  ${THEME_SCRIPT}
  <h2>Claude</h2>
  <p>Re-authenticate the <code>claude</code> CLI when its subscription credentials expire (the recurring <em>OAuth session expired</em> errors). This runs <code>claude setup-token</code> server-side and shows the authorization URL as a link you can tap or copy — no more wrapped terminal URLs.</p>
  <div class="auth-section">
    <button id="start-btn" class="auth-btn" type="button">Start login</button>
  </div>
  <div id="url-section" class="auth-section hidden">
    <p>1. Open this URL in your browser, authorize, then paste the code below:</p>
    <a id="url-link" class="auth-url-link" target="_blank" rel="noopener noreferrer"></a>
    <div class="auth-actions">
      <button id="copy-btn" class="auth-btn" type="button">Copy URL</button>
    </div>
    <p style="margin-top:1em">2. Paste the code from the browser — the whole value, including the part after the <code>#</code>:</p>
    <input id="code-input" class="auth-code" type="text" autocomplete="off" spellcheck="false" placeholder="paste full code#state here">
    <button id="complete-btn" class="auth-btn" type="button">Complete login</button>
  </div>
  <div id="status"></div>
  <script>
    (function () {
      var startBtn = document.getElementById("start-btn");
      var urlSection = document.getElementById("url-section");
      var urlLink = document.getElementById("url-link");
      var copyBtn = document.getElementById("copy-btn");
      var codeInput = document.getElementById("code-input");
      var completeBtn = document.getElementById("complete-btn");
      var status = document.getElementById("status");

      function setStatus(msg, ok) {
        status.textContent = msg;
        status.className = ok === undefined ? "" : ok ? "status-ok" : "status-err";
      }

      function setUrl(url) {
        urlLink.textContent = url;
        urlLink.href = /^https?:\/\//i.test(url) ? url : "#";
      }

      function selectUrlText() {
        try {
          var range = document.createRange();
          range.selectNodeContents(urlLink);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) { /* selection unsupported */ }
      }

      function startLogin(prefix) {
        startBtn.disabled = true;
        setStatus(prefix ? prefix + " Fetching a fresh URL…" : "Starting login…", prefix ? false : undefined);
        return fetch("/api/claude-auth/start", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok && d.url) {
              setUrl(d.url);
              urlSection.classList.remove("hidden");
              setStatus(
                prefix
                  ? prefix + " A fresh URL is ready above — authorize again and paste the new code."
                  : "URL ready — open it, authorize, then paste the code.",
                undefined
              );
            } else {
              setStatus((d && d.error) || "Failed to start login", false);
            }
          })
          .catch(function (e) { setStatus("Request failed: " + e, false); })
          .then(function () { startBtn.disabled = false; });
      }

      startBtn.addEventListener("click", function () { startLogin(""); });

      copyBtn.addEventListener("click", function () {
        var url = urlLink.textContent;
        function fallback() {
          selectUrlText();
          var ok = false;
          try {
            var ta = document.createElement("textarea");
            ta.value = url;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ok = document.execCommand("copy");
            document.body.removeChild(ta);
          } catch (e) { ok = false; }
          setStatus(ok ? "URL copied to clipboard." : "Copy failed — the URL is selected, copy it manually.", ok ? undefined : false);
        }
        if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
        navigator.clipboard.writeText(url).then(function () { setStatus("URL copied to clipboard."); }, fallback);
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
            } else if (d && d.retryable === false) {
              urlSection.classList.add("hidden");
              codeInput.value = "";
              startLogin(d.error || "Login failed.");
            } else {
              setStatus((d && d.error) || "Failed to complete login", false);
              if (d) codeInput.value = "";
            }
          })
          .catch(function (e) { setStatus("Request failed: " + e, false); })
          .then(function () { completeBtn.disabled = false; });
      });

      fetch("/api/claude-auth/status")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.status === "awaiting-code" && d.url) {
            setUrl(d.url);
            urlSection.classList.remove("hidden");
            setStatus("Login already in progress — paste the code below.");
          } else if (d && d.status === "failed" && d.error) {
            setStatus(d.error, false);
          }
        })
        .catch(function () {});
    })();
  </script>
  <h2>Codex</h2>
  <p>Re-authenticate the <code>codex</code> CLI when its ChatGPT session expires. This runs <code>codex login --device-auth</code> server-side — the browser-callback login listens on <code>127.0.0.1:1455</code>, which is unreachable from here, so the device-code flow is the only headless option.</p>
  <div class="auth-section">
    <button id="cx-start-btn" class="auth-btn" type="button">Start Codex login</button>
  </div>
  <div id="cx-flow" class="auth-section hidden">
    <p>1. Open this link in your browser and sign in to your ChatGPT account:</p>
    <a id="cx-url-link" class="auth-url-link" target="_blank" rel="noopener noreferrer"></a>
    <p style="margin-top:1em">2. Enter this one-time code:</p>
    <span id="cx-code" class="auth-user-code"></span>
    <div class="auth-actions">
      <button id="cx-copy-btn" class="auth-btn" type="button">Copy code</button>
    </div>
    <p class="field-note">The code expires 15 minutes after it is issued. This page finishes on its own once you authorize — there is nothing to paste back.</p>
  </div>
  <div id="cx-status"></div>
  <script>
    (function () {
      var startBtn = document.getElementById("cx-start-btn");
      var flow = document.getElementById("cx-flow");
      var urlLink = document.getElementById("cx-url-link");
      var codeEl = document.getElementById("cx-code");
      var copyBtn = document.getElementById("cx-copy-btn");
      var status = document.getElementById("cx-status");
      var polling = false;

      function setStatus(msg, ok) {
        status.textContent = msg;
        status.className = ok === undefined ? "" : ok ? "status-ok" : "status-err";
      }

      function isHttp(u) {
        return u.indexOf("https://") === 0 || u.indexOf("http://") === 0;
      }

      function show(url, code) {
        urlLink.textContent = url;
        urlLink.href = isHttp(url) ? url : "#";
        codeEl.textContent = code;
        flow.classList.remove("hidden");
      }

      function poll() {
        if (!polling) return;
        setTimeout(function () {
          if (!polling) return;
          fetch("/api/codex-auth/status")
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d) { poll(); return; }
              if (d.status === "completed") {
                polling = false;
                setStatus("Codex login complete — credentials refreshed.", true);
                startBtn.disabled = false;
              } else if (d.status === "failed") {
                polling = false;
                setStatus(d.error || "Codex login failed.", false);
                startBtn.disabled = false;
              } else {
                poll();
              }
            })
            // A fetch rejection must not stop the loop — the pod may be mid-restart.
            .catch(function () { poll(); });
        }, 3000);
      }

      function startPolling() {
        if (polling) return;
        polling = true;
        poll();
      }

      startBtn.addEventListener("click", function () {
        startBtn.disabled = true;
        polling = false;
        setStatus("Starting Codex login…");
        fetch("/api/codex-auth/start", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.ok && d.url && d.userCode) {
              show(d.url, d.userCode);
              setStatus("Waiting for you to authorize in the browser…");
              startPolling();
            } else {
              setStatus((d && d.error) || "Failed to start Codex login", false);
              startBtn.disabled = false;
            }
          })
          .catch(function (e) {
            setStatus("Request failed: " + e, false);
            startBtn.disabled = false;
          });
      });

      copyBtn.addEventListener("click", function () {
        var code = codeEl.textContent;
        function fallback() {
          var ok = false;
          try {
            var ta = document.createElement("textarea");
            ta.value = code;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ok = document.execCommand("copy");
            document.body.removeChild(ta);
          } catch (e) { ok = false; }
          setStatus(ok ? "Code copied to clipboard." : "Copy failed — copy the code manually.", ok ? undefined : false);
        }
        if (!navigator.clipboard || !navigator.clipboard.writeText) { fallback(); return; }
        navigator.clipboard.writeText(code).then(function () { setStatus("Code copied to clipboard."); }, fallback);
      });

      // Restore an in-flight login so a page reload does not orphan the PTY.
      fetch("/api/codex-auth/status")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.status === "awaiting-authorization" && d.url && d.userCode) {
            show(d.url, d.userCode);
            startBtn.disabled = true;
            setStatus("Login already in progress — waiting for you to authorize in the browser…");
            startPolling();
          } else if (d && d.status === "failed" && d.error) {
            setStatus(d.error, false);
          }
        })
        .catch(function () {});
    })();
  </script>
</body>
</html>`;
}
