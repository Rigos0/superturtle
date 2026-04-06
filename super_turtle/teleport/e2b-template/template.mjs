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

const remotionInstallSpecs = [
  "@remotion/cli",
  "remotion",
  "react",
  "react-dom",
];

const packageInstallCommand = [
  "set -euo pipefail && export BUN_INSTALL=/home/user/.bun PATH=\"/home/user/.bun/bin:$PATH\" && bun install -g",
  shellEscape(templateConfig.codexInstallSpec),
  ...remotionInstallSpecs.map(shellEscape),
  "&& chown -R user:user /home/user/.bun",
].join(" ");

export const template = Template()
  .fromBunImage(templateConfig.bunVersion)
  // Measured on 2026-04-06 against the current Debian-based managed sandbox:
  // this common office/media native stack adds about 430 packages and roughly
  // 1.4 GB installed size. Current managed sandboxes are about 22.4 GB disk,
  // so this is intentional headroom for office and media work.
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
      "imagemagick",
      "libnspr4",
      "libnss3",
      "libreoffice",
      "poppler-utils",
      "python3",
      "python3-pip",
      "python3-venv",
      "build-essential",
    ],
    { noInstallRecommends: true }
  )
  // Measured wheel downloads for python-pptx + Pillow were about 5 MB total.
  .runCmd("python3 -m pip install --break-system-packages uv python-pptx Pillow", { user: "root" })
  .runCmd(bootstrapCommands, { user: "root" })
  // A minimal global Remotion toolchain install was about 168 MB in node_modules
  // before browser/runtime caches. We preinstall it because video work is a
  // first-class managed-runtime workflow now.
  .runCmd(packageInstallCommand, { user: "root" })
  .setWorkdir("/home/user/workspace");
