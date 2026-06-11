// Alpine.js component factory for /queue. Endpoints (/queue/merge, /queue/skip,
// /queue/unskip, /queue/prioritize, /queue/deprioritize, /queue/unmark-problematic,
// /queue/mark-refined) and their JSON shapes are parsed by src/server.ts — keep wire formats in sync.
interface QueuePage {
  mergePR(repo: string, prNumber: number, ev: Event): Promise<void>;
  skipItem(repo: string, number: number, ev: Event): Promise<void>;
  unskipItem(repo: string, number: number, ev: Event): Promise<void>;
  togglePriority(repo: string, number: number, ev: Event): Promise<void>;
  unmarkProblematic(repo: string, number: number, ev: Event): Promise<void>;
  markRefined(repo: string, number: number, ev: Event): Promise<void>;
  refreshQueue(ev: Event): Promise<void>;
  refreshStatus: string;
}

function btnFromEvent(ev: Event): HTMLButtonElement {
  return ev.currentTarget as HTMLButtonElement;
}

function queuePage(): QueuePage {
  return {
    refreshStatus: "",

    async refreshQueue(ev: Event): Promise<void> {
      const btn = ev.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      const original = btn.textContent ?? "Refresh from GitHub";
      btn.textContent = "Refreshing...";
      this.refreshStatus = "Triggering rescan...";
      try {
        const r = await fetch("/queue/refresh", { method: "POST" });
        const data = (await r.json()) as { results?: Record<string, string>; error?: string };
        if (!r.ok || data.error) {
          this.refreshStatus = "Refresh failed";
          btn.textContent = original;
          btn.disabled = false;
          return;
        }
        const summary = Object.entries(data.results ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        this.refreshStatus = `Started (${summary}). Reloading…`;
        setTimeout(() => location.reload(), 4000);
      } catch {
        this.refreshStatus = "Refresh failed";
        btn.textContent = original;
        btn.disabled = false;
      }
    },

    async mergePR(repo: string, prNumber: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const row = btn.closest(".queue-item");
      row?.querySelector(".merge-error")?.remove();
      btn.disabled = true;
      btn.textContent = "Merging...";
      const showError = (msg: string): void => {
        btn.textContent = "Retry Merge";
        btn.disabled = false;
        btn.title = msg;
        if (row) {
          const span = document.createElement("span");
          span.className = "merge-error";
          span.textContent = `Merge failed: ${msg}`;
          btn.insertAdjacentElement("afterend", span);
        }
      };
      try {
        const r = await fetch("/queue/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, prNumber }),
        });
        const data = (await r.json()) as { error?: string };
        if (!r.ok || data.error) {
          showError(data.error ?? `HTTP ${r.status}`);
        } else {
          btn.textContent = "Merged!";
        }
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
      }
    },

    async skipItem(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      btn.disabled = true;
      btn.textContent = "Skipping...";
      try {
        const r = await fetch("/queue/skip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          btn.textContent = "Error";
          setTimeout(() => {
            btn.textContent = "Skip";
            btn.disabled = false;
          }, 3000);
        } else {
          const row = btn.closest(".queue-item");
          if (row) row.remove();
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = "Skip";
          btn.disabled = false;
        }, 3000);
      }
    },

    async unskipItem(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      btn.disabled = true;
      btn.textContent = "Restoring...";
      try {
        const r = await fetch("/queue/unskip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          btn.textContent = "Error";
          setTimeout(() => {
            btn.textContent = "Restore";
            btn.disabled = false;
          }, 3000);
        } else {
          const row = btn.closest(".queue-item");
          if (row) row.remove();
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = "Restore";
          btn.disabled = false;
        }, 3000);
      }
    },

    async togglePriority(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const mode = btn.dataset.mode;
      const isPrio = mode === "prio";
      const endpoint = isPrio ? "/queue/prioritize" : "/queue/deprioritize";
      const pending = isPrio ? "Prioritising..." : "Deprioritising...";
      const labelOnFail = isPrio ? "Prioritise" : "Deprioritise";
      btn.disabled = true;
      btn.textContent = pending;
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          btn.textContent = "Error";
          setTimeout(() => {
            btn.textContent = labelOnFail;
            btn.disabled = false;
          }, 3000);
        } else {
          if (isPrio) {
            btn.textContent = "Deprioritise";
            btn.className = "prio-btn deprio";
            btn.dataset.mode = "deprio";
          } else {
            btn.textContent = "Prioritise";
            btn.className = "prio-btn";
            btn.dataset.mode = "prio";
          }
          btn.disabled = false;
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = labelOnFail;
          btn.disabled = false;
        }, 3000);
      }
    },

    async unmarkProblematic(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      btn.disabled = true;
      btn.textContent = "Unmarking...";
      try {
        const r = await fetch("/queue/unmark-problematic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          btn.textContent = "Error";
          setTimeout(() => {
            btn.textContent = "Unmark";
            btn.disabled = false;
          }, 3000);
        } else {
          const item = document.getElementById("problematic-" + repo + "-" + number);
          if (item) item.style.display = "none";
          btn.textContent = "Unmarked";
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = "Unmark";
          btn.disabled = false;
        }, 3000);
      }
    },

    async markRefined(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      btn.disabled = true;
      btn.textContent = "Marking...";
      try {
        const r = await fetch("/queue/mark-refined", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          btn.textContent = "Error";
          setTimeout(() => { btn.textContent = "Refined"; btn.disabled = false; }, 3000);
        } else {
          btn.textContent = "Refined ✓";
          btn.disabled = true;
          btn.classList.add("refined-done");
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => { btn.textContent = "Refined"; btn.disabled = false; }, 3000);
      }
    },
  };
}

(window as unknown as { queuePage: () => QueuePage }).queuePage = queuePage;
