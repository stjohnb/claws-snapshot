import { describe, it, expect } from "vitest";

import {
  renderSessionEnvFile,
  renderGrantedEnvFile,
  grantedEnvMarker,
  sessionPromptFileContent,
  codexConfigBody,
  codexRemoteMcpServersToml,
  opencodeConfigBody,
  piRemoteMcpJson,
  CODEX_DISABLE_UPDATE_CHECK_TOML,
} from "./session-env-file.js";

describe("session-env-file", () => {
  it("renderSessionEnvFile writes one single-quoted export line per var (#3026)", () => {
    expect(renderSessionEnvFile({ A: "plain", B: "it's quoted" })).toBe("export A='plain'\nexport B='it'\\''s quoted'\n");
    expect(renderSessionEnvFile({})).toBe("");
  });

  it("renders granted.env with sorted marker lines before the exports (#3072)", () => {
    expect(grantedEnvMarker("ssh:nas")).toBe("# claws-granted: ssh:nas");
    expect(renderGrantedEnvFile(["ssh:nas", "home-assistant"], { HOME_ASSISTANT_TOKEN: "t" })).toBe(
      "# claws-granted: home-assistant\n# claws-granted: ssh:nas\nexport HOME_ASSISTANT_TOKEN='t'\n",
    );
  });

  it("sessionPromptFileContent adds a trailing newline only when missing", () => {
    expect(sessionPromptFileContent("## Claws session")).toBe("## Claws session\n");
    expect(sessionPromptFileContent("already terminated\n")).toBe("already terminated\n");
  });

  it("codexConfigBody carries developer_instructions only when non-empty", () => {
    expect(codexConfigBody("")).not.toContain("developer_instructions");
    expect(codexConfigBody("Be careful")).toContain('developer_instructions = "Be careful"');
  });

  it("codexConfigBody always disables the startup update check, before developer_instructions (#3312)", () => {
    const empty = codexConfigBody("");
    expect(empty).toContain(CODEX_DISABLE_UPDATE_CHECK_TOML);

    const withInstructions = codexConfigBody("Be careful");
    expect(withInstructions).toContain(CODEX_DISABLE_UPDATE_CHECK_TOML);
    expect(withInstructions.indexOf(CODEX_DISABLE_UPDATE_CHECK_TOML)).toBeLessThan(
      withInstructions.indexOf("developer_instructions"),
    );
  });

  it("codexConfigBody escapes developer instructions and appends MCP servers", () => {
    const body = codexConfigBody('say "hi"\nthen stop', codexRemoteMcpServersToml("claws-state", "http://claws:3000/mcp/sessions/abc", "CLAWS_SESSION_MCP_TOKEN"));
    expect(body).toContain('developer_instructions = "say \\"hi\\"\\nthen stop"');
    expect(body.trimEnd().endsWith('bearer_token_env_var = "CLAWS_SESSION_MCP_TOKEN"')).toBe(true);
  });

  it("renders Codex remote MCP TOML with quoted URL and token env var", () => {
    const toml = codexRemoteMcpServersToml(
      "claws-state",
      "http://claws:3000/mcp/sessions/a\"b",
      "CLAWS_SESSION_MCP_TOKEN",
    );

    expect(toml).toBe([
      "[mcp_servers.claws-state]",
      'url = "http://claws:3000/mcp/sessions/a\\"b"',
      'bearer_token_env_var = "CLAWS_SESSION_MCP_TOKEN"',
    ].join("\n"));
  });

  it("renders OpenCode config JSON with remote MCP headers quoted by JSON", () => {
    const body = opencodeConfigBody("/tmp/instructions.md", {
      "claws-state": {
        type: "remote",
        url: "http://claws:3000/mcp/sessions/a'b",
        headers: { Authorization: "Bearer tok\"en" },
      },
    });

    expect(JSON.parse(body)).toEqual({
      $schema: "https://opencode.ai/config.json",
      instructions: ["/tmp/instructions.md"],
      mcp: {
        "claws-state": {
          type: "remote",
          url: "http://claws:3000/mcp/sessions/a'b",
          headers: { Authorization: "Bearer tok\"en" },
        },
      },
    });
  });

  it("omits the OpenCode mcp key when there are no servers", () => {
    expect(JSON.parse(opencodeConfigBody("/tmp/instructions.md"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      instructions: ["/tmp/instructions.md"],
    });
  });

  it("renders pi's remote MCP config with the bearer as an env reference, never a value", () => {
    expect(JSON.parse(piRemoteMcpJson("claws-state", "http://claws:3000/mcp/sessions/abc", "PI_SESSION_MCP_TOKEN"))).toEqual({
      mcpServers: {
        "claws-state": {
          url: "http://claws:3000/mcp/sessions/abc",
          headers: { Authorization: "Bearer ${PI_SESSION_MCP_TOKEN}" },
          timeout: 300,
        },
      },
    });
  });
});
