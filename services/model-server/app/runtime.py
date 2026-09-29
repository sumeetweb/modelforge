import os
from pathlib import Path

import numpy as np
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .artifacts import CLASSES, load


class Settings(BaseModel):
    artifact_root: Path = Path("model-artifacts")
    model_version: str = Field(default="v1", pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
    enable_faults: bool = False
    fault_delay_ms: int = Field(default=0, ge=0, le=10000)
    fault_error_rate: float = Field(default=0, ge=0, le=1)

    @classmethod
    def from_env(cls):
        return cls(
            artifact_root=os.getenv("ARTIFACT_ROOT", "model-artifacts"),
            model_version=os.getenv("MODEL_VERSION", "v1"),
            enable_faults=os.getenv("ENABLE_FAULTS", "false"),
            fault_delay_ms=os.getenv("FAULT_DELAY_MS", "0"),
            fault_error_rate=os.getenv("FAULT_ERROR_RATE", "0"),
        )


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instances: list[list[float]] = Field(min_length=1, max_length=128)

    @field_validator("instances", mode="before")
    @classmethod
    def valid_instances(cls, rows):
        if not isinstance(rows, list):
            raise ValueError("Instances must be an array")
        for row in rows:
            if not isinstance(row, list) or len(row) != 4:
                raise ValueError("Every instance must contain four numeric measurements")
            if any(
                type(x) not in (int, float) or not np.isfinite(x) or not 0 <= x <= 30 for x in row
            ):
                raise ValueError("Measurements must be finite numbers in [0, 30]")
        return rows


class Prediction(BaseModel):
    label: str
    probabilities: list[float] = Field(min_length=3, max_length=3)


class PredictionResponse(BaseModel):
    model_version: str
    schema_version: str = "iris-v1"
    predictions: list[Prediction]


class ModelRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model = None
        self.manifest = None

    def load(self):
        self.manifest, self.model = load(self.settings.artifact_root, self.settings.model_version)

    def predict(self, request: PredictionRequest) -> PredictionResponse:
        if self.model is None:
            raise RuntimeError("Model not loaded")
        probabilities = self.model.predict_proba(request.instances)
        if (
            probabilities.shape != (len(request.instances), 3)
            or not np.isfinite(probabilities).all()
        ):
            raise RuntimeError("Model produced invalid output")
        if (
            (probabilities < 0).any()
            or (probabilities > 1).any()
            or not np.allclose(probabilities.sum(1), 1)
        ):
            raise RuntimeError("Model produced invalid probabilities")
        return PredictionResponse(
            model_version=self.settings.model_version,
            predictions=[
                Prediction(label=CLASSES[int(np.argmax(row))], probabilities=row.tolist())
                for row in probabilities
            ],
        )
