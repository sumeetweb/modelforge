import json

import pytest
from app.artifacts import ArtifactError, load, register, validate, version_dir


def test_roundtrip_and_evaluation(registry):
    manifest = validate(registry, "test-v1")
    assert manifest.accuracy >= 0.9
    assert len(manifest.sha256) == 64
    assert load(registry, "test-v1")[1].n_features_in_ == 4


def test_duplicate_version_is_immutable(registry):
    with pytest.raises(FileExistsError):
        register(registry, "test-v1")


@pytest.mark.parametrize("version", ["../escape", "/tmp/evil", "a/b", "", "v" * 65])
def test_path_traversal_rejected(tmp_path, version):
    with pytest.raises(ArtifactError):
        version_dir(tmp_path, version)


def test_checksum_checked_before_deserializing(registry, monkeypatch):
    (registry / "versions/test-v1/model.joblib").write_bytes(b"not a pickle")
    monkeypatch.setattr("joblib.load", lambda _: pytest.fail("deserializer must not run"))
    with pytest.raises(ArtifactError, match="checksum"):
        load(registry, "test-v1")


@pytest.mark.parametrize(
    "field,value",
    [
        ("schema_version", "iris-v2"),
        ("features", ["wrong"]),
        ("sklearn_version", "0.0"),
        ("version", "other"),
    ],
)
def test_incompatible_manifest(registry, field, value):
    path = registry / "versions/test-v1/manifest.json"
    data = json.loads(path.read_text())
    data[field] = value
    path.write_text(json.dumps(data))
    with pytest.raises(ArtifactError):
        load(registry, "test-v1")


def test_evaluation_recomputed(registry):
    path = registry / "versions/test-v1/manifest.json"
    data = json.loads(path.read_text())
    data["accuracy"] = 0.1
    path.write_text(json.dumps(data))
    with pytest.raises(ArtifactError, match="Candidate rejected"):
        validate(registry, "test-v1")
