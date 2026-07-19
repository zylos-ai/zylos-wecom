# WeCom Platform Limitations — User FAQ Reference

Read this when a user asks why the bot did not see, receive, or send
something in WeCom. These are platform-level behaviors of WeCom's
Intelligent Robot (智能机器人) long-connection mode — not bugs in this
component, and not configurable away.

## Who can talk to the bot in a group

Non-owner users can only @-mention the bot if they are inside the bot's
**visibility scope** (可见范围) configured in the WeCom admin console
(管理后台). A user outside that scope cannot reach the bot in a group at
all — their @-mention is never delivered. If a teammate says "the bot
ignores me", have the WeCom admin add them (or their department) to the
robot's visibility scope.

## What the bot receives in group chats

- Only messages that @-mention the bot are pushed. Everything else in the
  group is invisible to the bot — it cannot "read the room".
- Only `text` and `mixed` (text+image) message types are pushed in groups.
  Files, voice, video, and standalone images are silently dropped by the
  WeCom server even when the bot is @-mentioned. To hand the bot a file,
  send it in a DM, or include the image inline with text (mixed message).

## Quoted messages (applies to both DM and group)

- A quoted message carries no sender identity — the bot cannot tell who
  wrote the quoted text, only what it said.
- Images and files inside a quote arrive as bare `[image]` / `[file]`
  tags with no actual media data. The bot knows media was quoted but can
  never see it. If a user asks "why can't you see the picture I quoted",
  this is the answer: WeCom does not deliver quoted media content to
  bots. Workaround: re-send the image directly (DM, or inline with text
  in a group) instead of quoting it.

## DM vs group at a glance

DMs have none of the group-side restrictions: no @-mention needed, all
message types (standalone image, file, voice, video) are pushed, and
media is downloaded automatically. When a user hits a group limitation
above, moving the exchange to a DM is the reliable workaround.

## External (customer) groups

Bots cannot be added to external/customer groups (外部群) — internal and
external groups have different bot permission models on the WeCom side.

## Outbound media limits

When the bot sends images/files, WeCom enforces size caps (image 10MB,
file 20MB; voice 2MB, video 10MB at the protocol level) and rate limits
(30 messages/min, 1000/hr per bot). Proactive pushes additionally require
that the recipient has messaged the bot before.
