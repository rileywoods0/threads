"""Application configuration loaded from environment variables."""

import os

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    API_HOST: str = Field("0.0.0.0", env="API_HOST")
    API_PORT: int = Field(8000, env="API_PORT")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        populate_by_name=True,
        extra="ignore",
    )

    @property
    def supabase_secret(self) -> str:
        """Prefer the explicit service-role key but allow alternate aliases."""
        explicit = self.SUPABASE_SERVICE_ROLE_KEY
        if explicit:
            return explicit
        return os.getenv("SUPABASE_KEY", "")


settings = Settings()
