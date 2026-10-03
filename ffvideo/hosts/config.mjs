const HOSTS = new Set(['codex', 'chatgpt', 'claude', 'codebuddy', 'workbuddy', 'qoder', 'generic']);
const DEFAULT_ARGS = ['-y', '@ffclip-com/ffvideo', '--mcp'];
const GENERIC_LIMIT = 'Standard MCP tools do not wake an idle agent. wait_feed_events only runs while the host is processing an active turn.';

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new TypeError(`${name} must be a nonempty single-line string`);
  return value;
}
function endpoint(value, host) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('url must be an HTTP MCP endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new TypeError('url must be an HTTP MCP endpoint without embedded credentials or fragments');
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname) || url.hostname.endsWith('.localhost');
  if (host === 'chatgpt' && (url.protocol !== 'https:' || local))
    throw new TypeError('ChatGPT needs a reachable HTTPS endpoint or an explicitly configured Secure MCP Tunnel; cloud ChatGPT cannot access localhost');
  return url.href;
}
const tomlString = value => JSON.stringify(value);
function codexToml(server) {
  const lines = ['[mcp_servers.ffvideo]'];
  for (const [key, value] of Object.entries(server)) {
    if (Array.isArray(value)) lines.push(`${key} = [${value.map(tomlString).join(', ')}]`);
    else if (typeof value === 'string') lines.push(`${key} = ${tomlString(value)}`);
    else if (typeof value === 'number') lines.push(`${key} = ${value}`);
  }
  if (server.env) {
    lines.push('', '[mcp_servers.ffvideo.env]');
    for (const [key, value] of Object.entries(server.env)) lines.push(`${tomlString(key)} = ${tomlString(value)}`);
  }
  return lines.join('\n') + '\n';
}

/** Generate installation material, never write host settings or start a host.
 * token is an optional literal ffvideo token; tokenEnvVar avoids putting it in
 * returned configuration. ChatGPT gets a manual connection descriptor, not a
 * fictitious importable .mcp.json or automatic local-to-cloud connection.
 */
export function createHostConfig(host, options = {}) {
  host = String(host).toLowerCase();
  if (!HOSTS.has(host)) throw new TypeError(`Unsupported host: ${host}`);
  const { directory, cwd, url, token, tokenEnvVar = 'FFVIDEO_MCP_TOKEN', channels = false } = options;
  if (typeof channels !== 'boolean') throw new TypeError('channels must be an explicit boolean');
  if (channels && !['claude', 'codebuddy'].includes(host)) throw new TypeError('Channels are supported only for Claude Code and CodeBuddy Code');
  if (channels && url) throw new TypeError('Claude/CodeBuddy channel push uses local stdio, not HTTP');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnvVar)) throw new TypeError('tokenEnvVar must be an environment variable name');
  if (token !== undefined) text(token, 'token');
  const limitations = [GENERIC_LIMIT];
  let server, config, transport, launchInstructions;
  if (host === 'chatgpt') {
    const publicEndpoint = url ? endpoint(url, host) : null;
    transport = publicEndpoint ? 'http' : 'manual';
    config = { name: 'ffvideo', description: 'Generate and watch personal video drafts with sound.',
      connection: publicEndpoint ? { method: 'https', url: publicEndpoint } : { method: 'secure-mcp-tunnel-or-public-https', url: null },
      authentication: { serverMode: 'bearer', tokenEnvironmentVariable: tokenEnvVar, hostCompatibility: 'Verify the host connection authentication separately; this descriptor does not configure OAuth or inject a bearer token into ChatGPT.' } };
    launchInstructions = [
      'In ChatGPT developer mode, add a plugin connection using a reachable HTTPS /mcp endpoint or an existing Secure MCP Tunnel.',
      'Localhost, 127.0.0.1 and a local stdio command are not cloud-reachable by themselves. Configure and verify transport, viewer URL and authentication before using this connection.',
      'This is a connection descriptor for manual setup, not a ChatGPT JSON import file.'
    ];
    limitations.push('This implementation exposes MCP tools only. It does not advertise MCP 2 event subscriptions, sampling or an embedded MCP App; the viewer opens by URL.');
  } else {
    if (url) {
      transport = 'http';
      const remoteUrl = endpoint(url, host);
      if (host === 'codex') {
        server = { url: remoteUrl, tool_timeout_sec: 30 };
        if (token) server.http_headers = { Authorization: `Bearer ${token}` };
        else server.bearer_token_env_var = tokenEnvVar;
      } else {
        server = { type: host === 'workbuddy' ? 'streamableHttp' : 'http', url: remoteUrl,
          headers: { Authorization: token ? `Bearer ${token}` : `Bearer \${${tokenEnvVar}}` } };
        if (host === 'workbuddy') server.timeout = 30000;
      }
    } else {
      transport = 'stdio';
      const command = text(options.command ?? 'npx', 'command');
      const args = options.args === undefined ? [...DEFAULT_ARGS] : options.args;
      if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new TypeError('args must contain single-line strings');
      server = { command, args: [...args] };
      if (directory) server.args.push('--data-dir', text(directory, 'directory'));
      if (channels) server.args.push('--channels', '--host', host);
      if (cwd) server.cwd = text(cwd, 'cwd');
      if (options.env !== undefined) {
        if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)) throw new TypeError('env must be an object');
        server.env = {};
        for (const [key, value] of Object.entries(options.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new TypeError('env must map variable names to strings');
          server.env[key] = value;
        }
      }
      if (host === 'codex') server.tool_timeout_sec = 30;
      else server.type = 'stdio';
      if (host === 'workbuddy') server.runtime = { type: 'node', version: '22' };
    }
    config = host === 'codex' ? { mcp_servers: { ffvideo: server } } : { mcpServers: { ffvideo: server } };
    launchInstructions = host === 'codex'
      ? ['Add the generated TOML to the appropriate Codex project/user MCP configuration, or install the bundled ffvideo plugin.', 'Keep the host session open; use the optional Codex bridge for automatic replenishment instead of expecting generic MCP to wake the host.']
      : [`Import the MCP server entry through ${host}'s MCP settings, or save it in the supported project configuration after review.`, 'Install the accompanying video-feed skill. The configuration generator never changes user settings.'];
    if (channels) {
      const binary = host === 'claude' ? 'claude' : 'codebuddy';
      launchInstructions.push(`Development session: ${binary} --dangerously-load-development-channels server:ffvideo`, `After channel allowlisting: ${binary} --channels server:ffvideo`);
      limitations.splice(0, 1, 'Native channels can enqueue events into an open CLI session only after explicit opt-in; allowlist and organization policy still apply. Channel write success is not delivery acknowledgement.');
    }
    if (host === 'workbuddy' || host === 'qoder') limitations.push('An idle desktop agent wake-up API has not been established for this adapter. Use active-turn long polling or a separately configured continuous generation provider.');
  }
  // Serialize inline maps separately; no tokens are logged by this module.
  let configText;
  if (host === 'codex') {
    configText = codexToml(server);
    if (server.http_headers) {
      configText += '\n[mcp_servers.ffvideo.http_headers]\n';
      for (const [key, value] of Object.entries(server.http_headers)) configText += `${tomlString(key)} = ${tomlString(value)}\n`;
    }
  } else configText = JSON.stringify(config, null, 2) + '\n';
  return { host, transport, config, configText, launchInstructions, limitations };
}
