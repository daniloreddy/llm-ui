"""Generate static/tw.css via Tailwind CSS standalone CLI (stdlib only, no curl)."""
import json
import os
import platform
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent


def main() -> None:
    machine = platform.machine()
    arch_map = {"x86_64": "linux-x64", "aarch64": "linux-arm64"}
    asset = arch_map.get(machine)
    if not asset:
        raise RuntimeError(f"Unsupported architecture: {machine}")

    print(f"[tailwind] Fetching latest release…")
    with urllib.request.urlopen(
        "https://api.github.com/repos/tailwindlabs/tailwindcss/releases/latest"
    ) as resp:
        version = json.loads(resp.read())["tag_name"]

    url = (
        f"https://github.com/tailwindlabs/tailwindcss/releases/download"
        f"/{version}/tailwindcss-{asset}"
    )
    print(f"[tailwind] Downloading {version} ({asset})…")

    tmp = Path("/tmp/tailwindcss-build")
    urllib.request.urlretrieve(url, tmp)
    tmp.chmod(0o755)

    try:
        subprocess.run(
            [str(tmp), "-i", "static/input.css", "-o", "static/tw.css", "--minify"],
            cwd=ROOT,
            check=True,
        )
        print("[tailwind] Generated static/tw.css")
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
