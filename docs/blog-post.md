---
title: 'My Own Personal Claws'
pubDate: 2026-03-16
description: 'How I built a personal automation system that watches GitHub issues and PRs, plans implementations, writes code, fixes CI, and investigates production bugs — shipping 551 commits in 14 days across 8 repositories.'
author: 'Brendan St. John'
tags: ['claws', 'automation', 'github', 'claude-code', 'devops']
---

A few weeks ago I played around with [OpenClaw](https://openclaw.im/) and for a while I really loved the interaction. I was mainly using OpenClaw as a bridge from Claude Code to Slack, using Slack's channels and threads to organise work streams.

The love didn't really last long though. The rules I wrote in English were fragile. Switching the underlying model or upgrading OpenClaw itself resulted in things not working as they had previously. I started tracking SOUL.md, AGENTS.md, etc. in their own git repository but that was really just tracking the churn, not actually improving the situation.

Then I realised, the pace of software delivery has accelerated so much recently and the core workflows that I needed were so small, I could build them into a brand new custom service in a matter of hours. So I built my own Claws. The name comes from [Andrej Karpathy](https://x.com/karpathy/status/2024987174077432126) talking about the ecosystem of OpenClaw and its competitors.

My Claws is not destined to be a big open-source community project. Its a piece of software totally tailored for me. It has grown well beyond my initial estimate and has been a huge multiplier in the pace that I can ship new features and fix bugs across multiple software projects.

## How It Started

The initial idea was quite simple: Claws was to watch my GitHub Issues and PRs and progress them when it could.

The first two features I built were **Refinement** and **Implementation**, the two features I was using most in OpenClaw but had never managed to tune 100% to my satisfaction. When I create a GitHub issue, Claws picks it up within 5 minutes, reads the codebase documentation, and posts an implementation plan as a comment. If I want changes, I leave feedback — Claws detects it automatically and updates its plan in-place. We iterate until I'm happy, then I add the `Refined` label to the issue. Claws then begins implementation and opens a PR. These two features alone were immediately useful — I could describe what I wanted and come back to a working PR.

From there, I layered on more automation around the same loop. If CI fails, Claws automatically pushes a fix. If I request changes, Claws detects my comments and handles them automatically. When CI is green and I've approved, Claws merges it & it is automatically deployed to production.

**Triage** turned out to be one of the most valuable features. I gave Claws the ability to query production logs and data for my most active services and I gave my services the ability to raise GitHub issues for errors they encountered. When a new production issue is raised, Claws gathers all relevant logs and information and digests them into a timeline of events around the error. From there the standard refinement & implementation flows resolve the bug. Similar issues are de-duplicated & merged. The speed at which coding agents can analyze debug logs to identify race conditions or similar vastly outpaces my own. This has been a huge timesaver. Using this approach, Claws debugs and fixes itself.

I have a WhatsApp integration that lets me record an idea into my phone as a voice note from wherever I happen to be when the idea strikes. Claws transcribes it, interprets it, figures out which repository it belongs to, and creates a well-structured GitHub issue — all without me opening a laptop. Voice notes are particularly good for capturing shower ideas — the kind of half-formed thoughts that would normally evaporate before you get to a keyboard. The ability to capture ideas and even have them implemented while out for a walk means features get built and shipped _so_ much faster.

Claws figures out what needs attention by analysing comments, reactions, and PR state. Different Claws jobs track what they've already processed via reactions on comments, so there's no coordination overhead. The only label that drives a state transition is `Refined`, which I add as an explicit signal that an issue is ready for implementation.

## The Jobs

Already discussed:

- **Issue Refiner** (every 5 min) — Posts implementation plans on issues, iterates based on feedback
- **Issue Worker** (every 5 min) — Implements refined issues as PRs, supports multi-PR phased implementations
- **Review Addresser** (every 5 min) — Addresses unresolved PR review comments
- **Production Bug Investigator** (every 10 min) — Fetches production debug data and investigates bug reports
- **CI Fixer** (every 10 min) — Fixes CI failures related to the PR directly, but raises a separate issue for CI failures unrelated to the PR's goal and works on those independently. Also keeps branches up to date with main.

Other jobs worth highlighting:

- **Doc Maintainer** (daily at 1 AM) — Generates and updates `docs/*.md` for every repository. Structured to provide easy repo context to agents. Examines all plans associated with changes that have been shipped since the last docs update.
- **Repo Standards** (daily at 2 AM) — Enforces common standards across all repos. Simple things like ensuring consistent use of self-hosted CI runners, dependabot upgrades etc.
- **Improvement Identifier** (daily at 3 AM) — Quite a flexible job - Analyzes codebases for improvements: Security issues, suggested refactoring, feature ideas, promotional ideas. Each repo lists the area in which it is open to suggestions.
- **Email Monitor** (every 5 min) — Polls Gmail for forwarded veg box emails, extracts the vegetable list via Claude, generates recipe ideas, and emails them back. A personal automation that has nothing to do with code.

The **doc-maintainer** deserves special attention. Every night at 1 AM, it looks at every repository Claws has worked on and generates a comprehensive `docs/OVERVIEW.md` — a full architectural overview including module responsibilities, key patterns, configuration, and technology stack. This document is then read by every other job before it starts working.

This creates a virtuous cycle. The more Claws works on a repository, the better the documentation gets, and the better the documentation gets, the more effectively Claws works. The overview document serves as accumulated institutional knowledge — something that would normally only exist in senior engineers' heads. Since all refinement and implementation Claude Code sessions are invoked by my Claws, I have a single place where the docs need to be mentioned and I don't need to remember to include it in my prompt for every idea.

The **ci-fixer** has also been particularly useful to make previously flakey tests more reliable. One project in particular had a large number of Cypress tests that had various issues. Once Claws started tracking these (all combined into a single open issue & PR at any given time), it ran for a full weekend squashing bugs in both the application and the tests to make the suite vastly more reliable.

## Productivity Stats

Here are some real numbers across all 8 repositories that Claws manages.

In 14 days (March 3–16, 2026):

- **551 commits** merged into main — roughly 39 per day across 8 repositories
- **1,044 issues and PRs** created and processed through the pipeline

The most productive 48-hour stretch was **March 9–10**, with **124 commits** and **204 issues and PRs** created across all repositories.

For straightforward features, the time from idea to merged PR is often **under an hour**. More complex features that require multi-PR phased implementations or several rounds of plan refinement might take a few hours, but that's still remarkably fast when most of that time requires zero attention from me.

The system processes work while I sleep, while I eat, while I'm in meetings. Plans and PRs are ready for review whenever I want to check them.

## Turning Off OpenClaw

The final feature I needed in order to decommission my OpenClaw was monitoring of an email inbox and acting on emails. We receive a weekly veg delivery from a [local farm](https://www.helensbayorganic.com/). Before the veg is delivered the farm send email to say what this weeks delivery will contain. OpenClaw had been included on these emails and was generating appropriate recipe ideas based. One feature request and PR later, and Claws had been updated to monitor the same inbox and reply appropriately.

## Closing Thoughts

Claws is not a polished product but that's exactly the point. It's a piece of software 100% tailored to my needs. Thanks to coding agents, a single developer can ship features almost as quickly as they can think of them. Rather than trying to build a product with a community or customer base large enough to sustain it, it's now possible to build exactly the piece of software that works for a single person. This means shipping features faster and shipping features that just wouldn't have existed before, as there is no need to decided if a feature fits into The Product. I'd love to include a list of future features I'm planning to add to Claws - I'm sure there will be many more. Sadly though, all the feature ideas that I have had have already been implemented.
