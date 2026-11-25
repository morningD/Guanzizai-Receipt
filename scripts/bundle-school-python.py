"""Build the relocatable, hash-locked Python runtime next to the portable launcher."""
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile

RELEASE = "20261123"
VERSION = "3.12.16"
TARGETS = {
    ("Darwin", "arm64"): ("aarch64-apple-darwin", "0de87cfc2649849da10a54084f87fd01fa1e653478e32eee92198c213550e15c"),
    ("Windows", "amd64"): ("x86_64-pc-windows-msvc", "75988f49393727d7e53b673d50088e7f809a629dd37cb59da3756479bc6ea5c1"),
}


def bundle(output):
    triple, expected = TARGETS[(platform.system(), platform.machine().lower())]
    asset = f"cpython-{VERSION}+{RELEASE}-{triple}-install_only_stripped.tar.gz"
    url = f"https://github.com/astral-sh/python-build-standalone/releases/download/{RELEASE}/{asset}"
    with tempfile.TemporaryDirectory(prefix="receipt-python-") as work:
        directory = Path(work)
        archive = directory / asset
        subprocess.run(["curl.exe" if os.name == "nt" else "curl", "--fail", "--silent", "--show-error", "--location",
                        "--retry", "3", "--connect-timeout", "15", "--max-time", "150", "--output", str(archive), url], check=True)
        with archive.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                raise ValueError("Bundled Python archive SHA-256 mismatch")
        with tarfile.open(archive) as package:
            package.extractall(directory, filter="data")
        bundled = directory / "python"
        # ZIP entries are ordinary files. Only materialize aliases inside the verified distribution.
        for file in bundled.rglob("*"):
            if file.is_symlink():
                target = file.resolve(strict=True)
                if not target.is_relative_to(bundled.resolve()) or not target.is_file():
                    raise ValueError(f"Unexpected Python archive link: {file.name}")
                file.unlink()
                shutil.copy2(target, file)
        python = bundled / ("python.exe" if os.name == "nt" else "bin/python3.12")
        lockfile = Path(__file__).with_name("portable") / "school-wheels.txt"
        third_party = bundled / "site-packages"
        subprocess.run([str(python), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "install",
                        "--index-url", "https://pypi.org/simple", "--require-hashes", "--only-binary=:all:", "--no-compile",
                        "--target", str(third_party), "-r", str(lockfile)], check=True)
        # Console wrappers contain the build host interpreter path and are unused.
        for folder in (third_party / "bin", third_party / "Scripts", bundled / "Scripts"):
            if folder.is_dir():
                shutil.rmtree(folder)
        shutil.copytree(bundled, output)


if __name__ == "__main__":
    bundle(Path(sys.argv[1]).resolve())
