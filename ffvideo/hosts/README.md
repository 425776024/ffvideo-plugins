# Host adapters

`config.mjs` exports `createHostConfig(host, options)`. It returns configuration, serialized text, setup steps and limitations; it never writes user configuration, launches agents, creates a tunnel or changes permission rules. Defaults launch `npx -y @ffclip-com/ffvideo --mcp`. During source development pass `command: 'node'` and `args: ['/absolute/path/to/ffvideo/dist/bin/ffvideo.mjs', '--mcp']` after building. `directory` selects the feed data directory and `cwd` the process working directory.

```js
import { createHostConfig } from './config.mjs';
const local = createHostConfig('codex', { directory: '/absolute/path/to/feed-data' });
const channel = createHostConfig('claude', { channels: true });
const remote = createHostConfig('workbuddy', { url: 'https://video.example.com/mcp' });
```

Remote templates refer to a dedicated `FFVIDEO_MCP_TOKEN`; set it through the host's supported credential flow. `tokenEnvVar` changes the name. If a host does not expand `${VAR}` in headers, enter the ffvideo token through that host's UI or pass a literal `token` to the generator; do not assume interpolation is portable. Codex uses its documented `bearer_token_env_var`. These credentials authorize ffvideo, not a model-provider account. The generic handler negotiates MCP `2024-11-05` and implements tools only: no sampling, embedded MCP App, MCP 2 discovery, subscriptions or permission relay are advertised.

| Host | Connection in this package | Event handling | Proven boundary |
| --- | --- | --- | --- |
| Codex desktop / CLI | Local stdio or Streamable HTTP; Codex TOML template | Active-turn `wait_feed_events`; optional separate Codex bridge | MCP tools alone do not schedule new turns. |
| ChatGPT cloud | Manual HTTPS connection descriptor or an existing Secure MCP Tunnel | Active-turn tool calls only in this adapter | Cloud cannot access the user's localhost directly. Viewer reachability and authentication need separate verification. No arbitrary JSON import is claimed. |
| Claude Code | Local stdio; HTTP tools also available | Explicit native Channels opt-in | Open CLI session, channel allowlist and organization policy required. Written notification is not delivery acknowledgement. |
| CodeBuddy Code | Local stdio; HTTP tools also available | Explicit native Channels opt-in | Same documented `claude/channel` capability and notification contract; this does not prove WorkBuddy desktop has the same wake-up behavior. |
| WorkBuddy | stdio or `streamableHttp` connector configuration | Active-turn long polling | Official connector documentation establishes tools/transports. This adapter has no verified desktop idle wake-up mechanism. |
| Qoder CLI | stdio or HTTP `mcpServers` configuration | Active-turn long polling | Project/plugin MCP configuration exists; native push that wakes an idle desktop agent is unverified. |

## Native Channels

The ffvideo server must be launched with `--mcp --channels --host claude` or `--mcp --channels --host codebuddy`. It then declares `experimental['claude/channel'] = {}` and emits `notifications/claude/channel`. Push is scoped to this feed store. Comments, preference changes, newly queued work, publication and failure changes are coalesced; raw watch heartbeats, comment bodies and claim tokens are not forwarded in notifications. The model rereads state through tools. Channels are off by default and rejected for other hosts or HTTP configurations.

For a bare MCP entry named `ffvideo`, explicitly start a trusted development session:

```sh
claude --dangerously-load-development-channels server:ffvideo
# Or:
codebuddy --dangerously-load-development-channels server:ffvideo
```

The development flag bypasses the channel allowlist only and can require host confirmation; organization policy still applies. After approval/allowlisting, use `--channels server:ffvideo`. Plugin channel identifiers differ from bare-server identifiers; use the installed plugin's host identifier rather than guessing it. Keep the session open. This package does not enable `channelsEnabled`, bypass approvals or advertise channel permission relay. Claude's MCP 2 negotiation currently excludes the legacy channel listener; ffvideo intentionally negotiates the supported older tool protocol.

## Official sources checked

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): stdio, Streamable HTTP, bearer environment variables and plugin configuration.
- [ChatGPT plugin connection](https://developers.openai.com/plugins/deploy/connect-chatgpt): public HTTPS or Secure MCP Tunnel, developer-mode setup and authentication discovery.
- [Claude Channels reference](https://code.claude.com/docs/en/channels-reference) and [Claude MCP](https://code.claude.com/docs/en/mcp): capability, notifications, explicit loading, legacy negotiation and configuration.
- [CodeBuddy Channels reference](https://www.codebuddy.cn/docs/cli/channels-reference): stdio push contract, explicit loading and organizational controls. [CodeBuddy MCP](https://www.codebuddy.cn/docs/cli/mcp) documents ordinary tool connections.
- [WorkBuddy connector specification](https://open.workbuddy.cn/docs/connector): stdio/streamableHttp, Node runtime, credentials and connector metadata. It does not establish a general desktop idle wake-up API.
- [Qoder MCP reference](https://docs.qoder.com/cli/mcp-reference): command/args/cwd, HTTP headers and project/plugin configuration.

These are documentation-based compatibility boundaries, not acceptance results from running each desktop host. Host permissions and versions can change. The tests here cover protocol behavior and generated configuration, not external host event delivery.
