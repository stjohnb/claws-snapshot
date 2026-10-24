// Alpine.js component factory for the /prs and /issues row actions
// (src/pages/lists.ts). Endpoints (/queue/merge, /queue/skip,
// /queue/unskip, /queue/prioritize, /queue/deprioritize, /queue/unmark-problematic,
// /queue/mark-refined, /queue/mark-automerge) and their JSON shapes are parsed by
// src/server.ts — keep wire formats in sync. /queue/merge also accepts an
// optional `confirmInfra` flag when the PR touches tofu/terraform paths (#2275).
// /queue/merge and /queue/mark-automerge also accept `confirmManual`, sent once
// the operator confirms past a PR's unmet-manual-action warning.
// /prs/start-session takes `{repo, number}` and answers `{ok, id, url}` or `{error}`;
// on success the row swaps the button for a Go to session link without navigating.
/** An issue reference: a forge number, or a Claws-native `clw_…` id (#3215). */
type IssueRef = number | string;

interface QueuePage {
  mergePR(repo: string, prNumber: number, ev: Event, infraNote?: string, manualNote?: string): Promise<void>;
  skipItem(repo: string, number: IssueRef, ev: Event): Promise<void>;
  unskipItem(repo: string, number: IssueRef, ev: Event): Promise<void>;
  togglePriority(repo: string, number: IssueRef, ev: Event): Promise<void>;
  unmarkProblematic(repo: string, number: number, ev: Event): Promise<void>;
  clearManualAction(repo: string, number: number, ev: Event): Promise<void>;
  startPrSession(repo: string, number: number, ev: Event): Promise<void>;
  markRefined(repo: string, number: IssueRef, ev: Event): Promise<void>;
  markAutomerge(repo: string, number: IssueRef, ev: Event, alsoRefine?: boolean, manualNote?: string): Promise<void>;
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

/** The button's label text: its `.pr-label` span on the /prs icon buttons, else its own text. */
function getLabel(btn: HTMLElement): string | null {
  return (btn.querySelector(".pr-label") ?? btn).textContent;
}

/** Write a button's label. On the /prs icon buttons the text lives in a visually
 *  hidden `.pr-label`, so the icon stays on a phone; `visible` adds
 *  `pr-label-visible` so an outcome the operator must read (Error, Merged!)
 *  replaces the icon until the next non-visible write. */
function setLabel(btn: HTMLElement, text: string, visible = false): void {
  const label = btn.querySelector(".pr-label");
  (label ?? btn).textContent = text;
  btn.classList.toggle("pr-label-visible", visible && label !== null);
}

/** Ask past a PR's unmet-manual-action warning; true with no warning to ask about. */
function confirmManual(manualNote: string | undefined, verb: string): boolean {
  return !manualNote || window.confirm(`${manualNote}\n\nThis step is not confirmed done. ${verb} anyway?`);
}

function queuePage(): QueuePage {
  return {
    refreshStatus: "",

    async refreshQueue(ev: Event): Promise<void> {
      const btn = ev.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      const original = btn.title;
      btn.setAttribute("aria-busy", "true");
      btn.title = "Refreshing…";
      this.refreshStatus = "Triggering rescan...";
      try {
        const r = await fetch("/queue/refresh", { method: "POST" });
        const data = (await r.json()) as { results?: Record<string, string>; error?: string };
        if (!r.ok || data.error) {
          this.refreshStatus = "Refresh failed";
          btn.title = original;
        btn.removeAttribute("aria-busy");
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
        btn.title = original;
          btn.removeAttribute("aria-busy");
        btn.disabled = false;
      }
    },

    async mergePR(repo: string, prNumber: number, ev: Event, infraNote?: string, manualNote?: string): Promise<void> {
      if (!confirmManual(manualNote, "Merge")) return;
      if (infraNote && !window.confirm(`PR #${prNumber} in ${repo} changes infrastructure (tofu/terraform).\n\nPlan: ${infraNote}\n\nMerging applies real infra changes. Continue?`)) return;
      const btn = btnFromEvent(ev);
      const row = btn.closest("tr");
      row?.querySelector(".merge-error")?.remove();
      btn.disabled = true;
      setLabel(btn, "Merging...");
      const showError = (msg: string): void => {
        setLabel(btn, "Retry Merge", true);
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
          body: JSON.stringify({ repo, prNumber, confirmInfra: infraNote != null && infraNote !== "", confirmManual: !!manualNote }),
        });
        const data = (await r.json()) as { error?: string };
        if (!r.ok || data.error) {
          showError(data.error ?? `HTTP ${r.status}`);
        } else {
          setLabel(btn, "Merged!", true);
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
      setLabel(btn, pending);
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => {
            setLabel(btn, labelOnFail);
            btn.disabled = false;
            unlockWidth(btn);
          }, 3000);
        } else {
          const row = btn.closest("tr");
          const badge = row?.querySelector(".skip-badge") ?? null;
          if (isSkip) {
            setLabel(btn, "Restore");
            btn.classList.add("unskip");
            btn.dataset.mode = "unskip";
            if (!badge) row?.querySelector(".cell-title")?.insertAdjacentHTML("beforeend", ` <span class="skip-badge">Skipped</span>`);
          } else {
            setLabel(btn, "Skip");
            btn.classList.remove("unskip");
            btn.dataset.mode = "skip";
            badge?.remove();
          }
          btn.disabled = false;
          unlockWidth(btn);
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => {
          setLabel(btn, labelOnFail);
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async unskipItem(repo: string, number: IssueRef, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      lockWidth(btn);
      btn.disabled = true;
      setLabel(btn, "Restoring...");
      try {
        const r = await fetch("/queue/unskip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => {
            setLabel(btn, "Restore");
            btn.disabled = false;
            unlockWidth(btn);
          }, 3000);
        } else {
          const row = btn.closest("tr");
          if (row) row.remove();
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => {
          setLabel(btn, "Restore");
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
      setLabel(btn, pending);
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => {
            setLabel(btn, labelOnFail);
            btn.disabled = false;
            unlockWidth(btn);
          }, 3000);
        } else {
          if (isPrio) {
            setLabel(btn, "Deprioritise");
            btn.classList.add("deprio");
            btn.dataset.mode = "deprio";
          } else {
            setLabel(btn, "Prioritise");
            btn.classList.remove("deprio");
            btn.dataset.mode = "prio";
          }
          btn.disabled = false;
          unlockWidth(btn);
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => {
          setLabel(btn, labelOnFail);
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async unmarkProblematic(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const original = getLabel(btn) ?? "Unmark problematic";
      lockWidth(btn);
      btn.disabled = true;
      setLabel(btn, "Unmarking...");
      try {
        const r = await fetch("/queue/unmark-problematic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => {
            setLabel(btn, original);
            btn.disabled = false;
            unlockWidth(btn);
          }, 3000);
        } else {
          setLabel(btn, "Unmarked");
          btn.classList.add("refined-done");
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => {
          setLabel(btn, original);
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async clearManualAction(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      const original = getLabel(btn) ?? "Clear manual action";
      lockWidth(btn);
      btn.disabled = true;
      setLabel(btn, "Clearing...");
      try {
        const r = await fetch("/queue/clear-manual-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => {
            setLabel(btn, original);
            btn.disabled = false;
            unlockWidth(btn);
          }, 3000);
        } else {
          setLabel(btn, "Cleared");
          btn.classList.add("refined-done");
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => {
          setLabel(btn, original);
          btn.disabled = false;
          unlockWidth(btn);
        }, 3000);
      }
    },

    async startPrSession(repo: string, number: number, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      btn.parentElement?.querySelector(".merge-error")?.remove();
      const original = getLabel(btn) ?? "Start session";
      const originalTitle = btn.title;
      lockWidth(btn);
      btn.title = "Starting…";
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      setLabel(btn, "Starting…");
      const showError = (msg: string): void => {
        setLabel(btn, original);
        btn.title = originalTitle;
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        unlockWidth(btn);
        const span = document.createElement("span");
        span.className = "merge-error";
        span.textContent = `Could not start session: ${msg}`;
        btn.insertAdjacentElement("afterend", span);
      };
      try {
        const r = await fetch("/prs/start-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
        if (data.ok && data.url) {
          const link = document.createElement("a");
          link.className = "refined-btn pr-go-to-session";
          link.href = data.url;
          const goLabel = originalTitle.replace(/^Start /, "Go to ");
          link.title = goLabel;
          link.setAttribute("aria-label", goLabel);
          link.innerHTML =
            '<span class="pr-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></span><span class="pr-label">Go to session</span>';
          btn.replaceWith(link);
          const note = document.createElement("span");
          note.className = "session-started";
          note.textContent = "Session started";
          link.insertAdjacentElement("afterend", note);
          return;
        }
        showError(data.error ?? `HTTP ${r.status}`);
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }
    },

    async markRefined(repo: string, number: IssueRef, ev: Event): Promise<void> {
      const btn = btnFromEvent(ev);
      lockWidth(btn);
      btn.disabled = true;
      setLabel(btn, "Marking...");
      try {
        const r = await fetch("/queue/mark-refined", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => { setLabel(btn, "Refined"); btn.disabled = false; unlockWidth(btn); }, 3000);
        } else {
          setLabel(btn, "Refined");
          btn.disabled = true;
          btn.classList.add("refined-done");
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => { setLabel(btn, "Refined"); btn.disabled = false; unlockWidth(btn); }, 3000);
      }
    },

    async markAutomerge(repo: string, number: IssueRef, ev: Event, alsoRefine?: boolean, manualNote?: string): Promise<void> {
      if (!confirmManual(manualNote, "Approve the merge")) return;
      const btn = btnFromEvent(ev);
      const original = getLabel(btn) ?? "Automerge";
      lockWidth(btn);
      btn.disabled = true;
      setLabel(btn, "Marking...");
      try {
        const r = await fetch("/queue/mark-automerge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number, alsoRefine, confirmManual: !!manualNote }),
        });
        const data = (await r.json()) as { error?: string };
        if (data.error) {
          setLabel(btn, "Error", true);
          setTimeout(() => { setLabel(btn, original); btn.disabled = false; unlockWidth(btn); }, 3000);
        } else {
          setLabel(btn, original);
          btn.disabled = true;
          btn.classList.add("refined-done");
        }
      } catch {
        setLabel(btn, "Error", true);
        setTimeout(() => { setLabel(btn, original); btn.disabled = false; unlockWidth(btn); }, 3000);
      }
    },
  };
}

(window as unknown as { queuePage: () => QueuePage }).queuePage = queuePage;
