import pytest
from app.artifacts import register


@pytest.fixture
def registry(tmp_path):
    register(tmp_path, "test-v1")
    return tmp_path
