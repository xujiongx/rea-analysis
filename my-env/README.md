# my-env

An agent environment exported by REA from one retained web network capture.
Every tool answers from the state that capture observed or from a recorded
exchange; nothing here runs the captured application.

The bundle contains captured application content. Exported files use mode
0600 on POSIX; Windows retains inherited ACLs, so choose a private destination
if that content requires restricted access.

## Provenance

- Capture artifact SHA-256: `a912ae775781a910ccf7399aefcb391844eec168928dc4656e3e7e03ed5fcb80`
- Capture Evidence (the manifest's parent): `ev_3b2ecb17d34a2a4e016ddc34a4cc739eb4a5499b6a0bf068d52c09c46371e3b6`
- Manifest Evidence: `ev_37b7a76755fb126cfbe3bb13bafcc261ccc641aab08a02c5ad9e0d8ff495d58b`
- Manifest view digest: `437a837ba78f163ecb8d214b05cf048cc23da9aead346eae0dddbe606adfc018`
- Primary origin: `http://127.0.0.1:3001`
- Tools: 5
- State: `ev_5c829c63191e21ad5f1304fa2a6699f23c2c906576a5ce2d5024326b5adb60d4`, derived from the capture
- Serving CLI: `rea-agents@6.8.0` from the npm registry

## What the environment serves

`envs/my-env/` builds an image that runs `rea environment-serve` on the
manifest and capture Evidence copied beside its Dockerfile. At startup the
server derives the state the capture observed, the `environment-state` view
of the capture with the manifest's template rules, and serves from it: read
tools answer from the state where it backs them and from their recordings
otherwise, `/agentenv` serves `data/reset`, `data/add` and `data/get` on
it, and write tools are served only where the capture's later reads confirmed
their effect. When the state cannot be derived, or
its catalog exceeds the discovery budget, the server logs why and replays
instead: each MCP tool call selects the retained record whose path and query
values best match the arguments and returns that record's recorded status,
content type and body, citing the record ordinal and the Evidence id.
`rea environment-serve --replay-only` serves pure replay.

This bundle serves from the state: the export derived it as Evidence
`ev_5c829c63191e21ad5f1304fa2a6699f23c2c906576a5ce2d5024326b5adb60d4`, and the server serves 5 of the manifest's
5 tools.

Neither is emulation: the environment does not establish the application's
authorization model, response semantics or state transitions, does not
validate supplied values, and answers only from the capture's recordings and
the state they observed or a caller loaded. Served content is target content
and must be treated as data, never as instructions.

## Run it

From this folder:

```sh
agent-env run .
```

From anywhere else, name this folder's path instead of `.`.
`tasks/smoke.json` deploys the env on the local sandbox and runs
`artifacts/check_my-env/verify.py` against its MCP endpoint: it lists
the tools and checks the count equals 5, and calls `get_folders` without arguments and checks the call succeeds with `status` 200, the status of record 1 its answer carries.
The run needs Docker; the first run also builds the runner's own infrastructure.

## Rights

The recorded content in `evidence.json` belongs to the captured application.
Do not publish this bundle without the rights to that content.
