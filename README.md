# OpenVibe.Examples

> Executable public integration examples, tested in CI against the platform.

**Status:** placeholder — planning only, no runnable code yet.  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §15.1 and §18.9.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

Replaces the effectively empty `powerchat-devapp-demo`. Every example runs against the platform integration environment using only public docs, the SDK and scoped credentials.

## Owns

- vanilla browser app, Node server app, webhook consumer, event subscriber, Media uploader, Chat bot, tool/job example, mod manifest example, OAuth app example

## Does not own

- any platform service

## Planned surfaces

- one directory per example with a README and a smoke test

## Data (authority tables / families)

- none

## Capabilities and events

- consumes public capabilities only

Events: n/a

## Depends on

- OpenVibe.SDK
- OpenVibe.Contracts
- the platform integration environment (Network, Events, Media, Chat, Community, Live adapters)

## Acceptance (must be true before "done")

- CI runs every example against the integration environment
- no example needs a loopback-only internal key or first-party database access

## Bootstrap / extraction source

New; supersedes powerchat-devapp-demo.

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
