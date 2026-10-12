# Plateia

Text it a YouTube link. Plateia reads the comments — or the chat replay of a
past live — and texts back what your audience asks, wants and complains
about, the moments that spiked, and whether bots or copypasta are in the
room. Ask it to watch your channel and a digest arrives every week, to you or
to a group with your team.

```
You:     youtu.be/abc123
Plateia: Launch video — 600 of 2,140 comments read.
         • Most asked: "is there an Android version?" (87x)
         • Asking for: a setup tutorial (41x)
         • Complaint: low audio at 12:30 (23x)
         • Signal: one identical text from 9 accounts
         Want me to watch @yourchannel every week?
```

It is the audience analyst a creator or startup hires before it can afford a
community manager. Built on [OpenClaw 2.0](https://github.com/openclaw/openclaw)
through Plow's [plow-openclaw-agent](https://github.com/plow-pbc/plow-openclaw-agent)
base: you text it over iMessage, and multiplayer group threads let a
co-founder, editor or social-media person share the weekly digest.

On the [AI Worth Using Agent Index](https://aiworthusing.com/agent-index/publikum)
its id is `publikum`.

## Get your own Plateia

### 1-click (no code)

Open [Plateia on the Agent Index](https://aiworthusing.com/agent-index/publikum)
and tap **Message this agent**. iMessage opens with the setup phrase; send it,
and Plow gives you your own Plateia on its own number. Then text it a YouTube
link.

### Deploy it yourself on Plow

You need Python 3.11+, Git, Docker and a phone with iMessage.

1. Install the Plow CLI and log in. `login` prints a phrase — text it,
   exactly as printed (`Plow Activate: XXXXX`), to the number it shows.

   ```sh
   git clone https://github.com/plow-pbc/plow-agents.git
   export PATH="$PWD/plow-agents/bin:$PATH"
   plow-agents login
   plow-agents lines          # note a line marked "free"
   ```

2. Clone this repo and deploy the published image on that line:

   ```sh
   git clone https://github.com/leovnoliveira/plateia.git
   cd plateia
   plow-agents deploy ghcr.io/leovnoliveira/publikum@sha256:DIGEST --line ln_xxx
   plow-agents agents         # wait for "running"
   ```

   Use the digest from the latest
   [package version](https://github.com/users/leovnoliveira/packages/container/package/publikum).

3. Text the line's number (shown by `plow-agents lines`) a YouTube link.

To ship your own changes instead, build and push your image, make the GHCR
package public, and deploy that digest:

```sh
docker login ghcr.io -u YOUR_GITHUB_USER        # PAT with write:packages
plow-agents image build ghcr.io/YOUR_GITHUB_USER/plateia:v1
plow-agents image push ghcr.io/YOUR_GITHUB_USER/plateia:v1
plow-agents deploy ghcr.io/YOUR_GITHUB_USER/plateia@sha256:DIGEST --line ln_xxx
```

### Run it locally with Docker

```sh
plow-agents deploy --local --line ln_xxx    # mints ./plow-credentials, starts compose
docker compose logs -f agent
```

Dashboard: <http://localhost:3001> (local only; anyone reaching it is admin).
When done: `plow-agents revoke && docker compose down -v`.

> **Apple Silicon:** the Plow base image is published for amd64 only. Under
> Docker Desktop's emulation OpenClaw's first state migration fails with
> `openat2 beneath root: Function not implemented`, and the gateway exits
> with code 78. Run locally on an x86-64 machine, or deploy on Plow as above.

## How it reads YouTube

`skills/plateia/scripts/plateia.mjs` is a zero-dependency Node script that
calls the same public endpoints the YouTube web page does: no login, no API
key, public comments and chat only. It returns compact JSON — repeated
phrases, likely questions, most-liked comments, cited timestamps, chat peaks
per minute, copypasta (identical text from 3+ accounts) and flood — and the
agent writes the reply from that. Commenters are never named.

```sh
node skills/plateia/scripts/plateia.mjs video 'https://youtu.be/VIDEO_ID' --max 600
node skills/plateia/scripts/plateia.mjs channel '@handle' --limit 10
```

## Layout

| path | what |
| --- | --- |
| `Dockerfile` | `FROM` the OpenClaw base by digest; sets `AGENT_ID`, name, blurb; copies prompt and skill |
| `prompt/AGENTS.md` | base prompt verbatim, plus the Plateia role at the end |
| `skills/plateia/` | the skill and its reader script |
| `compose.yml`, `dev/Caddyfile` | local run, from the base repo |

Inference runs through Plow (`z-ai/glm-5.2`, `anthropic/claude-sonnet-5` as
fallback); no model key is needed. The base image registers the agent on the
Agent Index and reports token usage every five minutes.

## Limits

YouTube only. Channels can turn off comments and chat replay. Long videos
are sampled to the top N comments, and the reply says how many of how many.
The reader uses YouTube's undocumented web endpoints; if YouTube changes
them, the script fails with a reason rather than guessing.

## License

MIT — see [LICENSE](LICENSE). The base image is Apache-2.0, © The Plow
Collective, Inc.
