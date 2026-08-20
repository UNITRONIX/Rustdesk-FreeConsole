#!/usr/bin/env python3
"""Reproducible BetterDesk Desktop build and packaging entry point."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
FLUTTER = ROOT / "flutter"
DIST = ROOT / "dist"
VERSION = (REPO / "VERSION").read_text(encoding="utf-8").strip()


def tool(name: str) -> str | None:
    resolved = shutil.which(name)
    if resolved:
        return resolved
    if name == "flutter":
        return shutil.which("flutter.bat")
    return None


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    print("+", " ".join(command))
    subprocess.run(command, cwd=cwd, check=True)


def require_tools(names: list[str]) -> None:
    missing = [name for name in names if not tool(name)]
    if missing:
        raise SystemExit(
            "Missing build tools: "
            + ", ".join(missing)
            + ". See betterdesk-desktop/README.md."
        )


def ensure_flutter_project() -> None:
    if not (FLUTTER / "windows").exists() or not (FLUTTER / "linux").exists():
        flutter = tool("flutter")
        if not flutter:
            raise SystemExit("Missing build tool: flutter.")
        run(
            [
                flutter,
                "create",
                "--platforms=windows,linux",
                "--project-name",
                "betterdesk_desktop",
                ".",
            ],
            cwd=FLUTTER,
        )


def check() -> None:
    require_tools(["cargo", "rustc", "protoc", "python"])
    if not tool("flutter"):
        raise SystemExit(
            "Missing build tool: flutter. Install Flutter stable with "
            "Windows/Linux desktop support."
        )
    ensure_flutter_project()
    run(["cargo", "check"])
    run([tool("flutter"), "pub", "get"], cwd=FLUTTER)
    print(f"BetterDesk Desktop toolchain is ready for version {VERSION}.")


def test() -> None:
    run(["cargo", "test"])
    require_tools(["flutter"])
    ensure_flutter_project()
    run([tool("flutter"), "test"], cwd=FLUTTER)


def build_core() -> None:
    # Keep the native library beside this orchestrator. Some CI/sandbox
    # environments override CARGO_TARGET_DIR, which would otherwise make the
    # subsequent bundle-copy step unable to locate the cdylib.
    run(["cargo", "build", "--release", "--target-dir", str(ROOT / "target")])


def flutter_build(platform: str) -> Path:
    ensure_flutter_project()
    run([tool("flutter"), "pub", "get"], cwd=FLUTTER)
    run([tool("flutter"), "build", platform, "--release"], cwd=FLUTTER)
    if platform == "windows":
        return FLUTTER / "build" / "windows" / "x64" / "runner" / "Release"
    return FLUTTER / "build" / "linux" / "x64" / "release" / "bundle"


def copy_core(bundle: Path, platform: str) -> None:
    if platform == "windows":
        library = ROOT / "target" / "release" / "betterdesk_desktop.dll"
        helper = ROOT / "target" / "release" / "betterdesk_desktop_helper.exe"
    else:
        library = ROOT / "target" / "release" / "libbetterdesk_desktop.so"
        helper = None
    if not library.exists():
        raise SystemExit(f"Rust core library was not produced: {library}")
    shutil.copy2(library, bundle / library.name)
    if helper is not None:
        if not helper.exists():
            raise SystemExit(f"Windows elevation helper was not produced: {helper}")
        shutil.copy2(helper, bundle / "BetterDesk.Desktop.Helper.exe")
        manifest = ROOT / "packaging" / "windows" / "BetterDesk.Desktop.Helper.manifest"
        shutil.copy2(manifest, bundle / "BetterDesk.Desktop.Helper.exe.manifest")


def stage_bundle(source: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)


def zip_directory(source: Path, destination: Path) -> None:
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(source))


def package_windows(bundle: Path) -> list[Path]:
    require_tools(["powershell"])
    stage = DIST / "staging" / "windows-x64"
    stage_bundle(bundle, stage)
    portable_exe = stage / "betterdesk_desktop.exe"
    if not portable_exe.exists():
        portable_exe = next(
            (path for path in stage.glob("*.exe") if "helper" not in path.name.lower()),
            None,
        )
    if portable_exe is None:
        raise SystemExit("Flutter Windows bundle contains no executable.")

    output: list[Path] = []
    renamed_exe = DIST / f"BetterDesk-Desktop-{VERSION}-windows-x64.exe"
    shutil.copy2(portable_exe, renamed_exe)
    output.append(renamed_exe)
    portable_zip = DIST / f"BetterDesk-Desktop-{VERSION}-windows-x64-portable.zip"
    zip_directory(stage, portable_zip)
    output.append(portable_zip)

    wix = tool("wix")
    if wix:
        msi = DIST / f"BetterDesk-Desktop-{VERSION}-windows-x64.msi"
        run(
            [
                wix,
                "build",
                str(ROOT / "packaging" / "windows" / "BetterDesk.wxs"),
                f"-dAppDir={stage}",
                f"-dProductVersion={VERSION}",
                f"-o{msi}",
            ],
        )
        output.append(msi)
    else:
        print("warning: WiX is unavailable; MSI was not produced.", file=sys.stderr)
    return output


def create_deb(bundle: Path) -> Path:
    require_tools(["dpkg-deb"])
    root = DIST / "staging" / "deb"
    if root.exists():
        shutil.rmtree(root)
    app = root / "opt" / "betterdesk"
    stage_bundle(bundle, app)
    control = root / "DEBIAN"
    control.mkdir(parents=True)
    (control / "control").write_text(
        f"""Package: betterdesk-desktop
