# Claws capabilities in Scala 3's capture-checking system

**Deep dive.** Read this when you're curious how Claws' session capability
model maps onto Scala 3 capture-checking (#2556, analysis only). For the
actual capability model, see modules.md's `capabilities.ts` entry instead.

Issue #2556 asked how Claws' current capabilities would be represented using
Scala 3's capability system. This doc records the answer.

This is analysis only. Claws is TypeScript on Node.js; no Scala is built,
shipped, or proposed anywhere in this repo, and none of the code blocks below
are compiled by CI — they are illustrative sketches of what a capability-typed
version of `src/capabilities.ts` would look like, written in Scala 3's
experimental capture-checking syntax.

## 1. Two different things called "capability"

Claws actually has two unrelated concepts named "capability," and only one of
them is what Scala's capture-checking system is about.

**Session capabilities** (`src/capabilities.ts`) are authority grants: an
interactive session is default-deny, and a capability such as `home-assistant`
or `prod-infra` must be explicitly ticked before its credentials are injected
into the spawned process's environment. This is the concept the rest of this
doc maps onto Scala 3.

**`RunClaudeOptions.capability`** was a model-routing key — `"tool-use"` vs
`"text-only"` — that picked which provider/model tier a `runClaude` call
used. It was removed in #2688; `getModel`/`getFallbackOrder` in
`src/model-selector.ts` no longer take a capability argument. While it
existed it granted no authority and gated no credential. In Scala terms it
would have been nothing more than a plain enum or a `given` model-selection
type class:

```scala
enum Capability:
  case ToolUse, TextOnly
```

Capture checking has nothing to say about this second sense of the word; it
is a routing tag, not a capability in the security sense.

## 2. What Scala 3 capture checking gives you

Capture checking is an experimental Scala 3 feature enabled with
`import language.experimental.captureChecking`. Every type can carry a
**capture set**: `T^{c1, c2}` is the type `T` capturing exactly the
capabilities `c1` and `c2`, and `T^` is shorthand for `T^{cap}`, where `cap`
is the root/universal capability from which all others derive. A capability
class extends `caps.Capability` (`import caps.Capability`), which implicitly
gives it a capture set of `{cap}`. A pure `T` — one that captures nothing — is
a subtype of any `T^{…}`, so pure code can always be used where capturing code
is expected, but not vice versa. Function arrows are capture-aware too: `A =>
B` is impure sugar for `A ->{cap} B`, `A -> B` is the pure arrow `A ->{} B`,
and `A ->{c, d} B` captures exactly `c` and `d` (context functions have the
equivalent `?=>`/`?->` forms). **Escape checking** rejects a capability that
would outlive its scope — for example returning a closure that captures a
capability received as a parameter — with an error like *"The expression's
type `() => Unit` is not allowed to capture the root capability `cap`. This
usually means that a capability persists longer than its allowed lifetime."*
Type variables can't be instantiated to types that capture `cap`, which is
what makes that check sound. Capture sets can also be hidden inside a generic
instantiation (**boxing**, e.g. `Option[HomeAssistant^]`) and are recovered
(**unboxed**) on access.

```scala
import language.experimental.captureChecking
import caps.Capability

class HomeAssistant(baseUrl: String, token: String) extends Capability:
  def call(path: String): String = ???
```

## 3. The mapping table

| Claws construct | Scala construct | What the compiler then guarantees |
| --- | --- | --- |
| A `CAPABILITIES` registry entry | A class extending `caps.Capability` | Only a value of that class, not a name/string, grants the associated authority |
| Granting a capability to a session | Passing the capability value (`using`) into the code that needs it | Every call site that touches the resource must have a capability parameter in scope |
| `env -u` default-deny stripping | No ambient authority — the only route to Home Assistant is holding a `HomeAssistant^` value | A module that was never handed the value has no way to call `home-assistant`, at compile time, not just by policy |
| `resolve(): Record<string,string> \| null` / `isCapabilityAvailable` | `Option[HomeAssistant^]` | "Unconfigured" is `None`; there is no way to accidentally treat an absent capability as present |
| `validCapabilityIds` | The runtime→type boundary (see `resolveGrants` below) | Everything above this boundary is untyped strings from the DB; everything below it is statically checked |
| Sourced-then-deleted env file (`ENV_FILE_PRELUDE`) | Escape checking | A capability handed to a scoped block can't be smuggled out in a closure that outlives the block |
| Two-cluster `KUBECONFIG` colon-join | Capture-set union, e.g. `Kubectl^{prod, fleet}` | The merged handle's type names both capabilities it depends on |
| `buildCapabilityPrompt` | A `given Describe[C]` derived per granted capability | The system-prompt text a session receives is provably a function of the capabilities it actually holds |
| "All GitHub access goes through `src/github.ts`" (CLAUDE.md) | A `GitHub^` capability that no module can fabricate | Any module bypassing `github.ts` with a raw `fetch` fails to type-check, instead of failing only a code-review pass |

## 4. Worked sketches

```scala
/** Availability: mirrors `resolve() !== null`. No token, no value, so no call
 *  site can even name the capability. */
def homeAssistant(cfg: Config): Option[HomeAssistant^] =
  Option.when(cfg.haToken.nonEmpty)(HomeAssistant(cfg.haBaseUrl, cfg.haToken))
```

```scala
/** Scoped grant — the Scala analogue of sourcing the 0600 env file and
 *  immediately `rm -f`-ing it (ENV_FILE_PRELUDE in capabilities.ts). */
def withHomeAssistant[T](cfg: Config)(op: HomeAssistant^ => T): Option[T] =
  homeAssistant(cfg).map(op)

// OK — the result does not mention `ha`.
val states = withHomeAssistant(cfg)(ha => ha.call("/api/states"))

// Rejected by escape checking: the result type `() => Unit` would capture `cap`.
val later = withHomeAssistant(cfg)(ha => () => ha.call("/api/states"))
```

```scala
class ProdInfra extends Capability
class FleetInfra extends Capability
class Kubectl extends Capability

/** Both clusters granted: the merged handle names both in its capture set —
 *  the type-level form of colon-joining the two KUBECONFIG paths. */
def kubectl(prod: ProdInfra^, fleet: FleetInfra^): Kubectl^{prod, fleet} = ???
def kubectlProdOnly(prod: ProdInfra^): Kubectl^{prod} = ???
```

```scala
/** The single runtime-checked boundary — Scala's `validCapabilityIds`.
 *  Above it: strings from a checkbox list and the `sessions.capabilities`
 *  column. Below it: everything is statically checked. */
final case class Grants(
  homeAssistant: Option[HomeAssistant^],
  prodInfra: Option[ProdInfra^],
  fleetInfra: Option[FleetInfra^],
  sshHosts: Set[String],
)
def resolveGrants(selected: List[String], cfg: Config): Grants = ???
```

## 5. Pure arrows as a codebase convention

Scala's pure arrow `A -> B` (sugar for `A ->{} B`) is a compiler-checked
version of a convention Claws already follows by discipline: helpers like
`renderViolationTable` are pure functions over data, and network access is
confined to `src/github.ts`. A helper typed with a pure arrow provably
performs no I/O — the type itself rules out a stray `fetch` or `gh` call
sneaking into what's meant to be a formatting function:

```scala
val renderViolationTable: List[Violation] -> String = violations => ???
```

## 6. `CanThrow`, briefly

`import language.experimental.saferExceptions` lets a signature read `def
f(): T throws RateLimited`, which desugars to an implicit `CanThrow[E]`
parameter — itself a capability, since `CanThrow` extends `Capability`. A
function can only throw `RateLimited` if it was handed permission to, the
same way it can only call Home Assistant if it was handed a
`HomeAssistant^`. That's roughly the shape of what Claws' rate-limit circuit
breaker (`src/rate-limit.ts`) and `retryWithBackoff` (`src/retry.ts`) handle
today by convention rather than by type.

## 7. Where the analogy breaks

- **Process boundary, not type boundary.** Claws' actual enforcement target
  is a spawned `claude` subprocess running with
  `--dangerously-skip-permissions`. No host-language type system constrains
  what that subprocess can do; `env -u` plus a 0600 credential file plus argv
  hygiene is the real mechanism. Capture checking would harden Claws' own
  TypeScript, never the agent process it launches.
- **Grants are dynamic.** They come from a checkbox list, persist as a JSON
  array in the `sessions` table, and are re-applied on resume. Capture sets
  are static. The honest model is the `resolveGrants` runtime→type boundary
  above: the compiler can guarantee "no code path acts without holding a
  value," never "the operator actually ticked the box."
- **Phantom grants.** `ssh:*` and `browser` inject no env var at all —
  `ssh:*` only adds a sentence to `--append-system-prompt`, and `browser`
  only selects an `--mcp-config`. Typed, they'd be capability classes with no
  operations on them, so there is nothing left for the compiler to check.
- **Ambient state is the real leak vector.** The #2138 incident leaked a
  Home Assistant token via argv (`/proc/<pid>/cmdline`), which is exactly the
  kind of ambient, out-of-band channel capture checking doesn't model —
  capture checking is about authority passed as values, not `process.env` or
  `/proc`.
- **Taint is orthogonal.** `guardContent()` and Claws' prompt-injection
  defenses answer "where did this string come from," not "who may act."
  Capture checking says nothing about data provenance.
- **Still experimental.** Capture checking itself sits behind
  `language.experimental.captureChecking`, and the newer separation
  checking (`caps.Mutable`, `update` methods,
  `SharedCapability`/`ExclusiveCapability`, `@consume`) is even less settled.

## 8. The one transferable idea

The one property worth borrowing back into TypeScript, without any Scala
involved, is passing an explicit capability object into a job function
instead of having that function read module-level env or config directly —
so "which job can reach Home Assistant" is visible in a function signature
rather than buried in what it happens to import. This doc proposes no code
change along those lines, and no such refactor is scheduled.
