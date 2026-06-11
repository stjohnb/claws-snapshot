// Alpine.js component factory for the /sessions page. Exposed on `window` so
// Alpine's `x-data="sessionsListPage()"` directive can find it. Alpine itself
// is loaded separately via ALPINE_SCRIPT.
interface SessionsListPage {
  killSession(id: string): Promise<void>;
  onRepoChange(): void;
}

function sessionsListPage(): SessionsListPage {
  return {
    async killSession(id: string): Promise<void> {
      if (!confirm("Kill this session?")) return;
      await fetch("/sessions/" + encodeURIComponent(id) + "/kill", { method: "POST" });
      location.reload();
    },
    onRepoChange(): void {
      const repoEl = document.getElementById("session-repo") as HTMLSelectElement | null;
      const mode = document.getElementById("session-mode") as HTMLSelectElement | null;
      if (!repoEl || !mode) return;
      const repo = repoEl.value;
      const opts = mode.querySelectorAll("option");
      for (let i = 0; i < opts.length; i++) {
        const opt = opts[i] as HTMLOptionElement;
        const v = opt.value;
        if (repo) {
          opt.disabled = v === "home-claude";
          if (v === "repo-zsh") opt.text = "zsh in repo";
        } else {
          opt.disabled = v === "worktree-claude" || v === "repo-claude";
          if (v === "repo-zsh") opt.text = "zsh (home directory)";
        }
      }
      const current = mode.options[mode.selectedIndex] as HTMLOptionElement | undefined;
      if (current && current.disabled) mode.value = repo ? "worktree-claude" : "home-claude";
    },
  };
}

(window as unknown as { sessionsListPage: () => SessionsListPage }).sessionsListPage = sessionsListPage;

(function showFlashIfAny() {
  function show(text: string): void {
    const el = document.getElementById("session-flash");
    if (!el) return;
    el.textContent = text;
    el.style.display = "block";
    setTimeout(() => { el.style.display = "none"; }, 4000);
  }
  let stored: string | null = null;
  try { stored = window.sessionStorage.getItem("claws.sessionFlash"); } catch { /* ignore */ }
  if (stored) {
    try { window.sessionStorage.removeItem("claws.sessionFlash"); } catch { /* ignore */ }
    show(stored);
    const params = new URLSearchParams(window.location.search);
    if (params.get("notice") === "session-exited") {
      params.delete("notice");
      const qs = params.toString();
      history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    }
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (params.get("notice") === "session-exited") {
    show("Session exited cleanly.");
    params.delete("notice");
    const qs = params.toString();
    history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
  }
})();
