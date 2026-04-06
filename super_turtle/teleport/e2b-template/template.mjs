import { Template } from "e2b";
import { templateConfig } from "./config.mjs";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const manifest = {
  template_name: templateConfig.templateName,
  template_version: templateConfig.templateVersionTag,
  runtime_version: templateConfig.runtimeVersion,
  runtime_install_spec: templateConfig.runtimeInstallSpec,
  codex_install_spec: templateConfig.codexInstallSpec,
  built_at: new Date().toISOString(),
};

const manifestScript = [
  "cat > /opt/superturtle/template-manifest.json <<'EOF'",
  JSON.stringify(manifest, null, 2),
  "EOF",
].join("\n");

const bootstrapCommands = [
  "set -euo pipefail",
  "mkdir -p /opt/superturtle /home/user/.bun/bin /home/user/.local/bin /home/user/.codex /home/user/.superturtle /home/user/.superturtle/subturtles /home/user/workspace",
  "chown -R user:user /opt/superturtle /home/user/.bun /home/user/.local /home/user/.codex /home/user/.superturtle /home/user/.superturtle/subturtles /home/user/workspace",
  "printf '%s\n' 'export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$PATH\"' >/etc/profile.d/superturtle-path.sh",
  "chmod 644 /etc/profile.d/superturtle-path.sh",
  "if command -v fdfind >/dev/null 2>&1 && ! command -v fd >/dev/null 2>&1; then ln -sf \"$(command -v fdfind)\" /usr/local/bin/fd; fi",
  manifestScript,
];

const packageInstallCommand = [
  "set -euo pipefail && export BUN_INSTALL=/home/user/.bun PATH=\"/home/user/.bun/bin:$PATH\" && bun install -g",
  shellEscape(templateConfig.codexInstallSpec),
  shellEscape(templateConfig.runtimeInstallSpec),
  "&& chown -R user:user /home/user/.bun",
].join(" ");

export const template = Template()
  .fromBunImage(templateConfig.bunVersion)
  .aptInstall(
    [
      "git",
      "curl",
      "nodejs",
      "jq",
      "tmux",
      "rsync",
      "ripgrep",
      "fd-find",
      "unzip",
      "ffmpeg",
      "python3",
      "python3-pip",
      "python3-venv",
      "build-essential",
    ],
    { noInstallRecommends: true }
  )
  .runCmd("python3 -m pip install --break-system-packages uv", { user: "root" })
  .runCmd(bootstrapCommands, { user: "root" })
  .runCmd(packageInstallCommand, { user: "root" })
  .setWorkdir("/home/user/workspace");
