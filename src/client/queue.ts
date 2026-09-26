// Alpine.js component factory for the /prs and /issues row actions
// (src/pages/lists.ts). Endpoints (/queue/merge, /queue/skip,
// /queue/unskip, /queue/prioritize, /queue/deprioritize, /queue/unmark-problematic,
// /queue/mark-refined, /queue/mark-automerge) and their JSON shapes are parsed by
// src/server.ts — keep wire formats in sync. /queue/merge also accepts an
// optional `confirmInfra` flag when the PR touches tofu/terraform paths (#2275).
/** An issue reference: a forge number, or a Claws-native `clw_…` id (#3215). */
type IssueRef = number | string;

interface QueuePage {
  mergePR(repo: string, prNumber: number, ev: Event, infraNote?: string): Promise<void>;
  skipItem(repo: string, number: IssueRef, ev: Event): Promise<void>;
  unskipItem(repo: string, number: IssueRef, ev: Event): Promise<void>;
  togglePriority(repo: string, number: IssueRef, ev: Event): Promise<void>;
  unmarkProblematic(repo: string, number: number, ev: Event): Promise<void>;
  markRefined(repo: string, number: IssueRef, ev: Event): Promise<void>;
  markAutomerge(repo: string, number: IssueRef, ev: Event, alsoRefine?: boolean): Promise<void>;
  refreshQueue(ev: Event): Promise<void>;
  refreshStatus: string;
}

function btnFromEvent(ev: Event): HTMLButtonElement {
  return ev.currentTarget as HTMLButtonElement;
}

/** Freeze the button's box before swapping in a transient label, so the
 *  in-flight text cannot resize the surrounding table column (#2301). */
function lockWidth(btn: HTMLElement): void {
  btn.style.minWidth = `${btn.getBoundingClientRect().width}px`;
}
function unlockWidth(btn: HTMLElement): void {
  btn.style.minWidth = "";
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

    async mergePR(repo: string, prNumber: number, ev: Event, infraNote?: string): Promise<void> {
      if (infraNote && !window.confirm(`PR #${prNumber} in ${repo} changes infrastructure (tofu/terraform).\n\nPlan: ${infraNote}\n\nMerging applies real infra changes. Continue?`)) return;
      const btn = btnFromEvent(ev);
      const row = btn.closest("tr");
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
          body: JSON.stringify({ repo, prNumber, confirmInfra: infraNote != null && infraNote !== "" }),
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

    async skipItem(repo: string, number: IssueRef, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const isSkip = btn.dataset.mode !== "unskip";
      const endpoint = isSkip ? "/queue/skip" : "/queue/unskip";
      const pending = isSkip ? "Skipping..." : "Restoring...";
      const labelOnFail = isSkip ? "Skip" : "Restore";
      lockWidth(btn);
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
            unlockWidth(btn);
          }, 3000);
        } else {
          const row = btn.closest("tr");
          const badge = row?.querySelector(".skip-badge") ?? null;
          if (isSkip) {
            btn.textContent = "Restore";
            btn.classList.add("unskip");
            btn.dataset.mode = "unskip";
            if (!badge) row?.querySelector(".cell-title")?.insertAdjacentHTML("beforeend", ` <span class="skip-badge">Skipped</span>`);
          } else {
            btn.textContent = "Skip";
            btn.classList.remove("unskip");
            btn.dataset.mode = "skip";
            badge?.remove();
          }
          btn.disabled = false;
          unlockWidth(btn);
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = labelOnFail;
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async unskipItem(repo: string, number: IssueRef, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      lockWidth(btn);
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
            unlockWidth(btn);
          }, 3000);
        } else {
          const row = btn.closest("tr");
          if (row) row.remove();
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = "Restore";
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async togglePriority(repo: string, number: IssueRef, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const mode = btn.dataset.mode;
      const isPrio = mode === "prio";
      const endpoint = isPrio ? "/queue/prioritize" : "/queue/deprioritize";
      const pending = isPrio ? "Prioritising..." : "Deprioritising...";
      const labelOnFail = isPrio ? "Prioritise" : "Deprioritise";
      lockWidth(btn);
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
            unlockWidth(btn);
          }, 3000);
        } else {
          if (isPrio) {
            btn.textContent = "Deprioritise";
            btn.classList.add("deprio");
            btn.dataset.mode = "deprio";
          } else {
            btn.textContent = "Prioritise";
            btn.classList.remove("deprio");
            btn.dataset.mode = "prio";
          }
          btn.disabled = false;
          unlockWidth(btn);
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = labelOnFail;
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async unmarkProblematic(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const original = btn.textContent ?? "Unmark problematic";
      lockWidth(btn);
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
            btn.textContent = original;
            btn.disabled = false;
            unlockWidth(btn);
          }, 3000);
        } else {
          btn.textContent = "Unmarked";
          btn.classList.add("refined-done");
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async markRefined(repo: string, number: IssueRef, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      lockWidth(btn);
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
          setTimeout(() => { btn.textContent = "Refined"; btn.disabled = false; unlockWidth(btn); }, 3000);
        } else {
          btn.textContent = "Refined";
          btn.disabled = true;
          btn.classList.add("refined-done");
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => { btn.textContent = "Refined"; btn.disabled = false; unlockWidth(btn); }, 3000);
      }
    },

    async markAutomerge(repo: string, number: IssueRef, ev: Event, alsoRefine?: boolean): Promise<void> {
      const btn = btnFromEvent(ev);
      const original = btn.textContent ?? "Automerge";
      lockWidth(btn);
      btn.disabled = true;
      btn.textContent = "Marking...";
      try {
        const r = await fetch("/queue/mark-automerge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number, alsoRefine }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          btn.textContent = "Error";
          setTimeout(() => { btn.textContent = original; btn.disabled = false; unlockWidth(btn); }, 3000);
        } else {
          btn.textContent = original;
          btn.disabled = true;
          btn.classList.add("refined-done");
        }
      } catch {
        btn.textContent = "Error";
        setTimeout(() => { btn.textContent = original; btn.disabled = false; unlockWidth(btn); }, 3000);
      }
    },
  };
}

(window as unknown as { queuePage: () => QueuePage }).queuePage = queuePage;
