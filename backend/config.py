"""Application configuration loaded from environment variables."""

import os
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = REPO_ROOT / ".env"


class Settings(BaseSettings):
    """Centralized settings for the Threads backend."""

    SUPABASE_URL: str = Field(
        "https://dffscxoafddkvrufdvyi.supabase.co",
        env="SUPABASE_URL",
    )
    SUPABASE_SERVICE_ROLE_KEY: str = Field(
        "",
        env="SUPABASE_SERVICE_ROLE_KEY",
    )
    SUPABASE_SECRET_KEY: str = Field(
        "",
        env="SUPABASE_SECRET_KEY",
    )
    SUPABASE_KEY: str = Field(
        "",
        env="SUPABASE_KEY",
    )
    API_HOST: str = Field("0.0.0.0", env="API_HOST")
    API_PORT: int = Field(8000, env="API_PORT")
    THREADS_LLM_MODE: str = Field(
        "off",
        env="THREADS_LLM_MODE",
        description="off | rewrite (safe rewrite using facts only)",
    )
    OPENAI_API_KEY: str = Field("", env="OPENAI_API_KEY")
    OPENAI_MODEL: str = Field("gpt-4o-mini", env="OPENAI_MODEL")
    OPENAI_TIMEOUT_S: int = Field(20, env="OPENAI_TIMEOUT_S")

    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        populate_by_name=True,
        extra="ignore",
    )

    @property
    def supabase_secret(self) -> str:
        """Return the best available Supabase API key for backend use."""
        if self.SUPABASE_SERVICE_ROLE_KEY:
            return self.SUPABASE_SERVICE_ROLE_KEY
        if self.SUPABASE_SECRET_KEY:
            return self.SUPABASE_SECRET_KEY
        if self.SUPABASE_KEY:
            return self.SUPABASE_KEY
        return os.getenv("SUPABASE_KEY", "")


settings = Settings()