Version: {VERSION}
Section: net
Priority: optional
Architecture: amd64
Maintainer: UNITRONIX
Description: Independent BetterDesk Desktop operator client
""",
        encoding="utf-8",
    )
    output = DIST / f"BetterDesk-Desktop-{VERSION}-linux-x64.deb"
    run(["dpkg-deb", "--build", str(root), str(output)])
    return output


def create_rpm(bundle: Path) -> Path | None:
    if not tool("rpmbuild"):
        print("warning: rpmbuild is unavailable; RPM was not produced.", file=sys.stderr)
        return None
    top = DIST / "staging" / "rpm"
    if top.exists():
        shutil.rmtree(top)
    for name in ("BUILD", "RPMS", "SOURCES", "SPECS", "SRPMS"):
        (top / name).mkdir(parents=True)
    app = top / "BUILD" / "betterdesk"
    stage_bundle(bundle, app)
    spec = top / "SPECS" / "betterdesk-desktop.spec"
    spec.write_text(
        f"""Name: betterdesk-desktop
Version: {VERSION}
Release: 1
Summary: Independent BetterDesk Desktop operator client
License: AGPL-3.0-only
BuildArch: x86_64

%description
Independent BetterDesk Desktop operator client.

%install
mkdir -p %{{buildroot}}/opt/betterdesk
cp -a %{{_topdir}}/BUILD/betterdesk/. %{{buildroot}}/opt/betterdesk/

%files
/opt/betterdesk
""",
        encoding="utf-8",
    )
    run(["rpmbuild", "--define", f"_topdir {top}", "-bb", str(spec)])
    built = next((top / "RPMS").rglob("*.rpm"))
    output = DIST / f"BetterDesk-Desktop-{VERSION}-linux-x64.rpm"
    shutil.copy2(built, output)
    return output


def create_appimage(bundle: Path) -> Path | None:
    appimagetool = tool("appimagetool")
    if not appimagetool:
        print("warning: appimagetool is unavailable; AppImage was not produced.", file=sys.stderr)
        return None
    appdir = DIST / "staging" / "AppDir"
    if appdir.exists():
        shutil.rmtree(appdir)
    appdir.mkdir(parents=True)
    stage_bundle(bundle, appdir / "usr" / "lib" / "betterdesk")
    (appdir / "AppRun").write_text(
        "#!/bin/sh\nexec \"$(dirname \"$0\")/usr/lib/betterdesk/betterdesk_desktop\" \"$@\"\n",
        encoding="utf-8",
    )
    (appdir / "AppRun").chmod(0o755)
    (appdir / "betterdesk.desktop").write_text(
        """[Desktop Entry]
Name=BetterDesk Desktop
Exec=betterdesk_desktop
Type=Application
Categories=Network;RemoteAccess;
""",
        encoding="utf-8",
    )
    output = DIST / f"BetterDesk-Desktop-{VERSION}-linux-x64.AppImage"
    run([appimagetool, str(appdir), str(output)])
    return output


def package_linux(bundle: Path) -> list[Path]:
    stage = DIST / "staging" / "linux-x64"
    stage_bundle(bundle, stage)
    portable = DIST / f"BetterDesk-Desktop-{VERSION}-linux-x64.tar.gz"
    run(["tar", "-czf", str(portable), "-C", str(stage), "."])
    output: list[Path] = [portable, create_deb(bundle)]
    rpm = create_rpm(bundle)
    if rpm:
        output.append(rpm)
    appimage = create_appimage(bundle)
    if appimage:
        output.append(appimage)
    return output


def write_checksums(files: list[Path]) -> Path:
    checksum_file = DIST / "DESKTOP_CHECKSUMS.sha256"
    lines = []
    for path in sorted(files):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.name}")
    checksum_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return checksum_file


def build(target: str) -> None:
    require_tools(["cargo", "rustc", "protoc", "flutter"])
    DIST.mkdir(exist_ok=True)
    build_core()
    files: list[Path] = []
    if target == "windows-x64":
        bundle = flutter_build("windows")
        copy_core(bundle, "windows")
        files.extend(package_windows(bundle))
    elif target == "linux-x64":
        bundle = flutter_build("linux")
        copy_core(bundle, "linux")
        files.extend(package_linux(bundle))
    else:
        raise SystemExit(f"Unsupported target: {target}")
    files.append(write_checksums(files))
    print("Produced:")
    for path in files:
        print(f"  {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sub.add_parser("test")
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--target", choices=("windows-x64", "linux-x64"), required=True)
    args = parser.parse_args()
    if args.command == "check":
        check()
    elif args.command == "test":
        test()
    else:
        build(args.target)


if __name__ == "__main__":
    main()
