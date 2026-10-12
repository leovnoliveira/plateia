# Plateia: a Plow OpenClaw 2.0 agent that reads what a YouTube audience said.
#
# A variant of plow-pbc/plow-openclaw-agent: the base owns boot, the Plow
# channel (iMessage, multiplayer group threads), trust enforcement and the
# Agent Index usage reporter. This image adds only Plateia's prompt and skill.
#
# Pinned by digest: the tag names base commit 37cf07e, the digest is what
# actually boots holding this agent's Plow credential.
FROM public.ecr.aws/e1h7x4a2/plow-cloud-agents:base-37cf07ebb809f964fe94d3ccd66abeabd5ceca8d@sha256:0ec8aefc779eb418d993048814f94c990a89cdd32d485cb15b24dc764398e24e

# Agent Index identity. A cloud install runs the image with no compose file,
# so the image is the only place these can come from.
ENV AGENT_ID=publikum \
    AGENT_NAME="Plateia" \
    AGENT_BLURB="Text it a YouTube link. It reads the comments or the live chat replay and texts back what your audience asks, wants and complains about, plus bot and copypasta signals. Weekly digest for your channel."

# Group trust stays at the base default, ask: the owner decides per group
# whether teammates get tools, since a trusted group also reaches their Mac.

# The base prompt plus the Plateia role. Replaces the base file, so
# prompt/AGENTS.md carries the base text verbatim above the role section.
COPY prompt/AGENTS.md /opt/plow/prompt/AGENTS.md

# Merged beside the base's owners-mac and google-workspace skills. Root-owned
# and read-only to the agent: what a turn runs is what this image shipped.
COPY skills/ /opt/plow/skills/

COPY LICENSE /usr/share/doc/plateia/LICENSE
