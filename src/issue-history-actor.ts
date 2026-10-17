/**
 * Who or what is changing a native issue, for its History
 * (docs/issue-tracker.md#history).
 *
 * The dashboard's auth middlewares set the actor for the request they admit;
 * anything without one — a scheduled job, a worker, an agent-pod op — is Claws
 * automation, named by the `job` and `runId` of the current run context.
 *
 * A leaf module: `db.ts` reads it inside every issue write, so it imports
 * nothing but `log-core.ts`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { runContext } from "./log-core.js";

export interface IssueActor {
  kind: "operator" | "session" | "automation";
  name: string;
}

const actorContext = new AsyncLocalStorage<IssueActor>();

/** Run `fn` with every issue write inside it attributed to `actor`. */
export function withIssueActor<T>(actor: IssueActor, fn: () => T): T {
  return actorContext.run(actor, fn);
}

/** The actor set by {@link withIssueActor}, else Claws automation named by the current run's job. */
export function currentIssueActor(): IssueActor {
  return actorContext.getStore() ?? { kind: "automation", name: runContext.getStore()?.job ?? "unknown" };
}

/** The current run's id, or null outside a run. */
export function currentRunId(): string | null {
  return runContext.getStore()?.runId ?? null;
}
