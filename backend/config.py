"""Application configuration loaded from environment variables."""

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Centralized settings for the Threads backend."""

    SUPABASE_URL: str = Field(
        "https://dffscxoafddkvrufdvyi.supabase.co",
        validation_alias=AliasChoices("SUPABASE_URL"),
    )
    SUPABASE_SERVICE_ROLE_KEY: str = Field(
        "",
        validation_alias=AliasChoices("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"),
    )
    API_HOST: str = Field("0.0.0.0", validation_alias=AliasChoices("API_HOST"))
    API_PORT: int = Field(8000, validation_alias=AliasChoices("API_PORT"))

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        populate_by_name=True,
        extra="ignore",
    )


settings = Settings()
