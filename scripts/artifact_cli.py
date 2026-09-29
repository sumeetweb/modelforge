#!/usr/bin/env python3
"""Explicit single-operator release management; routing takes effect after restart."""

import argparse
import json
import os
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services/model-server"))
from app.artifacts import ArtifactError, atomic_json, register, validate, version_dir  # noqa: E402


def write_release(root: Path, release: dict):
    atomic_json(root / "release.json", release)
    temporary = root / "routing.tmp"
    temporary.write_text(
        f"MODEL_STABLE_VERSION={release['stable']}\n"
        f"MODEL_CANDIDATE_VERSION={release['candidate']}\nCANARY_PERCENT={release['canary_percent']}\n"
    )
    temporary.replace(root / "routing.env")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=["register", "validate", "bootstrap", "promote", "rollback"]
    )
    parser.add_argument("version", nargs="?")
    parser.add_argument(
        "--root", type=Path, default=Path(os.getenv("ARTIFACT_ROOT", "model-artifacts"))
    )
    parser.add_argument("--regularization", type=float, default=1)
    parser.add_argument("--minimum-accuracy", type=float, default=0.9)
    parser.add_argument("--weight", type=int, default=20)
    parser.add_argument(
        "--health-url", help="Candidate server origin for a pre-promotion prediction check"
    )
    args = parser.parse_args()
    root = args.root
    if args.command in ("register", "validate", "promote") and not args.version:
        parser.error("version is required")
    if args.command == "register":
        manifest = register(root, args.version, args.regularization)
        print(manifest.model_dump_json(indent=2))
    elif args.command == "validate":
        manifest = validate(root, args.version, args.minimum_accuracy)
        if manifest.state == "candidate":
            manifest.state = "validated"
            atomic_json(version_dir(root, args.version) / "manifest.json", manifest.model_dump())
        print(
            f"Validated {manifest.version}: accuracy={manifest.accuracy:.4f}, "
            f"sha256={manifest.sha256}"
        )
    elif args.command == "bootstrap":
        for version, regularization in [("v1", 1), ("v2", 2)]:
            if not version_dir(root, version).exists():
                register(root, version, regularization)
            validate(root, version)
        if not (root / "release.json").exists():
            write_release(root, {"stable": "v1", "candidate": "v2", "canary_percent": 20})
        print("Artifacts ready; existing releases preserved")
    elif args.command == "promote":
        if not 0 <= args.weight <= 100:
            parser.error("weight must be between 0 and 100")
        manifest = validate(root, args.version, args.minimum_accuracy)
        if args.health_url:
            request = urllib.request.Request(
                args.health_url.rstrip("/") + "/v1/predict",
                data=b'{"instances":[[5.1,3.5,1.4,0.2]]}',
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                result = json.load(response)
            if (
                result.get("model_version") != args.version
                or result["predictions"][0]["label"] != "setosa"
            ):
                raise ArtifactError("Candidate smoke test rejected")
        previous = json.loads((root / "release.json").read_text())
        history = root / "history"
        history.mkdir(exist_ok=True)
        atomic_json(history / "previous.json", previous)
        atomic_json(history / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%f')}.json", previous)
        manifest.state = "promoted" if args.weight == 100 else "canary"
        atomic_json(version_dir(root, args.version) / "manifest.json", manifest.model_dump())
        write_release(
            root,
            {
                "stable": previous["stable"],
                "candidate": args.version,
                "canary_percent": args.weight,
            },
        )
        print(
            "Release configuration updated. Restart services to apply; "
            "verify metrics before increasing weight."
        )
    else:
        previous = json.loads((root / "history/previous.json").read_text())
        validate(root, previous["stable"])
        validate(root, previous["candidate"])
        write_release(root, previous)
        print("Previous release restored. Restart services to apply (manual rollback).")


if __name__ == "__main__":
    try:
        main()
    except (ArtifactError, OSError, ValueError, KeyError) as exc:
        print(f"Release operation failed: {exc}", file=sys.stderr)
        sys.exit(1)
