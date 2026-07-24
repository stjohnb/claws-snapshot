// Alpine.js component factory for the /sessions page. Exposed on `window` so
// Alpine's `x-data="sessionsListPage()"` directive can find it. Alpine itself
// is loaded separately via ALPINE_SCRIPT.
interface SessionsListPage {
  killSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  resumeSession(id: string): Promise<void>;
  onRepoChange(): void;
}

function sessionsListPage(): SessionsListPage {
  return {
    async killSession(id: string): Promise<void> {
      if (!confirm("End this session? It will be kept in history.")) return;
      await fetch("/sessions/" + encodeURIComponent(id) + "/kill", { method: "POST" });
      location.reload();
    },
    async deleteSession(id: string): Promise<void> {
      if (!confirm("Permanently delete this session from history?")) return;
      await fetch("/sessions/" + encodeURIComponent(id) + "/delete", { method: "POST" });
      location.reload();
    },
    async resumeSession(id: string): Promise<void> {
      const res = await fetch("/sessions/" + encodeURIComponent(id) + "/resume", { method: "POST" });
      if (res.redirected) { location.href = res.url; return; }
      if (!res.ok) { alert("Failed to resume session: " + (await res.text())); return; }
      location.href = "/sessions/" + encodeURIComponent(id);
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

      const capList = document.getElementById("single-cap-list");
      if (capList) {
        const showAllEl = document.getElementById("cap-show-all") as HTMLInputElement | null;
        const showAll = !!showAllEl && showAllEl.checked;
        const labels = capList.querySelectorAll("label[data-cap]");
        let visible = 0;
        for (let i = 0; i < labels.length; i++) {
          const label = labels[i] as HTMLElement;
          let show = showAll;
          if (!show && repo) {
            let list: string[] = [];
            try { list = JSON.parse(label.getAttribute("data-cap-repos") || "[]"); } catch { list = []; }
            show = list.indexOf(repo) !== -1;
          }
          label.style.display = show ? "inline-flex" : "none";
          if (show) {
            visible++;
          } else {
            const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
            if (cb) cb.checked = false;
          }
        }
        const empty = document.getElementById("single-cap-empty");
        if (empty) empty.style.display = visible === 0 && !showAll ? "block" : "none";
      }
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
