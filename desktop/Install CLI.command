#!/bin/zsh
set -euo pipefail
installer_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cli_dir="$HOME/.local/bin"
mkdir -p "$cli_dir"
if [[ -e "$cli_dir/playtrace" || -L "$cli_dir/playtrace" ]]; then
  cp -P "$cli_dir/playtrace" "$cli_dir/playtrace.backup.$(date +%Y%m%d%H%M%S)"
fi
install -m 755 "$installer_dir/playtrace" "$cli_dir/playtrace"
printf '\nCLI 已安装到 %s/playtrace\n' "$cli_dir"
printf '首次登录请运行：~/.local/bin/playtrace auth login\n'
printf '如果终端找不到 playtrace，可使用上述完整路径。\n'
printf '在 Codex 中说明工具位于 ~/.local/bin/playtrace，并让它先运行 help。\n'
read '?按回车关闭。'
