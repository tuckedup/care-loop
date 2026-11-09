import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const dockerfile = read("Dockerfile");
const compose = read("docker-compose.app.yml");
const dockerignore = read(".dockerignore");
const gitignore = read(".gitignore");
const entrypoint = read("docker/entrypoint.sh");

describe("container secret hygiene", () => {
  it("the Dockerfile never bakes a key or secret into a layer", () => {
    const lines = dockerfile.split("\n").filter((l) => /^\s*(ARG|ENV)\b/.test(l));
    for (const l of lines) expect(l, l).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/i);
    expect(dockerfile).not.toMatch(/COPY\s+\.env/);
  });

  it("the build context excludes env files, secrets and git history", () => {
    for (const p of [".env", ".env.*", "secrets/", ".git"]) expect(dockerignore).toContain(p);
    expect(gitignore).toMatch(/^secrets\/$/m);
  });

  it("the runtime image runs as a non-root user", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toMatch(/^USER node$/m);
  });

  it("the API key and session secret arrive only as mounted secret files", () => {
    expect(compose).toMatch(/ANTHROPIC_API_KEY_FILE:\s*\/run\/secrets\/anthropic_api_key/);
    expect(compose).toMatch(/SESSION_SECRET_FILE:\s*\/run\/secrets\/session_secret/);
    expect(compose).not.toMatch(/^\s*ANTHROPIC_API_KEY:/m);
    expect(compose).not.toMatch(/^\s*SESSION_SECRET:/m);
  });

  it("hardens the long-running containers and binds the port to localhost", () => {
    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).toContain("read_only: true");
    expect(compose).toContain('cap_drop: ["ALL"]');
    expect(compose).toContain("no-new-privileges:true");
  });

  it("the entrypoint never echoes secret values", () => {
    expect(entrypoint).not.toMatch(
      /echo[^\n]*\$value|echo[^\n]*\$\{?name\}?=|printenv|\benv\b\s*$/m,
    );
    expect(entrypoint).toContain('exec "$@"');
  });

  it("the session guard reads cookies before the demo-auth flag so pages are never prerendered", () => {
    const g = read("src/infra/auth/guard.ts");
    const body = g.slice(g.indexOf("export async function getSession"));
    expect(body.indexOf("await cookies()")).toBeGreaterThan(-1);
    expect(body.indexOf("await cookies()")).toBeLessThan(body.indexOf("demoAuthEnabled()"));
  });
});
