"""Local, trusted artifact lifecycle. Never use this registry for untrusted pickle files."""

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
import sklearn
from pydantic import BaseModel, ConfigDict, Field
from sklearn.datasets import load_iris
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

SCHEMA_VERSION = "iris-v1"
FEATURES = ["sepal_length", "sepal_width", "petal_length", "petal_width"]
CLASSES = ["setosa", "versicolor", "virginica"]


class ArtifactError(ValueError):
    pass


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    schema_version: Literal["iris-v1"]
    features: list[str]
    classes: list[str]
    sklearn_version: str
    created_at: str
    algorithm: Literal["StandardScaler+LogisticRegression"]
    accuracy: float = Field(ge=0, le=1)
    evaluation: Literal["iris-stratified-holdout-seed42-30pct"]
    state: Literal["candidate", "validated", "canary", "promoted", "retired"] = "candidate"


def version_dir(root: Path, version: str) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}", version):
        raise ArtifactError("Invalid version identifier")
    directory = root / "versions" / version
    if not directory.resolve().is_relative_to((root / "versions").resolve()):
        raise ArtifactError("Artifact must remain inside registry")
    return directory


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def split_data():
    data = load_iris()
    return train_test_split(
        data.data, data.target, test_size=0.3, random_state=42, stratify=data.target
    )


def register(root: Path, version: str, regularization: float = 1.0) -> Manifest:
    if not np.isfinite(regularization) or regularization <= 0:
        raise ArtifactError("Regularization must be positive and finite")
    directory = version_dir(root, version)
    directory.mkdir(parents=True, exist_ok=False)
    train_x, test_x, train_y, test_y = split_data()
    model = make_pipeline(StandardScaler(), LogisticRegression(C=regularization, max_iter=300))
    model.fit(train_x, train_y)
    artifact = directory / "model.joblib"
    joblib.dump(model, artifact)
    manifest = Manifest(
        version=version,
        sha256=hashlib.sha256(artifact.read_bytes()).hexdigest(),
        schema_version=SCHEMA_VERSION,
        features=FEATURES,
        classes=CLASSES,
        sklearn_version=sklearn.__version__,
        created_at=datetime.now(UTC).isoformat(),
        algorithm="StandardScaler+LogisticRegression",
        accuracy=accuracy_score(test_y, model.predict(test_x)),
        evaluation="iris-stratified-holdout-seed42-30pct",
    )
    atomic_json(directory / "manifest.json", manifest.model_dump())
    return manifest


def load(root: Path, version: str):
    directory = version_dir(root, version)
    try:
        manifest = Manifest.model_validate_json((directory / "manifest.json").read_text())
        if (
            manifest.version != version
            or manifest.features != FEATURES
            or manifest.classes != CLASSES
        ):
            raise ArtifactError("Artifact input/output contract mismatch")
        if manifest.sklearn_version != sklearn.__version__:
            raise ArtifactError("Artifact sklearn version mismatch; regenerate in this runtime")
        artifact = directory / "model.joblib"
        if artifact.is_symlink() or not artifact.resolve().is_relative_to(directory.resolve()):
            raise ArtifactError("Artifact symlinks are not permitted")
        # Hash and deserialize the same bytes; never deserialize before integrity checks.
        data = artifact.read_bytes()
        if hashlib.sha256(data).hexdigest() != manifest.sha256:
            raise ArtifactError("Artifact checksum mismatch")
        import io

        model = joblib.load(io.BytesIO(data))
        if model.n_features_in_ != 4 or list(model.classes_) != [0, 1, 2]:
            raise ArtifactError("Artifact model contract mismatch")
        return manifest, model
    except ArtifactError:
        raise
    except Exception as exc:
        raise ArtifactError("Artifact could not be loaded") from exc


def validate(root: Path, version: str, minimum_accuracy: float = 0.9) -> Manifest:
    if not 0 <= minimum_accuracy <= 1:
        raise ArtifactError("Accuracy threshold must be between 0 and 1")
    manifest, model = load(root, version)
    _, test_x, _, test_y = split_data()
    measured = accuracy_score(test_y, model.predict(test_x))
    probabilities = model.predict_proba(test_x)
    if not np.isfinite(probabilities).all() or not np.allclose(probabilities.sum(axis=1), 1):
        raise ArtifactError("Invalid prediction probabilities")
    if abs(manifest.accuracy - measured) > 1e-9 or measured < minimum_accuracy:
        raise ArtifactError(
            f"Candidate rejected: accuracy {measured:.4f}, required {minimum_accuracy:.4f}"
        )
    return manifest
